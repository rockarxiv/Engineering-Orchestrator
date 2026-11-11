// EO-379: the command Codex runs as EO's `PreToolUse` hook.
//
// **Why this is a file at all.** Claude's SDK takes a hook as a function
// in EO's own process. Codex takes one as a *command*: it spawns it, puts
// the tool call on its stdin as JSON and reads what to tell the model off
// its stdout. So something executable has to exist as a real path — the
// same reason `eoServer.mjs` and `superviseStdioServer.mjs` are shipped
// beside the bundle rather than inside it.
//
// **Why there is no judgement in it.** Which calls are broad searches,
// and what sentence answers one, is decided in exactly one place:
// `packs/developer/repositoryIntelligence/broadSearch.ts`. This file is
// copied verbatim rather than bundled, so it cannot import that — and a
// second copy of the rules here would be two classifiers that have to
// agree, which is the thing this story was written to refuse. So it
// decides nothing. It carries the payload to the listener the Codex
// adapter opened for this turn (`codexSearchHook.ts`), which hands it to
// the same function the Claude hook calls, and it prints whatever comes
// back. Nothing in here reads `tool_name` or `tool_input`.
//
// **It can only ever stay quiet when something goes wrong.** A hook that
// fails is reported against the tool call it fired on, and a nudge that
// breaks the command it is nudging about is worse than no nudge. So every
// failure — no listener, a refused connection, a slow answer, an answer
// that is not the expected one — ends the same way: nothing on stdout and
// exit 0, which Codex reads as a hook with nothing to say.
//
// **Except on a turn that refuses calls (EO-732).** On the learning
// review's fork the same command carries EO's refusals, and there a
// failure must not let the call through: a refusal that fails open is no
// refusal. `EO_SEARCH_HOOK_REFUSES` says which turn this is, and every
// failure then refuses the call, saying why. An answer of "nothing to say"
// (204) is still the listener allowing the call.
//
// The globals this file uses, declared the way `eoServer.mjs` declares
// its own: nothing here is bundled, so there is no tsconfig lib to say
// what a Node runtime provides.
/* global process, setTimeout, Buffer */
import { request } from "node:http";

/**
 * How long the listener is given. The judgement has a deadline of its
 * own, well inside this; this one is for a listener that is not there to
 * answer at all, because what is waiting on this process is a tool call.
 */
const TIMEOUT_MS = 5000;

const url = process.env["EO_SEARCH_HOOK_URL"];
const token = process.env["EO_SEARCH_HOOK_TOKEN"];
const refuses = process.env["EO_SEARCH_HOOK_REFUSES"] === "1";

/** Nothing to say, and the call goes on: what every failure is, except where this turn refuses calls (EO-732). */
function allow() {
  process.exit(0);
}

/** A failure: quiet on an ordinary turn, and on a turn that refuses calls the call refused. */
let refusing = false;
function quiet() {
  if (!refuses) allow();
  // Once: a timeout and a failed request can both land before the write.
  if (refusing) return;
  refusing = true;
  const refusal = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "EO refused this call: it could not check it, and this turn may make only some calls.",
    },
  };
  process.stdout.write(JSON.stringify(refusal), () => process.exit(0));
}

if (!url || !token) quiet();

setTimeout(quiet, TIMEOUT_MS).unref();

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("error", quiet);
process.stdin.on("end", () => {
  const body = Buffer.concat(chunks);
  let outgoing;
  try {
    outgoing = request(
      url,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": body.length },
        timeout: TIMEOUT_MS,
      },
      (response) => {
        const answer = [];
        response.on("data", (chunk) => answer.push(chunk));
        response.on("error", quiet);
        response.on("end", () => {
          // 200 is the one status with something to say. 204 is "not a
          // broad search" (or a call the turn may make), and anything else
          // is a listener that is not EO's or not well.
          if (response.statusCode === 204) allow();
          if (response.statusCode !== 200) quiet();
          process.stdout.write(Buffer.concat(answer), allow);
        });
      },
    );
  } catch {
    quiet();
    return;
  }
  outgoing.on("timeout", quiet);
  outgoing.on("error", quiet);
  outgoing.end(body);
});
