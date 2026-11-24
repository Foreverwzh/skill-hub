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
import { saveConfig } from "../src/config.mjs";
import { createDirLink, safeLstat, safeRealpath } from "../src/paths.mjs";

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
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("multi-source isolation, profiles, per-target overrides, and non-destructive cleanup", () => {
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
