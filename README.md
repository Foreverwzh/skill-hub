# skill-hub

跨平台（macOS / Windows / Linux）多 Agent 技能管理与防泄密同步工具，支持纯 Node.js CLI（无外部依赖）与 **Smelt 桌面端原生插件（`ai.smelt.skill-hub`）**。

## 核心解决的问题

1. **存储与激活解耦**：多个仓库分门别类存放技能，每台设备通过 `~/.skill-hub/config.json` 按需启用分组或单技能，并按需同步到各个 Agent 目录（Antigravity、Claude Code、Codex、Cursor、OpenCode 等）。
2. **公司专用 vs 个人通用严格隔离**：
   - `github`（个人通用源）：可放 GitHub 在多台设备间同步；提交/推送前自动扫描敏感词与密钥正则。
   - `internal`（公司专用源）：只允许公司内网 Git 域名，自动禁止 `github.com` / `gitlab.com` / `gitee.com` 等公网远端并安装 `pre-push` hook；**连 `profiles.json` 也按源分仓存放**，GitHub 仓里绝不会出现公司技能名。
   - `local`（仅本地源）：不建任何 Git 远端，适合个人本地草稿或暂不同步的技能，后续可随时一键升级为 `internal` 公司仓库。
3. **跨端无痛同步（默认 `syncMode: "auto"`）**：
   - macOS / Linux 使用目录 Symlink。
   - Windows 默认使用**受管镜像副本（`copy` 模式，含 `.skill-hub-managed.json` 标记与内容摘要校验）**，确保 Antigravity / Claude Code / Cursor / Codex 等扫描器稳定发现技能，避免 NTFS Directory Junction 被跳过；也可通过设置切换为 `link` 模式（自动维护 Antigravity 的 `~/.gemini/config/skills.json` 清单）。
4. **绝不误删未纳管技能**：清理过期技能时严格校验“是受控软链或带 `skill-hub` 标记的受管副本且指向已注册源/中枢”，绝不触碰本机草稿或第三方安装的实体目录。

## 安装与初始化

```bash
git clone https://github.com/Foreverwzh/skill-hub.git
cd skill-hub

# 1. 写入本机 node/cli 运行时路径，并把 Smelt 插件挂载到 ~/.smelt/plugins/ai.smelt.skill-hub
node scripts/install.mjs

# 2. 可选：将 skill-hub 注册为全局命令
npm link
```

## 常用 CLI 命令（全部支持 `--json`）

```bash
# 查看当前源、技能生效矩阵与体检状态
skill-hub status

# 添加技能源（github / internal / local）
skill-hub source add --id personal --name 个人通用 --path ~/skill-sources/personal --trust github
skill-hub source add --id company  --name 公司专用 --path ~/skill-sources/company  --trust internal --allow-host git.example-corp.com
skill-hub source add --id local-work --name 本地草稿 --path ~/skill-sources/local-work --trust local

# 仅本地源后续升级为公司内网 Git 仓 / 调整源安全级别
skill-hub source convert-internal local-work --remote ssh://git@git.example-corp.com/team/skills.git
skill-hub source set-trust company --trust local

# 分组与单技能开关
skill-hub profile set personal:base --skills skill-creator,git-workflow
skill-hub profile enable personal:base
skill-hub skill enable wechat-minigame-dev
skill-hub skill disable wechat-minigame-dev --target cursor

# 预览并应用本地链接同步
skill-hub sync --dry-run
skill-hub sync

# 拉取远端并同步 / 防泄密检查并推送
skill-hub pull
skill-hub push personal -m "update skills"

# 体检、统一整合到 .agents 中枢与纳管
skill-hub doctor
skill-hub consolidate --dry-run
skill-hub consolidate
skill-hub resolve-conflict jira --keep ~/.agents/skills/jira
skill-hub adopt ~/.agents/skills/my-skill --to personal
skill-hub move my-skill --from local-work --to internal-team
```

## 在 Smelt 桌面端使用

安装后，Smelt 会自动加载 `~/.smelt/plugins/ai.smelt.skill-hub`：
- 命令行验证：`smelt plugin check ~/.smelt/plugins/ai.smelt.skill-hub`
- 打开主界面：`smelt app run ai.smelt.skill-hub/open`
- 设置页：**设置 → 智能体 → 技能中心**（配置敏感词典、禁止公网域名、正则规则与中枢路径）
