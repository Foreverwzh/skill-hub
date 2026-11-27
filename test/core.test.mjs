import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  addSource,
  adoptSkill,
  applyConsolidate,
  applySync,
  cleanupBrokenLinks,
  convertLocalToInternal,
  getFullStatus,
  moveSkill,
  planConsolidate,
  pullSources,
  pushSource,
  removeSource,
  resolveConflict,
  runDoctor,
  runGuardCheck,
  setSourceProfile,
  setSourceTrust,
  toggleProfile,
  toggleSkill,
  updateSettings,
  updateTarget,
} from "../src/api.mjs";
import { resolveSyncMode, saveConfig } from "../src/config.mjs";
import {
  createDirLink,
  isManagedCopyDir,
  readManagedCopyMarker,
  safeLstat,
  safeRealpath,
} from "../src/paths.mjs";
import { planSync } from "../src/sync.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "..", "bin", "skill-hub.mjs");

let tmpRoot = "";
let userHome = "";
let hubConfigDir = "";

function writeSkill(baseDir, dirName, { name = dirName, description = "desc", extraFiles = {} } = {}) {
  const dir = path.join(baseDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: |\n  ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
  for (const [rel, content] of Object.entries(extraFiles)) {
    const fPath = path.join(dir, rel);
    fs.mkdirSync(path.dirname(fPath), { recursive: true });
    fs.writeFileSync(fPath, content, "utf8");
  }
  return dir;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-hub-test-"));
  userHome = path.join(tmpRoot, "home");
  hubConfigDir = path.join(userHome, ".skill-hub");
  fs.mkdirSync(path.join(userHome, ".gemini", "config", "skills"), { recursive: true });
  fs.mkdirSync(path.join(userHome, ".claude", "skills"), { recursive: true });
  fs.mkdirSync(path.join(userHome, ".codex", "skills"), { recursive: true });
  fs.mkdirSync(path.join(userHome, ".agents", "skills"), { recursive: true });

  process.env.SKILL_HUB_USER_HOME = userHome;
  process.env.SKILL_HUB_HOME = hubConfigDir;
});

afterEach(() => {
  delete process.env.SKILL_HUB_USER_HOME;
  delete process.env.SKILL_HUB_HOME;
  delete process.env.SKILL_HUB_SYNC_MODE;
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("multi-source isolation, profiles, per-target overrides, and non-destructive cleanup", () => {
  process.env.SKILL_HUB_SYNC_MODE = "link";
  const personalDir = path.join(tmpRoot, "sources", "personal");
  const companyDir = path.join(tmpRoot, "sources", "company");
  const localDir = path.join(tmpRoot, "sources", "local-only");

  addSource({ id: "personal", name: "个人", path: personalDir, trust: "github" });
  addSource({ id: "company", name: "公司", path: companyDir, trust: "internal" });
  addSource({ id: "local", name: "本地", path: localDir, trust: "local" });

  writeSkill(path.join(personalDir, "skills"), "skill-a", { description: "Personal A" });
  writeSkill(path.join(personalDir, "skills"), "skill-b", { description: "Personal B" });
  writeSkill(path.join(companyDir, "skills"), "corp-deploy", { description: "Company deploy" });
  writeSkill(path.join(localDir, "skills"), "draft-local", { description: "Local draft" });

  // Unmanaged real directory, unmanaged external symlink, and existing target->hub symlink to unmanaged skill MUST NEVER be deleted
  const unmanagedHubSkill = writeSkill(path.join(userHome, ".agents", "skills"), "existing-hub-skill");
  const unmanagedHubTargetLink = path.join(userHome, ".claude", "skills", "existing-hub-skill");
  createDirLink(unmanagedHubSkill, unmanagedHubTargetLink);
  const unmanagedReal = writeSkill(path.join(userHome, ".claude", "skills"), "my-local-draft");
  const externalSkill = writeSkill(path.join(tmpRoot, "external"), "third-party");
  const externalLink = path.join(userHome, ".claude", "skills", "third-party");
  createDirLink(externalSkill, externalLink);

  // Per-source profiles remain physically separated
  setSourceProfile("personal", "base", ["skill-a", "skill-b"]);
  setSourceProfile("company", "work", ["corp-deploy"]);

  const personalProfiles = JSON.parse(fs.readFileSync(path.join(personalDir, "profiles.json"), "utf8"));
  assert.deepEqual(personalProfiles, { base: ["skill-a", "skill-b"] });
  assert.equal(JSON.stringify(personalProfiles).includes("corp-deploy"), false);

  toggleProfile({ ref: "personal:base", enabled: true });
  toggleProfile({ ref: "company:work", enabled: true });
  // Per-target exclusion: disable skill-b on claude only, force-include draft-local on claude only
  toggleSkill({ skillRef: "personal:skill-b", enabled: false, targetId: "claude" });
  toggleSkill({ skillRef: "local:draft-local", enabled: true, targetId: "claude" });

  const sync1 = applySync();
  assert.equal(sync1.errors.length, 0);

  const hubDir = path.join(userHome, ".agents", "skills");
  assert.equal(
    safeRealpath(path.join(hubDir, "skill-a")),
    safeRealpath(path.join(personalDir, "skills", "skill-a")),
  );
  assert.equal(
    safeRealpath(path.join(hubDir, "corp-deploy")),
    safeRealpath(path.join(companyDir, "skills", "corp-deploy")),
  );
  // Antigravity gets both skill-a and skill-b
  assert.ok(safeLstat(path.join(userHome, ".gemini", "config", "skills", "skill-b"))?.isSymbolicLink());
  // Claude skips skill-b, gets skill-a and draft-local
  assert.equal(safeLstat(path.join(userHome, ".claude", "skills", "skill-b")), null);
  assert.ok(safeLstat(path.join(userHome, ".claude", "skills", "skill-a"))?.isSymbolicLink());
  assert.ok(safeLstat(path.join(userHome, ".claude", "skills", "draft-local"))?.isSymbolicLink());
  // Codex is hub-only by default, so no direct symlink created
  assert.equal(safeLstat(path.join(userHome, ".codex", "skills", "skill-a")), null);

  // Disable company profile -> corp-deploy links are removed, unmanaged items stay intact
  toggleProfile({ ref: "company:work", enabled: false });
  const sync2 = applySync();
  assert.equal(sync2.errors.length, 0);
  assert.equal(safeLstat(path.join(hubDir, "corp-deploy")), null);
  assert.equal(safeLstat(path.join(userHome, ".claude", "skills", "corp-deploy")), null);
  assert.ok(safeLstat(unmanagedReal)?.isDirectory());
  assert.ok(safeLstat(externalLink)?.isSymbolicLink());
  assert.ok(safeLstat(unmanagedHubSkill)?.isDirectory());
  assert.ok(safeLstat(unmanagedHubTargetLink)?.isSymbolicLink());
});

test("4-layer leak guard blocks internal->github remote, github sensitive leaks, and real git pre-push", () => {
  const internalDir = path.join(tmpRoot, "sources", "corp-secret");
  const githubDir = path.join(tmpRoot, "sources", "my-public");

  // 1. Refuse adding internal source cloning from github.com
  assert.throws(
    () =>
      addSource({
        id: "bad-corp",
        path: path.join(tmpRoot, "bad-corp"),
        trust: "internal",
        cloneUrl: "https://github.com/someone/corp.git",
      }),
    /公网托管域名/,
  );

  addSource({ id: "corp", path: internalDir, trust: "internal" });
  addSource({ id: "pub", path: githubDir, trust: "github" });

  // 2. If someone manually configures github.com remote on internal repo, guard catches it
  execFileSync("git", ["remote", "add", "origin", "git@github.com:leak/corp.git"], {
    cwd: internalDir,
  });
  const corpCheck = runGuardCheck({ sourceId: "corp" });
  assert.equal(corpCheck.ok, false);
  assert.equal(corpCheck.results[0].violations[0].code, "FORBIDDEN_PUBLIC_REMOTE");

  // 3. Keyword + regex leak scan on github source
  updateSettings({ guard: { keywords: ["SECRET_INTERNAL_CORP"] } });
  writeSkill(path.join(githubDir, "skills"), "leaky-skill", {
    extraFiles: { "helper.js": 'const url = "https://api.SECRET_INTERNAL_CORP.internal";\n' },
  });

  const pubCheck = runGuardCheck({ sourceId: "pub" });
  assert.equal(pubCheck.ok, false);
  assert.ok(pubCheck.results[0].violations.some((v) => v.code === "SENSITIVE_CONTENT_MATCH"));

  // pushSource must reject before commit/push
  assert.throws(() => pushSource({ sourceId: "pub", skipPush: true }), /安全守卫拦截/);

  // 4. Real git pre-push hook blocks raw `git push` into a bare remote when leak exists
  const bareRepo = path.join(tmpRoot, "bare-pub.git");
  execFileSync("git", ["init", "--bare", bareRepo]);
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: githubDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: githubDir });
  execFileSync("git", ["remote", "add", "origin", bareRepo], { cwd: githubDir });
  execFileSync("git", ["add", "-A"], { cwd: githubDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: githubDir });

  assert.throws(
    () =>
      execFileSync("git", ["push", "-u", "origin", "HEAD"], {
        cwd: githubDir,
        env: { ...process.env, SKILL_HUB_USER_HOME: userHome, SKILL_HUB_HOME: hubConfigDir },
      }),
  );

  // Clean up leak -> push succeeds
  fs.writeFileSync(path.join(githubDir, "skills", "leaky-skill", "helper.js"), "const ok = true;\n");
  execFileSync("git", ["add", "-A"], { cwd: githubDir });
  execFileSync("git", ["commit", "-m", "clean"], { cwd: githubDir });
  execFileSync("git", ["push", "-u", "origin", "HEAD"], {
    cwd: githubDir,
    env: { ...process.env, SKILL_HUB_USER_HOME: userHome, SKILL_HUB_HOME: hubConfigDir },
  });
});

test("local -> internal conversion, doctor, adopt with leak guard, cross-source move, and broken link cleanup", () => {
  process.env.SKILL_HUB_SYNC_MODE = "link";
  const pubDir = path.join(tmpRoot, "sources", "pub");
  const draftDir = path.join(tmpRoot, "sources", "drafts");
  addSource({ id: "pub", name: "GitHub", path: pubDir, trust: "github" });
  addSource({ id: "drafts", name: "本地草稿", path: draftDir, trust: "local" });

  // Local source refuses public remote on upgrade, accepts internal remote
  assert.throws(
    () =>
      convertLocalToInternal("drafts", {
        remoteUrl: "https://github.com/user/drafts.git",
      }),
    /公网托管域名/,
  );
  const conv = convertLocalToInternal("drafts", {
    remoteUrl: "ssh://git@git.corp.local/team/skills.git",
    allowedRemoteHosts: ["git.corp.local"],
  });
  assert.equal(conv.source.trust, "internal");
  assert.equal(conv.git.isGit, true);
  assert.equal(conv.git.hasHook, true);

  // Configure sensitive keyword and test adopt blocking into github source
  updateSettings({ guard: { keywords: ["CORP_PRIVATE_HOST"] } });
  const unmanagedCorp = writeSkill(path.join(userHome, ".agents", "skills"), "internal-tool", {
    extraFiles: { "run.mjs": 'export const host = "CORP_PRIVATE_HOST";\n' },
  });
  const unmanagedSafe = writeSkill(path.join(userHome, ".codex", "skills"), "safe-helper");

  // Create a broken link in claude skills
  const brokenPath = path.join(userHome, ".claude", "skills", "ghost-link");
  createDirLink(path.join(tmpRoot, "nonexistent-dir"), brokenPath);

  const doc1 = runDoctor();
  assert.equal(doc1.unmanaged.length, 2);
  assert.equal(doc1.brokenLinks.length, 1);

  // Adopting sensitive skill into GitHub source MUST fail and leave original untouched
  assert.throws(
    () => adoptSkill({ skillPath: unmanagedCorp, targetSourceId: "pub" }),
    /安全守卫拒绝/,
  );
  assert.ok(safeLstat(unmanagedCorp)?.isDirectory());

  // Adopting into internal source succeeds and replaces original with symlink
  const adoptedCorp = adoptSkill({ skillPath: unmanagedCorp, targetSourceId: "drafts" });
  assert.equal(adoptedCorp.ok, true);
  assert.ok(safeLstat(unmanagedCorp)?.isSymbolicLink());
  assert.ok(fs.existsSync(path.join(draftDir, "skills", "internal-tool", "SKILL.md")));

  // Adopting safe skill from codex succeeds and leaves symlink
  const adoptedSafe = adoptSkill({ skillPath: unmanagedSafe, targetSourceId: "pub" });
  assert.equal(adoptedSafe.ok, true);
  assert.ok(safeLstat(unmanagedSafe)?.isSymbolicLink());

  // Moving sensitive skill from internal -> github MUST be blocked
  assert.throws(
    () => moveSkill({ dirName: "internal-tool", fromSourceId: "drafts", toSourceId: "pub" }),
    /安全守卫拦截/,
  );

  // Cleaning broken links removes only broken link
  const cleaned = cleanupBrokenLinks();
  assert.equal(cleaned.removed.length, 1);
  assert.equal(safeLstat(brokenPath), null);

  // Removing source never deletes source repo files on disk
  removeSource("drafts");
  assert.ok(fs.existsSync(path.join(draftDir, "skills", "internal-tool", "SKILL.md")));
});

test("CLI end-to-end --json execution and non-invasive status on fresh home", () => {
  const out = execFileSync(process.execPath, [CLI_PATH, "status", "--json"], {
    encoding: "utf8",
    env: { ...process.env, SKILL_HUB_USER_HOME: userHome, SKILL_HUB_HOME: hubConfigDir },
  });
  const parsed = JSON.parse(out);
  assert.equal(Array.isArray(parsed.sources), true);
  assert.equal(Array.isArray(parsed.targets), true);
  // Read-only status must not leave behind a config.json file
  assert.equal(fs.existsSync(path.join(hubConfigDir, "config.json")), false);

  // Add source via CLI and set target mode
  const srcPath = path.join(tmpRoot, "cli-src");
  const addOut = execFileSync(
    process.execPath,
    [CLI_PATH, "source", "add", "--id", "cli-personal", "--path", srcPath, "--trust", "github", "--json"],
    {
      encoding: "utf8",
      env: { ...process.env, SKILL_HUB_USER_HOME: userHome, SKILL_HUB_HOME: hubConfigDir },
    },
  );
  const added = JSON.parse(addOut);
  assert.equal(added.source.id, "cli-personal");

  const tgtOut = execFileSync(
    process.execPath,
    [CLI_PATH, "target", "set", "codex", "--mode", "link", "--json"],
    {
      encoding: "utf8",
      env: { ...process.env, SKILL_HUB_USER_HOME: userHome, SKILL_HUB_HOME: hubConfigDir },
    },
  );
  assert.equal(JSON.parse(tgtOut).target.mode, "link");

  const st = getFullStatus();
  assert.equal(st.sources.length, 1);
});

test("consolidate unifies scattered skills & legacy .smelt/skills into .agents hub, repairs bridges, and resolves conflicts to trash", () => {
  process.env.SKILL_HUB_SYNC_MODE = "link";
  const hubDir = path.join(userHome, ".agents", "skills");
  const claudeDir = path.join(userHome, ".claude", "skills");
  const antigravityDir = path.join(userHome, ".gemini", "config", "skills");
  const codexDir = path.join(userHome, ".codex", "skills");
  const legacyDir = path.join(userHome, ".smelt", "skills");

  // 1. Scattered skills across codex (hub-only), claude (link), and legacy .smelt/skills
  writeSkill(codexDir, "codex-only-skill", { description: "From codex" });
  writeSkill(claudeDir, "claude-only-skill", { description: "From claude" });
  writeSkill(legacyDir, "legacy-skill", { description: "From legacy smelt" });
  // Already in hub, missing links in claude & antigravity
  writeSkill(hubDir, "hub-unbridged", { description: "In hub already" });

  // 2. Conflicted skill present in both hub and codex
  const conflictHub = writeSkill(hubDir, "dup-skill", { description: "Hub copy" });
  const conflictCodex = writeSkill(codexDir, "dup-skill", { description: "Codex copy" });

  // 3. Managed source skill that is excluded for claude should NOT be force-linked into claude during consolidate
  const personalDir = path.join(tmpRoot, "sources", "personal");
  addSource({ id: "personal", name: "个人", path: personalDir, trust: "github" });
  writeSkill(path.join(personalDir, "skills"), "managed-skip-claude");
  toggleSkill({ skillRef: "personal:managed-skip-claude", enabled: true });
  toggleSkill({ skillRef: "personal:managed-skip-claude", enabled: false, targetId: "claude" });
  applySync();

  const preview = planConsolidate();
  assert.equal(preview.summary.toMove, 3);
  assert.equal(preview.conflicts.length, 1);
  assert.equal(preview.conflicts[0].dirName, "dup-skill");

  // Apply consolidation
  const res = applyConsolidate();
  assert.equal(res.errors.length, 0);
  assert.deepEqual(res.skippedConflicts, ["dup-skill"]);

  // Moved skills now live as real dirs inside ~/.agents/skills
  assert.ok(safeLstat(path.join(hubDir, "codex-only-skill"))?.isDirectory());
  assert.ok(safeLstat(path.join(hubDir, "claude-only-skill"))?.isDirectory());
  assert.ok(safeLstat(path.join(hubDir, "legacy-skill"))?.isDirectory());
  // Empty legacy ~/.smelt/skills removed
  assert.equal(safeLstat(legacyDir), null);

  // hub-only codex does NOT receive redundant symlinks back
  assert.equal(safeLstat(path.join(codexDir, "codex-only-skill")), null);
  assert.equal(safeLstat(path.join(codexDir, "hub-unbridged")), null);

  // link-mode targets (claude, antigravity) receive symlinks for consolidated skills
  for (const name of ["codex-only-skill", "claude-only-skill", "legacy-skill", "hub-unbridged"]) {
    assert.equal(safeRealpath(path.join(claudeDir, name)), safeRealpath(path.join(hubDir, name)));
    assert.equal(safeRealpath(path.join(antigravityDir, name)), safeRealpath(path.join(hubDir, name)));
  }

  // Managed skill excluded for claude remains unlinked in claude
  assert.equal(safeLstat(path.join(claudeDir, "managed-skip-claude")), null);
  assert.ok(safeLstat(path.join(antigravityDir, "managed-skip-claude"))?.isSymbolicLink());

  // Conflicted skill was NOT touched during consolidate
  assert.ok(safeLstat(conflictHub)?.isDirectory());
  assert.ok(safeLstat(conflictCodex)?.isDirectory());

  // Subsequent applySync() MUST preserve all consolidated unmanaged links (not stored in state.json)
  const syncAfter = applySync();
  assert.equal(syncAfter.summary.remove, 0);
  assert.ok(safeLstat(path.join(claudeDir, "codex-only-skill"))?.isSymbolicLink());

  // Resolve conflict by keeping codex copy -> moves hub copy to trash, moves codex copy into hub, bridges claude & antigravity
  const resolved = resolveConflict({ dirName: "dup-skill", keepPath: conflictCodex });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.trashed.length, 1);
  assert.ok(fs.existsSync(path.join(resolved.trashed[0].to, "SKILL.md")));
  assert.equal(safeLstat(conflictCodex), null);
  assert.ok(safeLstat(path.join(hubDir, "dup-skill"))?.isDirectory());
  assert.equal(
    fs.readFileSync(path.join(hubDir, "dup-skill", "SKILL.md"), "utf8").includes("Codex copy"),
    true,
  );
  assert.equal(
    safeRealpath(path.join(claudeDir, "dup-skill")),
    safeRealpath(path.join(hubDir, "dup-skill")),
  );
  assert.equal(
    safeRealpath(path.join(antigravityDir, "dup-skill")),
    safeRealpath(path.join(hubDir, "dup-skill")),
  );
});

test("CLI consolidate --dry-run, consolidate, and resolve-conflict --json", () => {
  process.env.SKILL_HUB_SYNC_MODE = "link";
  const hubDir = path.join(userHome, ".agents", "skills");
  const claudeDir = path.join(userHome, ".claude", "skills");
  const codexDir = path.join(userHome, ".codex", "skills");

  writeSkill(codexDir, "cli-scattered");
  const keepHub = writeSkill(hubDir, "cli-dup", { description: "keep me" });
  writeSkill(codexDir, "cli-dup", { description: "discard me" });

  const env = { ...process.env, SKILL_HUB_USER_HOME: userHome, SKILL_HUB_HOME: hubConfigDir };
  const dryOut = JSON.parse(
    execFileSync(process.execPath, [CLI_PATH, "consolidate", "--dry-run", "--json"], {
      encoding: "utf8",
      env,
    }),
  );
  assert.equal(dryOut.dryRun, true);
  assert.equal(dryOut.summary.toMove, 1);
  assert.equal(dryOut.summary.conflicts, 1);

  const runOut = JSON.parse(
    execFileSync(process.execPath, [CLI_PATH, "consolidate", "--json"], {
      encoding: "utf8",
      env,
    }),
  );
  assert.equal(runOut.dryRun, false);
  assert.equal(safeRealpath(path.join(claudeDir, "cli-scattered")), safeRealpath(path.join(hubDir, "cli-scattered")));

  const resOut = JSON.parse(
    execFileSync(
      process.execPath,
      [CLI_PATH, "resolve-conflict", "cli-dup", "--keep", keepHub, "--json"],
      { encoding: "utf8", env },
    ),
  );
  assert.equal(resOut.ok, true);
  assert.equal(resOut.trashed.length, 1);
  assert.equal(safeLstat(path.join(codexDir, "cli-dup")), null);
  assert.equal(safeRealpath(path.join(claudeDir, "cli-dup")), safeRealpath(keepHub));
});

test("push succeeds under stripped gpui-shell environment via --env-json and home fallback", () => {
  const repoDir = path.join(tmpRoot, "sources", "empty-env-pub");
  const bareRemote = path.join(tmpRoot, "empty-env-remote.git");
  execFileSync("git", ["init", "--bare", bareRemote]);

  // Write global git identity in the test user's HOME/.gitconfig (NOT inside repo local config)
  fs.writeFileSync(
    path.join(userHome, ".gitconfig"),
    "[user]\n\tname = Empty Env Tester\n\temail = empty-env@example.com\n",
    "utf8",
  );

  addSource({ id: "empty-env-pub", name: "空环境测试源", path: repoDir, trust: "github" });
  execFileSync("git", ["remote", "add", "origin", bareRemote], { cwd: repoDir });
  writeSkill(path.join(repoDir, "skills"), "env-skill-1", { description: "First" });

  // Case 1: Empty env + --env-json (exact simulation of Smelt gpui-shell process.run)
  const forwarded = JSON.stringify({
    HOME: userHome,
    PATH: process.env.PATH,
    SKILL_HUB_USER_HOME: userHome,
    SKILL_HUB_HOME: hubConfigDir,
  });
  const out1 = JSON.parse(
    execFileSync(
      process.execPath,
      [CLI_PATH, "push", "empty-env-pub", "-m", "commit via env-json", "--env-json", forwarded, "--json"],
      { encoding: "utf8", env: {} },
    ),
  );
  assert.equal(out1.ok, true);
  assert.equal(out1.committed, true);
  assert.equal(out1.pushed, true);

  // Case 2: Stripped env without HOME/PATH, relying on SKILL_HUB_USER_HOME + buildGitEnv fallbacks
  writeSkill(path.join(repoDir, "skills"), "env-skill-2", { description: "Second" });
  const out2 = JSON.parse(
    execFileSync(
      process.execPath,
      [CLI_PATH, "push", "empty-env-pub", "-m", "commit via fallback", "--json"],
      {
        encoding: "utf8",
        env: {
          SKILL_HUB_USER_HOME: userHome,
          SKILL_HUB_HOME: hubConfigDir,
        },
      },
    ),
  );
  assert.equal(out2.ok, true);
  assert.equal(out2.committed, true);
  assert.equal(out2.pushed, true);
});

test("addSource prevents duplicate paths, parent-child nesting across sources, and hubDir overlap", () => {
  const personalDir = path.join(tmpRoot, "sources", "personal");
  const localOneDir = path.join(tmpRoot, "sources", "local-one");

  addSource({ id: "personal", name: "个人", path: personalDir, trust: "github" });
  addSource({ id: "local-one", name: "本地1", path: localOneDir, trust: "local" });

  // Duplicate path between two local sources must throw
  assert.throws(
    () => addSource({ id: "local-dup", path: localOneDir, trust: "local" }),
    /已被源 "local-one".*占用/,
  );

  // Child directory inside existing github source must throw
  assert.throws(
    () =>
      addSource({
        id: "nested-child",
        path: path.join(personalDir, "sub-company"),
        trust: "local",
      }),
    /父子嵌套关系/,
  );

  // Parent directory enclosing existing sources must throw
  assert.throws(
    () =>
      addSource({
        id: "enclosing-parent",
        path: path.join(tmpRoot, "sources"),
        trust: "local",
      }),
    /父子嵌套关系/,
  );

  // Overlapping with hubDir (~/.agents/skills) must throw
  assert.throws(
    () =>
      addSource({
        id: "hub-overlap",
        path: path.join(userHome, ".agents", "skills"),
        trust: "local",
      }),
    /通用中枢目录/,
  );
});

test("setSourceTrust safely switches source trust levels and enforces leak/remote guards", () => {
  const dir = path.join(tmpRoot, "sources", "flex");
  addSource({ id: "flex", name: "弹性源", path: dir, trust: "github" });

  // github without remote -> local succeeds
  const toLocal = setSourceTrust("flex", { trust: "local" });
  assert.equal(toLocal.source.trust, "local");

  // Put sensitive keyword in local skill -> switching back to github must be blocked
  updateSettings({ guard: { keywords: ["SECRET_SWITCH_CHECK"] } });
  writeSkill(path.join(dir, "skills"), "secret-skill", {
    extraFiles: { "run.js": 'const k = "SECRET_SWITCH_CHECK";\n' },
  });
  assert.throws(() => setSourceTrust("flex", { trust: "github" }), /安全守卫拒绝/);

  // Clean up leak -> local -> github succeeds and installs hook
  fs.writeFileSync(path.join(dir, "skills", "secret-skill", "run.js"), "const k = 'ok';\n");
  const toGithub = setSourceTrust("flex", { trust: "github" });
  assert.equal(toGithub.source.trust, "github");
  assert.equal(toGithub.git.hasHook, true);

  // Add github.com remote -> cannot downgrade to local or switch to internal
  execFileSync("git", ["remote", "add", "origin", "https://github.com/user/repo.git"], {
    cwd: dir,
  });
  assert.throws(() => setSourceTrust("flex", { trust: "local" }), /已配置 Git 远端/);
  assert.throws(() => setSourceTrust("flex", { trust: "internal" }), /公网托管域名/);
});

test("profile CLI supports empty creation, add-skill, remove-skill, clearing with --skills=, and delete", () => {
  const personalDir = path.join(tmpRoot, "sources", "personal");
  addSource({ id: "personal", name: "个人通用", path: personalDir, trust: "github" });
  writeSkill(path.join(personalDir, "skills"), "game-a", { description: "Game A" });
  writeSkill(path.join(personalDir, "skills"), "game-b", { description: "Game B" });

  const env = { ...process.env, SKILL_HUB_USER_HOME: userHome, SKILL_HUB_HOME: hubConfigDir };
  const runJson = (args) =>
    JSON.parse(
      execFileSync(process.execPath, [CLI_PATH, ...args, "--json"], {
        encoding: "utf8",
        env,
      }),
    );

  // Create empty profile via --skills=
  const created = runJson(["profile", "set", "personal:gamedev", "--skills="]);
  assert.deepEqual(created.profiles.gamedev, []);

  // Enable profile so delete cleanup is also exercised
  runJson(["profile", "enable", "personal:gamedev"]);

  // Add skills one by one
  const addedA = runJson(["profile", "add-skill", "personal:gamedev", "game-a"]);
  assert.deepEqual(addedA.profiles.gamedev, ["game-a"]);
  const addedB = runJson(["profile", "add-skill", "personal:gamedev", "game-b"]);
  assert.deepEqual(addedB.profiles.gamedev, ["game-a", "game-b"]);

  // Remove one skill and inspect full status
  const removedA = runJson(["profile", "remove-skill", "personal:gamedev", "game-a"]);
  assert.deepEqual(removedA.profiles.gamedev, ["game-b"]);

  const statusAfterRemove = getFullStatus();
  const prof = statusAfterRemove.profiles.find((p) => p.ref === "personal:gamedev");
  assert.ok(prof);
  assert.deepEqual(prof.skills, ["game-b"]);
  assert.equal(prof.enabled, true);

  const skillA = statusAfterRemove.skills.find((s) => s.ref === "personal:game-a");
  const skillB = statusAfterRemove.skills.find((s) => s.ref === "personal:game-b");
  assert.deepEqual(skillA.profiles, []);
  assert.deepEqual(skillB.profiles, ["personal:gamedev"]);

  // Clear all members via --skills=
  const cleared = runJson(["profile", "set", "personal:gamedev", "--skills="]);
  assert.deepEqual(cleared.profiles.gamedev, []);

  // add-skill on nonexistent profile must fail
  assert.throws(() =>
    execFileSync(
      process.execPath,
      [CLI_PATH, "profile", "add-skill", "personal:missing", "game-a", "--json"],
      { encoding: "utf8", env },
    ),
  );

  // Delete profile removes it from profiles.json and enabledProfiles
  runJson(["profile", "delete", "personal:gamedev"]);
  const profilesDisk = JSON.parse(
    fs.readFileSync(path.join(personalDir, "profiles.json"), "utf8"),
  );
  assert.equal("gamedev" in profilesDisk, false);
  assert.equal(getFullStatus().config.enabledProfiles.includes("personal:gamedev"), false);
});

test("resolveSyncMode defaults and explicit overrides", () => {
  assert.equal(resolveSyncMode({ syncMode: "auto" }, { platform: "win32" }), "copy");
  assert.equal(resolveSyncMode({ syncMode: "auto" }, { platform: "darwin" }), "link");
  assert.equal(resolveSyncMode({ syncMode: "auto" }, { platform: "linux" }), "link");

  process.env.SKILL_HUB_SYNC_MODE = "link";
  assert.equal(resolveSyncMode({ syncMode: "auto" }, { platform: "win32" }), "link");
  assert.equal(resolveSyncMode({ syncMode: "copy" }, { platform: "darwin" }), "copy");

  process.env.SKILL_HUB_SYNC_MODE = "copy";
  assert.equal(resolveSyncMode({ syncMode: "link" }, { platform: "win32" }), "link");

  assert.throws(() => updateSettings({ syncMode: "invalid-mode" }), /非法同步方式/);
});

test("copy mode lifecycle, digest drift detection, non-destructive protection, doctor & status", () => {
  updateSettings({ syncMode: "copy" });
  updateTarget({ id: "cursor", mode: "link" });

  const personalDir = path.join(tmpRoot, "sources", "personal");
  addSource({ id: "personal", name: "个人", path: personalDir, trust: "github" });
  const srcA = writeSkill(path.join(personalDir, "skills"), "skill-a", {
    description: "Skill A v1",
    extraFiles: { "scripts/run.js": "console.log('v1');\n" },
  });
  writeSkill(path.join(personalDir, "skills"), "skill-b", { description: "Skill B" });

  // Unmanaged real directory, colliding real directory, and external symlink MUST NOT be overwritten or deleted
  const unmanagedClaude = writeSkill(path.join(userHome, ".claude", "skills"), "unmanaged-real");
  const collidingCursor = writeSkill(path.join(userHome, ".cursor", "skills"), "skill-a", {
    description: "User local cursor copy",
  });
  const externalSkill = writeSkill(path.join(tmpRoot, "external"), "third-party");
  const externalLink = path.join(userHome, ".claude", "skills", "third-party");
  createDirLink(externalSkill, externalLink);

  toggleSkill({ skillRef: "personal:skill-a", enabled: true });
  toggleSkill({ skillRef: "personal:skill-b", enabled: true });

  const sync1 = applySync();
  assert.equal(sync1.effectiveSyncMode, "copy");
  assert.equal(sync1.errors.length, 0);
  assert.equal(sync1.summary.conflicts, 1);

  const hubA = path.join(userHome, ".agents", "skills", "skill-a");
  const claudeA = path.join(userHome, ".claude", "skills", "skill-a");
  const agyA = path.join(userHome, ".gemini", "config", "skills", "skill-a");
  const isWin = process.platform === "win32";
  const expectedCopyDirs = isWin ? [hubA, claudeA] : [hubA, claudeA, agyA];

  for (const dir of expectedCopyDirs) {
    const lst = safeLstat(dir);
    assert.ok(lst?.isDirectory());
    assert.equal(lst?.isSymbolicLink(), false);
    assert.equal(isManagedCopyDir(dir), true);
    assert.equal(
      fs.readFileSync(path.join(dir, "scripts", "run.js"), "utf8"),
      "console.log('v1');\n",
    );
  }
  if (isWin) {
    // On Windows copy mode, Antigravity uses skills.json directly without redundant folder copies
    assert.equal(safeLstat(agyA), null);
    const manifestPath = path.join(userHome, ".gemini", "config", "skills.json");
    assert.equal(fs.existsSync(manifestPath), true);
  }
  assert.equal(readManagedCopyMarker(hubA)?.skillRef, "personal:skill-a");

  // Colliding real directory in cursor stays intact and unmanaged
  assert.equal(isManagedCopyDir(collidingCursor), false);
  assert.equal(
    fs.readFileSync(path.join(collidingCursor, "SKILL.md"), "utf8").includes("User local cursor copy"),
    true,
  );

  // Second sync is a complete noop
  const syncNoop = applySync();
  assert.equal(syncNoop.summary.create, 0);
  assert.equal(syncNoop.summary.replace, 0);
  assert.equal(syncNoop.summary.remove, 0);
  assert.equal(syncNoop.summary.totalPending, 0);

  // Status & doctor do not misclassify managed copies as unmanaged or conflicts
  const status = getFullStatus();
  assert.equal(status.effectiveSyncMode, "copy");
  const stA = status.skills.find((s) => s.dirName === "skill-a");
  const stB = status.skills.find((s) => s.dirName === "skill-b");
  assert.equal(stA.coverage.find((c) => c.targetId === "claude")?.status, "copied");
  assert.equal(stA.coverage.find((c) => c.targetId === "codex")?.status, "via-hub");
  assert.equal(stA.coverage.find((c) => c.targetId === "cursor")?.status, "conflict");
  assert.equal(
    stA.coverage.find((c) => c.targetId === "antigravity")?.status,
    isWin ? "linked" : "copied",
  );
  assert.equal(stB.coverage.find((c) => c.targetId === "claude")?.status, "copied");
  assert.equal(
    status.doctor.unmanaged.some((u) => u.dirName === "skill-b"),
    false,
  );
  assert.deepEqual(
    status.doctor.unmanaged.map((u) => u.dirName).sort(),
    ["skill-a", "unmanaged-real"],
  );

  // Source edit triggers digest drift and updates all managed copies
  fs.writeFileSync(path.join(srcA, "scripts", "run.js"), "console.log('v2');\n", "utf8");
  const driftPlan = planSync();
  assert.equal(driftPlan.summary.replace, expectedCopyDirs.length);
  const syncDrift = applySync();
  assert.equal(syncDrift.errors.length, 0);
  assert.equal(
    fs.readFileSync(path.join(claudeA, "scripts", "run.js"), "utf8"),
    "console.log('v2');\n",
  );
  assert.equal(applySync().summary.totalPending, 0);

  // Disabling skill-b removes only managed copies, leaving unmanaged items intact
  toggleSkill({ skillRef: "personal:skill-b", enabled: false });
  const syncDisable = applySync();
  assert.equal(syncDisable.errors.length, 0);
  assert.equal(safeLstat(path.join(userHome, ".agents", "skills", "skill-b")), null);
  assert.equal(safeLstat(path.join(userHome, ".claude", "skills", "skill-b")), null);
  assert.equal(safeLstat(path.join(userHome, ".gemini", "config", "skills", "skill-b")), null);
  assert.ok(safeLstat(unmanagedClaude)?.isDirectory());
  assert.ok(safeLstat(externalLink)?.isSymbolicLink());
  assert.ok(safeLstat(collidingCursor)?.isDirectory());
});

test("seamless migration between link and copy modes", () => {
  const personalDir = path.join(tmpRoot, "sources", "personal");
  addSource({ id: "personal", name: "个人", path: personalDir, trust: "github" });
  writeSkill(path.join(personalDir, "skills"), "skill-a");
  toggleSkill({ skillRef: "personal:skill-a", enabled: true });

  const unmanagedKeep = writeSkill(path.join(userHome, ".claude", "skills"), "keep-me");
  const externalSkill = writeSkill(path.join(tmpRoot, "external"), "ext-skill");
  const externalLink = path.join(userHome, ".claude", "skills", "ext-skill");
  createDirLink(externalSkill, externalLink);

  // Start in link mode
  updateSettings({ syncMode: "link" });
  const linkRes = applySync();
  assert.equal(linkRes.errors.length, 0);
  const isWin = process.platform === "win32";
  const hubPath = path.join(userHome, ".agents", "skills", "skill-a");
  const claudePath = path.join(userHome, ".claude", "skills", "skill-a");
  const agyPath = path.join(userHome, ".gemini", "config", "skills", "skill-a");
  const pathsToCheck = [hubPath, claudePath, agyPath];
  for (const p of pathsToCheck) {
    assert.ok(safeLstat(p)?.isSymbolicLink());
  }

  // Migrate link -> copy
  updateSettings({ syncMode: "copy" });
  const toCopyRes = applySync();
  assert.equal(toCopyRes.errors.length, 0);
  assert.equal(toCopyRes.summary.replace, isWin ? 2 : 3);
  for (const p of isWin ? [hubPath, claudePath] : pathsToCheck) {
    const lst = safeLstat(p);
    assert.ok(lst?.isDirectory());
    assert.equal(lst?.isSymbolicLink(), false);
    assert.equal(isManagedCopyDir(p), true);
  }
  if (isWin) {
    assert.equal(safeLstat(agyPath), null);
  }
  assert.ok(safeLstat(unmanagedKeep)?.isDirectory());
  assert.ok(safeLstat(externalLink)?.isSymbolicLink());

  // Migrate copy -> link
  updateSettings({ syncMode: "link" });
  const toLinkRes = applySync();
  assert.equal(toLinkRes.errors.length, 0);
  assert.equal(toLinkRes.summary.replace, isWin ? 2 : 3);
  for (const p of pathsToCheck) {
    assert.ok(safeLstat(p)?.isSymbolicLink());
    assert.equal(isManagedCopyDir(p), false);
  }
  assert.ok(safeLstat(unmanagedKeep)?.isDirectory());
  assert.ok(safeLstat(externalLink)?.isSymbolicLink());
});

test("consolidate, drift refresh, and adoptSkill in copy mode", () => {
  updateSettings({ syncMode: "copy" });

  const hubDir = path.join(userHome, ".agents", "skills");
  const claudeDir = path.join(userHome, ".claude", "skills");
  const agyDir = path.join(userHome, ".gemini", "config", "skills");
  const codexDir = path.join(userHome, ".codex", "skills");

  const hubSkill = writeSkill(hubDir, "hub-skill", { description: "Hub v1" });
  writeSkill(codexDir, "codex-skill", { description: "From codex" });
  writeSkill(claudeDir, "claude-skill", { description: "From claude" });

  const personalDir = path.join(tmpRoot, "sources", "personal");
  addSource({ id: "personal", name: "个人", path: personalDir, trust: "github" });
  writeSkill(path.join(personalDir, "skills"), "managed-a");
  writeSkill(path.join(personalDir, "skills"), "managed-skip-claude");
  toggleSkill({ skillRef: "personal:managed-a", enabled: true });
  toggleSkill({ skillRef: "personal:managed-skip-claude", enabled: true });
  toggleSkill({ skillRef: "personal:managed-skip-claude", enabled: false, targetId: "claude" });
  applySync();

  const consRes = applyConsolidate();
  assert.equal(consRes.errors.length, 0);

  for (const name of ["hub-skill", "codex-skill", "claude-skill"]) {
    assert.ok(safeLstat(path.join(hubDir, name))?.isDirectory());
    assert.equal(isManagedCopyDir(path.join(hubDir, name)), false);
    for (const targetDir of [claudeDir, agyDir]) {
      const dst = path.join(targetDir, name);
      assert.equal(isManagedCopyDir(dst), true);
      assert.equal(readManagedCopyMarker(dst)?.origin, "consolidate");
    }
  }
  // Managed skill excluded for claude is NOT copied to claude
  assert.equal(safeLstat(path.join(claudeDir, "managed-skip-claude")), null);

  // Subsequent planConsolidate and applySync remain clean and preserve consolidate copies
  assert.equal(planConsolidate().summary.totalActions, 0);
  const syncAfter = applySync();
  assert.equal(syncAfter.summary.remove, 0);
  assert.equal(isManagedCopyDir(path.join(claudeDir, "codex-skill")), true);

  // Editing hub-skill triggers planConsolidate drift refresh
  fs.writeFileSync(path.join(hubSkill, "SKILL.md"), "---\nname: hub-skill\ndescription: Hub v2\n---\n", "utf8");
  const driftCons = planConsolidate();
  assert.equal(driftCons.summary.toRelink, 2);
  applyConsolidate();
  assert.equal(
    fs.readFileSync(path.join(claudeDir, "hub-skill", "SKILL.md"), "utf8").includes("Hub v2"),
    true,
  );

  // adoptSkill in copy mode creates managed copies and refuses adopting a managed copy
  const adopted = adoptSkill({ skillPath: path.join(hubDir, "codex-skill"), targetSourceId: "personal" });
  assert.equal(adopted.ok, true);
  assert.equal(isManagedCopyDir(path.join(hubDir, "codex-skill")), true);
  assert.equal(isManagedCopyDir(path.join(claudeDir, "codex-skill")), true);
  assert.throws(
    () => adoptSkill({ skillPath: path.join(claudeDir, "codex-skill"), targetSourceId: "personal" }),
    /受管镜像副本/,
  );
});

test("Windows Antigravity skills.json manifest sync in copy & link modes, macOS unaffected", () => {
  const manifestPath = path.join(userHome, ".gemini", "config", "skills.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        exclude: ["legacy-ignored"],
        entries: [{ path: "C:/custom/my-skills" }],
      },
      null,
      2,
    ),
    "utf8",
  );

  const personalDir = path.join(userHome, "skill-sources", "personal");
  addSource({ id: "personal", name: "个人", path: personalDir, trust: "github" });
  writeSkill(path.join(personalDir, "skills"), "skill-a");
  writeSkill(path.join(personalDir, "skills"), "skill-b");

  toggleSkill({ skillRef: "personal:skill-a", enabled: true });
  toggleSkill({ skillRef: "personal:skill-b", enabled: true });
  toggleSkill({ skillRef: "personal:skill-b", enabled: false, targetId: "antigravity" });

  // Windows copy mode uses skills.json directly (with ~/ path) and creates zero copies in ~/.gemini/config/skills
  updateSettings({ syncMode: "copy" });
  const copySync = applySync({ platform: "win32" });
  assert.equal(copySync.errors.length, 0);
  assert.equal(safeLstat(path.join(userHome, ".gemini", "config", "skills", "skill-a")), null);

  const manifestAfterCopy = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.deepEqual(manifestAfterCopy.exclude, ["legacy-ignored"]);
  assert.equal(manifestAfterCopy.entries.length, 2);
  assert.equal(manifestAfterCopy.entries[0].path, "C:/custom/my-skills");
  assert.equal(manifestAfterCopy.entries[1].path, "~/skill-sources/personal/skills");
  assert.deepEqual(manifestAfterCopy.entries[1].include_only, ["skill-a"]);

  // Disabling antigravity removes only managed entries and keeps user entries
  updateTarget({ id: "antigravity", mode: "disabled" });
  const disabledSync = applySync({ platform: "win32" });
  assert.equal(disabledSync.errors.length, 0);

  const manifestAfterDisable = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.deepEqual(manifestAfterDisable.exclude, ["legacy-ignored"]);
  assert.deepEqual(manifestAfterDisable.entries, [{ path: "C:/custom/my-skills" }]);

  // When skills.json has no user entries, disabling antigravity or running on macOS removes managed entries cleanly
  fs.unlinkSync(manifestPath);
  updateTarget({ id: "antigravity", mode: "link" });
  applySync({ platform: "win32" });
  assert.equal(fs.existsSync(manifestPath), true);

  // macOS does not use skills.json manifest
  applySync({ platform: "darwin" });
  assert.equal(fs.existsSync(manifestPath), false);
});

test("planConsolidate skips managed source drift already owned by planSync", () => {
  updateSettings({ syncMode: "copy" });

  const personalDir = path.join(tmpRoot, "sources", "personal");
  addSource({ id: "personal", name: "个人", path: personalDir, trust: "github" });
  const srcA = writeSkill(path.join(personalDir, "skills"), "managed-a", {
    description: "v1",
  });
  toggleSkill({ skillRef: "personal:managed-a", enabled: true });
  applySync();

  // Edit source skill so managed copies drift
  fs.writeFileSync(
    path.join(srcA, "SKILL.md"),
    "---\nname: managed-a\ndescription: v2\n---\n\n# managed-a\n",
    "utf8",
  );

  // planSync reports hub + link targets needing update; planConsolidate must NOT duplicate them
  const syncPlan = planSync();
  assert.equal(syncPlan.summary.replace, process.platform === "win32" ? 2 : 3);
  const consPlan = planConsolidate();
  assert.equal(consPlan.summary.totalActions, 0);
});

test("pushSource auto-syncs local managed copies in copy mode", () => {
  updateSettings({ syncMode: "copy" });
  const personalDir = path.join(tmpRoot, "sources", "personal");
  const bareRemote = path.join(tmpRoot, "push-sync-remote.git");
  execFileSync("git", ["init", "--bare", bareRemote]);
  fs.writeFileSync(
    path.join(userHome, ".gitconfig"),
    "[user]\n\tname = Copy Push Tester\n\temail = copy-push@example.com\n",
    "utf8",
  );

  addSource({ id: "personal", name: "个人", path: personalDir, trust: "github" });
  execFileSync("git", ["remote", "add", "origin", bareRemote], { cwd: personalDir });
  const srcA = writeSkill(path.join(personalDir, "skills"), "skill-a", { description: "v1" });
  toggleSkill({ skillRef: "personal:skill-a", enabled: true });
  applySync();

  fs.writeFileSync(
    path.join(srcA, "SKILL.md"),
    "---\nname: skill-a\ndescription: v2 pushed\n---\n",
    "utf8",
  );
  const res = pushSource({ sourceId: "personal", message: "update skill-a" });
  assert.equal(res.pushed, true);
  assert.ok(res.sync);
  assert.equal(res.sync.errors.length, 0);
  assert.ok(
    fs
      .readFileSync(path.join(userHome, ".claude", "skills", "skill-a", "SKILL.md"), "utf8")
      .includes("v2 pushed"),
  );
  assert.equal(planSync().summary.totalPending, 0);
});

test("git pull --rebase --autostash and push auto-rebase handle diverged repos and roll back conflicts cleanly", () => {
  process.env.SKILL_HUB_SYNC_MODE = "link";
  const bareRemote = path.join(tmpRoot, "remote.git");
  const repoA = path.join(tmpRoot, "sources", "device-a");
  const repoB = path.join(tmpRoot, "device-b");

  execFileSync("git", ["init", "--bare", bareRemote]);
  fs.writeFileSync(
    path.join(userHome, ".gitconfig"),
    "[user]\n\tname = Sync Tester\n\temail = sync@example.com\n",
    "utf8",
  );

  addSource({ id: "personal", name: "个人", path: repoA, trust: "github" });
  execFileSync("git", ["remote", "add", "origin", bareRemote], { cwd: repoA });
  writeSkill(path.join(repoA, "skills"), "skill-a", { description: "A v1" });
  writeSkill(path.join(repoA, "skills"), "skill-b", { description: "B v1" });
  const initPush = pushSource({ sourceId: "personal", message: "init" });
  assert.equal(initPush.pushed, true);
  assert.equal(initPush.rebased, false);

  // Clone a second device repoB from bareRemote
  execFileSync("git", ["clone", bareRemote, repoB]);
  execFileSync("git", ["config", "user.name", "Device B"], { cwd: repoB });
  execFileSync("git", ["config", "user.email", "b@example.com"], { cwd: repoB });

  // 1. Device B edits skill-b and pushes; Device A has uncommitted edits on skill-a -> pullSources succeeds seamlessly
  fs.writeFileSync(
    path.join(repoB, "skills", "skill-b", "SKILL.md"),
    "---\nname: skill-b\ndescription: B from remote\n---\n",
    "utf8",
  );
  execFileSync("git", ["add", "-A"], { cwd: repoB });
  execFileSync("git", ["commit", "-m", "remote update B"], { cwd: repoB });
  execFileSync("git", ["push"], { cwd: repoB });

  fs.writeFileSync(
    path.join(repoA, "skills", "skill-a", "SKILL.md"),
    "---\nname: skill-a\ndescription: A local dirty\n---\n",
    "utf8",
  );

  const pull1 = pullSources({ sourceId: "personal", autoSync: false });
  assert.equal(pull1.ok, true);
  assert.equal(pull1.results[0].rebased, true);
  assert.ok(fs.readFileSync(path.join(repoA, "skills", "skill-b", "SKILL.md"), "utf8").includes("B from remote"));
  assert.ok(fs.readFileSync(path.join(repoA, "skills", "skill-a", "SKILL.md"), "utf8").includes("A local dirty"));

  // 2. Device B pushes another update to skill-b; Device A clicks pushSource directly -> auto-rebases & pushes cleanly
  fs.writeFileSync(
    path.join(repoB, "skills", "skill-b", "SKILL.md"),
    "---\nname: skill-b\ndescription: B from remote v2\n---\n",
    "utf8",
  );
  execFileSync("git", ["add", "-A"], { cwd: repoB });
  execFileSync("git", ["commit", "-m", "remote update B v2"], { cwd: repoB });
  execFileSync("git", ["push"], { cwd: repoB });

  const push2 = pushSource({ sourceId: "personal", message: "local update A" });
  assert.equal(push2.ok, true);
  assert.equal(push2.committed, true);
  assert.equal(push2.rebased, true);
  assert.equal(push2.pushed, true);
  assert.ok(fs.readFileSync(path.join(repoA, "skills", "skill-b", "SKILL.md"), "utf8").includes("B from remote v2"));

  // 3. Same-line conflict on uncommitted local edit during pull -> rolls back cleanly without conflict markers
  execFileSync("git", ["pull", "--rebase"], { cwd: repoB });
  fs.writeFileSync(
    path.join(repoB, "skills", "skill-a", "SKILL.md"),
    "---\nname: skill-a\ndescription: A remote conflict\n---\n",
    "utf8",
  );
  execFileSync("git", ["add", "-A"], { cwd: repoB });
  execFileSync("git", ["commit", "-m", "remote conflict A"], { cwd: repoB });
  execFileSync("git", ["push"], { cwd: repoB });

  fs.writeFileSync(
    path.join(repoA, "skills", "skill-a", "SKILL.md"),
    "---\nname: skill-a\ndescription: A local conflict\n---\n",
    "utf8",
  );

  const pullConflict = pullSources({ sourceId: "personal", autoSync: false });
  assert.equal(pullConflict.ok, false);
  assert.match(pullConflict.results[0].error, /冲突/);
  const aAfterPullConflict = fs.readFileSync(path.join(repoA, "skills", "skill-a", "SKILL.md"), "utf8");
  assert.ok(aAfterPullConflict.includes("A local conflict"));
  assert.equal(aAfterPullConflict.includes("<<<<<<<"), false);
  assert.equal(fs.existsSync(path.join(repoA, ".git", "rebase-merge")), false);

  // 4. Same-line conflict during pushSource -> aborts rebase cleanly and keeps local commit intact
  assert.throws(
    () => pushSource({ sourceId: "personal", message: "local conflict commit" }),
    (err) => err.code === "GIT_CONFLICT" && /skill-a\/SKILL\.md/.test(err.message),
  );
  assert.equal(fs.existsSync(path.join(repoA, ".git", "rebase-merge")), false);
  const aAfterPushConflict = fs.readFileSync(path.join(repoA, "skills", "skill-a", "SKILL.md"), "utf8");
  assert.ok(aAfterPushConflict.includes("A local conflict"));
  assert.equal(aAfterPushConflict.includes("<<<<<<<"), false);
});
