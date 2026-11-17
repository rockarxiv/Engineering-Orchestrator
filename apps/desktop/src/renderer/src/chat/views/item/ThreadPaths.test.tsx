import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { CommentView } from "@eo/core";
import { codeSpan, cutKeepingCodeSpans } from "../../../../../main/codeSpan";
import { codexHomeRefusal, prepareCodexHome, type CodexHomeFs, type LinkStat } from "../../../../../main/providers/codexHome";
import { createQueryClient } from "../../../query/client";
import { CommentThread } from "./Thread";

/**
 * Paths in the comments EO writes itself, as the item thread draws them
 * (EO-830).
 *
 * A comment is markdown, where a backslash before punctuation is an
 * escape, so a Windows path written as plain text loses the backslash
 * before every `.`, `-` and `_` in it. FORT-83's escalation read
 * `C:\Users\<name>.eo\codex-homes\…` for `C:\Users\<name>\.eo\codex-homes\…`.
 *
 * `codexHome.ts` builds its paths with `node:path`, which is Windows' here
 * so that they are the paths a Windows machine builds, backslashes and all.
 */
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return { ...actual.win32, default: actual.win32 };
});

const AGENT = "019fb8c6-0000-7000-8000-0000000000a1";
const ITEM = "019fb8c6-0000-7000-8000-0000000000c3";
const PERSON_HOME = "C:\\Users\\name\\.codex";
const APP_DATA_ROOT = "C:\\Users\\name\\AppData\\Roaming\\EO\\codex-homes";
const PROFILE_ROOT = "C:\\Users\\name\\.eo\\codex-homes";
const SKILLS = `${APP_DATA_ROOT}\\${AGENT}\\${ITEM}\\skills`;
const LOCK = `${PROFILE_ROOT}\\${AGENT}\\${ITEM}\\.sqlite-maintenance.lock`;

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

const DIRECTORY: LinkStat = { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true };

/**
 * A Windows filesystem where the home is made, and its scrub then meets
 * `entry` and cannot remove it: a Codex process is holding it open, and
 * Windows says so with `refusal`, quoting the path the way Node does.
 */
function heldOpen(home: string, entry: string, refusal: Error): CodexHomeFs {
  const directories = new Set<string>([`${home}\\${entry}`]);
  const unexpected = (call: string) => () => {
    throw new Error(`not expected here: ${call}`);
  };
  return {
    existsSync: (path) => directories.has(String(path)),
    lstatSync: (path) => {
      if (directories.has(path)) return DIRECTORY;
      throw errno("ENOENT", `no such file or directory, lstat '${path}'`);
    },
    mkdirSync: ((path: string) => {
      directories.add(path);
      return undefined;
    }) as CodexHomeFs["mkdirSync"],
    readdirSync: (path) => (path === home ? [entry] : []),
    readlinkSync: unexpected("readlinkSync"),
    rmSync: () => {
      throw refusal;
    },
    symlinkSync: unexpected("symlinkSync"),
    unlinkSync: () => {
      throw refusal;
    },
  };
}

/** What preparing the agent's home for the item under `root` refused with. */
function scrubRefusal(root: string, entry: string, refusal: Error): string {
  const home = `${root}\\${AGENT}\\${ITEM}`;
  const prepared = prepareCodexHome({ root, agentId: AGENT, itemId: ITEM, personHome: PERSON_HOME, platform: "win32", fs: heldOpen(home, entry, refusal) });
  if (prepared.ok) throw new Error("the scrub was expected to fail");
  return prepared.problem;
}

/**
 * FORT-83's escalation: the scrub refused under both roots, the problems
 * joined as `chooseCodexHome` joins them, and the agent's dispatch refused
 * with them (`codexHomeRefusal`).
 */
function fort83Escalation(): string {
  const problems = [
    scrubRefusal(APP_DATA_ROOT, "skills", errno("EPERM", `operation not permitted, rmdir '${SKILLS}'`)),
    scrubRefusal(PROFILE_ROOT, "skills", errno("EBUSY", `resource busy or locked, unlink '${LOCK}'`)),
  ];
  const refusal = codexHomeRefusal({ kind: "unavailable", problem: problems.join(" ") }, "signed_in", "Implementer");
  if (refusal === null) throw new Error("the dispatch was expected to be refused");
  return refusal;
}

/**
 * The dispatch refused because the home an agent had before EO-829 —
 * `root\<agent>` itself — holds a real `sessions` directory, whose
 * rollouts exist nowhere else.
 */
function realSessionsEscalation(root: string): string {
  const directories = new Set<string>([`${root}\\${AGENT}`, `${root}\\${AGENT}\\sessions`]);
  const fs: CodexHomeFs = {
    ...heldOpen(`${root}\\${AGENT}\\${ITEM}`, "unused", new Error("not expected here")),
    existsSync: (path) => directories.has(String(path)),
    lstatSync: (path) => {
      if (directories.has(path)) return DIRECTORY;
      throw errno("ENOENT", `no such file or directory, lstat '${path}'`);
    },
  };
  const prepared = prepareCodexHome({ root, agentId: AGENT, itemId: ITEM, personHome: PERSON_HOME, platform: "win32", fs });
  if (prepared.ok) throw new Error("the old home was expected to be refused");
  const refusal = codexHomeRefusal({ kind: "unavailable", problem: prepared.problem }, "signed_in", "Implementer");
  if (refusal === null) throw new Error("the dispatch was expected to be refused");
  return refusal;
}

function comment(overrides: Partial<CommentView>): CommentView {
  return {
    id: "c1",
    authorType: "engine",
    authorName: "EO",
    authorRole: null,
    runId: null,
    parentId: null,
    canApprove: false,
    body: "",
    kind: "escalation",
    options: null,
    pinned: false,
    createdAt: 100,
    awaitingHuman: false,
    mirroredInJira: false,
    ...overrides,
  };
}

/** The comment as the item thread draws it, and the text a person reads in it. */
function drawn(body: CommentView): HTMLElement {
  const { container } = render(
    <MemoryRouter>
      <QueryClientProvider client={createQueryClient()}>
        <CommentThread
          comment={body}
          replies={[]}
          mentionables={[]}
          busy={false}
          readOnly={false}
          pinning={new Map()}
          onTogglePin={() => {}}
          onDelete={() => {}}
          onReply={async () => {}}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  const article = container.querySelector("article");
  if (!article) throw new Error("the thread drew no comment");
  return article;
}

describe("paths in the comments EO writes itself (EO-830)", () => {
  it("draws every backslash of the paths in FORT-83's escalation, those before a dot among them", () => {
    const body = fort83Escalation();
    const text = drawn(comment({ body })).textContent ?? "";

    expect(text).toContain(`EO could not remove ${APP_DATA_ROOT}\\${AGENT}\\${ITEM}\\skills,`);
    expect(text).toContain(LOCK);
    expect(text).toContain(SKILLS);
    expect(text).toContain("C:\\Users\\name\\.eo\\codex-homes\\");
    // The text above is the whole sentence still: only how the paths are written changed.
    expect(text).toContain("Implementer runs with a Codex home of its own");
    expect(text).toContain("Then reply here to retry.");
  });

  it("draws every backslash of an old home's real sessions directory, which EO left alone", () => {
    const text = drawn(comment({ body: realSessionsEscalation(PROFILE_ROOT) })).textContent ?? "";

    expect(text).toContain(`${PROFILE_ROOT}\\${AGENT}\\sessions is a real directory rather than a link, so EO left ${PROFILE_ROOT}\\${AGENT} alone`);
  });

  it("would lose those backslashes written as plain text, which is what the code spans are for", () => {
    const text = drawn(comment({ body: `EO could not remove ${LOCK}.` })).textContent ?? "";

    expect(text).not.toContain(LOCK);
    expect(text).toContain(`C:\\Users\\name.eo\\codex-homes\\`);
    expect(text).toContain(`${ITEM}.sqlite-maintenance.lock`);
  });

  it("draws every backslash of a path in git's own refusal, which EO quotes whole", () => {
    // The shape \`rebaseOntoBase\` writes when git refuses before a rebase
    // starts; the refusal names the repository the way git does.
    const refusal = "fatal: detected dubious ownership in repository at 'C:\\Users\\name\\.eo\\repo'";
    const body = `Rebasing \`eo/FORT-83\` onto \`main\` failed: ${codeSpan(refusal)}`;
    const text = drawn(comment({ body, kind: "note" })).textContent ?? "";

    expect(text).toContain("'C:\\Users\\name\\.eo\\repo'");
  });

  it("keeps the backslashes of a long reason cut short, the path it cuts in among them", () => {
    // Two hooks under a deep checkout, in the words \`describeHookEscape\`
    // uses, cut to 500 characters the way \`sayable\` cuts a reason.
    const deep = `C:\\Users\\name\\.eo\\worktrees\\${"d".repeat(180)}\\my-repo\\.git\\hooks\\`;
    const hooks = [`${deep}post-commit`, `${deep}post-merge`];
    const reason = `CodeWiki installed git hooks into this repository at ${hooks.map(codeSpan).join(", ")} and EO could not remove them.`;
    const cut = (line: string) => `${cutKeepingCodeSpans(line, 500)}…`;
    expect(reason.length).toBeGreaterThan(500);

    const text = drawn(comment({ body: cut(reason), kind: "note" })).textContent ?? "";

    expect(text).toContain(hooks[0]);
    expect(text).toContain(`${hooks[0]}, C:\\Users\\name\\.eo\\worktrees\\ddd`);
    expect(text).not.toContain("`");
    // A plain cut leaves the second span open, and markdown takes its backslashes.
    const plain = drawn(comment({ body: `${reason.slice(0, 500)}…`, kind: "note" })).textContent ?? "";
    expect(plain).not.toContain(`, C:\\Users\\name\\.eo\\worktrees\\`);
  });

  it("leaves what a person writes as markdown: their \\* is a literal asterisk", () => {
    const article = drawn(comment({ authorType: "human", authorName: "Ana", kind: "note", body: "Use \\*.lock, not *every* file." }));

    expect(article.textContent).toContain("Use *.lock, not every file.");
    expect(article.querySelector("em")?.textContent).toBe("every");
  });
});
