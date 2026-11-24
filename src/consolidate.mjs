import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import {
  canonicalOrResolved,
  createDirLink,
  ensureDir,
  expandHome,
  getHubConfigDir,
  getUserHome,
  isInsideDir,
  moveDir,
  moveIntoDir,
  normalizeForCompare,
  removeIfEmptyDir,
  removeLink,
  resolveLinkTarget,
  safeLstat,
  safeRealpath,
  safeStat,
} from "./paths.mjs";
import { parseSkillFrontmatter } from "./sources.mjs";
import { applySync, buildSkillCatalog, resolveDesiredState } from "./sync.mjs";

function canonicalTargetPath(targetPath) {
  return (
    safeRealpath(targetPath) ||
    path.join(canonicalOrResolved(path.dirname(targetPath)), path.basename(targetPath))
  );
}

export function getTrashRoot() {
  return path.join(getHubConfigDir(), "trash");
}

function makeTrashBatchDir() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const root = getTrashRoot();
  let candidate = path.join(root, stamp);
  let seq = 1;
  while (safeLstat(candidate)) {
    candidate = path.join(root, `${stamp}-${seq}`);
    seq += 1;
  }
  ensureDir(candidate);
  return candidate;
}

export function collectScanLocations(config = loadConfig()) {
  const hubAbsDir = expandHome(config.hubDir);
  const hubCanon = normalizeForCompare(canonicalOrResolved(hubAbsDir));
  const locations = [
    {
      id: "hub",
      label: `通用中枢 (${config.hubDir})`,
      dir: hubAbsDir,
      isHub: true,
      isLegacy: false,
      mode: "hub",
    },
  ];
  const seenCanonDirs = new Set([hubCanon]);

  const legacyDir = path.join(getUserHome(), ".smelt", "skills");
  const legacyCanon = normalizeForCompare(canonicalOrResolved(legacyDir));
  if (safeLstat(legacyDir)?.isDirectory() && !seenCanonDirs.has(legacyCanon)) {
    seenCanonDirs.add(legacyCanon);
    locations.push({
      id: "legacy-smelt",
      label: "Smelt 旧目录 (~/.smelt/skills)",
      dir: legacyDir,
      isHub: false,
      isLegacy: true,
      mode: "legacy",
    });
  }

  for (const [id, target] of Object.entries(config.targets || {})) {
    const dir = expandHome(target.path);
    const canon = normalizeForCompare(canonicalOrResolved(dir));
    if (seenCanonDirs.has(canon)) continue;
    seenCanonDirs.add(canon);
    locations.push({
      id,
      label: target.label || id,
      dir,
      isHub: false,
      isLegacy: false,
      mode: target.mode,
    });
  }

  return { hubAbsDir, locations };
}

function scanSingleLocation(loc, ownedSourceRoots) {
  const realSkills = [];
  const symlinks = [];
  const externalLinks = [];
  const brokenLinks = [];

  const dirSt = safeLstat(loc.dir);
  if (!dirSt || !dirSt.isDirectory()) {
    return { realSkills, symlinks, externalLinks, brokenLinks };
  }

  let entries;
  try {
    entries = fs.readdirSync(loc.dir);
  } catch {
    return { realSkills, symlinks, externalLinks, brokenLinks };
  }

  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const fullPath = path.join(loc.dir, name);
    const lst = safeLstat(fullPath);
    if (!lst) continue;

    if (lst.isSymbolicLink()) {
      const targetReal = safeRealpath(fullPath);
      const mdPath = targetReal ? path.join(targetReal, "SKILL.md") : null;
      const mdSt = mdPath ? safeStat(mdPath) : null;
      if (!targetReal || !mdSt || !mdSt.isFile()) {
        brokenLinks.push({
          path: fullPath,
          rawTarget: resolveLinkTarget(fullPath),
          locationId: loc.id,
          locationLabel: loc.label,
        });
        continue;
      }
      symlinks.push({
        dirName: name,
        path: fullPath,
        targetReal,
        locationId: loc.id,
        locationLabel: loc.label,
      });
      const inOwnedSource = ownedSourceRoots.some((root) => isInsideDir(targetReal, root));
      if (!inOwnedSource) {
        externalLinks.push({
          dirName: name,
          path: fullPath,
          targetReal,
          locationId: loc.id,
          locationLabel: loc.label,
        });
      }
      continue;
    }

    if (lst.isDirectory()) {
      const mdPath = path.join(fullPath, "SKILL.md");
      const mdSt = safeStat(mdPath);
      if (!mdSt || !mdSt.isFile()) continue;
      let fm = { name: null, description: null };
      try {
        fm = parseSkillFrontmatter(fs.readFileSync(mdPath, "utf8"));
      } catch {
        // Ignore parse failures
      }
      realSkills.push({
        dirName: name,
        name: fm.name || name,
        description: fm.description || "",
        path: fullPath,
        canonicalPath: canonicalOrResolved(fullPath),
        mtimeMs: mdSt.mtimeMs,
        locationId: loc.id,
        locationLabel: loc.label,
        isHub: loc.isHub,
        isLegacy: loc.isLegacy,
        isManagedSource: false,
      });
    }
  }

  return { realSkills, symlinks, externalLinks, brokenLinks };
}

/**
 * Scans hub, legacy, and all agent directories along with registered sources.
 */
export function scanAllCopies(config = loadConfig()) {
  const catalog = buildSkillCatalog(config);
  const ownedSourceRoots = catalog.sources.flatMap((s) => [
    canonicalOrResolved(s.skillsRoot),
    canonicalOrResolved(s.absPath),
  ]);
  const { hubAbsDir, locations } = collectScanLocations(config);

  const realByCanon = new Map();
  const copiesByName = new Map();
  const allSymlinks = [];
  const brokenLinks = [];
  const hubEntries = new Map(); // dirName -> { dirName, isManagedSource, targetPath }

  for (const loc of locations) {
    const res = scanSingleLocation(loc, ownedSourceRoots);
    brokenLinks.push(...res.brokenLinks);
    allSymlinks.push(...res.symlinks);

    for (const item of res.realSkills) {
      const key = normalizeForCompare(item.canonicalPath);
      if (!realByCanon.has(key)) {
        realByCanon.set(key, {
          ...item,
          locations: [{ id: loc.id, label: loc.label, path: item.path }],
        });
      } else {
        realByCanon.get(key).locations.push({ id: loc.id, label: loc.label, path: item.path });
      }

      if (!copiesByName.has(item.dirName)) copiesByName.set(item.dirName, []);
      copiesByName.get(item.dirName).push(item);

      if (loc.isHub) {
        hubEntries.set(item.dirName, {
          dirName: item.dirName,
          isManagedSource: false,
          targetPath: item.path,
        });
      }
    }

    for (const ext of res.externalLinks) {
      const key = normalizeForCompare(ext.targetReal);
      if (realByCanon.has(key)) {
        realByCanon.get(key).locations.push({
          id: loc.id,
          label: `${loc.label} (软链)`,
          path: ext.path,
        });
      }
    }

    if (loc.isHub) {
      for (const link of res.symlinks) {
        const isManaged = ownedSourceRoots.some((root) => isInsideDir(link.targetReal, root));
        if (!hubEntries.has(link.dirName)) {
          hubEntries.set(link.dirName, {
            dirName: link.dirName,
            isManagedSource: isManaged,
            targetPath: link.path,
          });
        }
      }
    }
  }

  const unmanaged = [...realByCanon.values()].sort((a, b) =>
    a.dirName.localeCompare(b.dirName),
  );

  // Merge managed source skills into copiesByName so conflicts with managed sources are detected
  for (const managed of catalog.activeSkills) {
    if (!copiesByName.has(managed.dirName)) copiesByName.set(managed.dirName, []);
    copiesByName.get(managed.dirName).push({
      dirName: managed.dirName,
      name: managed.name,
      description: managed.description,
      path: managed.dir,
      canonicalPath: canonicalOrResolved(managed.dir),
      mtimeMs: managed.mtimeMs,
      locationId: `source:${managed.sourceId}`,
      locationLabel: `${managed.sourceName} (已纳管源)`,
      isHub: false,
      isLegacy: false,
      isManagedSource: true,
      sourceId: managed.sourceId,
    });
  }

  const conflicts = [];
  const scattered = [];

  for (const [dirName, copies] of copiesByName.entries()) {
    if (copies.length > 1) {
      const sorted = [...copies].sort((a, b) => {
        if (a.isManagedSource !== b.isManagedSource) return a.isManagedSource ? -1 : 1;
        if (a.isHub !== b.isHub) return a.isHub ? -1 : 1;
        return (b.mtimeMs || 0) - (a.mtimeMs || 0);
      });
      conflicts.push({
        dirName,
        copies: sorted.map((c) => ({
          locationId: c.locationId,
          locationLabel: c.locationLabel,
          path: c.path,
          mtimeMs: c.mtimeMs,
          isHub: Boolean(c.isHub),
          isLegacy: Boolean(c.isLegacy),
          isManagedSource: Boolean(c.isManagedSource),
        })),
      });
    } else if (copies.length === 1) {
      const only = copies[0];
      if (!only.isHub && !only.isManagedSource) {
        scattered.push(only);
      }
    }
  }

  conflicts.sort((a, b) => a.dirName.localeCompare(b.dirName));
  scattered.sort((a, b) => a.dirName.localeCompare(b.dirName));

  return {
    catalog,
    hubAbsDir,
    locations,
    unmanaged,
    brokenLinks,
    allSymlinks,
    hubEntries,
    conflicts,
    scattered,
  };
}

/**
 * Computes a deterministic, previewable plan to consolidate scattered real skills into
 * `.agents/skills` and create missing symlinks/junctions for `link`-mode targets.
 */
export function planConsolidate(
  config = loadConfig(),
  { skillNames = null, repairBridges = true } = {},
) {
  const scan = scanAllCopies(config);
  const desired = resolveDesiredState(config, scan.catalog);
  const filterSet =
    Array.isArray(skillNames) && skillNames.length > 0 ? new Set(skillNames) : null;
  const conflictSet = new Set(scan.conflicts.map((c) => c.dirName));

  const actions = [];
  const movingFromSet = new Set();
  const movedNames = new Set();
  const plannedTargetLinks = new Set();

  // Step A: Move scattered real directories into hubDir
  for (const item of scan.scattered) {
    if (filterSet && !filterSet.has(item.dirName)) continue;
    const hubDest = path.join(scan.hubAbsDir, item.dirName);
    const destLst = safeLstat(hubDest);
    if (destLst && !destLst.isSymbolicLink()) {
      continue;
    }

    actions.push({
      type: "moveToHub",
      dirName: item.dirName,
      from: item.path,
      to: hubDest,
      fromLabel: item.locationLabel,
      replaceBrokenLinkAtDest: Boolean(destLst && destLst.isSymbolicLink()),
      description: `迁移到 ${config.hubDir}: ${item.path} -> ${hubDest}`,
    });
    movingFromSet.add(normalizeForCompare(item.path));
    movedNames.add(item.dirName);

    // Repoint any existing symlinks that pointed directly to the old scattered location
    const oldCanon = normalizeForCompare(item.canonicalPath);
    for (const link of scan.allSymlinks) {
      if (normalizeForCompare(link.targetReal) !== oldCanon) continue;
      if (normalizeForCompare(link.path) === normalizeForCompare(hubDest)) continue;
      actions.push({
        type: "relink",
        dirName: link.dirName,
        at: link.path,
        to: hubDest,
        targetId: link.locationId,
        targetLabel: link.locationLabel,
        description: `重指已有软链 (${link.locationLabel}): ${link.path} -> ${hubDest}`,
      });
      plannedTargetLinks.add(normalizeForCompare(link.path));
    }
  }

  // Step B: Create/repair symlinks in link-mode targets for all non-conflicted hub skills
  if (repairBridges) {
    const candidateNames = new Set([
      ...scan.hubEntries.keys(),
      ...movedNames,
    ]);

    const linkTargets = Object.entries(config.targets || {})
      .filter(([, t]) => t.mode === "link")
      .map(([id, t]) => ({
        id,
        label: t.label || id,
        dir: expandHome(t.path),
      }));

    for (const dirName of [...candidateNames].sort()) {
      if (conflictSet.has(dirName)) continue;
      if (filterSet && !filterSet.has(dirName)) continue;

      const hubEntry = scan.hubEntries.get(dirName);
      const isManaged = Boolean(hubEntry?.isManagedSource);
      const hubDest = path.join(scan.hubAbsDir, dirName);

      for (const target of linkTargets) {
        // Respect managed skill exclusions/disables
        if (isManaged && !desired.targetDesired[target.id]?.has(dirName)) {
          continue;
        }

        const linkAt = path.join(target.dir, dirName);
        const normAt = normalizeForCompare(linkAt);
        if (plannedTargetLinks.has(normAt)) continue;

        const expectedTarget =
          isManaged && !desired.hubDesired.has(dirName)
            ? desired.targetDesired[target.id].get(dirName).linkTarget
            : hubDest;

        // If Step A is moving a real directory OUT of this exact linkAt path,
        // Step B will safely place a symlink in its spot right afterward.
        if (movingFromSet.has(normAt)) {
          actions.push({
            type: "link",
            dirName,
            at: linkAt,
            to: expectedTarget,
            targetId: target.id,
            targetLabel: target.label,
            description: `为 ${target.label} 建软链: ${linkAt} -> ${expectedTarget}`,
          });
          plannedTargetLinks.add(normAt);
          continue;
        }

        const lst = safeLstat(linkAt);
        if (!lst) {
          actions.push({
            type: "link",
            dirName,
            at: linkAt,
            to: expectedTarget,
            targetId: target.id,
            targetLabel: target.label,
            description: `为 ${target.label} 建软链: ${linkAt} -> ${expectedTarget}`,
          });
          plannedTargetLinks.add(normAt);
        } else if (lst.isSymbolicLink()) {
          const curReal = safeRealpath(linkAt);
          const expectedCanon = canonicalTargetPath(expectedTarget);
          const curCanon = curReal ? normalizeForCompare(curReal) : "";
          if (curCanon !== normalizeForCompare(expectedCanon)) {
            actions.push({
              type: "relink",
              dirName,
              at: linkAt,
              to: expectedTarget,
              targetId: target.id,
              targetLabel: target.label,
              description: `修复 ${target.label} 软链: ${linkAt} -> ${expectedTarget}`,
            });
            plannedTargetLinks.add(normAt);
          }
        }
      }
    }
  }

  // Step C: Remove ~/.smelt/skills if all entries inside it are moving out
  const legacyLoc = scan.locations.find((l) => l.isLegacy);
  if (legacyLoc) {
    try {
      const remaining = fs
        .readdirSync(legacyLoc.dir)
        .filter((name) => name !== ".DS_Store")
        .filter(
          (name) => !movingFromSet.has(normalizeForCompare(path.join(legacyLoc.dir, name))),
        );
      if (remaining.length === 0) {
        actions.push({
          type: "removeEmptyLegacy",
          path: legacyLoc.dir,
          description: `清理已迁空的旧目录: ${legacyLoc.dir}`,
        });
      }
    } catch {
      // Ignore unreadable legacy dir
    }
  }

  const toMove = actions.filter((a) => a.type === "moveToHub").length;
  const toLink = actions.filter((a) => a.type === "link").length;
  const toRelink = actions.filter((a) => a.type === "relink").length;

  return {
    actions,
    summary: {
      toMove,
      toLink,
      toRelink,
      conflicts: scan.conflicts.length,
      totalActions: actions.length,
    },
    scattered: scan.scattered,
    conflicts: scan.conflicts,
    skippedConflicts: scan.conflicts.map((c) => c.dirName),
    trashDir: getTrashRoot(),
  };
}

export function applyConsolidate({
  dryRun = false,
  skillNames = null,
  repairBridges = true,
} = {}) {
  const config = loadConfig();
  const plan = planConsolidate(config, { skillNames, repairBridges });

  if (dryRun) {
    return {
      dryRun: true,
      summary: plan.summary,
      actions: plan.actions,
      skippedConflicts: plan.skippedConflicts,
    };
  }

  const applied = [];
  const errors = [];

  const order = { moveToHub: 0, relink: 1, link: 2, removeEmptyLegacy: 3 };
  const sortedActions = [...plan.actions].sort(
    (a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9),
  );

  for (const action of sortedActions) {
    try {
      if (action.type === "moveToHub") {
        if (action.replaceBrokenLinkAtDest) {
          const destLst = safeLstat(action.to);
          if (destLst && destLst.isSymbolicLink()) removeLink(action.to);
        }
        moveDir(action.from, action.to);
        applied.push(action);
      } else if (action.type === "relink") {
        const curLst = safeLstat(action.at);
        if (curLst) {
          if (!curLst.isSymbolicLink()) {
            throw new Error(`目标位置已存在非软链目录，拒绝覆盖: ${action.at}`);
          }
          removeLink(action.at);
        }
        createDirLink(action.to, action.at);
        applied.push(action);
      } else if (action.type === "link") {
        const curLst = safeLstat(action.at);
        if (curLst) {
          if (curLst.isSymbolicLink()) {
            removeLink(action.at);
          } else {
            throw new Error(`目标位置已存在实体目录，拒绝覆盖: ${action.at}`);
          }
        }
        createDirLink(action.to, action.at);
        applied.push(action);
      } else if (action.type === "removeEmptyLegacy") {
        removeIfEmptyDir(action.path);
        applied.push(action);
      }
    } catch (err) {
      errors.push({ action, error: err.message });
    }
  }

  return {
    dryRun: false,
    summary: plan.summary,
    applied,
    errors,
    skippedConflicts: plan.skippedConflicts,
  };
}

/**
 * Resolves a duplicate real-dir conflict by keeping `keepPath`, moving all other real
 * copies safely to `~/.skill-hub/trash/<timestamp>/`, and optionally consolidating
 * the kept copy into `.agents/skills` + repairing target symlinks.
 */
export function resolveConflict({
  dirName,
  keepPath,
  consolidateToHub = true,
  repairBridges = true,
}) {
  if (!dirName || !keepPath) {
    throw new Error("必须指定冲突技能名 dirName 和保留路径 keepPath");
  }
  const config = loadConfig();
  const scan = scanAllCopies(config);
  const conflict = scan.conflicts.find((c) => c.dirName === dirName);
  if (!conflict) {
    throw new Error(`未找到技能 "${dirName}" 的同名冲突`);
  }

  const absKeep = expandHome(keepPath);
  const normKeep = normalizeForCompare(absKeep);
  const keptCopy = conflict.copies.find((c) => normalizeForCompare(c.path) === normKeep);
  if (!keptCopy) {
    throw new Error(`保留路径 "${absKeep}" 不在 "${dirName}" 的冲突副本列表中`);
  }

  const discardedCopies = conflict.copies.filter(
    (c) => normalizeForCompare(c.path) !== normKeep,
  );
  if (discardedCopies.some((c) => c.isManagedSource)) {
    throw new Error(
      `技能 "${dirName}" 存在已纳管仓库源副本，不能将仓库源副本移入回收站；请选择保留仓库源副本或先移除该源。`,
    );
  }

  const batchTrashDir = makeTrashBatchDir();
  const trashed = [];

  for (const discard of discardedCopies) {
    const discardCanon = normalizeForCompare(canonicalOrResolved(discard.path));
    // Unlink any symlinks that pointed specifically to this discarded copy
    for (const link of scan.allSymlinks) {
      if (normalizeForCompare(link.targetReal) === discardCanon) {
        removeLink(link.path);
      }
    }
    const movedTo = moveIntoDir(batchTrashDir, discard.path, dirName);
    trashed.push({ from: discard.path, to: movedTo });
  }

  let finalPath = keptCopy.path;
  let syncResult = null;
  let consolidateResult = null;

  if (keptCopy.isManagedSource) {
    syncResult = applySync();
  } else if (consolidateToHub && !keptCopy.isHub) {
    const hubDest = path.join(scan.hubAbsDir, dirName);
    const destLst = safeLstat(hubDest);
    if (destLst) {
      if (destLst.isSymbolicLink()) {
        removeLink(hubDest);
      } else {
        throw new Error(`中枢目录已存在非软链目录: ${hubDest}`);
      }
    }
    const keptCanon = normalizeForCompare(canonicalOrResolved(keptCopy.path));
    moveDir(keptCopy.path, hubDest);
    finalPath = hubDest;

    // Repoint any existing symlinks that pointed to the kept copy's previous location
    for (const link of scan.allSymlinks) {
      if (normalizeForCompare(link.targetReal) === keptCanon) {
        const curLst = safeLstat(link.path);
        if (curLst?.isSymbolicLink()) removeLink(link.path);
        createDirLink(hubDest, link.path);
      }
    }
  }

  if (!keptCopy.isManagedSource && repairBridges) {
    consolidateResult = applyConsolidate({
      skillNames: [dirName],
      repairBridges: true,
    });
  }

  return {
    ok: true,
    dirName,
    keptPath: finalPath,
    trashed,
    trashDir: batchTrashDir,
    sync: syncResult,
    consolidate: consolidateResult,
  };
}
