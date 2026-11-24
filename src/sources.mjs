import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  loadGuardConfig,
  saveConfig,
  TRUST_LEVELS,
} from "./config.mjs";
import {
  getRemotes,
  getRepoStatus,
  gitClone,
  gitInit,
  isGitRepo,
  setOriginRemote,
} from "./git.mjs";
import {
  installPrePushHook,
  scanDirectoryForLeaks,
  validateRemoteUrlForTrust,
} from "./guard.mjs";
import {
  canonicalPrefix,
  contractHome,
  ensureDir,
  expandHome,
  isInsideDir,
  normalizeForCompare,
  readJsonIfExists,
  safeLstat,
  safeStat,
  writeJsonAtomic,
} from "./paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CLI_PATH = path.resolve(__dirname, "..", "bin", "skill-hub.mjs");

/**
 * Parses SKILL.md YAML frontmatter `name` and `description`,
 * including YAML block scalars (`|`, `>`, `|-`, `>-`).
 */
export function parseSkillFrontmatter(markdownText) {
  const out = { name: null, description: null };
  if (!markdownText || typeof markdownText !== "string") return out;

  const lines = markdownText.split(/\r?\n/);
  if ((lines[0] || "").trim() !== "---") return out;

  let pending = null; // { key, value, style }
  const flushPending = () => {
    if (!pending) return;
    const cleaned = pending.value.trim();
    if (cleaned) {
      if (pending.key === "name") out.name = cleaned;
      if (pending.key === "description") out.description = cleaned;
    }
    pending = null;
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "---" || trimmed === "...") {
      flushPending();
      break;
    }

    if (pending && (line.startsWith(" ") || line.startsWith("\t") || trimmed === "")) {
      const part = trimmed;
      if (part === "") {
        if (pending.style === "|") pending.value += "\n";
      } else if (pending.value === "") {
        pending.value = part;
      } else if (pending.style === "|") {
        pending.value += `\n${part}`;
      } else {
        pending.value += ` ${part}`;
      }
      continue;
    }

    flushPending();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1).trim();
    if (key !== "name" && key !== "description") continue;

    if (rawVal === "|" || rawVal === "|-" || rawVal === ">" || rawVal === ">-") {
      pending = {
        key,
        value: "",
        style: rawVal.startsWith("|") ? "|" : ">",
      };
      continue;
    }

    const unquoted = stripQuotes(rawVal);
    if (unquoted) {
      if (key === "name") out.name = unquoted;
      if (key === "description") out.description = unquoted;
    }
  }

  flushPending();
  return out;
}

function stripQuotes(val) {
  if (!val) return "";
  if (
    (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
    (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
  ) {
    return val.slice(1, -1);
  }
  return val;
}

/**
 * Resolves where skills live inside a source repo:
 * 1. Explicit skillsDir on source config or source.json
 * 2. "<root>/skills" if it exists
 * 3. "." if direct subdirectories already contain SKILL.md
 * 4. Defaults to "skills"
 */
export function detectSkillsSubdir(sourceRoot, explicitSubdir) {
  if (explicitSubdir) return explicitSubdir;
  const meta = readJsonIfExists(path.join(sourceRoot, "source.json"), null);
  if (meta && typeof meta.skillsDir === "string" && meta.skillsDir.trim()) {
    return meta.skillsDir.trim();
  }
  const skillsDirStat = safeStat(path.join(sourceRoot, "skills"));
  if (skillsDirStat && skillsDirStat.isDirectory()) {
    return "skills";
  }
  try {
    const entries = fs.readdirSync(sourceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory()) continue;
      if (safeStat(path.join(sourceRoot, entry.name, "SKILL.md"))?.isFile()) {
        return ".";
      }
    }
  } catch {
    // Directory might not exist yet
  }
  return "skills";
}

export function hydrateSource(rawSource) {
  const absPath = expandHome(rawSource.path);
  const exists = Boolean(safeStat(absPath)?.isDirectory());
  const meta = exists ? readJsonIfExists(path.join(absPath, "source.json"), null) || {} : {};
  const skillsRelDir = exists
    ? detectSkillsSubdir(absPath, rawSource.skillsDir)
    : rawSource.skillsDir || "skills";
  const skillsRoot =
    skillsRelDir === "." ? absPath : path.resolve(absPath, skillsRelDir);

  return {
    id: rawSource.id,
    name: rawSource.name || meta.name || rawSource.id,
    path: contractHome(absPath),
    absPath,
    trust: rawSource.trust || meta.trust || "local",
    enabled: rawSource.enabled !== false,
    exists,
    skillsRelDir,
    skillsRoot,
    allowedRemoteHosts: Array.isArray(meta.allowedRemoteHosts)
      ? meta.allowedRemoteHosts
      : [],
    forbiddenRemoteHosts: Array.isArray(meta.forbiddenRemoteHosts)
      ? meta.forbiddenRemoteHosts
      : [],
  };
}

export function readSourceProfiles(source) {
  const filePath = path.join(source.absPath, "profiles.json");
  const raw = readJsonIfExists(filePath, null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const profiles = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) {
      profiles[k] = [...new Set(v.map(String).filter(Boolean))].sort();
    }
  }
  return profiles;
}

export function writeSourceProfiles(source, profiles) {
  const filePath = path.join(source.absPath, "profiles.json");
  const clean = {};
  for (const k of Object.keys(profiles).sort()) {
    clean[k] = [...new Set((profiles[k] || []).map(String).filter(Boolean))].sort();
  }
  writeJsonAtomic(filePath, clean);
  return clean;
}

export function scanSourceSkills(source) {
  if (!source.exists) return [];
  const skillsRootStat = safeStat(source.skillsRoot);
  if (!skillsRootStat || !skillsRootStat.isDirectory()) return [];

  const profiles = readSourceProfiles(source);
  const skillToProfiles = new Map();
  for (const [profileName, list] of Object.entries(profiles)) {
    for (const dirName of list) {
      if (!skillToProfiles.has(dirName)) skillToProfiles.set(dirName, []);
      skillToProfiles.get(dirName).push(`${source.id}:${profileName}`);
    }
  }

  let entries;
  try {
    entries = fs.readdirSync(source.skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const skillDir = path.join(source.skillsRoot, entry.name);
    const lst = safeLstat(skillDir);
    if (!lst || !lst.isDirectory()) continue;

    const mdPath = path.join(skillDir, "SKILL.md");
    const mdStat = safeStat(mdPath);
    if (!mdStat || !mdStat.isFile()) continue;

    let frontmatter = { name: null, description: null };
    try {
      const mdText = fs.readFileSync(mdPath, "utf8");
      frontmatter = parseSkillFrontmatter(mdText);
    } catch {
      // Unreadable SKILL.md falls back to directory name
    }

    skills.push({
      ref: `${source.id}:${entry.name}`,
      sourceId: source.id,
      sourceName: source.name,
      trust: source.trust,
      dirName: entry.name,
      name: frontmatter.name || entry.name,
      description: frontmatter.description || "",
      dir: skillDir,
      skillMdPath: mdPath,
      mtimeMs: mdStat.mtimeMs,
      profiles: skillToProfiles.get(entry.name) || [],
    });
  }

  skills.sort((a, b) => a.dirName.localeCompare(b.dirName));
  return skills;
}

export function listHydratedSources(config = loadConfig()) {
  return (config.sources || []).map(hydrateSource);
}

export function getSourceById(sourceId, config = loadConfig()) {
  const found = (config.sources || []).find((s) => s.id === sourceId);
  if (!found) {
    throw new Error(`找不到源 "${sourceId}"`);
  }
  return hydrateSource(found);
}

export function addSource({
  id,
  name,
  path: rawPath,
  trust = "local",
  cloneUrl = "",
  skillsDir,
  allowedRemoteHosts = [],
  forbiddenRemoteHosts = [],
  initIfMissing = true,
  cliPath = DEFAULT_CLI_PATH,
}) {
  if (!id || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    throw new Error(`源 ID 必须为小写字母/数字/连字符/下划线，收到: "${id}"`);
  }
  if (!TRUST_LEVELS.includes(trust)) {
    throw new Error(`非法信任级别 "${trust}"，必须是 ${TRUST_LEVELS.join(" | ")}`);
  }
  if (!rawPath) {
    throw new Error("必须指定源目录路径 path");
  }

  const config = loadConfig();
  if (config.sources.some((s) => s.id === id)) {
    throw new Error(`源 ID "${id}" 已存在`);
  }

  const absPath = expandHome(rawPath);
  const candCanon = canonicalPrefix(absPath);
  const hubCanon = canonicalPrefix(expandHome(config.hubDir));
  if (isInsideDir(candCanon, hubCanon) || isInsideDir(hubCanon, candCanon)) {
    throw new Error(
      `源目录 "${rawPath}" 不能与通用中枢目录 "${config.hubDir}" 相同或互相包含`,
    );
  }
  for (const existing of config.sources) {
    const existCanon = canonicalPrefix(expandHome(existing.path));
    if (normalizeForCompare(candCanon) === normalizeForCompare(existCanon)) {
      throw new Error(
        `目录 "${rawPath}" 已被源 "${existing.id}"（${existing.name}）占用，不能重复绑定同一目录`,
      );
    }
    if (isInsideDir(candCanon, existCanon) || isInsideDir(existCanon, candCanon)) {
      throw new Error(
        `目录 "${rawPath}" 与已有源 "${existing.id}"（${existing.path}）存在父子嵌套关系，为避免跨源污染与泄密风险已拒绝`,
      );
    }
  }

  const guardConfig = loadGuardConfig();

  // Validate cloneUrl before touching filesystem
  if (cloneUrl) {
    const violations = validateRemoteUrlForTrust({
      url: cloneUrl,
      trust,
      allowedRemoteHosts,
      forbiddenRemoteHosts,
      guardConfig,
    });
    if (violations.length > 0) {
      throw new Error(violations.map((v) => v.message).join("; "));
    }
    if (safeLstat(absPath)) {
      throw new Error(`目标目录已存在，无法执行 clone: ${absPath}`);
    }
    gitClone(cloneUrl, absPath);
  }

  const dirExists = Boolean(safeStat(absPath)?.isDirectory());
  if (!dirExists) {
    if (!initIfMissing) {
      throw new Error(`源目录不存在: ${absPath}`);
    }
    ensureDir(absPath);
    const resolvedSubdir = skillsDir || "skills";
    if (resolvedSubdir !== ".") {
      ensureDir(path.join(absPath, resolvedSubdir));
    }
    if (trust !== "local" && !isGitRepo(absPath)) {
      gitInit(absPath);
    }
  } else {
    // Check existing remotes against trust rules
    const existingRemotes = getRemotes(absPath);
    for (const remote of existingRemotes) {
      const violations = validateRemoteUrlForTrust({
        url: remote.url,
        trust,
        allowedRemoteHosts,
        forbiddenRemoteHosts,
        guardConfig,
      });
      if (violations.length > 0) {
        throw new Error(violations.map((v) => v.message).join("; "));
      }
    }
  }

  const sourceJsonPath = path.join(absPath, "source.json");
  const profilesJsonPath = path.join(absPath, "profiles.json");
  const gitignorePath = path.join(absPath, ".gitignore");
  const detectedSubdir = detectSkillsSubdir(absPath, skillsDir);

  if (!safeLstat(sourceJsonPath)) {
    const meta = {
      version: 1,
      id,
      name: name || id,
      trust,
      skillsDir: detectedSubdir,
    };
    if (trust === "internal") {
      if (allowedRemoteHosts.length > 0) meta.allowedRemoteHosts = allowedRemoteHosts;
      meta.forbiddenRemoteHosts =
        forbiddenRemoteHosts.length > 0
          ? forbiddenRemoteHosts
          : guardConfig.forbiddenPublicHosts;
    }
    writeJsonAtomic(sourceJsonPath, meta);
  }

  if (!safeLstat(profilesJsonPath)) {
    writeJsonAtomic(profilesJsonPath, {});
  }

  if (!safeLstat(gitignorePath) && trust !== "local") {
    fs.writeFileSync(gitignorePath, ".DS_Store\n*.tmp\n", "utf8");
  }

  let hookResult = { installed: false, reason: "not-git" };
  if (isGitRepo(absPath) && trust !== "local") {
    hookResult = installPrePushHook(absPath, { cliPath });
  }

  config.sources.push({
    id,
    name: name || id,
    path: contractHome(absPath),
    trust,
    enabled: true,
    ...(skillsDir ? { skillsDir } : {}),
  });
  saveConfig(config);

  const hydrated = getSourceById(id, config);
  return {
    source: hydrated,
    git: getRepoStatus(hydrated.absPath, hydrated.skillsRelDir),
    hook: hookResult,
  };
}

/**
 * Safely changes the trust level of an existing source (local <-> internal <-> github).
 */
export function setSourceTrust(
  sourceId,
  { trust, allowedRemoteHosts = [], cliPath = DEFAULT_CLI_PATH } = {},
) {
  if (!TRUST_LEVELS.includes(trust)) {
    throw new Error(`非法信任级别 "${trust}"，必须是 ${TRUST_LEVELS.join(" | ")}`);
  }

  const config = loadConfig();
  const entry = config.sources.find((s) => s.id === sourceId);
  if (!entry) {
    throw new Error(`找不到源 "${sourceId}"`);
  }

  const absPath = expandHome(entry.path);
  ensureDir(absPath);
  const remotes = getRemotes(absPath);
  const guardConfig = loadGuardConfig();
  const sourceJsonPath = path.join(absPath, "source.json");
  const existingMeta = readJsonIfExists(sourceJsonPath, {}) || {};

  const nextMeta = {
    ...existingMeta,
    version: 1,
    id: entry.id,
    name: entry.name || existingMeta.name || entry.id,
    trust,
    skillsDir: detectSkillsSubdir(absPath, entry.skillsDir),
  };

  let hookResult = { installed: false, reason: "not-git" };

  if (trust === "local") {
    if (remotes.length > 0) {
      throw new Error(
        `源 "${sourceId}" 已配置 Git 远端（${remotes.map((r) => r.url).join(", ")}），无法直接改为仅本地源，请先移除远端`,
      );
    }
    delete nextMeta.forbiddenRemoteHosts;
    delete nextMeta.allowedRemoteHosts;
  } else if (trust === "internal") {
    for (const remote of remotes) {
      const violations = validateRemoteUrlForTrust({
        url: remote.url,
        trust: "internal",
        allowedRemoteHosts,
        guardConfig,
      });
      if (violations.length > 0) {
        throw new Error(violations.map((v) => v.message).join("; "));
      }
    }
    if (!isGitRepo(absPath)) {
      gitInit(absPath);
    }
    const gitignorePath = path.join(absPath, ".gitignore");
    if (!safeLstat(gitignorePath)) {
      fs.writeFileSync(gitignorePath, ".DS_Store\n*.tmp\n", "utf8");
    }
    nextMeta.forbiddenRemoteHosts =
      existingMeta.forbiddenRemoteHosts || guardConfig.forbiddenPublicHosts;
    if (allowedRemoteHosts.length > 0) {
      nextMeta.allowedRemoteHosts = allowedRemoteHosts;
    }
    hookResult = installPrePushHook(absPath, { cliPath });
  } else if (trust === "github") {
    const findings = scanDirectoryForLeaks(absPath, guardConfig);
    if (findings.length > 0) {
      const err = new Error(
        `安全守卫拒绝将 "${sourceId}" 设为 GitHub 源，检测到敏感内容：\n${findings.map((f) => `- ${f.message}`).join("\n")}`,
      );
      err.code = "GUARD_BLOCKED";
      err.violations = findings;
      throw err;
    }
    if (!isGitRepo(absPath)) {
      gitInit(absPath);
    }
    const gitignorePath = path.join(absPath, ".gitignore");
    if (!safeLstat(gitignorePath)) {
      fs.writeFileSync(gitignorePath, ".DS_Store\n*.tmp\n", "utf8");
    }
    delete nextMeta.forbiddenRemoteHosts;
    delete nextMeta.allowedRemoteHosts;
    hookResult = installPrePushHook(absPath, { cliPath });
  }

  writeJsonAtomic(sourceJsonPath, nextMeta);
  entry.trust = trust;
  saveConfig(config);

  const hydrated = getSourceById(sourceId, config);
  return {
    ok: true,
    source: hydrated,
    git: getRepoStatus(hydrated.absPath, hydrated.skillsRelDir),
    hook: hookResult,
  };
}

export function removeSource(sourceId) {
  const config = loadConfig();
  const idx = config.sources.findIndex((s) => s.id === sourceId);
  if (idx === -1) {
    throw new Error(`找不到源 "${sourceId}"`);
  }
  const [removed] = config.sources.splice(idx, 1);
  const prefix = `${sourceId}:`;
  config.enabledProfiles = config.enabledProfiles.filter((p) => !p.startsWith(prefix));
  config.include = config.include.filter((s) => !s.startsWith(prefix));
  config.exclude = config.exclude.filter((s) => !s.startsWith(prefix));
  saveConfig(config);
  return { removed, note: "仅从配置移除，磁盘文件未删除" };
}

/**
 * Upgrades a local-only source into an internal company Git repository.
 */
export function convertLocalToInternal(
  sourceId,
  { remoteUrl = "", allowedRemoteHosts = [], cliPath = DEFAULT_CLI_PATH } = {},
) {
  const config = loadConfig();
  const entry = config.sources.find((s) => s.id === sourceId);
  if (!entry) {
    throw new Error(`找不到源 "${sourceId}"`);
  }
  if (entry.trust === "github") {
    throw new Error(`源 "${sourceId}" 是 GitHub 源，无法用此命令转为公司内网源`);
  }

  const absPath = expandHome(entry.path);
  ensureDir(absPath);
  const guardConfig = loadGuardConfig();

  if (remoteUrl) {
    const violations = validateRemoteUrlForTrust({
      url: remoteUrl,
      trust: "internal",
      allowedRemoteHosts,
      guardConfig,
    });
    if (violations.length > 0) {
      throw new Error(violations.map((v) => v.message).join("; "));
    }
  }

  if (!isGitRepo(absPath)) {
    gitInit(absPath);
  }
  if (remoteUrl) {
    setOriginRemote(absPath, remoteUrl);
  }

  const gitignorePath = path.join(absPath, ".gitignore");
  if (!safeLstat(gitignorePath)) {
    fs.writeFileSync(gitignorePath, ".DS_Store\n*.tmp\n", "utf8");
  }

  const sourceJsonPath = path.join(absPath, "source.json");
  const existingMeta = readJsonIfExists(sourceJsonPath, {}) || {};
  const nextMeta = {
    ...existingMeta,
    version: 1,
    id: entry.id,
    name: entry.name || existingMeta.name || entry.id,
    trust: "internal",
    skillsDir: detectSkillsSubdir(absPath, entry.skillsDir),
    forbiddenRemoteHosts:
      existingMeta.forbiddenRemoteHosts || guardConfig.forbiddenPublicHosts,
  };
  if (allowedRemoteHosts.length > 0) {
    nextMeta.allowedRemoteHosts = allowedRemoteHosts;
  }
  writeJsonAtomic(sourceJsonPath, nextMeta);

  entry.trust = "internal";
  saveConfig(config);

  const hookResult = installPrePushHook(absPath, { cliPath });
  const hydrated = getSourceById(sourceId, config);

  return {
    source: hydrated,
    git: getRepoStatus(hydrated.absPath, hydrated.skillsRelDir),
    hook: hookResult,
  };
}

export function setSourceProfile(sourceId, profileName, skillDirNames) {
  if (!profileName || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profileName)) {
    throw new Error(`分组名 "${profileName}" 格式不合法（仅允许字母/数字/.-_）`);
  }
  const source = getSourceById(sourceId);
  const profiles = readSourceProfiles(source);
  profiles[profileName] = [...new Set((skillDirNames || []).map(String).filter(Boolean))].sort();
  return writeSourceProfiles(source, profiles);
}

/**
 * Adds or removes a single skill from an existing profile in its source's profiles.json.
 */
export function updateSourceProfileMember(sourceId, profileName, skillDirName, included) {
  const cleanSkill = String(skillDirName || "").trim();
  if (!cleanSkill) {
    throw new Error("请指定技能目录名");
  }
  const source = getSourceById(sourceId);
  const profiles = readSourceProfiles(source);
  if (!(profileName in profiles)) {
    throw new Error(`源 "${sourceId}" 中不存在分组 "${profileName}"`);
  }
  const set = new Set((profiles[profileName] || []).map(String).filter(Boolean));
  if (included) {
    set.add(cleanSkill);
  } else {
    set.delete(cleanSkill);
  }
  profiles[profileName] = [...set].sort();
  return writeSourceProfiles(source, profiles);
}

export function deleteSourceProfile(sourceId, profileName) {
  const source = getSourceById(sourceId);
  const profiles = readSourceProfiles(source);
  delete profiles[profileName];
  const saved = writeSourceProfiles(source, profiles);

  const config = loadConfig();
  const ref = `${sourceId}:${profileName}`;
  config.enabledProfiles = config.enabledProfiles.filter((p) => p !== ref);
  saveConfig(config);
  return saved;
}
