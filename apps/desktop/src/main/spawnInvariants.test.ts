import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Every child process EO starts is started with `windowsHide` (EO-204).
 *
 * ## What the flag is for
 *
 * On Windows a console program inherits its parent's console. A parent
 * that has none — and the Electron main process is a GUI process, so it
 * has none — gets its child a brand new one, and a new console is a
 * window: an empty `cmd` box that appears over the app and stays for as
 * long as the child runs. `windowsHide: true` is Node's spelling of
 * `CREATE_NO_WINDOW`, which gives the child its console without giving
 * it a window. It costs nothing where a console was going to be
 * inherited anyway, and it is the whole fix where one was not.
 *
 * Because the flag only matters at the top of a chain, a call site
 * cannot decide for itself whether it needs one: whether its child has a
 * console to inherit is a fact about whoever started *this* process, and
 * on the two paths that reach EO from outside — a backend CLI starting
 * the MCP supervisor, a module declaring a binary it wants run — that is
 * not something the call site can read. So the rule is every site, not
 * the sites someone judged to be at the top.
 *
 * ## Why this is a source scan, and why it uses the compiler
 *
 * What it protects is "no window appears on Windows", which no assertion
 * on another platform can make and no runner here can observe. What *is*
 * checkable everywhere is the option being set at every call site, which
 * is exactly what was missing at three of them.
 * `db/architecturalInvariants.test.ts` is the precedent for the shape,
 * including the non-vacuity test below: a scanner that has quietly
 * stopped matching anything passes forever, so it is made to show it
 * still finds the calls it is clearing.
 *
 * It reads the real syntax tree rather than the text. Earlier versions
 * of this file matched on patterns and were wrong three times in three
 * different ways — a `windowsHide: false` that satisfied a search for
 * the word, a `["windowsHide"]` that a name comparison could not see
 * through, a `childProcess.spawn` nobody had written a pattern for. Each
 * fix was a new pattern, which is the shape of a check that will be
 * wrong a fourth time. TypeScript is already a dependency here and its
 * parser answers the actual questions — what is this name bound to, what
 * key does this property write, what value does it write — so the
 * remaining risk is in what this file *asks*, not in whether the text
 * happened to look like something.
 *
 * ## Set, not mentioned, and not overridable
 *
 * The last property to write `windowsHide` must write the literal
 * `true`, and anything after it that could write the key again — a
 * spread, a key this cannot evaluate — puts the answer back to unknown.
 * A key written before the flag does not matter, because the flag lands
 * after it.
 *
 * ## Everything unproven counts as unguarded
 *
 * Options handed over as a variable, a shorthand `{ windowsHide }` whose
 * value lives elsewhere, a computed key this cannot evaluate, a value
 * that is an expression rather than the literal, a spread of anything
 * opaque. That direction is the safe one: it costs a call being named
 * that may well be fine, which someone answers by writing the option
 * out, where the other direction costs a window nobody sees until it is
 * in front of a user.
 *
 * ## Finding the calls at all
 *
 * Bindings are followed rather than guessed, from both spellings of the
 * module. Named, default, namespace, `require`, `await import` and
 * `process.getBuiltinModule` — Node 22's route to a builtin, which
 * Electron 45's Node 24 has — in a name or destructured, and then ordinary aliasing on top of those:
 * `const start = spawn` makes `start` a starter, `const cp = childProcess`
 * makes `cp` the module, `promisify(cp.execFile)` makes its result one,
 * and each of those can be aliased again — resolved to a fixed point, so
 * depth costs nothing.
 *
 * A specifier is folded rather than merely matched, so
 * `require("node:" + "child_process")`, a template, and a name holding
 * one all reach the module the literal reaches. A name earns that only
 * by being declared once in the file, by `const`, and never assigned to:
 * `let MODULE = "electron-updater"; MODULE = "node:child_process"`
 * spells one name and holds two values, and a name declared in two
 * scopes spells one name and *is* two bindings. Folding either would
 * resolve a load of this module to some other one and lose the calls on
 * it, so a name that cannot be pinned down is simply not folded.
 *
 * A specifier that will not fold is kept as a load of *something*:
 * taking a starter's name off it is a finding, and every other member is
 * passed over — which is what keeps `import(url).then(…)` and
 * `loaded.default(…)`, both of which the real tree has, from failing an
 * invariant they have nothing to do with. A specifier that folds to some
 * other module's name is dropped outright.
 *
 * And because the ways to *acquire* a module are not a list this file
 * can close by enumeration — `getBuiltinModule` was the one that got
 * away, a `createRequire` result or somebody's own helper is the next —
 * the general question is asked too: a specifier for this module
 * reaching a call that is not read as a load is reported.
 *
 * A dynamic import delivers a *promise* of the module, which is not the
 * same value and is not treated as one: `.spawn` on it means nothing and
 * `.finally` hands the module onwards. Awaiting one gives the module,
 * and a `then` callback is given it, so that callback's first parameter
 * binds like any other name — by itself or destructured. A `then` that
 * hands the value straight on — no handler at all, `undefined`, or
 * `(m) => m` — consumes nothing, and the promise it returns is still a
 * promise of the module; treating that as the end of the trail is how
 * `await import(…).then()` came to look like a load somebody had
 * followed.
 *
 * Beyond that the question is turned around. Rather than chasing the
 * ways a promise can carry a module — `Promise.resolve`, then
 * `Promise.all`, then `finally`, a list with no end — a load of a module
 * this scan *identified* has to be picked up by something it understands
 * or it is a finding. `const cp = await Promise.resolve(import(…))` is
 * reported not because that wrapper was recognised but because nothing
 * read the load, which is a question that terminates. A result thrown
 * away is read: there is nothing for it to have handed on. A handler
 * written somewhere else is a route out of the file, and is said out
 * loud for the same reason.
 *
 * A member is a member however it is written. `cp.spawn`, `cp["spawn"]`
 * and `require("child_process")["spawn"]` select the same function, and
 * `{ spawn: s }`, `{ "spawn": s }` and `{ ["spawn"]: s }` take the same
 * one off the module; a rest element takes all of them at once and so is
 * the module under another name. A subscript or a property name that is
 * not a literal is not read as innocent — it is reported, because the
 * one thing it might be naming is a starter.
 *
 * Bindings are keyed by spelling rather than by scope, which is a real
 * limit and is treated as one: a name declared more than once in a file
 * is two bindings this cannot tell apart, so the collision is reported
 * and the first binding stands. Reading them as one entry is how an
 * inner `const spawn` could otherwise replace an imported starter and
 * take the outer call with it.
 *
 * Inspecting is also kept apart from consuming. Working out whether some
 * wrapper hands back a starter means looking inside it, and looking must
 * leave an unrecognised load exactly as unaccounted as it was found —
 * otherwise the act of rejecting a wrapper is itself what hides what it
 * wrapped.
 *
 * What makes that sound rather than merely thorough is the last pass: a
 * reference to one of these bindings that this file did not account for
 * — a starter passed to something as a value, a module member taken and
 * not followed — is reported as a finding in its own right. So is the
 * module being named anywhere the analysis did not already read. The
 * scan cannot conclude "no unguarded calls here" from having failed to
 * understand the file; the only way to a clean answer is for every use
 * to have been read.
 */

const mainSrcRoot = dirname(fileURLToPath(import.meta.url));

/** What `node:child_process` exports that starts a process and takes options. */
const CHILD_PROCESS_STARTERS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);

/** Both spellings. Node accepts the bare one and so must this. */
const MODULE_SPECIFIERS = new Set(["node:child_process", "child_process"]);

// ── Reading the file ──────────────────────────────────────────

function parse(source: string, fileName: string): ts.SourceFile {
  const javascript = [".mjs", ".cjs", ".js"].includes(extname(fileName));
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, javascript ? ts.ScriptKind.JS : ts.ScriptKind.TS);
}

function eachNode(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => eachNode(child, visit));
}

/** Past the wrappers that change nothing about what an expression is. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

/**
 * Whether this identifier is a name being *declared or selected*, rather
 * than a reference to a binding.
 *
 * `options.spawn`, `spawn?: SignInSpawner`, `{ spawn: handler }` — all
 * spell a starter's name without meaning the imported one, and the real
 * tree has each of them. Any node whose own `name` (or a qualified
 * name's `right`) is this identifier is such a position, which covers
 * member access, property signatures and declarations together.
 *
 * Shorthand is the exception that has to be carved out: in `{ spawn }`
 * the name *is* the reference.
 */
function isDeclaredOrSelectedName(node: ts.Identifier): boolean {
  const parent = node.parent as (ts.Node & { name?: ts.Node; right?: ts.Node }) | undefined;
  if (parent === undefined) return false;
  if (ts.isShorthandPropertyAssignment(parent)) return false;
  return parent.name === node || parent.right === node;
}

/**
 * Whether a `then` handler hands the fulfilled value straight on.
 *
 * `.then()` with no handler at all is the plainest case — JavaScript
 * passes the module through untouched — and `.then(undefined, onError)`
 * and `.then((m) => m)` do the same thing in more words. A promise like
 * that still carries the module, so treating the `then` as the end of
 * the trail would lose everything downstream of it.
 *
 * A handler that does anything else is not pass-through, and what it
 * returns is not tracked. It does not need to be: the module reached its
 * parameter, which is analysed like any other binding, and a starter
 * taken off that parameter without being called is already reported by
 * the member pass.
 */
function isPassThroughHandler(handler: ts.Expression | undefined): boolean {
  if (handler === undefined) return true;
  const inner = unwrap(handler);
  if (inner.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(inner) && inner.text === "undefined") return true;
  if (!ts.isArrowFunction(inner) && !ts.isFunctionExpression(inner)) return false;
  const [parameter] = inner.parameters;
  if (parameter === undefined || !ts.isIdentifier(parameter.name)) return false;
  const body = inner.body;
  let returned: ts.Expression | undefined;
  if (ts.isBlock(body)) {
    const [only] = body.statements;
    returned = body.statements.length === 1 && only !== undefined && ts.isReturnStatement(only) ? only.expression : undefined;
  } else {
    returned = body;
  }
  if (returned === undefined) return false;
  const value = unwrap(returned);
  return ts.isIdentifier(value) && value.text === parameter.name.text;
}

/**
 * Whether this expression's value is thrown away rather than used.
 *
 * `import("node:child_process");` on its own line loads the module for
 * its side effects and hands nobody anything, which is the one way a
 * load can go unread without that being a gap.
 */
function resultIsDiscarded(node: ts.Expression): boolean {
  let current: ts.Node = node;
  for (let parent = current.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isAwaitExpression(parent) || ts.isVoidExpression(parent) || ts.isParenthesizedExpression(parent)) {
      current = parent;
      continue;
    }
    return ts.isExpressionStatement(parent) && parent.expression === current;
  }
  return false;
}

/** A name used as a type cannot start anything. */
function isTypeContext(node: ts.Node): boolean {
  for (let parent: ts.Node | undefined = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isTypeNode(parent) || ts.isQualifiedName(parent) || ts.isImportTypeNode(parent)) return true;
    if (ts.isSourceFile(parent)) return false;
  }
  return false;
}

// ── What the options say ──────────────────────────────────────

/**
 * The key a property writes, or null when that cannot be worked out.
 *
 * A computed key is *read* rather than refused when it is a literal
 * string: `["windowsHide"]` writes `windowsHide`, and saying so is both
 * more accurate and more useful than declaring it unreadable. A computed
 * key whose expression is anything else really is unknown.
 */
function readPropertyName(name: ts.PropertyName | undefined): string | null {
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrap(name.expression);
    return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) ? expression.text : null;
  }
  return null;
}

function propertyKey(property: ts.ObjectLiteralElementLike): string | null {
  return readPropertyName(property.name);
}

/**
 * The member a `.name` or a `["name"]` selects, or null when that cannot
 * be worked out.
 *
 * The two spellings mean the same thing to Node and so have to mean the
 * same thing here: `cp.spawn` and `cp["spawn"]` start the same process.
 * A subscript that is not a literal really is unknown, and its caller
 * reports it rather than passing over it.
 */
function memberNameOf(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  if (ts.isPropertyAccessExpression(node)) return ts.isIdentifier(node.name) ? node.name.text : null;
  const subscript = unwrap(node.argumentExpression);
  return ts.isStringLiteral(subscript) || ts.isNoSubstitutionTemplateLiteral(subscript) ? subscript.text : null;
}

function literalBoolean(expression: ts.Expression): boolean | "unknown" {
  const inner = unwrap(expression);
  if (inner.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (inner.kind === ts.SyntaxKind.FalseKeyword) return false;
  return "unknown";
}

/** Every expression that could end up being the value of this one. */
function valuePositions(expression: ts.Expression): ts.Expression[] {
  const inner = unwrap(expression);
  if (ts.isConditionalExpression(inner)) return [...valuePositions(inner.whenTrue), ...valuePositions(inner.whenFalse)];
  if (ts.isBinaryExpression(inner)) {
    const operator = inner.operatorToken.kind;
    const merges = operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.AmpersandAmpersandToken;
    if (merges) return [...valuePositions(inner.left), ...valuePositions(inner.right)];
  }
  return [inner];
}

/**
 * Whether a `...spread` provably writes no `windowsHide` of its own.
 *
 * Needed because three production call sites merge optional settings in
 * *after* the flag — `...(options.signal ? { signal: options.signal } :
 * {})` and its siblings — and rejecting those outright would either fail
 * the invariant on correct code or push someone into reordering working
 * files to satisfy a test.
 *
 * The proof is deliberately shallow: every value the spread could take
 * has to be an object literal written right there, and none of them may
 * write the key. A spread of anything opaque — a variable, a call, a
 * conditional whose branches are not literals — is not provable and so
 * is not allowed. Recursive, so a literal merged in through two levels
 * is read at both.
 */
function spreadCannotSetWindowsHide(expression: ts.Expression): boolean {
  return valuePositions(expression).every(
    (value) =>
      ts.isObjectLiteralExpression(value) &&
      value.properties.every((property) => {
        if (ts.isSpreadAssignment(property)) return spreadCannotSetWindowsHide(property.expression);
        const key = propertyKey(property);
        return key !== null && key !== "windowsHide";
      }),
  );
}

/**
 * What `windowsHide` is left as by this options object.
 *
 * Folded left, the way the runtime builds the object: absent is `false`,
 * a later write beats an earlier one, and anything that *might* write
 * the key without this being able to say what — an opaque spread, a key
 * that will not evaluate — puts it back to unknown. Which means a
 * computed key before the flag is harmless and one after it is not,
 * exactly as at runtime.
 */
export function effectiveWindowsHide(literal: ts.ObjectLiteralExpression): boolean | "unknown" {
  let current: boolean | "unknown" = false;
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) {
      if (!spreadCannotSetWindowsHide(property.expression)) current = "unknown";
      continue;
    }
    const key = propertyKey(property);
    if (key === null) {
      current = "unknown";
      continue;
    }
    if (key !== "windowsHide") continue;
    current = ts.isPropertyAssignment(property) ? literalBoolean(property.initializer) : "unknown";
  }
  return current;
}

/**
 * The options object of a call, or null when there is not exactly one to
 * read.
 *
 * Identified as the only argument that is an object literal, which is
 * what every one of these APIs takes and what all thirteen call sites
 * pass. Options handed over as a variable are deliberately not resolved:
 * the answer would be somewhere else in the file, and a scanner that
 * guessed would be clearing calls it had not actually read.
 */
function optionsLiteral(call: ts.CallExpression): ts.ObjectLiteralExpression | null {
  const literals = call.arguments.map(unwrap).filter(ts.isObjectLiteralExpression);
  return literals.length === 1 ? (literals[0] as ts.ObjectLiteralExpression) : null;
}

// ── What is bound to the module ───────────────────────────────

/** A name holding a starter function, or the module object itself. */
type Binding = "starter" | "module" | "unknown" | "promise" | "unknownPromise";

export interface SpawnCallSite {
  /** The call as written, collapsed to one line — or the problem, when there is one. */
  call: string;
  /** Its options provably leave `windowsHide` `true`. */
  guarded: boolean;
}

function isModuleSpecifier(node: ts.Node | undefined): node is ts.StringLiteral {
  return node !== undefined && ts.isStringLiteral(node) && MODULE_SPECIFIERS.has(node.text);
}

/**
 * The string an expression is, when that is knowable without running it.
 *
 * Concatenation, templates and named string constants, because
 * `require("node:" + "child_process")` loads the module exactly as
 * surely as the literal does and a check that only reads literals would
 * call it something else. Anything genuinely computed folds to null,
 * which is the answer its caller acts on rather than ignores.
 */
function foldString(expression: ts.Expression, constants: ReadonlyMap<string, string>, used?: Set<string>): string | null {
  const inner = unwrap(expression);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  if (ts.isIdentifier(inner)) {
    const value = constants.get(inner.text);
    if (value === undefined) return null;
    used?.add(inner.text);
    return value;
  }
  if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldString(inner.left, constants, used);
    const right = foldString(inner.right, constants, used);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(inner)) {
    let text = inner.head.text;
    for (const span of inner.templateSpans) {
      const piece = foldString(span.expression, constants, used);
      if (piece === null) return null;
      text += piece + span.literal.text;
    }
    return text;
  }
  return null;
}

/** How many times each name is declared anywhere in the file. */
function declarationCounts(sourceFile: ts.SourceFile): Map<string, number> {
  const counts = new Map<string, number>();
  eachNode(sourceFile, (node) => {
    if (ts.isIdentifier(node) && declaresName(node)) counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
  });
  return counts;
}

/** Whether this identifier is the name a declaration introduces. */
function declaresName(node: ts.Identifier): boolean {
  const parent = node.parent as (ts.Node & { name?: ts.Node }) | undefined;
  if (parent === undefined) return false;
  const introduces =
    ts.isVariableDeclaration(parent) ||
    ts.isBindingElement(parent) ||
    ts.isParameter(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isFunctionExpression(parent) ||
    ts.isClassDeclaration(parent) ||
    ts.isClassExpression(parent) ||
    ts.isEnumDeclaration(parent) ||
    ts.isModuleDeclaration(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isTypeAliasDeclaration(parent) ||
    ts.isInterfaceDeclaration(parent);
  return introduces && parent.name === node;
}

function isConstDeclaration(node: ts.VariableDeclaration): boolean {
  const list = node.parent;
  return list !== undefined && ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
}

/** `=`, `+=`, `||=` and the rest. */
function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/**
 * The names that provably hold one known string for the whole file.
 *
 * Folding a specifier out of a name is only sound if the name cannot be
 * anything else, and a table keyed on spelling alone does not establish
 * that: `let MODULE = "electron-updater"; MODULE = "node:child_process"`
 * spells one name and holds two values, and a name declared in two
 * scopes spells one name and *is* two bindings. Either would have this
 * folding to the wrong string, and folding to the wrong string is worse
 * than not folding — it turns a load of this module into a load of some
 * other one, and the calls on it disappear.
 *
 * So a name earns a place here only by being declared exactly once in
 * the file, by `const`, with an initializer that folds, and never
 * appearing as the target of an assignment. Anything short of that is
 * simply left out, and a specifier that will not fold is a load this
 * scan could not identify — which is already a shape it knows what to do
 * with, and reports as soon as a starter is taken off it.
 *
 * Declared-once is stricter than scope analysis would be: two unrelated
 * `const` declarations of one name in two functions are both dropped. In
 * a scan whose job is to be sure, being unable to tell two bindings
 * apart is a reason to fold neither.
 */
function stringConstants(sourceFile: ts.SourceFile): Map<string, string> {
  const declarationCounts = new Map<string, number>();
  const candidates = new Map<string, ts.Expression>();
  const assigned = new Set<string>();

  eachNode(sourceFile, (node) => {
    if (ts.isIdentifier(node)) {
      if (declaresName(node)) declarationCounts.set(node.text, (declarationCounts.get(node.text) ?? 0) + 1);
      return;
    }
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const target = unwrap(node.left);
      if (ts.isIdentifier(target)) assigned.add(target.text);
      // `({ MODULE } = source)` and `[MODULE] = source` rebind too.
      else eachNode(target, (inner) => void (ts.isIdentifier(inner) && assigned.add(inner.text)));
      return;
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      const operand = unwrap(node.operand);
      if (ts.isIdentifier(operand)) assigned.add(operand.text);
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && isConstDeclaration(node)) {
      candidates.set(node.name.text, node.initializer);
    }
  });

  const settled = [...candidates].filter(([name]) => declarationCounts.get(name) === 1 && !assigned.has(name));
  const constants = new Map<string, string>();
  // Twice, so a constant built from an earlier one resolves whatever
  // order the declarations appear in.
  for (let round = 0; round < 2; round += 1) {
    for (const [name, initializer] of settled) {
      const value = foldString(initializer, constants);
      if (value !== null) constants.set(name, value);
    }
  }
  return constants;
}

/** What a `require(…)` or an `import(…)` yields. */
interface ModuleLoad {
  /** The specifier expression, whatever shape it took. */
  specifier: ts.Expression;
  /** It provably names the module. When false, it could name anything. */
  known: boolean;
  /**
   * The value here is a *promise* of the module rather than the module.
   *
   * `require(…)` hands back the module and `await import(…)` does too,
   * but a bare `import(…)` hands back a promise — on which `.spawn`
   * means nothing and `.finally` hands the module onwards. Conflating
   * the two is what let `import(…).finally(…)` read as a module member
   * access, and so as a load that had been accounted for.
   */
  promise: boolean;
}

/**
 * Whether this expression loads a module, and whether that module can be
 * identified.
 *
 * A specifier that folds to some *other* module's name is not a load of
 * this one and is dropped entirely — which is what keeps the ordinary
 * `import("electron-updater")` out of the findings. A specifier that
 * does not fold at all is kept and marked unknown, because the one thing
 * it might name is this module.
 */
function moduleLoad(expression: ts.Expression | undefined, constants: ReadonlyMap<string, string>, used?: Set<string>): ModuleLoad | null {
  if (expression === undefined) return null;
  let call: ts.Expression = unwrap(expression);
  let awaited = false;
  if (ts.isAwaitExpression(call)) {
    call = unwrap(call.expression);
    awaited = true;
  }
  if (!ts.isCallExpression(call)) return null;
  const callee = call.expression;
  const viaImport = callee.kind === ts.SyntaxKind.ImportKeyword;
  const viaRequire = ts.isIdentifier(callee) && callee.text === "require";
  // `process.getBuiltinModule("node:child_process")` — Node 22's own way
  // to a builtin, with no import and no require in sight. Electron 45
  // runs Node 24, so it is available here and hands back the same module
  // synchronously. The object is not checked: anything spelled
  // `getBuiltinModule` is treated as one, which errs the safe way.
  const viaBuiltin = (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) && memberNameOf(callee) === "getBuiltinModule";
  if (!viaImport && !viaRequire && !viaBuiltin) return null;
  const [specifier] = call.arguments;
  if (specifier === undefined || ts.isSpreadElement(specifier)) return null;
  const promise = viaImport && !awaited;
  const folded = foldString(specifier, constants, used);
  if (folded === null) return { specifier, known: false, promise };
  return MODULE_SPECIFIERS.has(folded) ? { specifier, known: true, promise } : null;
}

/**
 * Every call this file makes into the module, and everything about it
 * this scan could not account for.
 *
 * The two are returned together on purpose. "No calls found" and "no
 * calls found *and* every reference understood" are the same empty list
 * and must not mean the same thing, so the second list is what turns the
 * first into an answer worth trusting.
 */
export function spawnCallSites(source: string, fileName = "source.ts"): SpawnCallSite[] {
  const sourceFile = parse(source, fileName);
  const constants = stringConstants(sourceFile);
  const declaredTimes = declarationCounts(sourceFile);
  /** Constants a load actually folded, so the leftover pass does not re-report one it already read. */
  const usedConstants = new Set<string>();
  const bindings = new Map<string, Binding>();
  /** Nodes this scan has read and can explain. Everything else is a finding. */
  const accounted = new Set<ts.Node>();
  /** Member accesses that were resolved into a call or an alias, so the pass below knows which were left dangling. */
  const consumed = new Set<ts.Node>();
  const sites: SpawnCallSite[] = [];
  const problems: string[] = [];

  /**
   * Names bound here are keyed by spelling, not by scope, so one name
   * declared twice is one entry for two bindings.
   *
   * `import { spawn } from "node:child_process"` followed by a
   * `const spawn` inside some unrelated function is two different
   * `spawn`s, and reading them as one would let the inner declaration
   * quietly replace the imported starter and take the outer call with
   * it. Resolving that properly is scope analysis; this does the other
   * conservative thing and says it cannot tell.
   *
   * The first binding also stands rather than being overwritten, so the
   * call the import governs is still found and still has its options
   * read. The ambiguity is reported either way — that is the guarantee,
   * and keeping the first binding is only so the report arrives
   * alongside the call rather than instead of it.
   */
  const bind = (name: ts.Identifier, kind: Binding): boolean => {
    accounted.add(name);
    const ambiguous = (declaredTimes.get(name.text) ?? 0) > 1;
    if (ambiguous && kind !== "unknown" && kind !== "unknownPromise") {
      problems.push(`${name.text} is declared more than once in this file, so this scan cannot tell which binding a use of it means`);
    }
    const existing = bindings.get(name.text);
    if (existing !== undefined) return false;
    bindings.set(name.text, kind);
    return true;
  };

  /** Starters destructured out of the module object, by either syntax. */
  const bindDestructured = (pattern: ts.ObjectBindingPattern, from: "module" | "unknown" = "module"): void => {
    for (const element of pattern.elements) {
      // `const { ...rest } = cp` — rest carries every member the module
      // has, starters included, so it is the module by another name.
      if (element.dotDotDotToken !== undefined) {
        if (ts.isIdentifier(element.name)) bind(element.name, from);
        continue;
      }
      const property = element.propertyName;
      if (property !== undefined && ts.isIdentifier(property)) accounted.add(property);
      // `{ spawn: start }`, `{ "spawn": start }` and `{ ["spawn"]: start }`
      // all take the same function off the module.
      const imported = property === undefined ? (ts.isIdentifier(element.name) ? element.name.text : null) : readPropertyName(property);
      if (imported === null) {
        problems.push("something is destructured off the module under a name this scan cannot read");
        continue;
      }
      if (!ts.isIdentifier(element.name)) continue; // A nested pattern: what it pulls apart is not a function.
      if (!CHILD_PROCESS_STARTERS.has(imported)) {
        accounted.add(element.name);
        continue;
      }
      // Off a load this could not identify, a starter's name is still a
      // starter's name. Nothing here can say whether it is one, so it is
      // said out loud instead.
      if (from === "unknown") {
        problems.push(`"${imported}" is destructured off a module this scan could not identify`);
        accounted.add(element.name);
        continue;
      }
      bind(element.name, "starter");
    }
  };

  /**
   * Whether this expression is the module, something loaded that could
   * be, or neither — reading what it had to read to say so.
   */
  const moduleObjectKind = (expression: ts.Expression, commit = true): "module" | "unknown" | null => {
    const inner = unwrap(expression);
    if (ts.isIdentifier(inner)) {
      const kind = bindings.get(inner.text);
      if (kind !== "module" && kind !== "unknown") return null;
      if (commit) accounted.add(inner);
      return kind;
    }
    // `(await pending).spawn(…)` — awaiting a promise of the module
    // gives the module, wherever the promise came from.
    if (ts.isAwaitExpression(inner)) return promiseKind(inner.expression, commit);
    const load = moduleLoad(inner, constants, usedConstants);
    if (load === null || load.promise) return null;
    if (commit) accounted.add(load.specifier);
    return load.known ? "module" : "unknown";
  };

  /** The same question for a value that is a *promise* of the module. */
  function promiseKind(expression: ts.Expression, commit = true): "module" | "unknown" | null {
    const inner = unwrap(expression);
    // `<promise>.then()` and its wordier equivalents hand the same
    // module on, so the promise they return is still a promise of it.
    // Chained, because `.then().then()` is no different.
    if (ts.isCallExpression(inner)) {
      const callee = unwrap(inner.expression);
      const passesThrough =
        (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
        memberNameOf(callee) === "then" &&
        isPassThroughHandler(inner.arguments[0]);
      if (passesThrough) return promiseKind((callee as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression, commit);
    }
    if (ts.isIdentifier(inner)) {
      const kind = bindings.get(inner.text);
      if (kind !== "promise" && kind !== "unknownPromise") return null;
      if (commit) accounted.add(inner);
      return kind === "promise" ? "module" : "unknown";
    }
    const load = moduleLoad(inner, constants, usedConstants);
    if (load === null || !load.promise) return null;
    if (commit) accounted.add(load.specifier);
    return load.known ? "module" : "unknown";
  }

  // Pass A — what an import or a require binds.
  eachNode(sourceFile, (node) => {
    if (ts.isImportDeclaration(node) && isModuleSpecifier(node.moduleSpecifier)) {
      accounted.add(node.moduleSpecifier);
      const clause = node.importClause;
      if (clause === undefined || clause.isTypeOnly) return;
      if (clause.name) bind(clause.name, "module");
      const named = clause.namedBindings;
      if (named !== undefined && ts.isNamespaceImport(named)) bind(named.name, "module");
      if (named !== undefined && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if (element.isTypeOnly) {
            accounted.add(element.name);
            continue;
          }
          const imported = (element.propertyName ?? element.name).text;
          if (element.propertyName) accounted.add(element.propertyName);
          if (CHILD_PROCESS_STARTERS.has(imported)) bind(element.name, "starter");
          else accounted.add(element.name);
        }
      }
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      const load = moduleLoad(node.initializer, constants, usedConstants);
      if (load === null) return;
      accounted.add(load.specifier);
      const settled = load.known ? "module" : "unknown";
      if (ts.isIdentifier(node.name)) bind(node.name, load.promise ? (load.known ? "promise" : "unknownPromise") : settled);
      else if (ts.isObjectBindingPattern(node.name) && !load.promise) bindDestructured(node.name, settled);
      return;
    }
    // `let m; m = require(…)` binds just as surely as a declaration does.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      const load = moduleLoad(node.right, constants, usedConstants);
      if (load === null) return;
      accounted.add(load.specifier);
      bind(node.left, load.promise ? (load.known ? "promise" : "unknownPromise") : load.known ? "module" : "unknown");
      return;
    }
    // A load whose result is thrown away: read, because there is nothing
    // for it to have handed anywhere. Every other load has to be picked
    // up by one of the passes that reads results, or it is a finding —
    // see the accountability pass below. This used to account *every*
    // load unconditionally, which is precisely what let a load handed to
    // something else look like one that had been read.
    if (ts.isCallExpression(node) && resultIsDiscarded(node)) {
      const discarded = moduleLoad(node, constants, usedConstants);
      if (discarded !== null) accounted.add(discarded.specifier);
    }
  });

  /**
   * What an expression evaluates to, as far as this scan is concerned.
   *
   * Marks what it read as accounted for as it goes, which is what lets
   * the final pass treat everything left over as a use it did not
   * understand.
   */
  const resolve = (expression: ts.Expression, commit = true): Binding | null => {
    const inner = unwrap(expression);
    if (ts.isIdentifier(inner)) {
      const kind = bindings.get(inner.text);
      if (kind === undefined) return null;
      if (commit) accounted.add(inner);
      return kind;
    }
    if (ts.isAwaitExpression(inner)) return promiseKind(inner.expression, commit);
    if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
      if (moduleObjectKind(inner.expression, commit) !== "module") return null;
      const member = memberNameOf(inner);
      if (member === null) return null; // Reported by the member pass below.
      if (commit) {
        if (ts.isPropertyAccessExpression(inner)) accounted.add(inner.name);
        consumed.add(inner);
      }
      return CHILD_PROCESS_STARTERS.has(member) ? "starter" : null;
    }
    // `const pending = import("node:child_process").then();` — a promise
    // of the module is worth a binding of its own, so awaiting it later
    // still arrives at the module.
    const promised = promiseKind(inner, commit);
    if (promised !== null) return promised === "module" ? "promise" : "unknownPromise";
    // `promisify(execFile)`, and any other one-argument wrapper that
    // hands back something still callable as the starter.
    //
    // Looked at without committing first. Inspecting is not consuming:
    // a wrapper this does not understand — `Promise.resolve(import(…))`
    // — must leave the load exactly as unaccounted as it found it, or
    // the act of rejecting the wrapper is itself what hides the load.
    if (ts.isCallExpression(inner) && inner.arguments.length === 1) {
      const [argument] = inner.arguments;
      if (argument !== undefined && resolve(argument, false) === "starter") {
        if (commit) resolve(argument, true);
        return "starter";
      }
    }
    return null;
  };

  /**
   * The module handed to a `then` callback — `import("node:child_process").then(({ spawn }) => …)`.
   *
   * A dynamic import is a promise, so the module arrives in a callback
   * parameter rather than in a variable, and that parameter binds every
   * bit as much as `const cp = await import(…)` does. `then` only: a
   * `catch` handler is given an error and a `finally` handler nothing,
   * so neither is a route to the module.
   *
   * A handler written somewhere else — `.then(useIt)` — is a route this
   * cannot follow, and is said out loud when the module is one this
   * scan identified. Where the load could not be identified it stays
   * quiet, for the same reason the member pass does: nothing here says
   * that promise has anything to do with child processes, and the real
   * tree has such a load in `claudeSdk.ts`.
   */
  const bindThenCallbacks = (): boolean => {
    let bound = false;
    eachNode(sourceFile, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = unwrap(node.expression);
      if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return;
      if (memberNameOf(callee) !== "then") return;
      const [handler] = node.arguments;
      // Asked before anything is read, because reading is what marks the
      // load accounted for. A pass-through `then` consumes nothing — the
      // module carries on into whatever this call returns, and it is
      // that value's own use which has to be understood. Consuming it
      // here is exactly how `await import(…).then()` came to look like a
      // load somebody had followed.
      if (isPassThroughHandler(handler)) return;
      const kind = promiseKind(callee.expression);
      if (kind === null || handler === undefined) return;
      const inline = unwrap(handler);
      if (!ts.isArrowFunction(inline) && !ts.isFunctionExpression(inline)) {
        if (kind === "module") {
          problems.push(`${node.getText(sourceFile).replace(/\s+/g, " ").trim()} hands the module to a function this scan cannot follow`);
        }
        return;
      }
      const [parameter] = inline.parameters;
      if (parameter === undefined) return;
      if (ts.isIdentifier(parameter.name)) bound = bind(parameter.name, kind) || bound;
      else if (ts.isObjectBindingPattern(parameter.name)) bindDestructured(parameter.name, kind);
    });
    return bound;
  };


  // Pass B — ordinary aliasing, to a fixed point. `const start = spawn`,
  // `const cp = childProcess`, `const { spawn } = cp`, and any depth of
  // those built on each other.
  for (let changed = true; changed; ) {
    changed = false;
    eachNode(sourceFile, (node) => {
      if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return;
      const kind = resolve(node.initializer);
      if (kind === null) return;
      if (ts.isIdentifier(node.name)) changed = bind(node.name, kind) || changed;
      else if (ts.isObjectBindingPattern(node.name) && (kind === "module" || kind === "unknown")) bindDestructured(node.name, kind);
    });
    // In the same loop, so a promise reached through an alias delivers
    // its module to the callback just as a direct one does.
    changed = bindThenCallbacks() || changed;
  }

  // Pass C — the calls themselves.
  eachNode(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    // The same resolution the aliasing pass uses, which is what makes
    // `spawn(…)`, `cp.spawn(…)`, `start(…)` and `promisify(spawn)(…)`
    // one case rather than four.
    if (resolve(node.expression) !== "starter") return;
    const options = optionsLiteral(node);
    sites.push({
      call: node.getText(sourceFile).replace(/\s+/g, " ").trim(),
      guarded: options !== null && effectiveWindowsHide(options) === true,
    });
  });

  // Pass D — every member taken off the module, by either spelling.
  //
  // Three outcomes. A member this cannot name might be any of them, so
  // it is a finding. A starter that was never resolved into a call or an
  // alias could be started anywhere, so it is a finding too. A named
  // non-starter provably starts nothing, and is read here so the pass
  // below stays about uses that genuinely were not understood.
  eachNode(sourceFile, (node) => {
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return;
    const kind = moduleObjectKind(node.expression);
    if (kind === null) return;
    const text = node.getText(sourceFile).replace(/\s+/g, " ").trim();
    const member = memberNameOf(node);
    if (member === null) {
      problems.push(`${text} selects a module member this scan cannot read`);
      return;
    }
    if (ts.isPropertyAccessExpression(node)) accounted.add(node.name);
    if (!CHILD_PROCESS_STARTERS.has(member)) return;
    // A starter off a load this could not identify. Quiet about every
    // other member, which is what keeps the ordinary dynamic import —
    // `import(url).then(…)`, `loaded.default(…)` — out of the findings
    // while this shape stays in them.
    if (kind === "unknown") {
      problems.push(`${text} takes a starter off a module this scan could not identify`);
      return;
    }
    if (!consumed.has(node)) problems.push(`${text} is taken without being called, so this scan cannot follow it`);
  });

  /**
   * Pass D2 — a load of this module whose result went somewhere this
   * scan did not read.
   *
   * `const cp = await Promise.resolve(import("node:child_process"))` is
   * the shape: the load is plainly this module, and its result reaches
   * `cp` through a promise operation that is not one of the routes read
   * above. Chasing those routes would mean `Promise.resolve`, then
   * `Promise.all`, then `finally`, then whatever is next — a list that
   * does not end. So the question asked is the opposite one, and it does
   * end: was this load's result picked up by something this scan
   * understands? A load of a module it could *not* identify is not held
   * to this, for the reason the other passes are not either.
   */
  eachNode(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const load = moduleLoad(node, constants, usedConstants);
    if (load === null || !load.known || accounted.has(load.specifier)) return;
    problems.push(`${node.getText(sourceFile).replace(/\s+/g, " ").trim()} loads the module into something this scan cannot follow`);
  });

  /**
   * Pass D3 — the module's name handed to a call this does not read as a
   * load.
   *
   * `getBuiltinModule` was the one that got away, and patching it alone
   * would leave the next route — a `createRequire` result, somebody's
   * own `load()` helper — exactly as invisible. So the general question
   * is asked too: if a specifier for this module reaches a call this
   * scan does not recognise as a load, say so.
   *
   * It errs towards noise, and deliberately: a name-check like
   * `BLOCKED_BUILTINS.has("node:child_process")` would be reported even
   * though it loads nothing. Nothing under `src/main` does that today,
   * and the answer if something ever does is a sentence in the finding
   * rather than a scan that stayed quiet about a real load.
   */
  eachNode(sourceFile, (node) => {
    if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
    // A call this *does* read as a load is somebody else's business.
    if (ts.isCallExpression(node) && moduleLoad(node, constants, usedConstants) !== null) return;
    for (const argument of node.arguments ?? []) {
      if (ts.isSpreadElement(argument)) continue;
      const folded = foldString(argument, constants, usedConstants);
      if (folded === null || !MODULE_SPECIFIERS.has(folded)) continue;
      problems.push(`${argument.getText(sourceFile).replace(/\s+/g, " ").trim()} is handed to a call this scan does not read as a load of the module`);
      return;
    }
  });

  // Pass E — anything left. A binding used somewhere this did not read,
  // or the module named somewhere this did not read, means the answer
  // above is not an answer.
  eachNode(sourceFile, (node) => {
    // Bindings of a module this scan *identified*, and the starters off
    // it. A binding of a load it could not identify is deliberately not
    // held to this: nothing says that value is child_process, so an
    // ordinary use of it is not evidence of anything, and holding it to
    // the rule would fail on `claudeSdk.ts` handing its downloaded SDK
    // around. What matters there is a starter's *name* being taken off
    // it, which the member and destructuring passes already report.
    if (ts.isIdentifier(node)) {
      const kind = bindings.get(node.text);
      if (kind !== undefined && kind !== "unknown" && kind !== "unknownPromise" && !accounted.has(node) && !isTypeContext(node) && !isDeclaredOrSelectedName(node)) {
        problems.push(`${node.text} is used in a way this scan cannot follow`);
      }
      return;
    }
    // A specifier stashed in a variable is the one way left to load the
    // module without this having read the load: `const name =
    // "node:child_process"` and then `require(name)`. Every literal load
    // was accounted above, and a specifier sitting in an array or a
    // comparison is data — `moduleHost.mjs` keeps one in the set of
    // builtins it withholds from modules, and that is a mention rather
    // than a use. A specifier threaded through a helper is past what a
    // syntactic scan can follow, and is not claimed.
    if (ts.isStringLiteral(node) && MODULE_SPECIFIERS.has(node.text) && !accounted.has(node) && node.parent !== undefined && ts.isVariableDeclaration(node.parent)) {
      // Unless a load already folded this constant and was read through
      // it, in which case the call it made is in the list above and
      // saying it could not be followed would be untrue.
      const held = ts.isIdentifier(node.parent.name) ? node.parent.name.text : null;
      if (held === null || !usedConstants.has(held)) problems.push(`"${node.text}" is named in a way this scan cannot follow`);
    }
  });

  return [...sites, ...[...new Set(problems)].map((problem) => ({ call: problem, guarded: false }))];
}

// ── The walk ──────────────────────────────────────────────────

function walkSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(full));
      continue;
    }
    // Tests start processes deliberately — a suite that runs a real
    // supervisor against a real server is what proves the supervisor
    // works — and none of them ever runs on a person's machine.
    if (!entry.isFile() || /\.test\.[cm]?[jt]s$/.test(entry.name)) continue;
    if (/\.([cm]?[jt]s)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function sitesUnder(root: string): { file: string; site: SpawnCallSite }[] {
  return walkSourceFiles(root).flatMap((file) =>
    spawnCallSites(readFileSync(file, "utf8"), file).map((site) => ({ file: relative(root, file), site })),
  );
}

function allSpawnSites(root: string): string[] {
  return sitesUnder(root).map(({ file, site }) => `${file}: ${site.call}`);
}

function unguardedSpawnSites(root: string): string[] {
  return sitesUnder(root)
    .filter(({ site }) => !site.guarded)
    .map(({ file, site }) => `${file}: ${site.call}`);
}

describe("architectural invariant: no child process is started without windowsHide", () => {
  it("every spawn in the main process passes windowsHide, in the real source tree", () => {
    expect(unguardedSpawnSites(mainSrcRoot)).toEqual([]);
  });

  it("still finds the calls it is clearing (proves the pass above is not vacuous)", () => {
    // Thirteen at the time of writing, across twelve files. A floor
    // rather than an equality, so adding a guarded spawn does not fail
    // this — while a rename, or a refactor that moved every spawn out of
    // reach of the walk, does.
    expect(allSpawnSites(mainSrcRoot).length).toBeGreaterThanOrEqual(13);
  });
});

/** A one-call source spawning with the given options object. */
function spawning(options: string): string {
  return `import { spawn } from "node:child_process";\nspawn(command, args, ${options});\n`;
}

const guardedness = (source: string): boolean[] => spawnCallSites(source).map((site) => site.guarded);

describe("reading the options", () => {
  it("catches an unguarded spawn and clears a guarded one", () => {
    expect(guardedness(spawning("{ cwd, windowsHide: true }"))).toEqual([true]);
    expect(spawnCallSites(spawning("{ cwd }"))).toEqual([{ call: "spawn(command, args, { cwd })", guarded: false }]);
  });

  it("catches a spawn given no options at all, and one given only stdio", () => {
    expect(guardedness(`import { spawn } from "node:child_process";\nspawn(command, args);\n`)).toEqual([false]);
    expect(guardedness(spawning(`{ stdio: ["pipe", "inherit", "inherit"] }`))).toEqual([false]);
  });

  it("rejects windowsHide: false, which is the whole reason mentioning it is not the test", () => {
    expect(guardedness(spawning("{ cwd, windowsHide: false }"))).toEqual([false]);
  });

  it("rejects a value it cannot read as literally true", () => {
    expect(guardedness(spawning('{ windowsHide: process.platform === "win32" }'))).toEqual([false]);
    expect(guardedness(spawning("{ windowsHide: hide }"))).toEqual([false]);
    // Shorthand: the value is somewhere else, so there is nothing here
    // to prove it with.
    expect(guardedness(spawning("{ windowsHide }"))).toEqual([false]);
  });

  it("takes the last of two settings, the way the runtime does", () => {
    expect(guardedness(spawning("{ windowsHide: true, windowsHide: false }"))).toEqual([false]);
    expect(guardedness(spawning("{ windowsHide: false, windowsHide: true }"))).toEqual([true]);
  });

  it("reads a quoted or computed key rather than guessing at it", () => {
    expect(guardedness(spawning('{ "windowsHide": true }'))).toEqual([true]);
    expect(guardedness(spawning('{ ["windowsHide"]: true }'))).toEqual([true]);
    expect(guardedness(spawning('{ windowsHide: true, ["windowsHide"]: false }'))).toEqual([false]);
    expect(guardedness(spawning('{ windowsHide: true, "windowsHide": false }'))).toEqual([false]);
  });

  it("treats a key it cannot evaluate as one that might be this one", () => {
    expect(guardedness(spawning("{ windowsHide: true, [key]: false }"))).toEqual([false]);
    // ...but only when it lands after the flag, because only then could
    // it be the last word.
    expect(guardedness(spawning("{ [key]: false, windowsHide: true }"))).toEqual([true]);
  });

  it("rejects an opaque spread after the flag, which could put anything back", () => {
    expect(guardedness(spawning("{ windowsHide: true, ...overrides }"))).toEqual([false]);
    expect(guardedness(spawning("{ windowsHide: true, ...buildOptions() }"))).toEqual([false]);
    expect(guardedness(spawning("{ windowsHide: true, ...(flag ? extra : {}) }"))).toEqual([false]);
  });

  it("rejects a spread that sets the option back, at either depth", () => {
    expect(guardedness(spawning("{ windowsHide: true, ...(flag ? { windowsHide: false } : {}) }"))).toEqual([false]);
    expect(guardedness(spawning('{ windowsHide: true, ...(flag ? { ["windowsHide"]: false } : {}) }'))).toEqual([false]);
    expect(guardedness(spawning("{ windowsHide: true, ...(flag ? { ...other } : {}) }"))).toEqual([false]);
  });

  it("allows a spread it can see through, which is what three production call sites merge in", () => {
    expect(guardedness(spawning("{ windowsHide: true, ...(options.signal ? { signal: options.signal } : {}) }"))).toEqual([true]);
    expect(guardedness(spawning("{ windowsHide: true, ...(options?.env ? { env: { ...process.env, ...options.env } } : {}) }"))).toEqual([true]);
  });

  it("allows a spread before the flag, because the flag is what lands last", () => {
    expect(guardedness(spawning("{ ...defaults, windowsHide: true }"))).toEqual([true]);
  });

  it("rejects options handed over as a variable rather than written out", () => {
    expect(guardedness(`import { spawn } from "node:child_process";\nspawn(command, args, options);\n`)).toEqual([false]);
  });

  it("reads the options past a trailing callback argument, as execFile takes one", () => {
    const source = `import { execFile } from "node:child_process";\nexecFile(command, args, { windowsHide: true }, (error, stdout) => { resolve(stdout); });\n`;
    expect(guardedness(source)).toEqual([true]);
  });
});

describe("finding the calls", () => {
  it("follows an ordinary alias of an imported starter", () => {
    // The plainest way to have a spawn the scan never sees: rename it.
    const source = `import { spawn } from "node:child_process";\nconst start = spawn;\nstart(bin, args, {});\n`;
    expect(spawnCallSites(source)).toEqual([{ call: "start(bin, args, {})", guarded: false }]);
    const guarded = `import { spawn } from "node:child_process";\nconst start = spawn;\nstart(bin, args, { windowsHide: true });\n`;
    expect(guardedness(guarded)).toEqual([true]);
  });

  it("follows an alias of an alias, and one taken off an aliased module", () => {
    const chained = `import { spawn } from "node:child_process";\nconst first = spawn;\nconst second = first;\nsecond(bin, args, {});\n`;
    expect(guardedness(chained)).toEqual([false]);
    const viaModule = `import * as childProcess from "node:child_process";\nconst cp = childProcess;\nconst start = cp.spawn;\nstart(bin, args, {});\n`;
    expect(guardedness(viaModule)).toEqual([false]);
    const destructured = `import * as childProcess from "node:child_process";\nconst { spawn: start } = childProcess;\nstart(bin, args, {});\n`;
    expect(guardedness(destructured)).toEqual([false]);
  });

  it("reads the bare child_process specifier, which Node accepts too", () => {
    expect(guardedness(`import { spawn } from "child_process";\nspawn(bin, args, {});\n`)).toEqual([false]);
    expect(guardedness(`import { spawn } from "child_process";\nspawn(bin, args, { windowsHide: true });\n`)).toEqual([true]);
    expect(guardedness(`const cp = require("child_process");\ncp.execFileSync(bin, args, {});\n`)).toEqual([false]);
  });

  it("finds calls made through a namespace, a default import or a require", () => {
    expect(guardedness(`import * as childProcess from "node:child_process";\nchildProcess.spawn(bin, args, {});\n`)).toEqual([false]);
    expect(guardedness(`import childProcess from "node:child_process";\nchildProcess.execFileSync(bin, args, {});\n`)).toEqual([false]);
    expect(guardedness(`const { spawn } = require("node:child_process");\nspawn(bin, args, {});\n`)).toEqual([false]);
    expect(guardedness(`const { spawn } = await import("node:child_process");\nspawn(bin, args, {});\n`)).toEqual([false]);
  });

  it("reads process.getBuiltinModule, which reaches a builtin with no import or require", () => {
    // Node 22 and later, and Electron 45 runs Node 24, so this is a live route
    // here and hands back the module synchronously.
    const source = `const cp = process.getBuiltinModule("node:child_process");\ncp.spawn(bin, args, {});\n`;
    expect(spawnCallSites(source)).toEqual([{ call: "cp.spawn(bin, args, {})", guarded: false }]);
    expect(guardedness(`const cp = process.getBuiltinModule("node:child_process");\ncp.spawn(bin, args, { windowsHide: true });\n`)).toEqual([true]);
    expect(guardedness(`const { spawn } = process.getBuiltinModule("child_process");\nspawn(bin, args, {});\n`)).toEqual([false]);
    expect(guardedness(`process.getBuiltinModule("node:child_process").spawn(bin, args, {});\n`)).toEqual([false]);
    // And it is a synchronous load, not a promise: no await needed, and
    // a member off it is a module member rather than a promise's.
    expect(guardedness(`const cp = process.getBuiltinModule("node:child_process");\ncp["execFile"](bin, args, {});\n`)).toEqual([false]);
  });

  it("finds a call made straight off the require, with nothing bound at all", () => {
    expect(guardedness(`require("node:child_process").spawn(bin, args, {});\n`)).toEqual([false]);
  });

  it("finds a combined default and named import, which no pattern used to match", () => {
    const source = `import cp, { spawn } from "node:child_process";\nspawn(bin, args, {});\ncp.execFileSync(other, [], { windowsHide: true });\n`;
    expect(guardedness(source)).toEqual([false, true]);
  });

  it("follows the module into a then-callback, where a dynamic import delivers it", () => {
    // The promise hands the module to the parameter, so the parameter
    // binds exactly as `const cp = await import(…)` would.
    const destructured = `import("node:child_process").then(({ spawn }) => spawn(bin, args, {}));\n`;
    expect(spawnCallSites(destructured)).toEqual([{ call: "spawn(bin, args, {})", guarded: false }]);
    expect(guardedness(`import("node:child_process").then(({ spawn }) => spawn(bin, args, { windowsHide: true }));\n`)).toEqual([true]);
    expect(guardedness(`import("node:child_process").then((cp) => cp.spawn(bin, args, {}));\n`)).toEqual([false]);
    expect(guardedness(`import("child_process").then(({ spawn: start }) => start(bin, args, {}));\n`)).toEqual([false]);
    expect(guardedness(`import("node:child_process").then(function ({ execFile }) { execFile(bin, args, {}); });\n`)).toEqual([false]);
  });

  it("follows the module into a then-callback on a promise held in a name", () => {
    const source = `const pending = import("node:child_process");\npending.then(({ spawn }) => spawn(bin, args, {}));\n`;
    expect(spawnCallSites(source)).toEqual([{ call: "spawn(bin, args, {})", guarded: false }]);
  });

  it("follows a promise of the module through an await, however it is spelled", () => {
    expect(guardedness(`const cp = await import("node:child_process");\ncp.spawn(bin, args, {});\n`)).toEqual([false]);
    expect(guardedness(`(await import("node:child_process")).spawn(bin, args, {});\n`)).toEqual([false]);
    const held = `const pending = import("node:child_process");\nconst cp = await pending;\ncp.spawn(bin, args, {});\n`;
    expect(spawnCallSites(held)).toEqual([{ call: "cp.spawn(bin, args, {})", guarded: false }]);
    const destructuredLater = `const pending = import("node:child_process");\nconst { spawn } = await pending;\nspawn(bin, args, { windowsHide: true });\n`;
    expect(guardedness(destructuredLater)).toEqual([true]);
  });

  it("follows a pass-through then, which hands the module on untouched", () => {
    // `.then()` with no handler returns a promise of the same module, so
    // treating the `then` as the end of the trail loses everything after
    // it.
    const bare = `const cp = await import("node:child_process").then();\ncp.spawn(bin, args, {});\n`;
    expect(spawnCallSites(bare)).toEqual([{ call: "cp.spawn(bin, args, {})", guarded: false }]);
    expect(guardedness(`const cp = await import("node:child_process").then().then();\ncp.spawn(bin, args, {});\n`)).toEqual([false]);
    expect(guardedness(`const { spawn } = await import("node:child_process").then(undefined);\nspawn(bin, args, {});\n`)).toEqual([false]);
    expect(guardedness(`const cp = await import("child_process").then(null, report);\ncp.spawn(bin, args, {});\n`)).toEqual([false]);
    // The same thing said with an identity handler.
    expect(guardedness(`const cp = await import("node:child_process").then((m) => m);\ncp.spawn(bin, args, {});\n`)).toEqual([false]);
    expect(guardedness(`const cp = await import("node:child_process").then(function (m) { return m; });\ncp.spawn(bin, args, {});\n`)).toEqual([false]);
    // And it does not become a blanket rejection of the shape.
    expect(guardedness(`const cp = await import("node:child_process").then();\ncp.spawn(bin, args, { windowsHide: true });\n`)).toEqual([true]);
  });

  it("follows a pass-through then held in a name", () => {
    const source = `const pending = import("node:child_process").then();\nconst { execFile } = await pending;\nexecFile(bin, args, {});\n`;
    expect(spawnCallSites(source)).toEqual([{ call: "execFile(bin, args, {})", guarded: false }]);
  });

  it("follows a promisified starter, bare or off a namespace", () => {
    const bare = `import { execFile } from "node:child_process";\nconst execFileAsync = promisify(execFile);\nawait execFileAsync("git", args, {});\n`;
    const member = `import * as cp from "node:child_process";\nconst execFileAsync = promisify(cp.execFile);\nawait execFileAsync(bin, args, {});\n`;
    expect(guardedness(bare)).toEqual([false]);
    expect(guardedness(member)).toEqual([false]);
  });

  it("reads a starter selected by subscript, which Node treats the same as a dot", () => {
    expect(guardedness(`import * as cp from "node:child_process";\ncp["spawn"](bin, args, {});\n`)).toEqual([false]);
    expect(guardedness(`import * as cp from "node:child_process";\ncp["spawn"](bin, args, { windowsHide: true });\n`)).toEqual([true]);
  });

  it("reads a subscripted starter taken straight off the require, with nothing bound", () => {
    expect(spawnCallSites(`require("node:child_process")["spawn"](bin, args, {});\n`)).toEqual([
      { call: 'require("node:child_process")["spawn"](bin, args, {})', guarded: false },
    ]);
    expect(guardedness(`require("child_process")["execFileSync"](bin, args, { windowsHide: true });\n`)).toEqual([true]);
  });

  it("folds a computed specifier, which is a load however it is spelled", () => {
    // `require("node:" + "child_process")` reaches the same module as
    // the literal, so it gets a call site rather than a complaint.
    expect(guardedness(`const cp = require("node:" + "child_process");\ncp.spawn(bin, args, {});\n`)).toEqual([false]);
    expect(spawnCallSites(`require("node:" + "child_process").spawn(bin, args, {});\n`)).toEqual([
      { call: 'require("node:" + "child_process").spawn(bin, args, {})', guarded: false },
    ]);
    expect(guardedness('const cp = require(`node:${"child_process"}`);\ncp.spawn(bin, args, { windowsHide: true });\n')).toEqual([true]);
  });

  it("folds a specifier held in a named constant", () => {
    const source = `const MODULE = "node:child_process";\nconst cp = require(MODULE);\ncp.spawn(bin, args, {});\n`;
    expect(spawnCallSites(source)).toEqual([{ call: "cp.spawn(bin, args, {})", guarded: false }]);
    const built = `const PREFIX = "node:";\nconst MODULE = PREFIX + "child_process";\nconst { spawn } = require(MODULE);\nspawn(bin, args, {});\n`;
    expect(spawnCallSites(built)).toEqual([{ call: "spawn(bin, args, {})", guarded: false }]);
  });

  it("reads a starter destructured under a literal property name", () => {
    expect(guardedness(`const { "spawn": start } = require("node:child_process");\nstart(bin, args, {});\n`)).toEqual([false]);
    expect(guardedness(`const { ["spawn"]: start } = require("node:child_process");\nstart(bin, args, {});\n`)).toEqual([false]);
    expect(guardedness(`import { spawn as start } from "node:child_process";\nstart(bin, args, { windowsHide: true });\n`)).toEqual([true]);
  });

  it("treats a rest element as the module, because it carries every starter", () => {
    expect(guardedness(`const { ...rest } = require("node:child_process");\nrest.spawn(bin, args, {});\n`)).toEqual([false]);
  });

  it("does not count a module member that starts nothing", () => {
    expect(spawnCallSites(`import * as cp from "node:child_process";\nconst kind = cp.ChildProcess;\nvoid kind;\n`)).toEqual([]);
  });

  it("does not mistake a same-named method call for the imported starter", () => {
    expect(spawnCallSites(`import { exec } from "node:child_process";\nthing.exec(a, b);\nexec(a, b, { windowsHide: true });\n`)).toEqual([
      { call: "exec(a, b, { windowsHide: true })", guarded: true },
    ]);
  });
});

describe("refusing to guess", () => {
  it("reports a name declared twice, rather than letting one binding stand for two", () => {
    // Bindings are keyed by spelling, so an inner `const spawn` and the
    // imported one are a single entry. Reading them as one binding would
    // let the inner declaration replace the starter and take the outer
    // call with it, so the collision is reported — and the first binding
    // stands, so the call the import governs is still found and still
    // has its options read.
    const source = `import { spawn } from "node:child_process";\nfunction unrelated() { const spawn = import("node:child_process"); void spawn; }\nspawn(bin, args, {});\n`;
    expect(spawnCallSites(source)).toEqual([
      { call: "spawn(bin, args, {})", guarded: false },
      { call: "spawn is declared more than once in this file, so this scan cannot tell which binding a use of it means", guarded: false },
      { call: "spawn is used in a way this scan cannot follow", guarded: false },
    ]);
    // A guarded outer call is still read as guarded; the collision is
    // reported regardless, and so is the shadow's own use — which is the
    // conservatism working as intended rather than a separate defect.
    const guarded = `import { spawn } from "node:child_process";\nfunction unrelated() { const spawn = 1; void spawn; }\nspawn(bin, args, { windowsHide: true });\n`;
    expect(spawnCallSites(guarded)).toEqual([
      { call: "spawn(bin, args, { windowsHide: true })", guarded: true },
      { call: "spawn is declared more than once in this file, so this scan cannot tell which binding a use of it means", guarded: false },
      { call: "spawn is used in a way this scan cannot follow", guarded: false },
    ]);
  });

  it("reports a load inspected while rejecting a wrapper it does not understand", () => {
    // Inspecting is not consuming. The wrapper is unknown, so the load
    // must be left exactly as unaccounted as it was found — otherwise
    // the act of rejecting the wrapper is itself what hides the load.
    const source = `const pending = Promise.resolve(import("node:child_process").then());\npending.then((cp) => cp.spawn(bin, args, {}));\n`;
    expect(spawnCallSites(source)).toEqual([
      { call: 'import("node:child_process") loads the module into something this scan cannot follow', guarded: false },
    ]);
  });

  it("still reports a module handed to a wrapper, having looked inside it", () => {
    // The same rule read from the other side: looking at `someWrapper`'s
    // argument and finding it is not a starter must not count as having
    // read the module.
    expect(spawnCallSites(`import * as cp from "node:child_process";\nsomeWrapper(cp);\n`)).toEqual([
      { call: "cp is used in a way this scan cannot follow", guarded: false },
    ]);
  });

  it("reports a starter handed somewhere this cannot follow", () => {
    // It could be called anywhere, with anything. Saying so is the only
    // honest answer; staying quiet would be reporting that the file has
    // no unguarded spawns.
    const source = `import { spawn } from "node:child_process";\nregisterRunner(spawn);\n`;
    expect(spawnCallSites(source)).toEqual([{ call: "spawn is used in a way this scan cannot follow", guarded: false }]);
  });

  it("reports a starter taken off the module and not followed", () => {
    const source = `import * as cp from "node:child_process";\nregisterRunner(cp.spawn);\n`;
    expect(spawnCallSites(source)).toEqual([{ call: "cp.spawn is taken without being called, so this scan cannot follow it", guarded: false }]);
    // Both spellings, because they are the same handover.
    const subscripted = `import * as cp from "node:child_process";\nregisterRunner(cp["spawn"]);\n`;
    expect(spawnCallSites(subscripted)).toEqual([{ call: 'cp["spawn"] is taken without being called, so this scan cannot follow it', guarded: false }]);
  });

  it("reports a member selected by an expression it cannot evaluate", () => {
    const source = `import * as cp from "node:child_process";\ncp[name](bin, args, {});\n`;
    expect(spawnCallSites(source)).toEqual([{ call: "cp[name] selects a module member this scan cannot read", guarded: false }]);
  });

  it("reports a destructuring whose property name it cannot evaluate", () => {
    const source = `const { [key]: start } = require("node:child_process");\nstart(bin, args, {});\n`;
    expect(spawnCallSites(source)).toEqual([{ call: "something is destructured off the module under a name this scan cannot read", guarded: false }]);
  });

  it("reports a specifier stashed in a constant that no load it read ever used", () => {
    const source = `const name = "node:child_process";\nexport const held = name;\n`;
    expect(spawnCallSites(source)).toEqual([{ call: '"node:child_process" is named in a way this scan cannot follow', guarded: false }]);
  });

  it("reports the module's name reaching a call it does not read as a load", () => {
    // The general form of the `getBuiltinModule` gap: patching one route
    // leaves the next one — a `createRequire` result, somebody's own
    // helper — exactly as invisible.
    expect(spawnCallSites(`handOver("node:child_process");\n`)).toEqual([
      { call: '"node:child_process" is handed to a call this scan does not read as a load of the module', guarded: false },
    ]);
    const viaConstant = `const name = "node:child_process";\nhandOver(name);\n`;
    expect(spawnCallSites(viaConstant)).toEqual([
      { call: "name is handed to a call this scan does not read as a load of the module", guarded: false },
    ]);
    const viaCreateRequire = `const req = createRequire(import.meta.url);\nconst cp = req("node:child_process");\ncp.spawn(bin, args, {});\n`;
    expect(spawnCallSites(viaCreateRequire)).toEqual([
      { call: '"node:child_process" is handed to a call this scan does not read as a load of the module', guarded: false },
    ]);
  });

  it("does not say that about a load it does read", () => {
    expect(spawnCallSites(`require("node:child_process");\n`)).toEqual([]);
    expect(spawnCallSites(`import("child_process");\n`)).toEqual([]);
    expect(spawnCallSites(`const mod = await import("electron-updater");\nvoid mod;\n`)).toEqual([]);
  });

  it("reports a starter taken off a load whose specifier it could not work out", () => {
    const member = `const cp = require(whicheverModule);\ncp.spawn(bin, args, {});\n`;
    expect(spawnCallSites(member)).toEqual([{ call: "cp.spawn takes a starter off a module this scan could not identify", guarded: false }]);
    const destructured = `const { spawn } = require(whicheverModule);\nspawn(bin, args, {});\n`;
    expect(spawnCallSites(destructured)).toEqual([{ call: '"spawn" is destructured off a module this scan could not identify', guarded: false }]);
  });

  it("refuses to fold a specifier held in a name that is reassigned", () => {
    // The name spells one thing and holds two. Folding the declaration
    // would resolve this load to `electron-updater` and lose the spawn
    // entirely, which is worse than not folding at all.
    const reassigned = `let MODULE = "electron-updater";\nMODULE = "node:child_process";\nconst cp = require(MODULE);\ncp.spawn(bin, args, {});\n`;
    expect(spawnCallSites(reassigned)).toEqual([{ call: "cp.spawn takes a starter off a module this scan could not identify", guarded: false }]);
    const compound = `let MODULE = "node:";\nMODULE += "child_process";\nconst cp = require(MODULE);\ncp.spawn(bin, args, {});\n`;
    expect(spawnCallSites(compound)).toEqual([{ call: "cp.spawn takes a starter off a module this scan could not identify", guarded: false }]);
    const destructured = `let MODULE = "electron-updater";\n({ MODULE } = source);\nconst cp = require(MODULE);\ncp.spawn(bin, args, {});\n`;
    expect(spawnCallSites(destructured)).toEqual([{ call: "cp.spawn takes a starter off a module this scan could not identify", guarded: false }]);
  });

  it("refuses to fold a specifier held in a name declared more than once", () => {
    // Two bindings, one spelling. Which one `require` sees is a question
    // about scope that this does not attempt to answer, so it answers
    // "cannot tell" instead of guessing.
    const shadowed = `const MODULE = "electron-updater";\nfunction run() {\n  const MODULE = "node:child_process";\n  const cp = require(MODULE);\n  cp.spawn(bin, args, {});\n}\nvoid MODULE;\nvoid run;\n`;
    // Two findings, both true: the starter came off a module it could
    // not identify, and the specifier sits in a declaration no load it
    // read ever folded.
    expect(spawnCallSites(shadowed)).toEqual([{ call: "cp.spawn takes a starter off a module this scan could not identify", guarded: false }, { call: '"node:child_process" is named in a way this scan cannot follow', guarded: false }]);
    const shadowedByParameter = `const MODULE = "node:child_process";\nfunction run(MODULE) {\n  const cp = require(MODULE);\n  cp.spawn(bin, args, {});\n}\nvoid run;\n`;
    expect(spawnCallSites(shadowedByParameter)).toEqual([{ call: "cp.spawn takes a starter off a module this scan could not identify", guarded: false }, { call: '"node:child_process" is named in a way this scan cannot follow', guarded: false }]);
  });

  it("refuses to fold a specifier held in a let, even one never reassigned", () => {
    const source = `let MODULE = "node:child_process";\nconst cp = require(MODULE);\ncp.spawn(bin, args, {});\n`;
    expect(spawnCallSites(source)).toEqual([{ call: "cp.spawn takes a starter off a module this scan could not identify", guarded: false }, { call: '"node:child_process" is named in a way this scan cannot follow', guarded: false }]);
  });

  it("reports the module being handed to a callback written somewhere else", () => {
    const source = `import("node:child_process").then(useIt);\n`;
    expect(spawnCallSites(source)).toEqual([
      { call: 'import("node:child_process").then(useIt) hands the module to a function this scan cannot follow', guarded: false },
    ]);
  });

  it("reports a load whose result is handed to a promise operation it cannot follow", () => {
    // Chasing `Promise.resolve`, then `Promise.all`, then `finally`, is
    // a list that does not end. The question asked instead is whether
    // anything this scan understands picked the load up, which does.
    const wrapped = `const cp = await Promise.resolve(import("node:child_process"));\ncp.spawn(bin, args, {});\n`;
    expect(spawnCallSites(wrapped)).toEqual([
      { call: 'import("node:child_process") loads the module into something this scan cannot follow', guarded: false },
    ]);
    const gathered = `const [cp] = await Promise.all([import("node:child_process")]);\ncp.spawn(bin, args, {});\n`;
    expect(spawnCallSites(gathered)).toEqual([
      { call: 'import("node:child_process") loads the module into something this scan cannot follow', guarded: false },
    ]);
    // `finally` hands the module onwards, so a member access on the
    // promise is not the module member access it looks like.
    const throughFinally = `import("node:child_process").finally(cleanup).then(({ spawn }) => spawn(bin, args, {}));\n`;
    expect(spawnCallSites(throughFinally)).toEqual([
      { call: 'import("node:child_process") loads the module into something this scan cannot follow', guarded: false },
    ]);
  });

  it("reports a pass-through then whose promise then goes somewhere it cannot follow", () => {
    // The `then` consumed nothing, so the load is still looking for
    // somebody to have read it, and `Promise.resolve` is not somebody.
    const source = `const cp = await Promise.resolve(import("node:child_process").then());\ncp.spawn(bin, args, {});\n`;
    expect(spawnCallSites(source)).toEqual([
      { call: 'import("node:child_process") loads the module into something this scan cannot follow', guarded: false },
    ]);
  });

  it("says nothing about a load whose result is thrown away", () => {
    expect(spawnCallSites(`import("node:child_process");\n`)).toEqual([]);
    expect(spawnCallSites(`await import("node:child_process");\n`)).toEqual([]);
    expect(spawnCallSites(`void import("child_process");\n`)).toEqual([]);
  });

  it("stays quiet about an ordinary dynamic import, which the real tree has two of", () => {
    // `claudeSdk.ts` loads a downloaded SDK by path and `moduleHost.mjs`
    // a module by URL. Neither takes a starter off the result, and an
    // invariant that failed on them would be one somebody turns off.
    expect(spawnCallSites(`const pending = import(pathToFileURL(entry).href).then((m) => m);\nvoid pending;\n`)).toEqual([]);
    // `claudeSdk.ts` verbatim: the parameter now binds, but to a module
    // this could not identify, so passing it around says nothing.
    expect(spawnCallSites(`const pending = import(pathToFileURL(entryPath).href).then((module: unknown) => module as ClaudeSdkModule);\nvoid pending;\n`)).toEqual([]);
    // ...and a starter's name off that same value still is a finding.
    expect(spawnCallSites(`import(somewhere).then(({ spawn }) => spawn(bin, args, {}));\n`)).toEqual([
      { call: '"spawn" is destructured off a module this scan could not identify', guarded: false },
    ]);
    expect(spawnCallSites(`let loaded;\nloaded = await import(moduleUrl);\nawait loaded.default(ctx);\n`)).toEqual([]);
  });

  it("ignores a load that provably names some other module", () => {
    expect(spawnCallSites(`const mod = await import("electron-updater");\nmod.autoUpdater.checkForUpdates();\n`)).toEqual([]);
  });

  it("says nothing about a file that only mentions child processes in prose", () => {
    const source = `// Deliberately does not import node:child_process.\nconst spawn = (a) => a;\nspawn({ nothing: true });\n`;
    expect(spawnCallSites(source)).toEqual([]);
  });

  it("ignores a call held as source text, which is what the shim under repositoryIntelligence/ does", () => {
    const source = `export const SHIM = \`\nimport { execFileSync } from "node:child_process";\nexecFileSync("git", ["rev-parse"], { cwd: root });\n\`;\n`;
    expect(spawnCallSites(source)).toEqual([]);
  });

  it("ignores a commented-out spawn, and a type-only import", () => {
    expect(spawnCallSites(`import { spawn } from "node:child_process";\n// spawn(bin, args);\n/* spawn(other, args); */\nspawn(a, b, { windowsHide: true });\n`)).toEqual([
      { call: "spawn(a, b, { windowsHide: true })", guarded: true },
    ]);
    expect(spawnCallSites(`import type { ChildProcess } from "node:child_process";\nlet held: ChildProcess | null = null;\nvoid held;\n`)).toEqual([]);
  });
});

describe("the walk", () => {
  it("catches a real unguarded spawn written into a scratch tree, and skips test files", () => {
    const scratch = mkdtempSync(join(tmpdir(), "eo-spawn-invariant-"));
    try {
      writeFileSync(join(scratch, "offender.ts"), `import { spawn } from "node:child_process";\nspawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });\n`);
      writeFileSync(join(scratch, "aliased.mjs"), `import { spawn } from "child_process";\nconst start = spawn;\nstart("thing", []);\n`);
      writeFileSync(join(scratch, "offender.test.ts"), `import { spawn } from "node:child_process";\nspawn("anything", []);\n`);
      expect(unguardedSpawnSites(scratch).sort()).toEqual([
        'aliased.mjs: start("thing", [])',
        'offender.ts: spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] })',
      ]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
