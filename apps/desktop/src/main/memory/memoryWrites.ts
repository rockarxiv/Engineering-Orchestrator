import type { MemorySource, MemoryWriteResult } from "@eo/core";
import type { Db } from "../db/client.js";
import { addMemory, editMemory, noteMemory, restoreMemory, retireMemory } from "../db/repos/index.js";
import type { MemoryWriteRequest } from "../record/record.js";

/**
 * A write to memory, made in this database (EO-478, EO-482).
 *
 * The one place a `MemoryWriteRequest` turns into rows, used by whichever
 * record owns the project: the local record of a solo desktop or of a
 * project kept on one, and the organisation's record answering a device
 * (`serveMemory`). So the rules for what a write does are one set
 * wherever it lands — an edit retires and inserts, a note retires what
 * it replaces and inserts (EO-594), a retirement and a restore stamp and
 * clear, and nothing is deleted.
 *
 * `person` is who a person's write is sourced to: nobody in particular on
 * a solo installation, and on a record the person whose device asked.
 * `projectId` is the project a person's new entry belongs to, where the
 * record holds a workspace's memory without the workspace's row.
 */
export function applyMemoryWrite(db: Db, request: MemoryWriteRequest, person: MemorySource, projectId?: string): MemoryWriteResult {
  switch (request.op) {
    case "note":
      return noteMemory(db, {
        scope: request.scope,
        body: request.body,
        source: { type: "run", runId: request.runId, itemId: request.item.id, ...(request.extracted === true ? { extracted: true as const } : {}) },
        ...(request.item.projectId === null ? {} : { projectId: request.item.projectId }),
        ...(request.now === undefined ? {} : { now: request.now }),
        replaces: request.replaces ?? [],
        scopes: request.scopes ?? [],
      });
    case "add":
      return addMemory(db, { scope: request.scope, body: request.body, source: person, ...(projectId === undefined ? {} : { projectId }) });
    case "edit":
      return editMemory(db, request.id, request.body, person);
    case "retire":
      return retireMemory(db, request.id, { reason: "retired" });
    case "restore":
      return restoreMemory(db, request.id);
  }
}

/**
 * A person, on an installation that has one: the source of every entry a
 * person writes on a solo desktop, where there is nobody to tell them
 * apart from. Organisation mode names them on the record (EO-482).
 */
export const A_PERSON: MemorySource = { type: "person", personId: null };
