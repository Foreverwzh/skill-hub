// 技能中心（ai.smelt.skill-hub）：skill-hub CLI 的界面。CLI 经运行时的 `process.run`
// 在本机跑（`~/.skill-hub/runtime.json` 记着 node 和 CLI 的路径），界面只读它的 JSON。
import { computed, Scroll, signal, Text, View } from "nsh";
import { Button as BaseButton, Input, RadioGroup } from "nsh/base";
import { Menu } from "nsh/desktop";
import {
  bootTask,
  call,
  clipboardWrite,
  currentTheme,
  DIALOG_SURFACE_CLASS,
  INPUT_CLASS,
  initHost,
  onCommand,
  onEvent,
  onSlices,
  registerCommands,
  registerViews,
  run,
  SmeltButton,
  SmeltCheckbox,
  SmeltDialog,
  SmeltDisclosure,
  SmeltDisclosureChevron,
  SmeltRadio,
  t,
  text,
  viewShown,
} from "smelt/sdk";
import {
  addSourceArgs,
  coverageSummary,
  doctorIssueCount,
  filterSkills,
  formatTime,
  gitSummary,
  looksCompanyOnGithub,
  MODES,
  overrideTag,
  parseCliResult,
  pendingCount,
  prettyPath,
  profileShortName,
  TRUSTS,
  withItem,
  withoutItem,
} from "./model.ts";

const PLUGIN = "ai.smelt.skill-hub";
const MAIN_VIEW = `${PLUGIN}/main`;
const SETTINGS_VIEW = `${PLUGIN}/settings`;
const SYNC_MODES = ["auto", "copy", "link"];
const CLI_TIMEOUT_MS = 120_000;

type Notice = { error: boolean; text: string };
type Confirm = { title: string; body: string; action: string; danger?: boolean; run: () => Promise<unknown> };

// ---- 状态 ----

const status = signal<any>(null);
const loading = signal(true);
const busy = signal<string | null>(null);
const notice = signal<Notice | null>(null);
const tab = signal<"skills" | "sources" | "doctor">("skills");
const query = signal("");
const trustFilter = signal("all");
const expanded = signal<string | null>(null);
const home = signal("");

const confirm = signal<Confirm | null>(null);
const sourceOpen = signal(false);
const sourceTrust = signal("local");
const sourceId = signal("");
const sourceName = signal("");
const sourcePath = signal("");
const sourceClone = signal("");
const sourceAllowHosts = signal("");
const sourceAutoPath = signal("");
const pushFor = signal<any>(null);
const commitMsg = signal("");
const convertFor = signal<any>(null);
const convertRemote = signal("");
const convertAllow = signal("");
const trustSource = signal<any>(null);
const trustValue = signal("local");
const profileOpen = signal(false);
const profileRef = signal<string | null>(null);
const profileSourceId = signal("");
const profileName = signal("");
const profileMembers = signal<string[]>([]);
const conflictKeep = signal<Record<string, string>>({});
const showAllSteps = signal(false);

const settings = signal<{ config: any; guard: any } | null>(null);
const deviceName = signal("");
const hubDir = signal("");
const newKeyword = signal("");
const newHost = signal("");
const newRegex = signal("");

// ---- CLI ----

let runtime: { nodePath: string; cliPath: string } | null = null;

async function cliRuntime() {
  if (runtime) return runtime;
  const dirs = await call(null, "fs.known_dirs", {});
  home.set(dirs.home);
  const path = `${dirs.home}/.skill-hub/runtime.json`;
  let parsed: any = null;
  try {
    const file = await call(null, "fs.read", { path, encoding: "utf8" });
    parsed = JSON.parse(file.content);
  } catch {
    parsed = null;
  }
  if (!parsed?.nodePath || !parsed?.cliPath) throw new Error(t("error.no_runtime", { path }));
  runtime = { nodePath: parsed.nodePath, cliPath: parsed.cliPath };
  return runtime;
}

async function runCli(args: string[]): Promise<any> {
  const rt = await cliRuntime();
  const out = await call(
    null,
    "process.run",
    { program: rt.nodePath, args: [rt.cliPath, ...args, "--json"], timeout_ms: CLI_TIMEOUT_MS },
    CLI_TIMEOUT_MS + 5_000,
  );
  return parseCliResult(out);
}

function errMsg(err: unknown): string {
  return (err as any)?.message || String(err);
}

async function reload() {
  try {
    const data = await runCli(["status"]);
    status.set(data);
    const ref = profileOpen() ? profileRef() : null;
    if (ref && !(data.profiles || []).some((p: any) => p.ref === ref)) profileOpen.set(false);
  } catch (err) {
    notice.set({ error: true, text: errMsg(err) });
  } finally {
    loading.set(false);
  }
}

async function act(key: string, fn: () => Promise<any>, ok?: string | ((res: any) => string)) {
  if (busy()) return;
  busy.set(key);
  try {
    const res = await fn();
    await reload();
    if (ok) notice.set({ error: false, text: typeof ok === "function" ? ok(res) : ok });
  } catch (err) {
    notice.set({ error: true, text: errMsg(err) });
  } finally {
    busy.set(null);
  }
}

const cli = (key: string, args: string[], ok?: string | ((res: any) => string)) =>
  act(key, () => runCli(args), ok);

async function copy(value: string) {
  await clipboardWrite(value);
  notice.set({ error: false, text: t("notice.copied", { value }) });
}

const openDir = (path: string) => void run("smelt.app/open-in-file-manager", { path });
const pretty = (path: string) => prettyPath(home(), path);

const syncDone = (res: any) =>
  t("notice.synced", {
    create: res.summary.create,
    replace: res.summary.replace,
    remove: res.summary.remove,
    conflicts: res.summary.conflicts || 0,
  });
const consolidateDone = (res: any) =>
  t("notice.consolidated", {
    move: res.summary.toMove,
    link: res.summary.toLink,
    relink: res.summary.toRelink,
    skipped: res.skippedConflicts?.length || 0,
  });

async function loadSettings() {
  try {
    const data = await runCli(["settings", "get"]);
    settings.set({ config: data.config, guard: data.guard });
    deviceName.set(data.config?.deviceName || "");
    hubDir.set(data.config?.hubDir || "~/.agents/skills");
  } catch (err) {
    notice.set({ error: true, text: errMsg(err) });
  }
}

function saveSettings(payload: unknown, ok: string) {
  return act(
    "settings",
    async () => {
      const res = await runCli(["settings", "set", "--payload", JSON.stringify(payload)]);
      settings.set({ config: res.config, guard: res.guard });
    },
    ok,
  );
}

// ---- 启动、命令、事件 ----

let lastShown = { main: false, settings: false };

onSlices(["views"], () => {
  const main = viewShown(MAIN_VIEW);
  const set = viewShown(SETTINGS_VIEW);
  if (main && !lastShown.main) void reload();
  if (set && !lastShown.settings) void loadSettings();
  lastShown = { main, settings: set };
});

onEvent(
  (event: any) => {
    if (event?.type !== "view_opened") return;
    if (event.view === MAIN_VIEW) void reload();
    if (event.view === SETTINGS_VIEW) void loadSettings();
  },
  ["view_opened"],
);

onCommand(async ({ name }) => {
  if (name === "open") return { opened: await run("smelt.app/open-view", { view: MAIN_VIEW }) };
  if (name === "sync" || name === "consolidate") {
    const res = await runCli([name]);
    await reload();
    return res;
  }
  if (name === "status") {
    const res = await runCli(["status"]);
    status.set(res);
    return res;
  }
  throw new Error(`unknown command ${name}`);
});

bootTask(async () => {
  await initHost(["views"]);
  await registerViews([
    { name: "main", export: "Main", title: text("view.title"), icon: "icons/book-open.svg" },
    {
      name: "settings",
      export: "Settings",
      title: text("view.title"),
      icon: "icons/book-open.svg",
      settings: { group: "agents", keywords: ["skill", "skills", "技能", "github", "guard"] },
    },
  ]);
  await registerCommands([
    { name: "open", title: text("cmd.open"), args: [], cli: true },
    { name: "sync", title: text("cmd.sync"), args: [], cli: true },
    { name: "status", title: text("cmd.status"), args: [], cli: true },
    { name: "consolidate", title: text("cmd.consolidate"), args: [], cli: true },
  ]);
});

// ---- 小组件 ----

const look = currentTheme;
const row = (gap = 8, extra: Record<string, unknown> = {}): any => ({
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap,
  ...extra,
});
const col = (gap = 8, extra: Record<string, unknown> = {}): any => ({
  display: "flex",
  flexDirection: "column",
  gap,
  ...extra,
});
const mutedText = (extra: Record<string, unknown> = {}): any => ({
  fontSize: look().type.text_xsmall.size,
  lineHeight: look().type.text_xsmall.line_height,
  color: look().palette.muted,
  ...extra,
});
const bodyText = (extra: Record<string, unknown> = {}): any => ({
  fontSize: look().type.small.size,
  lineHeight: look().type.small.line_height,
  color: look().palette.text,
  ...extra,
});
const titleText = (extra: Record<string, unknown> = {}): any => ({
  fontSize: look().type.ui_medium.size,
  lineHeight: look().type.ui_medium.line_height,
  fontWeight: look().type.ui_medium.weight,
  color: look().palette.text,
  ...extra,
});
const monoText = (extra: Record<string, unknown> = {}): any => ({
  fontFamily: look().fonts?.mono,
  fontSize: 11,
  color: look().palette.muted,
  ...extra,
});
const wrapRow = (gap = 8) => row(gap, { flexWrap: "wrap" });

function Badge(props: { label: string; tone?: "ok" | "need" | "bad" }) {
  const fg = () =>
    props.tone === "ok"
      ? look().palette.ok
      : props.tone === "need"
        ? look().palette.need
        : props.tone === "bad"
          ? look().palette.bad
          : look().palette.muted;
  return (
    <View
      style={{
        paddingLeft: 6,
        paddingRight: 6,
        height: 18,
        borderRadius: look().radius.sm,
        backgroundColor: look().palette.soft,
        borderWidth: 1,
        borderColor: props.tone === "bad" ? look().palette.bad : look().palette.hair,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <Text style={mutedText({ color: fg(), numberOfLines: 1 })}>{props.label}</Text>
    </View>
  );
}

function TrustBadge(props: { trust: string }) {
  return (
    <Badge
      label={TRUSTS.includes(props.trust) ? t(`trust.${props.trust}`) : t("trust.unmanaged")}
      tone={props.trust === "github" ? "ok" : props.trust === "internal" ? "need" : undefined}
    />
  );
}

function Section(props: { title: string; trailing?: any; children?: any }) {
  return (
    <View style={col(8, { paddingLeft: 16, paddingRight: 16, paddingTop: 14 })}>
      <View style={row(8)}>
        <Text style={titleText({ flex: 1, minWidth: 0 })}>{props.title}</Text>
        {props.trailing}
      </View>
      {props.children}
    </View>
  );
}

function Check(props: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <SmeltCheckbox
      checked={props.checked}
      disabled={props.disabled}
      accessibilityLabel={props.label}
      onChange={props.onChange}
    >
      <Text style={bodyText({ numberOfLines: 1 })}>{props.label}</Text>
    </SmeltCheckbox>
  );
}

function Radio(props: { label: string; checked: boolean; onSelect: () => void }) {
  return (
    <SmeltRadio checked={props.checked} accessibilityLabel={props.label} onChange={props.onSelect}>
      <Text style={bodyText({ numberOfLines: 1 })}>{props.label}</Text>
    </SmeltRadio>
  );
}

function Field(props: { value: string; placeholder: string; onChange: (v: string) => void; flex?: boolean }) {
  return (
    <View style={{ flex: props.flex === false ? undefined : 1, minWidth: 0 }}>
      <Input
        value={props.value}
        placeholder={props.placeholder}
        accessibilityLabel={props.placeholder}
        class={INPUT_CLASS}
        onChange={({ value }: { value: string }) => props.onChange(value)}
        style={{ width: "100%", height: 26, fontSize: look().type.small.size }}
      />
    </View>
  );
}

function PathLine(props: { path: string }) {
  return (
    <View style={row(6)}>
      <Text style={monoText({ flex: 1, minWidth: 0, numberOfLines: 1 })}>{pretty(props.path)}</Text>
      <SmeltButton quiet small icon="icons/copy.svg" tooltip={t("action.copy_path")} onPress={() => void copy(props.path)} />
      <SmeltButton quiet small icon="icons/folder.svg" tooltip={t("action.open_dir")} onPress={() => openDir(props.path)} />
    </View>
  );
}

function DialogShell(props: {
  open: boolean;
  title: string;
  onClose: () => void;
  width?: number;
  children?: any;
}) {
  const isOpen = computed(() => Boolean(props.open));
  return (
    <SmeltDialog
      open={isOpen()}
      accessibilityLabel={props.title}
      onOpenChange={({ open }: { open: boolean }) => {
        if (!open) props.onClose();
      }}
      class={`m-auto ${DIALOG_SURFACE_CLASS} p-4`}
      style={{ width: props.width ?? 460, gap: 12 }}
    >
      <If when={isOpen()}>
        <Text style={titleText()}>{props.title}</Text>
        {props.children}
      </If>
    </SmeltDialog>
  );
}

function DialogButtons(props: { action: string; danger?: boolean; disabled?: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <View style={row(8, { justifyContent: "flex-end" })}>
      <SmeltButton quiet small label={t("cancel")} onPress={props.onCancel} />
      <SmeltButton
        primary={!props.danger}
        danger={props.danger}
        small
        disabled={props.disabled || busy() != null}
        label={props.action}
        onPress={props.onConfirm}
      />
    </View>
  );
}

// ---- 主视图 ----

export function Main() {
  const pending = computed(() => pendingCount(status()));
  const issues = computed(() => doctorIssueCount(status()));

  const openMore = (e: any) =>
    void Menu.popup(
      [
        { label: t("action.refresh"), onSelect: () => void act("refresh", reload) },
        { label: t("action.settings"), onSelect: () => void run("smelt.app/open-view", { view: SETTINGS_VIEW }) },
      ],
      e?.x != null && e?.y != null ? { x: e.x, y: e.y } : undefined,
    );

  return (
    <View style={col(0, { flex: 1, width: "100%", height: "100%", minWidth: 0, minHeight: 0 })}>
      <View
        style={row(6, {
          paddingLeft: 16,
          paddingRight: 16,
          paddingTop: 8,
          paddingBottom: 8,
          borderBottomWidth: 1,
          borderBottomColor: look().palette.hair,
          flexShrink: 0,
        })}
      >
        <SmeltButton
          quiet
          small
          selected={tab() === "skills"}
          label={t("tab.skills", { n: status()?.skills?.length || 0 })}
          onPress={() => tab.set("skills")}
        />
        <SmeltButton
          quiet
          small
          selected={tab() === "sources"}
          label={t("tab.sources", { n: status()?.sources?.length || 0 })}
          onPress={() => tab.set("sources")}
        />
        <SmeltButton
          quiet
          small
          selected={tab() === "doctor"}
          label={issues() > 0 ? t("tab.doctor_n", { n: issues() }) : t("tab.doctor")}
          onPress={() => tab.set("doctor")}
        />
        <View style={{ flex: 1 }} />
        <SmeltButton
          quiet
          small
          label={t("action.pull_all")}
          loading={busy() === "pull-all"}
          disabled={busy() != null}
          onPress={() =>
            void cli("pull-all", ["pull"], (res) =>
              t("notice.pulled", { n: (res.results || []).filter((r: any) => !r.skipped).length }),
            )
          }
        />
        <SmeltButton
          primary={pending() > 0}
          small
          label={pending() > 0 ? t("action.apply_n", { n: pending() }) : t("action.apply")}
          loading={busy() === "sync"}
          disabled={busy() != null}
          onPress={() => void cli("sync", ["sync"], syncDone)}
        />
        <SmeltButton quiet small icon="icons/ellipsis.svg" tooltip={t("action.more")} onPress={openMore} />
      </View>

      <NoticeBar />

      <Scroll style={{ flex: 1, minHeight: 0, width: "100%" }}>
        <View style={col(0, { paddingBottom: 16 })}>
          <If
            when={status() != null}
            else={
              <Text style={mutedText({ padding: 16 })}>{loading() ? t("loading") : t("load_failed")}</Text>
            }
          >
            <If when={tab() === "skills"}>
              <SkillsTab />
            </If>
            <If when={tab() === "sources"}>
              <SourcesTab />
            </If>
            <If when={tab() === "doctor"}>
              <DoctorTab />
            </If>
          </If>
        </View>
      </Scroll>

      <ConfirmDialog />
      <SourceDialog />
      <PushDialog />
      <ConvertDialog />
      <TrustDialog />
      <ProfileDialog />
    </View>
  );
}

function NoticeBar() {
  return (
    <If when={notice() != null}>
      <View style={row(8, { paddingLeft: 16, paddingRight: 16, paddingTop: 8, flexShrink: 0 })}>
        <Text
          style={mutedText({
            flex: 1,
            minWidth: 0,
            color: notice()?.error ? look().palette.bad : look().palette.muted,
          })}
        >
          {notice()?.text ?? ""}
        </Text>
        <SmeltButton quiet small icon="icons/copy.svg" tooltip={t("action.copy")} onPress={() => void clipboardWrite(notice()?.text ?? "")} />
        <SmeltButton dismiss icon="icons/x.svg" tooltip={t("action.close")} onPress={() => notice.set(null)} />
      </View>
    </If>
  );
}

// ---- 技能 ----

function SkillsTab() {
  const sources = computed(() => status()?.sources || []);
  const skills = computed(() => status()?.skills || []);
  const shown = computed(() => filterSkills(skills(), query(), trustFilter()));
  const unmanaged = computed(() => status()?.doctor?.unmanaged?.length || 0);

  return (
    <View style={col(0)}>
      <If when={sources().length === 0}>
        <Section title={t("welcome.title")}>
          <Text style={mutedText()}>{t("welcome.body")}</Text>
          <View style={row(8)}>
            <SmeltButton
              primary
              small
              label={t("source.add")}
              onPress={() => {
                tab.set("skills");
                openSourceForm();
              }}
            />
          </View>
        </Section>
      </If>
      <If when={sources().length > 0 && unmanaged() > 0}>
        <View style={row(8, { paddingLeft: 16, paddingRight: 16, paddingTop: 10 })}>
          <Text style={mutedText({ flex: 1 })}>{t("banner.unmanaged", { n: unmanaged() })}</Text>
          <SmeltButton quiet small label={t("banner.go_doctor")} onPress={() => tab.set("doctor")} />
        </View>
      </If>

      <View style={row(6, { paddingLeft: 16, paddingRight: 16, paddingTop: 10 })}>
        <Field value={query()} placeholder={t("search.placeholder")} onChange={(v) => query.set(v)} />
        <Each of={["all", ...TRUSTS]} key={(k: string) => k}>
          {(k: () => string) => (
            <SmeltButton
              quiet
              small
              selected={trustFilter() === k()}
              label={k() === "all" ? t("filter.all") : t(`trust.${k()}`)}
              onPress={() => trustFilter.set(k())}
            />
          )}
        </Each>
      </View>

      <If when={sources().length > 0}>
        <ProfilesSection />
      </If>

      <Section title={t("skills.title", { shown: shown().length, total: skills().length })}>
        <If when={shown().length === 0}>
          <Text style={mutedText()}>{skills().length === 0 ? t("skills.empty") : t("skills.no_match")}</Text>
        </If>
      </Section>
      <View style={col(0, { paddingTop: 4 })}>
        <Each of={shown()} key={(s: any) => s.ref}>
          {(s: () => any) => <SkillRow skill={s()} />}
        </Each>
      </View>
    </View>
  );
}

function openProfileForm(opts: { ref: string | null; sourceId: string; name: string; members: string[] }) {
  profileRef.set(opts.ref);
  profileSourceId.set(opts.sourceId);
  profileName.set(opts.name);
  profileMembers.set(opts.members);
  profileOpen.set(true);
}

function ProfilesSection() {
  const profiles = computed(() => status()?.profiles || []);
  return (
    <Section
      title={t("profiles.title")}
      trailing={
        <SmeltButton
          quiet
          small
          label={t("profiles.new")}
          onPress={() =>
            openProfileForm({ ref: null, sourceId: status()?.sources?.[0]?.id || "", name: "", members: [] })
          }
        />
      }
    >
      <If when={profiles().length === 0}>
        <Text style={mutedText()}>{t("profiles.empty")}</Text>
      </If>
      <View style={wrapRow(8)}>
        <Each of={profiles()} key={(p: any) => p.ref}>
          {(p: () => any) => (
            <View
              style={row(6, {
                paddingLeft: 8,
                paddingRight: 4,
                paddingTop: 3,
                paddingBottom: 3,
                borderRadius: look().radius.md,
                borderWidth: 1,
                borderColor: look().palette.hair,
              })}
            >
              <Check
                label={`${p().ref} (${p().skills.length})`}
                checked={p().enabled}
                disabled={busy() != null}
                onChange={(v) => void cli(`prof:${p().ref}`, ["profile", v ? "enable" : "disable", p().ref])}
              />
              <TrustBadge trust={p().trust} />
              <SmeltButton
                quiet
                small
                icon="icons/ellipsis.svg"
                tooltip={t("action.more")}
                onPress={(e: any) =>
                  void Menu.popup(
                    [
                      {
                        label: t("profiles.edit"),
                        onSelect: () =>
                          openProfileForm({ ref: p().ref, sourceId: p().sourceId, name: p().name, members: [...p().skills] }),
                      },
                      {
                        label: t("profiles.delete"),
                        onSelect: () =>
                          confirm.set({
                            title: t("profiles.delete_title", { name: p().ref }),
                            body: t("profiles.delete_body"),
                            action: t("action.delete"),
                            danger: true,
                            run: () => cli(`del-prof:${p().ref}`, ["profile", "delete", p().ref], t("notice.profile_deleted", { name: p().ref })),
                          }),
                      },
                    ],
                    e?.x != null ? { x: e.x, y: e.y } : undefined,
                  )
                }
              />
            </View>
          )}
        </Each>
      </View>
    </Section>
  );
}

function SkillRow(props: { skill: any }) {
  const s = () => props.skill;
  const open = computed(() => expanded() === s().ref);
  const tag = computed(() => overrideTag(s(), t));
  const sourceProfiles = computed(() => (status()?.profiles || []).filter((p: any) => p.sourceId === s().sourceId));
  const linkTargets = computed(() => (status()?.targets || []).filter((x: any) => x.mode === "link"));
  const otherSources = computed(() => (status()?.sources || []).filter((x: any) => x.id !== s().sourceId));

  return (
    <SmeltDisclosure
      open={open()}
      content={
        <View
          style={col(10, {
            paddingLeft: 42,
            paddingRight: 16,
            paddingTop: 4,
            paddingBottom: 12,
            borderBottomWidth: 1,
            borderBottomColor: look().palette.hair,
          })}
        >
          <If when={Boolean(s().description)}>
            <Text style={bodyText()}>{s().description}</Text>
          </If>
          <Text style={mutedText()}>{coverageSummary(s(), t)}</Text>
          <View style={row(6)}>
            <Text style={monoText({ flex: 1, minWidth: 0, numberOfLines: 1 })}>{pretty(s().dir)}</Text>
            <SmeltButton quiet small label={t("skill.edit_md")} onPress={() => void run("smelt.app/open-in-text-editor", { path: s().skillMdPath })} />
            <SmeltButton quiet small icon="icons/copy.svg" tooltip={t("action.copy_path")} onPress={() => void copy(s().dir)} />
            <SmeltButton quiet small icon="icons/folder.svg" tooltip={t("action.open_dir")} onPress={() => openDir(s().dir)} />
          </View>

          <View style={wrapRow(10)}>
            <Text style={mutedText()}>{t("skill.profiles")}</Text>
            <If when={sourceProfiles().length === 0}>
              <Text style={mutedText()}>{t("skill.no_profiles")}</Text>
            </If>
            <Each of={sourceProfiles()} key={(p: any) => p.ref}>
              {(p: () => any) => (
                <Check
                  label={p().name}
                  checked={(s().profiles || []).includes(p().ref)}
                  disabled={busy() != null}
                  onChange={(v) =>
                    void cli(`sk-prof:${s().ref}`, ["profile", v ? "add-skill" : "remove-skill", p().ref, s().dirName])
                  }
                />
              )}
            </Each>
          </View>

          <If when={linkTargets().length > 0}>
            <View style={wrapRow(10)}>
              <Text style={mutedText()}>{t("skill.per_target")}</Text>
              <Each of={linkTargets()} key={(x: any) => x.id}>
                {(x: () => any) => {
                  const state = () => s().perTarget?.[x().id] || { effective: s().enabled, override: "inherit" };
                  return (
                    <Check
                      label={state().override === "inherit" ? x().label : `${x().label} (${t(`skill.override.${state().override}`)})`}
                      checked={state().effective}
                      disabled={busy() != null}
                      onChange={(v) =>
                        void cli(`ov:${s().ref}`, ["skill", v ? "enable" : "disable", s().ref, "--target", x().id])
                      }
                    />
                  );
                }}
              </Each>
            </View>
          </If>

          <If when={otherSources().length > 0}>
            <View style={wrapRow(6)}>
              <Text style={mutedText()}>{t("skill.move")}</Text>
              <Each of={otherSources()} key={(x: any) => x.id}>
                {(dst: () => any) => (
                  <SmeltButton
                    quiet
                    small
                    label={dst().name}
                    disabled={busy() != null}
                    onPress={() =>
                      confirm.set({
                        title: t("skill.move_title", { name: s().dirName, dst: dst().name }),
                        body: dst().trust === "github" ? t("skill.move_body_github") : t("skill.move_body"),
                        action: t("skill.move_action"),
                        run: () =>
                          cli(
                            `move:${s().dirName}`,
                            ["move", s().dirName, "--from", s().sourceId, "--to", dst().id],
                            t("notice.moved", { name: s().dirName, dst: dst().name }),
                          ),
                      })
                    }
                  />
                )}
              </Each>
            </View>
          </If>
        </View>
      }
    >
      <View
        style={row(10, {
          paddingLeft: 16,
          paddingRight: 16,
          paddingTop: 7,
          paddingBottom: 7,
          backgroundColor: open() ? look().palette.row_selected : "transparent",
        })}
      >
        <SmeltCheckbox
          checked={s().enabled}
          disabled={busy() != null}
          accessibilityLabel={s().name}
          onChange={(v) => void cli(`toggle:${s().ref}`, ["skill", v ? "enable" : "disable", s().ref])}
        />
        <BaseButton
          onPress={() => expanded.set(open() ? null : s().ref)}
          style={row(8, { flex: 1, minWidth: 0 })}
        >
          <View style={col(2, { flex: 1, minWidth: 0 })}>
            <View style={row(6)}>
              <Text style={titleText({ numberOfLines: 1, flexShrink: 1 })}>{s().name}</Text>
              <TrustBadge trust={s().trust} />
              <Badge label={s().sourceName} />
              <Each of={s().profiles || []} key={(r: string) => r}>
                {(r: () => string) => <Badge label={profileShortName(r())} />}
              </Each>
            </View>
            <If when={!open()}>
              <Text style={mutedText({ numberOfLines: 1 })}>{s().description || coverageSummary(s(), t)}</Text>
            </If>
          </View>
          <If when={Boolean(tag())}>
            <Text style={mutedText({ flexShrink: 0 })}>{tag()}</Text>
          </If>
          <SmeltDisclosureChevron open={open()} size={12} />
        </BaseButton>
      </View>
    </SmeltDisclosure>
  );
}

// ---- 仓库 ----

function openSourceForm() {
  sourceTrust.set("local");
  sourceId.set("");
  sourceName.set("");
  sourcePath.set("");
  sourceClone.set("");
  sourceAllowHosts.set("");
  sourceAutoPath.set("");
  sourceOpen.set(true);
}

function SourcesTab() {
  const sources = computed(() => status()?.sources || []);
  return (
    <View style={col(0)}>
      <View style={row(8, { paddingLeft: 16, paddingRight: 16, paddingTop: 12 })}>
        <Text style={mutedText({ flex: 1 })}>{t("sources.hint")}</Text>
        <SmeltButton primary small label={t("source.add")} onPress={openSourceForm} />
      </View>
      <If when={sources().length === 0}>
        <Text style={mutedText({ padding: 16 })}>{t("sources.empty")}</Text>
      </If>
      <Each of={sources()} key={(x: any) => x.id}>
        {(x: () => any) => <SourceCard source={x()} />}
      </Each>
    </View>
  );
}

function SourceCard(props: { source: any }) {
  const s = () => props.source;
  const git = () => s().git || {};
  const remoteGit = () => git().isGit && s().trust !== "local";

  const openMore = (e: any) => {
    const items: any[] = [
      { label: t("action.copy_path"), onSelect: () => void copy(s().absPath) },
      {
        label: t("source.change_trust"),
        onSelect: () => {
          trustValue.set(s().trust);
          trustSource.set(s());
        },
      },
    ];
    if (remoteGit()) {
      items.push({
        label: t("source.guard"),
        onSelect: () => void cli(`guard:${s().id}`, ["guard", "--source", s().id], t("notice.guard_ok", { name: s().name })),
      });
    }
    if (remoteGit() && !git().hasHook) {
      items.push({
        label: t("source.install_hook"),
        onSelect: () => void cli(`hook:${s().id}`, ["source", "install-hook", s().id], t("notice.hook_installed", { name: s().name })),
      });
    }
    if (s().trust === "local") {
      items.push({
        label: t("source.convert"),
        onSelect: () => {
          convertRemote.set("");
          convertAllow.set("");
          convertFor.set(s());
        },
      });
    }
    items.push({
      label: t("source.remove"),
      onSelect: () =>
        confirm.set({
          title: t("source.remove_title", { name: s().name }),
          body: t("source.remove_body"),
          action: t("source.remove"),
          danger: true,
          run: () => cli(`rm:${s().id}`, ["source", "remove", s().id], t("notice.source_removed", { name: s().name })),
        }),
    });
    void Menu.popup(items, e?.x != null ? { x: e.x, y: e.y } : undefined);
  };

  return (
    <View
      style={col(6, {
        paddingLeft: 16,
        paddingRight: 16,
        paddingTop: 12,
        paddingBottom: 12,
        borderBottomWidth: 1,
        borderBottomColor: look().palette.hair,
      })}
    >
      <View style={row(8)}>
        <Text style={titleText({ numberOfLines: 1, flexShrink: 1 })}>{s().name}</Text>
        <TrustBadge trust={s().trust} />
        <Badge label={t("source.skills_n", { n: s().skillsCount })} />
        <If when={remoteGit()}>
          <Badge label={git().hasHook ? t("source.hook_ok") : t("source.hook_missing")} tone={git().hasHook ? "ok" : "need"} />
        </If>
        <View style={{ flex: 1 }} />
        <If when={remoteGit()}>
          <SmeltButton
            quiet
            small
            label={t("source.pull")}
            loading={busy() === `pull:${s().id}`}
            disabled={busy() != null}
            onPress={() =>
              void cli(`pull:${s().id}`, ["pull", "--source", s().id], (res) => res.results?.[0]?.reason || t("notice.pulled_one", { name: s().name }))
            }
          />
          <SmeltButton
            small
            label={t("source.push")}
            disabled={busy() != null}
            onPress={() => {
              commitMsg.set("");
              pushFor.set(s());
            }}
          />
        </If>
        <SmeltButton quiet small icon="icons/ellipsis.svg" tooltip={t("action.more")} onPress={openMore} />
      </View>
      <Text style={mutedText()}>{`${s().id} · ${gitSummary(git(), t)}`}</Text>
      <PathLine path={s().absPath} />
      <Each of={git().remotes || []} key={(r: any) => r.name}>
        {(r: () => any) => <Text style={monoText({ numberOfLines: 1 })}>{`${r().name}  ${r().url}`}</Text>}
      </Each>
      <If when={git().dirty && (git().changedSkills?.length || 0) > 0}>
        <Text style={mutedText()}>{t("source.changed", { names: (git().changedSkills || []).join(", ") })}</Text>
      </If>
    </View>
  );
}

// ---- 体检 ----

function DoctorTab() {
  const st = () => status();
  const doctor = () => st()?.doctor || { unmanaged: [], brokenLinks: [], conflicts: [], missingHooks: [] };
  const cons = () => st()?.consolidate || { actions: [], summary: {}, trashDir: "" };
  const sum = () => cons().summary || {};
  const hub = () => st()?.config?.hubDir || "~/.agents/skills";
  const steps = computed(() => (showAllSteps() ? cons().actions : cons().actions.slice(0, 10)));
  const conflictNames = computed(() => new Set((doctor().conflicts || []).map((c: any) => c.dirName)));
  const healthy = () => doctor().brokenLinks.length === 0 && doctor().conflicts.length === 0 && doctor().missingHooks.length === 0;

  return (
    <View style={col(4)}>
      {/* 整合到中枢 */}
      <Section
        title={t("cons.title", { hub: hub() })}
        trailing={
          <View style={row(6)}>
            <If when={Boolean(cons().trashDir)}>
              <SmeltButton quiet small label={t("cons.open_trash")} onPress={() => openDir(cons().trashDir)} />
            </If>
            <If when={(sum().toMove || 0) > 0}>
              <SmeltButton
                quiet
                small
                label={t("cons.move_only", { n: sum().toMove })}
                disabled={busy() != null}
                onPress={() =>
                  confirm.set({
                    title: t("cons.move_only_title", { n: sum().toMove, hub: hub() }),
                    body: t("cons.move_only_body"),
                    action: t("cons.move_only_action"),
                    run: () => cli("cons-move", ["consolidate", "--no-bridges"], consolidateDone),
                  })
                }
              />
            </If>
            <If when={(sum().totalActions || 0) > 0}>
              <SmeltButton
                primary
                small
                label={t("cons.all", { n: sum().totalActions })}
                disabled={busy() != null}
                onPress={() =>
                  confirm.set({
                    title: t("cons.all_title"),
                    body: t("cons.all_body", { move: sum().toMove, link: sum().toLink, relink: sum().toRelink, hub: hub() }),
                    action: t("cons.all_action"),
                    run: () => cli("cons-all", ["consolidate"], consolidateDone),
                  })
                }
              />
            </If>
          </View>
        }
      >
        <Text style={mutedText()}>{t("cons.hint")}</Text>
        <If when={(sum().totalActions || 0) === 0}>
          <Text style={mutedText()}>
            {(sum().conflicts || 0) > 0 ? t("cons.done_with_conflicts", { n: sum().conflicts, hub: hub() }) : t("cons.done", { hub: hub() })}
          </Text>
        </If>
        <Each of={steps()} key={(a: any, i: number) => `${i}:${a.description}`}>
          {(a: () => any) => <Text style={monoText()}>{`· ${a().description}`}</Text>}
        </Each>
        <If when={cons().actions.length > 10}>
          <View style={row(0)}>
            <SmeltButton
              quiet
              small
              label={showAllSteps() ? t("cons.collapse") : t("cons.expand", { n: cons().actions.length })}
              onPress={() => showAllSteps.set(!showAllSteps())}
            />
          </View>
        </If>
      </Section>

      {/* 目标工具 */}
      <Section
        title={t("targets.title", {
          device: st()?.config?.deviceName || "",
          mode: t(`sync_mode.${st()?.effectiveSyncMode || "link"}`),
        })}
      >
        <Text style={mutedText()}>{t("targets.hint")}</Text>
        <Each of={st()?.targets || []} key={(x: any) => x.id}>
          {(x: () => any) => (
            <View style={row(8, { paddingTop: 4 })}>
              <View style={col(1, { flex: 1, minWidth: 0 })}>
                <Text style={bodyText()}>{x().label}</Text>
                <Text style={monoText({ numberOfLines: 1 })}>{x().path}</Text>
              </View>
              <Each of={MODES} key={(m: string) => m}>
                {(m: () => string) => (
                  <SmeltButton
                    quiet
                    small
                    selected={x().mode === m()}
                    disabled={busy() != null}
                    label={t(`mode.${m()}`)}
                    onPress={() => {
                      if (x().mode === m()) return;
                      void cli(`tgt:${x().id}`, ["target", "set", x().id, "--mode", m()], t("notice.target_set", { name: x().label, mode: t(`mode.${m()}`) }));
                    }}
                  />
                )}
              </Each>
            </View>
          )}
        </Each>
      </Section>

      {/* 未纳管 */}
      <Section title={t("unmanaged.title", { n: doctor().unmanaged.length })}>
        <If when={doctor().unmanaged.length === 0}>
          <Text style={mutedText()}>{t("unmanaged.empty")}</Text>
        </If>
        <Each of={doctor().unmanaged} key={(u: any) => u.path}>
          {(u: () => any) => (
            <View style={col(4, { paddingTop: 6, paddingBottom: 6, borderTopWidth: 1, borderTopColor: look().palette.hair })}>
              <View style={wrapRow(6)}>
                <Text style={bodyText()}>{u().name}</Text>
                <Badge label={u().locationLabel} />
                <View style={{ flex: 1 }} />
                <If when={!u().isHub && !conflictNames().has(u().dirName)}>
                  <SmeltButton
                    quiet
                    small
                    label={t("unmanaged.to_hub")}
                    disabled={busy() != null}
                    onPress={() =>
                      void cli(`cons-one:${u().dirName}`, ["consolidate", "--skill", u().dirName], t("notice.to_hub", { name: u().dirName, hub: hub() }))
                    }
                  />
                </If>
                <Each of={st()?.sources || []} key={(d: any) => d.id}>
                  {(d: () => any) => (
                    <SmeltButton
                      quiet
                      small
                      label={t("unmanaged.adopt", { name: d().name })}
                      disabled={busy() != null}
                      onPress={() =>
                        confirm.set({
                          title: t("unmanaged.adopt_title", { name: u().dirName, dst: d().name }),
                          body: t(d().trust === "github" ? "unmanaged.adopt_body_github" : "unmanaged.adopt_body", { src: pretty(u().path), dst: d().path }),
                          action: t("unmanaged.adopt_action"),
                          run: () => cli(`adopt:${u().dirName}`, ["adopt", u().path, "--to", d().id], t("notice.adopted", { name: u().dirName, dst: d().name })),
                        })
                      }
                    />
                  )}
                </Each>
              </View>
              <If when={Boolean(u().description)}>
                <Text style={mutedText({ numberOfLines: 1 })}>{u().description}</Text>
              </If>
              <PathLine path={u().path} />
            </View>
          )}
        </Each>
      </Section>

      {/* 健康 */}
      <Section
        title={t("health.title")}
        trailing={
          <View style={row(6)}>
            <If when={doctor().missingHooks.length > 0}>
              <SmeltButton
                quiet
                small
                label={t("health.fix_hooks", { n: doctor().missingHooks.length })}
                disabled={busy() != null}
                onPress={() => void cli("fix-hooks", ["doctor", "--fix-hooks"], t("notice.hooks_fixed"))}
              />
            </If>
            <If when={doctor().brokenLinks.length > 0}>
              <SmeltButton
                quiet
                danger
                small
                label={t("health.clean_broken", { n: doctor().brokenLinks.length })}
                disabled={busy() != null}
                onPress={() =>
                  confirm.set({
                    title: t("health.clean_title"),
                    body: t("health.clean_body"),
                    action: t("health.clean_action"),
                    danger: true,
                    run: () => cli("fix-broken", ["doctor", "--fix-broken"], (res) => t("notice.cleaned", { n: res.cleanedBroken?.removed?.length || 0 })),
                  })
                }
              />
            </If>
          </View>
        }
      >
        <If when={healthy()}>
          <Text style={mutedText()}>{t("health.ok")}</Text>
        </If>
        <Each of={doctor().brokenLinks} key={(b: any) => b.path}>
          {(b: () => any) => <Text style={monoText({ numberOfLines: 1 })}>{`${pretty(b().path)} → ${b().rawTarget || "?"}`}</Text>}
        </Each>
        <Each of={doctor().conflicts} key={(c: any) => c.dirName}>
          {(c: () => any) => <ConflictBlock conflict={c()} />}
        </Each>
      </Section>
    </View>
  );
}

function ConflictBlock(props: { conflict: any }) {
  const c = () => props.conflict;
  const keep = () => conflictKeep()[c().dirName] || c().copies[0]?.path || "";
  const kept = () => c().copies.find((cp: any) => cp.path === keep()) || c().copies[0];
  const hub = () => status()?.config?.hubDir || "~/.agents/skills";
  return (
    <View
      style={col(8, {
        padding: 10,
        borderWidth: 1,
        borderColor: look().palette.hair,
        borderRadius: look().radius.lg,
      })}
    >
      <View style={row(8)}>
        <Text style={bodyText()}>{c().dirName}</Text>
        <Badge label={t("conflict.copies", { n: c().copies.length })} tone="bad" />
        <View style={{ flex: 1 }} />
        <SmeltButton
          primary
          small
          label={t("conflict.keep")}
          disabled={busy() != null || !kept()}
          onPress={() =>
            confirm.set({
              title: t("conflict.keep_title", { where: kept().locationLabel, name: c().dirName }),
              body: t("conflict.keep_body", { n: c().copies.length - 1, trash: pretty(status()?.consolidate?.trashDir || ""), hub: hub() }),
              action: t("conflict.keep_action"),
              run: () =>
                cli(`resolve:${c().dirName}`, ["resolve-conflict", c().dirName, "--keep", kept().path], (res) =>
                  t("notice.resolved", { name: c().dirName, path: pretty(res.keptPath || "") }),
                ),
            })
          }
        />
      </View>
      <RadioGroup accessibilityLabel={c().dirName} style={col(6)}>
        <Each of={c().copies} key={(cp: any) => cp.path}>
          {(cp: () => any) => (
            <View style={col(2)}>
              <Radio
                label={`${cp().locationLabel} · ${formatTime(cp().mtimeMs)}`}
                checked={keep() === cp().path}
                onSelect={() => conflictKeep.set({ ...conflictKeep(), [c().dirName]: cp().path })}
              />
              <View style={{ paddingLeft: 22 }}>
                <PathLine path={cp().path} />
              </View>
            </View>
          )}
        </Each>
      </RadioGroup>
    </View>
  );
}

// ---- 对话框 ----

function ConfirmDialog() {
  return (
    <DialogShell open={confirm() != null} title={confirm()?.title ?? ""} width={420} onClose={() => confirm.set(null)}>
      <Text style={bodyText({ color: look().palette.muted })}>{confirm()?.body ?? ""}</Text>
      <DialogButtons
        action={confirm()?.action ?? ""}
        danger={confirm()?.danger}
        onCancel={() => confirm.set(null)}
        onConfirm={() => {
          const c = confirm();
          confirm.set(null);
          if (c) void c.run();
        }}
      />
    </DialogShell>
  );
}

function SourceDialog() {
  const warnCompany = computed(() =>
    looksCompanyOnGithub({ trust: sourceTrust(), id: sourceId(), name: sourceName() }),
  );
  const showClone = computed(() => sourceTrust() !== "local");
  const showAllowHosts = computed(() => sourceTrust() === "internal");
  const pick = async () => {
    const picked = await run("smelt.app/pick-paths", {
      machine: null,
      title: t("source.pick_title"),
      confirm: t("source.pick_confirm"),
      files: false,
      multiple: false,
    });
    if (Array.isArray(picked) && picked[0]) {
      sourcePath.set(picked[0]);
      sourceAutoPath.set("");
    }
  };
  const submit = () => {
    const form = {
      trust: sourceTrust(),
      id: sourceId(),
      name: sourceName(),
      path: sourcePath(),
      clone: sourceClone(),
      allowHosts: sourceAllowHosts(),
    };
    const args = addSourceArgs(form);
    if (!args) {
      notice.set({ error: true, text: t("source.required") });
      return;
    }
    const name = form.name.trim() || form.id.trim();
    sourceOpen.set(false);
    void cli("add-source", args, t("notice.source_added", { name }));
  };
  return (
    <DialogShell open={sourceOpen()} title={t("source.add_title")} width={520} onClose={() => sourceOpen.set(false)}>
      <RadioGroup accessibilityLabel={t("source.trust")} style={wrapRow(12)}>
        <Each of={TRUSTS} key={(k: string) => k}>
          {(k: () => string) => <Radio label={t(`trust.${k()}`)} checked={sourceTrust() === k()} onSelect={() => sourceTrust.set(k())} />}
        </Each>
      </RadioGroup>
      <If when={warnCompany()}>
        <Text style={mutedText({ color: look().palette.need })}>{t("source.warn_company")}</Text>
      </If>
      <View style={row(8)}>
        <Field
          value={sourceId()}
          placeholder={t("source.id")}
          onChange={(id) => {
            const auto = id.trim() ? `~/skill-sources/${id.trim()}` : "";
            const keepAuto = !sourcePath().trim() || sourcePath() === sourceAutoPath();
            sourceId.set(id);
            if (keepAuto) {
              sourcePath.set(auto);
              sourceAutoPath.set(auto);
            }
          }}
        />
        <Field value={sourceName()} placeholder={t("source.name")} onChange={(name) => sourceName.set(name)} />
      </View>
      <View style={row(8)}>
        <Field value={sourcePath()} placeholder={t("source.path")} onChange={(path) => sourcePath.set(path)} />
        <SmeltButton small label={t("source.pick")} onPress={() => void pick()} />
      </View>
      <If when={showClone()}>
        <Field value={sourceClone()} placeholder={t("source.clone")} onChange={(clone) => sourceClone.set(clone)} />
      </If>
      <If when={showAllowHosts()}>
        <Field value={sourceAllowHosts()} placeholder={t("source.allow_hosts")} onChange={(allowHosts) => sourceAllowHosts.set(allowHosts)} />
      </If>
      <Text style={mutedText()}>{t(`source.hint.${sourceTrust()}`)}</Text>
      <DialogButtons action={t("source.add_action")} onCancel={() => sourceOpen.set(false)} onConfirm={submit} />
    </DialogShell>
  );
}

function PushDialog() {
  return (
    <DialogShell open={pushFor() != null} title={t("push.title", { name: pushFor()?.name ?? "" })} onClose={() => pushFor.set(null)}>
      <Field value={commitMsg()} placeholder={t("push.message")} onChange={(v) => commitMsg.set(v)} />
      <Text style={mutedText()}>{t("push.hint")}</Text>
      <DialogButtons
        action={t("push.action")}
        onCancel={() => pushFor.set(null)}
        onConfirm={() => {
          const s = pushFor();
          const msg = commitMsg().trim();
          pushFor.set(null);
          const args = ["push", s.id];
          if (msg) args.push("-m", msg);
          void cli(`push:${s.id}`, args, (res) => res.note || t("notice.pushed", { name: s.name }));
        }}
      />
    </DialogShell>
  );
}

function ConvertDialog() {
  return (
    <DialogShell open={convertFor() != null} title={t("convert.title", { name: convertFor()?.name ?? "" })} onClose={() => convertFor.set(null)}>
      <Text style={mutedText()}>{t("convert.hint")}</Text>
      <Field value={convertRemote()} placeholder={t("convert.remote")} onChange={(v) => convertRemote.set(v)} />
      <Field value={convertAllow()} placeholder={t("convert.allow")} onChange={(v) => convertAllow.set(v)} />
      <DialogButtons
        action={t("convert.action")}
        onCancel={() => convertFor.set(null)}
        onConfirm={() => {
          const s = convertFor();
          convertFor.set(null);
          const args = ["source", "convert-internal", s.id];
          if (convertRemote().trim()) args.push("--remote", convertRemote().trim());
          if (convertAllow().trim()) args.push("--allow-host", convertAllow().trim());
          void cli(`conv:${s.id}`, args, t("notice.converted", { name: s.name }));
        }}
      />
    </DialogShell>
  );
}

function TrustDialog() {
  return (
    <DialogShell open={trustSource() != null} title={t("trust_dialog.title", { name: trustSource()?.name ?? "" })} onClose={() => trustSource.set(null)}>
      <RadioGroup accessibilityLabel={t("source.trust")} style={wrapRow(12)}>
        <Each of={TRUSTS} key={(k: string) => k}>
          {(k: () => string) => (
            <Radio label={t(`trust.${k()}`)} checked={trustValue() === k()} onSelect={() => trustValue.set(k())} />
          )}
        </Each>
      </RadioGroup>
      <Text style={mutedText()}>{t(`trust_dialog.hint.${trustValue()}`)}</Text>
      <DialogButtons
        action={t("trust_dialog.action")}
        disabled={trustValue() === trustSource()?.trust}
        onCancel={() => trustSource.set(null)}
        onConfirm={() => {
          const source = trustSource();
          const value = trustValue();
          trustSource.set(null);
          if (!source) return;
          void cli(`trust:${source.id}`, ["source", "set-trust", source.id, "--trust", value], t("notice.trust_set", { name: source.name, trust: t(`trust.${value}`) }));
        }}
      />
    </DialogShell>
  );
}

function ProfileDialog() {
  const editing = computed(() => profileRef() != null);
  const srcSkills = computed(() => (status()?.skills || []).filter((s: any) => s.sourceId === profileSourceId()));
  const toggle = (dir: string, on: boolean) =>
    profileMembers.set(on ? withItem(profileMembers(), dir) : withoutItem(profileMembers(), dir));
  const save = () => {
    const existingRef = profileRef();
    const rawName = profileName().trim();
    const ref = existingRef ?? `${profileSourceId()}:${rawName}`;
    if (!existingRef && !rawName) {
      notice.set({ error: true, text: t("profiles.name_required") });
      return;
    }
    const members = profileMembers();
    profileOpen.set(false);
    void cli("save-profile", ["profile", "set", ref, `--skills=${members.join(",")}`], t("notice.profile_saved", { name: ref, n: members.length }));
  };
  return (
    <DialogShell
      open={profileOpen()}
      title={editing() ? t("profiles.edit_title", { name: profileRef() ?? "" }) : t("profiles.new_title")}
      width={560}
      onClose={() => profileOpen.set(false)}
    >
      <If when={!editing()}>
        <Field value={profileName()} placeholder={t("profiles.name")} onChange={(name) => profileName.set(name)} />
        <RadioGroup accessibilityLabel={t("profiles.source")} style={wrapRow(12)}>
          <Each of={status()?.sources || []} key={(s: any) => s.id}>
            {(s: () => any) => (
              <Radio
                label={s().name}
                checked={profileSourceId() === s().id}
                onSelect={() => {
                  profileSourceId.set(s().id);
                  profileMembers.set([]);
                }}
              />
            )}
          </Each>
        </RadioGroup>
      </If>
      <View style={row(6)}>
        <Text style={mutedText({ flex: 1 })}>{t("profiles.members", { n: profileMembers().length, total: srcSkills().length })}</Text>
        <SmeltButton quiet small label={t("profiles.all")} onPress={() => profileMembers.set(srcSkills().map((s: any) => s.dirName))} />
        <SmeltButton quiet small label={t("profiles.none")} onPress={() => profileMembers.set([])} />
      </View>
      <Scroll style={{ maxHeight: 280, width: "100%" }}>
        <View style={wrapRow(10)}>
          <If when={srcSkills().length === 0}>
            <Text style={mutedText()}>{t("profiles.no_skills")}</Text>
          </If>
          <Each of={srcSkills()} key={(s: any) => s.dirName}>
            {(s: () => any) => (
              <Check label={s().dirName} checked={profileMembers().includes(s().dirName)} onChange={(v) => toggle(s().dirName, v)} />
            )}
          </Each>
        </View>
      </Scroll>
      <DialogButtons action={t("profiles.save")} onCancel={() => profileOpen.set(false)} onConfirm={save} />
    </DialogShell>
  );
}

// ---- 设置页 ----

function ListEditor(props: {
  title: string;
  hint: string;
  items: string[];
  value: string;
  placeholder: string;
  mono?: boolean;
  onValue: (v: string) => void;
  onAdd: () => void;
  onRemove: (item: string) => void;
}) {
  return (
    <Section title={props.title}>
      <Text style={mutedText()}>{props.hint}</Text>
      <View style={row(8)}>
        <Field value={props.value} placeholder={props.placeholder} onChange={props.onValue} />
        <SmeltButton small label={t("action.add")} disabled={busy() != null || !props.value.trim()} onPress={props.onAdd} />
      </View>
      <If when={props.items.length === 0}>
        <Text style={mutedText()}>{t("settings.none")}</Text>
      </If>
      <Each of={props.items} key={(x: string) => x}>
        {(x: () => string) => (
          <View style={row(6)}>
            <Text style={(props.mono ? monoText : bodyText)({ flex: 1, minWidth: 0 })}>{x()}</Text>
            <SmeltButton quiet small icon="icons/copy.svg" tooltip={t("action.copy")} onPress={() => void copy(x())} />
            <SmeltButton quiet small icon="icons/trash.svg" tooltip={t("action.delete")} disabled={busy() != null} onPress={() => props.onRemove(x())} />
          </View>
        )}
      </Each>
    </Section>
  );
}

export function Settings() {
  const guard = () => settings()?.guard || {};
  const saveGuard = (key: string, next: string[], ok: string) => saveSettings({ guard: { [key]: next } }, ok);

  return (
    <Scroll style={{ flex: 1, minHeight: 0, width: "100%", height: "100%" }}>
      <View style={col(4, { paddingBottom: 16 })}>
        <NoticeBar />
        <If when={settings() != null} else={<Text style={mutedText({ padding: 16 })}>{t("loading")}</Text>}>
          <Section title={t("settings.basic")}>
            <View style={row(8)}>
              <Text style={mutedText({ width: 72 })}>{t("settings.device")}</Text>
              <Field value={deviceName()} placeholder={t("settings.device")} onChange={(v) => deviceName.set(v)} />
            </View>
            <View style={row(8)}>
              <Text style={mutedText({ width: 72 })}>{t("settings.hub")}</Text>
              <Field value={hubDir()} placeholder={t("settings.hub")} onChange={(v) => hubDir.set(v)} />
            </View>
            <View style={row(8)}>
              <Text style={mutedText({ flex: 1 })}>{t("settings.hub_hint")}</Text>
              <SmeltButton
                primary
                small
                label={t("settings.save")}
                loading={busy() === "settings"}
                disabled={busy() != null}
                onPress={() => void saveSettings({ deviceName: deviceName().trim(), hubDir: hubDir().trim() }, t("notice.settings_saved"))}
              />
            </View>
          </Section>

          <Section title={t("settings.sync_mode")}>
            <RadioGroup accessibilityLabel={t("settings.sync_mode")} style={col(6)}>
              <Each of={SYNC_MODES} key={(m: string) => m}>
                {(m: () => string) => (
                  <Radio
                    label={t(`sync_mode.${m()}`)}
                    checked={(settings()?.config?.syncMode || "auto") === m()}
                    onSelect={() => {
                      if ((settings()?.config?.syncMode || "auto") === m()) return;
                      void saveSettings({ syncMode: m() }, t("notice.sync_mode_set", { mode: t(`sync_mode.${m()}`) }));
                    }}
                  />
                )}
              </Each>
            </RadioGroup>
            <Text style={mutedText()}>{t("settings.sync_mode_hint")}</Text>
          </Section>

          <ListEditor
            title={t("settings.keywords")}
            hint={t("settings.keywords_hint")}
            items={guard().keywords || []}
            value={newKeyword()}
            placeholder={t("settings.keyword_placeholder")}
            onValue={(v) => newKeyword.set(v)}
            onAdd={() => {
              const v = newKeyword().trim();
              newKeyword.set("");
              void saveGuard("keywords", withItem(guard().keywords, v), t("notice.item_added", { value: v }));
            }}
            onRemove={(v) => void saveGuard("keywords", withoutItem(guard().keywords, v), t("notice.item_removed", { value: v }))}
          />
          <ListEditor
            title={t("settings.hosts")}
            hint={t("settings.hosts_hint")}
            items={guard().forbiddenPublicHosts || []}
            value={newHost()}
            placeholder={t("settings.host_placeholder")}
            mono
            onValue={(v) => newHost.set(v)}
            onAdd={() => {
              const v = newHost().trim().toLowerCase();
              newHost.set("");
              void saveGuard("forbiddenPublicHosts", withItem(guard().forbiddenPublicHosts, v), t("notice.item_added", { value: v }));
            }}
            onRemove={(v) => void saveGuard("forbiddenPublicHosts", withoutItem(guard().forbiddenPublicHosts, v), t("notice.item_removed", { value: v }))}
          />
          <ListEditor
            title={t("settings.regex")}
            hint={t("settings.regex_hint")}
            items={guard().regexPatterns || []}
            value={newRegex()}
            placeholder={t("settings.regex_placeholder")}
            mono
            onValue={(v) => newRegex.set(v)}
            onAdd={() => {
              const v = newRegex().trim();
              newRegex.set("");
              void saveGuard("regexPatterns", withItem(guard().regexPatterns, v), t("notice.item_added", { value: v }));
            }}
            onRemove={(v) => void saveGuard("regexPatterns", withoutItem(guard().regexPatterns, v), t("notice.item_removed", { value: v }))}
          />

          <Section title={t("settings.runtime")}>
            <Text style={monoText()}>{`node  ${runtime?.nodePath ?? "-"}`}</Text>
            <Text style={monoText()}>{`cli   ${runtime?.cliPath ?? "-"}`}</Text>
          </Section>
        </If>
      </View>
    </Scroll>
  );
}
