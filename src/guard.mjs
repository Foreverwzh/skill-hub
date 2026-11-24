import fs from "node:fs";
import path from "node:path";
import { loadGuardConfig } from "./config.mjs";
import { readJsonIfExists, safeLstat, safeStat } from "./paths.mjs";

export const HOOK_MARKER = "# skill-hub-guard";
const MAX_SCAN_FILE_BYTES = 1024 * 1024; // 1 MiB

/**
 * Extracts lowercase hostname from HTTPS, SSH, or SCP-style git remote URLs.
 * Returns "" for local filesystem paths or file:// URLs.
 */
export function extractHostFromRemoteUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  const url = rawUrl.trim();
  if (!url || url.startsWith("/") || url.startsWith("./") || url.startsWith("../")) {
    return "";
  }
  if (/^[A-Za-z]:[\\/]/.test(url) || url.startsWith("file://")) {
    return "";
  }
  // Standard URL: https://..., http://..., ssh://git@host:22/path, git://host/path
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
    try {
      const parsed = new URL(url);
      return (parsed.hostname || "").toLowerCase();
    } catch {
      return "";
    }
  }
  // SCP-like syntax: [user@]host:path
  const scpMatch = url.match(/^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):.+$/);
  if (scpMatch) {
    return scpMatch[1].toLowerCase();
  }
  return "";
}

function hostMatchesDomain(host, domain) {
  if (!host || !domain) return false;
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/**
 * Validates a single remote URL against a source's trust level and host rules.
 */
export function validateRemoteUrlForTrust({
  url,
  trust,
  allowedRemoteHosts = [],
  forbiddenRemoteHosts = [],
  guardConfig = loadGuardConfig(),
}) {
  const violations = [];
  const host = extractHostFromRemoteUrl(url);

  if (trust === "local") {
    violations.push({
      code: "LOCAL_SOURCE_REMOTE",
      message: `仅本地源（local）禁止配置任何 Git 远端: ${url}`,
    });
    return violations;
  }

  if (trust === "internal") {
    const forbidden = [
      ...(guardConfig.forbiddenPublicHosts || []),
      ...(forbiddenRemoteHosts || []),
    ];
    for (const bad of forbidden) {
      if (hostMatchesDomain(host, bad)) {
        violations.push({
          code: "FORBIDDEN_PUBLIC_REMOTE",
          message: `公司专用源（internal）严禁绑定公网托管域名 "${bad}"（检测到 ${url}）`,
        });
        break;
      }
    }

    if (allowedRemoteHosts.length > 0) {
      const matched = allowedRemoteHosts.some((allow) => hostMatchesDomain(host, allow));
      if (!matched) {
        violations.push({
          code: "REMOTE_NOT_IN_ALLOWLIST",
          message: `远端地址 "${url}" 不在允许的内网域名白名单 [${allowedRemoteHosts.join(", ")}] 内`,
        });
      }
    }
  }

  return violations;
}

/**
 * Checks all configured git remotes of a source against its trust rules.
 */
export function checkRemotes(source, remotes, guardConfig = loadGuardConfig()) {
  const metaPath = path.join(source.absPath, "source.json");
  const meta = readJsonIfExists(metaPath, null) || {};
  const allowedRemoteHosts = Array.isArray(meta.allowedRemoteHosts)
    ? meta.allowedRemoteHosts
    : [];
  const forbiddenRemoteHosts = Array.isArray(meta.forbiddenRemoteHosts)
    ? meta.forbiddenRemoteHosts
    : [];

  const violations = [];
  for (const remote of remotes) {
    const errs = validateRemoteUrlForTrust({
      url: remote.url,
      trust: source.trust,
      allowedRemoteHosts,
      forbiddenRemoteHosts,
      guardConfig,
    });
    for (const err of errs) {
      violations.push({
        ...err,
        remote: remote.name,
        url: remote.url,
      });
    }
  }
  return violations;
}

function isLikelyBinary(buf) {
  const len = Math.min(buf.length, 4096);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function compileMatchers(guardConfig) {
  const matchers = [];
  for (const kw of guardConfig.keywords || []) {
    const needle = String(kw).trim();
    if (!needle) continue;
    const lower = needle.toLowerCase();
    matchers.push({
      rule: `keyword:${needle}`,
      testLine(line) {
        return line.toLowerCase().includes(lower);
      },
    });
  }
  for (const pattern of guardConfig.regexPatterns || []) {
    const raw = String(pattern).trim();
    if (!raw) continue;
    try {
      const re = new RegExp(raw, "i");
      matchers.push({
        rule: `regex:${raw}`,
        testLine(line) {
          return re.test(line);
        },
      });
    } catch {
      // Ignore malformed user regex rather than crashing scans; report as warning separately if needed
    }
  }
  return matchers;
}

/**
 * Scans a directory tree for sensitive keywords or secret regex patterns.
 */
export function scanDirectoryForLeaks(dirPath, guardConfig = loadGuardConfig()) {
  const rootStat = safeStat(dirPath);
  if (!rootStat || !rootStat.isDirectory()) return [];

  const matchers = compileMatchers(guardConfig);
  if (matchers.length === 0) return [];

  const ignoreSet = new Set(guardConfig.ignorePaths || [".git", "node_modules", ".DS_Store"]);
  const findings = [];

  function walk(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ignoreSet.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      let st;
      try {
        st = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (st.size === 0 || st.size > MAX_SCAN_FILE_BYTES) continue;

      let buf;
      try {
        buf = fs.readFileSync(fullPath);
      } catch {
        continue;
      }
      if (isLikelyBinary(buf)) continue;

      const text = buf.toString("utf8");
      const lines = text.split(/\r?\n/);
      const relFile = path.relative(dirPath, fullPath) || entry.name;

      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];
        for (const matcher of matchers) {
          if (matcher.testLine(lineText)) {
            const trimmed = lineText.trim();
            findings.push({
              code: "SENSITIVE_CONTENT_MATCH",
              file: relFile,
              line: i + 1,
              rule: matcher.rule,
              snippet: trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed,
              message: `命中敏感规则 [${matcher.rule}] @ ${relFile}:${i + 1}`,
            });
          }
        }
      }
    }
  }

  walk(dirPath);
  return findings;
}

/**
 * Full guard check for a source:
 * - Verifies git remote URLs against source trust level
 * - Scans contents for sensitive keywords/patterns when trust === "github"
 */
export function guardSource(source, remotes = [], guardConfig = loadGuardConfig()) {
  const violations = [...checkRemotes(source, remotes, guardConfig)];

  if (source.trust === "github") {
    const contentFindings = scanDirectoryForLeaks(source.absPath, guardConfig);
    violations.push(...contentFindings);
  }

  return {
    ok: violations.length === 0,
    sourceId: source.id,
    trust: source.trust,
    violations,
  };
}

function toPosixPath(p) {
  return p.split(path.sep).join("/");
}

function resolveGitHooksDir(repoDir) {
  const dotGit = path.join(repoDir, ".git");
  const st = safeLstat(dotGit);
  if (!st) return null;
  if (st.isDirectory()) {
    return path.join(dotGit, "hooks");
  }
  if (st.isFile()) {
    try {
      const content = fs.readFileSync(dotGit, "utf8");
      const m = content.match(/^gitdir:\s*(.+)$/m);
      if (m) {
        const gitDir = path.resolve(repoDir, m[1].trim());
        return path.join(gitDir, "hooks");
      }
    } catch {
      return null;
    }
  }
  return null;
}

export function hasPrePushHook(repoDir) {
  const hooksDir = resolveGitHooksDir(repoDir);
  if (!hooksDir) return false;
  const hookPath = path.join(hooksDir, "pre-push");
  try {
    const content = fs.readFileSync(hookPath, "utf8");
    return content.includes(HOOK_MARKER);
  } catch {
    return false;
  }
}

/**
 * Installs a cross-platform git pre-push hook calling `node <cliPath> guard --repo <repoDir>`.
 */
export function installPrePushHook(
  repoDir,
  { cliPath, nodePath = process.execPath, force = false } = {},
) {
  const hooksDir = resolveGitHooksDir(repoDir);
  if (!hooksDir) {
    return { installed: false, reason: "not-a-git-repo" };
  }
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, "pre-push");
  const existingStat = safeLstat(hookPath);
  if (existingStat) {
    try {
      const current = fs.readFileSync(hookPath, "utf8");
      if (!current.includes(HOOK_MARKER) && !force) {
        return {
          installed: false,
          reason: "existing-custom-hook",
          hookPath,
        };
      }
    } catch {
      if (!force) {
        return { installed: false, reason: "existing-custom-hook", hookPath };
      }
    }
  }

  const nodeBin = toPosixPath(nodePath || "node");
  const cli = toPosixPath(cliPath);
  const repo = toPosixPath(path.resolve(repoDir));
  const script = [
    "#!/usr/bin/env sh",
    HOOK_MARKER,
    `exec "${nodeBin}" "${cli}" guard --repo "${repo}"`,
    "",
  ].join("\n");

  fs.writeFileSync(hookPath, script, { encoding: "utf8", mode: 0o755 });
  try {
    fs.chmodSync(hookPath, 0o755);
  } catch {
    // Windows filesystems ignore POSIX mode bits; sh script still runs under Git for Windows
  }

  return { installed: true, hookPath };
}
