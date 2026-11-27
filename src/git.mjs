import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGuardConfig, loadRuntimeInfo } from "./config.mjs";
import {
  extractHostFromRemoteUrl,
  guardSource,
  hasPrePushHook,
  validateRemoteUrlForTrust,
} from "./guard.mjs";
import { getUserHome, IS_WINDOWS, safeLstat, safeStat } from "./paths.mjs";

function isExecutableFile(filePath) {
  return Boolean(filePath && safeStat(filePath)?.isFile());
}

/**
 * Resolves the absolute path to `git` even when launched from GUI apps (like Smelt on Windows)
 * whose PATH omits custom Git install directories (e.g. `E:\AI\tools\Git\cmd`).
 */
export function resolveGitBinary() {
  const runtime = loadRuntimeInfo();
  if (runtime?.gitPath && isExecutableFile(runtime.gitPath)) {
    return runtime.gitPath;
  }

  const binName = IS_WINDOWS ? "git.exe" : "git";
  const pathDirs = (process.env.PATH || "")
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
  const home = getUserHome();
  const fallbackDirs = IS_WINDOWS
    ? [
        "C:\\Program Files\\Git\\cmd",
        "C:\\Program Files\\Git\\bin",
        "C:\\Program Files (x86)\\Git\\cmd",
        path.join(home, "scoop", "shims"),
        path.join(home, "AppData", "Local", "Programs", "Git", "cmd"),
      ]
    : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

  for (const dir of [...pathDirs, ...fallbackDirs]) {
    const candidate = path.join(dir, binName);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return "git";
}

export function buildGitEnv(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  const home = getUserHome();
  const gitBin = resolveGitBinary();
  const gitDir = path.isAbsolute(gitBin) ? path.dirname(gitBin) : null;

  if (IS_WINDOWS) {
    if (!env.USERPROFILE) env.USERPROFILE = home;
    if (!env.HOME) env.HOME = home;
  } else {
    if (!env.HOME) env.HOME = home;
  }

  if (!env.USER && !env.LOGNAME) {
    try {
      const username = os.userInfo().username;
      if (username) env.USER = username;
    } catch {
      // Ignore userInfo failures in stripped containers
    }
  }

  const currentParts = (env.PATH || "")
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
  const extraParts = IS_WINDOWS
    ? [
        ...(gitDir ? [gitDir] : []),
        path.dirname(process.execPath),
        "C:\\Program Files\\Git\\cmd",
      ]
    : [
        ...(gitDir ? [gitDir] : []),
        path.dirname(process.execPath),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ];
  const mergedPath = [];
  const seen = new Set();
  for (const part of [...currentParts, ...extraParts]) {
    if (!part || seen.has(part)) continue;
    seen.add(part);
    mergedPath.push(part);
  }
  env.PATH = mergedPath.join(path.delimiter);

  if (!env.GIT_TERMINAL_PROMPT) {
    env.GIT_TERMINAL_PROMPT = "0";
  }

  return env;
}

function runGit(cwd, args, options = {}) {
  try {
    const { env: extraEnv, ...restOptions } = options;
    const gitBin = resolveGitBinary();
    const out = execFileSync(gitBin, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: buildGitEnv(extraEnv),
      ...restOptions,
    });
    return { ok: true, stdout: out.trimEnd(), stderr: "" };
  } catch (err) {
    return {
      ok: false,
      code: err.status ?? 1,
      stdout: String(err.stdout || "").trimEnd(),
      stderr: String(err.stderr || err.message || "").trim(),
    };
  }
}

export function isGitRepo(dirPath) {
  if (!safeLstat(dirPath)) return false;
  const res = runGit(dirPath, ["rev-parse", "--is-inside-work-tree"]);
  return res.ok && res.stdout.trim() === "true";
}

export function gitInit(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  const res = runGit(dirPath, ["init"]);
  if (!res.ok) {
    throw new Error(`git init 失败: ${res.stderr}`);
  }
  return res;
}

export function gitClone(cloneUrl, targetDir) {
  const parent = path.dirname(targetDir);
  fs.mkdirSync(parent, { recursive: true });
  const res = runGit(parent, ["clone", cloneUrl, targetDir]);
  if (!res.ok) {
    throw new Error(`git clone 失败: ${res.stderr || res.stdout}`);
  }
  return res;
}

export function getRemotes(dirPath) {
  if (!isGitRepo(dirPath)) return [];
  const res = runGit(dirPath, ["remote", "-v"]);
  if (!res.ok || !res.stdout) return [];

  const seen = new Map();
  for (const line of res.stdout.split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!m) continue;
    const [, name, url, kind] = m;
    // Prefer push URL if present, otherwise fetch URL
    if (!seen.has(name) || kind === "push") {
      seen.set(name, {
        name,
        url,
        host: extractHostFromRemoteUrl(url),
      });
    }
  }
  return [...seen.values()];
}

export function setOriginRemote(dirPath, remoteUrl) {
  const remotes = getRemotes(dirPath);
  const hasOrigin = remotes.some((r) => r.name === "origin");
  const args = hasOrigin
    ? ["remote", "set-url", "origin", remoteUrl]
    : ["remote", "add", "origin", remoteUrl];
  const res = runGit(dirPath, args);
  if (!res.ok) {
    throw new Error(`设置 origin remote 失败: ${res.stderr}`);
  }
}

export function getRepoStatus(dirPath, skillsRelDir = "skills") {
  if (!isGitRepo(dirPath)) {
    return {
      isGit: false,
      branch: null,
      remotes: [],
      hasRemote: false,
      ahead: 0,
      behind: 0,
      dirty: false,
      changedFiles: [],
      changedSkills: [],
      hasHook: false,
    };
  }

  const branchRes = runGit(dirPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchRes.ok ? branchRes.stdout.trim() : "HEAD";
  const remotes = getRemotes(dirPath);
  const hasRemote = remotes.length > 0;

  let ahead = 0;
  let behind = 0;
  const upstreamRes = runGit(dirPath, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
  if (upstreamRes.ok && upstreamRes.stdout) {
    const parts = upstreamRes.stdout.trim().split(/\s+/);
    if (parts.length === 2) {
      behind = Number.parseInt(parts[0], 10) || 0;
      ahead = Number.parseInt(parts[1], 10) || 0;
    }
  }

  const statusRes = runGit(dirPath, ["status", "--porcelain=v1", "-uall"]);
  const changedFiles = [];
  const changedSkillSet = new Set();
  const normalizedSkillsPrefix =
    skillsRelDir === "." ? "" : `${skillsRelDir.replace(/\\/g, "/").replace(/\/+$/, "")}/`;

  if (statusRes.ok && statusRes.stdout) {
    for (const line of statusRes.stdout.split(/\r?\n/)) {
      if (!line) continue;
      const xy = line.slice(0, 2);
      let filePath = line.slice(3).trim();
      if (filePath.includes(" -> ")) {
        filePath = filePath.split(" -> ").pop();
      }
      if (filePath.startsWith('"') && filePath.endsWith('"')) {
        filePath = filePath.slice(1, -1);
      }
      changedFiles.push({ status: xy.trim() || "M", path: filePath });

      const posix = filePath.replace(/\\/g, "/");
      if (normalizedSkillsPrefix === "") {
        const firstSeg = posix.split("/")[0];
        if (firstSeg && !firstSeg.startsWith(".") && firstSeg !== "source.json" && firstSeg !== "profiles.json") {
          changedSkillSet.add(firstSeg);
        }
      } else if (posix.startsWith(normalizedSkillsPrefix)) {
        const rest = posix.slice(normalizedSkillsPrefix.length);
        const skillSeg = rest.split("/")[0];
        if (skillSeg) changedSkillSet.add(skillSeg);
      }
    }
  }

  return {
    isGit: true,
    branch,
    remotes,
    hasRemote,
    ahead,
    behind,
    dirty: changedFiles.length > 0,
    changedFiles,
    changedSkills: [...changedSkillSet].sort(),
    hasHook: hasPrePushHook(dirPath),
  };
}

function listConflictedFiles(dirPath) {
  const res = runGit(dirPath, ["diff", "--name-only", "--diff-filter=U"]);
  if (!res.ok || !res.stdout) return [];
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isRebaseInProgress(dirPath) {
  for (const name of ["rebase-merge", "rebase-apply"]) {
    const pRes = runGit(dirPath, ["rev-parse", "--git-path", name]);
    if (pRes.ok && pRes.stdout) {
      const fullPath = path.isAbsolute(pRes.stdout)
        ? pRes.stdout
        : path.resolve(dirPath, pRes.stdout);
      if (safeLstat(fullPath)) return true;
    }
  }
  return false;
}

function getBehindCount(dirPath) {
  const res = runGit(dirPath, ["rev-list", "--count", "HEAD..@{u}"]);
  if (!res.ok || !res.stdout) return 0;
  return Number.parseInt(res.stdout.trim(), 10) || 0;
}

/**
 * Safely rebases local commits (and optionally autostashed working-tree changes)
 * onto `@{u}`. On conflict, aborts and restores the exact pre-rebase state so
 * skill files are never left with conflict markers or an unfinished rebase.
 */
function safeRebaseOntoUpstream(dirPath, { allowAutostash = true } = {}) {
  const behind = getBehindCount(dirPath);
  if (behind === 0) {
    return { rebased: false, output: "Already up to date." };
  }

  const origHeadRes = runGit(dirPath, ["rev-parse", "HEAD"]);
  const origHead = origHeadRes.ok ? origHeadRes.stdout.trim() : null;

  let stashed = false;
  if (allowAutostash) {
    const dirtyRes = runGit(dirPath, ["status", "--porcelain=v1", "-uall"]);
    if (dirtyRes.ok && dirtyRes.stdout.trim().length > 0) {
      const stashRes = runGit(dirPath, [
        "stash",
        "push",
        "--include-untracked",
        "-m",
        "skill-hub-autostash",
      ]);
      if (!stashRes.ok) {
        throw new Error(`暂存本地改动失败: ${stashRes.stderr || stashRes.stdout}`);
      }
      stashed = !stashRes.stdout.includes("No local changes to save");
    }
  }

  const rebaseRes = runGit(dirPath, ["rebase", "@{u}"]);
  if (!rebaseRes.ok) {
    const conflicts = listConflictedFiles(dirPath);
    if (isRebaseInProgress(dirPath)) {
      runGit(dirPath, ["rebase", "--abort"]);
    }
    if (stashed) {
      runGit(dirPath, ["stash", "pop"]);
    }
    const detail =
      conflicts.length > 0
        ? `冲突文件: ${conflicts.join(", ")}`
        : rebaseRes.stderr || rebaseRes.stdout;
    const err = new Error(
      `本地与远端存在同文件冲突，已自动中止变基并保留本地原样（${detail}），请手动合并后再试`,
    );
    err.code = "GIT_CONFLICT";
    err.conflicts = conflicts;
    throw err;
  }

  if (stashed) {
    const popRes = runGit(dirPath, ["stash", "pop"]);
    if (!popRes.ok) {
      const conflicts = listConflictedFiles(dirPath);
      if (origHead) {
        runGit(dirPath, ["reset", "--hard", origHead]);
        runGit(dirPath, ["stash", "pop"]);
      }
      const detail =
        conflicts.length > 0
          ? `冲突文件: ${conflicts.join(", ")}`
          : popRes.stderr || popRes.stdout;
      const err = new Error(
        `本地未提交改动与远端更新冲突，已自动回滚并保留你的本地改动（${detail}），请先提交或手动合并后再拉取`,
      );
      err.code = "GIT_CONFLICT";
      err.conflicts = conflicts;
      throw err;
    }
  }

  return {
    rebased: true,
    output: rebaseRes.stdout || "Rebased onto upstream.",
  };
}

export function gitPull(source) {
  if (!isGitRepo(source.absPath)) {
    return { ok: true, skipped: true, reason: "非 Git 仓库，已跳过拉取" };
  }
  const remotes = getRemotes(source.absPath);
  if (remotes.length === 0) {
    return { ok: true, skipped: true, reason: "未配置 Git remote，已跳过拉取" };
  }

  // Also guard remotes before pulling
  const guardConfig = loadGuardConfig();
  for (const r of remotes) {
    const violations = validateRemoteUrlForTrust({
      url: r.url,
      trust: source.trust,
      guardConfig,
    });
    if (violations.length > 0) {
      throw new Error(violations.map((v) => v.message).join("; "));
    }
  }

  const fetchRes = runGit(source.absPath, ["fetch", "--prune"]);
  if (!fetchRes.ok) {
    throw new Error(`git fetch 失败: ${fetchRes.stderr || fetchRes.stdout}`);
  }

  const upstreamRes = runGit(source.absPath, ["rev-parse", "--abbrev-ref", "@{u}"]);
  if (!upstreamRes.ok) {
    return { ok: true, skipped: true, reason: "当前分支尚未关联上游分支（已完成 fetch）" };
  }

  const rebaseRes = safeRebaseOntoUpstream(source.absPath, { allowAutostash: true });
  return {
    ok: true,
    skipped: false,
    rebased: rebaseRes.rebased,
    output: rebaseRes.output,
  };
}

export function gitCommitAndPush(source, { message, skipPush = false } = {}) {
  if (!isGitRepo(source.absPath)) {
    throw new Error(`源 "${source.id}" 不是 Git 仓库（trust=${source.trust}）`);
  }

  const remotes = getRemotes(source.absPath);
  const guardConfig = loadGuardConfig();
  const guardResult = guardSource(source, remotes, guardConfig);
  if (!guardResult.ok) {
    const err = new Error(
      `安全守卫拦截提交/推送（${source.id}）：\n${guardResult.violations.map((v) => `- ${v.message}`).join("\n")}`,
    );
    err.code = "GUARD_BLOCKED";
    err.violations = guardResult.violations;
    throw err;
  }

  const statusBefore = getRepoStatus(source.absPath, source.skillsRelDir);
  let committed = false;

  if (statusBefore.dirty) {
    const addRes = runGit(source.absPath, ["add", "-A"]);
    if (!addRes.ok) {
      throw new Error(`git add 失败: ${addRes.stderr}`);
    }
    const commitMsg =
      (message && message.trim()) ||
      `chore(skills): update ${statusBefore.changedSkills.join(", ") || "skills"}`;
    const commitRes = runGit(source.absPath, ["commit", "-m", commitMsg]);
    if (!commitRes.ok) {
      throw new Error(`git commit 失败: ${commitRes.stderr || commitRes.stdout}`);
    }
    committed = true;
  }

  let rebased = false;
  let pushed = false;
  let pushOutput = "";
  if (!skipPush) {
    if (remotes.length === 0) {
      return {
        ok: true,
        committed,
        rebased: false,
        pushed: false,
        note: "已完成本地提交，但该源尚未配置 Git remote（未推送）",
      };
    }

    const upstreamRes = runGit(source.absPath, ["rev-parse", "--abbrev-ref", "@{u}"]);
    const hasUpstream = upstreamRes.ok;

    if (hasUpstream) {
      const fetchRes = runGit(source.absPath, ["fetch", "--prune"]);
      if (!fetchRes.ok) {
        throw new Error(`git fetch 失败: ${fetchRes.stderr || fetchRes.stdout}`);
      }
      const rebaseOutcome = safeRebaseOntoUpstream(source.absPath, { allowAutostash: false });
      rebased = rebaseOutcome.rebased;
    }

    const pushArgs = hasUpstream
      ? ["push"]
      : ["push", "-u", remotes[0].name, statusBefore.branch || "HEAD"];
    let pushRes = runGit(source.absPath, pushArgs);

    // Handle concurrent remote push between fetch and push with one automatic rebase retry
    if (
      !pushRes.ok &&
      hasUpstream &&
      /(non-fast-forward|fetch first|rejected)/i.test(`${pushRes.stderr}\n${pushRes.stdout}`)
    ) {
      const retryFetch = runGit(source.absPath, ["fetch", "--prune"]);
      if (retryFetch.ok) {
        const retryRebase = safeRebaseOntoUpstream(source.absPath, { allowAutostash: false });
        rebased = rebased || retryRebase.rebased;
        pushRes = runGit(source.absPath, pushArgs);
      }
    }

    if (!pushRes.ok) {
      throw new Error(`git push 失败: ${pushRes.stderr || pushRes.stdout}`);
    }
    pushed = true;
    pushOutput = pushRes.stdout || pushRes.stderr;
  }

  return {
    ok: true,
    committed,
    rebased,
    pushed,
    pushOutput,
    ...(rebased ? { note: "已自动拉取并变基远端更新，随后完成推送" } : {}),
  };
}
