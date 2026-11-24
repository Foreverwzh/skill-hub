#!/usr/bin/env node
import os from "node:os";
import { loadConfig, loadGuardConfig } from "../src/config.mjs";
import {
  addSource,
  adoptSkill,
  applyConsolidate,
  applySync,
  cleanupBrokenLinks,
  convertLocalToInternal,
  deleteSourceProfile,
  getFullStatus,
  installSourceHook,
  moveSkill,
  pullSources,
  pushSource,
  removeSource,
  resolveConflict,
  runDoctor,
  runGuardCheck,
  setSourceProfile,
  setSourceTrust,
  toggleProfile,
  toggleSkill,
  updateSettings,
  updateSourceProfileMember,
  updateTarget,
} from "../src/api.mjs";
import { getSourceById, readSourceProfiles } from "../src/sources.mjs";

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq !== -1) {
        flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      } else {
        const key = tok.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          if (flags[key] === undefined) flags[key] = next;
          else if (Array.isArray(flags[key])) flags[key].push(next);
          else flags[key] = [flags[key], next];
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (tok === "-m") {
      const next = argv[i + 1];
      if (next !== undefined) {
        flags.message = next;
        i++;
      }
    } else if (tok === "-h") {
      flags.help = true;
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}

function splitList(val) {
  if (!val || val === true) return [];
  const arr = Array.isArray(val) ? val : [val];
  return arr
    .flatMap((x) => String(x).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseProfileRef(rawRef) {
  const [sourceId, profileName, extra] = String(rawRef || "").split(":");
  if (!sourceId || !profileName || extra !== undefined) {
    throw new Error("格式应为 <sourceId>:<profileName>");
  }
  return [sourceId, profileName];
}

function printHelp() {
  console.log(`skill-hub — 跨端多 Agent 技能管理与防泄密同步工具

用法:
  skill-hub status [--json]
  skill-hub sync [--dry-run] [--json]
  skill-hub pull [--source <id>] [--no-sync] [--json]
  skill-hub push <sourceId> [-m <message>] [--commit-only] [--json]
  skill-hub guard [--source <id> | --repo <path>] [--json]

源管理:
  skill-hub source list [--json]
  skill-hub source add --id <id> --path <dir> --trust <github|internal|local> [--name <name>] [--clone <url>] [--skills-dir <dir>] [--allow-host <h1,h2>] [--json]
  skill-hub source remove <id> [--json]
  skill-hub source set-trust <id> --trust <github|internal|local> [--allow-host <h1,h2>] [--json]
  skill-hub source convert-internal <id> [--remote <url>] [--allow-host <h1,h2>] [--json]
  skill-hub source install-hook <id> [--force] [--json]

分组与技能开关:
  skill-hub profile list [--json]
  skill-hub profile enable <sourceId:profile> [--json]
  skill-hub profile disable <sourceId:profile> [--json]
  skill-hub profile set <sourceId:profile> --skills <s1,s2,...> [--json]
  skill-hub profile add-skill <sourceId:profile> <skillDirName> [--json]
  skill-hub profile remove-skill <sourceId:profile> <skillDirName> [--json]
  skill-hub profile delete <sourceId:profile> [--json]
  skill-hub skill enable <sourceId:skill|skill> [--target <targetId>] [--json]
  skill-hub skill disable <sourceId:skill|skill> [--target <targetId>] [--json]
  skill-hub skill inherit <sourceId:skill|skill> --target <targetId> [--json]

体检、整合、纳管与跨源迁移:
  skill-hub doctor [--fix-broken] [--fix-hooks] [--json]
  skill-hub consolidate [--dry-run] [--skill <s1,s2,...>] [--no-bridges] [--json]
  skill-hub resolve-conflict <dirName> --keep <path> [--no-consolidate] [--no-bridges] [--json]
  skill-hub adopt <skillDirPath> --to <sourceId> [--no-enable] [--json]
  skill-hub move <dirName> --from <sourceId> --to <targetSourceId> [--json]

目标工具与设置:
  skill-hub target list [--json]
  skill-hub target set <targetId> [--mode <link|hub-only|disabled>] [--path <dir>] [--label <name>] [--json]
  skill-hub settings get [--json]
  skill-hub settings set --payload '<json>' [--json]
`);
}

function outputResult(data, asJson, humanPrinter) {
  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (humanPrinter) {
    humanPrinter(data);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

function printHumanStatus(status) {
  console.log(`设备: ${status.config.deviceName} | 中枢目录: ${status.config.hubDir}`);
  console.log(`技能源 (${status.sources.length}):`);
  for (const s of status.sources) {
    const gitTag = s.git.isGit
      ? `${s.git.branch || "HEAD"}${s.git.dirty ? " [有改动]" : ""}${s.git.ahead ? ` ↑${s.git.ahead}` : ""}${s.git.behind ? ` ↓${s.git.behind}` : ""}`
      : "无Git";
    console.log(`  - ${s.id} (${s.name}) [${s.trust}] ${s.path} | 技能:${s.skillsCount} | ${gitTag}`);
  }
  console.log(
    `技能总数: ${status.skills.length} | 待同步: +${status.pendingSync.summary.create} ~${status.pendingSync.summary.replace} -${status.pendingSync.summary.remove} (冲突:${status.pendingSync.summary.conflicts})`,
  );
  console.log(
    `体检: 未纳管 ${status.doctor.unmanaged.length}, 失效链接 ${status.doctor.brokenLinks.length}, 冲突 ${status.doctor.conflicts.length}, 缺Hook ${status.doctor.missingHooks.length}`,
  );
  if (status.consolidate) {
    const cs = status.consolidate.summary;
    console.log(
      `可整合到 ${status.config.hubDir}: 迁移 ${cs.toMove} 个, 补/修软链 ${cs.toLink + cs.toRelink} 条, 冲突 ${cs.conflicts} 项`,
    );
  }
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  if (typeof flags["env-json"] === "string" && flags["env-json"].trim()) {
    try {
      const forwarded = JSON.parse(flags["env-json"]);
      if (forwarded && typeof forwarded === "object" && !Array.isArray(forwarded)) {
        for (const [k, v] of Object.entries(forwarded)) {
          if (typeof v === "string" && !(k in process.env)) {
            process.env[k] = v;
          }
        }
      }
    } catch {
      // Ignore malformed forwarded env payload
    }
  }
  const home = process.env.SKILL_HUB_USER_HOME || os.homedir();
  if (process.platform === "win32") {
    if (!process.env.USERPROFILE) process.env.USERPROFILE = home;
  } else if (!process.env.HOME) {
    process.env.HOME = home;
  }

  const asJson = Boolean(flags.json);
  const cmd = positionals[0];

  if (!cmd || cmd === "help" || flags.help) {
    if (asJson) {
      outputResult({ ok: true, usage: "skill-hub <command> --json" }, true);
    } else {
      printHelp();
    }
    return;
  }

  switch (cmd) {
    case "status": {
      const data = getFullStatus();
      outputResult(data, asJson, printHumanStatus);
      return;
    }

    case "sync": {
      const data = applySync({ dryRun: Boolean(flags["dry-run"]) });
      outputResult(data, asJson, (d) => {
        console.log(
          `${d.dryRun ? "[Dry Run] " : ""}创建:${d.summary.create} 更新:${d.summary.replace} 清理:${d.summary.remove} 跳过冲突:${d.summary.conflicts}`,
        );
      });
      return;
    }

    case "pull": {
      const data = pullSources({
        sourceId: typeof flags.source === "string" ? flags.source : null,
        autoSync: !flags["no-sync"],
      });
      outputResult(data, asJson);
      if (!data.ok) process.exitCode = 1;
      return;
    }

    case "push": {
      const sourceId = positionals[1] || flags.source;
      if (!sourceId) throw new Error("请指定 sourceId: skill-hub push <sourceId>");
      const data = pushSource({
        sourceId,
        message: typeof flags.message === "string" ? flags.message : "",
        skipPush: Boolean(flags["commit-only"]),
      });
      outputResult(data, asJson);
      return;
    }

    case "guard": {
      const data = runGuardCheck({
        sourceId: typeof flags.source === "string" ? flags.source : null,
        repoPath: typeof flags.repo === "string" ? flags.repo : null,
      });
      outputResult(data, asJson, (d) => {
        if (d.ok) {
          console.log("安全守卫检查通过。");
        } else {
          for (const r of d.results.filter((x) => !x.ok)) {
            console.error(`拦截 [${r.sourceId}] (${r.trust}):`);
            for (const v of r.violations) console.error(`  - ${v.message}`);
          }
        }
      });
      if (!data.ok) process.exitCode = 2;
      return;
    }

    case "source": {
      const sub = positionals[1];
      if (sub === "list") {
        const status = getFullStatus();
        outputResult({ sources: status.sources }, asJson);
        return;
      }
      if (sub === "add") {
        const data = addSource({
          id: flags.id,
          name: flags.name || flags.id,
          path: flags.path,
          trust: flags.trust || "local",
          cloneUrl: typeof flags.clone === "string" ? flags.clone : "",
          skillsDir: typeof flags["skills-dir"] === "string" ? flags["skills-dir"] : undefined,
          allowedRemoteHosts: splitList(flags["allow-host"]),
          forbiddenRemoteHosts: splitList(flags["forbid-host"]),
          initIfMissing: !flags["no-init"],
        });
        outputResult(data, asJson);
        return;
      }
      if (sub === "remove") {
        const id = positionals[2] || flags.id;
        if (!id) throw new Error("请指定源 ID");
        outputResult(removeSource(id), asJson);
        return;
      }
      if (sub === "set-trust") {
        const id = positionals[2] || flags.id;
        const trust = flags.trust;
        if (!id || typeof trust !== "string") {
          throw new Error("用法: skill-hub source set-trust <id> --trust <github|internal|local>");
        }
        const data = setSourceTrust(id, {
          trust,
          allowedRemoteHosts: splitList(flags["allow-host"]),
        });
        outputResult(data, asJson);
        return;
      }
      if (sub === "convert-internal") {
        const id = positionals[2] || flags.id;
        if (!id) throw new Error("请指定源 ID");
        const data = convertLocalToInternal(id, {
          remoteUrl: typeof flags.remote === "string" ? flags.remote : "",
          allowedRemoteHosts: splitList(flags["allow-host"]),
        });
        outputResult(data, asJson);
        return;
      }
      if (sub === "install-hook") {
        const id = positionals[2] || flags.id;
        if (!id) throw new Error("请指定源 ID");
        const data = installSourceHook(id, Boolean(flags.force));
        outputResult(data, asJson);
        return;
      }
      throw new Error(`未知 source 子命令: ${sub}`);
    }

    case "profile": {
      const sub = positionals[1];
      if (sub === "list") {
        const config = loadConfig();
        const enabledSet = new Set(config.enabledProfiles || []);
        const list = [];
        for (const raw of config.sources) {
          const s = getSourceById(raw.id, config);
          const p = readSourceProfiles(s);
          for (const [name, skills] of Object.entries(p)) {
            const ref = `${s.id}:${name}`;
            list.push({ ref, sourceId: s.id, name, skills, enabled: enabledSet.has(ref) });
          }
        }
        outputResult({ profiles: list }, asJson);
        return;
      }
      if (sub === "enable" || sub === "disable") {
        const ref = positionals[2] || flags.ref;
        const data = toggleProfile({ ref, enabled: sub === "enable" });
        if (flags.sync) data.sync = applySync();
        outputResult(data, asJson);
        return;
      }
      if (sub === "set") {
        const [sourceId, profileName] = parseProfileRef(positionals[2] || flags.ref);
        const skills = splitList(flags.skills);
        const saved = setSourceProfile(sourceId, profileName, skills);
        outputResult({ ok: true, sourceId, profileName, profiles: saved }, asJson);
        return;
      }
      if (sub === "add-skill" || sub === "remove-skill") {
        const [sourceId, profileName] = parseProfileRef(positionals[2] || flags.ref);
        const skillDirName =
          positionals[3] || (typeof flags.skill === "string" ? flags.skill : "");
        if (!String(skillDirName).trim()) throw new Error("请指定技能目录名");
        const included = sub === "add-skill";
        const saved = updateSourceProfileMember(sourceId, profileName, skillDirName, included);
        outputResult(
          {
            ok: true,
            sourceId,
            profileName,
            skillDirName: String(skillDirName).trim(),
            included,
            profiles: saved,
          },
          asJson,
        );
        return;
      }
      if (sub === "delete") {
        const [sourceId, profileName] = parseProfileRef(positionals[2] || flags.ref);
        const saved = deleteSourceProfile(sourceId, profileName);
        outputResult({ ok: true, sourceId, profileName, profiles: saved }, asJson);
        return;
      }
      throw new Error(`未知 profile 子命令: ${sub}`);
    }

    case "skill": {
      const sub = positionals[1];
      const skillRef = positionals[2] || flags.skill;
      const targetId = typeof flags.target === "string" ? flags.target : null;
      if (!skillRef) throw new Error("请指定技能名称或 <sourceId>:<dirName>");
      if (sub === "enable") {
        const data = toggleSkill({ skillRef, enabled: true, targetId });
        if (flags.sync) data.sync = applySync();
        outputResult(data, asJson);
        return;
      }
      if (sub === "disable") {
        const data = toggleSkill({ skillRef, enabled: false, targetId });
        if (flags.sync) data.sync = applySync();
        outputResult(data, asJson);
        return;
      }
      if (sub === "inherit") {
        if (!targetId) throw new Error("inherit 需要指定 --target <targetId>");
        const data = toggleSkill({ skillRef, enabled: null, targetId });
        if (flags.sync) data.sync = applySync();
        outputResult(data, asJson);
        return;
      }
      throw new Error(`未知 skill 子命令: ${sub}`);
    }

    case "doctor": {
      const out = {};
      if (flags["fix-broken"]) {
        out.cleanedBroken = cleanupBrokenLinks();
      }
      if (flags["fix-hooks"]) {
        const before = runDoctor();
        out.installedHooks = before.missingHooks.map((m) =>
          installSourceHook(m.sourceId, Boolean(flags.force)),
        );
      }
      out.doctor = runDoctor();
      outputResult(out, asJson);
      return;
    }

    case "consolidate": {
      const skills = splitList(flags.skill);
      const data = applyConsolidate({
        dryRun: Boolean(flags["dry-run"]),
        skillNames: skills.length > 0 ? skills : null,
        repairBridges: !flags["no-bridges"],
      });
      outputResult(data, asJson, (d) => {
        const prefix = d.dryRun ? "[Dry Run] " : "";
        console.log(
          `${prefix}整合预览/结果: 迁入 .agents ${d.summary.toMove} 个, 新建软链 ${d.summary.toLink} 条, 修复软链 ${d.summary.toRelink} 条, 跳过冲突 ${d.summary.conflicts} 项`,
        );
        for (const act of d.actions || d.applied || []) {
          console.log(`  - ${act.description}`);
        }
        if (d.skippedConflicts?.length > 0) {
          console.log(`已跳过冲突技能（请先用 resolve-conflict 处理）: ${d.skippedConflicts.join(", ")}`);
        }
      });
      return;
    }

    case "resolve-conflict": {
      const dirName = positionals[1] || flags.skill;
      const keepPath = flags.keep;
      if (!dirName || typeof keepPath !== "string") {
        throw new Error("用法: skill-hub resolve-conflict <dirName> --keep <path>");
      }
      const data = resolveConflict({
        dirName,
        keepPath,
        consolidateToHub: !flags["no-consolidate"],
        repairBridges: !flags["no-bridges"],
      });
      outputResult(data, asJson, (d) => {
        console.log(`已解决 "${d.dirName}" 同名冲突，保留: ${d.keptPath}`);
        for (const t of d.trashed || []) {
          console.log(`  已移入回收站: ${t.from} -> ${t.to}`);
        }
      });
      return;
    }

    case "adopt": {
      const skillPath = positionals[1] || flags.path;
      const targetSourceId = flags.to;
      if (!skillPath || !targetSourceId) {
        throw new Error("用法: skill-hub adopt <skillDirPath> --to <sourceId>");
      }
      const data = adoptSkill({
        skillPath,
        targetSourceId,
        enable: !flags["no-enable"],
      });
      outputResult(data, asJson);
      return;
    }

    case "move": {
      const dirName = positionals[1] || flags.skill;
      const fromSourceId = flags.from;
      const toSourceId = flags.to;
      if (!dirName || !fromSourceId || !toSourceId) {
        throw new Error("用法: skill-hub move <dirName> --from <sourceId> --to <toSourceId>");
      }
      const data = moveSkill({ dirName, fromSourceId, toSourceId });
      outputResult(data, asJson);
      return;
    }

    case "target": {
      const sub = positionals[1];
      if (sub === "list") {
        const config = loadConfig();
        outputResult({ targets: config.targets }, asJson);
        return;
      }
      if (sub === "set") {
        const id = positionals[2] || flags.id;
        if (!id) throw new Error("请指定目标 ID");
        const data = updateTarget({
          id,
          mode: typeof flags.mode === "string" ? flags.mode : undefined,
          path: typeof flags.path === "string" ? flags.path : undefined,
          label: typeof flags.label === "string" ? flags.label : undefined,
        });
        if (flags.sync) data.sync = applySync();
        outputResult(data, asJson);
        return;
      }
      throw new Error(`未知 target 子命令: ${sub}`);
    }

    case "settings": {
      const sub = positionals[1];
      if (sub === "get") {
        outputResult({ config: loadConfig(), guard: loadGuardConfig() }, asJson);
        return;
      }
      if (sub === "set") {
        if (typeof flags.payload !== "string") {
          throw new Error("请提供 --payload '<json>'");
        }
        const parsed = JSON.parse(flags.payload);
        const data = updateSettings(parsed);
        outputResult(data, asJson);
        return;
      }
      throw new Error(`未知 settings 子命令: ${sub}`);
    }

    default:
      throw new Error(`未知命令 "${cmd}"，运行 skill-hub help 查看用法`);
  }
}

main().catch((err) => {
  const asJson = process.argv.includes("--json");
  if (asJson) {
    console.error(
      JSON.stringify({
        ok: false,
        error: err.message || String(err),
        code: err.code || "ERR_SKILL_HUB",
        violations: err.violations || undefined,
      }),
    );
  } else {
    console.error(`错误: ${err.message || err}`);
  }
  process.exit(1);
});
