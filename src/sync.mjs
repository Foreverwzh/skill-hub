import fs from "node:fs";
import path from "node:path";
import { loadConfig, loadState, saveState } from "./config.mjs";
import {
  canonicalOrResolved,
  createDirLink,
  ensureDir,
  expandHome,
  isInsideDir,
  normalizeForCompare,
  removeLink,
  resolveLinkTarget,
  safeLstat,
  safeRealpath,
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

function planDirectorySync({
  dirPath,
  desiredEntries, // Map<dirName, targetPath>
  stateManagedSet,
  ownedRoots,
  scopeLabel,
}) {
  const actions = [];
  const nextManagedLinks = [];
  const dirStat = safeLstat(dirPath);
  const existingNames = new Set();

  if (dirStat && dirStat.isDirectory()) {
    for (const name of fs.readdirSync(dirPath)) {
      if (name.startsWith(".")) continue;
      existingNames.add(name);
    }
  }

  // 1. Ensure desired links
  for (const [name, targetPath] of desiredEntries.entries()) {
    const linkPath = path.join(dirPath, name);
    const lst = safeLstat(linkPath);
    const expectedCanon = canonicalOrResolved(targetPath);

    if (!lst) {
      actions.push({
        type: "create",
        scope: scopeLabel,
        name,
        linkPath,
        targetPath,
      });
      nextManagedLinks.push(linkPath);
      continue;
    }

    if (!lst.isSymbolicLink()) {
      actions.push({
        type: "skipConflict",
        scope: scopeLabel,
        name,
        linkPath,
        targetPath,
        reason: "目标路径存在未纳管的实体目录或文件，已跳过以避免覆盖",
      });
      continue;
    }

    const currentReal = safeRealpath(linkPath);
    const currentCanon = currentReal ? normalizeForCompare(currentReal) : "";
    if (currentCanon === normalizeForCompare(expectedCanon)) {
      actions.push({
        type: "noop",
        scope: scopeLabel,
        name,
        linkPath,
        targetPath,
      });
      nextManagedLinks.push(linkPath);
    } else if (isOwnedLink(linkPath, stateManagedSet, ownedRoots)) {
      actions.push({
        type: "replace",
        scope: scopeLabel,
        name,
        linkPath,
        targetPath,
      });
      nextManagedLinks.push(linkPath);
    } else {
      actions.push({
        type: "skipConflict",
        scope: scopeLabel,
        name,
        linkPath,
        targetPath,
        reason: "存在指向外部目录的自定义软链，已保留未覆盖",
      });
    }
  }

  // 2. Remove stale managed links that are no longer desired
  for (const name of existingNames) {
    if (desiredEntries.has(name)) continue;
    const entryPath = path.join(dirPath, name);
    const lst = safeLstat(entryPath);
    if (!lst || !lst.isSymbolicLink()) continue;

    if (isOwnedLink(entryPath, stateManagedSet, ownedRoots)) {
      actions.push({
        type: "remove",
        scope: scopeLabel,
        name,
        linkPath: entryPath,
      });
    }
  }

  return { actions, nextManagedLinks };
}

/**
 * Builds a complete, non-destructive sync plan across hubDir and all link-mode targets.
 */
export function planSync(
  config = loadConfig(),
  state = loadState(),
  catalog = buildSkillCatalog(config),
) {
  const desired = resolveDesiredState(config, catalog);
  const stateManagedSet = new Set((state.managedLinks || []).map(normalizeForCompare));
  const ownedRoots = [
    ...catalog.sources.map((s) => canonicalOrResolved(s.skillsRoot)),
    ...catalog.sources.map((s) => canonicalOrResolved(s.absPath)),
  ];

  const allActions = [];
  const nextManagedLinks = [];

  // Plan hubDir links
  const hubDesiredMap = new Map();
  for (const [name, skill] of desired.hubDesired.entries()) {
    hubDesiredMap.set(name, skill.dir);
  }
  const hubPlan = planDirectorySync({
    dirPath: desired.hubAbsDir,
    desiredEntries: hubDesiredMap,
    stateManagedSet,
    ownedRoots,
    scopeLabel: "hub",
  });
  allActions.push(...hubPlan.actions);
  nextManagedLinks.push(...hubPlan.nextManagedLinks);

  // Plan each link-mode target
  for (const [targetId, map] of Object.entries(desired.targetDesired)) {
    const targetCfg = config.targets[targetId];
    const targetDir = expandHome(targetCfg.path);
    const entries = new Map();
    for (const [name, info] of map.entries()) {
      entries.set(name, info.linkTarget);
    }
    const tPlan = planDirectorySync({
      dirPath: targetDir,
      desiredEntries: entries,
      stateManagedSet,
      ownedRoots,
      scopeLabel: targetId,
    });
    allActions.push(...tPlan.actions);
    nextManagedLinks.push(...tPlan.nextManagedLinks);
  }

  // Any previously tracked link in a target that switched to disabled/hub-only should also be cleaned up
  const plannedPaths = new Set(allActions.map((a) => normalizeForCompare(a.linkPath)));
  for (const oldLink of state.managedLinks || []) {
    if (plannedPaths.has(normalizeForCompare(oldLink))) continue;
    const lst = safeLstat(oldLink);
    if (lst && lst.isSymbolicLink() && isOwnedLink(oldLink, stateManagedSet, ownedRoots)) {
      allActions.push({
        type: "remove",
        scope: "cleanup",
        name: path.basename(oldLink),
        linkPath: oldLink,
      });
    }
  }

  const actionable = allActions.filter((a) => a.type !== "noop");
  const summary = {
    create: actionable.filter((a) => a.type === "create").length,
    replace: actionable.filter((a) => a.type === "replace").length,
    remove: actionable.filter((a) => a.type === "remove").length,
    conflicts: actionable.filter((a) => a.type === "skipConflict").length,
    totalPending: actionable.filter((a) => a.type !== "skipConflict").length,
  };

  return {
    summary,
    actions: actionable,
    allActions,
    nextManagedLinks,
    desired,
    nameCollisions: catalog.nameCollisions,
  };
}

export function applySync({ dryRun = false } = {}) {
  const config = loadConfig();
  const state = loadState();
  const catalog = buildSkillCatalog(config);
  const plan = planSync(config, state, catalog);

  if (dryRun) {
    return {
      dryRun: true,
      summary: plan.summary,
      actions: plan.actions,
      nameCollisions: plan.nameCollisions,
    };
  }

  const applied = [];
  const errors = [];
  const managedSet = new Set(plan.nextManagedLinks.map((p) => path.resolve(p)));

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
        createDirLink(action.targetPath, action.linkPath);
        applied.push(action);
      } else if (action.type === "replace") {
        removeLink(action.linkPath);
        createDirLink(action.targetPath, action.linkPath);
        applied.push(action);
      } else if (action.type === "remove") {
        removeLink(action.linkPath);
        managedSet.delete(path.resolve(action.linkPath));
        applied.push(action);
      }
    } catch (err) {
      errors.push({ action, error: err.message });
    }
  }

  saveState({ managedLinks: [...managedSet] });

  return {
    dryRun: false,
    summary: plan.summary,
    applied,
    errors,
    nameCollisions: plan.nameCollisions,
  };
}
