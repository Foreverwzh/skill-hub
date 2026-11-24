import { exists, readFile } from "fs/promises";
import os from "os";
import path from "path";
import process from "process";
import { realpath } from "smelt-fs";

let cachedRuntime = null;

function resolveHubConfigDir() {
  if (process.env.SKILL_HUB_HOME) {
    return path.resolve(process.env.SKILL_HUB_HOME);
  }
  const home = process.env.SKILL_HUB_USER_HOME || os.homedir();
  return path.join(home, ".skill-hub");
}

function fileUrlToPath(fileUrl) {
  try {
    let p = decodeURIComponent(new URL(fileUrl).pathname);
    if (process.platform === "win32" && /^\/[A-Za-z]:/.test(p)) {
      p = p.slice(1);
    }
    return p;
  } catch {
    return null;
  }
}

async function findNodeBinary(preferred) {
  const home = os.homedir();
  const candidates = [
    preferred,
    path.join(home, ".local", "share", "mise", "shims", "node"),
    path.join(home, ".nvm", "current", "bin", "node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (await exists(candidate)) {
        return candidate;
      }
    } catch {
      // Try next candidate
    }
  }
  return "node";
}

async function findCliScript(preferred) {
  const candidates = [];
  if (preferred) candidates.push(preferred);
  if (process.env.SKILL_HUB_CLI) candidates.push(process.env.SKILL_HUB_CLI);

  const bridgeFile = fileUrlToPath(import.meta.url);
  if (bridgeFile) {
    const pluginDir = path.resolve(path.dirname(bridgeFile), "..");
    candidates.push(path.resolve(pluginDir, "..", "bin", "skill-hub.mjs"));
    const realPluginDir = realpath(pluginDir);
    if (realPluginDir) {
      candidates.push(path.resolve(realPluginDir, "..", "bin", "skill-hub.mjs"));
    }
  }

  const installedPluginDir = path.join(os.homedir(), ".smelt", "plugins", "ai.smelt.skill-hub");
  const realInstalled = realpath(installedPluginDir);
  if (realInstalled) {
    candidates.push(path.resolve(realInstalled, "..", "bin", "skill-hub.mjs"));
  }

  for (const candidate of candidates) {
    try {
      if (candidate && (await exists(candidate))) {
        return candidate;
      }
    } catch {
      // Try next candidate
    }
  }

  throw new Error(
    "找不到 skill-hub CLI (bin/skill-hub.mjs)，请在仓库目录运行 node scripts/install.mjs",
  );
}

export async function resolveRuntime(forceRefresh = false) {
  if (cachedRuntime && !forceRefresh) return cachedRuntime;

  let runtimeJson = null;
  try {
    const runtimePath = path.join(resolveHubConfigDir(), "runtime.json");
    if (await exists(runtimePath)) {
      runtimeJson = JSON.parse(await readFile(runtimePath, "utf8"));
    }
  } catch {
    runtimeJson = null;
  }

  const nodePath = await findNodeBinary(runtimeJson?.nodePath);
  const cliPath = await findCliScript(runtimeJson?.cliPath);
  cachedRuntime = { nodePath, cliPath };
  return cachedRuntime;
}

const FORWARDED_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USER",
  "LOGNAME",
  "PATH",
  "SSH_AUTH_SOCK",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "LANG",
  "LC_ALL",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "TEMP",
  "TMP",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "SKILL_HUB_HOME",
  "SKILL_HUB_USER_HOME",
  "SKILL_HUB_SYNC_MODE",
];

function collectForwardedEnv() {
  const env = process.env || {};
  const out = {};
  for (const key of FORWARDED_ENV_KEYS) {
    if (typeof env[key] === "string" && env[key].length > 0) {
      out[key] = env[key];
    }
  }
  if (!out.HOME) {
    out.HOME = os.homedir();
  }
  if (process.platform === "win32" && !out.USERPROFILE) {
    out.USERPROFILE = os.homedir();
  }
  return out;
}

export async function runCli(args, { timeoutMs = 60000 } = {}) {
  const { nodePath, cliPath } = await resolveRuntime();
  const fullArgs = [cliPath, ...args, "--env-json", JSON.stringify(collectForwardedEnv())];
  if (!fullArgs.includes("--json")) fullArgs.push("--json");

  const out = await process.run(nodePath, fullArgs, { timeoutMs });
  const stdout = (out.stdout || "").trim();
  const stderr = (out.stderr || "").trim();

  if (out.code !== 0) {
    let parsedErr = null;
    try {
      parsedErr = JSON.parse(stderr || stdout);
    } catch {
      parsedErr = null;
    }
    const msg = parsedErr?.error || stderr || stdout || `命令退出码 ${out.code}`;
    const err = new Error(msg);
    err.code = parsedErr?.code || `EXIT_${out.code}`;
    err.violations = parsedErr?.violations || null;
    throw err;
  }

  if (!stdout) return { ok: true };
  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(`解析 skill-hub 输出失败: ${e.message}\n${stdout.slice(0, 300)}`);
  }
}

export const TRUST_LABELS = {
  github: "GitHub 通用",
  internal: "公司内网",
  local: "仅本地",
};

export const MODE_LABELS = {
  link: "独立挂载",
  "hub-only": "仅读中枢",
  disabled: "停用",
};

export const SYNC_MODE_LABELS = {
  auto: "自动（macOS/Linux 软链 · Windows 镜像副本）",
  copy: "受管镜像副本（兼容 Windows）",
  link: "软链 / Junction",
};
