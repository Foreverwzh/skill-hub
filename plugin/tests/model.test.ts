import { describe, expect, test } from "bun:test";
import {
  addSourceArgs,
  coverageSummary,
  doctorIssueCount,
  filterSkills,
  gitSummary,
  looksCompanyOnGithub,
  parseCliResult,
  prettyPath,
  withItem,
  withoutItem,
} from "../model.ts";

const t = (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key);

describe("parseCliResult", () => {
  test("parses stdout JSON on success", () => {
    expect(parseCliResult({ code: 0, stdout: '{"a":1}\n', stderr: "" })).toEqual({ a: 1 });
    expect(parseCliResult({ code: 0, stdout: "", stderr: "" })).toEqual({ ok: true });
  });
  test("surfaces the CLI's JSON error and code", () => {
    try {
      parseCliResult({ code: 2, stdout: "", stderr: '{"error":"blocked","code":"GUARD"}' });
      throw new Error("should throw");
    } catch (err: any) {
      expect(err.message).toBe("blocked");
      expect(err.code).toBe("GUARD");
    }
  });
  test("falls back to raw text and reports timeouts", () => {
    expect(() => parseCliResult({ code: 1, stdout: "", stderr: "boom" })).toThrow("boom");
    expect(() => parseCliResult({ code: null, timed_out: true, stdout: "", stderr: "" })).toThrow("timed out");
  });
});

test("filterSkills by trust and query", () => {
  const skills = [
    { name: "Lark", dirName: "lark-cli", description: "飞书", sourceName: "Work", trust: "internal" },
    { name: "Find", dirName: "find-skills", description: "", sourceName: "Me", trust: "github" },
  ];
  expect(filterSkills(skills, "", "all").length).toBe(2);
  expect(filterSkills(skills, "", "github").map((s: any) => s.dirName)).toEqual(["find-skills"]);
  expect(filterSkills(skills, "飞书", "all").map((s: any) => s.dirName)).toEqual(["lark-cli"]);
  expect(filterSkills(skills, "work", "github")).toEqual([]);
});

test("doctorIssueCount sums every pending fix", () => {
  expect(
    doctorIssueCount({
      doctor: { unmanaged: [1], brokenLinks: [1, 2], conflicts: [], missingHooks: [1] },
      consolidate: { summary: { totalActions: 3 } },
    }),
  ).toBe(7);
  expect(doctorIssueCount(null)).toBe(0);
});

test("coverage and git summaries", () => {
  expect(coverageSummary({ coverage: [] }, t)).toBe("cov.none");
  expect(coverageSummary({ coverage: [{ label: "Claude", status: "linked" }, { label: "X", status: "other" }] }, t)).toBe(
    "Claude cov.linked",
  );
  expect(gitSummary(null, t)).toBe("git.not_git");
  expect(gitSummary({ isGit: true, branch: "main", hasRemote: true, ahead: 1, dirty: false }, t)).toBe(
    'git.branch{"name":"main"} · git.ahead{"n":1} · git.clean',
  );
});

test("addSourceArgs only passes flags valid for the trust level", () => {
  const base = { id: " work ", name: "", path: "~/s/work", clone: "git@x:y.git", allowHosts: "x.corp", trust: "local" };
  expect(addSourceArgs({ ...base, id: "" })).toBeNull();
  expect(addSourceArgs(base)).toEqual(["source", "add", "--id", "work", "--name", "work", "--path", "~/s/work", "--trust", "local"]);
  expect(addSourceArgs({ ...base, trust: "internal" })).toContain("--allow-host");
  expect(addSourceArgs({ ...base, trust: "github" })).not.toContain("--allow-host");
  expect(addSourceArgs({ ...base, trust: "github" })).toContain("--clone");
});

test("misc helpers", () => {
  expect(looksCompanyOnGithub({ trust: "github", id: "company", name: "" })).toBe(true);
  expect(looksCompanyOnGithub({ trust: "internal", id: "company", name: "" })).toBe(false);
  expect(prettyPath("/Users/a", "/Users/a/x")).toBe("~/x");
  expect(prettyPath("/Users/a", "/Users/ab/x")).toBe("/Users/ab/x");
  expect(withItem(["a"], " a ")).toEqual(["a"]);
  expect(withItem(["a"], "b")).toEqual(["a", "b"]);
  expect(withoutItem(["a", "b"], "a")).toEqual(["b"]);
});
