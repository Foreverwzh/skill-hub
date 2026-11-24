#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { saveRuntimeInfo } from "../src/config.mjs";
import {
  copyDirRecursive,
  createDirLink,
  ensureDir,
  getUserHome,
  removeLink,
  safeLstat,
  safeRealpath,
} from "../src/paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PLUGIN_SRC = path.join(REPO_ROOT, "plugin");
const CLI_PATH = path.join(REPO_ROOT, "bin", "skill-hub.mjs");
const PLUGIN_ID = "ai.smelt.skill-hub";

const args = new Set(process.argv.slice(2));
const copyMode = args.has("--copy-plugin");
const uninstallMode = args.has("--uninstall");

const userHome = getUserHome();
const smeltDir = path.join(userHome, ".smelt");
const smeltPluginsDir = path.join(smeltDir, "plugins");
const pluginDest = path.join(smeltPluginsDir, PLUGIN_ID);

if (uninstallMode) {
  const lst = safeLstat(pluginDest);
  if (lst?.isSymbolicLink()) {
    removeLink(pluginDest);
    console.log(`已移除 Smelt 插件链接: ${pluginDest}`);
  } else if (lst) {
    console.log(`插件目标为实体目录，已保留未删除: ${pluginDest}`);
  } else {
    console.log("未发现已安装的 Smelt 插件链接。");
  }
  process.exit(0);
}

// Make CLI executable on POSIX
if (process.platform !== "win32") {
  try {
    fs.chmodSync(CLI_PATH, 0o755);
  } catch {
    // Ignore permission errors
  }
}

// Persist exact node binary path so GUI apps (Smelt) find node even if managed by mise/nvm/fnm
const resolvedNode = safeRealpath(process.execPath) || process.execPath;
saveRuntimeInfo({
  nodePath: resolvedNode,
  cliPath: CLI_PATH,
});
console.log(`已写入运行环境配置: node=${resolvedNode}, cli=${CLI_PATH}`);

// Link or copy plugin into ~/.smelt/plugins/ai.smelt.skill-hub if ~/.smelt exists
if (safeLstat(smeltDir)) {
  ensureDir(smeltPluginsDir);
  const existing = safeLstat(pluginDest);
  if (existing) {
    if (existing.isSymbolicLink()) {
      const currentReal = safeRealpath(pluginDest);
      const expectedReal = safeRealpath(PLUGIN_SRC);
      if (currentReal === expectedReal && !copyMode) {
        console.log(`Smelt 插件软链已就绪: ${pluginDest} -> ${PLUGIN_SRC}`);
      } else {
        removeLink(pluginDest);
        if (copyMode) {
          copyDirRecursive(PLUGIN_SRC, pluginDest);
          console.log(`已复制 Smelt 插件到: ${pluginDest}`);
        } else {
          createDirLink(PLUGIN_SRC, pluginDest);
          console.log(`已更新 Smelt 插件链接: ${pluginDest} -> ${PLUGIN_SRC}`);
        }
      }
    } else {
      console.warn(`警告: ${pluginDest} 已存在非软链目录，已保留未覆盖。`);
    }
  } else if (copyMode) {
    copyDirRecursive(PLUGIN_SRC, pluginDest);
    console.log(`已复制 Smelt 插件到: ${pluginDest}`);
  } else {
    createDirLink(PLUGIN_SRC, pluginDest);
    console.log(`已挂载 Smelt 插件 (${os.platform()}): ${pluginDest} -> ${PLUGIN_SRC}`);
  }
} else {
  console.log("未检测到 ~/.smelt 目录（无 GUI 或未安装 Smelt），已仅配置 CLI 运行环境。");
}

console.log(`
后续可用方式:
  1. 终端直接使用: node "${CLI_PATH}" status
     （或执行 npm link 后直接使用 skill-hub status）
  2. Smelt 桌面端打开「技能中心」视图或命令面板运行:
     smelt app run ai.smelt.skill-hub/open
`);
