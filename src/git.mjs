import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGuardConfig } from "./config.mjs";
import {
  extractHostFromRemoteUrl,
  guardSource,
  hasPrePushHook,
  validateRemoteUrlForTrust,
} from "./guard.mjs";
import { getUserHome, IS_WINDOWS, safeLstat } from "./paths.mjs";

export function buildGitEnv(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  const home = getUserHome();

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
    ? [path.dirname(process.execPath)]
    : [
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
    const out = execFileSync("git", args, {
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

  const pullRes = runGit(source.absPath, ["pull", "--ff-only"]);
  if (!pullRes.ok) {
    throw new Error(
      `git pull --ff-only 失败（可能存在本地冲突或分叉，请手动处理）: ${pullRes.stderr || pullRes.stdout}`,
    );
  }

  return {
    ok: true,
    skipped: false,
    output: pullRes.stdout || "Already up to date.",
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

  let pushed = false;
  let pushOutput = "";
  if (!skipPush) {
    if (remotes.length === 0) {
      return {
        ok: true,
        committed,
        pushed: false,
        note: "已完成本地提交，但该源尚未配置 Git remote（未推送）",
      };
    }

    const upstreamRes = runGit(source.absPath, ["rev-parse", "--abbrev-ref", "@{u}"]);
    const pushArgs = upstreamRes.ok
      ? ["push"]
      : ["push", "-u", remotes[0].name, statusBefore.branch || "HEAD"];
    const pushRes = runGit(source.absPath, pushArgs);
    if (!pushRes.ok) {
      throw new Error(`git push 失败: ${pushRes.stderr || pushRes.stdout}`);
    }
    pushed = true;
    pushOutput = pushRes.stdout || pushRes.stderr;
  }

  return {
    ok: true,
    committed,
    pushed,
    pushOutput,
  };
}
