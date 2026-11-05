import { editableWhenDiverged, lockedSectionsFor, PUBLISHED_SECTIONS, type IpcChannel, type PublishedSection, type SectionLock } from "@eo/core";
import type { Db } from "../db/client.js";
import { isReplica } from "../db/recordRole.js";
import { isDiverged } from "../db/repos/divergenceRepo.js";
import { publishedSectionRow } from "../db/repos/publishedSectionsRepo.js";

/**
 * Whether a write is one this installation may make (EO-329,
 * `ARCHITECTURE.md`, "Publish, lock and versions").
 *
 * ## Where the lock binds, and why it is not the renderer
 *
 * the original design, in its own words: "the system agent's admin MCP server
 * reaches the same handlers as the renderer through `dispatchIpc`, and
 * a renderer-only lock would let the assistant rewrite a published
 * pipeline from a chat." So the lock is asked below both doors, of
 * every registered channel, before the handler for it runs —
 * `handleIpcRequest`, which the renderer's `ipcMain.handle`, the MCP
 * host's `dispatchIpc` and the server's HTTP door all go through.
 *
 * One place rather than a check written into each of the eighteen
 * commands, and that is a decision about how this fails rather than
 * about how much typing it is. `ReadOnlyFence` already argues it for
 * the renderer: "a prop is only as complete as whoever remembered to
 * pass it… a fence cannot be forgotten the same way". The same is true
 * here with worse consequences — the guard `savePipeline` remembered
 * and `saveAgent` did not is a published agents section a chat can
 * still rewrite, and every test passes. What a command *can* forget is
 * covered by `SECTION_LOCKED_CHANNELS` being a written list in core
 * that `locks.test.ts` checks against the contract.
 *
 * ## Why being a replica is half the question
 *
 * The rows are the same rows on both ends: the record writes one when
 * an admin publishes, and every signed-in desktop stores a copy. It is
 * the *reading* that differs, because publishing is exactly what an
 * admin does on the record and a lock that bound there would lock the
 * one person who is supposed to be editing.
 *
 * `isReplica(db)` — asked with no item, which is its coarse form: does
 * this machine have a record somewhere else. True on a signed-in
 * desktop, false on a server, false on a solo desktop. A fact read at
 * each write rather than captured, because a person signs in and out
 * without relaunching.
 *
 * ## The one pipeline a lock steps over (EO-331, ARCHITECTURE.md, "Divergence and suggestions")
 *
 * A pipeline this machine has **diverged** is editable through
 * `pipeline:save`, and that is not the lock going per-field. It is
 * the original design's sentence being true: *Suggest a change* "opens an editable
 * copy", and a copy that could not be edited would be a button that
 * lies. The section is as locked as it was — a person may still not
 * create, delete, import or install a pipeline, approve a module or
 * take a pack, and the four other sections are untouched.
 *
 * What makes it safe is that divergence is a *written* fact, in a
 * column, put there by the very command a person pressed
 * (`pipelines:suggest`) or by the assistant doing what that button
 * does. Nothing an agent sends can claim it: a payload naming a
 * pipeline nobody diverged meets the lock exactly as before, which is
 * what `subjectPipeline` below fails towards.
 */
export function sectionLockFor(db: Db, channel: IpcChannel, payload?: unknown): SectionLock | null {
  const sections = lockedSectionsFor(channel);
  if (sections.length === 0) return null;
  // The record is where an admin publishes. Asked before the rows,
  // because a server holds every one of them.
  if (!isReplica(db)) return null;
  // The one pipeline this write may be about, where it is about one at
  // all and this machine has already diverged it (EO-331, ARCHITECTURE.md, "Divergence and
  // suggestions").
  const mine = editableWhenDiverged(channel) && isDiverged(db, subjectPipeline(payload) ?? "");
  for (const section of sections) {
    if (section === "pipelines" && mine) continue;
    const published = publishedSectionRow(db, section);
    if (published !== undefined) {
      return { locked: true, section, publishedBy: published.publishedByName ?? published.publishedBy };
    }
  }
  return null;
}

/**
 * The pipeline a write names, read out of a payload nothing has
 * validated yet (EO-331).
 *
 * Defensive on purpose. The lock is asked *before* the payload is
 * parsed — "a locked section refuses whatever was sent, and saying
 * 'invalid request' first would tell a caller to go and fix a payload
 * that was never going to be written" — so what arrives here is
 * genuinely `unknown`, and the only honest reading of a shape that is
 * not what it should be is "this names no pipeline", which locks.
 *
 * Failing that way round is the whole of the safety argument: a
 * malformed payload, a renamed field, a caller sending a number — every
 * one of them ends at the lock rather than past it. The exception has
 * to be *earned* by naming a pipeline this machine has on record as
 * diverged, and nothing else can be mistaken for that.
 */
function subjectPipeline(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const named = (payload as { pipelineId?: unknown }).pipelineId;
  return typeof named === "string" && named !== "" ? named : null;
}

/**
 * Which of the five this installation may not edit — what the screens
 * draw their locks from.
 *
 * Derived, never stored, for invariant #6's reason one subject over:
 * the row says a section was published and the installation says
 * whether that binds here, and a stored answer would be a third thing
 * able to disagree with both. Empty on a server and on a solo desktop.
 */
export function lockedSections(db: Db): PublishedSection[] {
  if (!isReplica(db)) return [];
  const locked = new Set<PublishedSection>();
  for (const section of PUBLISHED_SECTIONS) {
    if (publishedSectionRow(db, section) !== undefined) locked.add(section);
  }
  return [...locked];
}
