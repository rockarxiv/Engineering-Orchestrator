import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * EO never infers a write from an agent's event stream (EO-543,
 * ARCHITECTURE.md §13.1).
 *
 * What an agent writes — a comment, an attachment, a memory note —
 * reaches EO over the agent write bridge, and the tool answers with the
 * write's own result. A `tool_call` or `tool_result` in the stream is a
 * record of what the agent did and nothing more. The supervisor once
 * posted a comment from a call's arguments and wrote a note or an
 * attachment when a result's text began with the right words; on Claude,
 * whose results arrive as `structuredContent`, the words never matched,
 * and 66 notes and 10 attachments were told "done" and never written,
 * while every test passed.
 *
 * So this reads the supervisor and the provider adapters and fails on
 * any write made in response to either event: a write call inside a
 * branch that is taken because an event is a `tool_call` or a
 * `tool_result` — an `if`, a `?:`, an `&&` or a `case` that names
 * either type — or inside a function of the same file that such a branch
 * calls, however deep.
 *
 * **What counts as a write.** A function `db/repos` exports whose name
 * says it changes something (`post…`, `insert…`, `set…`, `record…` and
 * the rest of `WRITE_VERBS`); the writers that sit above the repos
 * (`attachRunFiles`, `writeMemoryNote`, `writeAgentComment`,
 * `applyMemoryWrite`); any call on the item record (`record.…`); an
 * attachment store's `storeImported` or `rollback`; and the database's
 * own `insert`, `update`, `delete`, `run` and `exec`. Found in the syntax
 * tree, so a comment that mentions one is not a write.
 *
 * **The allowlist starts empty**, and an entry has to say why its write
 * is not one the agent asked for. An entry whose write has gone fails
 * too, so the list shrinks with the code rather than behind it.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const mainRoot = here;

/** Where an agent's event stream is read. Repository-relative. */
const SCANNED = ["apps/desktop/src/main/supervisor/", "apps/desktop/src/main/providers/"] as const;

interface Allowed {
  /** Repository-relative. */
  readonly file: string;
  /** The callee, as `describe` below names it — `postComment`, `record.writeMemory`. */
  readonly call: string;
  /** Why this write is not one the agent asked for, and what would let it go. */
  readonly why: string;
}

const ALLOWLIST: readonly Allowed[] = [];

/** The verbs a `db/repos` export is named with when it changes something. */
const WRITE_VERBS =
  /^(set|delete|create|record|update|upsert|save|archive|write|mark|add|restore|replace|remember|keep|insert|forget|enqueue|clear|append|adopt|touch|store|start|remove|release|queue|prune|post|mirror|dismiss|ensure|retire|edit|close|open|claim|link|unlink|import|apply|settle|transition|move|reset|bump|grant|revoke|purge|cancel|finish|complete|assign|attach|detach|put|register|publish|stamp|drop|rename|resolve|consume|acknowledge|lease|expire|seed)[A-Z_]?/;

/** Writers above the repos: each one is a write whatever it is called with. */
const NAMED_WRITERS = ["attachRunFiles", "writeMemoryNote", "writeAgentComment", "applyMemoryWrite", "postComment", "postOutputComment"];

/** Methods that write whatever they are called on. */
const WRITING_METHODS = new Set(["storeImported", "rollback", "writeMemory", "appendRunEvent"]);

/** Methods that write when called on the database (`db.insert(…)`, `tx.delete(…)`), and the names a database goes by. */
const DATABASE_WRITES = new Set(["insert", "update", "delete", "run", "exec"]);
const DATABASE_RECEIVERS = new Set(["db", "tx", "database", "sqlite"]);

/** Receivers every method of which is a write: the item record. */
const WRITING_RECEIVERS = new Set(["record"]);

const EVENT_TYPES = new Set(["tool_call", "tool_result"]);

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|mts)$/.test(entry) && !/\.test\.(ts|mts)$/.test(entry) && !entry.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** Every function `db/repos` exports whose name is a write. */
function repoWriters(): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles(join(mainRoot, "db", "repos"))) {
    for (const match of readFileSync(file, "utf8").matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gm)) {
      const name = match[1] as string;
      if (WRITE_VERBS.test(name)) names.add(name);
    }
  }
  return names;
}

/** Whether an expression names `"tool_call"` or `"tool_result"` as a string, anywhere inside it. */
function namesAnEvent(node: ts.Node): boolean {
  if (ts.isStringLiteralLike(node) && EVENT_TYPES.has(node.text)) return true;
  return ts.forEachChild(node, (child) => (namesAnEvent(child) ? true : undefined)) === true;
}

/** Whether a condition is negative about the event — `!==` against it — so its `else` is the branch the event takes. */
function negates(node: ts.Node): boolean {
  if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)) {
    if (namesAnEvent(node.left) || namesAnEvent(node.right)) return true;
  }
  return ts.forEachChild(node, (child) => (negates(child) ? true : undefined)) === true;
}

/** The parts of a file taken because an event is a `tool_call` or a `tool_result`. */
function eventBranches(source: ts.SourceFile): ts.Node[] {
  const branches: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && namesAnEvent(node.expression)) {
      branches.push(node.thenStatement);
      if (node.elseStatement && negates(node.expression)) branches.push(node.elseStatement);
    } else if (ts.isConditionalExpression(node) && namesAnEvent(node.condition)) {
      branches.push(node.whenTrue);
      if (negates(node.condition)) branches.push(node.whenFalse);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && namesAnEvent(node.left)) {
      branches.push(node.right);
    } else if (ts.isCaseClause(node) && namesAnEvent(node.expression)) {
      branches.push(...node.statements);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return branches;
}

/** The functions a file declares by name — declarations, and `const f = () => …` — so a call to one can be followed into it. */
function localFunctions(source: ts.SourceFile): Map<string, ts.Node> {
  const functions = new Map<string, ts.Node>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) functions.set(node.name.text, node.body);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      functions.set(node.name.text, node.initializer.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return functions;
}

/** A callee as this test names it: `postComment`, `record.writeMemory`, `db.insert`. */
function describe_(callee: ts.Expression): string {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) {
    const receiver = callee.expression;
    const owner = ts.isIdentifier(receiver)
      ? receiver.text
      : ts.isPropertyAccessExpression(receiver)
        ? receiver.name.text
        : ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)
          ? `${receiver.expression.name.text}(…)`
          : "…";
    return `${owner}.${callee.name.text}`;
  }
  return callee.getText();
}

export interface Finding {
  file: string;
  line: number;
  call: string;
}

/** Every write made in response to a `tool_call` or `tool_result` in one source text. */
export function writesOnToolEvents(file: string, text: string, writers: Set<string>): Finding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = localFunctions(source);
  const findings: Finding[] = [];
  const seen = new Set<string>();

  const isWrite = (callee: ts.Expression): boolean => {
    if (ts.isIdentifier(callee)) return writers.has(callee.text) || NAMED_WRITERS.includes(callee.text);
    if (ts.isPropertyAccessExpression(callee)) {
      const name = callee.name.text;
      if (WRITING_METHODS.has(name) || writers.has(name) || NAMED_WRITERS.includes(name)) return true;
      const receiver = callee.expression;
      const owner = ts.isIdentifier(receiver) ? receiver.text : ts.isPropertyAccessExpression(receiver) ? receiver.name.text : null;
      if (owner !== null && WRITING_RECEIVERS.has(owner)) return true;
      if (owner !== null && DATABASE_RECEIVERS.has(owner) && DATABASE_WRITES.has(name)) return true;
      // A prepared statement run: `db.prepare(sql).run(…)`.
      return (name === "run" || name === "exec") && ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression) && receiver.expression.name.text === "prepare";
    }
    return false;
  };

  const followed = new Set<string>();
  const scan = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (isWrite(callee)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const call = describe_(callee);
        const key = `${String(line)}:${call}`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push({ file, line, call });
        }
      } else if (ts.isIdentifier(callee) && functions.has(callee.text) && !followed.has(callee.text)) {
        // A function of this file the branch calls: what it does is done
        // in response to the event too.
        followed.add(callee.text);
        scan(functions.get(callee.text)!);
      }
    }
    ts.forEachChild(node, scan);
  };
  for (const branch of eventBranches(source)) scan(branch);
  return findings;
}

/** How many branches a source text takes on a `tool_call` or `tool_result` — so a scan that found none says so. */
function branchCount(file: string, text: string): number {
  return eventBranches(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)).length;
}

const repoRelative = (path: string): string => relative(repoRoot, path).split(sep).join("/");

describe("EO never infers a write from an agent's event stream (ARCHITECTURE.md §13.1)", () => {
  const writers = repoWriters();
  const files = SCANNED.flatMap((dir) => sourceFiles(join(repoRoot, dir)));

  it("reads the code it is about", () => {
    // Not a vacuous pass: the supervisor does branch on these events —
    // to settle a draft, to count a call — and the scan sees it.
    expect(writers.has("postComment")).toBe(true);
    expect(files.map(repoRelative)).toEqual(expect.arrayContaining(["apps/desktop/src/main/supervisor/runSupervisor.ts", "apps/desktop/src/main/providers/fake.ts"]));
    const supervisor = join(repoRoot, "apps/desktop/src/main/supervisor/runSupervisor.ts");
    expect(branchCount(supervisor, readFileSync(supervisor, "utf8"))).toBeGreaterThan(0);
  });

  it("finds no write made in response to a tool_call or a tool_result, outside the allowlist", () => {
    const findings = files.flatMap((file) => writesOnToolEvents(repoRelative(file), readFileSync(file, "utf8"), writers));
    const unexplained = findings.filter((finding) => !ALLOWLIST.some((entry) => entry.file === finding.file && entry.call === finding.call));
    expect(
      unexplained.map((finding) => `${finding.file}:${String(finding.line)} ${finding.call}`),
      "An agent's write reaches EO over the agent write bridge (`mcp/writeBridge.ts`), never from its event stream. Make the write there, or add an entry to ALLOWLIST saying why this one is not the agent's.",
    ).toEqual([]);
    // An entry whose write has gone is a reason nobody needs any more.
    const stale = ALLOWLIST.filter((entry) => !findings.some((finding) => finding.file === entry.file && finding.call === entry.call));
    expect(stale).toEqual([]);
  });
});

describe("the boundary refuses what EO used to do (proves it is not a tautology)", () => {
  const writers = repoWriters();
  const flagged = (text: string): string[] => writesOnToolEvents("example.ts", text, writers).map((finding) => finding.call);

  it("flags the comment posted from a call's arguments", () => {
    expect(
      flagged(`
        for await (const event of stream) {
          if (event.type === "tool_call" && event.name === COMMENT_TOOL_NAME) {
            const parsed = CommentToolArgsSchema.safeParse(event.args);
            postComment(db, { itemId, body: parsed.data.body });
          }
        }`),
    ).toEqual(["postComment"]);
  });

  it("flags a write on a result's words, reached through a function of the same file", () => {
    expect(
      flagged(`
        async function keepMemoryNote(item, args) {
          const written = await writeMemoryNote({ record, args });
          if (!written.ok) postComment(db, { itemId: item.id, body: written.problem });
        }
        if (event.type === "tool_result" && event.output.startsWith(MEMORY_NOTE_ACCEPTED_PREFIX)) await keepMemoryNote(item, args);`),
    ).toEqual(["writeMemoryNote", "postComment"]);
  });

  it("flags an attachment written on a result, a record write and the store's own", () => {
    expect(
      flagged(`
        switch (event.type) {
          case "tool_result":
            await attachRunFiles({ db, store, args });
            await record.writeMemory({ op: "note" });
            await store.storeImported({ name, data });
            break;
        }`),
    ).toEqual(["attachRunFiles", "record.writeMemory", "store.storeImported"]);
  });

  it("flags the branch an inequality sends the event down", () => {
    expect(flagged(`if (event.type !== "tool_call") log(event); else postComment(db, { itemId, body: event.args.body });`)).toEqual(["postComment"]);
  });

  it("flags the database's own writes, and a prepared statement run", () => {
    expect(flagged(`if (event.type === "tool_call") { tx.insert(comments).values(row).run(); db.prepare("DELETE FROM notes").run(); }`)).toEqual(["tx.insert", "prepare(…).run"]);
  });

  it("passes what records the event or only remembers something about it", () => {
    expect(
      flagged(`
        const seq = buffer.append(runId, event.type, event);
        if (event.type === "output" || event.type === "tool_call") liveDrafts.settle(runId, seq, "text");
        if (event.type === "tool_call") activity.openCalls.add(event.callId);
        else if (event.type === "tool_result") activity.openCalls.delete(event.callId);
        postComment(db, { itemId, body: "not in response to a tool event" });`),
    ).toEqual([]);
  });
});
