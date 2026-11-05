import type { RepositoryIndexAnswers, RepositoryIndexHit, RepositoryIndexQuestion } from "@eo/core";
import { describe, expect, it, vi } from "vitest";
import { broadSearchIn, broadSearchInCommand, repositorySearchNudge } from "./broadSearch.js";

/**
 * Both sides of the line, named as commands rather than as categories
 * (EO-165).
 *
 * The acceptance criterion asks for concrete commands on both sides, and
 * that is the right shape for this particular test: the risk here is not
 * that the idea is wrong, it is that a command somebody actually types
 * lands on the wrong side of it. So the negative list is longer than the
 * positive one and is written out of the check suite, the git commands,
 * the builds and the file reads that a real EO run is mostly made of.
 *
 * The vocabulary below is a stand-in, not CodeWiki's. Nothing in this
 * file may know what the index is called — that is one file's business
 * and it is `codewiki/provider.ts` — and using fake names here is how
 * the test stays true when the implementation changes.
 */
const ANSWERS: RepositoryIndexAnswers = {
  symbol: "idx_symbol",
  area: "idx_area",
  reach: ["idx_callers", "idx_impact"],
  files: "idx_files",
};

const WORKTREE = "/home/someone/.eo/worktrees/EO-165";

const qualify = (tool: string): string => `mcp__repo__${tool}`;

/**
 * An index that holds whatever it is asked about (EO-173).
 *
 * The default for every test in this file that is about *classification*
 * — which side of the line a command falls on, and what the sentence
 * says. Those tests were written before the index was consulted at all
 * and they are still about the same thing; handing them an index that
 * always answers keeps them asking their own question rather than
 * quietly becoming tests of the lookup.
 *
 * Two hits rather than one, and deliberately: a single hit is the case
 * where *where* it is starts to matter, and that rule gets its own tests
 * below instead of being smuggled into every assertion here.
 */
const knowsEverything = async (question: RepositoryIndexQuestion): Promise<RepositoryIndexHit[]> =>
  question.of === "symbol"
    ? [
        { name: question.name, path: "apps/desktop/src/main/providers/claude.ts" },
        { name: question.name, path: "packages/engine/src/routing.ts" },
      ]
    : [
        { name: "apps/desktop/src/main/providers/claude.ts", path: "apps/desktop/src/main/providers/claude.ts" },
        { name: "packages/engine/src/routing.ts", path: "packages/engine/src/routing.ts" },
      ];

/** An index that holds exactly these and nothing else. */
const holding =
  (...held: RepositoryIndexHit[]) =>
  async (): Promise<RepositoryIndexHit[]> =>
    held;

// The sentence alone, which is what most of this file is about. The
// classification beside it has its own tests below and in
// `claude.test.ts`, where it reaches the run's event log.
const nudge = async (
  tool: string,
  input: unknown,
  root: string | undefined = WORKTREE,
  knows: (question: RepositoryIndexQuestion) => Promise<RepositoryIndexHit[]> = knowsEverything,
): Promise<string | null> => (await repositorySearchNudge({ tool, input, answers: ANSWERS, knows, qualify, root }))?.nudge ?? null;

const bash = (command: string): Promise<string | null> => nudge("Bash", { command });

describe("a broad search of the whole checkout", () => {
  /**
   * The shapes EO-159 and EO-162 actually ran, which is the only reason
   * any of them is here. `rg Foo apps packages` is not hypothetical — it
   * is the ripgrep-across-source-directories the story names.
   */
  it.each([
    ["grep -rn transitionItem .", "symbol"],
    ["grep -r transitionItem .", "symbol"],
    ["grep -rn 'transitionItem' apps packages", "symbol"],
    ["grep -R --include='*.ts' transitionItem .", "symbol"],
    ["grep -rn --include '*.ts' transitionItem .", "symbol"],
    ["grep -rne transitionItem .", "symbol"],
    ["grep -rn -e transitionItem .", "symbol"],
    ["grep -rnE 'transitionItem' .", "symbol"],
    ["grep -rn 'transitionItem\\|refuseTransition' .", "symbol"],
    ["rg transitionItem", "symbol"],
    ["rg -n transitionItem apps packages", "symbol"],
    ["rg -A 3 transitionItem .", "symbol"],
    ["rg -t ts transitionItem", "symbol"],
    ["grep -rn transitionItem . | head -20", "symbol"],
    ["find . -name '*.test.ts'", "file"],
    ["find . -type f -name 'claude.ts'", "file"],
    ["fd claudeSdk", "file"],
    ["ls -R apps", "layout"],
    ["ls -R", "layout"],
    ["find apps -type d", "layout"],
  ])("%s is intercepted as a %s search", async (command, kind) => {
    expect(broadSearchInCommand(command, WORKTREE)?.kind, command).toBe(kind);
    expect(await bash(command), command).not.toBeNull();
  });

  it("counts the worktree spelled out in full as the whole tree", () => {
    expect(broadSearchInCommand(`grep -rn transitionItem ${WORKTREE}`, WORKTREE)?.kind).toBe("symbol");
    // …and does not, when the agent is standing somewhere else. A path
    // that deep is a decision, not a sweep.
    expect(broadSearchInCommand(`grep -rn transitionItem ${WORKTREE}`, "/somewhere/else")).toBeNull();
  });

  it("reads the needle off the command so the answer can name it", () => {
    expect(broadSearchInCommand("grep -rn transitionItem .")).toEqual({ kind: "symbol", needle: "transitionItem", within: [] });
    expect(broadSearchInCommand("find . -name '*.test.ts'")).toEqual({ kind: "file", needle: "*.test.ts", within: [] });
  });
});

describe("the tools an agent uses when it is doing its job", () => {
  /**
   * The negative list, and the reason it is this long.
   *
   * EO-165 is explicit that a false positive costs more than a true
   * positive gains: the agent still has to do its work with something
   * interrupting it, and an interception that fires on `pnpm test`
   * teaches an agent to stop reading interceptions. Every entry here is
   * a command that appears in EO's own runs.
   */
  it.each([
    // The check suite.
    "pnpm test",
    "pnpm typecheck",
    "pnpm lint",
    "pnpm exec vitest run --root apps/desktop src/main/repositoryIntelligence/broadSearch.test.ts",
    "pnpm exec vitest run --reporter dot",
    // Builds and package management.
    "pnpm build",
    "pnpm install --frozen-lockfile",
    "npm ci",
    "pnpm -w run build",
    "node scripts/index-adoption.mjs",
    // Git, all of it — including the search-shaped ones.
    "git status --porcelain",
    "git diff --stat",
    "git log --oneline -20",
    "git add apps/desktop/src/main/repositoryIntelligence/broadSearch.ts",
    "git commit -m 'EO-165'",
    "git grep -n transitionItem",
    "git rev-parse HEAD",
    // Reading a file somebody already found.
    "cat apps/desktop/src/main/providers/claude.ts",
    "sed -n '440,780p' apps/desktop/src/main/providers/claude.ts",
    "head -40 packages/core/src/agent-provider.ts",
    "wc -l apps/desktop/src/main/providers/*.ts",
    "grep -n transitionItem packages/engine/src/routing.ts",
    // Writing files.
    "sed -i 's/foo/bar/' packages/engine/src/routing.ts",
    "echo 'export const x = 1;' > packages/engine/src/x.ts",
    "mkdir -p apps/desktop/src/main/repositoryIntelligence",
    "rm -rf out",
    // Looking around a directory the agent has already chosen.
    "ls apps/desktop/src/main",
    "ls -la",
    "rg transitionItem apps/desktop/src/main/providers",
    "grep -rn transitionItem packages/engine/src",
    "find apps/desktop/src/main/repositoryIntelligence -name '*.test.ts'",
    "grep -rn transitionItem ./packages/engine/src",
    // A search for something no index of declarations holds.
    "grep -rn 'every agent has always had' .",
    "rg 'the engine owns transitions' .",
    "grep -rn 'text-ink-subtle' .",
    // A find that is doing work rather than asking a question.
    "find . -name '*.tmp' -delete",
    "find . -name 'node_modules' -exec rm -rf {} +",
  ])("%s is never intercepted", async (command) => {
    expect(broadSearchInCommand(command, WORKTREE), command).toBeNull();
    expect(await bash(command), command).toBeNull();
  });

  it("leaves a compound command alone when no part of it is a broad search", async () => {
    expect(await bash("cd apps/desktop && pnpm exec vitest run src/main && git status --porcelain")).toBeNull();
  });
});

describe("the same question asked through Claude's own search tools", () => {
  it("intercepts a repository-wide Grep and a repository-wide Glob", async () => {
    expect(await nudge("Grep", { pattern: "transitionItem" })).not.toBeNull();
    expect(broadSearchIn({ tool: "Glob", input: { pattern: "**/*.test.ts" } })).toEqual({ kind: "file", needle: "**/*.test.ts", within: [] });
  });

  it("leaves one that was already pointed at a directory alone", async () => {
    expect(await nudge("Grep", { pattern: "transitionItem", path: "packages/engine/src" })).toBeNull();
    expect(await nudge("Glob", { pattern: "*.test.ts", path: "apps/desktop/src/main/providers" })).toBeNull();
  });

  it("says nothing about a tool that is not a search at all", async () => {
    expect(await nudge("Read", { file_path: "packages/engine/src/routing.ts" })).toBeNull();
    expect(await nudge("Write", { file_path: "packages/engine/src/x.ts", content: "grep -rn foo ." })).toBeNull();
  });

  it("survives arguments that are not the shape they should be", async () => {
    expect(await nudge("Bash", null)).toBeNull();
    expect(await nudge("Bash", { command: 42 })).toBeNull();
    expect(await nudge("Grep", {})).toBeNull();
  });
});

describe("a run without repository intelligence", () => {
  /**
   * The criterion in as many words: nothing is intercepted when there is
   * no index on this run, *for any reason*. Every reason arrives here as
   * the same thing — no vocabulary — because the provider is the only
   * party that could have supplied one, and a run with no provider, no
   * binary, no index or the feature switched off has no provider to ask.
   */
  it("says nothing at all, however loud the search", async () => {
    for (const command of ["grep -rn transitionItem .", "rg transitionItem apps packages", "find . -name '*.ts'", "ls -R"]) {
      const request = { tool: "Bash", input: { command }, qualify, root: WORKTREE };
      expect(await repositorySearchNudge({ ...request, answers: undefined, knows: knowsEverything }), command).toBeNull();
      // And the same when there is vocabulary but no way to check it
      // (EO-173): a suggestion nobody could check is not made.
      expect(await repositorySearchNudge({ ...request, answers: ANSWERS, knows: undefined }), command).toBeNull();
    }
  });
});

describe("what the agent is told", () => {
  it("names the call rather than the capability", async () => {
    const message = await bash("grep -rn transitionItem .");
    expect(message).toContain("mcp__repo__idx_symbol");
    expect(message).toContain("transitionItem");
    // The half no text search can do at all, which is the only honest
    // reason to interrupt somebody mid-grep.
    expect(message).toContain("mcp__repo__idx_callers");
    expect(message).toContain("mcp__repo__idx_impact");
  });

  it("names the file tool for a file hunt and a layout walk", async () => {
    expect(await bash("find . -name '*.test.ts'")).toContain("mcp__repo__idx_files");
    expect(await bash("ls -R")).toContain("mcp__repo__idx_files");
  });

  it("says the command was not blocked, because it was not", async () => {
    for (const command of ["grep -rn transitionItem .", "find . -name '*.ts'", "ls -R"]) {
      expect(await bash(command), command).toContain("not blocked");
    }
  });

  it("stays short enough to be worth re-sending on every later turn", async () => {
    // It goes into the conversation and is paid for again on each turn
    // after that. Anything much longer than this is a paragraph, and a
    // paragraph is the prompt route EO-164 measured as inert.
    for (const command of ["grep -rn transitionItem .", "find . -name '*.ts'", "ls -R"]) {
      expect(((await bash(command)) ?? "").length, command).toBeLessThan(500);
    }
  });
});

/**
 * The rule EO-173 adds, and the one the other tests in this file
 * deliberately do not exercise: before it says anything, it asks the
 * index whether the index has anything to say.
 *
 * Everything above hands over `knowsEverything`, so everything above is
 * still a test of classification. This block is where the index answers
 * something other than yes.
 */
describe("asking the index before suggesting it", () => {
  const at = (path: string, name = "needle"): RepositoryIndexHit => ({ name, path });

  it("says nothing about a name the index has never heard of", async () => {
    // The `hook_response` case from run 01a0491b: a message-type string
    // that appears once, as a literal, in a comparison. It is declared
    // nowhere, so a symbol index has nothing to say and a text search
    // has everything to say.
    expect(await nudge("Bash", { command: "grep -rn hook_response ." }, WORKTREE, holding())).toBeNull();
  });

  it("says nothing when the index only matched something else", async () => {
    // The shape this story is named for. Asked about `quota`, the index
    // answers `QuotaEvent` — which is not where `quota` is declared, it
    // is the observation that the word appears in some names. That is
    // the substring question the agent was already asking, answered
    // worse.
    const loosely = holding(at("packages/core/src/agent-provider.ts", "QuotaEvent"), at("apps/desktop/src/main/quotaBanner.tsx", "QuotaBanner"));
    expect(await nudge("Bash", { command: "grep -rn quota ." }, WORKTREE, loosely)).toBeNull();
  });

  it("speaks when the index holds that exact name", async () => {
    const exactly = holding(at("packages/core/src/agent-provider.ts", "quota"));
    expect(await nudge("Bash", { command: "grep -rn quota ." }, WORKTREE, exactly)).toContain("mcp__repo__idx_symbol");
  });

  it("says nothing when the one thing it found is not where the agent is looking", async () => {
    // `rg needle apps packages` says where the agent is working. An
    // index whose only hit is a local in a renderer component nobody
    // asked about has found something else, and "it is not where you are
    // looking, it is over here" is a suggestion this deliberately gives
    // up in exchange for the credibility of the ones it does make.
    const elsewhere = holding(at("scripts/index-adoption-trial.mjs"));
    expect(await nudge("Bash", { command: "rg needle apps packages" }, WORKTREE, elsewhere)).toBeNull();
    // Inside one of them, and it speaks.
    const inside = holding(at("packages/engine/src/routing.ts"));
    expect(await nudge("Bash", { command: "rg needle apps packages" }, WORKTREE, inside)).not.toBeNull();
  });

  it("does not apply that rule to a name declared in several places", async () => {
    // A name the index holds more than once is a name it genuinely
    // knows. Where those declarations are is then the agent's business,
    // and is exactly what the call being suggested would tell it.
    const several = holding(at("scripts/index-adoption-trial.mjs"), at("scripts/other.mjs"));
    expect(await nudge("Bash", { command: "rg needle apps packages" }, WORKTREE, several)).not.toBeNull();
  });

  it("does not apply it to a search that named nowhere in particular", async () => {
    // An agent searching the whole tree asked about the whole tree, so
    // there is no "somewhere else" to be in. Claiming otherwise would be
    // EO inventing a scope the agent never stated.
    const anywhere = holding(at("scripts/index-adoption-trial.mjs"));
    expect(await nudge("Bash", { command: "rg needle ." }, WORKTREE, anywhere)).not.toBeNull();
  });

  it("asks about the needle, and asks nothing when there was no broad search", async () => {
    const asked: RepositoryIndexQuestion[] = [];
    const recording = async (question: RepositoryIndexQuestion): Promise<RepositoryIndexHit[]> => {
      asked.push(question);
      return [];
    };
    await nudge("Bash", { command: "grep -rn transitionItem ." }, WORKTREE, recording);
    await nudge("Bash", { command: "find . -name '*.test.ts'" }, WORKTREE, recording);
    await nudge("Bash", { command: "ls -R" }, WORKTREE, recording);
    expect(asked).toEqual([
      { of: "symbol", name: "transitionItem" },
      { of: "file", pattern: "*.test.ts" },
      // A walk with no needle in it wants to know what is in the tree,
      // so what the index is asked is whether it holds any of it.
      { of: "file", pattern: "*" },
    ]);

    // The classification runs first, so a command that was never a broad
    // search costs no lookup at all. This is what keeps the cost
    // proportional to how narrow the classifier already is.
    asked.length = 0;
    await nudge("Bash", { command: "pnpm test" }, WORKTREE, recording);
    await nudge("Bash", { command: "git status --porcelain" }, WORKTREE, recording);
    await nudge("Read", { file_path: "packages/engine/src/routing.ts" }, WORKTREE, recording);
    expect(asked).toEqual([]);
  });

  it("fails open when the index cannot be asked", async () => {
    const threw = async (): Promise<RepositoryIndexHit[]> => {
      throw new Error("no index here");
    };
    expect(await nudge("Bash", { command: "grep -rn transitionItem ." }, WORKTREE, threw)).toBeNull();

    // Including a provider that throws before it ever returns a promise,
    // which is a different code path and the one a `Promise.race` would
    // not have caught.
    const threwFirst = (): Promise<RepositoryIndexHit[]> => {
      throw new Error("not even started");
    };
    expect(await nudge("Bash", { command: "grep -rn transitionItem ." }, WORKTREE, threwFirst)).toBeNull();
  });

  it("gives up rather than holding the tool call open", async () => {
    vi.useFakeTimers();
    try {
      // An index that never answers. What is waiting on this is a tool
      // call the agent already made, so the deadline is the whole point:
      // silence is a cost the agent does not notice and a stalled call is
      // one it does.
      const never = (): Promise<RepositoryIndexHit[]> => new Promise(() => {});
      const answered = nudge("Bash", { command: "grep -rn transitionItem ." }, WORKTREE, never);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await answered).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not leave its deadline running once the index has answered", async () => {
    vi.useFakeTimers();
    try {
      const held = holding(at("packages/engine/src/routing.ts", "transitionItem"));
      expect(await nudge("Bash", { command: "grep -rn transitionItem ." }, WORKTREE, held)).not.toBeNull();
      // A timer still pending here would keep the event loop — and in
      // production the Electron main process — alive for every search an
      // agent makes.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The number to beat, from the item: run `01a0491b` fired eight
 * interceptions and the agent took one.
 *
 * Each row is one of those eight, with what the index would answer about
 * it. Seven of them were advice that could not be taken, and the eighth
 * — the only genuine declared type in the set — is the one the agent
 * acted on. The rule is that this file's answers should be the agent's:
 * silence where the agent was right to ignore it, a sentence where it
 * was right to listen.
 *
 * Two of the eight never reach the lookup at all, and that is not a
 * cheat. `find /` is a search of the machine and `cd elsewhere && find
 * .` is a search of another directory entirely; an index of *this*
 * checkout was never going to answer either, and the classifier now says
 * so without asking.
 */
describe("the eight interceptions of run 01a0491b, as this now answers them", () => {
  const held = (...hits: Array<[string, string]>) => holding(...hits.map(([name, path]) => ({ name, path })));
  const nothing = holding();

  it.each([
    [
      "a message type that is only ever a literal",
      "grep -rn hook_response .",
      nothing,
    ],
    [
      "a field the agent was checking the existence of, which does not exist",
      "rg tool_use_id apps/desktop/src",
      nothing,
    ],
    [
      "a short word searched as a substring, first time",
      "grep -rn quota .",
      held(["QuotaEvent", "packages/core/src/agent-provider.ts"]),
    ],
    [
      "the same short word again",
      "rg quota apps packages",
      held(["QuotaEvent", "packages/core/src/agent-provider.ts"]),
    ],
    [
      "a name whose only declaration is a local in an unrelated component",
      "rg draft apps/desktop/src/main packages",
      held(["draft", "apps/desktop/src/renderer/src/discussions/Compose.tsx"]),
    ],
    [
      "a search of the whole machine for a dependency's typings",
      "find / -name '*.d.ts' -path '*claude-agent-sdk*'",
      knowsEverything,
    ],
    [
      "a walk of a directory that is not this checkout",
      "cd /home/someone/other/node_modules/@anthropic-ai && find . -type f",
      knowsEverything,
    ],
  ])("stays quiet about %s", async (_case, command, knows) => {
    expect(await nudge("Bash", { command }, WORKTREE, knows), command).toBeNull();
  });

  it("still speaks about the one that was worth taking", async () => {
    // A genuine declared type. This is the suggestion the agent acted
    // on, and losing it is the failure mode the item rules out by
    // name: a blunter matcher would have dropped the symbol case and
    // taken this with it.
    const declared = held(["SearchInterceptionEvent", "packages/core/src/run-events.ts"]);
    expect(await nudge("Bash", { command: "grep -rn SearchInterceptionEvent ." }, WORKTREE, declared)).toContain("mcp__repo__idx_symbol");
  });
});
