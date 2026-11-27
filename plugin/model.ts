// 技能中心插件的纯逻辑：不 import NSH，文案函数 t 从参数传进来，方便 bun / node 单测。

export const TRUSTS = ["github", "internal", "local"];
export const MODES = ["link", "hub-only", "disabled"];

/** CLI 跑在 smeltd 上：`process.run` 的结果转成 JSON，失败抛带 code 的错误。 */
export function parseCliResult(out: any) {
  const stdout = (out?.stdout || "").trim();
  const stderr = (out?.stderr || "").trim();
  if (out?.timed_out) throw new Error("skill-hub timed out");
  if (out?.code !== 0) {
    let parsed = null;
    try {
      parsed = JSON.parse(stderr || stdout);
    } catch {
      parsed = null;
    }
    const err: any = new Error(parsed?.error || stderr || stdout || `exit ${out?.code}`);
    err.code = parsed?.code || `EXIT_${out?.code}`;
    throw err;
  }
  if (!stdout) return { ok: true };
  return JSON.parse(stdout);
}

export function filterSkills(skills: any, query: any, trust: any) {
  const q = (query || "").trim().toLowerCase();
  return (skills || []).filter((s: any) => {
    if (trust !== "all" && s.trust !== trust) return false;
    if (!q) return true;
    return [s.name, s.dirName, s.description, s.sourceName].some((v) =>
      (v || "").toLowerCase().includes(q),
    );
  });
}

export function pendingCount(status: any) {
  return status?.pendingSync?.summary?.totalPending || 0;
}

export function doctorIssueCount(status: any) {
  const d = status?.doctor || {};
  return (
    (d.unmanaged?.length || 0) +
    (d.brokenLinks?.length || 0) +
    (d.conflicts?.length || 0) +
    (d.missingHooks?.length || 0) +
    (status?.consolidate?.summary?.totalActions || 0)
  );
}

const COVERAGE_KEYS: Record<string, string> = {
  linked: "cov.linked",
  copied: "cov.linked",
  "via-hub": "cov.hub",
  pending: "cov.pending",
  "pending-remove": "cov.pending_remove",
  conflict: "cov.conflict",
};

export function coverageSummary(skill: any, t: any) {
  const parts = (skill.coverage || [])
    .filter((c: any) => COVERAGE_KEYS[c.status])
    .map((c: any) => `${c.label} ${t(COVERAGE_KEYS[c.status])}`);
  return parts.length > 0 ? parts.join(" · ") : t("cov.none");
}

export function overrideTag(skill: any, t: any) {
  if (skill.explicitlyIncluded && !skill.fromEnabledProfile) return t("skill.tag.included");
  if (skill.explicitlyExcluded) return t("skill.tag.excluded");
  if (skill.fromEnabledProfile) return t("skill.tag.profile");
  return "";
}

export function gitSummary(git: any, t: any) {
  if (!git || !git.isGit) return t("git.not_git");
  const parts = [t("git.branch", { name: git.branch || "HEAD" })];
  if (!git.hasRemote) parts.push(t("git.no_remote"));
  if (git.ahead > 0) parts.push(t("git.ahead", { n: git.ahead }));
  if (git.behind > 0) parts.push(t("git.behind", { n: git.behind }));
  parts.push(git.dirty ? t("git.dirty", { n: git.changedFiles?.length || 0 }) : t("git.clean"));
  return parts.join(" · ");
}

export function profileShortName(ref: any) {
  return ref.includes(":") ? ref.split(":").slice(1).join(":") : ref;
}

export function formatTime(ms: any) {
  if (!ms || !Number.isFinite(ms)) return "-";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把 `/Users/x/foo` 或 `C:\Users\x\foo` 写成 `~/foo`。 */
export function prettyPath(home: any, path: any) {
  if (!home || !path) return path || "";
  const normHome = String(home).replace(/[\\/]+$/, "");
  const raw = String(path);
  if (raw === normHome) return "~";
  if (raw.startsWith(`${normHome}/`) || raw.startsWith(`${normHome}\\`)) {
    return `~/${raw.slice(normHome.length + 1).replace(/\\/g, "/")}`;
  }
  return raw;
}

/** `source add` 的参数；校验不过返回 null。 */
export function addSourceArgs(form: any) {
  const id = form.id.trim();
  const path = form.path.trim();
  if (!id || !path) return null;
  const args = ["source", "add", "--id", id, "--name", form.name.trim() || id, "--path", path, "--trust", form.trust];
  if (form.clone.trim() && form.trust !== "local") args.push("--clone", form.clone.trim());
  if (form.allowHosts.trim() && form.trust === "internal") args.push("--allow-host", form.allowHosts.trim());
  return args;
}

/** 名字像公司专用却选了 GitHub 源。 */
export function looksCompanyOnGithub(form: any) {
  return form.trust === "github" && /(company|corp|work|internal|office|公司|内网)/i.test(`${form.id} ${form.name}`);
}

/** 列表里去掉 / 加上一项，返回新数组；加的项为空或已有时原样返回。 */
export function withItem(list: any, item: any) {
  const v = (item || "").trim();
  if (!v || (list || []).includes(v)) return list || [];
  return [...(list || []), v];
}

export function withoutItem(list: any, item: any) {
  return (list || []).filter((x: any) => x !== item);
}
