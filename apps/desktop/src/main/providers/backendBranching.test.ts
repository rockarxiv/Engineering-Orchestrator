import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Invariant 12, as a guard on where a backend may be named (EO-380):
 * *a capability reaches both backends, or names the one it does not*.
 *
 * `providerParity.test.ts` holds the two adapters to one list of
 * capabilities. This holds everything else to not needing one. A line
 * outside the adapters that asks "is this Claude?" is a place where EO
 * does something for one backend and not the other, and every one of the
 * ten gaps the audit found (ASK-21) either started as such a line or was
 * hidden behind one — while each adapter's own tests went on passing.
 *
 * So the lines are written down. Code may branch on `"claude"` or
 * `"codex"` inside `providers/` and `runtimes/`, where a backend's
 * spelling and delivery are the whole job, and on the sign-in screens,
 * where the two CLIs really do sign in differently and the person is
 * looking at exactly one of them. Anywhere else, each such line is on
 * the allowlist below with the reason it has to be there, and a new one
 * fails this test until somebody either removes the branch or writes
 * down why not.
 *
 * It is `packs/importAllowlist.test.ts` with a different question, and
 * strikes the same bargain: an entry whose line has gone fails too, so
 * the list shrinks with the code rather than behind it.
 *
 * **What counts as branching.** A comparison against the literal
 * (`=== "claude"`, `!== "codex"`, either way round, loose or strict,
 * on one line or broken across two), a `case "claude":`, and a
 * membership test that names one — `["codex"].includes(provider)`,
 * `new Set(["claude"]).has(provider)`, `enabled.includes("codex")`.
 * Found in the syntax tree, so the literal counts however it is wrapped
 * (`("codex")`, `"codex" as Backend`) and wherever a comment sits beside
 * it, and a comment or a string that merely mentions one does not.
 * Naming a backend is not branching — a key in a
 * table, an argument, a default — and a table keyed by backend is in
 * fact the shape this guard pushes code towards, since a missing key
 * there is a type error rather than a silent `else`.
 *
 * **What is not scanned.** Test files. A fixture that answers
 * differently for each backend is describing the two backends, not
 * making EO behave differently for them, and listing forty of those
 * would bury the handful of product lines the list exists to show.
 *
 * **How to shrink it.** Delete the branch, then delete the entry, in
 * the same change.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..", "..");

/** Where a backend's id is the subject matter. Repository-relative. */
const MAY_BRANCH = [
  { path: "apps/desktop/src/main/providers/", why: "the adapters, and what is known about each backend" },
  { path: "apps/desktop/src/main/runtimes/", why: "installing each backend's CLI and asking it who is signed in" },
  { path: "apps/desktop/src/renderer/src/chat/views/agents/SignIn.tsx", why: "the sign-in screen: the two CLIs sign in differently" },
] as const;

interface Allowed {
  readonly file: string;
  /** Why these lines have to ask which backend it is, and what would let them stop. */
  readonly why: string;
  /**
   * The lines, trimmed, exactly as written. By text rather than by
   * number, so that an edit above one does not fail the test and an edit
   * *to* one does — a changed branch is a new branch. A line that occurs
   * twice in a file is listed twice.
   */
  readonly lines: readonly string[];
}

const ALLOWLIST: readonly Allowed[] = [
  {
    file: "apps/desktop/src/main/engine.ts",
    why: "The composition root, where an agent's backend id is turned into the adapter that runs it. The `switch` is that one decision, and it is the only place outside `providers/` that constructs either adapter.",
    lines: ['case "codex":', 'case "claude":'],
  },
  {
    file: "apps/desktop/src/main/engine.ts",
    why: "Resolving a runtime for the two backends that have one. `RUNTIMES` is keyed by exactly these ids, and `fake`, `scripted` and `demo` have no executable to find, so the guard narrows a free-form provider string to the table's keys rather than choosing between the two.",
    lines: ['if (agent.provider !== "claude" && agent.provider !== "codex") return null;', 'if (provider !== "claude" && provider !== "codex") return null;'],
  },
  {
    file: "apps/desktop/src/main/engine.ts",
    why: "Claude is an SDK EO imports as well as a binary it spawns, and Codex is a binary alone (EO-372), so only one of them has an entry path to resolve. Delivery, not capability: both end up runnable.",
    lines: ['sdkEntryPath: agent.provider === "claude" ? resolvePackageSet(runtimeRoot, CLAUDE_SDK) : null,'],
  },
  {
    file: "apps/desktop/src/main/engine.ts",
    why: "An API key typed into EO is held by EO only for Claude, which reads it from its environment at spawn (EO-84); Codex's key is handed to its CLI, which keeps it. The preflight has to know about the one `claude auth status` cannot see.",
    lines: ['storedKey: agent.provider === "claude" && hasApiKey(apiKeys, "claude"),'],
  },
  {
    file: "apps/desktop/src/main/engine.ts",
    why: "The lockdown is the same on both backends and is delivered differently (EO-107, EO-378): Claude takes options, Codex needs a home directory of its own made ready before the launch, and a sign-in in the OS keyring cannot be carried into one. These two are that preparation and the notice a dispatch carries when it could not be done.",
    lines: [
      'if (!verdict.ok || agent.provider !== "codex" || !codexHomeRoots || inheritsAmbientConfig(agent.config)) return verdict;',
      'if (agent.provider !== "codex" || inheritsAmbientConfig(agent.config)) return [];',
    ],
  },
  {
    file: "apps/desktop/src/main/ipc/conversationView.ts",
    why: "The two backends store reasoning effort under different config keys (`effort`, `reasoningEffort`), each the name its own SDK uses. Both have the setting; this reads it from where it was saved.",
    lines: ['const effortKey = agent.provider === "claude" ? "effort" : "reasoningEffort";'],
  },
  {
    file: "apps/desktop/src/main/ipc/handlers.ts",
    why: "Both backends list their models live, and each is asked in its own way: the Codex binary's app-server, and the Claude SDK. One capability, two fetchers, chosen here because the handler holds what each needs.",
    lines: ['payload.provider === "codex"'],
  },
  {
    file: "apps/desktop/src/main/ipc/runtimeCommands.ts",
    why: "The IPC face of `runtimes/`: narrowing a channel's free-form string to the two backends EO manages a runtime for. Not a choice between them.",
    lines: ['if (value === "codex") return "codex";', 'if (value === "claude" || value === CLAUDE_SDK.id) return "claude";', 'if (provider !== "codex" && provider !== "claude") return true;'],
  },
  {
    file: "apps/desktop/src/main/ipc/runtimeCommands.ts",
    why: "Claude's runtime is two downloads — the CLI and the SDK EO imports — where Codex's is one. Installing, sizing, pruning and reporting a runtime all have to count the second package, or a Claude agent is reported ready on a machine that cannot load it.",
    lines: [
      'return provider === "claude" ? ["claude@", `${CLAUDE_SDK.id}@`] : ["codex@"];',
      'if (provider === "claude") {',
      'return provider !== "claude" || resolvePackageSet(context.root, CLAUDE_SDK) !== null;',
      'if (input.provider === "claude") {',
      'if (provider === "claude") active.add(`${CLAUDE_SDK.id}@${CLAUDE_SDK.version}`);',
      'if (provider === "claude" && !resolvePackageSet(context.root, CLAUDE_SDK)) {',
    ],
  },
  {
    file: "apps/desktop/src/main/ipc/runtimeCommands.ts",
    why: "Signing in with an API key, which is these handlers' half of the sign-in screens: Codex's CLI takes the key and keeps it, and Claude has no such command, so EO holds that one itself (EO-84) — and only a key EO holds can be removed by EO.",
    lines: ['return provider === "claude" && hasApiKey(context.apiKeys, "claude");', 'if (input.provider === "codex") {', 'if (input.provider === "codex") {'],
  },
  {
    file: "apps/desktop/src/main/ipc/runtimeCommands.ts",
    why: "Whether a Codex agent can be locked down on this machine at all (EO-378): a sign-in the Codex CLI keeps in the OS keyring cannot be carried into an agent's own home. Claude's lockdown needs no home, so there is nothing to report for it.",
    lines: ['...(managed === "codex" && signInIsInKeyring(personCodexHome(machine.env ?? process.env, machine.home ?? homedir())) ? { codexSignInInKeyring: true } : {}),'],
  },
  {
    file: "apps/desktop/src/main/mcpHost/aliasUse.ts",
    why: "Not an agent backend, for the reason given for `clients.ts` below: this names the *client* that connected to EO's own MCP server from what it reported itself as, so that a row in the list of connections reads \"Codex\" rather than a user-agent string.",
    lines: ['if (normalised.includes("codex")) return "codex";'],
  },
  {
    file: "apps/desktop/src/main/mcpHost/clients.ts",
    why: "Not an agent backend. These are the *clients* EO's own MCP server can be registered with — Claude Code, Codex, Claude Desktop — where a person's own tool connects to EO, and each has its own `mcp add`. The id happens to be spelled the same.",
    lines: ['if (id === "claude-code" || id === "codex") {', 'if (id === "codex") {'],
  },
  {
    file: "apps/desktop/src/renderer/src/chat/views/agents/AgentEditor.tsx",
    why: "Reasoning effort, which both backends have: Claude says per model whether it is supported and Codex supports it on every model, and each saves it under its own SDK's key — read in one place, `effortKeyOf`, by the agent's own field and by the system agent's consolidation override (EO-578).",
    lines: [
      'return provider === "claude" ? "effort" : "reasoningEffort";',
      'const showEffort = efforts.length > 0 && (provider !== "claude" || (chosen?.supportsEffort ?? false));',
    ],
  },
  {
    file: "apps/desktop/src/renderer/src/chat/views/agents/AgentEditor.tsx",
    why: "The same opt-out tickbox on both backends (EO-107, EO-378), drawn once for each because the words under it name what that backend gives back — `~/.claude` or `~/.codex` — and Codex's carries the keyring notice beside it.",
    lines: [
      'const keyringNotice = draft.provider === "codex" && runtime?.codexSignInInKeyring === true && draft.config["inheritAmbientConfig"] !== true;',
      '{draft.provider === "claude" ? (',
      '{draft.provider === "codex" ? (',
    ],
  },
  {
    file: "apps/desktop/src/renderer/src/shared/agents/signIn.ts",
    why: "The sign-in screen's words, kept apart from the screen (EO-519): what the first step says and who keeps a typed key, which differ because the two CLIs sign in differently. Listed by line rather than exempted as a sign-in screen, because this module is shared code and not a screen.",
    lines: ['if (runtime.id === "codex") {', 'if (runtime.id === "codex") {'],
  },
  {
    file: "packages/core/src/mcpConnect.ts",
    why: "Not an agent backend, for the reason given for `clients.ts` above: the command a person pastes to connect their own Codex to EO's MCP server, built once for the registration and for Settings so neither can put the token back on a command line (EO-601).",
    lines: ['if (client === "codex") return [shellCommand("codex", codexAddArgs(url)), exportLine(MCP_TOKEN_VAR, token)].join("\\n");'],
  },
];

const SELF = relative(repoRoot, fileURLToPath(import.meta.url)).split(sep).join("/");

const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

function codeFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "out") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...codeFiles(full));
    else if (entry.isFile() && CODE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) && !entry.name.endsWith(".d.ts")) files.push(full);
  }
  return files;
}

/** The literal has to appear as text for a file to hold a branch on it, so everything else is never parsed. */
const NAMES_A_BACKEND = /["'`](?:claude|codex)["'`]/;
const BACKEND_IDS = new Set(["claude", "codex"]);
/** The ways of asking whether a value is one of a set: `[..].includes(x)`, `new Set([..]).has(x)`, `list.includes("codex")`. */
const MEMBERSHIP = new Set(["includes", "indexOf", "has", "some", "every", "find", "filter"]);

/** An expression with everything that changes how it is written and not what it is taken off: `("codex")`, `"codex" as Backend`, `x!`. */
function bare(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** The literal itself, when this expression is a backend's id written out. */
function backendLiteral(node: ts.Expression): ts.Node | null {
  const inner = bare(node);
  return (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) && BACKEND_IDS.has(inner.text) ? inner : null;
}

/** The array literal a membership test is asked of, when it names a backend: `[..]`, `([..] as const)`, `new Set([..])`. */
function backendList(node: ts.Expression): ts.Node | null {
  const inner = bare(node);
  if (ts.isArrayLiteralExpression(inner)) return inner.elements.some((element) => backendLiteral(element) !== null) ? inner : null;
  if (ts.isNewExpression(inner) || ts.isCallExpression(inner)) {
    for (const argument of inner.arguments ?? []) if (backendList(argument) !== null) return inner;
  }
  return null;
}

const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken]);

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * The lines of a source that branch on a backend's id — trimmed, in
 * order, repeats kept.
 *
 * Read off the syntax tree rather than matched in the text. The first
 * two versions of this were regular expressions, and each was a list of
 * spellings somebody had thought of: a comparison broken across lines
 * got past the first, and a literal in parentheses and a branch written
 * after a block comment got past the second. A parser has no spellings
 * to forget — a comment is not in the tree at all, and `("codex")` is
 * the same literal with a node round it.
 *
 * What is reported is the lines the branch itself is written on — the
 * operator and the literal, the `case` and its label, the list and the
 * method asked of it — joined by a space when that is more than one, so
 * it reads and is allowlisted as the one expression it is. A line
 * holding two branches is one line.
 */
function branchingLines(source: string, path = "source.tsx"): string[] {
  if (!NAMES_A_BACKEND.test(source)) return [];
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, scriptKind(path));
  const lines = source.split("\n").map((line) => line.trim());
  const lineOf = (position: number): number => file.getLineAndCharacterOfPosition(position).line;

  const spans = new Map<string, { first: number; last: number }>();
  const found = (from: number, to: number): void => {
    const first = lineOf(Math.min(from, to));
    const last = lineOf(Math.max(from, to));
    spans.set(`${first}-${last}`, { first, last });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      // `x === "claude"`, `"codex" != x`, `x === ("codex")`
      for (const side of [node.left, node.right]) {
        const literal = backendLiteral(side);
        if (literal) found(Math.min(literal.getStart(file), node.operatorToken.getStart(file)), Math.max(literal.getEnd(), node.operatorToken.getEnd()) - 1);
      }
    } else if (ts.isCaseClause(node) && backendLiteral(node.expression)) {
      // `case "claude":`
      found(node.getStart(file), node.expression.getEnd() - 1);
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && MEMBERSHIP.has(node.expression.name.text)) {
      const asked = node.expression;
      // `["codex"].includes(x)`, `new Set(["claude", "codex"]).has(x)`
      const list = backendList(asked.expression);
      if (list) found(list.getStart(file), asked.name.getEnd() - 1);
      // `enabled.includes("codex")`, `managed?.has("claude")`
      const named = node.arguments.map((argument) => backendLiteral(argument)).find((literal) => literal !== null);
      if (named) found(asked.name.getStart(file), named.getEnd() - 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  return [...spans.values()].sort((a, b) => a.first - b.first || a.last - b.last).map(({ first, last }) => lines.slice(first, last + 1).join(" "));
}

const isTest = (path: string): boolean => /\.test\.[cm]?[jt]sx?$/.test(path);
const mayBranch = (path: string): boolean => MAY_BRANCH.some((exempt) => (exempt.path.endsWith("/") ? path.startsWith(exempt.path) : path === exempt.path));

interface SourceFile {
  /** Repository-relative. */
  readonly path: string;
  readonly source: string;
}

interface Line {
  readonly file: string;
  readonly line: string;
}

/** Every branching line in the given files that is not somewhere a backend may be named. */
function branchesOutside(files: readonly SourceFile[]): Line[] {
  return files.filter(({ path }) => !isTest(path) && !mayBranch(path)).flatMap(({ path, source }) => branchingLines(source, path).map((line) => ({ file: path, line })));
}

/**
 * The two ways the list and the tree can disagree, counted rather than
 * merely matched: the same text twice in a file is two branches, and a
 * list that names it once allows one.
 */
function disagreements(found: readonly Line[], allowlist: readonly Allowed[]): { unlisted: Line[]; stale: Line[] } {
  const key = (entry: Line): string => `${entry.file}\n${entry.line}`;
  const remaining = new Map<string, number>();
  for (const entry of allowlist.flatMap(({ file, lines }) => lines.map((line) => ({ file, line })))) remaining.set(key(entry), (remaining.get(key(entry)) ?? 0) + 1);

  const unlisted: Line[] = [];
  for (const entry of found) {
    const left = remaining.get(key(entry)) ?? 0;
    if (left === 0) unlisted.push(entry);
    else remaining.set(key(entry), left - 1);
  }
  const stale = [...remaining].flatMap(([entry, left]) => {
    const [file = "", line = ""] = entry.split("\n");
    return Array.from({ length: left }, () => ({ file, line }));
  });
  return { unlisted, stale };
}

const report = (lines: readonly Line[]): string[] => lines.map(({ file, line }) => `${file}: ${line}`);

/** Everything that ships or runs against the product: the app, the pure packages and the scripts. */
const tree: SourceFile[] = [codeFiles(join(repoRoot, "apps", "desktop", "src")), codeFiles(join(repoRoot, "packages")), codeFiles(join(repoRoot, "scripts"))]
  .flat()
  .map((file) => relative(repoRoot, file).split(sep).join("/"))
  .map((path) => ({ path, source: readFileSync(join(repoRoot, path), "utf8") }));

describe("the backend guard scans the tree it claims to", () => {
  it("reaches the main process, the renderer, the scripts and the pure packages", () => {
    const paths = tree.map(({ path }) => path);
    expect(paths).toContain("apps/desktop/src/main/supervisor/runSupervisor.ts");
    expect(paths).toContain("apps/desktop/src/renderer/src/chat/views/agents/AgentEditor.tsx");
    expect(paths).toContain("packages/engine/src/scheduler.ts");
    expect(paths.some((path) => path.startsWith("scripts/"))).toBe(true);
  });

  it("exempts only places that exist, and only the three kinds the invariant names", () => {
    const paths = tree.map(({ path }) => path);
    for (const exempt of MAY_BRANCH) {
      expect(paths.some((path) => mayBranch(path) && path.startsWith(exempt.path)), `${exempt.path} is exempt (${exempt.why}) and is not in the tree`).toBe(true);
    }
    expect(MAY_BRANCH.map((exempt) => exempt.path)).toEqual([
      "apps/desktop/src/main/providers/",
      "apps/desktop/src/main/runtimes/",
      "apps/desktop/src/renderer/src/chat/views/agents/SignIn.tsx",
    ]);
  });
});

describe("architectural invariant: where code may branch on a backend's id", () => {
  it("nothing outside providers/, runtimes/ and the sign-in screens branches on a backend, unless the line is on the allowlist", () => {
    const { unlisted } = disagreements(branchesOutside(tree), ALLOWLIST);
    expect(
      report(unlisted),
      `these lines branch on "claude" or "codex". A capability reaches both backends or names the one it does not (invariant 12): ` +
        `move the difference into the adapters, or add the line to the allowlist in ${SELF} with the reason it has to be here`,
    ).toEqual([]);
  });

  it("every entry is still a line in the tree, so the list shrinks with the code rather than behind it", () => {
    const { stale } = disagreements(branchesOutside(tree), ALLOWLIST);
    expect(report(stale), "these entries no longer match a branching line — delete them from the allowlist in the change that removed or rewrote the branch").toEqual([]);
  });

  it("says why, for every entry", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.why.length, `${entry.file} is allowed without a reason`).toBeGreaterThan(60);
      expect(entry.lines.length, `${entry.file} has a reason and no line`).toBeGreaterThan(0);
    }
  });

  it("allows nothing somewhere a backend may be named anyway, and nothing in a test", () => {
    for (const { file } of ALLOWLIST) {
      expect(mayBranch(file), `${file} is exempt and also on the allowlist — one of the two is wrong`).toBe(false);
      expect(isTest(file), `${file} is a test, which this guard does not scan`).toBe(false);
    }
  });

  it("keeps its files in an order a person can scan", () => {
    const files = ALLOWLIST.map((entry) => entry.file);
    expect(files).toEqual([...files].sort());
  });
});

describe("the scan catches what it claims to (proves it is not a tautology)", () => {
  const file = "apps/desktop/src/main/supervisor/newThing.ts";
  const lines = (source: string): string[] => branchesOutside([{ path: file, source }]).map(({ line }) => line);

  it("sees a comparison either way round, strict or loose, in any quote, and a case", () => {
    expect(lines('if (agent.provider === "claude") steer();')).toHaveLength(1);
    expect(lines("if (agent.provider !== 'codex') return;")).toHaveLength(1);
    expect(lines('const ok = "codex" == run.provider;')).toHaveLength(1);
    expect(lines("return provider === `claude` ? a : b;")).toHaveLength(1);
    expect(lines('switch (p) {\n  case "codex":\n    return 1;\n}')).toEqual(['case "codex":']);
  });

  it("sees a comparison a formatter broke across lines, as the one expression it is", () => {
    expect(lines('const fetched =\n  payload.provider ===\n    "codex"\n    ? a\n    : b;')).toEqual(['payload.provider === "codex"']);
    expect(lines('if (\n  "claude" !==\n  agent.provider\n) return;')).toEqual(['"claude" !==']);
    // Broken before the operator, the comparison is whole on its own line.
    expect(lines('const ok = agent.provider\n  === "codex";')).toEqual(['=== "codex";']);
    expect(lines('switch (p) {\n  case\n    "claude":\n    return 1;\n}')).toEqual(['case "claude":']);
  });

  it("sees a membership test that names a backend, which is a comparison by another name", () => {
    expect(lines('if (["codex"].includes(agent.provider)) return skipBudget();')).toHaveLength(1);
    expect(lines("if (!['claude', 'codex'].includes(provider)) return null;")).toHaveLength(1);
    expect(lines('const steerable = new Set(["claude"]).has(run.provider);')).toHaveLength(1);
    expect(lines('if (enabledProviders.includes("codex")) offerHook();')).toHaveLength(1);
    expect(lines('if (managed?.has("claude")) return;')).toHaveLength(1);
    expect(lines('const priced = [\n  "codex",\n].includes(provider);')).toEqual(['const priced = [ "codex", ].includes(provider);']);
    expect(lines('if (["fake", "codex"].some((id) => id === provider)) return;')).toHaveLength(1);
  });

  it("sees a literal however it is wrapped, because the wrapping is not the comparison", () => {
    expect(lines('if (agent.provider === ("codex")) return;')).toEqual(['if (agent.provider === ("codex")) return;']);
    expect(lines('if (("claude") !== agent.provider) return;')).toHaveLength(1);
    expect(lines('if (agent.provider === ("codex" as Backend)) return;')).toHaveLength(1);
    expect(lines('if (agent.provider === ("codex" satisfies Backend)) return;')).toHaveLength(1);
    expect(lines('switch (p) {\n  case ("claude"):\n    return 1;\n}')).toEqual(['case ("claude"):']);
    expect(lines('if (enabled.includes(("codex"))) return;')).toHaveLength(1);
    expect(lines('if ((["claude", "codex"] as const).includes(provider)) return;')).toHaveLength(1);
  });

  it("sees a branch written after a comment, on the same line or inside the expression", () => {
    expect(lines('/* explanation */ if (agent.provider === "codex") return;')).toEqual(['/* explanation */ if (agent.provider === "codex") return;']);
    expect(lines('/** why */ const steerable = run.provider !== "claude";')).toHaveLength(1);
    expect(lines('if (agent.provider === /* the app-server one */ "codex") return;')).toHaveLength(1);
    expect(lines('if (agent.provider /* which? */ === "codex") return;')).toHaveLength(1);
    expect(lines('return (\n  <div>\n    {/* only one */ draft.provider === "codex" && <Notice />}\n  </div>\n);')).toHaveLength(1);
    // A continuation line that begins the way a comment's does.
    expect(lines('const weight = base\n  * (provider === "claude" ? 1 : 2);')).toEqual(['* (provider === "claude" ? 1 : 2);']);
  });

  it("fails each of those outside the allowed places until it is on the allowlist", () => {
    for (const source of ['/* explanation */ if (agent.provider === "codex") return;', 'if (agent.provider === ("codex")) return;']) {
      const found = branchesOutside([{ path: file, source }]);
      expect(disagreements(found, []), source).toEqual({ unlisted: [{ file, line: source }], stale: [] });
      expect(disagreements(found, [{ file, why: "a reason", lines: [source] }]), source).toEqual({ unlisted: [], stale: [] });
    }
  });

  it("counts a line holding two branches once", () => {
    expect(lines('if (provider !== "claude" && provider !== "codex") return null;')).toHaveLength(1);
  });

  it("does not mistake naming a backend for branching on one", () => {
    // A list of backends that is only a list, and a lookup by one.
    expect(lines('const MANAGED = ["claude", "codex"] as const;')).toEqual([]);
    expect(lines('for (const provider of ["claude", "codex"]) warm(provider);')).toEqual([]);
    expect(lines('const spec = RUNTIMES["codex"];')).toEqual([]);
    expect(lines('if (name.includes("codex-mini")) return small;')).toEqual([]);
    expect(lines('const provider = "claude";')).toEqual([]);
    expect(lines('createProvider({ provider: "codex" });')).toEqual([]);
    expect(lines('const LABELS = { claude: "Claude", codex: "Codex" };')).toEqual([]);
    expect(lines('// when the provider === "claude" the SDK is loaded')).toEqual([]);
    expect(lines('const x = 1; // provider === "claude" was checked here')).toEqual([]);
    expect(lines('/* if (provider === "codex") return; */ const provider = "codex";')).toEqual([]);
    expect(lines('const help = "use provider === \\"codex\\" to filter";')).toEqual([]);
    expect(lines('return <p>{/* shown when provider === "codex" */}</p>;')).toEqual([]);
    expect(lines(' * `provider === "codex"` used to be checked here')).toEqual([]);
    // Another product that begins with the same word is not the backend.
    expect(lines('if (id === "claude-code") return manual;')).toEqual([]);
  });

  it("fails when a new line branches on a backend outside the allowed places", () => {
    const found = branchesOutside([{ path: file, source: 'if (run.provider === "codex") return skipBudget();' }]);
    expect(disagreements(found, [])).toEqual({ unlisted: [{ file, line: 'if (run.provider === "codex") return skipBudget();' }], stale: [] });
  });

  it("passes the same line once it is on the allowlist, and reports the entry when the line goes", () => {
    const line = 'if (run.provider === "codex") return skipBudget();';
    const allowed: Allowed[] = [{ file, why: "a reason", lines: [line] }];
    expect(disagreements(branchesOutside([{ path: file, source: line }]), allowed)).toEqual({ unlisted: [], stale: [] });
    expect(disagreements(branchesOutside([{ path: file, source: "return budget();" }]), allowed)).toEqual({ unlisted: [], stale: [{ file, line }] });
  });

  it("counts a line written twice as two branches", () => {
    const line = 'if (provider === "codex") {';
    const found = branchesOutside([{ path: file, source: `${line}\n}\n${line}\n}` }]);
    expect(disagreements(found, [{ file, why: "a reason", lines: [line] }]).unlisted).toEqual([{ file, line }]);
  });

  it("leaves the adapters, the runtimes, the sign-in screens and tests alone", () => {
    const source = 'if (provider === "claude") return;';
    for (const path of [
      "apps/desktop/src/main/providers/claude.ts",
      "apps/desktop/src/main/runtimes/auth.ts",
      "apps/desktop/src/renderer/src/chat/views/agents/SignIn.tsx",
      "apps/desktop/src/main/supervisor/guardrails.test.ts",
    ]) {
      expect(branchesOutside([{ path, source }]), path).toEqual([]);
    }
    // A sibling of the sign-in screen is not the sign-in screen.
    expect(branchesOutside([{ path: "apps/desktop/src/renderer/src/chat/views/agents/AgentEditor.tsx", source }])).toHaveLength(1);
  });
});
