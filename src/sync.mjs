import fs from "node:fs";
import path from "node:path";
import { loadConfig, loadState, resolveSyncMode, saveState } from "./config.mjs";
import {
  canonicalOrResolved,
  computeDirDigest,
  contractHome,
  createDirLink,
  ensureDir,
  expandHome,
  getUserHome,
  isInsideDir,
  normalizeForCompare,
  readJsonIfExists,
  readManagedCopyMarker,
  removeLink,
  removeManagedCopy,
  resolveLinkTarget,
  safeLstat,
  safeRealpath,
  safeStat,
  writeJsonAtomic,
  writeManagedCopy,
} from "./paths.mjs";
import { listHydratedSources, readSourceProfiles, scanSourceSkills } from "./sources.mjs";

function matchesRef(skill, token) {
  return token === skill.ref || token === skill.dirName;
}

/**
 * Collects all skills across enabled sources and resolves duplicate dirName collisions.
 * Earlier sources in config.sources take precedence when two sources define the same dirName.
 */
export function buildSkillCatalog(config = loadConfig()) {
  const sources = listHydratedSources(config);
  const byDirName = new Map();
  const allSkills = [];
  const nameCollisions = [];

  for (const source of sources) {
    if (!source.enabled) continue;
    const skills = scanSourceSkills(source);
    for (const skill of skills) {
      allSkills.push(skill);
      if (byDirName.has(skill.dirName)) {
        const winner = byDirName.get(skill.dirName);
        nameCollisions.push({
          dirName: skill.dirName,
          winnerRef: winner.ref,
          shadowedRef: skill.ref,
        });
      } else {
        byDirName.set(skill.dirName, skill);
      }
    }
  }

  // Filter out shadowed skills when computing mountable catalog, keep full list too
  const activeSkills = [...byDirName.values()];
  return { sources, allSkills, activeSkills, byDirName, nameCollisions };
}

/**
 * Computes desired enabled skills for the central hub and each enabled target.
 */
export function resolveDesiredState(config = loadConfig(), catalog = buildSkillCatalog(config)) {
  const { sources, activeSkills, byDirName } = catalog;
  const enabledProfileSet = new Set(config.enabledProfiles || []);

  // Build map: sourceId:profileName -> Set<dirName>
  const profileSkillRefs = new Set();
  for (const source of sources) {
    if (!source.enabled) continue;
    const profiles = readSourceProfiles(source);
    for (const [profileName, dirNames] of Object.entries(profiles)) {
      const ref = `${source.id}:${profileName}`;
      if (!enabledProfileSet.has(ref)) continue;
      for (const dirName of dirNames) {
        profileSkillRefs.add(`${source.id}:${dirName}`);
      }
    }
  }

  const hubDesired = new Map(); // dirName -> skill
  for (const skill of activeSkills) {
    const fromProfile = profileSkillRefs.has(skill.ref);
    const included = (config.include || []).some((tok) => matchesRef(skill, tok));
    const excluded = (config.exclude || []).some((tok) => matchesRef(skill, tok));

    if ((fromProfile || included) && !excluded) {
      hubDesired.set(skill.dirName, skill);
    }
  }

  const targetDesired = {}; // targetId -> Map<dirName, { skill, linkTarget }>
  const hubAbsDir = expandHome(config.hubDir);

  for (const [targetId, target] of Object.entries(config.targets || {})) {
    if (target.mode !== "link") continue;
    const map = new Map();
    const tInclude = target.include || [];
    const tExclude = target.exclude || [];

    for (const skill of activeSkills) {
      const inHub = hubDesired.has(skill.dirName);
      const forcedInclude = tInclude.some((tok) => matchesRef(skill, tok));
      const forcedExclude = tExclude.some((tok) => matchesRef(skill, tok));

      if ((inHub || forcedInclude) && !forcedExclude) {
        // Point to hub/<dirName> when enabled in hub, else directly to source skill dir
        const linkTarget = inHub ? path.join(hubAbsDir, skill.dirName) : skill.dir;
        map.set(skill.dirName, { skill, linkTarget });
      }
    }
    targetDesired[targetId] = map;
  }

  return {
    hubAbsDir,
    hubDesired,
    targetDesired,
    byDirName,
  };
}

function isOwnedLink(linkPath, stateManagedSet, ownedRoots) {
  if (stateManagedSet.has(normalizeForCompare(linkPath))) {
    return true;
  }
  const target = resolveLinkTarget(linkPath);
  if (!target) return false;
  return ownedRoots.some((root) => isInsideDir(target, root));
}

function isOwnedManagedCopy(copyPath, stateManagedCopySet, ownedRoots) {
  const marker = readManagedCopyMarker(copyPath);
  if (!marker) return false;
  if (stateManagedCopySet.has(normalizeForCompare(copyPath))) {
    return true;
  }
  if (marker.origin === "consolidate") {
    return false;
  }
  return Boolean(
    marker.sourceDir && ownedRoots.some((root) => isInsideDir(marker.sourceDir, root)),
  );
}

function planDirectorySync({
  dirPath,
  desiredEntries, // Map<dirName, { targetPath, sourceDir, sourceId, skillRef, digest }>
  stateManagedSet,
  stateManagedCopySet,
  ownedRoots,
  scopeLabel,
  materializeMode,
}) {
  const actions = [];
  const nextManagedLinks = [];
  const nextManagedCopies = [];
  const dirStat = safeLstat(dirPath);
  const existingNames = new Set();

  if (dirStat && dirStat.isDirectory()) {
    for (const name of fs.readdirSync(dirPath)) {
      if (name.startsWith(".")) continue;
      existingNames.add(name);
    }
  }

  // 1. Ensure desired links or managed copies
  for (const [name, entry] of desiredEntries.entries()) {
    const linkPath = path.join(dirPath, name);
    const lst = safeLstat(linkPath);
    const expectedCanon = canonicalOrResolved(entry.targetPath);

    if (!lst) {
      actions.push({
        type: "create",
        materialize: materializeMode,
        scope: scopeLabel,
        name,
        linkPath,
        targetPath: entry.targetPath,
        sourceDir: entry.sourceDir,
        sourceId: entry.sourceId,
        skillRef: entry.skillRef,
        digest: entry.digest,
      });
      if (materializeMode === "copy") {
        nextManagedCopies.push(linkPath);
      } else {
        nextManagedLinks.push(linkPath);
      }
      continue;
    }

    if (lst.isSymbolicLink()) {
      if (materializeMode === "link") {
        const currentReal = safeRealpath(linkPath);
        const currentCanon = currentReal ? normalizeForCompare(currentReal) : "";
        if (currentCanon === normalizeForCompare(expectedCanon)) {
          actions.push({
            type: "noop",
            materialize: "link",
            scope: scopeLabel,
            name,
            linkPath,
            targetPath: entry.targetPath,
          });
          nextManagedLinks.push(linkPath);
        } else if (isOwnedLink(linkPath, stateManagedSet, ownedRoots)) {
          actions.push({
            type: "replace",
            materialize: "link",
            scope: scopeLabel,
            name,
            linkPath,
            targetPath: entry.targetPath,
            sourceDir: entry.sourceDir,
            sourceId: entry.sourceId,
            skillRef: entry.skillRef,
            digest: entry.digest,
          });
          nextManagedLinks.push(linkPath);
        } else {
          actions.push({
            type: "skipConflict",
            scope: scopeLabel,
            name,
            linkPath,
            targetPath: entry.targetPath,
            reason: "存在指向外部目录的自定义软链，已保留未覆盖",
          });
        }
      } else if (isOwnedLink(linkPath, stateManagedSet, ownedRoots)) {
        actions.push({
          type: "replace",
          materialize: "copy",
          scope: scopeLabel,
          name,
          linkPath,
          targetPath: entry.targetPath,
          sourceDir: entry.sourceDir,
          sourceId: entry.sourceId,
          skillRef: entry.skillRef,
          digest: entry.digest,
        });
        nextManagedCopies.push(linkPath);
      } else {
        actions.push({
          type: "skipConflict",
          scope: scopeLabel,
          name,
          linkPath,
          targetPath: entry.targetPath,
          reason: "存在指向外部目录的自定义软链，已保留未覆盖",
        });
      }
      continue;
    }

    if (lst.isDirectory()) {
      const marker = readManagedCopyMarker(linkPath);
      if (!marker) {
        actions.push({
          type: "skipConflict",
          scope: scopeLabel,
          name,
          linkPath,
          targetPath: entry.targetPath,
          reason: "目标路径存在未纳管的实体目录或文件，已跳过以避免覆盖",
        });
        continue;
      }

      if (materializeMode === "copy") {
        const sourceMatches =
          normalizeForCompare(marker.sourceDir || "") ===
          normalizeForCompare(canonicalOrResolved(entry.sourceDir));
        const digestMatches = marker.digest === entry.digest;
        const hasSkillMd = Boolean(safeStat(path.join(linkPath, "SKILL.md"))?.isFile());

        if (sourceMatches && digestMatches && hasSkillMd) {
          actions.push({
            type: "noop",
            materialize: "copy",
            scope: scopeLabel,
            name,
            linkPath,
            targetPath: entry.targetPath,
          });
        } else {
          actions.push({
            type: "replace",
            materialize: "copy",
            scope: scopeLabel,
            name,
            linkPath,
            targetPath: entry.targetPath,
            sourceDir: entry.sourceDir,
            sourceId: entry.sourceId,
            skillRef: entry.skillRef,
            digest: entry.digest,
          });
        }
        nextManagedCopies.push(linkPath);
      } else {
        actions.push({
          type: "replace",
          materialize: "link",
          scope: scopeLabel,
          name,
          linkPath,
          targetPath: entry.targetPath,
          sourceDir: entry.sourceDir,
          sourceId: entry.sourceId,
          skillRef: entry.skillRef,
          digest: entry.digest,
        });
        nextManagedLinks.push(linkPath);
      }
      continue;
    }

    actions.push({
      type: "skipConflict",
      scope: scopeLabel,
      name,
      linkPath,
      targetPath: entry.targetPath,
      reason: "目标路径存在未纳管的实体目录或文件，已跳过以避免覆盖",
    });
  }

  // 2. Remove stale managed links or managed copies that are no longer desired
  for (const name of existingNames) {
    if (desiredEntries.has(name)) continue;
    const entryPath = path.join(dirPath, name);
    const lst = safeLstat(entryPath);
    if (!lst) continue;

    if (lst.isSymbolicLink() && isOwnedLink(entryPath, stateManagedSet, ownedRoots)) {
      actions.push({
        type: "remove",
        materialize: "link",
        scope: scopeLabel,
        name,
        linkPath: entryPath,
      });
    } else if (lst.isDirectory() && isOwnedManagedCopy(entryPath, stateManagedCopySet, ownedRoots)) {
      actions.push({
        type: "remove",
        materialize: "copy",
        scope: scopeLabel,
        name,
        linkPath: entryPath,
      });
    }
  }

  return { actions, nextManagedLinks, nextManagedCopies };
}

export function usesAntigravityManifestOnly(
  targetId,
  effectiveSyncMode,
  platform = process.platform,
) {
  return targetId === "antigravity" && platform === "win32" && effectiveSyncMode === "copy";
}

export function getAntigravityManifestPath(config) {
  const antigravityTarget = config.targets?.antigravity;
  const targetSkillsDir = antigravityTarget?.path
    ? expandHome(antigravityTarget.path)
    : path.join(getUserHome(), ".gemini", "config", "skills");
  return path.join(path.dirname(targetSkillsDir), "skills.json");
}

function planAntigravityManifest(
  config,
  state,
  desired,
  effectiveSyncMode,
  { platform = process.platform } = {},
) {
  const antigravityTarget = config.targets?.antigravity;
  const manifestPath = getAntigravityManifestPath(config);
  const active =
    platform === "win32" &&
    Boolean(antigravityTarget && antigravityTarget.mode !== "disabled");

  const existingManifest = readJsonIfExists(manifestPath, null);
  const previouslyManagedSet = new Set(
    (state.managedManifestEntries || []).map((p) => normalizeForCompare(expandHome(p))),
  );

  if (!active && previouslyManagedSet.size === 0 && !existingManifest) {
    return {
      manifestPath,
      changed: false,
      nextManagedManifestEntries: [],
      nextContent: null,
      removeFile: false,
    };
  }

  const desiredByNormDir = new Map();
  if (active) {
    const activeSkills =
      antigravityTarget.mode === "link"
        ? [...(desired.targetDesired.antigravity?.values() || [])].map((x) => x.skill)
        : [...desired.hubDesired.values()];

    for (const skill of activeSkills) {
      const parentDir = path.dirname(canonicalOrResolved(skill.dir));
      const norm = normalizeForCompare(parentDir);
      if (!desiredByNormDir.has(norm)) {
        desiredByNormDir.set(norm, {
          displayPath: contractHome(parentDir).replace(/\\/g, "/"),
          dirNames: new Set(),
        });
      }
      desiredByNormDir.get(norm).dirNames.add(skill.dirName);
    }
  }

  const existingEntries = Array.isArray(existingManifest?.entries)
    ? existingManifest.entries
    : [];
  const preservedEntries = [];
  for (const entry of existingEntries) {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string") continue;
    const norm = normalizeForCompare(expandHome(entry.path));
    if (previouslyManagedSet.has(norm)) continue;
    if (active && desiredByNormDir.has(norm)) continue;
    preservedEntries.push(entry);
  }

  const managedEntries = [...desiredByNormDir.values()]
    .sort((a, b) => a.displayPath.localeCompare(b.displayPath))
    .map((group) => ({
      path: group.displayPath,
      include_only: [...group.dirNames].sort(),
    }));

  const nextManagedManifestEntries = managedEntries.map((e) => e.path);
  const mergedEntries = [...preservedEntries, ...managedEntries];

  const baseObj =
    existingManifest && typeof existingManifest === "object" && !Array.isArray(existingManifest)
      ? { ...existingManifest }
      : {};
  if (mergedEntries.length > 0) {
    baseObj.entries = mergedEntries;
  } else {
    delete baseObj.entries;
  }

  if (Object.keys(baseObj).length === 0) {
    return {
      manifestPath,
      changed: existingManifest !== null,
      nextManagedManifestEntries: [],
      nextContent: null,
      removeFile: existingManifest !== null,
    };
  }

  const changed = JSON.stringify(existingManifest) !== JSON.stringify(baseObj);
  return {
    manifestPath,
    changed,
    nextManagedManifestEntries,
    nextContent: baseObj,
    removeFile: false,
  };
}

/**
 * Builds a complete, non-destructive sync plan across hubDir and all link-mode targets.
 */
export function planSync(
  config = loadConfig(),
  state = loadState(),
  catalog = buildSkillCatalog(config),
  { platform = process.platform } = {},
) {
  const effectiveSyncMode = resolveSyncMode(config, { platform });
  const desired = resolveDesiredState(config, catalog);
  const stateManagedSet = new Set((state.managedLinks || []).map(normalizeForCompare));
  const stateManagedCopySet = new Set((state.managedCopies || []).map(normalizeForCompare));
  const ownedRoots = [
    ...catalog.sources.map((s) => canonicalOrResolved(s.skillsRoot)),
    ...catalog.sources.map((s) => canonicalOrResolved(s.absPath)),
  ];

  const digestCache = new Map();
  const getSkillDigest = (skillDir) => {
    if (effectiveSyncMode !== "copy") return null;
    const key = normalizeForCompare(skillDir);
    if (!digestCache.has(key)) {
      digestCache.set(key, computeDirDigest(skillDir));
    }
    return digestCache.get(key);
  };

  const allActions = [];
  const nextManagedLinks = [];
  const nextManagedCopies = [];

  // Plan hubDir entries
  const hubDesiredMap = new Map();
  for (const [name, skill] of desired.hubDesired.entries()) {
    hubDesiredMap.set(name, {
      targetPath: skill.dir,
      sourceDir: skill.dir,
      sourceId: skill.sourceId,
      skillRef: skill.ref,
      digest: getSkillDigest(skill.dir),
    });
  }
  const hubPlan = planDirectorySync({
    dirPath: desired.hubAbsDir,
    desiredEntries: hubDesiredMap,
    stateManagedSet,
    stateManagedCopySet,
    ownedRoots,
    scopeLabel: "hub",
    materializeMode: effectiveSyncMode,
  });
  allActions.push(...hubPlan.actions);
  nextManagedLinks.push(...hubPlan.nextManagedLinks);
  nextManagedCopies.push(...hubPlan.nextManagedCopies);

  // Plan each link-mode target (on Windows copy mode, Antigravity reads source dirs directly via skills.json)
  for (const [targetId, map] of Object.entries(desired.targetDesired)) {
    if (usesAntigravityManifestOnly(targetId, effectiveSyncMode, platform)) {
      continue;
    }
    const targetCfg = config.targets[targetId];
    const targetDir = expandHome(targetCfg.path);
    const entries = new Map();
    for (const [name, info] of map.entries()) {
      entries.set(name, {
        targetPath: info.linkTarget,
        sourceDir: info.skill.dir,
        sourceId: info.skill.sourceId,
        skillRef: info.skill.ref,
        digest: getSkillDigest(info.skill.dir),
      });
    }
    const tPlan = planDirectorySync({
      dirPath: targetDir,
      desiredEntries: entries,
      stateManagedSet,
      stateManagedCopySet,
      ownedRoots,
      scopeLabel: targetId,
      materializeMode: effectiveSyncMode,
    });
    allActions.push(...tPlan.actions);
    nextManagedLinks.push(...tPlan.nextManagedLinks);
    nextManagedCopies.push(...tPlan.nextManagedCopies);
  }

  // Any previously tracked link or managed copy in a target that switched to disabled/hub-only should also be cleaned up
  const plannedPaths = new Set(allActions.map((a) => normalizeForCompare(a.linkPath)));
  for (const oldLink of state.managedLinks || []) {
    if (plannedPaths.has(normalizeForCompare(oldLink))) continue;
    const lst = safeLstat(oldLink);
    if (lst && lst.isSymbolicLink() && isOwnedLink(oldLink, stateManagedSet, ownedRoots)) {
      allActions.push({
        type: "remove",
        materialize: "link",
        scope: "cleanup",
        name: path.basename(oldLink),
        linkPath: oldLink,
      });
      plannedPaths.add(normalizeForCompare(oldLink));
    }
  }
  for (const oldCopy of state.managedCopies || []) {
    if (plannedPaths.has(normalizeForCompare(oldCopy))) continue;
    const lst = safeLstat(oldCopy);
    if (lst && lst.isDirectory() && isOwnedManagedCopy(oldCopy, stateManagedCopySet, ownedRoots)) {
      allActions.push({
        type: "remove",
        materialize: "copy",
        scope: "cleanup",
        name: path.basename(oldCopy),
        linkPath: oldCopy,
      });
      plannedPaths.add(normalizeForCompare(oldCopy));
    }
  }

  const manifestPlan = planAntigravityManifest(config, state, desired, effectiveSyncMode, {
    platform,
  });

  const actionable = allActions.filter((a) => a.type !== "noop");
  const summary = {
    create: actionable.filter((a) => a.type === "create").length,
    replace: actionable.filter((a) => a.type === "replace").length,
    remove: actionable.filter((a) => a.type === "remove").length,
    conflicts: actionable.filter((a) => a.type === "skipConflict").length,
    manifestChanged: Boolean(manifestPlan?.changed),
    totalPending:
      actionable.filter((a) => a.type !== "skipConflict").length +
      (manifestPlan?.changed ? 1 : 0),
  };

  return {
    effectiveSyncMode,
    summary,
    actions: actionable,
    allActions,
    nextManagedLinks,
    nextManagedCopies,
    manifestPlan,
    desired,
    nameCollisions: catalog.nameCollisions,
  };
}

export function applySync({ dryRun = false, platform = process.platform } = {}) {
  const config = loadConfig();
  const state = loadState();
  const catalog = buildSkillCatalog(config);
  const plan = planSync(config, state, catalog, { platform });

  if (dryRun) {
    return {
      dryRun: true,
      effectiveSyncMode: plan.effectiveSyncMode,
      summary: plan.summary,
      actions: plan.actions,
      manifest: plan.manifestPlan,
      nameCollisions: plan.nameCollisions,
    };
  }

  const applied = [];
  const errors = [];
  const managedLinkSet = new Set(plan.nextManagedLinks.map((p) => path.resolve(p)));
  const managedCopySet = new Set(plan.nextManagedCopies.map((p) => path.resolve(p)));

  // Execute hub actions BEFORE target actions so target -> hub links never dangle
  const ordered = [...plan.actions].sort((a, b) => {
    const rank = (x) => (x.scope === "hub" ? 0 : x.type === "remove" ? 2 : 1);
    return rank(a) - rank(b);
  });

  for (const action of ordered) {
    try {
      if (action.type === "skipConflict") {
        applied.push(action);
        continue;
      }
      if (action.type === "create") {
        ensureDir(path.dirname(action.linkPath));
        if (action.materialize === "copy") {
          writeManagedCopy(action.sourceDir, action.linkPath, {
            sourceId: action.sourceId,
            skillRef: action.skillRef,
            digest: action.digest,
          });
        } else {
          createDirLink(action.targetPath, action.linkPath);
        }
        applied.push(action);
      } else if (action.type === "replace") {
        if (action.materialize === "copy") {
          writeManagedCopy(action.sourceDir, action.linkPath, {
            sourceId: action.sourceId,
            skillRef: action.skillRef,
            digest: action.digest,
          });
        } else {
          const curLst = safeLstat(action.linkPath);
          if (curLst) {
            if (curLst.isSymbolicLink()) {
              removeLink(action.linkPath);
            } else {
              removeManagedCopy(action.linkPath);
            }
          }
          createDirLink(action.targetPath, action.linkPath);
        }
        applied.push(action);
      } else if (action.type === "remove") {
        if (action.materialize === "copy") {
          removeManagedCopy(action.linkPath);
          managedCopySet.delete(path.resolve(action.linkPath));
        } else {
          removeLink(action.linkPath);
          managedLinkSet.delete(path.resolve(action.linkPath));
        }
        applied.push(action);
      }
    } catch (err) {
      errors.push({ action, error: err.message });
    }
  }

  if (plan.manifestPlan?.changed) {
    try {
      if (plan.manifestPlan.removeFile) {
        fs.unlinkSync(plan.manifestPlan.manifestPath);
      } else {
        writeJsonAtomic(plan.manifestPlan.manifestPath, plan.manifestPlan.nextContent);
      }
    } catch (err) {
      errors.push({
        action: { type: "manifest", path: plan.manifestPlan.manifestPath },
        error: err.message,
      });
    }
  }

  saveState({
    managedLinks: [...managedLinkSet],
    managedCopies: [...managedCopySet],
    managedManifestEntries: plan.manifestPlan?.nextManagedManifestEntries || [],
  });

  return {
    dryRun: false,
    effectiveSyncMode: plan.effectiveSyncMode,
    summary: plan.summary,
    applied,
    errors,
    manifest: plan.manifestPlan,
    nameCollisions: plan.nameCollisions,
  };
}
