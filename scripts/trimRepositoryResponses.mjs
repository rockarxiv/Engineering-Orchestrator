#!/usr/bin/env node
// EO-164, arm A: the repository index with its noise removed.
//
// **This is apparatus, not a shipped component.** EO-164 named two
// candidate reasons the index gets called once and then abandoned, and
// said to test them one at a time. One of them is that the answer is
// half noise — a `codewiki_context` reply that lists React state
// variables from an unrelated screen and a variable called `module` from
// a test file alongside the symbols that matter. This file is how that
// hypothesis was given a fair trial: it is a JSON-RPC relay that sits
// between the backend and the real server and strips exactly that
// material out of `tools/call` results, so an arm of the experiment can
// be run against a clean answer without EO shipping a relay to get one.
//
//   node scripts/trimRepositoryResponses.mjs <codewiki> serve --mcp --path <root> --no-watch
//
// **Why EO does not ship this.** `main/mcp/superviseStdioServer.mjs`
// makes the opposite choice on purpose: it keeps the server's replies on
// an inherited descriptor so that nothing EO wrote sits in the middle of
// every tool call an agent makes. Putting a hand-written relay there
// trades a loud failure for a quiet one. It is worth that trade only if
// the noise is what is costing adoption, and the point of this file is
// to find out before paying.
/* global process */
import { spawn } from "node:child_process";

/** A symbol line the agent cannot act on, or would be misled by. */
function noise(line) {
  return (
    // Destructured React state — `[outcome, setOutcome]` names nothing
    // that can be looked up, called, or read anywhere else.
    /\*\*\[[^\]]*\]\*\*/.test(line) ||
    // A symbol whose only definition is in a test or a fixture. Real,
    // and never the answer to "where does this behaviour live".
    /`[^`]*(?:\.test\.|__fixtures__|\.spec\.)[^`]*`/.test(line)
  );
}

/**
 * Strips the sections nothing can be done with, and the entries inside
 * the good sections that name nothing lookupable.
 *
 * Section-aware rather than line-by-line: dropping a heading has to drop
 * its body too, and dropping a symbol from the lists has to drop the
 * `### Key Code` block that quotes it, or the trim would leave the
 * response *more* confusing than it found it.
 */
export function trim(text) {
  const dropped = new Set();
  const out = [];
  let skipping = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{2,4}\s/.test(line)) {
      // The edge section: a count of relationships, or edges named by
      // hash. Neither can be looked up, so neither earns its bytes.
      skipping = /^###\s+Relationships\s*$/.test(line);
      if (!skipping && /^####\s/.test(line)) {
        const symbol = /^####\s+`?([^`\s(]+)/.exec(line)?.[1];
        if (symbol && dropped.has(symbol)) skipping = true;
      }
      if (skipping) continue;
    }
    if (skipping) continue;
    if (noise(line)) {
      const symbol = /\*\*([^*]+)\*\*/.exec(line)?.[1];
      if (symbol) dropped.add(symbol);
      continue;
    }
    // The summary sentence promises relationships this now omits.
    out.push(line.replace(/\s*\d+ relationships?\./, ""));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function trimResult(message) {
  const content = message?.result?.content;
  if (!Array.isArray(content)) return message;
  for (const part of content) if (typeof part?.text === "string") part.text = trim(part.text);
  return message;
}

/**
 * The relay, started only when this file is the program.
 *
 * Guarded so that `trim` can be imported and exercised on a captured
 * response without spawning anything — which is how the before/after
 * figures in EO-164's handover were taken.
 */
function relay(command, args) {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim() === "") continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // Not a frame this understands. Relay it untouched rather than
        // dropping it — a relay that eats what it cannot parse is a
        // relay that breaks the protocol it was meant to be transparent
        // to.
        process.stdout.write(line + "\n");
        continue;
      }
      process.stdout.write(JSON.stringify(trimResult(message)) + "\n");
    }
  });
  process.stdin.pipe(child.stdin);
  process.stdin.on("end", () => child.kill());
  child.stdin.on("error", () => {});
  child.once("exit", (code) => process.exit(code ?? 0));
}

const [command, ...args] = process.argv.slice(2);
if (command !== undefined) relay(command, args);
