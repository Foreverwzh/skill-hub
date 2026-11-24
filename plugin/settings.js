import { View, div } from "gpui-kit";
import {
  SmeltAlert,
  SmeltBadge,
  SmeltButton,
  SmeltInputState,
  SmeltTextInput,
} from "smelt-ui";
import { emit_event } from "smelt-plugin-api";
import { resolveRuntime, runCli } from "./lib/bridge.js";
import { selectableLine } from "./lib/ui.js";

const CHANGED_EVENT = "ai.smelt.skill-hub/changed";

function box(c) {
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

export default class SkillHubSettings extends View {
  init(_props, cx) {
    this.loading = true;
    this.saving = false;
    this.notice = null;
    this.config = null;
    this.guard = { forbiddenPublicHosts: [], keywords: [], regexPatterns: [] };
    this.runtimeInfo = null;

    this.deviceNameInput = SmeltInputState.new("当前设备标识（如 work-mac）");
    this.hubDirInput = SmeltInputState.new("~/.agents/skills");
    this.newKeywordInput = SmeltInputState.new("输入公司内部敏感词（如内部平台名/内网后缀）");
    this.newRegexInput = SmeltInputState.new("输入自定义敏感正则（可选）");
    this.newHostInput = SmeltInputState.new("禁止内网源绑定的公网域名（如 github.com）");

    cx.spawn(async (cx) => {
      await this.load(cx);
    });
  }

  async load(cx) {
    this.loading = true;
    cx.notify();
    try {
      const [data, rt] = await Promise.all([
        runCli(["settings", "get"]),
        resolveRuntime(),
      ]);
      this.config = data.config;
      this.guard = data.guard;
      this.runtimeInfo = rt;
      this.deviceNameInput.set_value(data.config?.deviceName || "");
      this.hubDirInput.set_value(data.config?.hubDir || "~/.agents/skills");
    } catch (err) {
      this.notice = { error: true, text: err?.message || String(err) };
    } finally {
      this.loading = false;
      cx.notify();
    }
  }

  async savePayload(cx, payload, okMessage) {
    if (this.saving) return;
    this.saving = true;
    cx.notify();
    try {
      const res = await runCli(["settings", "set", "--payload", JSON.stringify(payload)]);
      this.config = res.config;
      this.guard = res.guard;
      this.notice = { error: false, text: okMessage };
      emit_event(CHANGED_EVENT, { action: "settings" });
    } catch (err) {
      this.notice = { error: true, text: err?.message || String(err) };
    } finally {
      this.saving = false;
      cx.notify();
    }
  }

  render(cx) {
    const c = cx.theme().colors;

    return div()
      .id("skill-hub-settings-scroll")
      .size_full()
      .min_h_0()
      .overflow_y_scrollbar()
      .p(16)
      .flex()
      .flex_col()
      .gap(12)
      .text_color(c.foreground)
      .child(
        div()
          .text_base()
          .font_semibold()
          .child("技能中心 · 设备与防泄密守卫设置"),
      )
      .when(this.notice, (el) =>
        el.child(
          this.notice.error
            ? SmeltAlert.new("settings-notice", this.notice.text)
            : div()
                .px(10)
                .py(6)
                .rounded(6)
                .border_1()
                .border_color(c.border)
                .bg(c.surface)
                .text_xs()
                .child(this.notice.text),
        ),
      )
      .when(this.loading && !this.config, (el) =>
        el.child(div().text_xs().text_color(c.muted_foreground).child("正在加载设置...")),
      )
      .when(this.config, (el) =>
        el
          .child(
            box(c)
              .child(div().text_sm().font_semibold().child("本机基本配置"))
              .child(
                div()
                  .flex()
                  .flex_row()
                  .items_center()
                  .gap(8)
                  .child(div().w(90).text_xs().text_color(c.muted_foreground).child("设备名:"))
                  .child(
                    div()
                      .flex_1()
                      .child(SmeltTextInput.new(this.deviceNameInput).aria_label("设备名").small()),
                  ),
              )
              .child(
                div()
                  .flex()
                  .flex_row()
                  .items_center()
                  .gap(8)
                  .child(div().w(90).text_xs().text_color(c.muted_foreground).child("中枢目录:"))
                  .child(
                    div()
                      .flex_1()
                      .child(SmeltTextInput.new(this.hubDirInput).aria_label("中枢目录").small()),
                  ),
              )
              .child(
                div()
                  .flex()
                  .flex_row()
                  .justify_between()
                  .items_center()
                  .child(
                    div()
                      .text_xs()
                      .text_color(c.muted_foreground)
                      .child("修改中枢目录后请回到「技能中心」点击「应用变更」。"),
                  )
                  .child(
                    SmeltButton.new("btn-save-basic")
                      .label("保存基础配置")
                      .primary()
                      .small()
                      .loading(this.saving)
                      .on_click((_ev, cx) => {
                        const deviceName = this.deviceNameInput.value().trim();
                        const hubDir = this.hubDirInput.value().trim();
                        cx.spawn((cx) =>
                          this.savePayload(cx, { deviceName, hubDir }, "已保存设备与中枢配置"),
                        );
                      }),
                  ),
              ),
          )
          .child(
            box(c)
              .child(div().text_sm().font_semibold().child("GitHub 防泄密关键词（仅保存在本机 ~/.skill-hub/guard.json）"))
              .child(
                div()
                  .text_xs()
                  .text_color(c.muted_foreground)
                  .child("向 GitHub 源提交、推送或从内网源迁移到 GitHub 源时，命中以下词条（不区分大小写）将立即拦截。"),
              )
              .child(
                div()
                  .flex()
                  .flex_row()
                  .gap(8)
                  .child(
                    div()
                      .flex_1()
                      .child(SmeltTextInput.new(this.newKeywordInput).aria_label("新增敏感词").small()),
                  )
                  .child(
                    SmeltButton.new("btn-add-kw")
                      .label("添加关键词")
                      .secondary()
                      .small()
                      .on_click((_ev, cx) => {
                        const kw = this.newKeywordInput.value().trim();
                        if (!kw) return;
                        const next = [...new Set([...(this.guard.keywords || []), kw])];
                        this.newKeywordInput.set_value("");
                        cx.spawn((cx) =>
                          this.savePayload(cx, { guard: { keywords: next } }, `已添加关键词「${kw}」`),
                        );
                      }),
                  ),
              )
              .child(
                div()
                  .flex()
                  .flex_row()
                  .flex_wrap()
                  .gap(6)
                  .when((this.guard.keywords || []).length === 0, (w) =>
                    w.child(div().text_xs().text_color(c.muted_foreground).child("暂未配置自定义关键词。")),
                  )
                  .children(
                    (this.guard.keywords || []).map((kw) =>
                      div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(4)
                        .child(SmeltBadge.new().need().child(kw))
                        .child(
                          SmeltButton.new(`del-kw-${kw}`)
                            .label("×")
                            .quiet()
                            .small()
                            .on_click((_ev, cx) => {
                              const next = (this.guard.keywords || []).filter((x) => x !== kw);
                              cx.spawn((cx) =>
                                this.savePayload(cx, { guard: { keywords: next } }, `已移除关键词「${kw}」`),
                              );
                            }),
                        ),
                    ),
                  ),
              ),
          )
          .child(
            box(c)
              .child(div().text_sm().font_semibold().child("禁止内网源绑定的公网 Git 域名"))
              .child(
                div()
                  .flex()
                  .flex_row()
                  .gap(8)
                  .child(
                    div()
                      .flex_1()
                      .child(SmeltTextInput.new(this.newHostInput).aria_label("新增禁用域名").small()),
                  )
                  .child(
                    SmeltButton.new("btn-add-host")
                      .label("添加域名")
                      .secondary()
                      .small()
                      .on_click((_ev, cx) => {
                        const host = this.newHostInput.value().trim().toLowerCase();
                        if (!host) return;
                        const next = [
                          ...new Set([...(this.guard.forbiddenPublicHosts || []), host]),
                        ];
                        this.newHostInput.set_value("");
                        cx.spawn((cx) =>
                          this.savePayload(
                            cx,
                            { guard: { forbiddenPublicHosts: next } },
                            `已加入禁止域名「${host}」`,
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
                  .gap(6)
                  .children(
                    (this.guard.forbiddenPublicHosts || []).map((h) =>
                      div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(4)
                        .child(SmeltBadge.new().child(h))
                        .child(
                          SmeltButton.new(`del-host-${h}`)
                            .label("×")
                            .quiet()
                            .small()
                            .on_click((_ev, cx) => {
                              const next = (this.guard.forbiddenPublicHosts || []).filter(
                                (x) => x !== h,
                              );
                              cx.spawn((cx) =>
                                this.savePayload(
                                  cx,
                                  { guard: { forbiddenPublicHosts: next } },
                                  `已移除域名「${h}」`,
                                ),
                              );
                            }),
                        ),
                    ),
                  ),
              ),
          )
          .child(
            box(c)
              .child(div().text_sm().font_semibold().child("敏感内容正则规则"))
              .child(
                div()
                  .flex()
                  .flex_row()
                  .gap(8)
                  .child(
                    div()
                      .flex_1()
                      .child(SmeltTextInput.new(this.newRegexInput).aria_label("新增正则").small()),
                  )
                  .child(
                    SmeltButton.new("btn-add-regex")
                      .label("添加正则")
                      .secondary()
                      .small()
                      .on_click((_ev, cx) => {
                        const re = this.newRegexInput.value().trim();
                        if (!re) return;
                        try {
                          new RegExp(re);
                        } catch (err) {
                          this.notice = { error: true, text: `正则表达式语法错误: ${err.message}` };
                          cx.notify();
                          return;
                        }
                        const next = [...new Set([...(this.guard.regexPatterns || []), re])];
                        this.newRegexInput.set_value("");
                        cx.spawn((cx) =>
                          this.savePayload(cx, { guard: { regexPatterns: next } }, "已添加敏感正则规则"),
                        );
                      }),
                  ),
              )
              .children(
                (this.guard.regexPatterns || []).map((re, idx) =>
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
                        .child(selectableLine(`re-text-${idx}`, re, c.muted_foreground)),
                    )
                    .child(
                      SmeltButton.new(`copy-re-${idx}`)
                        .label("复制")
                        .quiet()
                        .small()
                        .on_click((_ev, cx) => {
                          cx.write_to_clipboard(re);
                          this.notice = { error: false, text: "已复制正则规则" };
                          cx.notify();
                        }),
                    )
                    .child(
                      SmeltButton.new(`del-re-${idx}`)
                        .label("移除")
                        .quiet()
                        .small()
                        .on_click((_ev, cx) => {
                          const next = (this.guard.regexPatterns || []).filter((x) => x !== re);
                          cx.spawn((cx) =>
                            this.savePayload(cx, { guard: { regexPatterns: next } }, "已移除敏感正则规则"),
                          );
                        }),
                    ),
                ),
              ),
          )
          .when(this.runtimeInfo, (el) =>
            el.child(
              box(c)
                .child(div().text_sm().font_semibold().child("运行环境诊断"))
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
                            "rt-node",
                            `Node: ${this.runtimeInfo.nodePath}`,
                            c.muted_foreground,
                          ),
                        ),
                    )
                    .child(
                      SmeltButton.new("copy-rt-node")
                        .label("复制")
                        .quiet()
                        .small()
                        .on_click((_ev, cx) => {
                          cx.write_to_clipboard(this.runtimeInfo.nodePath);
                          this.notice = { error: false, text: "已复制 Node 路径" };
                          cx.notify();
                        }),
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
                            "rt-cli",
                            `CLI: ${this.runtimeInfo.cliPath}`,
                            c.muted_foreground,
                          ),
                        ),
                    )
                    .child(
                      SmeltButton.new("copy-rt-cli")
                        .label("复制")
                        .quiet()
                        .small()
                        .on_click((_ev, cx) => {
                          cx.write_to_clipboard(this.runtimeInfo.cliPath);
                          this.notice = { error: false, text: "已复制 CLI 路径" };
                          cx.notify();
                        }),
                    ),
                ),
            ),
          ),
      );
  }
}
