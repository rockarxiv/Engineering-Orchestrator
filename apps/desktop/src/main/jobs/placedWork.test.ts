import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_PERSON_ID, type JobRunsOn, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb, createTestItem } from "../db/testHelpers.js";
import { listItemsForProject, listOccurrences } from "../db/repos/index.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { jobOwnerForItem, serverPlacedItemIds } from "../db/repos/jobsRepo.js";
import { jobs as jobRows } from "../db/schema.js";
import { viewerFor } from "../identity/viewer.js";
import { createLocalRecord } from "../record/localRecord.js";
import { buildTickInput } from "../supervisor/buildTickInput.js";
import { createJob } from "./jobs.js";
import { runJobTick } from "./scheduler.js";

/**
 * Where a job's work actually happens (EO-330,
 * `ARCHITECTURE.md`, "Where a job runs").
 *
 * The story's third acceptance criterion, which is not a claim about a
 * screen: *a server job fires on schedule with no desktop online, and
 * its item appears on a desktop when it signs in.* Two halves, and the
 * second one is the easy one to get wrong — "the server runs it" must
 * not become "the desktop cannot see it". The item is an ordinary item
 * on an ordinary board; what placement decides is only which machine is
 * offered the work.
 *
 * So these drive the record rather than the supervisor: the record is
 * the half that places, and `offerWork`'s `runsOn` is the whole of how
 * it does. What a *supervisor* does with an offer is
 * `supervisor/recordDevice.test.ts`'s question.
 */

let handle: DbHandle;
let clock: number;

/** 2026-06-01 is a Monday; 08:00 in Berlin is 06:00Z. */
const MONDAY_0800 = Date.UTC(2026, 5, 1, 6, 0);
const LIMITS = { globalConcurrency: 4, perAgentConcurrency: 4, perRepositoryConcurrency: 4 };

beforeEach(() => {
  handle = openMigratedTestDb();
  clock = MONDAY_0800;
});

afterEach(() => {
  handle.close();
});

/**
 * A weekly job that was already standing when its occurrence came
 * round.
 *
 * `createJob` stamps "now" and the catch-up sweeps from a job's
 * creation, so a job made this instant has missed nothing — right, and
 * not what any of this is about.
 */
function weeklyJob(name: string, runsOn: JobRunsOn, ownerId?: Uuid) {
  const result = createJob(handle.db, {
    projectId: null,
    name,
    trigger: {
      kind: "schedule",
      schedule: { kind: "weekly", weekday: 1, hour: 8, minute: 0 },
      timeZone: "Europe/Berlin",
      catchUpWithinMinutes: 180,
    },
    pipelineId: "default",
    template: { type: "developer:story", title: name, body: null },
    runsOn,
    ...(ownerId === undefined ? {} : { ownerId }),
  });
  if (!result.ok) throw new Error(result.problem);
  handle.db.update(jobRows).set({ createdAt: MONDAY_0800 - 60_000 }).where(eq(jobRows.id, result.job.id)).run();
  return result.job;
}

/**
 * What the record hands a machine of this kind, asking for everything
 * it has.
 *
 * Awaited because the record's door is async: a remote one is a request
 * over the wire, and the local one keeps the same shape.
 */
async function offers(runsOn: JobRunsOn, deviceId: string): Promise<string[]> {
  const record = createLocalRecord(handle.db, { now: () => clock });
  const given = await record.offerWork({
    deviceId,
    capacity: 10,
    tickInput: buildTickInput(handle.db, LIMITS, false),
    runsOn,
    at: clock,
  });
  return given.map((offer) => offer.dispatch.item.id);
}

/** The same ask, at the concurrency EO ships (invariant #10). */
async function oneSlot(runsOn: JobRunsOn, deviceId: string): Promise<string[]> {
  const record = createLocalRecord(handle.db, { now: () => clock });
  const given = await record.offerWork({
    deviceId,
    capacity: 1,
    tickInput: buildTickInput(handle.db, { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 }, false),
    runsOn,
    at: clock,
  });
  return given.map((offer) => offer.dispatch.item.id);
}

/** The item the last tick filed for this job. */
function itemFiredBy(jobId: string): string {
  const occurrence = listOccurrences(handle.db, jobId as Uuid).find((row) => row.status === "fired");
  if (occurrence?.itemId == null) throw new Error(`nothing fired for ${jobId}`);
  return occurrence.itemId;
}

describe("a job somebody put on the organisation server", () => {
  it("fires on schedule with no desktop anywhere near it", () => {
    // The server is the record and it runs the only scheduler, so the
    // occurrence is not waiting on anybody's laptop being open. Nothing
    // in this test is a device.
    const job = weeklyJob("Monday report", "server");

    const result = runJobTick(handle.db, { now: clock });

    expect(result.fired).toEqual([job.id]);
    expect(listOccurrences(handle.db, job.id as Uuid).map((row) => row.status)).toEqual(["fired"]);
  });

  it("is offered to the server and to no desktop", async () => {
    const job = weeklyJob("Monday report", "server");
    runJobTick(handle.db, { now: clock });
    const item = itemFiredBy(job.id);

    // The desktop asks first, deliberately. An offer *claims* what it
    // hands over, so asking the server first would leave the item
    // leased and the desktop offered nothing for a reason that has
    // nothing to do with placement — a test that passes either way.
    // Anna's laptop signs in, asks for work, and is offered none: the
    // person deliberately put this job somewhere else, and nothing
    // about the ask fails.
    expect(await offers("device", "anna-laptop")).toEqual([]);
    expect(await offers("server", "eo-server")).toContain(item);
  });

  it("puts its item on the board a desktop reads, which is where it appears when one signs in", async () => {
    // The other half of the criterion, and the half that would be easy
    // to lose: placement decides which machine *runs* the work, never
    // who can see it. The item is an ordinary item — on the board, with
    // its provenance, filed by the owner — and a desktop that signs in
    // tomorrow finds it there.
    const anna = createPerson(handle.db, { name: "Anna", email: "anna@example.com" });
    const job = weeklyJob("Monday report", "server", anna.id as Uuid);
    runJobTick(handle.db, { now: clock });
    const item = itemFiredBy(job.id);

    const board = listItemsForProject(handle.db, null);
    expect(board.map((row) => row.id)).toContain(item);
    // Created by the job's owner, not by whichever process happened to
    // stamp it out — so the mentions on it are Anna's (ARCHITECTURE.md, "Where a job runs").
    expect(board.find((row) => row.id === item)?.createdBy).toBe(anna.id);
  });
});

describe("a server with one slot and a desktop's work in front of it", () => {
  it("is still offered its own", async () => {
    // The scheduler returns one dispatch per capacity slot, which is
    // one at the concurrency EO ships — so placing its *answer* would
    // spend the only slot there is on an item that is then thrown away
    // for being somebody else's. A server would be offered nothing, on
    // every tick, for as long as an unclaimed desktop item stood at the
    // front of the board. Which is the third acceptance criterion's own
    // situation: no desktop online, and their work waiting.
    createTestItem(handle.db, { type: "story", title: "Anna's, and she is asleep", stepId: "todo" });
    const job = weeklyJob("Monday report", "server");
    runJobTick(handle.db, { now: clock });

    expect(await oneSlot("server", "eo-server")).toEqual([itemFiredBy(job.id)]);
  });
});

describe("a job that stayed on somebody's machine", () => {
  it("is offered to a desktop and never to the server", async () => {
    const job = weeklyJob("Monday report", "device");
    runJobTick(handle.db, { now: clock });
    const item = itemFiredBy(job.id);

    // What stops a server contending for work that needs somebody's
    // login and somebody's disk. It runs a device loop since EO-330;
    // this is the scope on it. Asked before the desktop's, so that an
    // offer nobody made is the reason rather than a lease somebody
    // else is holding.
    expect(await offers("server", "eo-server")).toEqual([]);
    expect(await offers("device", "anna-laptop")).toContain(item);
  });
});

describe("an item no job filed", () => {
  it("is a desktop's, which is where work a person typed has always run", async () => {
    const typed = createTestItem(handle.db, { type: "story", title: "Typed by hand", stepId: "todo" });

    expect(serverPlacedItemIds(handle.db).has(typed.id)).toBe(false);
    expect(await offers("server", "eo-server")).toEqual([]);
    expect(await offers("device", "anna-laptop")).toContain(typed.id);
  });
});

describe("who an item's 'you' is where the process has none", () => {
  it("is the job's owner on an item a server ran, rather than everybody", () => {
    // A server's own signed-in person is nobody in particular, and
    // `LOCAL_PERSON_ID` is read as "one of ours" by every signed-in
    // desktop — so an escalation raised at 03:00 would land in every
    // inbox, which is the same as landing in none.
    const anna = createPerson(handle.db, { name: "Anna", email: "anna@example.com" });
    const job = weeklyJob("Monday report", "server", anna.id as Uuid);
    runJobTick(handle.db, { now: clock });

    expect(jobOwnerForItem(handle.db, itemFiredBy(job.id) as Uuid)).toBe(anna.id);
    expect(viewerFor(handle.db, itemFiredBy(job.id) as Uuid)).toBe(anna.id);
  });

  it("is unchanged for an item nobody's job filed", () => {
    const typed = createTestItem(handle.db, { type: "story", title: "Typed by hand", stepId: "todo" });

    expect(viewerFor(handle.db, typed.id as Uuid)).toBe(LOCAL_PERSON_ID);
  });
});
