import path from "node:path";
import {
  KNOWN_AGENTS,
  TARGET_MODES,
  loadConfig,
  loadGuardConfig,
  loadRuntimeInfo,
  loadState,
  saveConfig,
  saveGuardConfig,
} from "./config.mjs";
import {
  applyConsolidate,
  getTrashRoot,
  planConsolidate,
  resolveConflict,
} from "./consolidate.mjs";
import {
  adoptSkill,
  cleanupBrokenLinks,
  moveSkill,
  runDoctor,
} from "./doctor.mjs";
import { getRemotes, getRepoStatus, gitCommitAndPush, gitPull, isGitRepo } from "./git.mjs";
import { guardSource, hasPrePushHook, installPrePushHook } from "./guard.mjs";
import {
  contractHome,
  expandHome,
  normalizeForCompare,
  safeLstat,
  safeRealpath,
} from "./paths.mjs";
import {
  DEFAULT_CLI_PATH,
  addSource,
  convertLocalToInternal,
  deleteSourceProfile,
  getSourceById,
  hydrateSource,
  readSourceProfiles,
  removeSource,
  setSourceProfile,
  setSourceTrust,
} from "./sources.mjs";
import { applySync, buildSkillCatalog, planSync } from "./sync.mjs";

function computeSkillCoverage(skill, desired, config) {
  const hubDir = desired.hubAbsDir;
  const hubLink = path.join(hubDir, skill.dirName);
  const hubReal = safeRealpath(hubLink);
  const hubActive = Boolean(
    hubReal && normalizeForCompare(hubReal) === normalizeForCompare(skill.dir),
  );
  const hubDesired = desired.hubDesired.has(skill.dirName);

  const coverage = [];
  for (const [targetId, target] of Object.entries(config.targets || {})) {
    if (target.mode === "disabled") continue;
    const known = KNOWN_AGENTS.find((a) => a.id === targetId);
    if (target.mode === "hub-only") {
      coverage.push({
        targetId,
        label: target.label || targetId,
        mode: "hub-only",
        status: hubActive ? "via-hub" : hubDesired ? "pending" : "off",
      });
      continue;
    }

    const targetDir = expandHome(target.path);
    const tLink = path.join(targetDir, skill.dirName);
    const lst = safeLstat(tLink);
    const targetWant = desired.targetDesired[targetId]?.has(skill.dirName) || false;

    let status = "off";
    if (lst && !lst.isSymbolicLink()) {
      status = "conflict";
    } else if (lst && lst.isSymbolicLink()) {
      const real = safeRealpath(tLink);
      if (real && normalizeForCompare(real) === normalizeForCompare(skill.dir)) {
        status = targetWant ? "linked" : "pending-remove";
      } else {
        status = "conflict";
      }
    } else if (targetWant) {
      status = "pending";
    }

    coverage.push({
      targetId,
      label: target.label || known?.label || targetId,
      mode: "link",
      status,
    });
  }
  return coverage;
}

export function getFullStatus() {
  const config = loadConfig();
  const state = loadState();
  const guardConfig = loadGuardConfig();
  const runtimeInfo = loadRuntimeInfo();
  const catalog = buildSkillCatalog(config);
  const plan = planSync(config, state, catalog);
  const doctor = runDoctor(config);
  const consolidate = planConsolidate(config);

  const sources = catalog.sources.map((source) => {
    const profiles = readSourceProfiles(source);
    const git = source.exists
      ? getRepoStatus(source.absPath, source.skillsRelDir)
      : {
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
    const skillsCount = catalog.allSkills.filter((s) => s.sourceId === source.id).length;
    return {
      ...source,
      profiles,
      git,
      skillsCount,
    };
  });

  const enabledProfilesSet = new Set(config.enabledProfiles || []);
  const allProfiles = [];
  for (const s of sources) {
    for (const [name, members] of Object.entries(s.profiles)) {
      const ref = `${s.id}:${name}`;
      allProfiles.push({
        ref,
        sourceId: s.id,
        sourceName: s.name,
        trust: s.trust,
        name,
        skills: members,
        enabled: enabledProfilesSet.has(ref),
      });
    }
  }

  const skills = catalog.activeSkills.map((skill) => {
    const inHubDesired = plan.desired.hubDesired.has(skill.dirName);
    const fromEnabledProfile = skill.profiles.some((p) => enabledProfilesSet.has(p));
    const explicitlyIncluded = config.include.some(
      (x) => x === skill.ref || x === skill.dirName,
    );
    const explicitlyExcluded = config.exclude.some(
      (x) => x === skill.ref || x === skill.dirName,
    );

    const perTarget = {};
    for (const [targetId, target] of Object.entries(config.targets || {})) {
      if (target.mode !== "link") continue;
      const tInc = (target.include || []).some(
        (x) => x === skill.ref || x === skill.dirName,
      );
      const tExc = (target.exclude || []).some(
        (x) => x === skill.ref || x === skill.dirName,
      );
      perTarget[targetId] = {
        effective: Boolean(plan.desired.targetDesired[targetId]?.has(skill.dirName)),
        override: tInc ? "include" : tExc ? "exclude" : "inherit",
      };
    }

    return {
      ...skill,
      enabled: inHubDesired,
      fromEnabledProfile,
      explicitlyIncluded,
      explicitlyExcluded,
      perTarget,
      coverage: computeSkillCoverage(skill, plan.desired, config),
    };
  });

  const targets = Object.entries(config.targets || {}).map(([id, target]) => ({
    id,
    label: target.label || id,
    path: target.path,
    absPath: expandHome(target.path),
    mode: target.mode,
    include: target.include || [],
    exclude: target.exclude || [],
  }));

  return {
    config,
    guard: guardConfig,
    runtime: runtimeInfo,
    sources,
    profiles: allProfiles,
    skills,
    targets,
    pendingSync: {
      summary: plan.summary,
      actions: plan.actions,
      nameCollisions: plan.nameCollisions,
    },
    doctor,
    consolidate,
  };
}

export function toggleProfile({ ref, enabled }) {
  const config = loadConfig();
  const [sourceId, profileName] = String(ref || "").split(":");
  if (!sourceId || !profileName) {
    throw new Error(`无效的分组引用 "${ref}"，应为 <sourceId>:<profileName>`);
  }
  const source = getSourceById(sourceId, config);
  const profiles = readSourceProfiles(source);
  if (!(profileName in profiles)) {
    throw new Error(`源 "${sourceId}" 中不存在分组 "${profileName}"`);
  }

  const set = new Set(config.enabledProfiles || []);
  if (enabled) set.add(ref);
  else set.delete(ref);
  config.enabledProfiles = [...set];
  saveConfig(config);
  return { ok: true, enabledProfiles: config.enabledProfiles };
}

export function toggleSkill({ skillRef, enabled, targetId = null }) {
  const config = loadConfig();
  const catalog = buildSkillCatalog(config);
  const skill = catalog.activeSkills.find(
    (s) => s.ref === skillRef || s.dirName === skillRef,
  );
  if (!skill) {
    throw new Error(`找不到技能 "${skillRef}"`);
  }

  if (targetId) {
    const target = config.targets?.[targetId];
    if (!target) {
      throw new Error(`找不到目标工具 "${targetId}"`);
    }
    if (target.mode !== "link") {
      throw new Error(`目标工具 "${targetId}" 当前模式为 ${target.mode}，仅 link 模式支持单独开关`);
    }
    target.include = (target.include || []).filter(
      (x) => x !== skill.ref && x !== skill.dirName,
    );
    target.exclude = (target.exclude || []).filter(
      (x) => x !== skill.ref && x !== skill.dirName,
    );

    const desiredNow = resolveHubIncludesSkill(config, catalog, skill);
    if (enabled === null) {
      // Reset to inherit from hub
    } else if (enabled && !desiredNow) {
      target.include.push(skill.ref);
    } else if (!enabled && desiredNow) {
      target.exclude.push(skill.ref);
    }
    saveConfig(config);
    return { ok: true, targetId, skillRef: skill.ref };
  }

  const enabledProfiles = new Set(config.enabledProfiles || []);
  const inEnabledProfile = skill.profiles.some((p) => enabledProfiles.has(p));

  config.include = (config.include || []).filter(
    (x) => x !== skill.ref && x !== skill.dirName,
  );
  config.exclude = (config.exclude || []).filter(
    (x) => x !== skill.ref && x !== skill.dirName,
  );

  if (enabled) {
    if (!inEnabledProfile) {
      config.include.push(skill.ref);
    }
  } else {
    if (inEnabledProfile) {
      config.exclude.push(skill.ref);
    }
  }

  saveConfig(config);
  return { ok: true, skillRef: skill.ref, enabled };
}

function resolveHubIncludesSkill(config, catalog, skill) {
  const enabledProfiles = new Set(config.enabledProfiles || []);
  const source = catalog.sources.find((s) => s.id === skill.sourceId);
  const profiles = source ? readSourceProfiles(source) : {};
  const fromProfile = Object.entries(profiles).some(
    ([pName, members]) =>
      enabledProfiles.has(`${skill.sourceId}:${pName}`) && members.includes(skill.dirName),
  );
  const inc = (config.include || []).some((x) => x === skill.ref || x === skill.dirName);
  const exc = (config.exclude || []).some((x) => x === skill.ref || x === skill.dirName);
  return (fromProfile || inc) && !exc;
}

export function pullSources({ sourceId = null, autoSync = true } = {}) {
  const config = loadConfig();
  const sources = sourceId
    ? [getSourceById(sourceId, config)]
    : (config.sources || []).map(hydrateSource).filter((s) => s.enabled);

  const results = [];
  for (const s of sources) {
    try {
      const res = gitPull(s);
      results.push({ sourceId: s.id, ...res });
    } catch (err) {
      results.push({ sourceId: s.id, ok: false, error: err.message });
    }
  }

  const failed = results.filter((r) => r.ok === false);
  let sync = null;
  if (autoSync) {
    sync = applySync({ dryRun: false });
  }

  return {
    ok: failed.length === 0,
    results,
    sync,
  };
}

export function pushSource({ sourceId, message = "", skipPush = false }) {
  const source = getSourceById(sourceId);
  return gitCommitAndPush(source, { message, skipPush });
}

export function runGuardCheck({ sourceId = null, repoPath = null } = {}) {
  const config = loadConfig();
  const guardConfig = loadGuardConfig();

  let targetSources = [];
  if (sourceId) {
    targetSources = [getSourceById(sourceId, config)];
  } else if (repoPath) {
    const absRepo = expandHome(repoPath);
    const matched = (config.sources || [])
      .map(hydrateSource)
      .find((s) => normalizeForCompare(s.absPath) === normalizeForCompare(absRepo));
    if (matched) {
      targetSources = [matched];
    } else {
      // Fallback check when invoked directly via pre-push hook from a repo
      targetSources = [
        hydrateSource({
          id: path.basename(absRepo),
          name: path.basename(absRepo),
          path: absRepo,
          trust: "local",
        }),
      ];
    }
  } else {
    targetSources = (config.sources || []).map(hydrateSource);
  }

  const results = targetSources.map((source) => {
    const remotes = isGitRepo(source.absPath) ? getRemotes(source.absPath) : [];
    return guardSource(source, remotes, guardConfig);
  });

  const ok = results.every((r) => r.ok);
  return { ok, results };
}

export function installSourceHook(sourceId, force = false) {
  const source = getSourceById(sourceId);
  const runtime = loadRuntimeInfo();
  const res = installPrePushHook(source.absPath, {
    cliPath: runtime?.cliPath || DEFAULT_CLI_PATH,
    nodePath: runtime?.nodePath || process.execPath,
    force,
  });
  return { sourceId, ...res };
}

export function updateTarget({ id, mode, path: targetPath, label }) {
  const config = loadConfig();
  if (!config.targets[id] && !targetPath) {
    throw new Error(`新建自定义目标 "${id}" 时必须提供 path`);
  }
  const existing = config.targets[id] || {
    label: label || id,
    path: contractHome(expandHome(targetPath)),
    mode: "link",
    include: [],
    exclude: [],
  };
  if (mode !== undefined) {
    if (!TARGET_MODES.includes(mode)) {
      throw new Error(`非法目标模式 "${mode}"，必须是 ${TARGET_MODES.join(" | ")}`);
    }
    existing.mode = mode;
  }
  if (targetPath !== undefined) {
    existing.path = contractHome(expandHome(targetPath));
  }
  if (label !== undefined) {
    existing.label = String(label);
  }
  config.targets[id] = existing;
  saveConfig(config);
  return { ok: true, id, target: existing };
}

export function updateSettings({ deviceName, hubDir, guard }) {
  const config = loadConfig();
  if (deviceName !== undefined && String(deviceName).trim()) {
    config.deviceName = String(deviceName).trim();
  }
  if (hubDir !== undefined && String(hubDir).trim()) {
    config.hubDir = contractHome(expandHome(String(hubDir).trim()));
  }
  saveConfig(config);

  let savedGuard = loadGuardConfig();
  if (guard && typeof guard === "object") {
    savedGuard = saveGuardConfig({
      ...savedGuard,
      ...guard,
    });
  }

  return {
    ok: true,
    config,
    guard: savedGuard,
  };
}

export {
  addSource,
  adoptSkill,
  applyConsolidate,
  applySync,
  cleanupBrokenLinks,
  convertLocalToInternal,
  deleteSourceProfile,
  getTrashRoot,
  hasPrePushHook,
  moveSkill,
  planConsolidate,
  removeSource,
  resolveConflict,
  runDoctor,
  setSourceProfile,
  setSourceTrust,
};
