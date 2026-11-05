#!/usr/bin/env node
// The prompts EO shipped before it recorded what it wrote (migration 0033).
//
// `syncRolePrompts` decides whether an agent's instructions are EO's own
// words or somebody's edit. From 0033 on that is recorded at write time,
// but every install older than the column has no provenance at all — so
// the one remaining way to recognise an untouched default there is to
// know the text of every default EO ever shipped.
//
// This walks each prompt file's git history and prints that set, ready to
// paste into `SHIPPED_PROMPT_HASHES` in `apps/desktop/src/main/roles/prompts.ts`.
//
//   node scripts/shipped-prompt-hashes.mjs
//
// It should not need running again: the set is closed, and anything
// written after 0033 carries its own hash. It exists so the constant in
// that file is reproducible rather than asserted.
//
// It prints every version in history, which is a superset of what the
// constant holds. Take the versions that predate 0033 — the later ones
// carry their own provenance and belong in nobody's list. The one
// exception is a prompt whose role has just been renamed: the version
// shipping with the rename goes in too, because until the next revision
// there is no earlier text under that role name to recognise.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// A role, and every path its prompt has ever been shipped at — newest
// first. More than one when a role replaces another: EO-181 merged the
// product owner and the pipeline architect into `system`, and a pre-0033
// row that is now `system` still holds the text it was shipped as, so
// that text has to be recognised under the new role's name. The
// architect's file is not here: it first shipped with migration 0036,
// after 0033, so no install of it lacks provenance.
// KAN-144 moved the directory into the developer pack, which is a
// second path per role rather than a replacement: the history before
// the move is still where the older text is, and it is the older text
// this script exists to find.
const FILES = {
  system: [
    "apps/desktop/src/main/packs/developer/prompts/system-agent.md",
    "apps/desktop/src/main/roles/prompts/system-agent.md",
    "apps/desktop/src/main/roles/prompts/product-owner.md",
  ],
  implementer: [
    "apps/desktop/src/main/packs/developer/prompts/implementer.md",
    "apps/desktop/src/main/roles/prompts/implementer.md",
  ],
  reviewer: [
    "apps/desktop/src/main/packs/developer/prompts/reviewer.md",
    "apps/desktop/src/main/roles/prompts/reviewer.md",
  ],
};

// stderr piped rather than inherited: `git show` is expected to fail on
// the commit that *deleted* a prompt, and that is caught below — without
// this the child writes "fatal: path does not exist" straight to the
// terminal and the output looks broken when it is not.
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

for (const [role, paths] of Object.entries(FILES)) {
  console.log(`  ${role}: [`);
  const seen = new Set();
  for (const path of paths) {
    const commits = git("log", "--format=%H", "--", path).trim().split("\n").filter(Boolean);

    for (const commit of commits) {
      // `git log -- path` reports the commit that deleted a file as well
      // as the ones that wrote it, and there is nothing to read at that
      // revision. Skip it rather than failing the whole run.
      let text;
      try {
        text = git("show", `${commit}:${path}`).trim();
      } catch {
        continue;
      }
      // Hashed the way prompts.ts hashes them: over the trimmed text, since
      // that is what `loadRolePrompt` stores.
      const hash = createHash("sha256").update(text).digest("hex");
      if (seen.has(hash)) continue;
      seen.add(hash);

      const version = /prompt-version:\s*(\d+)/.exec(text.split("\n")[0] ?? "")?.[1] ?? "?";
      console.log(`    "${hash}", // v${version}`);
    }
  }
  console.log("  ],");
}
