import path from "node:path";
import { loadConfig, loadGuardConfig, loadState, resolveSyncMode, saveConfig } from "./config.mjs";
import { scanAllCopies } from "./consolidate.mjs";
import { isGitRepo } from "./git.mjs";
import { hasPrePushHook, scanDirectoryForLeaks } from "./guard.mjs";
import {
  createDirLink,
  ensureDir,
  expandHome,
  isInsideDir,
  isManagedCopyDir,
  moveDir,
  normalizeForCompare,
  removeLink,
  safeLstat,
  safeStat,
  writeManagedCopy,
} from "./paths.mjs";
import {
  getSourceById,
  listHydratedSources,
  readSourceProfiles,
  writeSourceProfiles,
} from "./sources.mjs";
import { applySync } from "./sync.mjs";

/**
 * Inspects hubDir, legacy ~/.smelt/skills, all configured targets, and registered sources for:
 * - Unmanaged real skill directories (ready to be adopted into a source or consolidated)
 * - Broken symlinks
 * - Duplicate real-dir conflicts across locations
 * - Git sources missing pre-push leak guard hooks
 */
export function runDoctor(config = loadConfig()) {
  const sources = listHydratedSources(config);
  const scan = scanAllCopies(config);

  const missingHooks = sources
    .filter(
      (s) =>
        s.exists &&
        s.trust !== "local" &&
        isGitRepo(s.absPath) &&
        !hasPrePushHook(s.absPath),
    )
    .map((s) => ({ sourceId: s.id, name: s.name, path: s.absPath }));

  return {
    unmanaged: scan.unmanaged,
    brokenLinks: scan.brokenLinks,
    conflicts: scan.conflicts,
    missingHooks,
    healthy:
      scan.brokenLinks.length === 0 &&
      scan.conflicts.length === 0 &&
      missingHooks.length === 0,
  };
}

/**
 * Safely moves an unmanaged real skill directory into a registered source,
 * replacing the original folder with a symlink/junction.
 */
export function adoptSkill({ skillPath, targetSourceId, enable = true }) {
  const absSkillPath = expandHome(skillPath);
  const lst = safeLstat(absSkillPath);
  if (!lst || !lst.isDirectory() || lst.isSymbolicLink()) {
    throw new Error(`只能纳管本地实体技能目录（收到: ${absSkillPath}）`);
  }
  if (isManagedCopyDir(absSkillPath)) {
    throw new Error(`该路径是 skill-hub 受管镜像副本，请直接在对应源仓库中编辑: ${absSkillPath}`);
  }
  const mdSt = safeStat(path.join(absSkillPath, "SKILL.md"));
  if (!mdSt || !mdSt.isFile()) {
    throw new Error(`目录缺少 SKILL.md，不是有效技能: ${absSkillPath}`);
  }

  const config = loadConfig();
  const targetSource = getSourceById(targetSourceId, config);
  const dirName = path.basename(absSkillPath);
  const destDir = path.join(targetSource.skillsRoot, dirName);

  if (safeLstat(destDir)) {
    throw new Error(`目标源 "${targetSourceId}" 中已存在同名技能 "${dirName}": ${destDir}`);
  }

  if (targetSource.trust === "github") {
    const guardConfig = loadGuardConfig();
    const findings = scanDirectoryForLeaks(absSkillPath, guardConfig);
    if (findings.length > 0) {
      const err = new Error(
        `安全守卫拒绝将 "${dirName}" 纳管到 GitHub 源 "${targetSourceId}"，检测到敏感内容：\n${findings.map((f) => `- ${f.message}`).join("\n")}`,
      );
      err.code = "GUARD_BLOCKED";
      err.violations = findings;
      throw err;
    }
  }

  ensureDir(targetSource.skillsRoot);
  moveDir(absSkillPath, destDir);

  const hubAbsDir = expandHome(config.hubDir);
  const adoptedFromHub =
    normalizeForCompare(path.dirname(absSkillPath)) === normalizeForCompare(hubAbsDir);

  if (enable) {
    const ref = `${targetSource.id}:${dirName}`;
    if (!config.include.includes(ref)) {
      config.include.push(ref);
    }
    config.exclude = config.exclude.filter((x) => x !== ref && x !== dirName);
    saveConfig(config);

    const effectiveSyncMode = resolveSyncMode(config);
    if (effectiveSyncMode === "copy") {
      const syncRes = applySync();
      const hubOnlyDirs = Object.values(config.targets || {})
        .filter((t) => t.mode === "hub-only")
        .map((t) => expandHome(t.path));
      const inHubOnlyTarget = hubOnlyDirs.some((d) => isInsideDir(absSkillPath, d));
      if (!safeLstat(absSkillPath) && !inHubOnlyTarget) {
        writeManagedCopy(destDir, absSkillPath, {
          sourceId: targetSource.id,
          skillRef: ref,
          origin: "consolidate",
        });
      }
      return {
        ok: true,
        dirName,
        destDir,
        targetSourceId,
        enabled: true,
        sync: syncRes,
      };
    }

    // Replace original path immediately (sync will also reconcile targets)
    if (adoptedFromHub) {
      createDirLink(destDir, absSkillPath);
    } else {
      ensureDir(hubAbsDir);
      const hubLink = path.join(hubAbsDir, dirName);
      if (!safeLstat(hubLink)) {
        createDirLink(destDir, hubLink);
      }
      createDirLink(hubLink, absSkillPath);
    }
    const syncRes = applySync();
    return {
      ok: true,
      dirName,
      destDir,
      targetSourceId,
      enabled: true,
      sync: syncRes,
    };
  }

  return {
    ok: true,
    dirName,
    destDir,
    targetSourceId,
    enabled: false,
  };
}

/**
 * Moves a managed skill between two registered sources, with leak guard if destination is GitHub.
 */
export function moveSkill({ dirName, fromSourceId, toSourceId }) {
  if (fromSourceId === toSourceId) {
    throw new Error("源与目标源相同，无需迁移");
  }
  const config = loadConfig();
  const fromSource = getSourceById(fromSourceId, config);
  const toSource = getSourceById(toSourceId, config);

  const srcDir = path.join(fromSource.skillsRoot, dirName);
  const dstDir = path.join(toSource.skillsRoot, dirName);
  if (!safeStat(srcDir)?.isDirectory()) {
    throw new Error(`源 "${fromSourceId}" 中不存在技能 "${dirName}"`);
  }
  if (safeLstat(dstDir)) {
    throw new Error(`目标源 "${toSourceId}" 中已存在同名技能 "${dirName}"`);
  }

  if (toSource.trust === "github" && fromSource.trust !== "github") {
    const guardConfig = loadGuardConfig();
    const findings = scanDirectoryForLeaks(srcDir, guardConfig);
    if (findings.length > 0) {
      const err = new Error(
        `安全守卫拦截跨源迁移（${fromSourceId} → ${toSourceId}）：\n${findings.map((f) => `- ${f.message}`).join("\n")}`,
      );
      err.code = "GUARD_BLOCKED";
      err.violations = findings;
      throw err;
    }
  }

  ensureDir(toSource.skillsRoot);
  moveDir(srcDir, dstDir);

  // Update include/exclude refs
  const oldRef = `${fromSourceId}:${dirName}`;
  const newRef = `${toSourceId}:${dirName}`;
  config.include = config.include.map((x) => (x === oldRef ? newRef : x));
  config.exclude = config.exclude.map((x) => (x === oldRef ? newRef : x));

  // Migrate profile membership if source profiles referenced this skill
  const fromProfiles = readSourceProfiles(fromSource);
  let profileUpdated = false;
  for (const [pName, list] of Object.entries(fromProfiles)) {
    if (list.includes(dirName)) {
      fromProfiles[pName] = list.filter((x) => x !== dirName);
      profileUpdated = true;
      // Preserve effective activation via include if that profile was enabled
      if (
        config.enabledProfiles.includes(`${fromSourceId}:${pName}`) &&
        !config.include.includes(newRef)
      ) {
        config.include.push(newRef);
      }
    }
  }
  if (profileUpdated) {
    writeSourceProfiles(fromSource, fromProfiles);
  }

  saveConfig(config);
  const syncRes = applySync();

  return {
    ok: true,
    dirName,
    fromSourceId,
    toSourceId,
    destDir: dstDir,
    sync: syncRes,
  };
}

/**
 * Safely deletes broken symlinks found by runDoctor().
 */
export function cleanupBrokenLinks(targetPaths = null) {
  const doctor = runDoctor();
  const allowedBroken = new Set(
    doctor.brokenLinks.map((b) => normalizeForCompare(b.path)),
  );
  const candidates = targetPaths
    ? targetPaths.map(expandHome).filter((p) => allowedBroken.has(normalizeForCompare(p)))
    : doctor.brokenLinks.map((b) => b.path);

  const removed = [];
  const errors = [];
  for (const p of candidates) {
    try {
      if (removeLink(p)) removed.push(p);
    } catch (err) {
      errors.push({ path: p, error: err.message });
    }
  }
  return { removed, errors };
}

export function getStateSummary() {
  return loadState();
}
