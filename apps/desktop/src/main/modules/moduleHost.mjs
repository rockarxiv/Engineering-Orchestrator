// No shebang, deliberately. Nothing ever executes this file directly —
// EO always spawns it as `spawn(execPath, [thisFile])` — so the line bought
// nothing, and Vitest inlines a source `.mjs` rather than letting Node load
// it, which makes a leading `#!` a SyntaxError on Windows.
/* global process, Buffer, URL, setImmediate */

/**
 * Runs one custom module, with nothing of EO in scope (KAN-105).
 *
 * ## What this is, and what it is not
 *
 * It **is** an isolation boundary around EO's own in-process state. The
 * main process holds the writable database handle, the IPC surface, the
 * forge credentials and every Electron API; a module runs over here, so
 * none of it is reachable through an object reference. That is worth
 * having and it is real. Nothing of EO's database crosses either:
 * `ctx.item()` and `ctx.itemByKey()` ask the main process, which reads
 * with the code the screens read with and answers on fd 6 (EO-709), and
 * `ctx.commentOn()` asks the same way whether the key it was handed
 * names an item (EO-75). This process once opened the database
 * read-only and answered with SQL of its own (EO-74); that SQL was a
 * second reader no migration updated, and it is gone.
 *
 * It is **not a sandbox**. A module runs with the user's privileges and
 * Node's full builtin surface, so `node:fs` reads whatever the user can
 * read — EO's database file and the module-secret ciphertext included.
 * The checks below (the import rule, `needs.bin`, the built environment,
 * the result nonce) stop a module doing those things *by accident* or in
 * passing; a module written to go around them will. Approving a module
 * is therefore a decision to trust its author, exactly as approving a
 * script would be, and the UI says so rather than implying otherwise.
 *
 * Node's permission model (`--permission --allow-fs-read=…`) is what
 * would make this a real sandbox, along with moving `ctx.exec` out to the
 * parent so `node:child_process` can be withheld. Not done here — see the
 * follow-up on KAN-105.
 *
 * The second file in the repo launched as a subprocess, after
 * `mcp/eoServer.mjs`, and for the same reason it is a real `.mjs` on
 * disk rather than bundled: Rollup does not bundle a file another
 * process has to execute.
 *
 * `node:vm` was considered as the boundary instead and is worse — it is
 * documented as escapable, and a worker thread shares the process
 * outright.
 *
 * The protocol is one JSON request on stdin, the module's own output as
 * newline-delimited JSON on fd 3, and one JSON response on fd 4.
 *
 * Writes go out over fd 3 rather than being done here (EO-75). There
 * is no handle to write through over here, and that is not merely
 * caution: EO's `postComment` resolves mentions, queues the Jira mirror and announces
 * the change to open windows, so a row inserted from this side would be
 * a comment that never reaches Jira and that no open window hears about.
 * fd 3 already carries typed JSON and already has `output` and `exec`
 * cases, so `ctx.comment()` is one more case rather than new plumbing —
 * and the parent, which owns the database, does the posting.
 * `ctx.attach()` is the same again (EO-414): an `attach` event naming
 * paths, which the parent checks, copies into the attachment store and
 * posts as one comment with the files on it.
 *
 * `ctx.createItem()` is the same again (EO-433) with one thing added. A
 * `create` event asks the parent to create a work item, and the module
 * needs that item's key — so for the first time something has to come
 * *back* after the request. Stdin cannot carry it: it is read to its
 * end, and that end is how this process knows the request is whole. So
 * there is a third descriptor, fd 5, that the parent writes one line to
 * for each creation.
 *
 * That line is signed. It is an HMAC and the JSON it was computed over,
 * under a key that arrived on stdin and appears in no frame — a second
 * secret, deliberately not the nonce, because fd 5 is a descriptor a
 * module can read and the nonce is what fd 4 is believed on. And it is
 * read and verified by functions this file took hold of before the
 * module was imported (`PRIMORDIALS` below), so replacing
 * `Socket.prototype.emit`, `JSON.parse` or `fs.read` afterwards changes
 * nothing this reader calls.
 *
 * Reads are the same again (EO-709): a `read` event on fd 3, and a
 * signed line back on fd 6 — a fourth descriptor, because this one is
 * waited on synchronously (`ctx.item()` takes no `await`) and fd 5 has
 * an asynchronous read outstanding while a creation waits.
 *
 * The result gets its own descriptor rather than sharing stdout, and that
 * is not fastidiousness — a module *will* `console.log`, and console.log
 * writes to the host's stdout. Leaving the result there would let a
 * module print something result-shaped and have it believed, which on a
 * `deploy` step is the worst outcome available. So stdout belongs to the
 * module and is treated as transcript.
 *
 * The descriptor is not private, though — it is an inherited fd in the
 * same process, so `writeSync(4, …)` reaches it. What makes the channel
 * trustworthy against an accident is the nonce: the parent accepts only
 * a message carrying the value it sent on stdin, which the module has no
 * ordinary way to read.
 *
 * ## Test mode (EO-352)
 *
 * A request with `mode: "test"` runs one *test case* of a module rather
 * than the module against a real item. The parent (`runModuleTests.ts`)
 * starts one host per case, in a fresh temporary directory it removes
 * afterwards, and aggregates what each reports.
 *
 * A test case is an ES module held to the same import rule as a module
 * — Node builtins only, written `node:…` — whose default export is an
 * async function. It is handed the **harness**, drives the module with
 * it, and asserts with `node:assert`. A case passes when its function
 * returns, and fails when it throws; the failure is the thrown message.
 *
 * ```js
 * import assert from "node:assert/strict";
 *
 * export default async function (harness) {
 *   const run = await harness.run({
 *     inputs: { pr: "12" },
 *     item: { key: "EO-7", title: "Ship it", prUrl: "https://github.com/o/r/pull/12" },
 *     exec: [
 *       { bin: "gh", args: ["pr", "checks", "12"], code: 8, stdout: "pending" },
 *       { bin: "gh", args: ["pr", "checks", "12"], code: 0, stdout: "all passed" },
 *       { bin: "gh", args: ["pr", "merge", "12", "--squash"], code: 0 },
 *     ],
 *   });
 *   assert.deepEqual(run.outcome, { ok: true, result: "merged", detail: "" });
 *   assert.equal(run.comments.length, 1);
 *   assert.match(run.comments[0].body, /merged/);
 * }
 * ```
 *
 * The harness:
 *
 * - `harness.cwd` — the case's temporary directory, which is also
 *   `ctx.cwd` and `process.cwd()`. The only place a case may write.
 * - `harness.run(fixtures)` — runs the module's default export once
 *   against a scripted `ctx` built from `fixtures`, and answers
 *   `{ outcome, comments, attachments, created, logs, execs }`. Every fixture is optional;
 *   a name not listed here is refused as a typo.
 *   - `exec`: `[{ bin, args, code, stdout, stderr }, …]`, the answers
 *     `ctx.exec` gives. Each entry answers one call; a call takes the
 *     first unused entry with the same binary and arguments (an entry
 *     without `args` answers any arguments), so a polling loop's
 *     repeated calls take their answers in order. `code` defaults to 0,
 *     `stdout` and `stderr` to "". `needs.bin` is still enforced.
 *   - `item`: the item `ctx.item()` answers with, as a partial of its
 *     shape (`itemShape`): `id`, `key`, `type`, `title`, `body`,
 *     `parentKey`, `branch`, `prUrl`, `jiraKey`, `createdAt`,
 *     `updatedAt`, `comments`, `spec`, `fields`, `priority`, `heldAt`,
 *     `archivedAt`, `trial`, `createdBy`, `pipeline`, `step`,
 *     `pipelineVersion`, `git`, `extensions`, `parent`, `children`,
 *     `dependsOn`, `dependedOnBy` and `attachments`. Fields left out are
 *     null, `false`, `[]` or `{}` (`spec`, `extensions`); `git` is
 *     always an object, its fields null or `false` where left out.
 *     Defaults to `{ key: "TEST-1" }`; `null` runs the module with no
 *     item.
 *   - `itemByKey`: `{ "EO-2": { title: … }, … }`, the other items
 *     `ctx.itemByKey()` finds and `ctx.commentOn()` may comment on, each
 *     a partial of the same shape.
 *   - `runs` and `transitions`: `{ "EO-1": [ … ], … }`, what
 *     `ctx.runs()` and `ctx.transitions()` answer for each key, each entry
 *     a partial of `runShape` or `transitionShape` (EO-710). A key the
 *     case knows — the running item's, or one in `itemByKey` — and
 *     scripted none for answers `[]`; any other answers `found: false`.
 *   - `items`: `[{ key, title, type, pipelineName, stepName, parentKey }, …]`,
 *     what `ctx.items()` searches, narrowed by its filter as EO's query
 *     narrows and paged. An entry may also carry `stepId`, `pipelineId`,
 *     `createdAt`, `updatedAt` and `atTerminalStep`, which only the
 *     filters read; one without them matches no filter on them.
 *   - `attachments`: `{ "att-1": { name, mimeType, content }, … }`, the
 *     files `ctx.readAttachment()` finds, `content` a string (as UTF-8)
 *     or bytes.
 *   - `run`, `workspace` and `project`: partials of `ctx.run`,
 *     `ctx.workspace` and `ctx.project` (EO-711), shaped as a real run's
 *     are — `{ step: { id, name }, cameFrom: { step, result }, … }`,
 *     `{ kind, id, name, git: { baseBranch, testCommand, forge: { kind } … } }`,
 *     `{ id, name, keyPrefix, workspaces, itemTypes, pipelines }`. Fields
 *     left out are null, `false` or `[]`; `ctx.run` and `ctx.workspace`
 *     are always objects, `ctx.project` is null unless scripted, and
 *     `workspace.git.worktreePath` is always `harness.cwd`.
 *   - `entry`: `ctx.entry` on an entry check (EO-736),
 *     `{ door, pipeline: { id, name }, fromStep: { id, name } }` — `door`
 *     one of `creation`, `move`, `route` and `job`, `fromStep` null on
 *     creation and from a job. Null unless scripted. On creation the
 *     `item` fixture's `id` and `key` are left out, as a real door's are.
 *   - `intake`: `{ job: { id, name } }` runs the module as a pipeline's
 *     intake check (EO-752) — a check a watch job makes, with no item.
 *     `ctx.run.intake` is the fixture, `ctx.run.step` and
 *     `ctx.run.cameFrom` are null whatever `run` says, `ctx.item()`
 *     finds nothing, and `ctx.comment`, `ctx.attach` and
 *     `ctx.createItem` refuse. Taken with no `item` fixture. Absent, the
 *     run is not one and `ctx.run.intake` is null.
 *   - `answer`: what `ctx.answer()` answers, `{ text, offered, matched }`
 *     or null (the default).
 *   - `inputs`: the step's values, laid over the manifest's defaults and
 *     type-checked against it exactly as a real run is.
 *   - `timeoutMs`: `ctx.timeoutMs`, and the limit this run is held to.
 *     Defaults to the module's time limit.
 *   - `createItem`: `[{ key: "EO-9" }, { reason: "…" }, …]`, the answers
 *     `ctx.createItem` gets, used in order — one per creation that
 *     reaches EO. `{ key }` is the item EO made and `{ reason }` a
 *     refusal. With none scripted, or once they run out, creations
 *     answer `NEW-1`, `NEW-2` and so on.
 * - What `run` answers:
 *   - `outcome`: what EO would make of the module's return value —
 *     `{ ok: true, result, detail }` or `{ ok: false, reason, options? }`.
 *     An entry check's refusal (EO-736, manifest `entryCheck: true`) is
 *     `{ ok: true, result: "refuse", detail, reason }`.
 *     A module that throws, fails to load or returns nonsense is a
 *     failed outcome here as on a real run, not a thrown `run`. A check
 *     that is still waiting (EO-458) is
 *     `{ ok: true, result: "waiting", detail, news: [{ id, text }] }`,
 *     `news` always a list — and the failure a real run gets when its
 *     manifest does not declare `watch: true`. On an intake check
 *     (`intake`) it also has `findings: [{ key, title, body?, spec?,
 *     existingBranch? }]`, always a list, parsed as a real run parses
 *     them; anywhere else a module returning `findings` fails.
 *   - `comments`: `[{ key, body }]`, every comment `ctx.comment()` and
 *     `ctx.commentOn()` would have posted, under the same caps. Recorded,
 *     never posted: nothing reaches any thread.
 *   - `attachments`: `[{ key, caption, paths }]`, every `ctx.attach()`
 *     the module made that EO would have accepted, under the same rules
 *     as a real run — so the files have to exist, in `harness.cwd`,
 *     which is where a case writes them before it runs the module.
 *     Recorded, never copied and never posted. `caption` is "" where
 *     the module gave none, and `paths` are as the module wrote them.
 *   - `created`:
 *     `[{ idempotencyKey, key, type, title, body, spec, pipeline, parent, repository, existingBranch, wait, dependsOn }]`,
 *     every `ctx.createItem()` EO would have accepted (EO-433).
 *     Recorded, never created: a case opens no database, so nothing here
 *     checks that the type exists or that `spec` has its fields — a real
 *     run does. What *is* held as on a real run: `needs.create`, the
 *     `idempotencyKey`, a repeated key answering `existing: true` with
 *     the first key and recording nothing more, and the cap per run.
 *     `body` is "" and `spec` `{}` where the module gave none;
 *     `pipeline`, `parent`, `repository` and `existingBranch` are null
 *     where the module gave none (EO-648). `wait` is "none"
 *     and `dependsOn` `[]` where the module gave none (EO-434); nothing
 *     is held in a case, they are recorded as asked. A `dependsOn` key
 *     that is neither the running item's nor one in `itemByKey` is
 *     refused, and so is a `wait` that is none of the three.
 *   - `logs`: every line given to `ctx.log()`.
 *   - `execs`: `[{ bin, args }]`, every `ctx.exec` call, scripted or not.
 *
 * What a case runs under, and why it cannot touch anything real:
 *
 * - **No process is spawned.** `ctx.exec` answers from the script. A
 *   call the case did not script — a call to a binary missing from
 *   `needs.bin` included — fails the case with a message naming the
 *   binary and its arguments, even when the module catches it.
 * - **No secrets.** The environment is empty, `PATH` included.
 * - **No network.** `fetch`, `node:http`, `node:https`, `node:net` (and
 *   `node:tls`, `node:http2`, `node:dgram`, `WebSocket`) throw, and the
 *   case fails even when the module catches it.
 * - **No writes outside `harness.cwd`.** Same rule, same failure.
 *   Judged by where the write lands, so a symbolic link inside the
 *   directory pointing out of it is no way past — and for a recursive
 *   `fs.cp`, by where every entry it copies lands, not only the
 *   destination it was handed.
 * - **Time is faked.** `setTimeout`, `setInterval`, `node:timers`,
 *   `node:timers/promises`, `Date` and `performance.now` run on a clock
 *   that jumps to the next timer whenever nothing else is ready, so a
 *   module polling CI every thirty seconds for ten minutes finishes its
 *   case in milliseconds. Time stops at the run's `timeoutMs` and the
 *   case's own limit: a case still waiting there fails, saying so, and
 *   one that never yields is killed by the parent at the same limit in
 *   real time. A `timeoutMs` fixture can shorten that limit for a run
 *   and never lengthen it: the module's own limit holds over the whole
 *   case whatever a run asks for.
 * - **Coverage is V8's**, taken from this process's own inspector and
 *   measured on the module's code alone, never the case's.
 *
 * Like everything else in this file, this is a boundary against
 * accidents, not a sandbox: a case written to get around it will.
 */

import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { read as readDescriptor, readSync, writeSync } from "node:fs";
import { createRequire, isBuiltin, registerHooks, syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute as isAbsolutePath, parse as parsePath, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as nodeUtil from "node:util";
// The one import that is not a Node builtin, and the reason it is here
// (EO-414): which files may go on a ticket is decided by the function the
// agent's `attachment_add` tool is checked against (`checkRunFile`, held to
// it by `runAttachments.test.ts`), rather than by a third
// copy of it. That file ships alone beside this one — `mcp/eoServer.mjs`
// next to `modules/moduleHost.mjs`, in the source tree and in the
// packaged resources alike — and importing it starts nothing: it serves
// only when it is itself the file that was launched.
import { checkAttachmentPath } from "../mcp/eoServer.mjs";

/**
 * Keeps `node:sqlite`'s experimental warning out of every transcript.
 *
 * Importing it emits one on stderr — this host does not use it, but
 * `mcp/eoServer.mjs`, imported below for its attachment check, does —
 * and this process's stderr *is* the module's transcript — so without this, EO's own choice of SQLite
 * binding would print two lines into `run_events` on every module run,
 * including the runs of modules that never read a ticket. `run_events`
 * is append-only (invariant #3), which makes it noise nothing can take
 * back out.
 *
 * Targeted rather than `--no-warnings`: Node's own printers are kept and
 * handed everything else, so a deprecation a *module* triggers still
 * reaches the person reading the transcript, which is exactly what a
 * transcript is for. The warning is emitted a tick after the import, so
 * this runs in time despite imports being hoisted.
 */
const warningPrinters = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) return;
  for (const printer of warningPrinters) printer(warning);
});

/** The transcript channel: whatever the module says as it works. */
const TRANSCRIPT_FD = 3;
/** The result channel. Only a message carrying the parent's nonce is believed. */
const RESULT_FD = 4;
/** The reply channel (EO-433): the parent's signed answer to each `ctx.createItem()`. */
const REPLY_FD = 5;
/** The read channel (EO-709): the parent's signed answer to each `ctx.item()` and `ctx.itemByKey()`, waited for. */
const READ_FD = 6;

/**
 * What the three channels are worked with, taken before any module runs
 * (EO-433).
 *
 * A module shares this realm. It can assign to `JSON.parse`, replace a
 * method on a prototype, or — through `syncBuiltinESMExports` — swap
 * what a named import of a builtin resolves to, and anything this file
 * looked up *at the moment of use* would then be the module's function
 * rather than Node's. That is how an answer on fd 5 was forged: the
 * reader was a `net.Socket`, and `Socket.prototype.emit` is a property
 * anybody can set.
 *
 * So everything the reply reader and the two writers call is bound here,
 * while this file is being evaluated and nothing of the module exists.
 * `uncurryThis` turns a method into a function taking its receiver, and
 * calling one of those looks nothing up: a bound function's target and
 * arguments are fixed when it is made.
 *
 * It is a boundary against a module that patches what it can reach, not
 * a sandbox — see the header. What it does guarantee is narrow and
 * checkable: no answer reaches `ctx.createItem`'s promise except one
 * whose signature this file verified with these functions.
 */
const uncurryThis = Function.prototype.bind.bind(Function.prototype.call);
const hmacPrototype = Object.getPrototypeOf(createHmac("sha256", "eo"));
const PRIMORDIALS = Object.freeze({
  write: writeSync,
  read: readDescriptor,
  readSync,
  wait: Atomics.wait,
  hmac: createHmac,
  hmacUpdate: uncurryThis(hmacPrototype.update),
  hmacDigest: uncurryThis(hmacPrototype.digest),
  jsonParse: JSON.parse,
  jsonStringify: JSON.stringify,
  isArray: Array.isArray,
  keys: Object.keys,
  indexOf: uncurryThis(String.prototype.indexOf),
  slice: uncurryThis(String.prototype.slice),
  latin1: uncurryThis(Buffer.prototype.latin1Slice),
  freeze: Object.freeze,
  Promise,
  uuid: randomUUID,
  later: setImmediate,
});

/** How much of a command's output `ctx.exec` keeps. The tail is where a failure explains itself. */
const MAX_CAPTURE_CHARS = 200_000;

function emit(line) {
  try {
    PRIMORDIALS.write(TRANSCRIPT_FD, `${PRIMORDIALS.jsonStringify(line)}\n`);
  } catch {
    // The parent closed the pipe — the run is being torn down and there
    // is nowhere left to say so. Losing a transcript line is not worth
    // failing the module over.
  }
}

/**
 * What a module reaches for, asked of the loader instead of guessed from
 * its text (EO-80).
 *
 * ## Why this is a hook and not a scan
 *
 * This was a set of patterns over the module's source, shaped like
 * `/\bexport[\s\S]+?\bfrom\s*["']([^"']+)["']/g`. Every module
 * contains `export default`, `[\s\S]+?` spans any distance and any
 * content, and a comment is text — so the first quoted phrase following
 * the word `from` anywhere in the rest of the file was read as a package
 * name. A docstring saying one thing differed `from` a quoted phrase
 * refused an entire production run, reporting that the module imported a
 * package called "CI is unhappy". Nothing in that file imported
 * anything. `\bimport` had no trailing boundary either, so the word
 * `important` opened a match just as well.
 *
 * Tightening the patterns was the obvious repair and the wrong one: the
 * question has an exact answer available, and a text scan is only ever
 * approximating it. `registerHooks` puts this check inside the real ESM
 * loader, where every specifier the module actually asks for arrives
 * with the module's own URL as its parent. Prose is not a specifier, so
 * it is never seen; and a way of writing an import that no pattern
 * anticipated is not a way past, because there is no pattern left to
 * slip.
 *
 * It keeps the property the old docstring was defending. Static imports
 * are resolved and linked before any of a module's own code executes, so
 * a hook that throws during resolution fires exactly as early as a scan
 * that ran beforehand — nothing of the module has run either way, and
 * `runModule.test.ts` asserts precisely that rather than taking it on
 * trust.
 *
 * It also closes a hole the scan was the only thing covering. The data:
 * URL below was described as a second mechanism enforcing the same rule,
 * and it never was: a bare or relative specifier cannot resolve from
 * one, but an absolute `file:///…` resolves perfectly well and so does
 * every `node:` builtin, blocked or not. Those were the patterns' to
 * catch, and now they are the loader's.
 *
 * The other job the scan was doing — warning that a module would not
 * survive being exported to another machine — has moved to
 * `portability.ts`, where it is advice given to an author rather than a
 * refusal handed to a run. One check answering both questions is what
 * made its conservatism cost a production run; split, each gets to be
 * right.
 *
 * ## Synchronous hooks, deliberately
 *
 * `registerHooks` rather than `register`: it runs the hook on this
 * thread, so it closes over the module's URL directly and its throw
 * arrives as an ordinary exception, where `register` wants a second file
 * on disk — which this host already has reason to avoid, see the header
 * on why it is not bundled — plus a worker thread and a message port to
 * say the same thing.
 *
 * It needs Node 22.15, and this host already needs 22.5 for
 * `node:sqlite`. Production is Electron 45's Node 24.22 under
 * ELECTRON_RUN_AS_NODE=1, which has both (checked on the upgrade to 45,
 * EO-670); loader hooks were measured working under Electron 39's Node
 * 22.22 before any of this was written. On a Node too old the named import
 * above fails at link time, which is the right way round: the host does
 * not start, so nothing runs unguarded.
 */

/**
 * Builtins that hand a module a way around the rest of the contract.
 *
 * `child_process` makes `needs.bin` unenforceable, which would leave
 * KAN-108's import preflight reading a declaration nothing keeps.
 * `module` reaches `createRequire`, which loads npm packages from the
 * worktree and ends portability — and now also `registerHooks`, which
 * would let a module take this very check back out.
 * `worker_threads` and `vm` are fresh realms this check never sees.
 *
 * Refused by name rather than by prefix, because `startsWith("node:")`
 * treats them as ordinary builtins — which is how they got in.
 */
const BLOCKED_BUILTINS = new Set(["node:child_process", "node:module", "node:worker_threads", "node:vm", "node:v8", "node:inspector", "node:repl"]);

/**
 * Builtins EO's own runtime has and Node does not.
 *
 * This host is Electron's binary under ELECTRON_RUN_AS_NODE=1, so the
 * loader's builtin set is Node's plus Electron's: `original-fs` is
 * `fs` without asar, and `electron/js2c/…` are Electron's own bundles.
 * Both resolve here and on no other machine, which is precisely what the
 * rule below exists to prevent — so the runtime's answer is taken minus
 * the runtime's own additions.
 *
 * A list, and a list can go stale: a builtin some later Electron adds
 * would be permitted until somebody names it here. That is where every
 * one of them stood before this existed, so it can only be an
 * improvement — and `portability.ts` warns about anything outside Node's
 * own set regardless of what this says.
 */
const RUNTIME_ONLY_BUILTINS = new Set(["original-fs", "electron"]);

/**
 * The builtin a specifier names, bare and without its subpath.
 *
 * Both sets below are matched on this rather than on the whole string,
 * because a subpath is the same builtin wearing a different name:
 * `node:inspector/promises` is `node:inspector`'s API with promises on
 * it, and an exact-name set said yes to it.
 */
function builtinRoot(specifier) {
  const bare = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  const slash = bare.indexOf("/");
  return slash === -1 ? bare : bare.slice(0, slash);
}

/** Whether this names a builtin of Node itself, rather than one only this runtime has. */
function nodeBuiltin(specifier) {
  return isBuiltin(specifier) && !RUNTIME_ONLY_BUILTINS.has(builtinRoot(specifier));
}

/**
 * Whether this names a builtin EO withholds, however it is written.
 *
 * Bare names too, so `import "child_process"` is refused as withheld
 * rather than told to write itself the long way and meet the same
 * refusal one edit later.
 */
function withheldBuiltin(specifier) {
  return BLOCKED_BUILTINS.has(`node:${builtinRoot(specifier)}`);
}

/** The code on the error a refused resolution throws, so the catch can tell it apart. */
const FORBIDDEN_IMPORT = "ERR_EO_FORBIDDEN_IMPORT";

/**
 * Whether the loader may resolve this specifier on a module's behalf.
 *
 * The prefix alone is not the question. `startsWith("node:")` says yes
 * to `node:does-not-exist`, which is not a builtin EO permits because it
 * is not a builtin at all — and handing it to `next()` got it refused a
 * few frames later by Node, as an `ERR_UNKNOWN_BUILTIN_MODULE` naming no
 * line of the module. Anything this host will not stand behind has to be
 * refused *here*, where the refusal can say where it is written.
 *
 * Asked of the runtime rather than checked against a written list of
 * builtin names, for the same reason the rest of this is a hook: the
 * runtime holds the exact answer and a list is a copy of it that goes
 * stale — refusing a builtin a later Node added, in the same confident
 * wrong voice the scan used. `RUNTIME_ONLY_BUILTINS` above subtracts
 * what this runtime has and Node does not, because the rule is Node's
 * builtins and this host happens to be Electron.
 */
export function permittedSpecifier(specifier) {
  return specifier.startsWith("node:") && nodeBuiltin(specifier) && !withheldBuiltin(specifier);
}

/** How much of a source line a refusal quotes. `runs.error` is durable, and a minified module is one line. */
const MAX_QUOTED_CHARS = 200;
/** How many places a refusal points at, when a specifier is written in several. */
const MAX_SITES = 5;

/**
 * Where a line ends, in every spelling JavaScript has.
 *
 * CR LF comes first in the alternation so that it matches as the single
 * terminator it is rather than as two, which would report a module
 * written on Windows as having twice the lines it has.
 *
 * `LINE_TERMINATOR` below is the same four characters as a set, for the
 * places that walk the source one character at a time rather than split
 * it.
 */
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

/**
 * The 1-based line an offset falls on, and the text of that line.
 *
 * All of them, not merely LF. Counting only LF put an import on the
 * second line of a CR-only, LS- or PS-separated module on "line 1" and
 * quoted both lines back at its author joined into one — a refusal
 * pointing confidently at the wrong place, which is worse than a refusal
 * that admits it cannot point at all.
 */
function siteAt(code, offset) {
  return siteOnLine(code, code.slice(0, offset).split(LINE_BREAK).length);
}

/** The same, for a 1-based line somebody else counted — see `siteWhereItRan`. */
function siteOnLine(code, line) {
  const text = code.split(LINE_BREAK)[line - 1] ?? "";
  const trimmed = text.trim();
  return { line, text: trimmed.length > MAX_QUOTED_CHARS ? `${trimmed.slice(0, MAX_QUOTED_CHARS)}…` : trimmed };
}

/** The one-letter escapes, for the last branch of the decoder below. */
const ESCAPE_SHORTHAND = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };

/**
 * The line terminators, which a backslash may swallow whole.
 *
 * All four of them, because JavaScript has four and the decoder below
 * once knew only LF — which is the one a module written on Windows does
 * not use. CR LF is a single terminator spelled with two characters, so
 * there are five ways to write a line continuation rather than four;
 * the decoder and `closingQuote` each have to consume both halves of
 * that one.
 *
 * LS and PS are terminators but are *not* string-literal terminators:
 * they have been legal unescaped inside a literal since ES2019, so they
 * belong here and not in the bail-out below.
 */
const LINE_TERMINATOR = new Set(["\n", "\r", "\u2028", "\u2029"]);

/**
 * The offset of the next line terminator at or after `from`, or the end
 * of the source.
 *
 * `indexOf("\n")` was doing this job and knew one terminator of the
 * four, so a `//` comment in a CR-only, LS- or PS-separated module ran
 * to the end of the file and took every import after it into the
 * comment with it. A refusal in that module could point at nothing
 * whatsoever, which is the failure this one shares with the miscounted
 * line above: both are the lexer being wrong about where a line ends.
 */
function endOfLine(code, from) {
  for (let at = from; at < code.length; at += 1) if (LINE_TERMINATOR.has(code[at])) return at;
  return code.length;
}

/** A `\x`/`\u` escape's character, or nothing when its digits are not digits. */
function characterOf(digits) {
  const point = Number.parseInt(digits, 16);
  return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
}

/**
 * What a quoted literal in the source actually says.
 *
 * The loader is handed a *decoded* specifier: `import "node\x2dfetch"`
 * arrives at the hook as `node-fetch`, because the parser resolved the
 * escape before there was a specifier to resolve. Searching the source
 * for the decoded text therefore finds nothing at all, and a refusal
 * that cannot point is most of a refusal missing — so the source is
 * decoded to meet the loader, rather than the loader's answer searched
 * for verbatim.
 *
 * An escape this does not know contributes the character after the
 * backslash, which is what JavaScript does with one too.
 *
 * A line continuation contributes nothing, and there are five ways of
 * writing one: a backslash before LF, CR, CR LF, LS or PS. Only LF was
 * handled at first, which left `import "node\<CR><LF>-fetch"` — an
 * ordinary import in a module written on Windows — resolving to the
 * refused `node-fetch` while the refusal pointed nowhere.
 */
function decodeLiteral(raw) {
  if (!raw.includes("\\")) return raw;
  let text = "";
  for (let at = 0; at < raw.length; at += 1) {
    if (raw[at] !== "\\") {
      text += raw[at];
      continue;
    }
    const escape = raw[at + 1];
    at += 1;
    if (escape === "x") {
      text += characterOf(raw.slice(at + 1, at + 3));
      at += 2;
    } else if (escape === "u" && raw[at + 1] === "{") {
      const close = raw.indexOf("}", at + 1);
      if (close === -1) return text;
      text += characterOf(raw.slice(at + 2, close));
      at = close;
    } else if (escape === "u") {
      text += characterOf(raw.slice(at + 1, at + 5));
      at += 4;
    } else if (LINE_TERMINATOR.has(escape)) {
      // A line continuation: a way of writing no character whatsoever.
      // CR LF is one terminator, so its LF is consumed here rather than
      // left to come round again as an escape of its own — which would
      // put a newline in the middle of the name being decoded and mean
      // the specifier still matched nothing.
      if (escape === "\r" && raw[at + 1] === "\n") at += 1;
    } else {
      text += ESCAPE_SHORTHAND[escape] ?? escape;
    }
  }
  return text;
}

/**
 * The offset of the quote closing a literal opened at `from`, or null if
 * the line ends first.
 *
 * The escaped character is stepped over, and when that character is CR
 * LF both halves are — one line terminator written with two characters.
 * Stopping between them would read the LF as the end of the line and
 * call a perfectly good literal unterminated, which is how a
 * `"node\<CR><LF>-fetch"` yielded no token at all for the decoder below
 * to ever get a look at.
 *
 * A *raw* LF or CR ends the literal, because the parser says so too. LS
 * and PS do not, having been legal inside one since ES2019 — which is
 * why the bail-out is spelled out here rather than reusing
 * `LINE_TERMINATOR`.
 */
function closingQuote(code, from, quote) {
  for (let at = from + 1; at < code.length; at += 1) {
    if (code[at] === "\\") {
      if (code[at + 1] === "\r" && code[at + 2] === "\n") at += 1;
      at += 1;
      continue;
    }
    if (code[at] === quote) return at;
    if (code[at] === "\n" || code[at] === "\r") return null;
  }
  return null;
}

/** The same for a template, which may run over lines and may have a substitution in it. */
function closingBacktick(code, from) {
  let substituted = false;
  for (let at = from + 1; at < code.length; at += 1) {
    if (code[at] === "\\") {
      at += 1;
      continue;
    }
    if (code[at] === "`") return { end: at, substituted };
    if (code[at] === "$" && code[at + 1] === "{") {
      substituted = true;
      let depth = 1;
      at += 2;
      while (at < code.length && depth > 0) {
        if (code[at] === "{") depth += 1;
        else if (code[at] === "}") depth -= 1;
        at += 1;
      }
      at -= 1;
    }
  }
  return null;
}

/** Past a regular expression literal opening at `from`, where a `/` inside a class does not close it. */
function pastRegex(code, from) {
  let inClass = false;
  for (let at = from + 1; at < code.length; at += 1) {
    const char = code[at];
    if (char === "\\") {
      at += 1;
      continue;
    }
    // Unterminated: a regular expression may not contain a raw line
    // terminator, any of the four, so the line ending is the end of it.
    if (LINE_TERMINATOR.has(char)) return at;
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) return at + 1;
  }
  return code.length;
}

const WORD_CHAR = /[A-Za-z0-9_$]/;

/** The digits, for telling a numeric literal from a name and a number's own point from a member dot. */
const DIGIT = /[0-9]/;

/**
 * Where the numeric literal starting at `at` ends.
 *
 * Almost all of a number is word characters already — `0x1f`, `1e3`,
 * `1_000n` come out of the loop above whole — so this is about the one
 * character that is not: the decimal point. `1./2` ends in one, and
 * reading that point as a member dot left the `/` after it opening a
 * regular expression, which ran to the end of the line and swallowed
 * the import written there.
 *
 * At most one point, and never a leading one twice: `1..toString()` is
 * the number `1.` and then a member dot, which is the whole reason that
 * spelling exists.
 */
function pastNumber(code, at) {
  let end = at;
  // `.5` — a fraction with no whole part, whose point comes first.
  const leading = code[end] === ".";
  if (leading) end += 1;
  while (end < code.length && WORD_CHAR.test(code[end])) end += 1;
  if (!leading && code[end] === ".") {
    end += 1;
    while (end < code.length && WORD_CHAR.test(code[end])) end += 1;
  }
  return end;
}

/** Words after which an *expression* follows: a `{` is an object literal and a `/` opens a regular expression. */
const EXPRESSION_FOLLOWS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "yield", "await", "throw", "case", "default"]);

/**
 * Words a `/` may follow and still open a regular expression rather than
 * divide: the above, plus the two that expect a *statement*.
 *
 * `do /re/.test(x); while (…)` and `else /re/.test(x)` are each a
 * regular expression, so they belong here — while `do {` and `else {`
 * are each a block rather than an object literal, which is why they do
 * not belong in the set above.
 */
const DIVIDES_NOTHING = new Set([...EXPRESSION_FOLLOWS, "do", "else"]);

/** Words whose `(` is a control head, so the `)` that closes it lands back in statement position. */
const CONTROL_HEAD = new Set(["if", "for", "while", "switch", "catch", "with"]);

/** `=>`, which this sees as two punctuation marks that touch. */
function isArrow(previous, before) {
  return previous?.kind === "punct" && previous.text === ">" && before?.kind === "punct" && before.text === "=" && before.at === previous.at - 1;
}

/**
 * Which side of its operand the `++` or `--` closing at `mark` is
 * written on: after it (`n++`) or before it (`++n`).
 *
 * Only the one written after ends an operand, and a `/` after a token
 * that ends an operand divides. `n++ / 2` — a division in the plainest
 * arithmetic there is — was read as a regular expression opening, and
 * it then ran to the end of the line and swallowed the import written
 * after it there.
 *
 * A `++` is postfix when something it could increment stands before it,
 * which is `opensRegex` asked of that token and answered no — the same
 * "does this end an operand" the caller is asking, one token earlier.
 * And when no line ends in between: JavaScript inserts a semicolon
 * before a `++` that starts a line, so `n\n++x` is two statements and
 * that `++` is the second one's prefix. Read off spans of source rather
 * than counted in tokens, because a line ending inside a comment counts
 * for semicolon insertion exactly as one in the open does.
 */
function updateSide(code, mark, before) {
  if (before === undefined || opensRegex(before)) return "prefix";
  return LINE_BREAK.test(code.slice(before.end, mark.at)) ? "prefix" : "postfix";
}

/**
 * Whether the `?` written here opens a ternary, rather than being `?.`
 * or one half of `??`.
 *
 * Only a ternary's `?` is ever answered by a `:`, so only a ternary's
 * may count towards one. Read off the characters rather than the
 * tokens because all three are spelled with the same one: `??` is two
 * marks that touch, and the second of them is not an opening either.
 *
 * A digit after the `.` puts the mark back: `flag?.5:1` is a ternary
 * answering with a fraction, not an optional read of a property that
 * could not be named that anyway, and the grammar says so with the same
 * lookahead. It is the number's point again, one mark further left.
 */
function opensQuestion(code, at) {
  if (code[at + 1] === "." && DIGIT.test(code[at + 2])) return code[at - 1] !== "?";
  return code[at + 1] !== "?" && code[at + 1] !== "." && code[at - 1] !== "?";
}

/**
 * What follows the `:` being read — a statement, or an expression.
 *
 * JavaScript writes four different things with a colon and they divide
 * two and two. A property's (`{ n: {} }`) and a ternary's
 * (`ok ? 1 : {}`) are each followed by an expression, so a `{` after
 * one of them opens an object literal. A label's (`retry: {}`) and a
 * case's (`case 1: {}`) are each followed by a statement, so a `{`
 * after one of them opens a *block* — and a `/` after the `}` closing a
 * block opens a regular expression rather than dividing.
 *
 * What tells the pairs apart is where the colon is written. Inside a
 * block, or at the top of a file, it belongs to a label or a case;
 * anywhere else it belongs to a property. A ternary's turns up in
 * either, which is what the count of `?` still waiting for an answer is
 * for — and spending one of them here is why this is not a pure
 * question.
 *
 * `retry: {} /"/.test(x)` is the reading that was wrong. Taking a
 * label's colon for a property's made the `}` the end of an object
 * literal, the `/` after it a division, and the quote after *that* the
 * start of a string — which ran on and swallowed the import next on the
 * line, leaving the refusal with nowhere to point.
 */
function afterColon(inside) {
  if (inside.asking > 0) {
    inside.asking -= 1;
    return "expression";
  }
  // A control head's `(` is the one frame whose closer lands in
  // statement position while its inside is an expression, so it is
  // asked by bracket rather than by `opens`. Nothing turns on it — a
  // colon with no `?` before it cannot appear inside one — and it is
  // written out rather than left leaning on that.
  return inside.bracket !== "(" && inside.opens === "statement" ? "statement" : "expression";
}

/**
 * Whether the `{` written after `previous` is the body its keyword is
 * waiting for, rather than a brace that merely turned up next.
 *
 * A function's body follows its parameter list and nothing else. A
 * class's follows the keyword, a name, or the end of what it extends —
 * which may be a call, an element, or another class body. Neither ever
 * follows a `:`, which is what a keyword written as a property name
 * (`{ class: 1 }`) is followed by, and that is the reading this is here
 * to refuse.
 */
function opensBody(head, previous) {
  if (head.keyword === "function") return previous?.text === ")";
  return previous?.kind === "word" || previous?.kind === "number" || previous?.text === ")" || previous?.text === "]" || previous?.text === "}";
}

/**
 * Whether the `function` or `class` written here begins a declaration
 * rather than standing inside an expression.
 *
 * Its body's `}` is the thing that turns on the answer. A declaration's
 * ends a statement, so `function g() {} /re/.test(x)` opens a regular
 * expression; an expression's ends an operand, so
 * `const f = function () {} / 2` divides one. Both are spelled the same
 * from the `}` backwards, and reading every function body as a
 * statement's made the second a regular expression that ran to the end
 * of the line and swallowed the import written after it there.
 *
 * `default` is the exception among the words an expression follows:
 * `export default function () {}` is a declaration, while
 * `export default {}` is the object literal that word is otherwise
 * followed by.
 */
function declares(previous) {
  if (previous === undefined) return true;
  if (previous.kind === "string" || previous.kind === "regex" || previous.kind === "number") return false;
  if (previous.kind === "word") return previous.text === "default" || !(EXPRESSION_FOLLOWS.has(previous.text) || previous.text === "extends");
  if (previous.text === "}" || previous.text === ")") return previous.closes === "statement";
  return previous.text === ";" || previous.text === "{";
}

/**
 * The frame for the bracket opening here: what it opened, so that the
 * one closing it can say whether a `/` after it divides.
 *
 * A body answers to its keyword rather than to the token before it, so
 * a `function` or `class` still waiting for a body at exactly this
 * depth is what decides — and one left waiting below this depth never
 * got a body and never will, `{ class: 1 }` being a property and not a
 * head. Spending them here is why this is not a pure question, as with
 * `afterColon` above.
 */
function frameFor(char, previous, before, heads, depth) {
  while (heads.length > 0 && heads[heads.length - 1].depth > depth) heads.pop();
  const head = heads[heads.length - 1];
  const opens = char === "{" && head?.depth === depth && opensBody(head, previous) ? heads.pop().opens : opensStatement(char, previous, before) ? "statement" : "expression";
  return { bracket: char, opens, asking: 0 };
}

/**
 * Whether the bracket opening here lands in statement position, where a
 * `/` after its closer opens a regular expression rather than divides.
 *
 * A closing bracket does not say which it is; only the opening one
 * knows. `if (x) {} /re/.test(y)` and `({ n: 1 }) / 2` end in the same
 * two characters and differ entirely, and the usual shorthand — treat
 * every `}` and `)` as the end of an expression — got the first of them
 * wrong. `if (false) {} /"/.test("x")` was then read as a division
 * followed by a string literal opening at that quote, and the string ran
 * on and swallowed the import that came after it on the line, leaving
 * the refusal with nowhere to point.
 *
 * A `:` before the bracket asks the same question one step earlier —
 * `retry: {}` is a block and `{ n: {} }` is an object literal — and it
 * is answered where the colon itself is read, by `afterColon`.
 */
function opensStatement(char, previous, before) {
  if (char === "(") return previous?.kind === "word" && CONTROL_HEAD.has(previous.text);
  if (previous === undefined) return true;
  if (previous.kind === "string" || previous.kind === "regex" || previous.kind === "number") return false;
  if (previous.kind === "word") return !EXPRESSION_FOLLOWS.has(previous.text);
  if (isArrow(previous, before)) return true;
  if (previous.text === ":") return previous.colon === "statement";
  return ");}".includes(previous.text);
}

/**
 * Whether a `/` written after this token opens a regular expression
 * rather than dividing what stands before it.
 *
 * Which is one question: does that token end an operand? Most
 * punctuation does not — `a = /re/`, `a, /re/`, `a + /re/` are each a
 * regular expression — and listing the marks that do (`]`, and a `}` or
 * `)` that closed an expression) missed two of them.
 *
 * `n++` ends an operand and is spelled with a mark that on its own
 * never does, so `n++ / 2` was read as a regular expression, which ran
 * to the end of the line and took the import written after it there
 * into itself. And a regular expression ends an operand too — `/a/ / 2`
 * divides — but left no token behind at all to be asked.
 *
 * A number is the third, and the mark it ends with is a `.`: `1./2`
 * divides, where a member dot before a `/` cannot. That one is settled
 * before this is asked, by reading the point as part of the literal it
 * belongs to — so what arrives here is a number, and a number is an
 * operand like a string or a regular expression.
 */
function opensRegex(previous) {
  if (previous === undefined) return true;
  if (previous.kind === "string" || previous.kind === "regex" || previous.kind === "number") return false;
  if (previous.kind === "word") return DIVIDES_NOTHING.has(previous.text);
  if (previous.text === "}" || previous.text === ")") return previous.closes === "statement";
  if (previous.update === "postfix") return false;
  return previous.text !== "]";
}

/**
 * The module's source as words, punctuation and quoted literals, with
 * comments dropped.
 *
 * Deliberately not a parser — enough to know that a quoted phrase is a
 * quoted phrase and not the inside of a comment, a regular expression or
 * a template, and enough to know what stands immediately before it.
 * `indexOf('"node-fetch"')` knew neither: a docstring naming a package
 * five times filled a refusal with five citations of prose and never
 * reached the import, which is the same mistake as the one that started
 * this ticket, made one job further down.
 *
 * Nothing enforces anything here. The loader has already decided; this
 * only has to point, and a miss costs a refusal that names the specifier
 * without a line.
 *
 * The one piece of state it keeps is `open`: a frame for each bracket
 * still unclosed, saying what that bracket opened — so the one closing
 * it can say whether a `/` after it divides — and counting the `?`
 * inside it still waiting for their `:`. See `opensStatement` and
 * `afterColon`.
 *
 * Every token says where it ends as well as where it starts, because
 * whether a line ended between two of them is a question JavaScript's
 * own semicolon insertion asks. See `updateSide`.
 */
function tokenize(code) {
  const found = [];
  // Innermost last, standing on a frame for the file itself — which is
  // statement position, exactly as the inside of a block is.
  const open = [{ bracket: null, opens: "statement", asking: 0 }];
  // The `function` and `class` keywords whose bodies have not been
  // reached yet, innermost last, each with the depth it was written at —
  // so that a `{` nested deeper (a default value's object literal in the
  // parameter list) is not mistaken for that body, and so that a head
  // written inside another's heritage (`class extends class {} {}`) does
  // not displace it.
  const heads = [];
  let at = 0;
  while (at < code.length) {
    const char = code[at];
    const previous = found[found.length - 1];
    if (char === "/" && code[at + 1] === "/") {
      at = endOfLine(code, at);
    } else if (char === "/" && code[at + 1] === "*") {
      const end = code.indexOf("*/", at + 2);
      at = end === -1 ? code.length : end + 2;
    } else if (char === '"' || char === "'") {
      const end = closingQuote(code, at, char);
      if (end === null) at += 1;
      else {
        found.push({ kind: "string", at, end: end + 1, quoted: true, value: decodeLiteral(code.slice(at + 1, end)) });
        at = end + 1;
      }
    } else if (char === "`") {
      const closed = closingBacktick(code, at);
      if (closed === null) at += 1;
      else {
        // A template with a substitution names nothing statically, so it
        // carries no value rather than a misleading one.
        found.push({ kind: "string", at, end: closed.end + 1, quoted: false, value: closed.substituted ? null : decodeLiteral(code.slice(at + 1, closed.end)) });
        at = closed.end + 1;
      }
    } else if (char === "/" && opensRegex(previous)) {
      // Remembered rather than merely stepped over. A regular expression
      // is an operand like any other, and `/a/ / 2` divides one — which
      // there was nothing left standing to say.
      const end = pastRegex(code, at);
      found.push({ kind: "regex", at, end });
      at = end;
    } else if (DIGIT.test(char) || (char === "." && DIGIT.test(code[at + 1]))) {
      // Before the word branch and before the punctuation branch,
      // because both of them are wrong about a number's point: one
      // stops at it and the other calls it a member dot, which is what
      // left `1./2` looking like the start of a regular expression. A
      // `.` can only begin a number where a digit follows it — no name
      // starts with one, so `o.5` is nothing at all.
      const end = pastNumber(code, at);
      found.push({ kind: "number", at, end, text: code.slice(at, end) });
      at = end;
    } else if (WORD_CHAR.test(char)) {
      let end = at + 1;
      while (end < code.length && WORD_CHAR.test(code[end])) end += 1;
      const text = code.slice(at, end);
      // A body cannot answer for itself: by the time its `{` is read the
      // keyword is several tokens back, behind a name and a parameter
      // list. So the keyword answers here and the body collects it. Not
      // when it is somebody's property — `o.class` and `this.#function`
      // are a read, not a head — and `async` is stepped over to reach
      // what the whole construct is written after.
      if ((text === "function" || text === "class") && previous?.text !== "." && previous?.text !== "#") {
        const beforeKeyword = previous?.kind === "word" && previous.text === "async" ? found[found.length - 2] : previous;
        heads.push({ keyword: text, depth: open.length, opens: declares(beforeKeyword) ? "statement" : "expression" });
      }
      found.push({ kind: "word", at, end, text });
      at = end;
    } else {
      if (!/\s/.test(char)) {
        const token = { kind: "punct", at, end: at + 1, text: char };
        const inside = open[open.length - 1];
        // Decided where the bracket opens and remembered on the one that
        // closes it, because that is where the question gets asked. A
        // stray closer — source this has already lost its place in —
        // leaves the file's own frame standing, so it reads as statement
        // position, the same as the start of a file.
        if (char === "{" || char === "(") open.push(frameFor(char, previous, found[found.length - 2], heads, open.length));
        else if (char === "}" || char === ")") token.closes = (open.length > 1 ? open.pop() : inside).opens;
        else if (char === "?" && opensQuestion(code, at)) inside.asking += 1;
        else if (char === ":") token.colon = afterColon(inside);
        // The second mark of a `++` or `--`, which is the one a `/` would
        // follow, so it is the one that has to know which side of its
        // operand the pair was written on.
        else if ((char === "+" || char === "-") && previous?.kind === "punct" && previous.text === char && previous.at === at - 1) token.update = updateSide(code, previous, found[found.length - 2]);
        found.push(token);
      }
      at += 1;
    }
  }
  return found;
}

/**
 * Whether the word at `index` is a property somebody is reading, rather
 * than the keyword it is spelled like.
 *
 * `o.import("node-fetch")` calls a method named `import`. So does
 * `o?.import(…)`, which is that same `.` with a `?` written before it,
 * and so does `this.#import(…)` on a private one. None of them imports
 * anything and the loader is never asked — but every one of them was
 * read as an `import(` call, so five written above a real import filled
 * the refusal's five citations with member calls and pushed the import
 * itself off the end as "…and 1 more". A refusal that does not say
 * where is the whole of what this ticket is about.
 */
function readsProperty(found, index) {
  const before = found[index - 1];
  return before?.kind === "punct" && (before.text === "." || before.text === "#");
}

/**
 * Whether the callee ending at `index` is the `import` keyword itself.
 *
 * The bracket that follows is `resolutionCall`'s business, since where
 * a callee ends is the same question for both shapes and is answered
 * there once.
 */
function callsImport(found, index) {
  const word = found[index];
  if (word?.kind !== "word" || word.text !== "import") return false;
  return !readsProperty(found, index);
}

/**
 * The token a call's callee ends on, for the `(` at `index`.
 *
 * One token back, except where the call is written `?.(` — an optional
 * call, which is the same call with two more marks in front of its
 * bracket. `import.meta.resolve?.("node-fetch")` reaches the loader
 * exactly as `import.meta.resolve("node-fetch")` does, so the run is
 * refused; it was read as neither shape, so the refusal named the
 * package and pointed nowhere.
 *
 * `?.` is one punctuator in the grammar — no space may fall between the
 * two marks — but the tokenizer reads punctuation a character at a
 * time, so it arrives here as two tokens and the adjacency is checked
 * rather than assumed. `x ? .5 : y` writes those two marks with a
 * number between them and is not a call at all.
 *
 * What this steps back to is always a member read: `import?.(…)` is not
 * a spelling of anything, the grammar admitting no optional import
 * call, so a module containing one does not parse and never reaches the
 * loader to be refused.
 */
function calleeEnd(found, index) {
  const dot = found[index - 1];
  const question = found[index - 2];
  const optional = dot?.kind === "punct" && dot.text === "." && question?.kind === "punct" && question.text === "?" && question.at === dot.at - 1;
  return optional ? index - 3 : index - 1;
}

/**
 * The `import` heading the `import.meta.resolve` call whose callee ends
 * at `index`, or -1 when that is not what this is.
 *
 * A fourth way a module asks the loader to resolve something, and the
 * one nothing here knew about. `import.meta.resolve("node-fetch")` runs
 * the resolve hook with the module as the parent exactly as an import
 * does — so the run is refused — while being neither an import
 * statement nor an `import(` call, which left the refusal naming a
 * package and pointing nowhere.
 *
 * Two spellings of the property read, because both are ordinary member
 * access and both reach the same function: `import.meta.resolve` and
 * `import.meta["resolve"]`, either of them written through `?.`. The
 * `import.meta` at the head of it is a fixed pair of tokens rather than
 * a member read of anything — `import?.meta` does not parse — so it is
 * matched literally, and `o.import.meta.resolve()` is somebody's
 * property all the way down and resolves nothing.
 */
function importMetaResolve(found, index) {
  const punct = (token, text) => token?.kind === "punct" && token.text === text;
  // Back over the property being read, to whatever `import.meta` was
  // written as.
  let at = index;
  const name = found[at];
  if (punct(name, "]")) {
    if (found[at - 1]?.kind !== "string" || found[at - 1].value !== "resolve") return -1;
    if (!punct(found[at - 2], "[")) return -1;
    at -= 3;
  } else if (name?.kind === "word" && name.text === "resolve") {
    if (!punct(found[at - 1], ".")) return -1;
    at -= 2;
  } else return -1;
  // `?.` is two marks that touch, and the tokenizer reads punctuation
  // one character at a time, so an optional read is one token longer
  // than a plain one — two, where it is `?.[`.
  if (punct(found[at], ".")) at -= 1;
  if (punct(found[at], "?")) at -= 1;
  if (found[at]?.kind !== "word" || found[at].text !== "meta") return -1;
  if (!punct(found[at - 1], ".")) return -1;
  const keyword = found[at - 2];
  if (keyword?.kind !== "word" || keyword.text !== "import") return -1;
  return readsProperty(found, at - 2) ? -1 : at - 2;
}

/**
 * The `import` heading the resolution call whose `(` is at `index`, or
 * -1 when nothing is being resolved there.
 *
 * `import(…)` and `import.meta.resolve(…)` are the two calls that reach
 * the loader, and everything downstream wants the same two things of
 * either: whether the literal inside is a specifier, and which token to
 * point an author at when it is not. Asked in one place so the two
 * cannot come to disagree about what a resolution call is.
 */
function resolutionCall(found, index) {
  const open = found[index];
  if (open?.kind !== "punct" || open.text !== "(") return -1;
  const callee = calleeEnd(found, index);
  if (callsImport(found, callee)) return callee;
  return importMetaResolve(found, callee);
}

/**
 * Words that cannot be what a declaration binds, so a `from` reached
 * back past one of them belongs to something that is not an import.
 *
 * What `import` and `export` bind out here is an identifier, and no
 * reserved word is one: `import let from "m"` does not parse. Which
 * makes a reserved word the end of the walk below — without it,
 * `export { helper }` with `let from` written under it would walk out
 * of one statement and into the other and read the two as an import.
 */
const NOT_A_BINDING = new Set([...EXPRESSION_FOLLOWS, ...CONTROL_HEAD, "do", "else", "try", "finally", "break", "continue", "debugger", "var", "let", "const", "function", "class", "extends", "super", "this", "null", "true", "false"]);

/**
 * Whether the `from` at `index` is an import or export declaration's,
 * rather than an identifier a string literal happens to follow.
 *
 * Adjacency was the whole test, on the grounds that nothing but an
 * import ever writes a literal touching the word `from`. Two things do:
 * `o.from` and a plain `from` each take one when a line ending falls
 * between them, JavaScript's semicolon insertion putting a statement
 * boundary where the source has none — both valid, and neither an
 * import.
 *
 * So walk back to the head of the clause instead of looking at one
 * token. Between `import` or `export` and its `from` a declaration may
 * write only names, `as`, `*`, `,` and a braced list; reaching anything
 * else first means this `from` is somebody's. Inside the braces the
 * rule is looser than outside because the grammar is looser there —
 * `{ default as d }` and `{ "a" as b }` are both legal, and neither is
 * legal as a binding out here.
 */
function importsFrom(found, index) {
  let depth = 0;
  for (let at = index - 1; at >= 0; at -= 1) {
    const token = found[at];
    const brace = token.kind === "punct" ? token.text : "";
    if (depth > 0) {
      if (brace === "}") depth += 1;
      else if (brace === "{") depth -= 1;
      continue;
    }
    if (token.kind === "word") {
      if (token.text === "import" || token.text === "export") return true;
      if (NOT_A_BINDING.has(token.text)) return false;
      continue;
    }
    if (brace === "}") depth += 1;
    else if (brace !== "," && brace !== "*") return false;
  }
  return false;
}

/**
 * Every literal standing where a module names something it imports.
 *
 * Four shapes: after `from`, straight after `import`, inside `import(`,
 * and inside `import.meta.resolve(`. What all four have in common is a
 * *keyword* carrying the literal — which is why the word being read is
 * asked about rather than merely matched. A word spelled like a keyword
 * is not one when it is somebody's property (`readsProperty`) or
 * somebody's variable (`importsFrom`), and a literal after one of those
 * imports nothing.
 *
 * A static specifier is a quoted string and never a template, because
 * that is all the grammar admits: an import whose specifier is written
 * in backticks does not parse. So a literal standing there in backticks
 * is a tagged template and the word before it is a function being
 * called — two more ways to write a line that imports nothing and was
 * read as one. A dynamic specifier takes a template happily, an
 * import() call being an ordinary expression, so the two are asked
 * separately.
 */
function specifierTokens(code) {
  const found = tokenize(code);
  const written = [];
  for (let index = 0; index < found.length; index += 1) {
    const token = found[index];
    if (token.kind !== "string") continue;
    const before = found[index - 1];
    if (before === undefined) continue;
    const keyword = before.kind === "word" && token.quoted ? before.text : "";
    const afterKeyword = keyword === "from" ? importsFrom(found, index - 1) : keyword === "import" && !readsProperty(found, index - 1);
    const insideCall = before.kind === "punct" && before.text === "(" && resolutionCall(found, index - 1) >= 0;
    if (afterKeyword || insideCall) written.push(token);
  }
  return written;
}

/**
 * Where in the source the module asks for this specifier.
 *
 * Import syntax, not text that happens to match: a comment mentioning a
 * package is prose, and the refusal that quotes it back at an author is
 * the bug this ticket is about. Escapes are decoded first, because the
 * loader was handed `node-fetch` for a source that says
 * `"node\x2dfetch"` and neither half of the refusal is any use pointing
 * at the wrong one.
 */
export function specifierSites(code, specifier) {
  return specifierTokens(code)
    .filter((token) => token.value === specifier)
    .map((token) => siteAt(code, token.at));
}

/**
 * The resolution calls whose argument is not a plain literal.
 *
 * The fallback when a specifier is written nowhere, because the module
 * assembled it — `"fi" + "le://…"` is the case that used to be reported
 * as "a computed import" and left an author to find it themselves. The
 * loader knows what it resolved to; this knows where it was asked for.
 *
 * `import.meta.resolve(name)` counts for the same reason `import(name)`
 * does: it reaches the loader, so it can be the call that got the run
 * refused, and an author reading "the specifier is assembled" needs the
 * line either way.
 */
export function computedImportSites(code) {
  const found = tokenize(code);
  const sites = [];
  for (let index = 0; index < found.length; index += 1) {
    // The keyword, not a method somebody named the same: `o.import(a + b)`
    // is a call whose argument this cannot read either, and pointing an
    // author at it would be pointing at a line that imports nothing.
    const head = resolutionCall(found, index);
    if (head < 0) continue;
    const argument = found[index + 1];
    const after = found[index + 2];
    // A literal and then the end of the argument. `import("a" + b)` opens
    // with a literal too, and is not one.
    const plain =
      argument !== undefined &&
      argument.kind === "string" &&
      argument.value !== null &&
      after !== undefined &&
      after.kind === "punct" &&
      (after.text === ")" || after.text === ",");
    if (!plain) sites.push(siteAt(code, found[head].at));
  }
  return sites;
}

/** How deep a stack this reads. See `siteWhereItRan` for why it is not the measured depth. */
const STACK_DEPTH = 50;

/**
 * V8's frames, taken once here rather than reached for when needed.
 *
 * A snapshot, because this file is evaluated before the module it is
 * about to run exists, and a builtin's exports are an object a module
 * can reach and write to. Read through `nodeUtil` at the moment of use
 * it would be the module's to replace, which is the whole thing this
 * moved away from `Error` to avoid.
 *
 * Null where the function is not there at all. It has been in Node
 * since 22.12 and `registerHooks` — which this host cannot run without
 * — since 22.15, so that is not a case production reaches; a missing
 * location is still the right way to lose, since a refusal without a
 * line beats a host that will not start.
 */
const getCallSites = typeof nodeUtil.getCallSites === "function" ? nodeUtil.getCallSites : null;

/**
 * The line the module was on when it asked, read off the stack, or null.
 *
 * The part of a resolution this process can watch happen.
 * `import.meta.resolve(…)` is an ordinary synchronous call, and a
 * dynamic `import()` is resolved from the call that made it, so when
 * the hook throws the module's own frame is still standing underneath —
 * with the line it was called from. A static import has none: it is
 * resolved at link time, before any of the module exists to be on a
 * stack. Measured for all three rather than assumed.
 *
 * Which makes this exactly the fallback for what reading the source
 * cannot reach. `const { resolve } = import.meta` puts the same
 * function behind a name of the module's choosing, and no amount of
 * lexing — or parsing — finds that without following the binding. The
 * stack does not have to: it says where the call happened.
 *
 * Which is why what a module has done to `Error` is not allowed to
 * decide whether it gets one. The stack used to be read out of
 * `new Error().stack`, and both halves of that are the module's to
 * take away: `Error.stackTraceLimit = 0` turns the capture off, and
 * `Error.prepareStackTrace` replaces the code that assembles the text —
 * a module that had set the latter to `() => null` was refused an
 * import and told the package and nothing else. Neither is a hostile
 * act on its own. Both are documented, and a module may have set them
 * long before it reached for anything.
 *
 * `util.getCallSites` is the same stack read without going through any
 * of that: V8's own frames, each answering `scriptName` and
 * `lineNumber`, which is the thing wanted anyway rather than a line of
 * text to be parsed back out of. Verified against a module that had
 * frozen `Error` outright with a non-configurable hook returning null
 * on it — the location still comes back.
 *
 * The depth asked for is well past what is needed rather than the
 * measured one: the loader stands 6 frames over an
 * `import.meta.resolve` and 12 over a dynamic `import()`, and the
 * default of 10 is between them — which is how the dynamic case first
 * looked like one that leaves no frame. Depth is not a function of the
 * module, since the frame wanted is the innermost of its own.
 *
 * Nothing here may throw whatever else it finds: an error raised out of
 * this would leave the module refused for something that is not the
 * refusal at all. Giving up means giving up on the location alone, and
 * the source still answers for everything written plainly.
 */
function siteWhereItRan(moduleUrl, code) {
  if (getCallSites === null) return null;
  let frames;
  try {
    frames = getCallSites(STACK_DEPTH);
  } catch {
    return null;
  }
  for (const frame of frames) {
    if (frame?.scriptName === moduleUrl && typeof frame.lineNumber === "number") return siteOnLine(code, frame.lineNumber);
  }
  return null;
}

/**
 * The sentence a refused module is given.
 *
 * It names where in the module the problem is, and that is the point of
 * it. The refusal this replaced named a package and stopped, so the one
 * that misfired had to be diagnosed by reading the module against a
 * regular expression — which is not something a module author should
 * ever have to do.
 *
 * `ranAt` is the site the stack gave, when the resolution happened
 * somewhere a stack could see it. Reading the source comes first: it
 * finds every place the specifier is written rather than the one that
 * fired, and it is the answer for the two shapes that leave no frame at
 * all.
 */
export function importRefusal(specifier, code, ranAt = null) {
  const quoted = JSON.stringify(specifier);
  // Withheld is withheld either way it is written. `import "child_process"`
  // is a bare builtin *and* a blocked one, and telling its author to
  // write it the long way would be sending them to a second refusal.
  const asBuiltin = specifier.startsWith("node:") ? specifier : `node:${specifier}`;
  let why;
  // Existence first, so nothing is described as a builtin that is not
  // one. `node:vm/nope` has a withheld root and is still no module, and
  // calling it "a Node builtin EO withholds" would be this refusal
  // making the same kind of confident wrong claim the scan used to.
  if (nodeBuiltin(asBuiltin) && withheldBuiltin(asBuiltin)) {
    why = `This module reaches for ${quoted}. It is a Node builtin, but one EO withholds: these are the ones that hand a module a way around the rest of the contract — around \`needs.bin\`, around the ban on npm packages, or into a fresh realm where none of it is checked at all.`;
  } else if (!specifier.startsWith("node:") && nodeBuiltin(specifier)) {
    why = `This module reaches for ${quoted}. That is a Node builtin, but a module has to name one the long way: write "node:${specifier}".`;
  } else if (isBuiltin(asBuiltin)) {
    // Resolves, and only here. EO's host is Electron running as Node, so
    // the loader knows `original-fs` and its own js2c bundles; a machine
    // that imported this pipeline would not.
    why = `This module reaches for ${quoted}. It resolves in EO's own host, which is Electron running as Node, and nowhere else — Node has no builtin by that name. Modules may import Node's own builtins only, so that a pipeline still runs where it is exported to.`;
  } else if (specifier.startsWith("node:")) {
    // Spelled like a builtin and is not one. Left to `next()` this came
    // back as Node's own ERR_UNKNOWN_BUILTIN_MODULE, which names no line
    // and no rule — so it is refused here and gets both.
    why = `This module reaches for ${quoted}. It is spelled like a Node builtin, but this Node has no builtin by that name, so nothing resolves it — here or on any other machine. Check the spelling.`;
  } else {
    why = `This module reaches for ${quoted}. Modules may import Node builtins (node:…) only — anything else would not survive being exported to another machine.`;
  }

  const written = specifierSites(code, specifier);
  // Where the specifier is written wins: it is what an author is looking
  // for, and it names every place rather than the one that happened to
  // fire first.
  const calls = written.length > 0 ? [] : computedImportSites(code);
  // The two together are better than either. The source says which calls
  // assembled their specifier; the stack says which call it actually
  // was. Where they agree, the answer is one line and the reason for it.
  const assembled = ranAt === null ? calls : calls.filter((site) => site.line === ranAt.line);
  const ran = assembled.length === 0 && ranAt !== null ? [ranAt] : [];
  const sites = written.length > 0 ? written : ran.length > 0 ? ran : assembled;
  if (sites.length === 0) return why;

  // "assembled" rather than a line number the module does not have: a
  // specifier built out of pieces is written nowhere, so the honest
  // thing to point at is the call that asked for it. That claim is only
  // made where the source bears it out — a specifier reached through a
  // name the module gave it is written plainly on the line and merely
  // could not be read from there, so it gets the neutral sentence.
  const where =
    written.length > 0
      ? "It is written here:"
      : ran.length > 0
        ? "The module asked for it here:"
        : `The specifier is assembled while the module runs, so it appears nowhere in the source. ${sites.length === 1 ? "The call that asked for it:" : "One of these asked for it:"}`;
  const shown = sites.slice(0, MAX_SITES).map((site) => `  line ${site.line}: ${site.text}`);
  if (sites.length > MAX_SITES) shown.push(`  …and ${sites.length - MAX_SITES} more`);
  return `${why}\n\n${where}\n${shown.join("\n")}`;
}

/**
 * Installs the hook for one module and reports what it refused.
 *
 * Only what the module itself asks for: the entry arrives with this
 * host's own file URL as its parent, and everything else resolving in
 * this process is EO's. Comparing against the module's URL rather than
 * merely testing for a parent is what keeps that exact — and it closes
 * the recursion too, since nothing else can ever *become* a parent when
 * the first hop away from the module is already refused.
 *
 * The refusal is remembered as well as thrown, for the dynamic case. A
 * static import cannot be caught — the module has not run — but
 * `try { await import("axios") } catch {}` can be, and a module that
 * asked for something it may not have and carried on as though it had
 * not does not get to report success. Nothing silently drops work on the
 * floor (invariant #8), so it goes to the transcript at the moment it
 * happens as well as into the outcome afterwards.
 *
 * First refusal only. It is the one the author has to fix, and a module
 * in a retry loop would otherwise rewrite the reason on every turn.
 */
export function guardImports(moduleUrl, code) {
  let refusal = null;
  registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL !== moduleUrl) return next(specifier, context);
      if (permittedSpecifier(specifier)) return next(specifier, context);
      if (refusal === null) {
        refusal = importRefusal(specifier, code, siteWhereItRan(moduleUrl, code));
        emit({ type: "output", text: `EO refused an import: ${refusal}\n` });
      }
      const error = new Error(`EO does not allow this module to import ${JSON.stringify(specifier)}.`);
      error.code = FORBIDDEN_IMPORT;
      throw error;
    },
  });
  return { refusal: () => refusal };
}

/**
 * Runs a declared binary in the worktree.
 *
 * `ctx.exec` rather than letting a module reach `node:child_process`
 * itself, because this is what makes `needs.bin` a promise EO keeps
 * rather than a line of documentation. No shell: the binary is declared,
 * the arguments are an array, and there is nothing to quote — which is
 * the one respect in which this is stricter than the check commands
 * `runCommand` runs, where a person typed the command line themselves.
 *
 * The wall clock and the process tree are the parent's business. It
 * spawns this host detached and kills the whole group, so a child started
 * here dies with it.
 */
function makeExec(request, env) {
  const allowed = new Set(request.needs.bin);
  return (bin, args = []) =>
    new Promise((resolve, reject) => {
      if (typeof bin !== "string" || bin === "") {
        reject(new Error("ctx.exec needs the name of a binary."));
        return;
      }
      if (!allowed.has(bin)) {
        reject(new Error(`This module did not declare "${bin}" in needs.bin, so it may not run it.`));
        return;
      }
      emit({ type: "exec", bin, args });

      // `windowsHide` for the same reason `runModule` passes it when it
      // spawns this host (EO-204): a console program started by a parent
      // that has no console gets a new one, and a new console is a
      // window. The host is spawned hidden, so a grandchild started here
      // inherits that and there is nothing to see — but "the parent
      // happened to be started correctly" is not a property this call
      // site can read, and a module runs whatever binary it declared.
      const child = spawn(bin, args, { cwd: request.cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      // Bounded while still running, the way `runCommand` bounds its own
      // buffer: a command can print gigabytes, and holding all of it
      // would take the host down with an OOM long before anyone read it.
      // The tail is the part that matters — it is where a failing
      // command says what broke.
      const keepTail = (text, chunk) => (text + chunk).slice(-MAX_CAPTURE_CHARS);
      child.stdout.on("data", (chunk) => {
        stdout = keepTail(stdout, chunk);
        emit({ type: "output", text: String(chunk) });
      });
      child.stderr.on("data", (chunk) => {
        stderr = keepTail(stderr, chunk);
        emit({ type: "output", text: String(chunk) });
      });
      child.on("error", (error) => reject(error));
      child.on("close", (code) => resolve({ code, stdout, stderr, tail: (stdout + stderr).slice(-4000) }));
    });
}

// ── Reading an item ───────────────────────────────────────────

/** A number, or null for anything else — a missing date is missing, not zero. */
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Null rather than "null": a missing branch is missing, not the word. */
function asText(value) {
  return typeof value === "string" ? value : null;
}

/** The strings in a list, frozen; `[]` for anything that is not one. */
function textList(value) {
  return Object.freeze((Array.isArray(value) ? value : []).filter((entry) => typeof entry === "string"));
}

/** A plain object or array as frozen data, all the way down, and a copy: nothing a module holds is shared with what it was built from. */
function frozenData(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenData));
  if (value !== null && typeof value === "object") {
    const copy = {};
    for (const [name, entry] of Object.entries(value)) copy[name] = frozenData(entry);
    return Object.freeze(copy);
  }
  return value === undefined ? null : value;
}

/** An object's fields as frozen data, or `{}` — so `ctx.item().spec.automerge` reads undefined rather than throwing. */
function frozenRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? frozenData(value) : Object.freeze({});
}

/** A list, each entry shaped, frozen; `[]` for anything that is not one. */
function frozenList(value, shape) {
  return Object.freeze((Array.isArray(value) ? value : []).map((entry) => shape(entry !== null && typeof entry === "object" ? entry : {})));
}

/** An object shaped, or null where there is none. */
function shapedOrNull(value, shape) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? shape(value) : null;
}

/**
 * One comment, as a program reads one rather than as a person does.
 *
 * `author` is the pair rather than the "you" / "EO" / agent-name string
 * `mcp/eoServer.mjs` renders: that service writes prose for an agent to
 * read, and this is read by an `if`. `id` and `parentId` stay because a
 * reply is only a reply by pointing at what it answers — which is how a
 * module finds the answer to the question it asked. A comment's files
 * are in the item's `attachments`, each naming the comment it is on.
 */
function commentShape(value) {
  const author = value.author !== null && typeof value.author === "object" ? value.author : {};
  return Object.freeze({
    id: asText(value.id),
    parentId: asText(value.parentId),
    author: Object.freeze({ type: asText(author.type), name: asText(author.name) }),
    kind: asText(value.kind),
    body: asText(value.body),
    pinned: value.pinned === true,
    createdAt: asNumber(value.createdAt),
  });
}

/** Another item this one is related to (EO-709): enough to name it and to know whether it is done. */
function relationShape(value) {
  return Object.freeze({
    key: asText(value.key),
    title: asText(value.title),
    type: asText(value.type),
    stepName: asText(value.stepName),
    finished: value.finished === true,
  });
}

/**
 * What a module is told about an item (EO-74, EO-709).
 *
 * ## Everything, because modules may read everything
 *
 * This was once argued narrow on purpose — "the narrower this is, the
 * less an exported module can come to depend on" — and widened a field
 * at a time against that argument. The decision on ASK-67 overturned
 * it: a module may read everything EO holds about an item, and only a
 * secret's value stays limited to what the module declares in
 * `needs.env`. A check that belongs in a module — merge only when the
 * item's `automerge` field is set, refuse when the pull request targets
 * the default branch — could not be written while the fields, the step
 * and the branch it targets were held back.
 *
 * So the item comes whole: its id and key, its fields as stored
 * (`spec`) with its type's field definitions (`fields`), so "not set"
 * can be told from `false`; its priority and state; where it sits — the
 * pipeline, the step and the pipeline version it entered on; its git
 * state, including `targetBranch`, the branch its pull request is or
 * will be opened against; every pack's extension data, keyed by
 * extension; its parent, children and dependencies both ways; its
 * files, without their content; and its thread.
 *
 * What a module must still not lean on is what differs between
 * installations: pipeline and step ids and names, and the version
 * number, are where *this* EO keeps the item, and an exported module
 * that branched on one would break on arrival somewhere else.
 *
 * ## One shape, from two places
 *
 * The main process builds the answer (`moduleItemView`, beside what
 * `item_get` is built from) and a test case writes a partial one; both
 * come through here, so a field a real run has is a field the fixture
 * has. A field left out is null, `false`, `[]` or `{}` — never missing,
 * and never a throw. Every name a module approved before this read
 * (`key` … `comments`) keeps its meaning; `branch` and `prUrl` are the
 * same values as `git.branch` and `git.pullRequest`, and either spelling
 * fills the other when a fixture gives only one.
 */
function itemShape(value) {
  const item = value !== null && typeof value === "object" ? value : {};
  const git = item.git !== null && typeof item.git === "object" ? item.git : {};
  const parent = shapedOrNull(item.parent, relationShape);
  const branch = asText(item.branch) ?? asText(git.branch);
  const pullRequest = asText(item.prUrl) ?? asText(git.pullRequest);
  return Object.freeze({
    id: asText(item.id),
    key: asText(item.key),
    type: asText(item.type),
    title: asText(item.title),
    body: asText(item.body),
    parentKey: asText(item.parentKey) ?? parent?.key ?? null,
    branch,
    prUrl: pullRequest,
    jiraKey: asText(item.jiraKey),
    createdAt: asNumber(item.createdAt),
    updatedAt: asNumber(item.updatedAt),
    comments: frozenList(item.comments, commentShape),
    spec: frozenRecord(item.spec),
    fields: frozenList(item.fields, fieldDefinitionShape),
    priority: asNumber(item.priority),
    heldAt: asNumber(item.heldAt),
    archivedAt: asNumber(item.archivedAt),
    trial: item.trial === true,
    createdBy: asText(item.createdBy),
    pipeline: shapedOrNull(item.pipeline, pipelineRefShape),
    step: shapedOrNull(item.step, (step) =>
      Object.freeze({ id: asText(step.id), name: asText(step.name), kind: asText(step.kind), ownerRole: asText(step.ownerRole) }),
    ),
    pipelineVersion: shapedOrNull(item.pipelineVersion, (version) => Object.freeze({ id: asText(version.id), number: asNumber(version.number) })),
    git: Object.freeze({
      branch: asText(git.branch) ?? branch,
      baseBranch: asText(git.baseBranch),
      namedBranch: git.namedBranch === true,
      attachedAt: asText(git.attachedAt),
      pullRequest: asText(git.pullRequest) ?? pullRequest,
      reference: asText(git.reference),
      targetBranch: asText(git.targetBranch),
      // The item's own reviewers as stored — null inherits, [] is
      // nobody — beside the list the pull request step will ask, as
      // `baseBranch` sits beside `targetBranch` (EO-742).
      reviewers: Array.isArray(git.reviewers) ? textList(git.reviewers) : null,
      pullRequestReviewers: textList(git.pullRequestReviewers),
    }),
    extensions: frozenRecord(item.extensions),
    parent,
    children: frozenList(item.children, relationShape),
    dependsOn: frozenList(item.dependsOn, relationShape),
    dependedOnBy: frozenList(item.dependedOnBy, relationShape),
    attachments: frozenList(item.attachments, (attachment) =>
      Object.freeze({
        id: asText(attachment.id),
        name: asText(attachment.name),
        mimeType: asText(attachment.mimeType),
        size: asNumber(attachment.size),
        commentId: asText(attachment.commentId),
        createdAt: asNumber(attachment.createdAt),
      }),
    ),
  });
}

// ── An item's history, the board and a file's bytes (EO-710) ──
//
// Four reads beyond the item itself, each asked of the main process on
// the channel `ctx.item()` uses and each answered in a shape built here,
// from the parent's answer on a real run and from a fixture in a test
// case alike — so a field a real run has is a field a fixture has, and
// anything a fixture leaves out is null.

/** A step a run or a move names: its id, and its name as the item's own version gives it. */
function stepRefShape(value) {
  return Object.freeze({ id: asText(value.id), name: asText(value.name) });
}

/** One run on an item, oldest first in the list `ctx.runs()` answers. */
function runShape(value) {
  return Object.freeze({
    id: asText(value.id),
    step: shapedOrNull(value.step, stepRefShape),
    action: asText(value.action),
    agentName: asText(value.agentName),
    status: asText(value.status),
    resultKey: asText(value.resultKey),
    answer: frozenData(value.answer ?? null),
    error: asText(value.error),
    attempt: asNumber(value.attempt),
    startedAt: asNumber(value.startedAt),
    endedAt: asNumber(value.endedAt),
    costCents: asNumber(value.costCents),
  });
}

/** One step move, oldest first in the list `ctx.transitions()` answers. `from` is null for the item's first step. */
function transitionShape(value) {
  return Object.freeze({
    from: shapedOrNull(value.from, stepRefShape),
    to: shapedOrNull(value.to, stepRefShape),
    actor: asText(value.actor),
    reason: asText(value.reason),
    at: asNumber(value.at),
  });
}

/** One item as `ctx.items()` lists it. `ctx.itemByKey()` reads one whole. */
function itemSummaryShape(value) {
  return Object.freeze({
    key: asText(value.key),
    title: asText(value.title),
    type: asText(value.type),
    pipelineName: asText(value.pipelineName),
    stepName: asText(value.stepName),
    parentKey: asText(value.parentKey),
  });
}

/** What `ctx.items()` may be narrowed by — `items_list`'s filters — and the page. */
const ITEMS_FILTER_KINDS = Object.freeze({
  stepId: "text",
  stepName: "text",
  pipelineId: "text",
  type: "text",
  parentKey: "text",
  keys: "keys",
  text: "text",
  createdSince: "count",
  updatedSince: "count",
  atTerminalStep: "boolean",
  offset: "count",
  limit: "limit",
});

/** The most items one page holds, and how many when a module does not say. `MODULE_ITEMS_PAGE_*` in `moduleItemRead.ts`, which this file cannot import. */
const ITEMS_PAGE_MAX = 500;
const ITEMS_PAGE_DEFAULT = 100;

/**
 * A module's `ctx.items()` filter, checked and copied as plain data, or
 * the sentence saying what is wrong with it.
 *
 * Checked here, before anything is asked, so a test case and a real run
 * refuse one filter with the same words; the parent checks it again.
 * Copied through JSON so that what is sent is data — a filter holding a
 * cycle or a getter must answer with a reason, not stop the run.
 */
function readItemsFilter(value) {
  if (value === undefined || value === null) return { filter: {} };
  const shape = 'ctx.items() takes one object of filters, like { parentKey: "EO-42" } or { text: "login", limit: 20 }.';
  if (typeof value !== "object" || Array.isArray(value)) return { reason: shape };
  let filter;
  try {
    filter = PRIMORDIALS.jsonParse(PRIMORDIALS.jsonStringify(value));
  } catch {
    return { reason: shape };
  }
  // Checked again on what came out: a `toJSON` decides what is sent, so
  // `{ toJSON() { return null; } }` is an object going in and null out.
  if (filter === null || typeof filter !== "object" || PRIMORDIALS.isArray(filter)) return { reason: shape };
  for (const name of PRIMORDIALS.keys(filter)) {
    if (!Object.hasOwn(ITEMS_FILTER_KINDS, name)) {
      return { reason: `ctx.items() does not take ${PRIMORDIALS.jsonStringify(name)}. It takes ${PRIMORDIALS.keys(ITEMS_FILTER_KINDS).join(", ")}.` };
    }
    const kind = ITEMS_FILTER_KINDS[name];
    const entry = filter[name];
    const fits =
      kind === "text"
        ? typeof entry === "string" && entry !== ""
        : kind === "keys"
          ? PRIMORDIALS.isArray(entry) && entry.length > 0 && entry.length <= 1000 && entry.every((key) => typeof key === "string" && key !== "")
          : kind === "boolean"
            ? typeof entry === "boolean"
            : kind === "limit"
              ? Number.isInteger(entry) && entry >= 1 && entry <= ITEMS_PAGE_MAX
              : Number.isInteger(entry) && entry >= 0;
    if (!fits) {
      const wanted =
        kind === "text"
          ? "a non-empty string"
          : kind === "keys"
            ? 'a list of 1 to 1000 keys, like ["EO-42"]'
            : kind === "boolean"
              ? "true or false"
              : kind === "limit"
                ? `a whole number from 1 to ${ITEMS_PAGE_MAX}`
                : "a whole number, 0 or more";
      return { reason: `ctx.items()'s ${name} is ${wanted}.` };
    }
  }
  return { filter };
}

/** A page of item summaries, as `ctx.items()` answers it. */
function itemsPageShape(value) {
  const page = value !== null && typeof value === "object" ? value : {};
  return Object.freeze({
    found: true,
    items: frozenList(page.items, itemSummaryShape),
    total: asNumber(page.total) ?? 0,
    nextOffset: asNumber(page.nextOffset),
  });
}

/**
 * One file and its bytes, as `ctx.readAttachment()` answers it.
 *
 * `content` is a fresh Buffer on every read — a Buffer is a Uint8Array,
 * so it is bytes for any code that wants bytes and `.toString("utf8")`
 * for text — and the one thing here not frozen, because a typed array
 * holding anything cannot be.
 */
function attachmentContentShape(value, content) {
  return Object.freeze({
    found: true,
    attachment: Object.freeze({
      id: asText(value.id),
      name: asText(value.name),
      mimeType: asText(value.mimeType),
      size: content.byteLength,
      content,
    }),
  });
}

/** The sentence for an attachment id that is not one. */
const ATTACHMENT_ID_SHAPE = "An attachment id is a string, as ctx.item().attachments lists it.";

// ── The run, the workspace and the project (EO-711) ──────────
//
// Three values rather than reads: the parent builds them once, when the
// run starts, and sends them on stdin with everything else, so a module
// reads `ctx.run`, `ctx.workspace` and `ctx.project` without `await`.
// None of it changes while the run does. A test case writes a partial
// of each and comes through the same shapes, so a field a real run has
// is a field a fixture has, null where it was left out.
//
// None of it is a secret: no environment variable, keychain value,
// connector credential or forge token goes into building any of them.
// What does differ between installations — every step and pipeline id
// and name, every workspace id and path — is for a module to read and
// report, not to branch on: an exported module that compared one with a
// literal would break on arrival somewhere else.

/** A field an item type defines: its name, its kind and whether it is required. `ctx.item().fields` and `ctx.project.itemTypes[].fields` alike. */
function fieldDefinitionShape(field) {
  return Object.freeze({ name: asText(field.name), kind: asText(field.kind), required: field.required === true });
}

/** A pipeline named by id and name. */
function pipelineRefShape(value) {
  return Object.freeze({ id: asText(value.id), name: asText(value.name) });
}

/**
 * `ctx.run`: the step and pipeline this run is on, which attempt it is,
 * what brought the item here (the step it left and the result that
 * routed it), whether it is a trial's test item, and — on a step that
 * keeps checking — since when, how long so far and how often.
 *
 * On an intake check (EO-752) — `intake` as `intakeShape` made it —
 * there is no step and nothing came from anywhere, so `step` and
 * `cameFrom` are null whatever was sent; `pipeline` is the job's, and
 * `intake` says which job. Null on every other run.
 */
function runContextShape(value, intake = null) {
  const run = value !== null && typeof value === "object" ? value : {};
  const cameFrom = run.cameFrom !== null && typeof run.cameFrom === "object" ? run.cameFrom : {};
  return Object.freeze({
    step: intake === null ? shapedOrNull(run.step, stepRefShape) : null,
    pipeline: shapedOrNull(run.pipeline, pipelineRefShape),
    attempt: asNumber(run.attempt),
    cameFrom:
      intake === null ? Object.freeze({ step: shapedOrNull(cameFrom.step, stepRefShape), result: asText(cameFrom.result) }) : null,
    trial: run.trial === true,
    watch: shapedOrNull(run.watch, (watch) =>
      Object.freeze({ startedAt: asNumber(watch.startedAt), waitingMs: asNumber(watch.waitingMs), intervalMs: asNumber(watch.intervalMs) }),
    ),
    intake,
  });
}

/**
 * `ctx.run.intake` (EO-752): on an intake check — a run of a watch
 * module made for a job, with no item — the job it checks for,
 * `{ job: { id, name } }`. Null where nothing was sent, which is every
 * run that is not one.
 */
function intakeShape(value) {
  if (value === null || typeof value !== "object") return null;
  const job = value.job !== null && typeof value.job === "object" ? value.job : {};
  return Object.freeze({ job: Object.freeze({ id: asText(job.id), name: asText(job.name) }) });
}

/**
 * What an intake check is answered when it asks for something that needs
 * an item (EO-752). Every one says an intake check has no item, and what
 * to do instead where there is something.
 */
const INTAKE_NO_ITEM = "An intake check has no item";

/** `ctx.item()` and `ctx.ticket()` on an intake check (EO-752). */
function intakeItemRead(intake) {
  const answer = Object.freeze({ found: false, reason: `${INTAKE_NO_ITEM}: this run checks for the job "${intake.job.name}". ctx.itemByKey still reads any item by its key.` });
  return () => answer;
}

/**
 * `ctx.comment`, `ctx.attach` and `ctx.createItem` on an intake check
 * (EO-752): each refuses, in the shape it answers with anywhere else,
 * and says so in the transcript as its other refusals do (invariant #8).
 * `ctx.commentOn` is not among them: it names its item.
 */
function intakeWrites() {
  const refused = (said, reason, answer) => {
    emit({ type: "output", text: `${said}: ${reason}\n` });
    return Object.freeze(answer(reason));
  };
  const { Promise: NativePromise } = PRIMORDIALS;
  return {
    comment: () => refused("EO did not post a comment", `${INTAKE_NO_ITEM} to comment on. ctx.commentOn can still comment on another item by its key.`, (reason) => ({ posted: false, reason })),
    attach: async () => refused("EO did not attach files", `${INTAKE_NO_ITEM} to attach files to.`, (reason) => ({ attached: false, reason })),
    createItem: () => {
      const answer = refused(
        "EO did not create an item",
        `${INTAKE_NO_ITEM} to create items from. Return what the check found as findings on a "${WAITING_RESULT}" answer, and EO files each one on the job's pipeline.`,
        (reason) => ({ created: false, reason }),
      );
      return new NativePromise((resolve) => resolve(answer));
    },
  };
}

/**
 * `ctx.entry` (EO-736): on an entry check, the door the item is entering
 * by — `creation`, `move`, `route` or `job` — the pipeline it is entering
 * and, for a move or a route, the step it came from. Null on every run
 * that is not an entry check.
 */
function entryContextShape(value) {
  if (value === null || typeof value !== "object") return null;
  return Object.freeze({
    door: asText(value.door),
    pipeline: shapedOrNull(value.pipeline, pipelineRefShape),
    fromStep: shapedOrNull(value.fromStep, stepRefShape),
  });
}

/**
 * `ctx.workspace`: its kind, id and name and, on a git repository,
 * `git`. `git.worktreePath` is `cwd` whatever was sent — the directory
 * the module runs in is the one fact here this side knows first-hand.
 */
function workspaceContextShape(value, cwd) {
  const workspace = value !== null && typeof value === "object" ? value : {};
  return Object.freeze({
    kind: asText(workspace.kind),
    id: asText(workspace.id),
    name: asText(workspace.name),
    git: shapedOrNull(workspace.git, (git) => {
      const forge = git.forge !== null && typeof git.forge === "object" ? git.forge : {};
      return Object.freeze({
        repositoryName: asText(git.repositoryName),
        mainCheckout: asText(git.mainCheckout),
        worktreePath: cwd,
        baseBranch: asText(git.baseBranch),
        testCommand: asText(git.testCommand),
        lintCommand: asText(git.lintCommand),
        buildCommand: asText(git.buildCommand),
        forge: Object.freeze({
          kind: asText(forge.kind),
          remote: asText(forge.remote),
          draft: forge.draft === true,
          opensPullRequests: forge.opensPullRequests === true,
        }),
      });
    }),
  });
}

/** `ctx.project`: its id, name and key prefix, its workspaces, its item types with their fields, and its pipelines with their steps. */
function projectContextShape(value) {
  return Object.freeze({
    id: asText(value.id),
    name: asText(value.name),
    keyPrefix: asText(value.keyPrefix),
    workspaces: frozenList(value.workspaces, (workspace) => Object.freeze({ kind: asText(workspace.kind), id: asText(workspace.id), name: asText(workspace.name) })),
    itemTypes: frozenList(value.itemTypes, (type) =>
      Object.freeze({
        id: asText(type.id),
        slug: asText(type.slug),
        label: asText(type.label),
        container: type.container === true,
        fields: frozenList(type.fields, fieldDefinitionShape),
      }),
    ),
    pipelines: frozenList(value.pipelines, (pipeline) =>
      Object.freeze({
        id: asText(pipeline.id),
        name: asText(pipeline.name),
        steps: frozenList(pipeline.steps, (step) => Object.freeze({ id: asText(step.id), name: asText(step.name), kind: asText(step.kind) })),
      }),
    ),
  });
}

/**
 * The line a module's transcript carries the first time it calls one of
 * the old names (KAN-162).
 *
 * The retirement version is duplicated from `ALIAS_RETIREMENT_VERSION`
 * in `@eo/core` rather than imported, because this file ships unbundled
 * — the host is spawned by path and resolves nothing but Node's own
 * builtins. `runModule.test.ts` pins it against core so the two cannot
 * drift.
 */
const CONTEXT_DEPRECATION_LINE =
  "EO: this module called ctx.ticket() or ctx.ticketByKey(). Those names are deprecated; use ctx.item() and " +
  "ctx.itemByKey(), which answer identically. The old names are retired after v0.1.";

/**
 * How a read reaches the parent and its answer comes back (EO-709).
 *
 * Out on fd 3 as a `read` event, back on fd 6 as one signed line — the
 * format, the key and the checks are the creation channel's, so
 * everything said above `makeCreationChannel` about what counts as an
 * answer holds here too, and every function this calls was taken from
 * `PRIMORDIALS` before the module was imported.
 *
 * What differs is that this one waits. `ctx.item()` is called without
 * `await` — every module written so far does — so the answer has to be
 * in hand before it returns: the read on fd 6 is synchronous, and the
 * process does nothing else until the parent has answered. That is why
 * reads have a descriptor of their own: a synchronous read on fd 5
 * could take a creation's answer from under the asynchronous read
 * waiting there for it.
 *
 * Answers `{ payload }`, or `{ failed }` with the sentence saying why
 * no answer can come — after which every later read fails the same way
 * at once, rather than waiting on a channel that has already ended.
 */
function makeReadChannel(key) {
  const { readSync, hmac, hmacUpdate, hmacDigest, jsonParse, indexOf, slice, latin1, uuid, wait } = PRIMORDIALS;
  let failure = typeof key === "string" && key !== "" ? null : "this run was given no way to check EO's answer.";
  let buffered = "";
  const chunk = Buffer.allocUnsafe(65536);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));

  const verified = (line) => {
    const space = indexOf(line, " ");
    if (space <= 0) return null;
    const signed = slice(line, space + 1);
    if (slice(line, 0, space) !== hmacDigest(hmacUpdate(hmac("sha256", key), signed), "hex")) return null;
    try {
      const framed = jsonParse(signed);
      return framed !== null && typeof framed === "object" && typeof framed.id === "string" ? framed : null;
    } catch {
      return null;
    }
  };

  return (question) => {
    if (failure !== null) return { failed: failure };
    const id = uuid();
    emit(question.filter === undefined ? { type: "read", id, what: question.what, key: question.key } : { type: "read", id, what: question.what, key: question.key, filter: question.filter });
    for (;;) {
      for (let end = indexOf(buffered, "\n"); end !== -1; end = indexOf(buffered, "\n")) {
        const framed = verified(slice(buffered, 0, end));
        buffered = slice(buffered, end + 1);
        if (framed !== null && framed.id === id) return { payload: framed.payload };
      }
      let bytesRead;
      try {
        bytesRead = readSync(READ_FD, chunk, 0, chunk.length, null);
      } catch (error) {
        // A descriptor that answers "nothing yet" instead of waiting —
        // which it is belongs to the platform. A short sleep, not a
        // spin, and ask again.
        if (error && error.code === "EAGAIN") {
          wait(sleeper, 0, 0, 2);
          continue;
        }
        failure = `EO's answer could not be read: ${error instanceof Error ? error.message : String(error)}`;
        return { failed: failure };
      }
      if (bytesRead === 0) {
        failure = "EO stopped answering before this read was answered.";
        return { failed: failure };
      }
      buffered += latin1(chunk, 0, bytesRead);
    }
  };
}

/**
 * `ctx.item()`, `ctx.itemByKey()` and the two deprecated names beside
 * them, answered by the main process (EO-709).
 *
 * All four answer `{ found: true, item, ticket }` or
 * `{ found: false, reason }`, and none throws. A key nothing matches is
 * an ordinary answer a module can act on — or hand back as its own
 * `reason`, which is the sentence a person would want anyway. A throw
 * would end the run in a stack trace instead, and an empty object would
 * read like an item that exists and has no title.
 *
 * One shape for both, including the unreadable case, because a module
 * that has to branch two ways to read an item will branch one way and
 * be wrong on the other.
 *
 * The host used to answer these with SQL of its own against a read-only
 * handle on EO's database. That SQL was a second reader nobody's
 * migration updated, and it could only ever say what a few columns
 * held; `ask` puts the question to the main process instead, which
 * builds the answer with the code the screens and `item_get` use. So
 * nothing here opens the database any more.
 *
 * ## Why the answer carries the item twice (KAN-162)
 *
 * `item` and `ticket` are the same frozen object under two keys, and
 * that is the same "one shape" argument one level down. A module's code
 * is approved by the hash of its body, so a module reading `.ticket`
 * cannot be edited to read `.item` without a person approving it again —
 * and a module written today should not have to say `.ticket`. Keying
 * the result on which *method* was called would mean the shape depended
 * on the spelling, which is the branch this function exists to remove.
 *
 * The deprecated names are not refused, not slowed and not degraded:
 * they are the same call. What they do is put one line in the
 * transcript, once per run however many times they are called, so the
 * person reading a module's output learns the names are on a clock
 * before the release that removes them (invariant #12 — an absence is
 * never left to be discovered).
 */
function makeItemReads(ask, runningKey) {
  let warned = false;

  /**
   * Said once, on the first deprecated call, and never again.
   *
   * Per run rather than per call because a module in a loop would
   * otherwise bury its own output in the warning about it, and a
   * transcript is append-only (invariant #3) — there is no later pass
   * that could thin it out.
   */
  const deprecated = () => {
    if (warned) return;
    warned = true;
    emit({ type: "output", text: `${CONTEXT_DEPRECATION_LINE}\n` });
  };

  /**
   * The parent's answer to one question, or the sentence that says why
   * there is none.
   *
   * Shared by the read and by `ctx.commentOn`'s key check (EO-75) so the
   * two answer a bad key with the same words — a module told "no ticket
   * has the key" by one and something else by the other would be a
   * module that has to learn EO's phrasing twice.
   */
  const question = (what, key) => {
    if (typeof key !== "string" || key.trim() === "") return { reason: 'A ticket key is a string, like "EO-42".' };
    const asked = key.trim();
    const answer = ask({ what, key: asked });
    if (answer.failed !== undefined) return { reason: `EO's ticket store could not be read: ${answer.failed}` };
    const payload = answer.payload !== null && typeof answer.payload === "object" ? answer.payload : {};
    if (typeof payload.unavailable === "string") return { reason: payload.unavailable };
    return { key: asked, payload };
  };

  const read = (key) => {
    const at = question("item", key);
    if (at.payload === undefined) return Object.freeze({ found: false, reason: at.reason });
    if (at.payload.item === null || typeof at.payload.item !== "object") return Object.freeze({ found: false, reason: `No ticket has the key "${at.key}".` });
    const item = itemShape(at.payload.item);
    // `ticket` beside `item`, and the same object rather than a copy
    // of it — see the note above on why the shape does not depend on
    // which name was called.
    return Object.freeze({ found: true, item, ticket: item });
  };

  /**
   * Whether a key names an item, without building the shape.
   *
   * `ctx.commentOn` needs the answer and nothing else, and reading a
   * whole thread to discard it would make posting a comment cost what
   * reading an item costs.
   */
  const resolve = (key) => {
    const at = question("exists", key);
    if (at.payload === undefined) return Object.freeze({ found: false, reason: at.reason });
    if (at.payload.exists !== true) return Object.freeze({ found: false, reason: `No ticket has the key "${at.key}".` });
    return Object.freeze({ found: true, key: at.key });
  };

  /**
   * An item's runs or its step moves (EO-710): the list, oldest first,
   * or the reason there is none — the same reasons `ctx.itemByKey()`
   * gives, for the same key.
   */
  const history = (what, key, shape) => {
    const at = question(what, key);
    if (at.payload === undefined) return Object.freeze({ found: false, reason: at.reason });
    const list = at.payload[what];
    if (!PRIMORDIALS.isArray(list)) return Object.freeze({ found: false, reason: `No ticket has the key "${at.key}".` });
    return Object.freeze({ found: true, [what]: frozenList(list, shape) });
  };

  /** The parent's answer to a question that is not about one item's key, or the sentence why there is none. */
  const plain = (asked) => {
    const answer = ask(asked);
    if (answer.failed !== undefined) return { reason: `EO's ticket store could not be read: ${answer.failed}` };
    const payload = answer.payload !== null && typeof answer.payload === "object" ? answer.payload : {};
    if (typeof payload.unavailable === "string") return { reason: payload.unavailable };
    if (typeof payload.refused === "string") return { reason: payload.refused };
    return { payload };
  };

  /** A page of the running item's project's items (EO-710). */
  const items = (value) => {
    const read = readItemsFilter(value);
    if (read.reason !== undefined) return Object.freeze({ found: false, reason: read.reason });
    const at = plain({ what: "items", key: runningKey, filter: read.filter });
    if (at.payload === undefined) return Object.freeze({ found: false, reason: at.reason });
    return itemsPageShape(at.payload.items);
  };

  /** One file on any item, and its bytes (EO-710). */
  const readAttachment = (id) => {
    if (typeof id !== "string" || id.trim() === "") return Object.freeze({ found: false, reason: ATTACHMENT_ID_SHAPE });
    const asked = id.trim();
    const at = plain({ what: "attachment", key: asked });
    if (at.payload === undefined) return Object.freeze({ found: false, reason: at.reason });
    const file = at.payload.attachment;
    if (file === null || typeof file !== "object") return Object.freeze({ found: false, reason: `No attachment has the id "${asked}".` });
    return attachmentContentShape(file, Buffer.from(typeof file.content === "string" ? file.content : "", "base64"));
  };

  return {
    /** The item this step is running on. Its key came in on the request. */
    item: () => read(runningKey),
    itemByKey: (key) => read(key),
    /** The same two reads under the names a module approved before KAN-162 may still call. */
    ticket: () => {
      deprecated();
      return read(runningKey);
    },
    ticketByKey: (key) => {
      deprecated();
      return read(key);
    },
    /** Says the deprecated names are deprecated, once — for `ctx.ticket()` on an intake check (EO-752), which reads nothing. */
    deprecated,
    resolve,
    // Asynchronous by contract (EO-710), though answered the way the
    // two reads above are: a later EO is free to answer them without
    // holding the module still, and a module that awaits them now will
    // not have to change.
    runs: async (key) => history("runs", key, runShape),
    transitions: async (key) => history("transitions", key, transitionShape),
    items: async (filter) => items(filter),
    readAttachment: async (id) => readAttachment(id),
  };
}

// ── Saying something in the thread ────────────────────────────

/**
 * `ctx.comment()` and `ctx.commentOn()` (EO-75).
 *
 * Comments are the only communication channel (invariant #4) and a
 * module had no voice in it. These give it one — for the ticket the step
 * is running on, and for any other by key.
 *
 * Neither writes the table, and that is the whole shape of this. EO's
 * `postComment` resolves mentions, queues the Jira mirror and announces
 * the change to open windows; a row inserted from this side would be a
 * comment that never reaches Jira and that no open window hears about —
 * which is also why this side holds no handle on the database. So a
 * comment is an event on fd 3 and the parent posts it.
 *
 * Both answer `{ posted: true }` or `{ posted: false, reason }` and
 * neither throws, matching the reads: a module that has to catch to find
 * out whether it was heard will forget to catch.
 *
 * A refusal is also written to the transcript, not only handed back.
 * Nothing silently drops work on the floor (invariant #8), and a module
 * that ignores the return value — most will — would otherwise leave a
 * person reading the run with no sign that anything was meant to be
 * said.
 *
 * No mentions anywhere in here. A module asks by refusing with options,
 * which ends the run (invariant #9); a comment that could summon
 * somebody would be a second way to stop and ask, and two ways to
 * escalate is one more than EO can keep honest.
 *
 * The caps come in on the request rather than being written here,
 * because the parent enforces them too — it owns the write, and fd 3 is
 * an inherited descriptor a module can reach directly, so the count that
 * decides whether a row exists must be the parent's (invariant #5). One
 * number, sent to whoever needs it, rather than two that have to agree.
 */
function makeComments(request, reads, send = (comment) => emit({ type: "comment", ...comment }), sendFiles = (attach) => emit({ type: "attach", ...attach })) {
  const limits = request.comments ?? {};
  const maxPerRun = Number.isFinite(limits.maxPerRun) ? limits.maxPerRun : 0;
  const maxChars = Number.isFinite(limits.maxChars) ? limits.maxChars : 0;
  const maxPaths = Number.isFinite(request.attachments?.maxPaths) ? request.attachments.maxPaths : 0;
  let posted = 0;

  const refuseFiles = (reason) => {
    emit({ type: "output", text: `EO did not attach files: ${reason}\n` });
    return Object.freeze({ attached: false, reason });
  };

  /**
   * `ctx.attach(paths, caption)` (EO-414): files on the ticket this step
   * is running on, as one comment.
   *
   * In here rather than beside it because an attach *is* one of the
   * run's comments — it spends the same count `post` does, and its
   * caption is held to the same length — and two counters would be two
   * numbers that have to agree.
   *
   * Asynchronous where `comment` is not, because the files are looked
   * at before the answer is given: a module told `{ attached: true }`
   * for a path that does not exist would find out from nobody. It still
   * never throws, and so never rejects.
   *
   * The checks run in the order that wastes least: what is wrong with
   * the call itself, then what is wrong with the files, and the count
   * last — so a module told a file is missing is not also told, next
   * call, that it has used up a comment it never got. The count is read
   * and spent with no `await` between, which is what keeps two attaches
   * started together from both taking the last one.
   *
   * No key. A module attaches to its own ticket; another ticket's files
   * are not this run's to add to.
   */
  const attach = async (paths, caption) => {
    try {
      const list = typeof paths === "string" ? [paths] : paths;
      if (!Array.isArray(list) || list.length === 0 || list.some((path) => typeof path !== "string" || path === "")) {
        return refuseFiles("ctx.attach takes a file path, or a list of them, and an optional caption.");
      }
      if (caption !== undefined && caption !== null && typeof caption !== "string") return refuseFiles("A caption is text.");
      const words = caption ?? "";
      if (words.length > maxChars) return refuseFiles(`A caption may be at most ${maxChars} characters and this one is ${words.length}.`);
      if (list.length > maxPaths) return refuseFiles(`One call may attach at most ${maxPaths} files and this one names ${list.length}.`);

      const refusals = [];
      for (const path of list) {
        const checked = await checkAttachmentPath(request.cwd, path);
        if (!checked.ok) refusals.push(checked.reason);
      }
      if (refusals.length > 0) return refuseFiles(refusals.join(" "));

      if (posted >= maxPerRun) {
        return refuseFiles(`A module may post ${maxPerRun} comments in one run, attachments included, and this run has posted them all.`);
      }
      posted += 1;
      sendFiles({ paths: list.slice(), caption: words });
      return Object.freeze({ attached: true });
    } catch (error) {
      return refuseFiles(`The files could not be checked: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const refuse = (reason) => {
    emit({ type: "output", text: `EO did not post a comment: ${reason}\n` });
    return Object.freeze({ posted: false, reason });
  };

  const post = (key, body) => {
    if (typeof body !== "string" || body.trim() === "") return refuse("A comment needs something to say.");
    // Before the count, so a module told its body is too long is not
    // also told, next call, that it has used up a comment it never got.
    if (body.length > maxChars) {
      return refuse(`A comment may be at most ${maxChars} characters and this one is ${body.length}. The transcript takes whatever does not fit — it is buffered for exactly this, and comments are not.`);
    }
    if (posted >= maxPerRun) return refuse(`A module may post ${maxPerRun} comments in one run, and this run has posted them all.`);
    posted += 1;
    // Through `send` rather than straight onto fd 3, so the test mode
    // (EO-352) can record the comment for a case to assert on instead of
    // asking the parent to post it.
    send({ key, body });
    return Object.freeze({ posted: true });
  };

  return {
    /**
     * The ticket this step is running on.
     *
     * Deliberately not routed through the key check below: the parent
     * knows which ticket the run is on, so a module should still be able
     * to say something on it in a build that never told this host where
     * the database is.
     */
    comment: (body) => post(request.itemKey, body),
    /**
     * Another ticket, by key.
     *
     * The key is checked here rather than only where the row is written,
     * so a typo comes back to the module as a sentence it can act on
     * while it is still running. The parent checks again — the ticket
     * can go between the two, and the parent is what actually writes —
     * and reports a miss into the transcript.
     */
    commentOn: (key, body) => {
      const found = reads.resolve(key);
      if (!found.found) return refuse(found.reason);
      return post(found.key, body);
    },
    attach,
  };
}

// ── Creating work ─────────────────────────────────────────────

/** Every name `ctx.createItem` takes. One outside this is a typo, and is refused rather than ignored. */
const CREATION_FIELDS = ["idempotencyKey", "type", "title", "body", "spec", "pipeline", "parent", "repository", "existingBranch", "wait", "dependsOn"];

/**
 * What `wait` may be (EO-434). `this_waits` holds the item this step is
 * running on behind the new one, `created_waits` holds the new one
 * behind it, and `none` — the default — holds neither. The parent keeps
 * its own copy and is the side that decides.
 */
const CREATION_WAITS = ["none", "this_waits", "created_waits"];
const CREATION_WAIT_REFUSAL = `wait is one of ${CREATION_WAITS.map((value) => JSON.stringify(value)).join(", ")}.`;
const CREATION_DEPENDS_ON_REFUSAL = 'dependsOn is a list of item keys, like ["EO-40"].';
const CREATION_EXISTING_BRANCH_REFUSAL = "existingBranch is the name of a branch that already exists, as text.";

/**
 * `ctx.createItem(spec)` (EO-433): one work item, on a pipeline of the
 * project this step's item is on.
 *
 * Nothing is written here, as nothing is by `ctx.comment`. A creation
 * is an event the parent performs — it is the side with a writable
 * handle and with `applyNewItem`, the door every item handed over
 * complete comes through — and `ask` is how the event goes out and the
 * answer comes back. On a real run that is fd 3 and fd 5; in a test it
 * is a recorder.
 *
 * It answers `{ created: true, key, existing }` or
 * `{ created: false, reason }` and never throws, so never rejects.
 * `existing` is true when this `idempotencyKey` had already made that
 * item, in this run or an earlier one on the same item.
 *
 * What is checked here is what can be known without a database: that
 * the manifest declares `needs.create`, and that the call has its three
 * required names. Everything else is the parent's, and its refusals
 * come back as the same shape.
 *
 * **Nothing is remembered here, and that is deliberate.** This function
 * once kept the answer each key had been given and a count of what the
 * run had created, and both were wrong in the way a second copy of a
 * fact is wrong. The remembered answer went on naming an item somebody
 * had deleted while the module was still running. The count refused an
 * eleventh call that was only a repeat of a key an earlier run had
 * used — which the parent would have answered with the item it already
 * made. Whether a key has made an item, and how many this run has made,
 * are facts the parent reads from its own tables at the moment it is
 * asked, in the order the calls were made. So every call that passes
 * the checks above is asked, and two calls with one key started
 * together are settled by the order their events reach the parent: one
 * creation, one repeat.
 *
 * `needs.create` is enforced, unlike `needs.comment`. A created item
 * lands on a pipeline with no person accepting it first, so the
 * approval of the manifest is the only gate there is, and the parent
 * refuses the event as well for a module that goes round this function.
 *
 * A refusal made here is also written to the transcript (invariant #8).
 * One the parent made is written there by the parent.
 *
 * Built on the promise constructor taken at load and settled by a
 * direct call, with no `then` and no `await` between the verified
 * answer and the promise the module holds — see `PRIMORDIALS`.
 */
function makeCreations(request, ask) {
  const declared = request.needs?.create === true;
  const { Promise: NativePromise, freeze } = PRIMORDIALS;

  const answered = (answer) => new NativePromise((resolve) => resolve(freeze(answer)));
  const refuse = (reason) => {
    emit({ type: "output", text: `EO did not create an item: ${reason}\n` });
    return answered({ created: false, reason });
  };
  const named = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

  return (spec) => {
    try {
      if (!declared) return refuse("This module does not declare needs.create in its manifest, so it may not create items.");
      if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
        return refuse("ctx.createItem takes one object: { idempotencyKey, type, title, body, spec, pipeline, parent, repository, existingBranch, wait, dependsOn }.");
      }
      const unknown = Object.keys(spec).filter((name) => !CREATION_FIELDS.includes(name));
      if (unknown.length > 0) {
        return refuse(`ctx.createItem does not take ${unknown.map((name) => JSON.stringify(name)).join(", ")}. It takes ${CREATION_FIELDS.join(", ")}.`);
      }
      const idempotencyKey = named(spec.idempotencyKey);
      if (idempotencyKey === null) {
        return refuse("ctx.createItem needs an idempotencyKey — a string that is the same every time this step asks for this item, so that running the step twice does not create it twice.");
      }
      const type = named(spec.type);
      if (type === null) return refuse('ctx.createItem needs a type: the slug of one of the project\'s item types, like "story".');
      const title = named(spec.title);
      if (title === null) return refuse("ctx.createItem needs a title.");
      if (spec.body !== undefined && spec.body !== null && typeof spec.body !== "string") return refuse("A body is text.");
      if (spec.spec !== undefined && spec.spec !== null && (typeof spec.spec !== "object" || Array.isArray(spec.spec))) {
        return refuse("spec is an object of the fields the type declares.");
      }
      const creation = { idempotencyKey, type, title, body: spec.body ?? "" };
      try {
        // A copy, and the proof it can cross: what cannot be written as
        // JSON cannot reach the parent, and finding that out here is a
        // refusal where finding it out on the way would be a call that
        // is never answered.
        creation.spec = JSON.parse(JSON.stringify(spec.spec ?? {}));
      } catch {
        return refuse("spec has to be plain data that can be written as JSON.");
      }
      for (const name of ["pipeline", "parent", "repository"]) {
        if (spec[name] === undefined || spec[name] === null) continue;
        const value = named(spec[name]);
        if (value === null) return refuse(`${name} is a name, as text.`);
        creation[name] = value;
      }
      // A branch that already exists, to be worked on instead of cutting
      // one (EO-648). Whether git would take the name, and whether the
      // pipeline works on a branch at all, is the door's to answer; what
      // is known here is that it is text. Unlike the three above, a
      // `null` is refused: only leaving it out means "cut a branch", and
      // a lookup that found no branch is not that.
      if (spec.existingBranch !== undefined) {
        const value = named(spec.existingBranch);
        if (value === null) return refuse(CREATION_EXISTING_BRANCH_REFUSAL);
        creation.existingBranch = value;
      }
      // Who waits for whom (EO-434). A `wait` that is none of the three
      // is refused rather than read as "none": a module that asked to be
      // held and was not runs ahead of the work it filed.
      // Only leaving it out means "none". A `null` is a value somebody
      // supplied — a lookup that found nothing, usually — and it is not
      // one of the three.
      if (spec.wait !== undefined) {
        if (!CREATION_WAITS.includes(spec.wait)) return refuse(CREATION_WAIT_REFUSAL);
        creation.wait = spec.wait;
      }
      if (spec.dependsOn !== undefined && spec.dependsOn !== null) {
        if (!Array.isArray(spec.dependsOn)) return refuse(CREATION_DEPENDS_ON_REFUSAL);
        const keys = [];
        for (const given of spec.dependsOn) {
          const key = named(given);
          if (key === null) return refuse(CREATION_DEPENDS_ON_REFUSAL);
          if (!keys.includes(key)) keys.push(key);
        }
        creation.dependsOn = keys;
      }

      // Asked before this function returns, so the event is on fd 3 by
      // the time the module's next line runs: one that does not await
      // its creation and comments straight after still has the two
      // reach the parent in the order it wrote them.
      return new NativePromise((resolve) => {
        ask(creation, (answer) => {
          resolve(
            freeze(
              answer !== null && typeof answer === "object" && answer.created === true && typeof answer.key === "string"
                ? { created: true, key: answer.key, existing: answer.existing === true }
                : { created: false, reason: String(answer?.reason ?? "EO did not say why.") },
            ),
          );
        });
      });
    } catch (error) {
      return refuse(`The creation could not be made: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/**
 * How a creation reaches the parent and its answer comes back (EO-433).
 *
 * Out on fd 3, as every other write a module asks for goes. Back on
 * fd 5, read only while a creation is waiting and never for a module
 * that creates nothing.
 *
 * ## What counts as an answer
 *
 * A line is `<hmac> <json>`, and it is an answer only if the HMAC of
 * the JSON under `key` is the one written beside it. The key came on
 * stdin, which is consumed before the module is imported, and it is in
 * no frame — so reading this descriptor teaches a module what EO
 * answered and nothing it could sign a different answer with. `id` is
 * inside what is signed, so a real answer to one call cannot be
 * replayed as the answer to another. It is not the nonce: the nonce is
 * what the parent believes a *result* on, and a secret written to a
 * descriptor a module can read is not one.
 *
 * ## What reads it
 *
 * `fs.read` on the descriptor, with every function involved taken from
 * `PRIMORDIALS`: the read itself, the decoding, the search for a line's
 * end, the HMAC and the parse. There is no stream here and no emitter,
 * so there is no `emit` to replace; the callbacks waiting on an answer
 * are properties of an object with no prototype, so there is no
 * `Map.prototype.set` to watch them go into. The parent writes the JSON
 * as ASCII — anything else escaped — so a read that ends in the middle
 * of a character cannot happen.
 *
 * A read is outstanding only while a call is waiting, which is what
 * keeps this process alive exactly as long as it has to be: a module
 * that returns without awaiting its `createItem` is still answered,
 * because the parent does not resolve the run until it has done the
 * work, and one that creates nothing exits when it always did.
 *
 * A channel that breaks answers every waiting call with a refusal
 * rather than leaving it pending: a module awaiting an answer that
 * cannot come would otherwise sit until its time limit.
 */
function makeCreationChannel(key) {
  const { read, hmac, hmacUpdate, hmacDigest, jsonParse, indexOf, slice, latin1, uuid, later } = PRIMORDIALS;
  const waiting = { __proto__: null };
  let outstanding = 0;
  let reading = false;
  let failure = typeof key === "string" && key !== "" ? null : "this run was given no way to check EO's answer.";
  let buffered = "";
  const chunk = Buffer.allocUnsafe(65536);

  const fail = (reason) => {
    failure ??= reason;
    for (const id in waiting) {
      const settle = waiting[id];
      delete waiting[id];
      settle({ created: false, reason: failure });
    }
    outstanding = 0;
  };

  const take = (line) => {
    const space = indexOf(line, " ");
    if (space <= 0) return;
    const signed = slice(line, space + 1);
    if (slice(line, 0, space) !== hmacDigest(hmacUpdate(hmac("sha256", key), signed), "hex")) return;
    let framed;
    try {
      framed = jsonParse(signed);
    } catch {
      return;
    }
    if (framed === null || typeof framed !== "object" || typeof framed.id !== "string") return;
    const settle = waiting[framed.id];
    if (settle === undefined) return;
    delete waiting[framed.id];
    outstanding -= 1;
    settle(framed.payload);
  };

  const pump = () => {
    if (reading || outstanding === 0 || failure !== null) return;
    reading = true;
    try {
      read(REPLY_FD, chunk, 0, chunk.length, null, (error, bytesRead) => {
        reading = false;
        // A descriptor that answers "nothing yet" instead of waiting.
        // The one EO hands over waits, but which it is belongs to the
        // platform, and asking again costs nothing.
        if (error && error.code === "EAGAIN") {
          later(pump);
          return;
        }
        if (error) {
          fail(`EO's answer could not be read: ${error.message}`);
          return;
        }
        if (bytesRead === 0) {
          fail("EO stopped answering before this creation was confirmed.");
          return;
        }
        buffered += latin1(chunk, 0, bytesRead);
        for (let end = indexOf(buffered, "\n"); end !== -1; end = indexOf(buffered, "\n")) {
          const line = slice(buffered, 0, end);
          buffered = slice(buffered, end + 1);
          take(line);
        }
        pump();
      });
    } catch (error) {
      reading = false;
      fail(`EO's answer has nowhere to arrive in this run: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (creation, settle) => {
    if (failure !== null) {
      emit({ type: "output", text: `EO did not create an item: ${failure}\n` });
      settle({ created: false, reason: failure });
      return;
    }
    const id = uuid();
    waiting[id] = settle;
    outstanding += 1;
    emit({ type: "create", id, creation });
    pump();
  };
}

/**
 * `ctx.answer()` — what somebody said since this step last asked (EO-183).
 *
 * A snapshot, taken before the module was imported and handed back
 * unchanged however many times it is called. The value is not this
 * side's to work out: the parent read the thread, applied the rules
 * about who counts as having answered and compared the reply with what
 * was offered, and sent the result on the request. Nothing here reads a
 * comment to build it — a second implementation of those rules living
 * in this file is exactly what having one reader was meant to end.
 *
 * Rebuilt from the request rather than passed through, for the reason
 * every other value a module touches is: `offered` reaches a module as a
 * frozen array of strings or it reaches it as something a module can
 * push onto, and a module that mutated it would be editing what the next
 * caller sees.
 */
function makeAnswer(value) {
  if (value === null || typeof value !== "object") return () => null;
  const answer = Object.freeze({
    text: String(value.text ?? ""),
    offered: Object.freeze((Array.isArray(value.offered) ? value.offered : []).filter((option) => typeof option === "string")),
    matched: typeof value.matched === "string" ? value.matched : null,
  });
  return () => answer;
}

/**
 * What a module's `process.env` is built from: what it declared, and on
 * Windows `SystemRoot` as well (EO-613).
 *
 * Windows reads `SystemRoot` from the process environment to find its
 * socket and DNS provider DLLs. Node starts without it, so losing it
 * shows up only as a `getaddrinfo` failure on a module's first lookup.
 * Unlike PATH it has to stay in `process.env`, because the OS reads it
 * there. It is not a secret.
 *
 * A name a module declared wins, and Windows does not tell `SYSTEMROOT`
 * from `SystemRoot`: both in one object would leave a child with
 * whichever `spawn` happened to keep.
 */
export function moduleEnv(platform, hostEnv, declared) {
  const systemRoot = platform === "win32" ? hostEnv.SystemRoot : undefined;
  const declaresIt = Object.keys(declared).some((name) => name.toUpperCase() === "SYSTEMROOT");
  return { ...(systemRoot && !declaresIt ? { SystemRoot: systemRoot } : {}), ...declared };
}

async function main() {
  const request = JSON.parse(await read(process.stdin));
  nonce = String(request.nonce ?? "");
  // Held in one place from here on (EO-436). `request` is passed to a
  // good deal of what follows, and the nonce has no business riding
  // along on it into code that runs once a module has been imported.
  delete request.nonce;

  // One case of a module's tests rather than the module itself (EO-352).
  // Before anything below: a test run builds no environment from the
  // request, opens no database and spawns nothing.
  if (request.mode === "test") {
    await testMain(request);
    return;
  }

  // The environment a module sees, and the environment a module's
  // children see, are built rather than inherited. `process.env` is
  // emptied down to exactly the secrets this module declared, so reading
  // an undeclared one answers undefined — the promise `needs.env` makes.
  // `moduleEnv` holds the one addition, which is Windows' alone.
  //
  // PATH is the exception, and it is taken *out* of `process.env` and
  // kept here instead: `ctx.exec` needs it to find a binary, and a module
  // has no business reading it.
  const path = process.env.PATH ?? "";
  const env = moduleEnv(process.platform, process.env, request.env ?? {});
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const childEnv = { ...env, PATH: path };

  // Asked of the parent, which reads with the code the screens read
  // with (EO-709), and waited for so `ctx.item()` needs no `await`.
  // Never a way to write — a write is asked for below and granted by
  // the parent, never done here.
  const reads = makeItemReads(makeReadChannel(request.replyKey), request.itemKey);
  // An intake check (EO-752): a watch module run for a job, with no item.
  const intake = intakeShape(request.intake);
  const noItem = intake === null ? null : intakeItemRead(intake);
  const intakeRefuses = intake === null ? null : intakeWrites();
  // An entry check (EO-736) is about an item as it would enter, which on
  // creation is no row at all: the parent built it and sent it, so
  // `ctx.item()` answers with that rather than asking for a key.
  const entering = request.entering !== null && typeof request.entering === "object" ? itemShape(request.entering) : null;
  const readEntering = () => Object.freeze({ found: true, item: entering, ticket: entering });
  // The other direction (EO-75): an event on fd 3 the parent turns into
  // a real `postComment`, because a write from here would skip the
  // mentions, the Jira mirror and the push to open windows.
  const says = makeComments(request, reads);

  const ctx = {
    cwd: request.cwd,
    inputs: Object.freeze({ ...request.inputs }),
    /**
     * How long this run may take before EO kills the tree (EO-162).
     *
     * Milliseconds, and the real figure: the parent computed it from the
     * step's own setting and armed the timer that will stop this process
     * with it, then sent the same number here. A module that waits for
     * something slow — CI, a deploy — sizes its wait against this rather
     * than against a constant it was written with, which is what stopped
     * being possible when EO's ceiling was fixed in code and unreachable
     * from a module. Leave room for whatever the module does *after* the
     * wait: stopping at the ceiling is being killed, not finishing.
     *
     * A number, not a deadline, because the process's own clock is what
     * a module can subtract from. It is set once and does not move.
     */
    timeoutMs: request.timeoutMs,
    /**
     * The newest answer since this step last asked, or null (EO-183).
     *
     * `{ text, offered, matched }`. `text` is what was written, raw and
     * unedited; `offered` is what that question put in front of a person,
     * in the order it offered them; `matched` is the one of those the
     * reply *is* — compared after the wrapping a person types is stripped,
     * so a button whose label came back as "Send it back." still matches
     * the option "Send it back", and null where the reply is none of them.
     *
     * Null means nobody has answered since the last question, which
     * includes never having asked one. A module reading this on its first
     * run gets null, refuses with its `options`, and finds the answer here
     * on the run after — the loop it used to have to hand-write.
     *
     * What it decides is what EO can check. `matched: null` alongside a
     * `text` is a person answering in their own words, and whether those
     * words meant one of the options is not something this can know: the
     * sentence is handed over whole for a module that wants to try, and
     * refusing again with it quoted back is the honest alternative.
     * Nothing here is verified against the world either — a branch, a
     * version or an environment somebody named is still a claim, and
     * checking it is the module's (invariant #5).
     */
    answer: makeAnswer(request.answer ?? null),
    // The run, the workspace and the project (EO-711): sent with the run.
    run: runContextShape(request.context?.run, intake),
    workspace: workspaceContextShape(request.context?.workspace, request.cwd),
    project: shapedOrNull(request.context?.project, projectContextShape),
    // Which door, on an entry check (EO-736); null on every other run.
    entry: entryContextShape(request.entry),
    item: noItem ?? (entering === null ? reads.item : readEntering),
    itemByKey: reads.itemByKey,
    // An item's history, the board and a file's bytes (EO-710).
    runs: reads.runs,
    transitions: reads.transitions,
    items: reads.items,
    readAttachment: reads.readAttachment,
    /**
     * The names a module approved before KAN-162 still calls.
     *
     * Kept beside the new ones rather than translated away, because a
     * module's body is approved by its hash: EO cannot edit
     * `ctx.ticket()` into `ctx.item()` without asking the person who
     * approved it to approve it again. They answer identically and put
     * one line in the transcript saying they are on a clock.
     */
    ticket:
      noItem === null
        ? entering === null
          ? reads.ticket
          : readEntering
        : () => {
            reads.deprecated();
            return noItem();
          },
    ticketByKey: reads.ticketByKey,
    comment: intakeRefuses?.comment ?? says.comment,
    commentOn: says.commentOn,
    attach: intakeRefuses?.attach ?? says.attach,
    // And work (EO-433): the parent creates the item, and answers on
    // the one channel that runs back this way.
    createItem: intakeRefuses?.createItem ?? makeCreations(request, makeCreationChannel(request.replyKey)),
    exec: makeExec(request, childEnv),
    log: (line) => emit({ type: "output", text: `${line}\n` }),
  };

  // A data: URL rather than a temp file: nothing is written to disk that
  // would have to be cleaned up after a kill, and a bare or relative
  // specifier cannot resolve from one at all.
  //
  // Not a second enforcement of the import rule, though it was once
  // described as one. An absolute `file:///…` resolves from a data: URL
  // perfectly well, and so does every `node:` builtin — so what stops
  // those is the hook below and nothing else (EO-80).
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(request.code, "utf8").toString("base64")}`;
  const guard = guardImports(moduleUrl, request.code);

  let loaded;
  try {
    loaded = await import(moduleUrl);
  } catch (error) {
    // A refused import reaches here as an ordinary load failure, and the
    // loader's own wording for one is about resolution rather than about
    // the rule that was broken. The guard's sentence is the one that
    // names the rule and the line, so it wins when there is one.
    const refusal = guard.refusal();
    respond({ ok: false, reason: refusal ?? `This module could not be loaded: ${error instanceof Error ? error.message : String(error)}` });
    return;
  }

  if (typeof loaded.default !== "function") {
    respond({ ok: false, reason: "A module must export a default function to run." });
    return;
  }

  try {
    const outcome = await loaded.default(ctx);
    // A dynamic import is refused where it was called, which a module can
    // catch. One that asked for something it may not have and then
    // reported success is a run EO refuses anyway — the guard fired, and
    // a fired guard does not end in a module's own account of events
    // (invariant #5).
    const refusal = guard.refusal();
    respond(refusal === null ? normalize(outcome, request.options, request.watch === true, request.entryCheck === true, intake !== null) : { ok: false, reason: refusal });
  } catch (error) {
    const refusal = guard.refusal();
    respond({ ok: false, reason: refusal ?? (error instanceof Error ? (error.stack ?? error.message) : String(error)) });
  }
}

// ── Test mode (EO-352) ────────────────────────────────────────
//
// The harness API this implements is documented in the file header,
// under "Test mode". What follows is the machinery behind it.

/**
 * Every fixture `harness.run` takes. A name outside this is a typo, and is refused rather than ignored.
 *
 * Exported for `roles/systemAgentModuleSurface.test.ts` (EO-712), which
 * fails when a name here is missing from the system agent's prompt or
 * from module_test_save's description.
 */
export const FIXTURE_NAMES = new Set(["exec", "item", "itemByKey", "runs", "transitions", "items", "attachments", "run", "workspace", "project", "entry", "intake", "answer", "inputs", "timeoutMs", "createItem"]);

/**
 * The `runs` or `transitions` a case scripted, `{ KEY: [entry, …] }`,
 * checked, or a TypeError saying what is wrong with them (EO-710).
 */
function readHistoryFixture(value, name, example) {
  if (value === undefined) return new Map();
  const shape = `harness.run's ${name} is an object of item keys to lists: { "EO-2": [${example}] }.`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(shape);
  const lists = new Map();
  for (const [key, list] of Object.entries(value)) {
    if (!Array.isArray(list) || list.some((entry) => entry === null || typeof entry !== "object" || Array.isArray(entry))) throw new TypeError(shape);
    lists.set(key, list);
  }
  return lists;
}

/** The `items` a case scripted — the board `ctx.items()` searches — checked (EO-710). */
function readItemsFixture(value) {
  if (value === undefined) return [];
  const shape = 'harness.run\'s items is a list of items, each like { key: "EO-2", title: "…", stepName: "Review", parentKey: "EO-1" }.';
  if (!Array.isArray(value) || value.some((entry) => entry === null || typeof entry !== "object" || Array.isArray(entry))) throw new TypeError(shape);
  return value;
}

/** The `attachments` a case scripted, `{ ID: { name, mimeType, content } }`, as bytes, checked (EO-710). */
function readAttachmentsFixture(value) {
  if (value === undefined) return new Map();
  const shape = 'harness.run\'s attachments is an object of attachment ids to files: { "att-1": { name: "log.txt", mimeType: "text/plain", content: "…" } }, content a string or bytes.';
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(shape);
  const files = new Map();
  for (const [id, file] of Object.entries(value)) {
    if (file === null || typeof file !== "object" || Array.isArray(file)) throw new TypeError(shape);
    const content = file.content;
    if (content !== undefined && typeof content !== "string" && !(content instanceof Uint8Array)) throw new TypeError(shape);
    files.set(id, { ...file, id, bytes: typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content ?? []) });
  }
  return files;
}

/**
 * Whether a scripted item matches a `ctx.items()` filter, as EO's own
 * query would match it (EO-710). A fixture entry may carry what a
 * summary does not — `stepId`, `pipelineId`, `createdAt`, `updatedAt`,
 * `atTerminalStep` — for the filters that read them; an entry without
 * one does not match a filter on it.
 */
function fixtureItemMatches(entry, filter) {
  const fold = (text) => (typeof text === "string" ? text.toLocaleLowerCase() : null);
  if (filter.stepId !== undefined && entry.stepId !== filter.stepId) return false;
  if (filter.stepName !== undefined && fold(entry.stepName) !== fold(filter.stepName)) return false;
  if (filter.pipelineId !== undefined && entry.pipelineId !== filter.pipelineId) return false;
  if (filter.type !== undefined && entry.type !== filter.type) return false;
  if (filter.parentKey !== undefined && entry.parentKey !== filter.parentKey) return false;
  if (filter.keys !== undefined && !filter.keys.includes(entry.key)) return false;
  if (filter.text !== undefined && !(fold(entry.title) ?? "").includes(fold(filter.text))) return false;
  if (filter.createdSince !== undefined && !(typeof entry.createdAt === "number" && entry.createdAt >= filter.createdSince)) return false;
  if (filter.updatedSince !== undefined && !(typeof entry.updatedAt === "number" && entry.updatedAt >= filter.updatedSince)) return false;
  if (filter.atTerminalStep !== undefined && (entry.atTerminalStep === true) !== filter.atTerminalStep) return false;
  return true;
}

/** The `createItem` answers a case handed `harness.run`, checked, or a TypeError saying what is wrong with them (EO-433). */
function readCreationAnswers(value) {
  if (value === undefined) return [];
  const shape = 'harness.run\'s createItem is a list of answers, each { key: "EO-9" } or { reason: "…" }.';
  if (!Array.isArray(value)) throw new TypeError(shape);
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError(shape);
    const names = Object.keys(entry);
    if (names.length === 1 && typeof entry.key === "string" && entry.key.trim() !== "") return { key: entry.key.trim() };
    if (names.length === 1 && typeof entry.reason === "string" && entry.reason.trim() !== "") return { reason: entry.reason };
    throw new TypeError(shape);
  });
}

/** The key the running item has when a case does not say. */
const FIXTURE_ITEM_KEY = "TEST-1";

/** Longest a timer may be set for, as Node has it: anything longer fires after 1ms, with a warning. */
const MAX_TIMER_MS = 2_147_483_647;

/** The code on the error a refused network call or write throws, so it can be told apart from the module's own. */
const TEST_REFUSAL = "ERR_EO_TEST_REFUSED";

/** A duration as a sentence reads it. A copy of `describeDuration` in `@eo/core`, which this file cannot import. */
function describeMs(ms) {
  if (ms % 60_000 === 0) return `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}`;
  if (ms % 1000 === 0) return `${ms / 1000} second${ms === 1000 ? "" : "s"}`;
  return `${ms}ms`;
}

/** Whether two argument lists are the same list. */
function sameArgs(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * `ctx.exec` inside a test: answered from the case's script, never run.
 *
 * Nothing here can start a process — there is no `spawn` in reach of
 * it, and `moduleHost.test.ts` asserts that with `node:child_process`
 * mocked out. A call the case did not script is refused with a sentence
 * naming the binary and its arguments, and reported through
 * `onUnscripted` as well, because a module can catch the rejection and
 * carry on — and a case whose module tried to run something unscripted
 * must still fail.
 *
 * `needs.bin` is checked first, exactly as a real run checks it, so a
 * module calling a binary it never declared is told so here too rather
 * than having the script paper over it. That call is reported through
 * `onUnscripted` as well — nothing could have scripted it — so it fails
 * the case even when the module catches the refusal.
 *
 * Each script entry answers one call. A call takes the first unused
 * entry with its binary and arguments (an entry with no `args` matches
 * any), so a polling loop's repeated identical calls take their answers
 * in the order they were written.
 */
export function makeScriptedExec({ needs, script, onCall, onUnscripted, say }) {
  const allowed = new Set(needs?.bin ?? []);
  const slots = (script ?? []).map((entry) => ({ entry, used: false }));
  return (bin, args = []) => {
    if (typeof bin !== "string" || bin === "") return Promise.reject(new Error("ctx.exec needs the name of a binary."));
    const argv = Array.isArray(args) ? args.map((arg) => String(arg)) : [];
    if (!allowed.has(bin)) {
      // The refusal a real run gives, unchanged — and a violation of the
      // case as well. A call to an undeclared binary is a call nothing
      // scripted, and a module that catches the rejection and carries on
      // must not let its case pass on the strength of having caught it.
      onCall?.({ bin, args: argv });
      onUnscripted?.(
        `ctx.exec(${JSON.stringify(bin)}, ${JSON.stringify(argv)}) names a binary this module did not declare in needs.bin, so EO did not run it. ` +
          `Declare "${bin}" in the manifest's needs.bin if the module is meant to run it.`,
      );
      return Promise.reject(new Error(`This module did not declare "${bin}" in needs.bin, so it may not run it.`));
    }
    onCall?.({ bin, args: argv });
    say?.({ type: "exec", bin, args: argv });

    const slot = slots.find((candidate) => !candidate.used && candidate.entry.bin === bin && (candidate.entry.args === undefined || sameArgs(candidate.entry.args, argv)));
    if (slot === undefined) {
      const message =
        `ctx.exec(${JSON.stringify(bin)}, ${JSON.stringify(argv)}) was not scripted by this test case, so EO did not run it. ` +
        `Add { bin: ${JSON.stringify(bin)}, args: ${JSON.stringify(argv)}, code, stdout, stderr } to the exec list given to harness.run.`;
      onUnscripted?.(message);
      return Promise.reject(new Error(message));
    }
    slot.used = true;
    const { code = 0, stdout = "", stderr = "" } = slot.entry;
    if (stdout !== "") say?.({ type: "output", text: stdout });
    if (stderr !== "") say?.({ type: "output", text: stderr });
    // The shape a real call resolves with, `tail` included, so a module
    // reading `result.tail` reads the same thing under test.
    return Promise.resolve({ code, stdout, stderr, tail: (stdout + stderr).slice(-4000) });
  };
}

/** The exec script a case handed `harness.run`, checked, or a TypeError saying what is wrong with it. */
function readScript(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("harness.run's exec is a list: [{ bin, args, code, stdout, stderr }, …].");
  return value.map((entry, index) => {
    const where = `exec[${index}]`;
    if (entry === null || typeof entry !== "object") throw new TypeError(`${where} must be an object: { bin, args, code, stdout, stderr }.`);
    if (typeof entry.bin !== "string" || entry.bin === "") throw new TypeError(`${where}.bin must name the binary, like "gh".`);
    if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== "string"))) {
      throw new TypeError(`${where}.args must be a list of strings, or left out to answer any arguments.`);
    }
    if (entry.code !== undefined && !Number.isInteger(entry.code)) throw new TypeError(`${where}.code must be an integer exit code.`);
    if (entry.stdout !== undefined && typeof entry.stdout !== "string") throw new TypeError(`${where}.stdout must be a string.`);
    if (entry.stderr !== undefined && typeof entry.stderr !== "string") throw new TypeError(`${where}.stderr must be a string.`);
    return Object.freeze({ bin: entry.bin, args: entry.args === undefined ? undefined : [...entry.args], code: entry.code ?? 0, stdout: entry.stdout ?? "", stderr: entry.stderr ?? "" });
  });
}

/**
 * Time, faked, for everything a case and its module can reach (EO-352).
 *
 * A module that polls CI waits in `setTimeout` for minutes at a time, and
 * a test of it that waited too would take minutes. So `setTimeout`,
 * `setInterval`, their `clear…`, `node:timers`, `node:timers/promises`,
 * `Date` and `performance.now` are replaced with a clock that does not
 * move on its own: when nothing else is ready to run, it jumps straight
 * to the next timer that is due and fires it. A ten-minute polling loop
 * runs in milliseconds.
 *
 * "Nothing else is ready" is two turns of the real event loop with a
 * timer still waiting, not a reading of what is pending — Node does not
 * answer that question reliably across versions. Microtasks always run
 * first, and a scripted `ctx.exec` answers through a promise, so for a
 * module whose waiting is all timers the order is exactly the real one.
 * Real I/O slower than a turn of the loop can see a timer fire first;
 * that is the cost of faking time and is written down here so nobody
 * meets it as a mystery.
 *
 * Time cannot run past a limit. `deadline(ms)` sets one from now; when
 * the next timer is due beyond the nearest limit, the clock stops and
 * `onLimit` is told which — which is how a module that would poll for
 * ever is stopped at its time limit rather than run in virtual time for
 * ever. The case as a whole is held to `caseLimitMs` the same way.
 */
export function installFakeClock({ caseLimitMs, onLimit, onError }) {
  const realSetImmediate = globalThis.setImmediate;
  const RealDate = globalThis.Date;
  const epoch = RealDate.now();
  const performanceEpoch = globalThis.performance.now();

  let elapsed = 0;
  let sequence = 0;
  let armed = false;
  let quietTurns = 0;
  let stopped = false;
  const timers = new Map();
  const limits = new Set([{ at: caseLimitMs, ms: caseLimitMs }]);

  const delayOf = (ms) => {
    const number = Number(ms);
    return Number.isFinite(number) && number >= 1 && number <= MAX_TIMER_MS ? Math.floor(number) : 1;
  };

  class FakeTimeout {
    constructor(id) {
      this.id = id;
    }
    ref() {
      return this;
    }
    unref() {
      return this;
    }
    hasRef() {
      return true;
    }
    refresh() {
      const timer = timers.get(this.id);
      if (timer) {
        timer.at = elapsed + timer.delay;
        timer.order = ++sequence;
      }
      return this;
    }
    close() {
      timers.delete(this.id);
      return this;
    }
    [Symbol.toPrimitive]() {
      return this.id;
    }
  }

  const nearestLimit = () => {
    let nearest = null;
    for (const limit of limits) if (nearest === null || limit.at < nearest.at) nearest = limit;
    return nearest;
  };

  const arm = () => {
    if (armed || stopped || timers.size === 0) return;
    armed = true;
    realSetImmediate(turn);
  };

  function turn() {
    armed = false;
    if (stopped || timers.size === 0) return;
    // A second quiet turn before moving time, so whatever became ready
    // on the first — an I/O callback, a promise it resolved — runs
    // before a timer that would really have fired later.
    quietTurns += 1;
    if (quietTurns < 2) {
      arm();
      return;
    }
    quietTurns = 0;

    let next = null;
    for (const timer of timers.values()) if (next === null || timer.at < next.at || (timer.at === next.at && timer.order < next.order)) next = timer;
    const limit = nearestLimit();
    if (limit !== null && next.at > limit.at) {
      stopped = true;
      onLimit(limit.ms);
      return;
    }
    elapsed = Math.max(elapsed, next.at);
    if (next.repeat) {
      next.at = elapsed + next.delay;
      next.order = ++sequence;
    } else {
      timers.delete(next.id);
    }
    try {
      next.fn(...next.args);
    } catch (error) {
      onError(error);
    }
    arm();
  }

  const schedule = (fn, ms, args, repeat) => {
    if (typeof fn !== "function") throw new TypeError('The "callback" argument must be of type function.');
    const id = ++sequence;
    const delay = delayOf(ms);
    timers.set(id, { id, fn, args, delay, at: elapsed + delay, order: id, repeat });
    arm();
    return new FakeTimeout(id);
  };
  const clear = (handle) => {
    if (handle === null || handle === undefined) return;
    timers.delete(typeof handle === "object" ? handle.id : Number(handle));
  };

  const fakeSetTimeout = (fn, ms, ...args) => schedule(fn, ms, args, false);
  const fakeSetInterval = (fn, ms, ...args) => schedule(fn, ms, args, true);

  const abortError = (signal) => Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: signal?.reason });
  const sleep = (ms, value, options) =>
    new Promise((resolveSleep, rejectSleep) => {
      const signal = options?.signal;
      if (signal?.aborted) {
        rejectSleep(abortError(signal));
        return;
      }
      const onAbort = () => {
        clear(handle);
        rejectSleep(abortError(signal));
      };
      const handle = fakeSetTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolveSleep(value);
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  async function* repeatEvery(ms, value, options) {
    for (;;) {
      await sleep(ms, undefined, options);
      yield value;
    }
  }

  const now = () => epoch + elapsed;
  const FakeDate = new Proxy(RealDate, {
    construct: (target, args, newTarget) => Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget),
    apply: () => new RealDate(now()).toString(),
    get: (target, key) => (key === "now" ? now : Reflect.get(target, key, target)),
  });

  globalThis.setTimeout = fakeSetTimeout;
  globalThis.setInterval = fakeSetInterval;
  globalThis.clearTimeout = clear;
  globalThis.clearInterval = clear;
  globalThis.Date = FakeDate;
  globalThis.performance.now = () => performanceEpoch + elapsed;

  const require = createRequire(import.meta.url);
  const timersModule = require("node:timers");
  Object.assign(timersModule, { setTimeout: fakeSetTimeout, setInterval: fakeSetInterval, clearTimeout: clear, clearInterval: clear });
  const timersPromises = require("node:timers/promises");
  timersPromises.setTimeout = sleep;
  timersPromises.setInterval = repeatEvery;
  if (timersPromises.scheduler) timersPromises.scheduler.wait = (ms, options) => sleep(ms, undefined, options);

  return {
    /** A limit `ms` from now. The function it answers takes it away again. */
    deadline: (ms) => {
      const limit = { at: elapsed + ms, ms };
      limits.add(limit);
      return () => limits.delete(limit);
    },
    stop: () => {
      stopped = true;
    },
  };
}

/** A path as a sentence names it, from whatever the caller wrote it as. */
function pathOf(target) {
  if (target instanceof URL) return fileURLToPath(target);
  if (Buffer.isBuffer(target)) return target.toString();
  return String(target);
}

/** Whether an `open` flag writes. */
function opensForWriting(flags, constants) {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === "number") return (flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_TRUNC)) !== 0;
  return /[wa+]/.test(String(flags));
}

/** How many entries a recursive `cp` may write before it is too large to check, and refused. */
const MAX_COPY_ENTRIES = 100_000;

/** How many symbolic links one path may pass through before it is refused, as the kernel's own ELOOP limit. */
const MAX_SYMLINK_HOPS = 40;

/** A path's components as the OS reads them: `/` everywhere, and `\\` as well on Windows. */
const PATH_SEPARATORS = sep === "\\" ? /[\\/]+/ : /\/+/;

/** The root an absolute path starts from — `/`, or a drive or UNC root on Windows. */
function rootOf(path) {
  return parsePath(path).root;
}

/**
 * Where a write to `raw` actually lands, with every symbolic link on the
 * way resolved — or null where the path loops.
 *
 * Walked one component at a time, left to right, from the path exactly
 * as it was written, because that is the order the kernel walks it in.
 * Normalising first is the trap: `escape/../victim` reads as `victim`
 * once `..` has been folded away, but the kernel follows `escape` before
 * it ever sees the `..` — so if `escape` links to a directory outside,
 * the `..` climbs from *there*. A `..` is therefore only applied to a
 * directory already resolved to a real one, and a link's own target is
 * spliced into the components still to walk rather than resolved on
 * its own.
 *
 * Every directory on the way is followed, because the OS follows them.
 * The last component is followed only for the writes that follow it:
 * `writeFile` through a link writes the file it points at, while
 * `unlink` on a link removes the link and leaves its target alone. A
 * link that dangles is followed too, since `writeFile` and
 * `mkdir({ recursive })` through one create its target. A component
 * that does not exist yet is taken as written: the write creates it
 * there, or fails.
 *
 * Read with `lstat` and `readlink` rather than `realpath`, which fails on
 * the first component that does not exist — precisely the case of a
 * write that creates a file.
 */
function landingPath(fs, raw, followLast) {
  const absolute = isAbsolutePath(raw) ? raw : `${process.cwd()}${sep}${raw}`;
  let current = rootOf(absolute);
  const pending = absolute.slice(current.length).split(PATH_SEPARATORS);
  let hops = 0;

  while (pending.length > 0) {
    const part = pending.shift();
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // `current` has no link left in it, so its parent is its real parent.
      current = dirname(current);
      continue;
    }
    const next = current.endsWith(sep) ? `${current}${part}` : `${current}${sep}${part}`;
    // The last component, written with nothing after it: an entry the
    // write may act on itself. A trailing `/` or `/.` makes the kernel
    // follow it like any directory, so only a bare last name counts.
    if (pending.length === 0 && !followLast) return next;

    let stat;
    try {
      stat = fs.lstatSync(next);
    } catch {
      // Nothing there yet: the write creates it, at exactly this path.
      current = next;
      continue;
    }
    if (!stat.isSymbolicLink()) {
      current = next;
      continue;
    }
    hops += 1;
    if (hops > MAX_SYMLINK_HOPS) return null;
    const target = String(fs.readlinkSync(next));
    // Relative to the directory holding the link, which is `current`;
    // an absolute target starts again from its own root.
    if (isAbsolutePath(target)) {
      current = rootOf(target);
      pending.unshift(...target.slice(current.length).split(PATH_SEPARATORS));
    } else {
      pending.unshift(...target.split(PATH_SEPARATORS));
    }
  }
  return current;
}

/**
 * Refuses every write outside `root`, the case's temporary directory.
 *
 * The writing half of `node:fs`, `node:fs/promises` with it, wrapped so
 * a write is checked against the directory before it happens. Reading
 * is untouched: a case may read whatever it needs to arrange. Refused
 * writes are reported through `onViolation` as well as thrown, so a
 * module that swallows the error still fails its case.
 *
 * Checked where the write *lands*, not where its path says: a case can
 * make a symbolic link inside its directory that points out of it, and
 * a write through `harness.cwd/escape/file` would otherwise pass a
 * check of the text and land outside. See `landingPath`. A hard link is
 * the same escape by another route, so `link` is checked on the file it
 * links to as well as on the name it creates.
 *
 * Not a sandbox, for the reason the file header gives: a module written
 * to go around this will — and a link made between the check and the
 * write is such a module. It is what stops a test doing damage in passing.
 */
export function confineWrites(root, onViolation) {
  const require = createRequire(import.meta.url);
  const fs = require("node:fs");
  // Captured before anything below wraps them, and never wrapped: they
  // read, and the check has to keep working while the writers are not
  // the originals.
  const lstatSync = fs.lstatSync.bind(fs);
  const readlinkSync = fs.readlinkSync.bind(fs);
  const reader = { lstatSync, readlinkSync };

  const roots = [resolvePath(root)];
  try {
    roots.push(fs.realpathSync(root));
  } catch {
    // The directory is the parent's to make; if it cannot be resolved,
    // the path as given is the only answer there is.
  }
  const within = (path) => roots.some((candidate) => path === candidate || path.startsWith(candidate.endsWith(sep) ? candidate : candidate + sep));
  const inside = (target, followLast) => {
    const written = pathOf(target);
    // The text first — a path that names somewhere outside is refused
    // whatever its links would do — and then where it really lands,
    // walked from the path as written and not from its normalised form.
    if (!within(resolvePath(written))) return false;
    let landing;
    try {
      landing = landingPath(reader, written, followLast);
    } catch {
      // A component that cannot be read is a path whose landing is not
      // known, and an unknown landing is not "inside".
      return false;
    }
    return landing !== null && within(landing);
  };
  const refuse = (message) => {
    onViolation(message);
    const error = new Error(message);
    error.code = TEST_REFUSAL;
    return error;
  };
  const check = (target, followLast, what) => {
    // An open descriptor or `FileHandle` was checked when it was opened.
    if (typeof target === "number" || (target !== null && typeof target === "object" && typeof target.fd === "number")) return;
    if (target === undefined || inside(target, followLast)) return;
    throw refuse(`This test case tried to ${what} ${pathOf(target)}, outside its temporary directory. A test may write only inside harness.cwd (${root}).`);
  };

  // Read-only, and captured unwrapped for the reason the two above are.
  const readdirSync = fs.readdirSync.bind(fs);
  const statSync = fs.statSync.bind(fs);
  /**
   * Every path a `cp` would write: its destination, and — copying a
   * directory recursively — the destination of every entry beneath it.
   *
   * The destination alone is not enough, and that is not hypothetical:
   * with `src/sub/victim` inside the directory and `dst/sub` a link to
   * somewhere outside, `cpSync(src, dst, { recursive: true })` writes the
   * outside `victim` while `dst` itself is plainly inside. Every entry's
   * landing is checked before anything is copied, through the same
   * `landingPath`, as a write that follows links — which also refuses
   * replacing a destination link that points out, harmless as that one
   * would be, rather than reason about which writes `cp` follows.
   *
   * The source is walked the way `cp` walks it: through links only when
   * told to `dereference`. Null when it is too large to check, which a
   * link loop under `dereference` would otherwise be for ever.
   */
  const copyDestinations = (source, destination, options) => {
    const top = pathOf(destination);
    const destinations = [top];
    if (options === null || typeof options !== "object" || options.recursive !== true) return destinations;
    const from = pathOf(source);
    const look = options.dereference === true ? statSync : lstatSync;
    let stat;
    try {
      stat = look(from);
    } catch {
      // `cp` will fail on a source it cannot read; there is nothing it
      // could write to check.
      return destinations;
    }
    if (!stat.isDirectory()) return destinations;
    // Joined by hand, never normalised: a `..` in a destination is
    // `landingPath`'s to walk in the order the kernel does.
    const queue = [""];
    while (queue.length > 0) {
      const relative = queue.shift();
      let names;
      try {
        names = readdirSync(relative === "" ? from : `${from}${sep}${relative}`);
      } catch {
        continue;
      }
      for (const name of names) {
        const entry = relative === "" ? String(name) : `${relative}${sep}${name}`;
        destinations.push(`${top}${sep}${entry}`);
        if (destinations.length > MAX_COPY_ENTRIES) return null;
        try {
          if (look(`${from}${sep}${entry}`).isDirectory()) queue.push(entry);
        } catch {
          // Gone, or unreadable: `cp` will meet the same and fail on it.
        }
      }
    }
    return destinations;
  };
  const wrapCopy = (target, name) => {
    const original = target[name];
    if (typeof original !== "function") return;
    target[name] = function (...args) {
      const [source, destination, options] = args;
      const destinations = copyDestinations(source, destination, typeof options === "function" ? undefined : options);
      if (destinations === null) {
        throw refuse(`This test case tried to copy ${pathOf(source)} into ${pathOf(destination)}, which is more than ${MAX_COPY_ENTRIES} entries for EO to check stay inside harness.cwd (${root}).`);
      }
      for (const each of destinations) check(each, FOLLOWS, "copy into");
      return original.apply(this, args);
    };
  };

  /**
   * Which arguments of each writer are paths it writes, and whether the
   * write follows a link in the last component. `true` follows it — the
   * data lands where the link points. `false` acts on the entry itself.
   */
  const FOLLOWS = true;
  const ON_ENTRY = false;
  const writers = {
    writeFile: [[0, FOLLOWS]],
    appendFile: [[0, FOLLOWS]],
    mkdir: [[0, FOLLOWS]],
    mkdtemp: [[0, FOLLOWS]],
    truncate: [[0, FOLLOWS]],
    chmod: [[0, FOLLOWS]],
    chown: [[0, FOLLOWS]],
    utimes: [[0, FOLLOWS]],
    copyFile: [[1, FOLLOWS]],
    rm: [[0, ON_ENTRY]],
    rmdir: [[0, ON_ENTRY]],
    unlink: [[0, ON_ENTRY]],
    lchmod: [[0, ON_ENTRY]],
    lchown: [[0, ON_ENTRY]],
    lutimes: [[0, ON_ENTRY]],
    rename: [
      [0, ON_ENTRY],
      [1, ON_ENTRY],
    ],
    symlink: [[1, ON_ENTRY]],
    // The existing file as well as the new name: a hard link inside the
    // directory to a file outside it is that file, writable from inside.
    link: [
      [0, FOLLOWS],
      [1, ON_ENTRY],
    ],
  };
  const wrap = (target, name, positions) => {
    const original = target[name];
    if (typeof original !== "function") return;
    target[name] = function (...args) {
      for (const [position, followLast] of positions) check(args[position], followLast, "write to");
      return original.apply(this, args);
    };
  };
  const wrapOpen = (target, name) => {
    const original = target[name];
    if (typeof original !== "function") return;
    target[name] = function (...args) {
      if (opensForWriting(args[1], fs.constants)) check(args[0], FOLLOWS, "open for writing");
      return original.apply(this, args);
    };
  };
  for (const [name, positions] of Object.entries(writers)) {
    wrap(fs, name, positions);
    wrap(fs, `${name}Sync`, positions);
    wrap(fs.promises, name, positions);
  }
  // `cp` on its own terms: a recursive copy writes far more than the one
  // destination it is handed. See `copyDestinations`.
  wrapCopy(fs, "cp");
  wrapCopy(fs, "cpSync");
  wrapCopy(fs.promises, "cp");
  wrap(fs, "createWriteStream", [[0, FOLLOWS]]);
  for (const name of ["open", "openSync"]) wrapOpen(fs, name);
  wrapOpen(fs.promises, "open");
}

/**
 * Refuses every direct network call: `fetch`, `node:http`, `node:https`,
 * `node:net` and the rest of the ways out (EO-352).
 *
 * A test has no network. A module can still import these — the import
 * rule is the module's and is the same under test — but calling out
 * fails, and is reported through `onViolation` so a module that catches
 * it still fails its case. `net.Socket.prototype.connect` is the floor
 * under all of the TCP ones; the named entries are refused before they
 * get there so the sentence can say which was called.
 */
export function blockNetwork(onViolation) {
  const require = createRequire(import.meta.url);
  const refuse = (what) => {
    const message = `This test case made a network call (${what}). Tests have no network: a module's calls out cannot be scripted, so a case has to keep it from making them.`;
    onViolation(message);
    const error = new Error(message);
    error.code = TEST_REFUSAL;
    return error;
  };
  const target = (value) => {
    if (typeof value === "string") return value;
    if (value instanceof URL) return value.href;
    if (value && typeof value === "object") return typeof value.url === "string" ? value.url : typeof value.host === "string" || typeof value.hostname === "string" ? String(value.hostname ?? value.host) : "";
    return "";
  };
  const refusing = (name) =>
    function (...args) {
      const where = target(args[0]);
      throw refuse(where === "" ? name : `${name} ${where}`);
    };

  globalThis.fetch = async (input) => {
    const where = target(input);
    throw refuse(where === "" ? "fetch" : `fetch ${where}`);
  };
  if (typeof globalThis.WebSocket === "function") {
    globalThis.WebSocket = function WebSocket(url) {
      throw refuse(`WebSocket ${String(url)}`);
    };
  }
  for (const name of ["http", "https"]) {
    const module = require(`node:${name}`);
    module.request = refusing(`node:${name} request`);
    module.get = refusing(`node:${name} get`);
  }
  const net = require("node:net");
  net.connect = refusing("node:net connect");
  net.createConnection = refusing("node:net createConnection");
  net.Socket.prototype.connect = refusing("node:net connect");
  const tls = require("node:tls");
  tls.connect = refusing("node:tls connect");
  const http2 = require("node:http2");
  http2.connect = refusing("node:http2 connect");
  const dgram = require("node:dgram");
  dgram.Socket.prototype.send = refusing("node:dgram send");
}

/** A data: URL for source, under a media type of the caller's choosing so two URLs never collide. */
function dataUrl(code, mediaType) {
  return `data:${mediaType};base64,${Buffer.from(code, "utf8").toString("base64")}`;
}

/** One comment, from the partial shape a case writes, with the defaults a case has always had. */
function fixtureComment(value, index) {
  const comment = value !== null && typeof value === "object" ? value : {};
  return {
    id: comment.id ?? `comment-${index + 1}`,
    parentId: comment.parentId ?? null,
    author: { type: comment.author?.type ?? "human", name: comment.author?.name ?? null },
    kind: comment.kind ?? "comment",
    body: comment.body ?? "",
    pinned: comment.pinned ?? false,
    createdAt: comment.createdAt ?? null,
  };
}

/**
 * An item from the partial shape a case writes, in the exact shape
 * `ctx.item()` answers with on a real run — `itemShape` builds both, so a
 * field a real run has is a field the fixture has: every field EO-709
 * added included, null, `false`, `[]` or `{}` where the case did not say.
 */
function fixtureItem(value, key) {
  const item = value !== null && typeof value === "object" ? value : {};
  return itemShape({
    ...item,
    key: typeof item.key === "string" ? item.key : key,
    comments: Array.isArray(item.comments) ? item.comments.map(fixtureComment) : [],
  });
}

/** The type a value would satisfy, in a manifest's words. */
function inputTypeOf(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? typeof value : null;
}

/**
 * The inputs a case's module sees: the manifest's defaults under what
 * the case set, declared names only, or the sentence a real run would
 * refuse with. `resolveInputs` and `moduleInputProblems` in TypeScript,
 * restated because this file imports nothing of EO's.
 */
function fixtureInputs(declared, configured) {
  const problems = [];
  const inputs = {};
  for (const [name, input] of Object.entries(declared ?? {})) {
    if (input?.default !== undefined && input.default !== null) inputs[name] = input.default;
    const value = configured[name];
    if (value === undefined || value === null) continue;
    if (inputTypeOf(value) !== input?.type) {
      problems.push(`"${name}" expects a ${input?.type}, and this case sets ${JSON.stringify(value)}.`);
      continue;
    }
    inputs[name] = value;
  }
  return { inputs, problems };
}

/** A failure as a person reads it, with the data: URLs a stack would print replaced by names. */
function describeThrown(error, urls) {
  let text = error instanceof Error ? (error.name === "AssertionError" ? error.message : (error.stack ?? error.message)) : String(error);
  for (const [url, name] of urls) text = text.split(url).join(name);
  return text;
}

/** V8's own coverage, from this process's own inspector, taken before anything is compiled. */
async function startCoverage() {
  try {
    const { Session } = await import("node:inspector");
    const session = new Session();
    session.connect();
    const post = (method, params) => new Promise((resolvePost, rejectPost) => session.post(method, params ?? {}, (error, result) => (error ? rejectPost(error) : resolvePost(result))));
    await post("Profiler.enable");
    await post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
    return async (url) => {
      try {
        const { result } = await post("Profiler.takePreciseCoverage");
        return result.find((script) => script.url === url)?.functions ?? null;
      } catch {
        return null;
      }
    };
  } catch {
    // No inspector in this runtime: the case still runs, and contributes
    // nothing to coverage rather than failing for a reason of EO's.
    return async () => null;
  }
}

/**
 * One test case, run in this process and answered on fd 4 (EO-352).
 *
 * The parent runs one of these per case, each in a fresh temporary
 * directory it made and removes afterwards, so nothing one case does
 * can reach the next — and so a case that never yields can be killed
 * without taking the other cases with it.
 */
async function testMain(request) {
  // No secrets, and nothing else either: a case's environment is empty.
  for (const key of Object.keys(process.env)) delete process.env[key];

  const takeCoverage = await startCoverage();
  const moduleUrl = dataUrl(String(request.code ?? ""), "text/javascript");
  // A different media type so the case's URL can never be the module's,
  // even for identical text — coverage is told apart by URL.
  const caseUrl = dataUrl(String(request.caseSource ?? ""), "text/javascript;charset=utf-8");
  const names = [
    [moduleUrl, "<module>"],
    [caseUrl, "<test case>"],
  ];
  const caseLimitMs = Number.isFinite(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : 600_000;
  const realSetTimeout = globalThis.setTimeout;

  const violations = [];
  const violate = (message) => {
    if (!violations.includes(message)) violations.push(message);
  };

  let done = false;
  const finish = async (verdict) => {
    if (done) return;
    done = true;
    clock.stop();
    const coverage = await takeCoverage(moduleUrl);
    // A violation outranks whatever the case said about itself: a case
    // whose module ran something unscripted, called out or wrote outside
    // its directory has failed, whether or not the error was caught.
    const failure = violations[0] ?? (verdict.passed ? null : verdict.failure);
    respond({ passed: failure === null, failure, coverage });
    // Out promptly, but not before stdout has had a moment to drain. A
    // module that left something holding the loop open does not get to
    // keep the case running past its answer.
    realSetTimeout(() => process.exit(0), 50).unref();
  };

  const limitReached = (ms) => {
    void finish({ passed: false, failure: `This case did not finish within the module's time limit of ${describeMs(ms)}, so EO stopped it.` });
  };
  const thrownOutside = (error) => {
    void finish({ passed: false, failure: `The module or the case threw outside anything awaiting it: ${describeThrown(error, names)}` });
  };

  const clock = installFakeClock({ caseLimitMs, onLimit: limitReached, onError: thrownOutside });
  process.on("uncaughtException", thrownOutside);
  process.on("unhandledRejection", thrownOutside);
  // The loop has emptied with the case still waiting: nothing is left
  // that could ever settle what it awaits. With time faked that is the
  // same as running out the limit, so it is reported as that.
  process.on("beforeExit", () => {
    void finish({
      passed: false,
      failure: `This case did not finish within the module's time limit of ${describeMs(caseLimitMs)}: it was waiting on something nothing will ever settle, so EO stopped it.`,
    });
  });

  blockNetwork(violate);
  confineWrites(process.cwd(), violate);
  // Once, after everything above, so a named import of a builtin —
  // `import { request } from "node:https"` — sees the replacement.
  syncBuiltinESMExports();

  // The import rule, for the module and for the case alike.
  const moduleGuard = guardImports(moduleUrl, String(request.code ?? ""));
  const caseGuard = guardImports(caseUrl, String(request.caseSource ?? ""));

  let loading = null;
  const loadModule = () => {
    loading ??= import(moduleUrl).then(
      (module) => ({ module }),
      (error) => ({ error }),
    );
    return loading;
  };

  const run = async (fixtures = {}) => {
    if (fixtures === null || typeof fixtures !== "object" || Array.isArray(fixtures)) {
      throw new TypeError("harness.run takes one object of fixtures: { exec, item, itemByKey, runs, transitions, items, attachments, run, workspace, project, entry, intake, answer, inputs, createItem, timeoutMs }.");
    }
    const unknown = Object.keys(fixtures).filter((name) => !FIXTURE_NAMES.has(name));
    if (unknown.length > 0) {
      throw new TypeError(`harness.run does not take ${unknown.map((name) => JSON.stringify(name)).join(", ")}. It takes exec, item, itemByKey, runs, transitions, items, attachments, run, workspace, project, entry, intake, answer, inputs, createItem and timeoutMs.`);
    }
    const script = readScript(fixtures.exec);
    const creationAnswers = readCreationAnswers(fixtures.createItem);
    const scriptedRuns = readHistoryFixture(fixtures.runs, "runs", '{ action: "review", resultKey: "approved", answer: { … } }');
    const scriptedTransitions = readHistoryFixture(fixtures.transitions, "transitions", '{ from: { id: "implement", name: "Implement" }, to: { id: "review", name: "Review" }, actor: "Implementer", reason: "run succeeded" }');
    const scriptedItems = readItemsFixture(fixtures.items);
    const scriptedAttachments = readAttachmentsFixture(fixtures.attachments);
    if (fixtures.timeoutMs !== undefined && !(Number.isFinite(fixtures.timeoutMs) && fixtures.timeoutMs > 0)) {
      throw new TypeError("harness.run's timeoutMs is a positive number of milliseconds.");
    }
    const timeoutMs = fixtures.timeoutMs ?? caseLimitMs;
    if (fixtures.inputs !== undefined && (fixtures.inputs === null || typeof fixtures.inputs !== "object" || Array.isArray(fixtures.inputs))) {
      throw new TypeError("harness.run's inputs is an object of input names to values.");
    }
    // The run, the workspace and the project (EO-711): an object each,
    // and `project` may be null — an item no project holds.
    for (const name of ["run", "workspace", "project"]) {
      const value = fixtures[name];
      if (value === undefined || (name === "project" && value === null)) continue;
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`harness.run's ${name} is an object, a partial of ctx.${name}.`);
    }
    // An intake check (EO-752): the job it runs for, and no item.
    if (fixtures.intake !== undefined && fixtures.intake !== null) {
      const job = typeof fixtures.intake === "object" && !Array.isArray(fixtures.intake) ? fixtures.intake.job : undefined;
      if (job === null || typeof job !== "object" || typeof job.id !== "string" || typeof job.name !== "string") {
        throw new TypeError('harness.run\'s intake is { job: { id, name } }, the job an intake check runs for: { job: { id: "job-1", name: "Dependabot" } }.');
      }
      if (fixtures.item !== undefined && fixtures.item !== null) {
        throw new TypeError("harness.run's intake runs the module as an intake check, which has no item, so it takes no item fixture.");
      }
    }
    if (fixtures.itemByKey !== undefined && (fixtures.itemByKey === null || typeof fixtures.itemByKey !== "object" || Array.isArray(fixtures.itemByKey))) {
      throw new TypeError('harness.run\'s itemByKey is an object of keys to items: { "EO-2": { title: "…" } }.');
    }

    const record = { comments: [], attachments: [], created: [], logs: [], execs: [] };
    const result = (outcome) =>
      Object.freeze({
        outcome: Object.freeze(outcome),
        comments: Object.freeze(record.comments.slice()),
        attachments: Object.freeze(record.attachments.slice()),
        created: Object.freeze(record.created.slice()),
        logs: Object.freeze(record.logs.slice()),
        execs: Object.freeze(record.execs.slice()),
      });

    const { inputs, problems } = fixtureInputs(request.inputs, fixtures.inputs ?? {});
    if (problems.length > 0) return result({ ok: false, reason: `The module was not run: ${problems.join(" ")}` });

    const intake = intakeShape(fixtures.intake);
    const item = fixtures.item === null || intake !== null ? null : fixtureItem(fixtures.item, FIXTURE_ITEM_KEY);
    const known = new Map();
    for (const [key, value] of Object.entries(fixtures.itemByKey ?? {})) known.set(key, fixtureItem({ ...value, key }, key));
    if (item !== null) known.set(item.key, item);

    const lookup = (key) => {
      if (typeof key !== "string" || key.trim() === "") return { reason: 'A ticket key is a string, like "EO-42".' };
      const found = known.get(key.trim());
      return found === undefined ? { reason: `No ticket has the key "${key.trim()}".` } : { item: found };
    };
    const read = (key) => {
      const at = lookup(key);
      return at.item === undefined ? Object.freeze({ found: false, reason: at.reason }) : Object.freeze({ found: true, item: at.item, ticket: at.item });
    };
    const noItem = intake === null ? null : intakeItemRead(intake);
    const readRunning = () => noItem?.() ?? (item === null ? Object.freeze({ found: false, reason: "This test case runs the module with no item (item: null)." }) : read(item.key));
    let warned = false;
    const deprecated = () => {
      if (warned) return;
      warned = true;
      emit({ type: "output", text: `${CONTEXT_DEPRECATION_LINE}\n` });
    };
    // An item's history (EO-710): what the case scripted for the key, an
    // empty list for an item the case knows and scripted none for, and
    // the reason `ctx.itemByKey()` would give for any other key.
    const history = (lists, what, shape) => async (key) => {
      if (typeof key !== "string" || key.trim() === "") return Object.freeze({ found: false, reason: 'A ticket key is a string, like "EO-42".' });
      const asked = key.trim();
      const list = lists.get(asked) ?? (known.has(asked) ? [] : undefined);
      if (list === undefined) return Object.freeze({ found: false, reason: `No ticket has the key "${asked}".` });
      return Object.freeze({ found: true, [what]: frozenList(list, shape) });
    };
    // The board (EO-710): the scripted items, narrowed by the filter as
    // EO's query narrows them, in the order the case gave, and paged.
    const searchItems = async (value) => {
      const read = readItemsFilter(value);
      if (read.reason !== undefined) return Object.freeze({ found: false, reason: read.reason });
      const { offset = 0, limit = ITEMS_PAGE_DEFAULT, ...filter } = read.filter;
      const matched = scriptedItems.filter((entry) => fixtureItemMatches(entry, filter));
      const end = offset + limit;
      return itemsPageShape({ items: matched.slice(offset, end), total: matched.length, nextOffset: end < matched.length ? end : null });
    };
    const readScriptedAttachment = async (id) => {
      if (typeof id !== "string" || id.trim() === "") return Object.freeze({ found: false, reason: ATTACHMENT_ID_SHAPE });
      const file = scriptedAttachments.get(id.trim());
      if (file === undefined) return Object.freeze({ found: false, reason: `No attachment has the id "${id.trim()}".` });
      return attachmentContentShape(file, Buffer.from(file.bytes));
    };

    const reads = {
      resolve: (key) => {
        const at = lookup(key);
        return at.item === undefined ? Object.freeze({ found: false, reason: at.reason }) : Object.freeze({ found: true, key: at.item.key });
      },
    };
    const runningKey = item?.key ?? FIXTURE_ITEM_KEY;
    const says = makeComments(
      { itemKey: runningKey, comments: request.comments, attachments: request.attachments, cwd: process.cwd() },
      reads,
      (comment) => {
        record.comments.push(Object.freeze({ key: comment.key, body: comment.body }));
      },
      // Recorded and nothing else (EO-414): the files were checked where
      // they lie, by the rules a real run is held to, and no byte of
      // them is copied anywhere.
      (attach) => {
        record.attachments.push(Object.freeze({ key: runningKey, caption: attach.caption, paths: Object.freeze(attach.paths.slice()) }));
      },
    );

    // Recorded and nothing else (EO-433). This stands where the parent
    // and its database would be, and a case has neither — so it keeps
    // the two facts the parent would have read from its tables: which
    // keys this run has made an item under, and how many it has made.
    // What it asks about waiting is checked first (EO-434); then a
    // repeat is answered, as the parent answers it, and spends nothing;
    // then the cap; then the next scripted answer, or a key no
    // real item has once the script runs out.
    const maxCreations = Number.isFinite(request.creations?.maxPerRun) ? request.creations.maxPerRun : 0;
    const madeUnder = new Map();
    let answered = 0;
    let minted = 0;
    const createItem = makeCreations({ needs: request.needs }, (creation, settle) => {
      const refuse = (reason) => {
        emit({ type: "output", text: `EO did not create an item: ${reason}\n` });
        settle({ created: false, reason });
      };
      // What a case can know about waiting without a database (EO-434):
      // that every key the new item is to wait for is an item the case
      // knows — the running one, or one in `itemByKey` — and that the
      // one loop visible from here is not asked for. Anything deeper is
      // a graph only a real run has. Asked first, of a repeat too: a
      // real run holds a repeat to what it says about waiting.
      const dependsOn = creation.dependsOn ?? [];
      const unknownKey = dependsOn.find((key) => !known.has(key) && key !== runningKey);
      if (unknownKey !== undefined) {
        refuse(`There is no ticket ${unknownKey} for this to depend on.`);
        return;
      }
      const wait = creation.wait ?? "none";
      if (wait === "this_waits" && dependsOn.includes(runningKey)) {
        refuse(`${runningKey} cannot wait for the new item — that would make the dependencies circular: ${runningKey} → the new item → ${runningKey}.`);
        return;
      }
      const before = madeUnder.get(creation.idempotencyKey);
      if (before !== undefined) {
        settle({ created: true, key: before, existing: true });
        return;
      }
      if (record.created.length >= maxCreations) {
        refuse(`a module may create ${maxCreations} items in one run, and this run has created them all.`);
        return;
      }
      const scripted = creationAnswers[answered];
      answered += 1;
      if (scripted?.reason !== undefined) {
        refuse(scripted.reason);
        return;
      }
      const key = scripted?.key ?? `NEW-${(minted += 1)}`;
      madeUnder.set(creation.idempotencyKey, key);
      record.created.push(
        Object.freeze({
          idempotencyKey: creation.idempotencyKey,
          key,
          type: creation.type,
          title: creation.title,
          body: creation.body,
          spec: creation.spec,
          pipeline: creation.pipeline ?? null,
          parent: creation.parent ?? null,
          repository: creation.repository ?? null,
          existingBranch: creation.existingBranch ?? null,
          wait,
          dependsOn: Object.freeze(dependsOn.slice()),
        }),
      );
      settle({ created: true, key, existing: false });
    });

    const intakeRefuses = intake === null ? null : intakeWrites();
    const ctx = {
      cwd: process.cwd(),
      inputs: Object.freeze({ ...inputs }),
      timeoutMs,
      answer: makeAnswer(fixtures.answer ?? null),
      run: runContextShape(fixtures.run, intake),
      workspace: workspaceContextShape(fixtures.workspace, process.cwd()),
      project: shapedOrNull(fixtures.project, projectContextShape),
      entry: entryContextShape(fixtures.entry),
      item: readRunning,
      itemByKey: read,
      runs: history(scriptedRuns, "runs", runShape),
      transitions: history(scriptedTransitions, "transitions", transitionShape),
      items: searchItems,
      readAttachment: readScriptedAttachment,
      ticket: () => {
        deprecated();
        return readRunning();
      },
      ticketByKey: (key) => {
        deprecated();
        return read(key);
      },
      // Refused as a real intake check refuses them (EO-752), and recorded nowhere.
      comment: intakeRefuses?.comment ?? says.comment,
      commentOn: says.commentOn,
      attach: intakeRefuses?.attach ?? says.attach,
      createItem: intakeRefuses?.createItem ?? createItem,
      exec: makeScriptedExec({
        needs: request.needs,
        script,
        onCall: (call) => record.execs.push(Object.freeze({ bin: call.bin, args: Object.freeze(call.args) })),
        onUnscripted: violate,
        say: emit,
      }),
      log: (line) => {
        record.logs.push(String(line));
        emit({ type: "output", text: `${line}\n` });
      },
    };

    // The run's own limit, in faked time here and in real time in the
    // parent, which is told so it can stop a case that never yields.
    const release = clock.deadline(timeoutMs);
    emit({ type: "limit", ms: timeoutMs });
    try {
      const loaded = await loadModule();
      if (loaded.error !== undefined) {
        return result({ ok: false, reason: moduleGuard.refusal() ?? `This module could not be loaded: ${describeThrown(loaded.error, names)}` });
      }
      if (typeof loaded.module.default !== "function") return result({ ok: false, reason: "A module must export a default function to run." });
      try {
        const returned = await loaded.module.default(ctx);
        const refusal = moduleGuard.refusal();
        return result(refusal === null ? normalize(returned, request.options, request.watch === true, request.entryCheck === true, intake !== null) : { ok: false, reason: refusal });
      } catch (error) {
        return result({ ok: false, reason: moduleGuard.refusal() ?? describeThrown(error, names) });
      }
    } finally {
      release();
      emit({ type: "limit", ms: caseLimitMs });
    }
  };

  const harness = Object.freeze({ cwd: process.cwd(), run });

  let loaded;
  try {
    loaded = await import(caseUrl);
  } catch (error) {
    await finish({ passed: false, failure: caseGuard.refusal() ?? `This test case could not be loaded: ${describeThrown(error, names)}` });
    return;
  }
  if (typeof loaded.default !== "function") {
    await finish({ passed: false, failure: "A test case must export a default async function that takes the harness." });
    return;
  }
  try {
    await loaded.default(harness);
    const refusal = caseGuard.refusal();
    await finish(refusal === null ? { passed: true, failure: null } : { passed: false, failure: refusal });
  } catch (error) {
    await finish({ passed: false, failure: caseGuard.refusal() ?? describeThrown(error, names) });
  }
}

/**
 * What a module returned, held to the shape the supervisor already knows.
 *
 * `BuiltinOutcome` verbatim, so the run row, the elapsed time, the
 * park-on-failure and the routing that `runBuiltin` already does are
 * reused rather than reimplemented for modules. A module that returns
 * something else is a module that failed — guessing at what it meant is
 * how a failure comes to look like a success.
 *
 * A refusal may also name the answers it would take (EO-76), which is
 * how a module asks a question rather than reporting a fact: they reach
 * `runBuiltin`'s escalation comment as buttons, exactly as the worktree
 * builtin's candidate keys already do. Held to the same suspicion as
 * everything else here — see `offeredAnswers`.
 *
 * ## Hearing the answer
 *
 * Nothing here reads one. The reply is an ordinary comment, the run has
 * already ended (invariant #9), and the next dispatch re-runs the module
 * from the top — so the answer arrives on the *request*, worked out by
 * the parent before this process started, and `ctx.answer()` is what
 * hands it over.
 *
 * It answers `{ text, offered, matched }`, or null where nobody has
 * answered since the last question — which includes never having asked
 * one. The rules behind it are `recordedStackAnswer`'s, now shared with
 * it in `main/roles/answers.ts`: newest reply wins, human replies only,
 * nothing pulled in from Jira, and nothing written before EO's most
 * recent `escalation` comment, because everything before that answered a
 * different question and reading it as this one's answer is EO putting
 * words in somebody's mouth.
 *
 * `matched` is the part worth being precise about. It is an exact
 * comparison against what this module actually offered — after the
 * wrapping a person types is stripped, which is what makes a clicked
 * button that came back as "Send it back." equal to the option "Send it
 * back" — and it is the offered label, not the reply's own casing, so a
 * module can compare it with its own constant.
 *
 * What it deliberately does not decide is everything that needs to know
 * what the question meant. A reply that is none of the options comes
 * back with `matched: null` and its `text` intact, and whether that
 * sentence meant one of them is a judgement nothing here can make and
 * this does not fake — a module that wants to try has the sentence.
 * Nothing is verified against the world, either: `recordedStackAnswer`
 * asks git whether a branch somebody named exists before believing it
 * (invariant #5), and a module hearing a version, an environment or a
 * path has the same work to do. And what to do about an answer it cannot
 * use is still the module's: refusing again with the reply quoted back,
 * rather than repeating the question, is what stops an answered question
 * looking unread.
 */
function normalize(outcome, optionLimits, watch, entryCheck = false, intake = false) {
  if (outcome === null || typeof outcome !== "object") {
    return { ok: false, reason: `A module must return { ok: true, result, detail } or { ok: false, reason }; this one returned ${JSON.stringify(outcome) ?? "undefined"}.` };
  }
  // `ok === true` exactly, rather than "not false". Anything else is a
  // module that did not say it succeeded, and reading `{ result: "…" }`
  // as a success is precisely the guess this function exists to refuse —
  // a parsed API response that happens to carry a `result` field would
  // have routed a ticket on it.
  if (outcome.ok === true) {
    if (typeof outcome.result !== "string" || outcome.result === "") {
      return { ok: false, reason: "A module that succeeded must name the result it produced, so the pipeline knows where to send the ticket." };
    }
    // Findings are an intake check's, on a `waiting` answer (EO-752).
    // Anywhere else nothing would file them, and a module that believes
    // it filed something it did not is told so rather than ignored.
    if (outcome.findings !== undefined && outcome.findings !== null && !(intake && outcome.result === WAITING_RESULT)) {
      return { ok: false, reason: findingsElsewhere(intake, outcome.result) };
    }
    if (outcome.result === WAITING_RESULT) return waitingOutcome(outcome, watch, intake);
    // An entry check's refusal carries why (EO-736): the person at the
    // door reads it in the refusal sentence. Only there, so every other
    // module's outcome is exactly what it was.
    if (entryCheck && outcome.result === ENTRY_CHECK_REFUSE) {
      return { ok: true, result: outcome.result, detail: String(outcome.detail ?? ""), reason: typeof outcome.reason === "string" ? outcome.reason : "" };
    }
    return { ok: true, result: outcome.result, detail: String(outcome.detail ?? "") };
  }
  if (outcome.ok === false) {
    const reason = String(outcome.reason ?? "The module reported a failure with no reason.");
    const options = offeredAnswers(outcome.options, optionLimits);
    // Omitted rather than sent as an empty array. `runBuiltin` tests the
    // length anyway, but a refusal that offered nothing and a refusal
    // that offered nothing usable should reach the run row as the same
    // thing — which is a refusal with a reason and no question in it.
    return options.length > 0 ? { ok: false, reason, options } : { ok: false, reason };
  }
  return { ok: false, reason: `A module must return { ok: true, result, detail } or { ok: false, reason }; this one returned neither.` };
}

/**
 * The outcome a check reports while what it waits on has not happened
 * yet (EO-458). `WAITING_RESULT` in `@eo/core`, which this file cannot
 * import.
 */
const WAITING_RESULT = "waiting";

/** What an entry check answers when it keeps an item out (EO-736). `ENTRY_CHECK_REFUSE` in `@eo/core`. */
const ENTRY_CHECK_REFUSE = "refuse";

/**
 * A module that answered `waiting`, held to what that means (EO-458,
 * ARCHITECTURE.md, "Modules: a step that is a script").
 *
 * Only a manifest that declares `watch: true` may say it. Anywhere else
 * `waiting` is a module claiming to be a check it was never declared
 * to be: the step it runs on runs it once, nothing will ask again, and
 * reading the word as a result key would park the item on a route
 * nobody can write — so it is a failure, with the sentence that says
 * which declaration is missing. Decided here rather than in the parent
 * because this is the one place both a real run and a test case pass
 * through, and a case asserting the refusal has to see the refusal a
 * run would get.
 *
 * `news` is checked rather than cast, for `offeredAnswers`' reason: each
 * entry becomes part of a comment, and its id is how EO knows it posted
 * the entry before. Unlike an option, a bad entry fails the whole check
 * rather than being dropped — a dropped entry is news nobody ever hears,
 * and a check that keeps failing escalates with this sentence, which is
 * how the author finds out. Always an array on a waiting outcome, so a
 * case can assert on `outcome.news` whether or not the module gave any.
 */
function waitingOutcome(outcome, watch, intake = false) {
  if (!watch) {
    return {
      ok: false,
      reason: `This module returned "${WAITING_RESULT}", but its manifest does not declare \`watch: true\`, so it cannot wait: it runs once and must return one of its results. Declare \`watch: true\` and run it on a step that keeps checking, or return a result.`,
    };
  }
  const shape = `A module that is still waiting returns { ok: true, result: "${WAITING_RESULT}", news: [{ id, text }, …] }, where each id is a non-empty string that stays the same for as long as the news is true, and each text is a string.`;
  if (outcome.news !== undefined && outcome.news !== null && !Array.isArray(outcome.news)) return { ok: false, reason: `${shape} This one's news is not a list.` };
  const news = [];
  for (const entry of outcome.news ?? []) {
    if (entry === null || typeof entry !== "object" || typeof entry.id !== "string" || entry.id.trim() === "" || typeof entry.text !== "string") {
      return { ok: false, reason: `${shape} This one gave ${JSON.stringify(entry) ?? "undefined"}.` };
    }
    news.push({ id: entry.id, text: entry.text });
  }
  if (!intake) return { ok: true, result: WAITING_RESULT, detail: String(outcome.detail ?? ""), news };
  const read = readFindings(outcome.findings);
  if (read.problem !== undefined) return { ok: false, reason: read.problem };
  return { ok: true, result: WAITING_RESULT, detail: String(outcome.detail ?? ""), news, findings: read.findings };
}

/** The most findings one intake check may report (EO-752). `MAX_WATCH_FINDINGS` in `@eo/core`, which this file cannot import. */
const MAX_FINDINGS = 100;
/** The longest a finding's key may be. `MAX_WATCH_FINDING_KEY_CHARS` in `@eo/core`. */
const MAX_FINDING_KEY_CHARS = 200;

/** Why a run that is not an intake check's `waiting` answer may not return findings (EO-752). */
function findingsElsewhere(intake, result) {
  if (!intake) {
    return "This module returned findings, but findings are only read when the module runs as a pipeline's intake — a check a watch job makes, with no item. On a step, say what changed as news, or create items with ctx.createItem.";
  }
  return `This module returned findings with the result "${result}", but findings are only read when the module runs as a pipeline's intake and answers "${WAITING_RESULT}". Return findings on a "${WAITING_RESULT}" answer; a result tells the job's owner something is wrong.`;
}

/**
 * What an intake check found (EO-752), held to `WatchFindingSchema` in
 * `@eo/core` — which this file cannot import, so it is written out
 * again here and the parent parses what arrives with the schema itself.
 *
 * All or nothing, like `news`: one finding EO cannot file keeps every
 * one of them, and the check fails with the sentence naming it. A check
 * that filed most of what it found would leave its author never hearing
 * about the rest; a failing check is retried and, failing on, reaches
 * the job's owner with this sentence. So does a check reporting more
 * than `MAX_FINDINGS`, or two findings with one key — the key is how EO
 * files a thing once, and two things under one key would be one filed
 * and the other lost.
 *
 * Always a list on an intake check's `waiting`, so a case can assert on
 * `outcome.findings` whether or not the module found anything.
 */
function readFindings(value) {
  const shape =
    `An intake check that is still waiting returns { ok: true, result: "${WAITING_RESULT}", detail, findings: [{ key, title, body?, spec?, existingBranch? }, …] }, ` +
    `where each key is the module's own stable name for what it found, at most ${MAX_FINDING_KEY_CHARS} characters, and each title is text.`;
  if (value === undefined || value === null) return { findings: [] };
  if (!Array.isArray(value)) return { problem: `${shape} This one's findings is not a list.` };
  if (value.length > MAX_FINDINGS) return { problem: `An intake check may report at most ${MAX_FINDINGS} findings, and this one reported ${value.length}. EO kept none of them.` };
  const findings = [];
  const seen = new Map();
  for (let index = 0; index < value.length; index += 1) {
    const read = findingShape(value[index]);
    if (read.problem !== undefined) return { problem: `${shape} findings[${index}] ${read.problem} EO kept none of them.` };
    const before = seen.get(read.finding.key);
    if (before !== undefined) {
      return { problem: `findings[${before}] and findings[${index}] both have the key "${read.finding.key}", and each finding needs a key of its own: it is how EO files a thing once. EO kept none of them.` };
    }
    seen.set(read.finding.key, index);
    findings.push(read.finding);
  }
  return { findings };
}

/** One finding as `WatchFindingSchema` reads it — trimmed where it trims — or what is wrong with it. */
function findingShape(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return { problem: "is not an object." };
  const text = (name) => (typeof entry[name] === "string" ? entry[name].trim() : null);
  const key = text("key");
  if (key === null || key === "") return { problem: "has no key: it needs one, as non-empty text." };
  if (key.length > MAX_FINDING_KEY_CHARS) return { problem: `has a key of ${key.length} characters, and a key may be at most ${MAX_FINDING_KEY_CHARS}.` };
  const title = text("title");
  if (title === null || title === "") return { problem: "has no title: it needs one, as non-empty text." };
  const finding = { key, title };
  if (entry.body !== undefined) {
    if (typeof entry.body !== "string") return { problem: "has a body that is not text." };
    finding.body = entry.body;
  }
  if (entry.spec !== undefined) {
    if (entry.spec === null || typeof entry.spec !== "object" || Array.isArray(entry.spec)) return { problem: "has a spec that is not an object of the item type's fields." };
    try {
      // A copy, and the proof it can cross, as `ctx.createItem`'s spec is.
      finding.spec = JSON.parse(JSON.stringify(entry.spec));
    } catch {
      return { problem: "has a spec that is not plain data that can be written as JSON." };
    }
    // A `toJSON` can write a spec as something else entirely.
    if (finding.spec === null || typeof finding.spec !== "object" || Array.isArray(finding.spec)) return { problem: "has a spec that is not an object of the item type's fields." };
  }
  if (entry.existingBranch !== undefined) {
    const branch = text("existingBranch");
    if (branch === null || branch === "") return { problem: "has an existingBranch that is not a branch's name, as non-empty text." };
    finding.existingBranch = branch;
  }
  return { finding };
}

/**
 * The answers a refusing module named, minus anything EO will not put in
 * front of a person (EO-76).
 *
 * `normalize` exists because a module that did not say it succeeded must
 * not be read as having succeeded; what it claims to be *offering*
 * deserves the same treatment, because an option is not decoration. It
 * becomes a button somebody clicks, the click becomes the text of their
 * reply, and that reply is what the next dispatch reads back — so
 * `options: [null]` rendered as an empty button, or `options: "yes"`
 * spread into five one-character ones, is a question nobody can answer
 * and a loop that never closes.
 *
 * Per entry rather than all-or-nothing. A module that names three
 * answers and one stray `undefined` meant the three, and dropping them
 * with it would turn a small mistake into a question with no buttons at
 * all. What does not survive is simply not offered — and if nothing
 * survives, the refusal still escalates, still carries its reason, and
 * still parks the ticket. `reason` is the part that must never be lost;
 * these are the shortcut.
 *
 * Over-long options are dropped rather than truncated, and that is the
 * one place this is deliberately lossy. The label a person clicks is the
 * answer the next run matches against — a truncated option would offer
 * an answer nobody named, and match nothing when it came back.
 *
 * The caps come in on the request for the same reason the comment ones
 * do: the parent applies the length again, on the redacted label it is
 * about to hand the supervisor, because replacing a secret with «NAME»
 * can make a short answer long. One number sent to both halves rather
 * than two that have to agree — a copy here would be a cap the escalation
 * comment quietly exceeded the day somebody edited one of them.
 */
function offeredAnswers(value, limits) {
  if (!Array.isArray(value)) return [];
  // Absent caps mean nothing is offered, matching `makeComments`: a host
  // told no limit has not been told it may ignore one, and a refusal
  // with no buttons still escalates on its reason.
  const caps = limits ?? {};
  const max = Number.isFinite(caps.max) ? caps.max : 0;
  const maxChars = Number.isFinite(caps.maxChars) ? caps.maxChars : 0;
  const offered = [];
  for (const option of value) {
    if (offered.length >= max) break;
    if (typeof option !== "string") continue;
    // Trimmed rather than merely tested: whitespace at either end is
    // noise in a button and noise in the text a reply is compared with.
    const answer = option.trim();
    if (answer === "" || answer.length > maxChars) continue;
    offered.push(answer);
  }
  return offered;
}

/**
 * The nonce the parent will accept a result under.
 *
 * Read from the request on stdin, held here, and written nowhere the
 * module can reach: stdin is consumed before the module is imported, it
 * is not in `argv` and it is deliberately not in the environment, so
 * `/proc/self/cmdline` and `/proc/self/environ` do not disclose it.
 *
 * This exists because the result descriptor is *not* private. The module
 * runs in this process, so `writeSync(4, …)` from `node:fs` reaches it —
 * a module could write something result-shaped, exit before the host
 * answered, and have a failed deploy read as a successful one. Requiring
 * the nonce means an unsigned write is ignored rather than believed.
 *
 * It is not a defence against a module that goes looking for it, and
 * nothing here is: see the file header on what this process is and is
 * not.
 */
let nonce = "";

/**
 * A value as JSON text, without asking the value how (EO-436).
 *
 * `JSON.stringify` looks up `toJSON` on every object and array it is
 * about to write, and that lookup goes through the prototype chain — so
 * a module that had set `Object.prototype.toJSON` was called in the
 * middle of the host writing its answer, twice over. Once with the
 * envelope as `this`, which is the nonce handed to it: it wrote a line
 * of its own to fd 4 under that nonce, ahead of the host's, and the
 * parent believes the first signed line. And once with the payload,
 * where whatever it returned is what the host then signed. Either way a
 * run that failed was recorded as whatever the module preferred.
 *
 * A function taken at load does not help with that — it is the real
 * `JSON.stringify` doing what it is specified to do. So objects and
 * arrays are walked here, and only primitives are handed to it: for a
 * string or a number there is no `toJSON` lookup at all, which is the
 * property this rests on. Nothing below is found through a prototype a
 * module can reach — no `for…of`, no `push`, no `join` — only own keys,
 * own indices and `+`.
 *
 * It is what `JSON.stringify` writes for plain data, which is all the
 * host ever answers with: a property that is undefined, a function or a
 * symbol is left out of an object and is `null` in an array, and a
 * number JSON cannot say is `null`. `toJSON` is not honoured, which is
 * the point of it. Depth is bounded so that a cycle is an error with a
 * sentence rather than a stack overflow.
 */
function encodePlain(value, depth = 0) {
  const { jsonStringify, isArray, keys } = PRIMORDIALS;
  if (value === null) return "null";
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return jsonStringify(value);
  if (kind === "number") return value - value === 0 ? jsonStringify(value) : "null";
  if (kind !== "object") return undefined;
  if (depth > MAX_RESULT_DEPTH) throw new TypeError("EO could not write this result: it is nested too deeply, or contains itself.");

  if (isArray(value)) {
    let text = "[";
    const { length } = value;
    for (let index = 0; index < length; index += 1) {
      if (index > 0) text += ",";
      text += encodePlain(value[index], depth + 1) ?? "null";
    }
    return `${text}]`;
  }

  let text = "{";
  const names = keys(value);
  const { length } = names;
  let written = 0;
  for (let index = 0; index < length; index += 1) {
    const name = names[index];
    const encoded = encodePlain(value[name], depth + 1);
    if (encoded === undefined) continue;
    if (written > 0) text += ",";
    text += `${jsonStringify(name)}:${encoded}`;
    written += 1;
  }
  return `${text}}`;
}

/** Far past anything the host answers with; coverage ranges are four levels down. */
const MAX_RESULT_DEPTH = 64;

function respond(payload) {
  // `writeSync` on the result descriptor, not `process.stdout.write`:
  // stdout is the module's, and a synchronous write cannot be lost to an
  // exit that happens before an async one flushes.
  //
  // The payload is encoded before the nonce is anywhere near it, and the
  // line is put together from two strings (EO-436). There is no object
  // holding the nonce for anything to be called on, and `encodePlain`
  // calls nothing of a module's on the way — so the line written here is
  // the host's own answer, and the only one carrying the nonce.
  const encoded = encodePlain(payload) ?? "null";
  PRIMORDIALS.write(RESULT_FD, `{"nonce":${PRIMORDIALS.jsonStringify(nonce)},"payload":${encoded}}\n`);
}

function read(stream) {
  return new Promise((resolve, reject) => {
    let text = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      text += chunk;
    });
    stream.on("end", () => resolve(text));
    stream.on("error", reject);
  });
}

// Importable for its own tests, executed when launched as the host.
if (process.argv[1] && process.argv[1].endsWith("moduleHost.mjs")) {
  main().catch((error) => {
    respond({ ok: false, reason: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}
