import os from "node:os";
import path from "node:path";
import {
  contractHome,
  expandHome,
  getHubConfigDir,
  getUserHome,
  readJsonIfExists,
  safeLstat,
  writeJsonAtomic,
} from "./paths.mjs";

export const TRUST_LEVELS = ["github", "internal", "local"];
export const TARGET_MODES = ["link", "hub-only", "disabled"];

export const KNOWN_AGENTS = [
  {
    id: "antigravity",
    label: "Antigravity",
    home: ".gemini/config",
    skillsDir: ".gemini/config/skills",
    defaultMode: "link",
    readsHub: true,
  },
  {
    id: "claude",
    label: "Claude Code",
    home: ".claude",
    skillsDir: ".claude/skills",
    defaultMode: "link",
    readsHub: false,
  },
  {
    id: "codex",
    label: "Codex",
    home: ".codex",
    skillsDir: ".codex/skills",
    defaultMode: "hub-only",
    readsHub: true,
  },
  {
    id: "cursor",
    label: "Cursor",
    home: ".cursor",
    skillsDir: ".cursor/skills",
    defaultMode: "link",
    readsHub: true,
  },
  {
    id: "opencode",
    label: "OpenCode",
    home: ".config/opencode",
    skillsDir: ".config/opencode/skills",
    defaultMode: "hub-only",
    readsHub: true,
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    home: ".gemini",
    skillsDir: ".gemini/skills",
    defaultMode: "hub-only",
    readsHub: true,
  },
  {
    id: "copilot",
    label: "Copilot",
    home: ".copilot",
    skillsDir: ".copilot/skills",
    defaultMode: "hub-only",
    readsHub: true,
  },
  {
    id: "kiro",
    label: "Kiro",
    home: ".kiro",
    skillsDir: ".kiro/skills",
    defaultMode: "hub-only",
    readsHub: true,
  },
];

export const DEFAULT_FORBIDDEN_PUBLIC_HOSTS = [
  "github.com",
  "gitlab.com",
  "gitee.com",
  "bitbucket.org",
  "codeberg.org",
];

export const DEFAULT_SECRET_REGEXES = [
  "(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)",
];

export function getConfigPaths() {
  const dir = getHubConfigDir();
  return {
    dir,
    configFile: path.join(dir, "config.json"),
    stateFile: path.join(dir, "state.json"),
    guardFile: path.join(dir, "guard.json"),
    runtimeFile: path.join(dir, "runtime.json"),
  };
}

export function detectAgentInstalled(agent) {
  const home = getUserHome();
  const homeDir = path.join(home, agent.home);
  const skillsDir = path.join(home, agent.skillsDir);
  const stHome = safeLstat(homeDir);
  const stSkills = safeLstat(skillsDir);
  return Boolean((stHome && stHome.isDirectory()) || stSkills);
}

export function buildDefaultTargets() {
  const targets = {};
  for (const agent of KNOWN_AGENTS) {
    const installed = detectAgentInstalled(agent);
    targets[agent.id] = {
      label: agent.label,
      path: `~/${agent.skillsDir}`,
      mode: installed ? agent.defaultMode : "disabled",
      include: [],
      exclude: [],
    };
  }
  return targets;
}

export function normalizeConfig(raw) {
  const defaults = {
    version: 1,
    deviceName: os.hostname(),
    hubDir: "~/.agents/skills",
    sources: [],
    enabledProfiles: [],
    include: [],
    exclude: [],
    targets: buildDefaultTargets(),
  };
  if (!raw || typeof raw !== "object") {
    return defaults;
  }

  const targets = {};
  const rawTargets = raw.targets && typeof raw.targets === "object" ? raw.targets : {};
  for (const agent of KNOWN_AGENTS) {
    const existing = rawTargets[agent.id];
    const detected = detectAgentInstalled(agent);
    if (existing && typeof existing === "object") {
      const mode = TARGET_MODES.includes(existing.mode)
        ? existing.mode
        : existing.enabled === false
          ? "disabled"
          : agent.defaultMode;
      targets[agent.id] = {
        label: existing.label || agent.label,
        path: existing.path || `~/${agent.skillsDir}`,
        mode,
        include: Array.isArray(existing.include) ? [...new Set(existing.include)] : [],
        exclude: Array.isArray(existing.exclude) ? [...new Set(existing.exclude)] : [],
      };
    } else {
      targets[agent.id] = {
        label: agent.label,
        path: `~/${agent.skillsDir}`,
        mode: detected ? agent.defaultMode : "disabled",
        include: [],
        exclude: [],
      };
    }
  }

  // Preserve custom user-defined targets outside KNOWN_AGENTS
  for (const [id, t] of Object.entries(rawTargets)) {
    if (targets[id] || !t || typeof t !== "object" || !t.path) continue;
    targets[id] = {
      label: t.label || id,
      path: t.path,
      mode: TARGET_MODES.includes(t.mode) ? t.mode : "link",
      include: Array.isArray(t.include) ? [...new Set(t.include)] : [],
      exclude: Array.isArray(t.exclude) ? [...new Set(t.exclude)] : [],
    };
  }

  const sources = Array.isArray(raw.sources)
    ? raw.sources
        .filter((s) => s && typeof s === "object" && s.id && s.path)
        .map((s) => ({
          id: String(s.id),
          name: String(s.name || s.id),
          path: contractHome(expandHome(String(s.path))),
          trust: TRUST_LEVELS.includes(s.trust) ? s.trust : "local",
          enabled: s.enabled !== false,
          skillsDir: s.skillsDir ? String(s.skillsDir) : undefined,
        }))
    : [];

  return {
    version: 1,
    deviceName: String(raw.deviceName || defaults.deviceName),
    hubDir: String(raw.hubDir || defaults.hubDir),
    sources,
    enabledProfiles: Array.isArray(raw.enabledProfiles)
      ? [...new Set(raw.enabledProfiles.map(String))]
      : [],
    include: Array.isArray(raw.include) ? [...new Set(raw.include.map(String))] : [],
    exclude: Array.isArray(raw.exclude) ? [...new Set(raw.exclude.map(String))] : [],
    targets,
  };
}

export function loadConfig() {
  const { configFile } = getConfigPaths();
  const raw = readJsonIfExists(configFile, null);
  return normalizeConfig(raw);
}

export function saveConfig(config) {
  const { configFile } = getConfigPaths();
  const normalized = normalizeConfig(config);
  writeJsonAtomic(configFile, normalized);
  return normalized;
}

export function loadState() {
  const { stateFile } = getConfigPaths();
  const raw = readJsonIfExists(stateFile, null);
  return {
    version: 1,
    managedLinks: Array.isArray(raw?.managedLinks) ? raw.managedLinks.map(String) : [],
  };
}

export function saveState(state) {
  const { stateFile } = getConfigPaths();
  const normalized = {
    version: 1,
    managedLinks: [...new Set((state?.managedLinks || []).map(String))].sort(),
  };
  writeJsonAtomic(stateFile, normalized);
  return normalized;
}

export function loadGuardConfig() {
  const { guardFile } = getConfigPaths();
  const raw = readJsonIfExists(guardFile, null);
  return {
    version: 1,
    forbiddenPublicHosts: Array.isArray(raw?.forbiddenPublicHosts)
      ? [...new Set(raw.forbiddenPublicHosts.map((h) => String(h).toLowerCase()))]
      : [...DEFAULT_FORBIDDEN_PUBLIC_HOSTS],
    keywords: Array.isArray(raw?.keywords)
      ? [...new Set(raw.keywords.map(String).filter(Boolean))]
      : [],
    regexPatterns: Array.isArray(raw?.regexPatterns)
      ? [...new Set(raw.regexPatterns.map(String).filter(Boolean))]
      : [...DEFAULT_SECRET_REGEXES],
    ignorePaths: Array.isArray(raw?.ignorePaths)
      ? [...new Set(raw.ignorePaths.map(String).filter(Boolean))]
      : [".git", "node_modules", ".DS_Store"],
  };
}

export function saveGuardConfig(guard) {
  const { guardFile } = getConfigPaths();
  const normalized = {
    version: 1,
    forbiddenPublicHosts: [...new Set((guard?.forbiddenPublicHosts || DEFAULT_FORBIDDEN_PUBLIC_HOSTS).map((h) => String(h).trim().toLowerCase()).filter(Boolean))],
    keywords: [...new Set((guard?.keywords || []).map((k) => String(k).trim()).filter(Boolean))],
    regexPatterns: [...new Set((guard?.regexPatterns || DEFAULT_SECRET_REGEXES).map((r) => String(r).trim()).filter(Boolean))],
    ignorePaths: [...new Set((guard?.ignorePaths || [".git", "node_modules", ".DS_Store"]).map(String).filter(Boolean))],
  };
  writeJsonAtomic(guardFile, normalized);
  return normalized;
}

export function loadRuntimeInfo() {
  const { runtimeFile } = getConfigPaths();
  return readJsonIfExists(runtimeFile, null);
}

export function saveRuntimeInfo(info) {
  const { runtimeFile } = getConfigPaths();
  writeJsonAtomic(runtimeFile, {
    nodePath: String(info.nodePath),
    cliPath: String(info.cliPath),
    updatedAt: new Date().toISOString(),
  });
}
