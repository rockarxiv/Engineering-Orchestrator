import { describe, expect, it } from "vitest";
import { findTemplate, MAX_TEMPLATE_CHARS, type TreeReader } from "./template.js";

/**
 * Finding the repository's template (F-06).
 *
 * Every case here is about *not* guessing. `gh pr create --body`
 * overrides whatever the repository declares, so if EO picks the wrong
 * file it silently replaces a template the team requires.
 */
function reader(files: Record<string, string>): TreeReader {
  return {
    showFile: async (_ref, path) => files[path] ?? null,
    listTree: async (_ref, dir) => Object.keys(files).filter((path) => path.startsWith(`${dir}/`)),
  };
}

describe("GitHub", () => {
  it("prefers .github over the root and docs", async () => {
    const found = await findTemplate({
      reader: reader({
        ".github/pull_request_template.md": "from dot-github",
        "PULL_REQUEST_TEMPLATE.md": "from the root",
        "docs/pull_request_template.md": "from docs",
      }),
      ref: "main",
      forge: "github",
    });

    expect(found.body).toBe("from dot-github");
    expect(found.path).toBe(".github/pull_request_template.md");
  });

  it("accepts either case, because GitHub does", async () => {
    const upper = await findTemplate({ reader: reader({ ".github/PULL_REQUEST_TEMPLATE.md": "shouty" }), ref: "main", forge: "github" });
    const lower = await findTemplate({ reader: reader({ "pull_request_template.md": "quiet" }), ref: "main", forge: "github" });

    expect(upper.body).toBe("shouty");
    expect(lower.body).toBe("quiet");
  });

  it("refuses to choose between several in a template directory", async () => {
    // GitHub applies none of them automatically — they are selected by a
    // ?template= query parameter — so there is no default to fall back
    // on, and picking one would file a security patch as a bug report.
    const found = await findTemplate({
      reader: reader({
        ".github/PULL_REQUEST_TEMPLATE/bug_fix.md": "a",
        ".github/PULL_REQUEST_TEMPLATE/security_fix.md": "b",
      }),
      ref: "main",
      forge: "github",
    });

    expect(found.body).toBeNull();
    expect(found.ambiguous).toEqual([".github/PULL_REQUEST_TEMPLATE/bug_fix.md", ".github/PULL_REQUEST_TEMPLATE/security_fix.md"]);
  });

  it("does not treat a directory's Default.md as a default", async () => {
    // That convention is GitLab's, and borrowing it here would apply a
    // template GitHub itself would not have applied.
    const found = await findTemplate({
      reader: reader({
        ".github/PULL_REQUEST_TEMPLATE/Default.md": "a",
        ".github/PULL_REQUEST_TEMPLATE/other.md": "b",
      }),
      ref: "main",
      forge: "github",
    });

    expect(found.body).toBeNull();
    expect(found.ambiguous).toHaveLength(2);
  });

  it("uses a lone file in the directory, since there is nothing to choose between", async () => {
    const found = await findTemplate({ reader: reader({ ".github/PULL_REQUEST_TEMPLATE/only.md": "the only one" }), ref: "main", forge: "github" });

    expect(found.body).toBe("the only one");
  });
});

describe("GitLab", () => {
  it("treats Default.md as the default, in any case", async () => {
    const found = await findTemplate({
      reader: reader({
        ".gitlab/merge_request_templates/Default.md": "the default",
        ".gitlab/merge_request_templates/hotfix.md": "not this one",
      }),
      ref: "main",
      forge: "gitlab",
    });

    expect(found.body).toBe("the default");
  });

  it("does not look at GitHub's locations", async () => {
    const found = await findTemplate({ reader: reader({ ".github/pull_request_template.md": "wrong forge" }), ref: "main", forge: "gitlab" });

    expect(found.body).toBeNull();
  });
});

describe("in general", () => {
  it("takes an explicit path over anything it would have searched", async () => {
    const found = await findTemplate({
      reader: reader({ ".github/pull_request_template.md": "the one it would have found", "docs/mine.md": "the one I asked for" }),
      ref: "main",
      forge: "github",
      override: "docs/mine.md",
    });

    expect(found.body).toBe("the one I asked for");
  });

  it("reports no template as an ordinary answer, not a failure", async () => {
    const found = await findTemplate({ reader: reader({}), ref: "main", forge: "github" });

    expect(found).toEqual({ body: null, path: null, ambiguous: null, truncated: false });
  });

  it("ignores a file that exists but is blank", async () => {
    const found = await findTemplate({ reader: reader({ ".github/pull_request_template.md": "   \n\n" }), ref: "main", forge: "github" });

    expect(found.body).toBeNull();
  });

  it("cuts a runaway template and says it did", async () => {
    const found = await findTemplate({ reader: reader({ ".github/pull_request_template.md": "x".repeat(MAX_TEMPLATE_CHARS + 500) }), ref: "main", forge: "github" });

    expect(found.truncated).toBe(true);
    expect(found.body).toContain("truncated by EO");
    expect(found.body!.length).toBeLessThan(MAX_TEMPLATE_CHARS + 100);
  });

  it("reads from the ref it was given, not the working tree", async () => {
    // The checkout is wherever the user left it; the template belongs to
    // the branch the pull request targets.
    const refs: string[] = [];
    const tracking: TreeReader = {
      showFile: async (ref, path) => {
        refs.push(ref);
        return path === ".github/pull_request_template.md" ? "body" : null;
      },
      listTree: async () => [],
    };

    await findTemplate({ reader: tracking, ref: "release/2.0", forge: "github" });

    expect(new Set(refs)).toEqual(new Set(["release/2.0"]));
  });
});
