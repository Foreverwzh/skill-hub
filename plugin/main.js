import { exists } from "fs/promises";
import { View, div } from "gpui-kit";
import {
  SmeltAlert,
  SmeltBadge,
  SmeltButton,
  SmeltCheckbox,
  SmeltConfirmButton,
  SmeltInputState,
  SmeltMenuButton,
  SmeltRadio,
  SmeltTextInput,
} from "smelt-ui";
import {
  emit_event,
  next_command,
  next_event,
  register_commands,
  register_views,
  reject_command,
  resolve_command,
  run,
  view_shown,
} from "smelt-plugin-api";
import { MODE_LABELS, TRUST_LABELS, runCli } from "./lib/bridge.js";
import { selectableLine } from "./lib/ui.js";

const VIEW_ID = "ai.smelt.skill-hub/main";
const CHANGED_EVENT = "ai.smelt.skill-hub/changed";

function trustBadge(trust) {
  if (trust === "github") return SmeltBadge.new().ok().child(TRUST_LABELS.github);
  if (trust === "internal") return SmeltBadge.new().need().child(TRUST_LABELS.internal);
  if (trust === "local") return SmeltBadge.new().child(TRUST_LABELS.local);
  return SmeltBadge.new().bad().child("未纳管");
}

function sectionBox(c) {
  return div()
    .flex()
    .flex_col()
    .gap(8)
    .p(12)
    .border_1()
    .border_color(c.border)
    .rounded(8)
    .bg(c.surface);
}

function pillButton(id, label, active, onClick) {
  const btn = SmeltButton.new(id).label(label).small().on_click(onClick);
  return active ? btn.secondary() : btn.quiet();
}

function coverageSummary(skill) {
  const parts = [];
  for (const cov of skill.coverage || []) {
    if (cov.status === "linked") parts.push(`${cov.label}:✓`);
    else if (cov.status === "via-hub") parts.push(`${cov.label}:中枢`);
    else if (cov.status === "pending") parts.push(`${cov.label}:待建`);
    else if (cov.status === "pending-remove") parts.push(`${cov.label}:待删`);
    else if (cov.status === "conflict") parts.push(`${cov.label}:冲突`);
  }
  return parts.length > 0 ? parts.join("  ·  ") : "当前未挂载到任何工具";
}

function formatGitSummary(git) {
  if (!git || !git.isGit) return "非 Git 目录";
  const parts = [`分支 ${git.branch || "HEAD"}`];
  if (!git.hasRemote) parts.push("未配置 Remote");
  if (git.ahead > 0) parts.push(`领先 ${git.ahead}`);
  if (git.behind > 0) parts.push(`落后 ${git.behind}`);
  if (git.dirty) parts.push(`${git.changedFiles.length} 个文件未提交`);
  else parts.push("工作区干净");
  return parts.join(" · ");
}

function formatTime(ms) {
  if (!ms || !Number.isFinite(ms)) return "未知时间";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default class SkillHubView extends View {
  init(_props, cx) {
    this.tab = "matrix";
    this.status = null;
    this.loading = true;
    this.busyAction = null;
    this.notice = null;
    this.copiedNotice = false;
    this.filterQuery = "";
    this.filterTrust = "all";
    this.expandedSkill = null;
    this.moveDraft = null;
    this.showAddSource = false;
    this.newSourceTrust = "local";
    this.showNewProfile = false;
    this.newProfileSourceId = "";
    this.newProfileMembers = new Set();
    this.editingProfileRef = null;
    this.editingProfileMembers = new Set();
    this.pushingSourceId = null;
    this.convertingSourceId = null;
    this.editingTrustSourceId = null;
    this.editingTrustValue = "local";
    this.conflictKeep = {};
    this.showAllConsolidate = false;
    this.lastAutoSrcPath = "";

    // All retained input states must be created once in init()
    this.searchInput = SmeltInputState.new("搜索技能名或描述...");
    this.searchInput.on("change", (_ev, cx) => {
      this.filterQuery = this.searchInput.value().trim().toLowerCase();
      cx.notify();
    });

    this.srcIdInput = SmeltInputState.new("源 ID（如 personal / company）");
    this.srcNameInput = SmeltInputState.new("显示名称（如 个人通用 / 公司专用）");
    this.srcPathInput = SmeltInputState.new("本地目录（输入源 ID 自动建议 ~/skill-sources/<id>）");
    this.srcIdInput.on("change", (_ev, cx) => {
      const id = this.srcIdInput.value().trim();
      const curPath = this.srcPathInput.value().trim();
      if (!curPath || curPath === this.lastAutoSrcPath) {
        const nextAuto = id ? `~/skill-sources/${id}` : "";
        this.lastAutoSrcPath = nextAuto;
        this.srcPathInput.set_value(nextAuto);
      }
      cx.notify();
    });
    this.srcNameInput.on("change", (_ev, cx) => {
      cx.notify();
    });
    this.srcCloneInput = SmeltInputState.new("Git Clone URL（可选，local 源留空）");
    this.srcAllowHostsInput = SmeltInputState.new("内网允许域名（可选，逗号分隔）");
    this.commitMsgInput = SmeltInputState.new("提交说明（留空将自动生成）");
    this.convertRemoteInput = SmeltInputState.new("公司内网 Git Remote URL（可选）");
    this.convertAllowInput = SmeltInputState.new("允许的内网域名（可选，逗号分隔）");
    this.newProfileNameInput = SmeltInputState.new("分组名（如 base / work / gamedev）");

    register_views([
      {
        name: "settings",
        title: { en: "Skill Hub", "zh-CN": "技能中心" },
        entry: "settings.js",
        settings: {
          group: "agents",
          keywords: ["skill", "skills", "技能", "同步", "github", "company", "guard"],
        },
      },
    ]);

    register_commands([
      {
        name: "open",
        title: { en: "Open Skill Hub", "zh-CN": "打开技能中心" },
        args: [],
        cli: true,
      },
      {
        name: "sync",
        title: { en: "Sync Skills", "zh-CN": "同步技能链接" },
        args: [],
        cli: true,
      },
      {
        name: "status",
        title: { en: "Skill Hub Status", "zh-CN": "查看技能同步状态" },
        args: [],
        cli: true,
      },
      {
        name: "consolidate",
        title: { en: "Consolidate Skills to .agents", "zh-CN": "整合技能到 .agents 并补齐软链" },
        args: [],
        cli: true,
      },
    ]);

    cx.spawn(async (cx) => {
      await this.refresh(cx, { silent: true });
    });

    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await next_command();
        try {
          if (cmd.name === "open") {
            const ok = await run("smelt.app/open-view", { view: VIEW_ID });
            resolve_command(cmd.id, { opened: ok });
          } else if (cmd.name === "sync") {
            const res = await runCli(["sync"]);
            await this.refresh(cx, { silent: true });
            emit_event(CHANGED_EVENT, { action: "sync" });
            resolve_command(cmd.id, res);
          } else if (cmd.name === "status") {
            const res = await runCli(["status"]);
            this.status = res;
            this.loading = false;
            cx.notify();
            resolve_command(cmd.id, res);
          } else if (cmd.name === "consolidate") {
            const res = await runCli(["consolidate"]);
            await this.refresh(cx, { silent: true });
            emit_event(CHANGED_EVENT, { action: "consolidate" });
            resolve_command(cmd.id, res);
          } else {
            reject_command(cmd.id, `未知命令: ${cmd.name}`);
          }
        } catch (err) {
          reject_command(cmd.id, err?.message || String(err));
        }
      }
    });

    cx.spawn(async (cx) => {
      let wasShown = view_shown(VIEW_ID);
      for (;;) {
        const ev = await next_event();
        if (ev.type === "shown_views_changed") {
          const shownNow = view_shown(VIEW_ID);
          if (shownNow && !wasShown) {
            await this.refresh(cx, { silent: true });
          }
          wasShown = shownNow;
        } else if (ev.type === "plugin" && ev.name === CHANGED_EVENT) {
          await this.refresh(cx, { silent: true });
        }
      }
    });
  }

  async refresh(cx, { silent = false } = {}) {
    if (!silent) {
      this.busyAction = "refresh";
      cx.notify();
    }
    try {
      const data = await runCli(["status"]);
      this.status = data;
      if (!this.newProfileSourceId && data.sources?.length > 0) {
        this.newProfileSourceId = data.sources[0].id;
      }
      if (
        this.editingProfileRef &&
        (data.profiles || []).every((p) => p.ref !== this.editingProfileRef)
      ) {
        this.editingProfileRef = null;
        this.editingProfileMembers = new Set();
      }
    } catch (err) {
      this.copiedNotice = false;
      this.notice = { level: "error", text: err?.message || String(err) };
    } finally {
      this.loading = false;
      if (!silent) this.busyAction = null;
      cx.notify();
    }
  }

  copyText(text, label, cx) {
    cx.write_to_clipboard(String(text || ""));
    this.copiedNotice = false;
    this.notice = { level: "ok", text: `已复制${label}：${text}` };
    cx.notify();
  }

  async runAction(cx, actionKey, fn, successText = null) {
    if (this.busyAction) return;
    this.busyAction = actionKey;
    cx.notify();
    try {
      const res = await fn();
      await this.refresh(cx, { silent: true });
      if (successText) {
        const text = typeof successText === "function" ? successText(res) : successText;
        this.copiedNotice = false;
        this.notice = { level: "ok", text };
      }
    } catch (err) {
      this.copiedNotice = false;
      this.notice = { level: "error", text: err?.message || String(err) };
    } finally {
      this.busyAction = null;
      cx.notify();
    }
  }

  render(cx) {
    const theme = cx.theme();
    const c = theme.colors;
    const status = this.status;
    const pendingCount = status?.pendingSync?.summary?.totalPending || 0;
    const doctorIssues =
      (status?.doctor?.unmanaged?.length || 0) +
      (status?.doctor?.brokenLinks?.length || 0) +
      (status?.doctor?.conflicts?.length || 0) +
      (status?.doctor?.missingHooks?.length || 0) +
      (status?.consolidate?.summary?.totalActions || 0);

    return div()
      .size_full()
      .min_h_0()
      .flex()
      .flex_col()
      .text_color(c.foreground)
      .child(this.renderHeader(c, pendingCount, doctorIssues, cx))
      .when(this.notice, (el) => el.child(this.renderNotice(c)))
      .child(
        div()
          .id("skill-hub-scroll-body")
          .flex_1()
          .min_h_0()
          .overflow_y_scrollbar()
          .p(16)
          .flex()
          .flex_col()
          .gap(12)
          .child(this.renderBody(c, cx)),
      );
  }

  renderHeader(c, pendingCount, doctorIssues, _cx) {
    const syncLabel = pendingCount > 0 ? `应用变更 (${pendingCount})` : "应用变更";
    const syncBtn = SmeltButton.new("btn-apply-sync")
      .label(syncLabel)
      .small()
      .loading(this.busyAction === "sync")
      .disabled(Boolean(this.busyAction))
      .on_click((_ev, cx) => {
        cx.spawn((cx) =>
          this.runAction(
            cx,
            "sync",
            () => runCli(["sync"]),
            (res) =>
              `同步完成：新建 ${res.summary.create}，更新 ${res.summary.replace}，清理 ${res.summary.remove}${res.summary.conflicts ? `，跳过冲突 ${res.summary.conflicts}` : ""}`,
          ),
        );
      });

    return div()
      .flex()
      .flex_row()
      .flex_wrap()
      .items_center()
      .justify_between()
      .gap(8)
      .px(16)
      .py(10)
      .border_b_1()
      .border_color(c.border)
      .child(
        div()
          .flex()
          .flex_row()
          .items_center()
          .gap(6)
          .child(
            pillButton(
              "tab-matrix",
              `技能矩阵 (${this.status?.skills?.length || 0})`,
              this.tab === "matrix",
              (_ev, cx) => {
                this.tab = "matrix";
                cx.notify();
              },
            ),
          )
          .child(
            pillButton(
              "tab-sources",
              `仓库与同步 (${this.status?.sources?.length || 0})`,
              this.tab === "sources",
              (_ev, cx) => {
                this.tab = "sources";
                cx.notify();
              },
            ),
          )
          .child(
            pillButton(
              "tab-doctor",
              doctorIssues > 0 ? `设备与体检 (${doctorIssues})` : "设备与体检",
              this.tab === "doctor",
              (_ev, cx) => {
                this.tab = "doctor";
                cx.notify();
              },
            ),
          ),
      )
      .child(
        div()
          .flex()
          .flex_row()
          .items_center()
          .gap(6)
          .child(
            SmeltButton.new("btn-refresh")
              .label("刷新")
              .quiet()
              .small()
              .loading(this.busyAction === "refresh")
              .disabled(Boolean(this.busyAction))
              .on_click((_ev, cx) => {
                cx.spawn((cx) => this.refresh(cx));
              }),
          )
          .child(
            SmeltButton.new("btn-pull-all")
              .label("拉取并同步")
              .secondary()
              .small()
              .loading(this.busyAction === "pull-all")
              .disabled(Boolean(this.busyAction))
              .on_click((_ev, cx) => {
                cx.spawn((cx) =>
                  this.runAction(
                    cx,
                    "pull-all",
                    () => runCli(["pull"]),
                    (res) => {
                      const pulled = res.results.filter((r) => !r.skipped).length;
                      return `已拉取 ${pulled} 个仓库并完成本地链接同步`;
                    },
                  ),
                );
              }),
          )
          .child(pendingCount > 0 ? syncBtn.primary() : syncBtn.secondary())
          .child(
            SmeltButton.new("btn-open-settings")
              .label("防泄密设置")
              .quiet()
              .small()
              .on_click((_ev, cx) => {
                cx.spawn(async () => {
                  await run("smelt.app/open-view", { view: "ai.smelt.skill-hub/settings" });
                });
              }),
          ),
      );
  }

  renderNotice(c) {
    const isErr = this.notice.level === "error";
    const isNeed = this.notice.level === "need";
    return div()
      .px(16)
      .pt(10)
      .flex()
      .flex_row()
      .items_center()
      .gap(8)
      .child(
        div()
          .flex_1()
          .min_w_0()
          .map((el) => {
            if (isErr) return el.child(SmeltAlert.new("hub-notice", this.notice.text));
            if (isNeed) return el.child(SmeltAlert.new("hub-notice", this.notice.text).need());
            return el.child(
              div()
                .px(10)
                .py(6)
                .rounded(6)
                .border_1()
                .border_color(c.border)
                .bg(c.surface)
                .child(selectableLine("hub-notice-text", this.notice.text, c.foreground)),
            );
          }),
      )
      .child(
        SmeltButton.new("btn-copy-notice")
          .label(this.copiedNotice ? "已复制" : "复制")
          .quiet()
          .small()
          .on_click((_ev, cx) => {
            cx.write_to_clipboard(String(this.notice?.text || ""));
            this.copiedNotice = true;
            cx.notify();
          }),
      )
      .child(
        SmeltButton.new("btn-close-notice")
          .label("关闭")
          .quiet()
          .small()
          .on_click((_ev, cx) => {
            this.notice = null;
            this.copiedNotice = false;
            cx.notify();
          }),
      );
  }

  renderBody(c, cx) {
    if (this.loading && !this.status) {
      return div().p(16).text_sm().text_color(c.muted_foreground).child("正在扫描本机技能与仓库状态...");
    }
    if (!this.status) {
      return div().p(16).text_sm().text_color(c.muted_foreground).child("未能读取技能状态，请点击右上角刷新。");
    }

    if (this.tab === "sources") return this.renderSourcesTab(c, cx);
    if (this.tab === "doctor") return this.renderDoctorTab(c, cx);
    return this.renderMatrixTab(c, cx);
  }

  // ===================== Tab 1: 技能矩阵 =====================
  renderMatrixTab(c, _cx) {
    const status = this.status;
    const sources = status.sources || [];
    const profiles = status.profiles || [];
    const skills = status.skills || [];

    const q = this.filterQuery;
    const trustFilter = this.filterTrust;
    const filtered = skills.filter((s) => {
      if (trustFilter !== "all" && s.trust !== trustFilter) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.dirName.toLowerCase().includes(q) ||
        (s.description || "").toLowerCase().includes(q) ||
        s.sourceName.toLowerCase().includes(q)
      );
    });

    const unmanagedCount = status.doctor?.unmanaged?.length || 0;

    return div()
      .flex()
      .flex_col()
      .gap(12)
      .when(sources.length === 0, (el) =>
        el.child(
          sectionBox(c)
            .child(div().text_sm().font_semibold().child("欢迎使用技能中心"))
            .child(
              div()
                .text_xs()
                .text_color(c.muted_foreground)
                .child("你还没有配置任何技能源。先前往「仓库与同步」添加个人 GitHub 仓、公司内网仓或仅本地目录，再到「设备与体检」将现有技能一键纳管。"),
            )
            .child(
              div()
                .flex()
                .flex_row()
                .gap(8)
                .child(
                  SmeltButton.new("empty-go-sources")
                    .label("去添加技能源")
                    .primary()
                    .small()
                    .on_click((_ev, cx) => {
                      this.tab = "sources";
                      this.showAddSource = true;
                      cx.notify();
                    }),
                )
                .when(unmanagedCount > 0, (b) =>
                  b.child(
                    SmeltButton.new("empty-go-doctor")
                      .label(`查看 ${unmanagedCount} 个未纳管技能`)
                      .secondary()
                      .small()
                      .on_click((_ev, cx) => {
                        this.tab = "doctor";
                        cx.notify();
                      }),
                  ),
                ),
            ),
        ),
      )
      .when(unmanagedCount > 0 && sources.length > 0, (el) =>
        el.child(
          div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(8)
            .px(12)
            .py(8)
            .rounded(8)
            .border_1()
            .border_color(c.border)
            .bg(c.surface)
            .child(
              div()
                .text_xs()
                .text_color(c.muted_foreground)
                .child(`检测到本机仍有 ${unmanagedCount} 个散落/未纳管技能，可按需归入 GitHub 通用源或公司专用源。`),
            )
            .child(
              SmeltButton.new("banner-go-doctor")
                .label("去体检纳管")
                .small()
                .secondary()
                .on_click((_ev, cx) => {
                  this.tab = "doctor";
                  cx.notify();
                }),
            ),
        ),
      )
      // Search & Trust filter bar
      .child(
        div()
          .flex()
          .flex_row()
          .flex_wrap()
          .items_center()
          .gap(8)
          .child(
            div()
              .flex_1()
              .min_w(200)
              .child(
                SmeltTextInput.new(this.searchInput)
                  .aria_label("搜索技能")
                  .small()
                  .cleanable(true),
              ),
          )
          .child(
            div()
              .flex()
              .flex_row()
              .gap(4)
              .child(
                pillButton("f-all", "全部", this.filterTrust === "all", (_ev, cx) => {
                  this.filterTrust = "all";
                  cx.notify();
                }),
              )
              .child(
                pillButton("f-gh", "GitHub", this.filterTrust === "github", (_ev, cx) => {
                  this.filterTrust = "github";
                  cx.notify();
                }),
              )
              .child(
                pillButton("f-int", "公司内网", this.filterTrust === "internal", (_ev, cx) => {
                  this.filterTrust = "internal";
                  cx.notify();
                }),
              )
              .child(
                pillButton("f-loc", "仅本地", this.filterTrust === "local", (_ev, cx) => {
                  this.filterTrust = "local";
                  cx.notify();
                }),
              ),
          ),
      )
      // Profiles section
      .when(sources.length > 0, (el) => el.child(this.renderProfilesCard(c, sources, profiles)))
      // Skills list
      .child(
        sectionBox(c)
          .child(
            div()
              .flex()
              .flex_row()
              .items_center()
              .justify_between()
              .child(
                div()
                  .text_xs()
                  .font_medium()
                  .text_color(c.muted_foreground)
                  .child(`已纳管技能 (${filtered.length} / ${skills.length})`),
              ),
          )
          .when(filtered.length === 0, (box) =>
            box.child(
              div()
                .py(12)
                .text_xs()
                .text_color(c.muted_foreground)
                .child(skills.length === 0 ? "当前源内还没有技能。" : "没有匹配搜索条件的技能。"),
            ),
          )
          .children(filtered.map((skill) => this.renderSkillRow(c, skill, sources, profiles))),
      );
  }

  renderProfileMemberGrid(c, { idPrefix, skills, selectedSet, emptyText }) {
    if (skills.length === 0) {
      return div().text_xs().text_color(c.muted_foreground).child(emptyText);
    }
    return div()
      .flex()
      .flex_row()
      .flex_wrap()
      .gap(8)
      .children(
        skills.map((sk) =>
          SmeltCheckbox.new(`${idPrefix}${sk.dirName}`)
            .label(sk.dirName)
            .checked(selectedSet.has(sk.dirName))
            .on_change((checked, cx) => {
              if (checked) selectedSet.add(sk.dirName);
              else selectedSet.delete(sk.dirName);
              cx.notify();
            }),
        ),
      );
  }

  renderProfilesCard(c, sources, profiles) {
    const selectedSrc =
      sources.find((s) => s.id === this.newProfileSourceId) || sources[0];
    const srcSkills = (this.status?.skills || []).filter(
      (s) => s.sourceId === selectedSrc?.id,
    );
    const editingProfile =
      profiles.find((p) => p.ref === this.editingProfileRef) || null;
    const editSrcSkills = editingProfile
      ? (this.status?.skills || []).filter((s) => s.sourceId === editingProfile.sourceId)
      : [];

    return sectionBox(c)
      .child(
        div()
          .flex()
          .flex_row()
          .items_center()
          .justify_between()
          .child(
            div()
              .text_xs()
              .font_medium()
              .text_color(c.muted_foreground)
              .child("设备分组 Profile（各自存放在所属仓库的 profiles.json 中，互不泄露）"),
          )
          .child(
            SmeltButton.new("btn-toggle-new-profile")
              .label(this.showNewProfile ? "收起" : "新建分组")
              .quiet()
              .small()
              .on_click((_ev, cx) => {
                this.showNewProfile = !this.showNewProfile;
                if (this.showNewProfile) {
                  this.editingProfileRef = null;
                  this.editingProfileMembers = new Set();
                }
                cx.notify();
              }),
          ),
      )
      .when(profiles.length === 0, (el) =>
        el.child(
          div()
            .text_xs()
            .text_color(c.muted_foreground)
            .child("暂无分组，你可以点击「新建分组」把常用技能打包成 base / work / gamedev 等预设。"),
        ),
      )
      .when(profiles.length > 0, (el) =>
        el.child(
          div()
            .flex()
            .flex_row()
            .flex_wrap()
            .gap(10)
            .children(
              profiles.map((p) => {
                const isEditing = this.editingProfileRef === p.ref;
                return div()
                  .flex()
                  .flex_row()
                  .items_center()
                  .gap(6)
                  .px(8)
                  .py(4)
                  .rounded(6)
                  .border_1()
                  .border_color(c.border)
                  .bg(isEditing ? c.background : c.surface)
                  .child(
                    SmeltCheckbox.new(`prof-${p.ref}`)
                      .label(`${p.ref} (${p.skills.length})`)
                      .checked(p.enabled)
                      .on_change((checked, cx) => {
                        cx.spawn((cx) =>
                          this.runAction(cx, `prof:${p.ref}`, () =>
                            runCli([
                              "profile",
                              checked ? "enable" : "disable",
                              p.ref,
                            ]),
                          ),
                        );
                      }),
                  )
                  .child(trustBadge(p.trust))
                  .child(
                    SmeltButton.new(`btn-edit-prof-${p.ref}`)
                      .label(isEditing ? "收起" : "编辑")
                      .quiet()
                      .small()
                      .disabled(Boolean(this.busyAction))
                      .on_click((_ev, cx) => {
                        if (isEditing) {
                          this.editingProfileRef = null;
                          this.editingProfileMembers = new Set();
                        } else {
                          this.showNewProfile = false;
                          this.editingProfileRef = p.ref;
                          this.editingProfileMembers = new Set(p.skills || []);
                        }
                        cx.notify();
                      }),
                  )
                  .child(
                    SmeltConfirmButton.new(`btn-del-prof-${p.ref}`)
                      .label("删除")
                      .danger_quiet()
                      .small()
                      .title(`确认删除分组「${p.ref}」？`)
                      .description("仅删除该分组定义并取消本机启用状态，不会删除任何技能文件。")
                      .action("确认删除")
                      .on_confirm((cx) => {
                        cx.spawn((cx) =>
                          this.runAction(
                            cx,
                            `del-prof:${p.ref}`,
                            async () => {
                              const res = await runCli(["profile", "delete", p.ref]);
                              if (this.editingProfileRef === p.ref) {
                                this.editingProfileRef = null;
                                this.editingProfileMembers = new Set();
                              }
                              return res;
                            },
                            `已删除分组 ${p.ref}`,
                          ),
                        );
                      }),
                  );
              }),
            ),
        ),
      )
      .when(editingProfile, (el) =>
        el.child(
          div()
            .flex()
            .flex_col()
            .gap(8)
            .pt(8)
            .border_t_1()
            .border_color(c.border)
            .child(
              div()
                .flex()
                .flex_row()
                .flex_wrap()
                .items_center()
                .justify_between()
                .gap(8)
                .child(
                  div()
                    .text_xs()
                    .text_color(c.muted_foreground)
                    .child(
                      `编辑分组 ${editingProfile.ref} 成员（已选 ${this.editingProfileMembers.size} / ${editSrcSkills.length}，仅限「${editingProfile.sourceName}」源内技能）`,
                    ),
                )
                .child(
                  div()
                    .flex()
                    .flex_row()
                    .flex_wrap()
                    .items_center()
                    .gap(6)
                    .child(
                      SmeltButton.new("btn-edit-prof-all")
                        .label("全选")
                        .quiet()
                        .small()
                        .on_click((_ev, cx) => {
                          this.editingProfileMembers = new Set(
                            editSrcSkills.map((sk) => sk.dirName),
                          );
                          cx.notify();
                        }),
                    )
                    .child(
                      SmeltButton.new("btn-edit-prof-none")
                        .label("清空")
                        .quiet()
                        .small()
                        .on_click((_ev, cx) => {
                          this.editingProfileMembers = new Set();
                          cx.notify();
                        }),
                    )
                    .child(
                      SmeltButton.new("btn-save-edit-prof")
                        .label("保存成员")
                        .primary()
                        .small()
                        .loading(this.busyAction === "save-edit-profile")
                        .disabled(Boolean(this.busyAction))
                        .on_click((_ev, cx) => {
                          const targetRef = editingProfile.ref;
                          const members = [...this.editingProfileMembers];
                          const skillsCsv = members.join(",");
                          cx.spawn((cx) =>
                            this.runAction(
                              cx,
                              "save-edit-profile",
                              async () => {
                                await runCli([
                                  "profile",
                                  "set",
                                  targetRef,
                                  `--skills=${skillsCsv}`,
                                ]);
                                this.editingProfileRef = null;
                                this.editingProfileMembers = new Set();
                              },
                              `已更新分组 ${targetRef}（${members.length} 个技能）`,
                            ),
                          );
                        }),
                    )
                    .child(
                      SmeltButton.new("btn-cancel-edit-prof")
                        .label("取消")
                        .quiet()
                        .small()
                        .on_click((_ev, cx) => {
                          this.editingProfileRef = null;
                          this.editingProfileMembers = new Set();
                          cx.notify();
                        }),
                    ),
                ),
            )
            .child(
              this.renderProfileMemberGrid(c, {
                idPrefix: `ep-m-${editingProfile.ref}-`,
                skills: editSrcSkills,
                selectedSet: this.editingProfileMembers,
                emptyText: "该源下暂无已纳管技能，请先到「设备与体检」纳管技能。",
              }),
            ),
        ),
      )
      .when(this.showNewProfile && selectedSrc, (el) =>
        el.child(
          div()
            .flex()
            .flex_col()
            .gap(8)
            .pt(8)
            .border_t_1()
            .border_color(c.border)
            .child(
              div()
                .flex()
                .flex_row()
                .flex_wrap()
                .items_center()
                .gap(8)
                .child(div().text_xs().text_color(c.muted_foreground).child("所属源："))
                .children(
                  sources.map((s) =>
                    SmeltRadio.new(`new-prof-src-${s.id}`)
                      .label(`${s.name} (${s.trust})`)
                      .checked(selectedSrc.id === s.id)
                      .on_select((cx) => {
                        this.newProfileSourceId = s.id;
                        this.newProfileMembers = new Set();
                        cx.notify();
                      }),
                  ),
                ),
            )
            .child(
              div()
                .flex()
                .flex_row()
                .items_center()
                .gap(8)
                .child(
                  div()
                    .w(240)
                    .child(
                      SmeltTextInput.new(this.newProfileNameInput)
                        .aria_label("新分组名")
                        .small(),
                    ),
                )
                .child(
                  SmeltButton.new("btn-save-new-profile")
                    .label("保存分组")
                    .primary()
                    .small()
                    .disabled(Boolean(this.busyAction))
                    .on_click((_ev, cx) => {
                      const pName = this.newProfileNameInput.value().trim();
                      if (!pName) {
                        this.notice = { level: "error", text: "请输入分组名称" };
                        cx.notify();
                        return;
                      }
                      const skillsCsv = [...this.newProfileMembers].join(",");
                      cx.spawn((cx) =>
                        this.runAction(
                          cx,
                          "save-profile",
                          async () => {
                            await runCli([
                              "profile",
                              "set",
                              `${selectedSrc.id}:${pName}`,
                              `--skills=${skillsCsv}`,
                            ]);
                            this.newProfileNameInput.set_value("");
                            this.newProfileMembers = new Set();
                            this.showNewProfile = false;
                          },
                          `已保存分组 ${selectedSrc.id}:${pName}`,
                        ),
                      );
                    }),
                ),
            )
            .child(
              div()
                .flex()
                .flex_row()
                .flex_wrap()
                .items_center()
                .justify_between()
                .gap(8)
                .child(
                  div()
                    .text_xs()
                    .text_color(c.muted_foreground)
                    .child(
                      `选择「${selectedSrc.name}」源内技能（已选 ${this.newProfileMembers.size} / ${srcSkills.length}）：`,
                    ),
                )
                .child(
                  div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(6)
                    .child(
                      SmeltButton.new("btn-new-prof-all")
                        .label("全选")
                        .quiet()
                        .small()
                        .on_click((_ev, cx) => {
                          this.newProfileMembers = new Set(
                            srcSkills.map((sk) => sk.dirName),
                          );
                          cx.notify();
                        }),
                    )
                    .child(
                      SmeltButton.new("btn-new-prof-none")
                        .label("清空")
                        .quiet()
                        .small()
                        .on_click((_ev, cx) => {
                          this.newProfileMembers = new Set();
                          cx.notify();
                        }),
                    ),
                ),
            )
            .child(
              this.renderProfileMemberGrid(c, {
                idPrefix: `np-m-${selectedSrc.id}:`,
                skills: srcSkills,
                selectedSet: this.newProfileMembers,
                emptyText: "该源下暂无已纳管技能，请先到「设备与体检」纳管技能。",
              }),
            ),
        ),
      );
  }

  renderSkillRow(c, skill, sources, profiles) {
    const isExpanded = this.expandedSkill === skill.ref;
    const linkTargets = (this.status?.targets || []).filter((t) => t.mode === "link");
    const otherSources = sources.filter((s) => s.id !== skill.sourceId);

    let overrideTag = null;
    if (skill.explicitlyIncluded && !skill.fromEnabledProfile) overrideTag = "本机单独启用";
    else if (skill.explicitlyExcluded) overrideTag = "本机已排除";
    else if (skill.fromEnabledProfile) overrideTag = "来自启用的分组";

    const menu = SmeltMenuButton.new(`menu-${skill.ref}`)
      .label("操作")
      .quiet()
      .small()
      .item("编辑 SKILL.md", (cx) => {
        cx.spawn(async () => {
          await run("smelt.app/open-in-text-editor", { path: skill.skillMdPath });
        });
      })
      .item("打开目录", (cx) => {
        cx.spawn(async () => {
          await run("smelt.app/open-in-file-manager", { path: skill.dir });
        });
      })
      .item(isExpanded ? "收起详情" : "展开详情与工具覆盖", (cx) => {
        this.expandedSkill = isExpanded ? null : skill.ref;
        this.moveDraft = null;
        cx.notify();
      });

    return div()
      .flex()
      .flex_col()
      .gap(6)
      .py(8)
      .px(8)
      .rounded(6)
      .border_1()
      .border_color(c.border)
      .child(
        div()
          .flex()
          .flex_row()
          .items_center()
          .gap(8)
          .child(
            SmeltCheckbox.new(`chk-skill-${skill.ref}`)
              .label(skill.name)
              .checked(skill.enabled)
              .on_change((checked, cx) => {
                cx.spawn((cx) =>
                  this.runAction(cx, `toggle:${skill.ref}`, () =>
                    runCli(["skill", checked ? "enable" : "disable", skill.ref]),
                  ),
                );
              }),
          )
          .child(trustBadge(skill.trust))
          .child(SmeltBadge.new().child(skill.sourceName))
          .children(
            (skill.profiles || []).map((pRef) =>
              SmeltBadge.new().child(
                `分组:${pRef.includes(":") ? pRef.split(":").slice(1).join(":") : pRef}`,
              ),
            ),
          )
          .when(overrideTag, (el) =>
            el.child(div().text_xs().text_color(c.muted_foreground).child(overrideTag)),
          )
          .child(div().flex_1())
          .child(
            SmeltButton.new(`expand-${skill.ref}`)
              .label(isExpanded ? "收起" : "详情")
              .quiet()
              .small()
              .on_click((_ev, cx) => {
                this.expandedSkill = isExpanded ? null : skill.ref;
                this.moveDraft = null;
                cx.notify();
              }),
          )
          .child(menu),
      )
      .when(skill.description, (el) =>
        el.child(
          div()
            .px(24)
            .text_xs()
            .text_color(c.muted_foreground)
            .truncate()
            .child(skill.description),
        ),
      )
      .child(
        div()
          .px(24)
          .text_xs()
          .text_color(c.muted_foreground)
          .child(coverageSummary(skill)),
      )
      .when(isExpanded, (el) =>
        el.child(this.renderSkillExpanded(c, skill, linkTargets, otherSources, profiles)),
      );
  }

  renderSkillExpanded(c, skill, linkTargets, otherSources, profiles) {
    const sourceProfiles = (profiles || []).filter((p) => p.sourceId === skill.sourceId);
    const activeDraft =
      this.moveDraft && this.moveDraft.dirName === skill.dirName ? this.moveDraft : null;
    const dstSource = activeDraft
      ? otherSources.find((s) => s.id === activeDraft.toSourceId)
      : null;

    return div()
      .mx(24)
      .mt(4)
      .p(10)
      .rounded(6)
      .border_1()
      .border_color(c.border)
      .bg(c.background)
      .flex()
      .flex_col()
      .gap(8)
      .child(
        div()
          .flex()
          .flex_row()
          .items_center()
          .justify_between()
          .gap(8)
          .child(
            div()
              .flex_1()
              .min_w_0()
              .child(
                selectableLine(
                  `skill-dir-${skill.ref}`,
                  `目录路径: ${skill.dir}`,
                  c.muted_foreground,
                ),
              ),
          )
          .child(
            SmeltButton.new(`copy-skill-dir-${skill.ref}`)
              .label("复制路径")
              .quiet()
              .small()
              .on_click((_ev, cx) => {
                this.copyText(skill.dir, "技能路径", cx);
              }),
          ),
      )
      .child(
        div()
          .flex()
          .flex_row()
          .flex_wrap()
          .items_center()
          .gap(8)
          .child(div().text_xs().text_color(c.muted_foreground).child("所属分组:"))
          .when(sourceProfiles.length === 0, (row) =>
            row
              .child(
                div()
                  .text_xs()
                  .text_color(c.muted_foreground)
                  .child(`「${skill.sourceName}」源下暂无分组`),
              )
              .child(
                SmeltButton.new(`btn-new-prof-from-${skill.ref}`)
                  .label("去新建分组")
                  .quiet()
                  .small()
                  .on_click((_ev, cx) => {
                    this.newProfileSourceId = skill.sourceId;
                    this.newProfileMembers = new Set([skill.dirName]);
                    this.editingProfileRef = null;
                    this.editingProfileMembers = new Set();
                    this.showNewProfile = true;
                    cx.notify();
                  }),
              ),
          )
          .when(sourceProfiles.length > 0, (row) =>
            row.children(
              sourceProfiles.map((p) =>
                SmeltCheckbox.new(`sk-prof-${skill.ref}-${p.name}`)
                  .label(p.enabled ? `${p.name} (已启用)` : p.name)
                  .checked((skill.profiles || []).includes(p.ref))
                  .on_change((checked, cx) => {
                    cx.spawn((cx) =>
                      this.runAction(
                        cx,
                        `sk-prof:${skill.ref}:${p.ref}`,
                        async () => {
                          const res = await runCli([
                            "profile",
                            checked ? "add-skill" : "remove-skill",
                            p.ref,
                            skill.dirName,
                          ]);
                          if (this.editingProfileRef === p.ref) {
                            if (checked) this.editingProfileMembers.add(skill.dirName);
                            else this.editingProfileMembers.delete(skill.dirName);
                          }
                          return res;
                        },
                        checked
                          ? `已将 ${skill.dirName} 加入分组 ${p.ref}`
                          : `已将 ${skill.dirName} 移出分组 ${p.ref}`,
                      ),
                    );
                  }),
              ),
            ),
          ),
      )
      .when(linkTargets.length > 0, (el) =>
        el.child(
          div()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap(10)
            .child(div().text_xs().text_color(c.muted_foreground).child("单工具覆盖:"))
            .children(
              linkTargets.map((t) => {
                const state = skill.perTarget?.[t.id] || {
                  effective: skill.enabled,
                  override: "inherit",
                };
                const labelText =
                  state.override === "inherit"
                    ? t.label
                    : `${t.label}(${state.override === "include" ? "强开" : "强关"})`;
                return SmeltCheckbox.new(`ov-${skill.ref}-${t.id}`)
                  .label(labelText)
                  .checked(state.effective)
                  .on_change((checked, cx) => {
                    cx.spawn((cx) =>
                      this.runAction(cx, `ov:${skill.ref}:${t.id}`, () =>
                        runCli([
                          "skill",
                          checked ? "enable" : "disable",
                          skill.ref,
                          "--target",
                          t.id,
                        ]),
                      ),
                    );
                  });
              }),
            ),
        ),
      )
      .when(otherSources.length > 0, (el) =>
        el.child(
          div()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap(8)
            .child(div().text_xs().text_color(c.muted_foreground).child("跨源迁移:"))
            .children(
              otherSources.map((dst) =>
                SmeltRadio.new(`mv-dst-${skill.ref}-${dst.id}`)
                  .label(`${dst.name} (${dst.trust})`)
                  .checked(activeDraft?.toSourceId === dst.id)
                  .on_select((cx) => {
                    this.moveDraft = {
                      dirName: skill.dirName,
                      fromSourceId: skill.sourceId,
                      toSourceId: dst.id,
                    };
                    cx.notify();
                  }),
              ),
            )
            .when(dstSource, (box) =>
              box.child(
                SmeltConfirmButton.new(`btn-confirm-move-${skill.ref}`)
                  .label(`迁移到 ${dstSource.name}`)
                  .small()
                  .danger()
                  .title(`确认将「${skill.dirName}」迁移到 ${dstSource.name}？`)
                  .description(
                    dstSource.trust === "github"
                      ? "目标源是 GitHub 源，系统会先执行敏感词与密钥扫描；若命中安全规则将自动拦截。迁移后本地所有链接会自动重指。"
                      : "会把技能文件夹从原仓库移至目标仓库，并自动更新所有本地链接。",
                  )
                  .action("确认迁移")
                  .on_confirm((cx) => {
                    const draft = this.moveDraft;
                    cx.spawn((cx) =>
                      this.runAction(
                        cx,
                        `move:${draft.dirName}`,
                        async () => {
                          const res = await runCli([
                            "move",
                            draft.dirName,
                            "--from",
                            draft.fromSourceId,
                            "--to",
                            draft.toSourceId,
                          ]);
                          this.moveDraft = null;
                          this.expandedSkill = `${draft.toSourceId}:${draft.dirName}`;
                          return res;
                        },
                        `已将 ${draft.dirName} 迁移至 ${dstSource.name}`,
                      ),
                    );
                  }),
              ),
            ),
        ),
      );
  }

  // ===================== Tab 2: 仓库与同步 =====================
  renderSourcesTab(c, _cx) {
    const sources = this.status?.sources || [];

    return div()
      .flex()
      .flex_col()
      .gap(12)
      .child(
        div()
          .flex()
          .flex_row()
          .items_center()
          .justify_between()
          .child(
            div()
              .text_xs()
              .text_color(c.muted_foreground)
              .child("将「个人 GitHub 仓」、「公司内网 Git 仓」与「仅本地源」物理隔离管理"),
          )
          .child(
            SmeltButton.new("btn-toggle-add-source")
              .label(this.showAddSource ? "收起表单" : "+ 添加 / 创建技能源")
              .primary()
              .small()
              .on_click((_ev, cx) => {
                this.showAddSource = !this.showAddSource;
                cx.notify();
              }),
          ),
      )
      .when(this.showAddSource, (el) => el.child(this.renderAddSourceForm(c)))
      .when(sources.length === 0 && !this.showAddSource, (el) =>
        el.child(
          sectionBox(c).child(
            div()
              .text_xs()
              .text_color(c.muted_foreground)
              .child("暂无技能源。点击右上角「+ 添加 / 创建技能源」开始配置。"),
          ),
        ),
      )
      .children(sources.map((s) => this.renderSourceCard(c, s)));
  }

  renderAddSourceForm(c) {
    const draftLabel = `${this.srcIdInput.value().trim()} ${this.srcNameInput.value().trim()}`;
    const looksCompanyOnGithub =
      this.newSourceTrust === "github" &&
      /(company|corp|work|internal|office|公司|内网)/i.test(draftLabel);

    return sectionBox(c)
      .child(div().text_sm().font_semibold().child("添加 / 初始化技能源"))
      .child(
        div()
          .flex()
          .flex_row()
          .flex_wrap()
          .items_center()
          .gap(10)
          .child(div().text_xs().text_color(c.muted_foreground).child("安全级别:"))
          .child(
            SmeltRadio.new("add-trust-github")
              .label("个人 GitHub 仓 (github)")
              .checked(this.newSourceTrust === "github")
              .on_select((cx) => {
                this.newSourceTrust = "github";
                cx.notify();
              }),
          )
          .child(
            SmeltRadio.new("add-trust-internal")
              .label("公司内网 Git 仓 (internal)")
              .checked(this.newSourceTrust === "internal")
              .on_select((cx) => {
                this.newSourceTrust = "internal";
                cx.notify();
              }),
          )
          .child(
            SmeltRadio.new("add-trust-local")
              .label("仅本地目录 (local)")
              .checked(this.newSourceTrust === "local")
              .on_select((cx) => {
                this.newSourceTrust = "local";
                cx.notify();
              }),
          ),
      )
      .when(looksCompanyOnGithub, (el) =>
        el.child(
          SmeltAlert.new(
            "warn-company-github",
            "提示：源 ID 或名称包含公司/内网关键字，但当前选中的是「个人 GitHub 仓」。如果这是公司专用技能，请改选「公司内网 Git 仓」或「仅本地目录」。",
          ).need(),
        ),
      )
      .child(
        div()
          .flex()
          .flex_row()
          .gap(8)
          .child(
            div()
              .flex_1()
              .child(SmeltTextInput.new(this.srcIdInput).aria_label("源 ID").small()),
          )
          .child(
            div()
              .flex_1()
              .child(SmeltTextInput.new(this.srcNameInput).aria_label("显示名称").small()),
          ),
      )
      .child(
        div()
          .flex()
          .flex_row()
          .items_center()
          .gap(8)
          .child(
            div()
              .flex_1()
              .child(SmeltTextInput.new(this.srcPathInput).aria_label("本地路径").small()),
          )
          .child(
            SmeltButton.new("btn-pick-source-dir")
              .label("选择目录...")
              .secondary()
              .small()
              .on_click((_ev, cx) => {
                cx.spawn(async (cx) => {
                  const picked = await run("smelt.app/pick-paths", {
                    machine: null,
                    title: "选择或新建技能源目录",
                    confirm: "选择",
                    files: false,
                    multiple: false,
                  });
                  if (Array.isArray(picked) && picked[0]) {
                    this.lastAutoSrcPath = "";
                    this.srcPathInput.set_value(picked[0]);
                    cx.notify();
                  }
                });
              }),
          ),
      )
      .when(this.newSourceTrust !== "local", (el) =>
        el.child(
          SmeltTextInput.new(this.srcCloneInput).aria_label("Git Clone URL").small(),
        ),
      )
      .when(this.newSourceTrust === "internal", (el) =>
        el.child(
          SmeltTextInput.new(this.srcAllowHostsInput)
            .aria_label("内网域名白名单")
            .small(),
        ),
      )
      .child(
        div()
          .flex()
          .flex_row()
          .items_center()
          .justify_between()
          .child(
            div()
              .text_xs()
              .text_color(c.muted_foreground)
              .child(
                this.newSourceTrust === "internal"
                  ? "内网源会自动禁止绑定 github.com / gitlab.com / gitee.com 等公网域名，并自动安装 pre-push 拦截钩子。"
                  : this.newSourceTrust === "github"
                    ? "GitHub 源在提交与推送前会自动扫描敏感词/密钥正则。"
                    : "仅本地目录不初始化任何 Git 远端，后续可随时一键升级为公司内网 Git 仓。",
              ),
          )
          .child(
            SmeltButton.new("btn-submit-add-source")
              .label(`保存并添加（${TRUST_LABELS[this.newSourceTrust]}）`)
              .primary()
              .small()
              .loading(this.busyAction === "add-source")
              .disabled(Boolean(this.busyAction))
              .on_click((_ev, cx) => {
                const id = this.srcIdInput.value().trim();
                const name = this.srcNameInput.value().trim() || id;
                const dirPath = this.srcPathInput.value().trim();
                const cloneUrl = this.srcCloneInput.value().trim();
                const allowHosts = this.srcAllowHostsInput.value().trim();

                if (!id || !dirPath) {
                  this.notice = { level: "error", text: "源 ID 和本地路径不能为空" };
                  cx.notify();
                  return;
                }

                const args = ["source", "add", "--id", id, "--name", name, "--path", dirPath, "--trust", this.newSourceTrust];
                if (cloneUrl && this.newSourceTrust !== "local") {
                  args.push("--clone", cloneUrl);
                }
                if (allowHosts && this.newSourceTrust === "internal") {
                  args.push("--allow-host", allowHosts);
                }

                cx.spawn((cx) =>
                  this.runAction(
                    cx,
                    "add-source",
                    async () => {
                      const res = await runCli(args);
                      this.lastAutoSrcPath = "";
                      this.srcIdInput.set_value("");
                      this.srcNameInput.set_value("");
                      this.srcPathInput.set_value("");
                      this.srcCloneInput.set_value("");
                      this.srcAllowHostsInput.set_value("");
                      this.newSourceTrust = "local";
                      this.showAddSource = false;
                      return res;
                    },
                    `已添加技能源「${name}」`,
                  ),
                );
              }),
          ),
      );
  }

  renderSourceCard(c, source) {
    const git = source.git || {};
    const isPushing = this.pushingSourceId === source.id;
    const isConverting = this.convertingSourceId === source.id;
    const isEditingTrust = this.editingTrustSourceId === source.id;

    return sectionBox(c)
      .child(
        div()
          .flex()
          .flex_row()
          .flex_wrap()
          .items_center()
          .justify_between()
          .gap(8)
          .child(
            div()
              .flex()
              .flex_row()
              .items_center()
              .gap(8)
              .child(div().text_sm().font_semibold().child(source.name))
              .child(trustBadge(source.trust))
              .child(SmeltBadge.new().child(`技能 ${source.skillsCount}`))
              .when(git.isGit && source.trust !== "local", (el) =>
                el.child(
                  git.hasHook
                    ? SmeltBadge.new().ok().child("防泄密 Hook 已就绪")
                    : SmeltBadge.new().need().child("缺少 Hook"),
                ),
              ),
          )
          .child(
            div()
              .flex()
              .flex_row()
              .flex_wrap()
              .gap(6)
              .child(
                SmeltButton.new(`src-open-${source.id}`)
                  .label("打开目录")
                  .quiet()
                  .small()
                  .on_click((_ev, cx) => {
                    cx.spawn(async () => {
                      await run("smelt.app/open-in-file-manager", { path: source.absPath });
                    });
                  }),
              )
              .when(git.isGit && source.trust !== "local", (el) =>
                el
                  .child(
                    SmeltButton.new(`src-guard-${source.id}`)
                      .label("安全自检")
                      .quiet()
                      .small()
                      .loading(this.busyAction === `guard:${source.id}`)
                      .disabled(Boolean(this.busyAction))
                      .on_click((_ev, cx) => {
                        cx.spawn((cx) =>
                          this.runAction(
                            cx,
                            `guard:${source.id}`,
                            async () => {
                              const res = await runCli(["guard", "--source", source.id]);
                              return res;
                            },
                            `源「${source.name}」安全守卫自检通过`,
                          ),
                        );
                      }),
                  )
                  .child(
                    SmeltButton.new(`src-pull-${source.id}`)
                      .label("拉取")
                      .secondary()
                      .small()
                      .loading(this.busyAction === `pull:${source.id}`)
                      .disabled(Boolean(this.busyAction))
                      .on_click((_ev, cx) => {
                        cx.spawn((cx) =>
                          this.runAction(
                            cx,
                            `pull:${source.id}`,
                            () => runCli(["pull", "--source", source.id]),
                            (res) => res.results?.[0]?.reason || `已拉取「${source.name}」并刷新链接`,
                          ),
                        );
                      }),
                  )
                  .child(
                    SmeltButton.new(`src-push-toggle-${source.id}`)
                      .label(isPushing ? "收起提交" : "提交并推送")
                      .primary()
                      .small()
                      .on_click((_ev, cx) => {
                        this.pushingSourceId = isPushing ? null : source.id;
                        cx.notify();
                      }),
                  ),
              )
              .when(git.isGit && !git.hasHook && source.trust !== "local", (el) =>
                el.child(
                  SmeltButton.new(`src-hook-${source.id}`)
                    .label("安装 Hook")
                    .secondary()
                    .small()
                    .on_click((_ev, cx) => {
                      cx.spawn((cx) =>
                        this.runAction(
                          cx,
                          `hook:${source.id}`,
                          () => runCli(["source", "install-hook", source.id]),
                          `已为「${source.name}」安装 pre-push 防泄密钩子`,
                        ),
                      );
                    }),
                ),
              )
              .when(source.trust === "local", (el) =>
                el.child(
                  SmeltButton.new(`src-conv-toggle-${source.id}`)
                    .label(isConverting ? "取消升级" : "转为公司内网 Git 仓")
                    .secondary()
                    .small()
                    .on_click((_ev, cx) => {
                      this.convertingSourceId = isConverting ? null : source.id;
                      cx.notify();
                    }),
                ),
              )
              .child(
                SmeltButton.new(`src-trust-toggle-${source.id}`)
                  .label(isEditingTrust ? "取消改级别" : "改安全级别")
                  .quiet()
                  .small()
                  .on_click((_ev, cx) => {
                    if (isEditingTrust) {
                      this.editingTrustSourceId = null;
                    } else {
                      this.editingTrustSourceId = source.id;
                      this.editingTrustValue = source.trust;
                    }
                    cx.notify();
                  }),
              )
              .child(
                SmeltConfirmButton.new(`src-rm-${source.id}`)
                  .label("移除")
                  .danger_quiet()
                  .small()
                  .title(`确认移除技能源「${source.name}」？`)
                  .description("仅从本机 skill-hub 配置中移除引用并清理失效链接，不会删除磁盘上的任何仓库文件。")
                  .action("移除源")
                  .on_confirm((cx) => {
                    cx.spawn((cx) =>
                      this.runAction(
                        cx,
                        `rm:${source.id}`,
                        () => runCli(["source", "remove", source.id]),
                        `已移除技能源「${source.name}」（磁盘文件已保留）`,
                      ),
                    );
                  }),
              ),
          ),
      )
      .child(
        div()
          .flex()
          .flex_row()
          .items_center()
          .justify_between()
          .gap(8)
          .child(
            div()
              .flex_1()
              .min_w_0()
              .child(
                selectableLine(
                  `src-meta-${source.id}`,
                  `ID: ${source.id} · 路径: ${source.path} · 技能子目录: ${source.skillsRelDir}`,
                  c.muted_foreground,
                ),
              ),
          )
          .child(
            SmeltButton.new(`src-copy-path-${source.id}`)
              .label("复制路径")
              .quiet()
              .small()
              .on_click((_ev, cx) => {
                this.copyText(source.absPath, "源路径", cx);
              }),
          ),
      )
      .child(selectableLine(`src-git-${source.id}`, formatGitSummary(git), c.muted_foreground))
      .when(git.remotes && git.remotes.length > 0, (el) =>
        el.child(
          div()
            .flex()
            .flex_col()
            .gap(4)
            .children(
              git.remotes.map((r, idx) =>
                div()
                  .flex()
                  .flex_row()
                  .items_center()
                  .justify_between()
                  .gap(8)
                  .child(
                    div()
                      .flex_1()
                      .min_w_0()
                      .child(
                        selectableLine(
                          `src-remote-${source.id}-${idx}`,
                          `Remote (${r.name}): ${r.url}`,
                          c.muted_foreground,
                        ),
                      ),
                  )
                  .child(
                    SmeltButton.new(`src-copy-remote-${source.id}-${idx}`)
                      .label("复制地址")
                      .quiet()
                      .small()
                      .on_click((_ev, cx) => {
                        this.copyText(r.url, " Remote 地址", cx);
                      }),
                  ),
              ),
            ),
        ),
      )
      .when(git.dirty && git.changedSkills?.length > 0, (el) =>
        el.child(
          selectableLine(
            `src-dirty-${source.id}`,
            `待提交技能改动: ${git.changedSkills.join(", ")}`,
            c.muted_foreground,
          ),
        ),
      )
      .when(isEditingTrust, (el) =>
        el.child(
          div()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap(10)
            .pt(6)
            .border_t_1()
            .border_color(c.border)
            .child(div().text_xs().text_color(c.muted_foreground).child("调整安全级别:"))
            .children(
              ["local", "internal", "github"].map((t) =>
                SmeltRadio.new(`src-edit-trust-${source.id}-${t}`)
                  .label(TRUST_LABELS[t])
                  .checked(this.editingTrustValue === t)
                  .on_select((cx) => {
                    this.editingTrustValue = t;
                    cx.notify();
                  }),
              ),
            )
            .child(
              SmeltConfirmButton.new(`src-edit-trust-save-${source.id}`)
                .label(`确认改为「${TRUST_LABELS[this.editingTrustValue]}」`)
                .primary()
                .small()
                .disabled(Boolean(this.busyAction) || this.editingTrustValue === source.trust)
                .title(`将「${source.name}」的安全级别改为「${TRUST_LABELS[this.editingTrustValue]}」？`)
                .description(
                  this.editingTrustValue === "github"
                    ? "系统会先全量扫描目录敏感词/密钥规则；若命中将阻止切换。"
                    : this.editingTrustValue === "internal"
                      ? "会校验远端不含公网 Git 域名，并自动安装 pre-push 防泄密钩子。"
                      : "仅在未绑定 Git 远端时可切换为仅本地目录。",
                )
                .action("确认切换")
                .on_confirm((cx) => {
                  const targetTrust = this.editingTrustValue;
                  cx.spawn((cx) =>
                    this.runAction(
                      cx,
                      `set-trust:${source.id}`,
                      async () => {
                        const res = await runCli([
                          "source",
                          "set-trust",
                          source.id,
                          "--trust",
                          targetTrust,
                        ]);
                        this.editingTrustSourceId = null;
                        return res;
                      },
                      `已将「${source.name}」调整为「${TRUST_LABELS[targetTrust]}」`,
                    ),
                  );
                }),
            ),
        ),
      )
      .when(isPushing, (el) =>
        el.child(
          div()
            .flex()
            .flex_row()
            .items_center()
            .gap(8)
            .pt(6)
            .border_t_1()
            .border_color(c.border)
            .child(
              div()
                .flex_1()
                .child(SmeltTextInput.new(this.commitMsgInput).aria_label("提交说明").small()),
            )
            .child(
              SmeltButton.new(`src-push-exec-${source.id}`)
                .label("执行守卫检查并推送")
                .primary()
                .small()
                .loading(this.busyAction === `push:${source.id}`)
                .disabled(Boolean(this.busyAction))
                .on_click((_ev, cx) => {
                  const msg = this.commitMsgInput.value().trim();
                  const args = ["push", source.id];
                  if (msg) args.push("-m", msg);
                  cx.spawn((cx) =>
                    this.runAction(
                      cx,
                      `push:${source.id}`,
                      async () => {
                        const res = await runCli(args);
                        this.commitMsgInput.set_value("");
                        this.pushingSourceId = null;
                        return res;
                      },
                      (res) =>
                        res.note ||
                        `已完成「${source.name}」${res.committed ? "提交与" : ""}${res.pushed ? "推送" : "处理"}`,
                    ),
                  );
                }),
            ),
        ),
      )
      .when(isConverting, (el) =>
        el.child(
          div()
            .flex()
            .flex_col()
            .gap(8)
            .pt(6)
            .border_t_1()
            .border_color(c.border)
            .child(
              div()
                .text_xs()
                .text_color(c.muted_foreground)
                .child("将纯本地源初始化为公司内网 Git 仓库（可暂不填 Remote，之后手动添加；若填公网域名将被拒绝）。"),
            )
            .child(
              div()
                .flex()
                .flex_row()
                .gap(8)
                .child(
                  div()
                    .flex_1()
                    .child(
                      SmeltTextInput.new(this.convertRemoteInput)
                        .aria_label("内网 Remote URL")
                        .small(),
                    ),
                )
                .child(
                  div()
                    .w(220)
                    .child(
                      SmeltTextInput.new(this.convertAllowInput)
                        .aria_label("允许的内网域名")
                        .small(),
                    ),
                )
                .child(
                  SmeltButton.new(`src-conv-exec-${source.id}`)
                    .label("确认升级为内网仓")
                    .primary()
                    .small()
                    .loading(this.busyAction === `conv:${source.id}`)
                    .disabled(Boolean(this.busyAction))
                    .on_click((_ev, cx) => {
                      const remote = this.convertRemoteInput.value().trim();
                      const allow = this.convertAllowInput.value().trim();
                      const args = ["source", "convert-internal", source.id];
                      if (remote) args.push("--remote", remote);
                      if (allow) args.push("--allow-host", allow);
                      cx.spawn((cx) =>
                        this.runAction(
                          cx,
                          `conv:${source.id}`,
                          async () => {
                            const res = await runCli(args);
                            this.convertRemoteInput.set_value("");
                            this.convertAllowInput.set_value("");
                            this.convertingSourceId = null;
                            return res;
                          },
                          `已将「${source.name}」升级为公司内网 Git 仓`,
                        ),
                      );
                    }),
                ),
            ),
        ),
      );
  }

  // ===================== Tab 3: 设备与体检 =====================
  renderDoctorTab(c, _cx) {
    const status = this.status;
    const doctor = status.doctor || {
      unmanaged: [],
      brokenLinks: [],
      conflicts: [],
      missingHooks: [],
    };
    const consolidate = status.consolidate || {
      actions: [],
      summary: { toMove: 0, toLink: 0, toRelink: 0, conflicts: 0, totalActions: 0 },
      conflicts: [],
      skippedConflicts: [],
      trashDir: "",
    };
    const consSummary = consolidate.summary || {
      toMove: 0,
      toLink: 0,
      toRelink: 0,
      conflicts: 0,
      totalActions: 0,
    };
    const conflictNames = new Set((doctor.conflicts || []).map((cf) => cf.dirName));
    const consActions = consolidate.actions || [];
    const shownConsActions = this.showAllConsolidate ? consActions : consActions.slice(0, 10);
    const targets = status.targets || [];
    const sources = status.sources || [];

    return div()
      .flex()
      .flex_col()
      .gap(12)
      // 1. 整合到 .agents 中枢（统一目录 + 软链）
      .child(
        sectionBox(c)
          .child(
            div()
              .flex()
              .flex_row()
              .flex_wrap()
              .items_center()
              .justify_between()
              .gap(8)
              .child(
                div()
                  .flex()
                  .flex_row()
                  .flex_wrap()
                  .items_center()
                  .gap(8)
                  .child(
                    div()
                      .text_sm()
                      .font_semibold()
                      .child(`整合到 ${status.config.hubDir} 中枢（统一目录 + 软链）`),
                  )
                  .when(consSummary.toMove > 0, (el) =>
                    el.child(SmeltBadge.new().need().child(`待迁入 ${consSummary.toMove}`)),
                  )
                  .when(consSummary.toLink + consSummary.toRelink > 0, (el) =>
                    el.child(
                      SmeltBadge.new()
                        .ok()
                        .child(`待补/修软链 ${consSummary.toLink + consSummary.toRelink}`),
                    ),
                  )
                  .when(consSummary.conflicts > 0, (el) =>
                    el.child(SmeltBadge.new().bad().child(`冲突跳过 ${consSummary.conflicts}`)),
                  ),
              )
              .child(
                div()
                  .flex()
                  .flex_row()
                  .flex_wrap()
                  .gap(6)
                  .when(consolidate.trashDir, (el) =>
                    el.child(
                      SmeltButton.new("cons-open-trash")
                        .label("打开回收站")
                        .quiet()
                        .small()
                        .on_click((_ev, cx) => {
                          cx.spawn(async (cx) => {
                            if (await exists(consolidate.trashDir)) {
                              await run("smelt.app/open-in-file-manager", {
                                path: consolidate.trashDir,
                              });
                            } else {
                              this.notice = {
                                level: "need",
                                text: `回收站当前为空（${consolidate.trashDir} 尚未产生冲突备份）`,
                              };
                              cx.notify();
                            }
                          });
                        }),
                    ),
                  )
                  .when(consSummary.toMove > 0, (el) =>
                    el.child(
                      SmeltConfirmButton.new("cons-apply-move-only")
                        .label(`仅迁入 (${consSummary.toMove})`)
                        .secondary()
                        .small()
                        .disabled(Boolean(this.busyAction))
                        .title(`仅把 ${consSummary.toMove} 个散落技能迁入 ${status.config.hubDir}？`)
                        .description(
                          "仅迁移实体目录到通用中枢（并更新已有指向它们的软链），暂不为其他工具补建新软链；同名冲突项会自动跳过。",
                        )
                        .action("仅迁入")
                        .on_confirm((cx) => {
                          cx.spawn((cx) =>
                            this.runAction(
                              cx,
                              "consolidate-move-only",
                              () => runCli(["consolidate", "--no-bridges"]),
                              (res) =>
                                `迁入完成：迁入 ${res.summary.toMove} 个，重指软链 ${res.summary.toRelink} 条${res.skippedConflicts?.length ? `，跳过冲突 ${res.skippedConflicts.length} 项` : ""}`,
                            ),
                          );
                        }),
                    ),
                  )
                  .when(consSummary.totalActions > 0, (el) =>
                    el.child(
                      SmeltConfirmButton.new("cons-apply-all")
                        .label(`一键整合 (${consSummary.totalActions})`)
                        .primary()
                        .small()
                        .disabled(Boolean(this.busyAction))
                        .title("确认整合到 .agents 中枢并补齐软链？")
                        .description(
                          `将迁入 ${consSummary.toMove} 个散落技能到 ${status.config.hubDir}，并为已启用「建软链」的工具新建 ${consSummary.toLink} 条、修复 ${consSummary.toRelink} 条软链。「仅读中枢」工具（如 Codex/OpenCode）不会多建重复软链；存在同名冲突的技能会跳过保留原样。`,
                        )
                        .action("确认整合")
                        .on_confirm((cx) => {
                          cx.spawn((cx) =>
                            this.runAction(
                              cx,
                              "consolidate-all",
                              () => runCli(["consolidate"]),
                              (res) =>
                                `整合完成：迁入 ${res.summary.toMove} 个，新建软链 ${res.summary.toLink} 条，修复软链 ${res.summary.toRelink} 条${res.skippedConflicts?.length ? `，跳过冲突 ${res.skippedConflicts.length} 项` : ""}`,
                            ),
                          );
                        }),
                    ),
                  ),
              ),
          )
          .child(
            div()
              .text_xs()
              .text_color(c.muted_foreground)
              .child(
                "参考 Smelt 原生技能管理：将散落在各 Agent 目录或 ~/.smelt/skills 里的实体技能统一归拢到 ~/.agents/skills，其它勾选「建软链」的工具改为软链/Junction；「仅读中枢」的工具直接读 ~/.agents/skills。",
              ),
          )
          .when(consSummary.totalActions === 0, (el) =>
            el.child(
              div()
                .text_xs()
                .text_color(c.muted_foreground)
                .child(
                  consSummary.conflicts > 0
                    ? `除 ${consSummary.conflicts} 项同名冲突外，其余技能均已整合到 ${status.config.hubDir} 且软链齐全。`
                    : `所有非冲突技能均已整合在 ${status.config.hubDir}，各工具软链完整。`,
                ),
            ),
          )
          .when(consActions.length > 0, (el) =>
            el.child(
              div()
                .flex()
                .flex_col()
                .gap(4)
                .p(8)
                .rounded(6)
                .border_1()
                .border_color(c.border)
                .bg(c.background)
                .child(
                  div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .child(
                      div()
                        .text_xs()
                        .font_medium()
                        .text_color(c.muted_foreground)
                        .child(`将执行的整合步骤 (${consActions.length})`),
                    )
                    .when(consActions.length > 10, (b) =>
                      b.child(
                        SmeltButton.new("cons-preview-toggle")
                          .label(this.showAllConsolidate ? "仅显示前 10 条" : `展开全部 ${consActions.length} 条`)
                          .quiet()
                          .small()
                          .on_click((_ev, cx) => {
                            this.showAllConsolidate = !this.showAllConsolidate;
                            cx.notify();
                          }),
                      ),
                    ),
                )
                .children(
                  shownConsActions.map((act, idx) =>
                    selectableLine(
                      `cons-act-${idx}`,
                      `· ${act.description}`,
                      c.muted_foreground,
                    ),
                  ),
                ),
            ),
          ),
      )
      // 2. 目标 Agent 工具配置
      .child(
        sectionBox(c)
          .child(
            div()
              .text_sm()
              .font_semibold()
              .child(`本机 Agent 目标工具（设备名: ${status.config.deviceName} · 中枢: ${status.config.hubDir}）`),
          )
          .child(
            div()
              .text_xs()
              .text_color(c.muted_foreground)
              .child("「建软链」会在该工具目录建立独立软链/Junction（支持单工具差异化开关）；「仅读中枢」表示由该工具直接读取 ~/.agents/skills，避免重复加载。"),
          )
          .children(
            targets.map((t) =>
              div()
                .flex()
                .flex_row()
                .flex_wrap()
                .items_center()
                .justify_between()
                .gap(8)
                .py(6)
                .border_t_1()
                .border_color(c.border)
                .child(
                  div()
                    .flex()
                    .flex_col()
                    .gap(2)
                    .child(div().text_xs().font_medium().child(`${t.label} (${t.id})`))
                    .child(div().text_xs().text_color(c.muted_foreground).child(t.path)),
                )
                .child(
                  div()
                    .flex()
                    .flex_row()
                    .gap(10)
                    .children(
                      ["link", "hub-only", "disabled"].map((mode) =>
                        SmeltRadio.new(`tgt-${t.id}-${mode}`)
                          .label(MODE_LABELS[mode])
                          .checked(t.mode === mode)
                          .on_select((cx) => {
                            cx.spawn((cx) =>
                              this.runAction(
                                cx,
                                `tgt:${t.id}:${mode}`,
                                () => runCli(["target", "set", t.id, "--mode", mode]),
                                `已将 ${t.label} 设为「${MODE_LABELS[mode]}」（请点击「应用变更」或「一键整合」生效）`,
                              ),
                            );
                          }),
                      ),
                    ),
                ),
            ),
          ),
      )
      // 3. 未纳管技能发现与归档
      .child(
        sectionBox(c)
          .child(
            div()
              .flex()
              .flex_row()
              .items_center()
              .justify_between()
              .child(
                div()
                  .text_sm()
                  .font_semibold()
                  .child(`未纳管的本地技能 (${doctor.unmanaged.length})`),
              ),
          )
          .when(doctor.unmanaged.length === 0, (el) =>
            el.child(
              div()
                .text_xs()
                .text_color(c.muted_foreground)
                .child("未发现散落的实体技能目录。"),
            ),
          )
          .when(doctor.unmanaged.length > 0 && sources.length === 0, (el) =>
            el.child(
              SmeltAlert.new(
                "need-source-for-adopt",
                "检测到未纳管技能。你可以先在上方「一键整合」把它们统一归拢到 ~/.agents/skills 并补齐软链；若需要跨设备同步，请到「仓库与同步」创建源后再归入对应源仓库。",
              ).need(),
            ),
          )
          .children(
            doctor.unmanaged.map((item, idx) =>
              div()
                .flex()
                .flex_col()
                .gap(4)
                .py(8)
                .border_t_1()
                .border_color(c.border)
                .child(
                  div()
                    .flex()
                    .flex_row()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap(8)
                    .child(
                      div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(8)
                        .child(div().text_xs().font_semibold().child(item.name))
                        .child(SmeltBadge.new().child(item.locationLabel)),
                    )
                    .child(
                      div()
                        .flex()
                        .flex_row()
                        .flex_wrap()
                        .gap(6)
                        .child(
                          SmeltButton.new(`unm-open-${item.path}`)
                            .label("打开目录")
                            .quiet()
                            .small()
                            .on_click((_ev, cx) => {
                              cx.spawn(async () => {
                                await run("smelt.app/open-in-file-manager", { path: item.path });
                              });
                            }),
                        )
                        .when(!item.isHub && !conflictNames.has(item.dirName), (el) =>
                          el.child(
                            SmeltButton.new(`unm-move-hub-${item.path}`)
                              .label("迁入 .agents")
                              .secondary()
                              .small()
                              .disabled(Boolean(this.busyAction))
                              .on_click((_ev, cx) => {
                                cx.spawn((cx) =>
                                  this.runAction(
                                    cx,
                                    `cons-one:${item.dirName}`,
                                    () => runCli(["consolidate", "--skill", item.dirName]),
                                    `已将「${item.dirName}」迁入 ${status.config.hubDir} 并更新软链`,
                                  ),
                                );
                              }),
                          ),
                        )
                        .children(
                          sources.map((dst) =>
                            SmeltConfirmButton.new(`adopt-${item.path}-${dst.id}`)
                              .label(`归入 ${dst.name}`)
                              .small()
                              .secondary()
                              .title(`将「${item.dirName}」纳管到 ${dst.name}？`)
                              .description(
                                dst.trust === "github"
                                  ? `会把 ${item.path} 移入 ${dst.path}，并在原位置留下软链。若命中敏感词或密钥规则将自动拦截。`
                                  : `会把 ${item.path} 移入 ${dst.path}，并在原位置自动建立软链。`,
                              )
                              .action("确认纳管")
                              .on_confirm((cx) => {
                                cx.spawn((cx) =>
                                  this.runAction(
                                    cx,
                                    `adopt:${item.dirName}`,
                                    () => runCli(["adopt", item.path, "--to", dst.id]),
                                    `已将「${item.dirName}」纳管至 ${dst.name} 并替换原位置为软链`,
                                  ),
                                );
                              }),
                          ),
                        ),
                    ),
                )
                .when(item.description, (el) =>
                  el.child(
                    div()
                      .text_xs()
                      .text_color(c.muted_foreground)
                      .truncate()
                      .child(item.description),
                  ),
                )
                .child(
                  selectableLine(
                    `unm-path-${idx}`,
                    `路径: ${item.path} · 当前可见位置: ${(item.locations || []).map((l) => l.label).join(", ")}`,
                    c.muted_foreground,
                  ),
                ),
            ),
          ),
      )
      // 4. 异常、失效链接与同名冲突解决
      .child(
        sectionBox(c)
          .child(
            div()
              .flex()
              .flex_row()
              .items_center()
              .justify_between()
              .child(div().text_sm().font_semibold().child("健康体检（失效链接 / 同名冲突解决 / Hook）"))
              .child(
                div()
                  .flex()
                  .flex_row()
                  .gap(6)
                  .when(doctor.brokenLinks.length > 0, (el) =>
                    el.child(
                      SmeltConfirmButton.new("btn-clean-broken")
                        .label(`清理 ${doctor.brokenLinks.length} 条失效链接`)
                        .danger()
                        .small()
                        .title("确认清理全部失效软链？")
                        .description("只删除目标已不存在或缺少 SKILL.md 的软链本身，绝不触碰任何实体目录。")
                        .action("确认清理")
                        .on_confirm((cx) => {
                          cx.spawn((cx) =>
                            this.runAction(
                              cx,
                              "fix-broken",
                              () => runCli(["doctor", "--fix-broken"]),
                              (res) => `已清理 ${res.cleanedBroken?.removed?.length || 0} 条失效软链`,
                            ),
                          );
                        }),
                    ),
                  )
                  .when(doctor.missingHooks.length > 0, (el) =>
                    el.child(
                      SmeltButton.new("btn-fix-hooks")
                        .label(`补装 ${doctor.missingHooks.length} 个 Hook`)
                        .secondary()
                        .small()
                        .on_click((_ev, cx) => {
                          cx.spawn((cx) =>
                            this.runAction(
                              cx,
                              "fix-hooks",
                              () => runCli(["doctor", "--fix-hooks"]),
                              "已为所有 Git 源补装 pre-push 防泄密钩子",
                            ),
                          );
                        }),
                    ),
                  ),
              ),
          )
          .when(
            doctor.brokenLinks.length === 0 &&
              doctor.conflicts.length === 0 &&
              doctor.missingHooks.length === 0,
            (el) =>
              el.child(
                div()
                  .text_xs()
                  .text_color(c.muted_foreground)
                  .child("所有链接、副本与防泄密 Hook 状态健康。"),
              ),
          )
          .children(
            doctor.brokenLinks.map((b, idx) =>
              selectableLine(
                `broken-link-${idx}`,
                `[失效软链] ${b.path} -> ${b.rawTarget || "缺失目标"}`,
                c.muted_foreground,
              ),
            ),
          )
          .children(
            doctor.conflicts.map((cf) => {
              const selectedKeep =
                this.conflictKeep[cf.dirName] || cf.copies[0]?.path || "";
              const keptCopy =
                cf.copies.find((cp) => cp.path === selectedKeep) || cf.copies[0];
              return div()
                .flex()
                .flex_col()
                .gap(8)
                .p(10)
                .rounded(6)
                .border_1()
                .border_color(c.border)
                .bg(c.background)
                .child(
                  div()
                    .flex()
                    .flex_row()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap(8)
                    .child(
                      div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(8)
                        .child(div().text_xs().font_semibold().child(cf.dirName))
                        .child(SmeltBadge.new().bad().child(`${cf.copies.length} 份同名副本`)),
                    )
                    .when(keptCopy, (el) =>
                      el.child(
                        SmeltConfirmButton.new(`cf-resolve-${cf.dirName}`)
                          .label("保留选中并整合到 .agents")
                          .primary()
                          .small()
                          .disabled(Boolean(this.busyAction))
                          .title(`保留「${keptCopy.locationLabel}」的 ${cf.dirName}？`)
                          .description(
                            `其余 ${cf.copies.length - 1} 份副本不会直接删除，而是安全移入 ${consolidate.trashDir}，保留的一份会整合进 ${status.config.hubDir} 并补齐各工具软链。`,
                          )
                          .action("确认保留并整合")
                          .on_confirm((cx) => {
                            const dirName = cf.dirName;
                            const keepPath = keptCopy.path;
                            cx.spawn((cx) =>
                              this.runAction(
                                cx,
                                `resolve:${dirName}`,
                                () =>
                                  runCli([
                                    "resolve-conflict",
                                    dirName,
                                    "--keep",
                                    keepPath,
                                  ]),
                                (res) =>
                                  `已解决「${dirName}」冲突（保留 ${res.keptPath}，其余副本已移入 ${res.trashDir}）`,
                              ),
                            );
                          }),
                      ),
                    ),
                )
                .children(
                  cf.copies.map((cp, idx) =>
                    div()
                      .flex()
                      .flex_col()
                      .gap(2)
                      .py(4)
                      .border_t_1()
                      .border_color(c.border)
                      .child(
                        div()
                          .flex()
                          .flex_row()
                          .items_center()
                          .justify_between()
                          .gap(8)
                          .child(
                            SmeltRadio.new(`cf-radio-${cf.dirName}-${idx}`)
                              .label(`${cp.locationLabel} · ${formatTime(cp.mtimeMs)}`)
                              .checked(selectedKeep === cp.path)
                              .on_select((cx) => {
                                this.conflictKeep[cf.dirName] = cp.path;
                                cx.notify();
                              }),
                          )
                          .child(
                            SmeltButton.new(`cf-open-${cf.dirName}-${idx}`)
                              .label("打开目录")
                              .quiet()
                              .small()
                              .on_click((_ev, cx) => {
                                cx.spawn(async () => {
                                  await run("smelt.app/open-in-file-manager", {
                                    path: cp.path,
                                  });
                                });
                              }),
                          ),
                      )
                      .child(
                        div()
                          .px(24)
                          .child(
                            selectableLine(
                              `cf-path-${cf.dirName}-${idx}`,
                              cp.path,
                              c.muted_foreground,
                            ),
                          ),
                      ),
                  ),
                );
            }),
          ),
      );
  }
}
