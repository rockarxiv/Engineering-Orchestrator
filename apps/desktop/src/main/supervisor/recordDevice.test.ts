import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agent, Item, Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createRun, getItem, listAgents, listCommentsForItem, listRunsForItem, recordOccurrence } from "../db/repos/index.js";
import { createJob } from "../jobs/jobs.js";
import { grantLease, leaseFor, listLeases } from "../db/repos/leasesRepo.js";
import { listTransitionsForItem } from "../db/repos/transitionsRepo.js";
import { createLocalRecord, type LocalItemRecord } from "../record/localRecord.js";
import { LOCAL_DEVICE_ID } from "../record/device.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { createRunSupervisor, type RunSupervisor, type RunSupervisorOptions } from "./runSupervisor.js";
import { kindsPreparing } from "./testWorkspaceKinds.js";

/**
 * The record and the device, in one process (EO-322,
 * `ARCHITECTURE.md`, "The record").
 *
 * The supervisor is the device: it claims a dispatch under a lease,
 * runs the machine-local preflight, runs the dispatch and reports. It
 * does not write where an item sits — it sends a transition command and
 * the record applies it, which is what makes one writer survive there
 * being more than one process later on.
 *
 * Solo mode is both roles in one process with a local lease, and these
 * assert that it behaves exactly as it always did while being visibly
 * the two halves: a claim taken and given back around a dispatch that
 * has no run row to show for itself, a refusal reported as a comment,
 * and a claim nobody renewed released on the next tick.
 */

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
const CWD = "/tmp/eo/worktrees/EO-322";
const TTL = 60_000;

let handle: DbHandle;
let item: Item;
let implementer: Agent;
let clock: number;

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
  implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  clock = 1_700_000_000_000;
});

afterEach(() => {
  handle.close();
});

/** The record this supervisor's device talks to, so a test can claim as somebody else. */
let record: LocalItemRecord;

function supervisorWith(overrides: Partial<RunSupervisorOptions> = {}): RunSupervisor {
  record = createLocalRecord(handle.db, { now: () => clock, leaseTtlMs: TTL });
  return createRunSupervisor({
    db: handle.db,
    provider: createFakeProvider({ steps: [{ output: "working" }], result: validImplementResult }),
    limits: LIMITS,
    kinds: kindsPreparing(CWD),
    record,
    leaseTtlMs: TTL,
    ...overrides,
  });
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for something the dispatch does on its own schedule, or gives up loudly. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** What the person is told, newest last. */
function bodies(): string[] {
  return listCommentsForItem(handle.db, item.id).map((comment) => comment.body);
}

describe("a dispatch this device cannot preflight", () => {
  it("reports the refusal as a comment and gives the claim back", async () => {
    const supervisor = supervisorWith({
      // The machine-local half: this desktop is not signed in to the
      // backend this agent runs on, which is a fact no record holding
      // this item could have known.
      checkAuth: async () => ({ ok: false, reason: "You are not signed in to Claude on this machine." }),
    });

    await supervisor.runOnce();

    expect(bodies().join("\n")).toContain("not signed in to Claude on this machine");
    // The claim is given back whatever the dispatch came to. An item
    // held by a device that has decided it cannot do the work is an
    // item nothing will offer and nothing is working on.
    expect(leaseFor(handle.db, item.id)).toBeNull();
    // And the refusal is a real run row carrying the reason, parked for
    // a person — which is what every other guard in the supervisor does
    // and what this had to keep doing.
    expect(listRunsForItem(handle.db, item.id).map((run) => run.status)).toEqual(["awaiting_input"]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  it("is not dispatched again while the claim stands", async () => {
    const supervisor = supervisorWith({ checkAuth: async () => ({ ok: false, reason: "Not signed in." }) });
    // Somebody else's claim, standing: the record does not offer the
    // item at all, so the device never gets as far as its preflight.
    grantLease(handle.db, { itemId: item.id, deviceId: "anna-laptop", now: clock, ttlMs: TTL });

    await supervisor.runOnce();

    expect(listRunsForItem(handle.db, item.id)).toEqual([]);
    expect(bodies()).toEqual([]);
    expect(leaseFor(handle.db, item.id)?.deviceId).toBe("anna-laptop");
  });
});

describe("a claim nobody renewed", () => {
  it("is released on the next tick, with a comment naming the device that held it", async () => {
    const supervisor = supervisorWith();
    grantLease(handle.db, { itemId: item.id, deviceId: "anna-laptop", now: clock, ttlMs: TTL });

    clock += TTL + 1;
    await supervisor.runOnce();

    expect(bodies().join("\n")).toContain("anna-laptop");
    // And the item is available again — the same tick that released it
    // went on to dispatch it, which is the whole reason the sweep is at
    // the top of the tick rather than somewhere on its own.
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1);
  });

  it("is not released while its device is still saying so", async () => {
    const supervisor = supervisorWith();
    grantLease(handle.db, { itemId: item.id, deviceId: "anna-laptop", now: clock, ttlMs: TTL });

    clock += TTL - 1;
    await supervisor.runOnce();

    expect(bodies()).toEqual([]);
    expect(leaseFor(handle.db, item.id)?.deviceId).toBe("anna-laptop");
  });
});

describe("this device's own claims", () => {
  it("are not renewed back to life after a stall longer than the whole term", async () => {
    const supervisor = supervisorWith();
    // A claim this process is holding — and then a laptop asleep, or an
    // event loop blocked, for longer than the lease lasts. Every tick
    // that would have renewed it did not happen.
    // The claim is granted by the record and adopted by the device —
    // which is what an offer of work does, in one step, since EO-324.
    const claimed = record.grantLease({ itemId: item.id, deviceId: LOCAL_DEVICE_ID })!;
    supervisor.device.adopt(claimed);
    clock += TTL + 1;

    await supervisor.runOnce();

    // The renewal at the top of the tick refuses, so the sweep a line
    // below it finds the row and says so. Waking up is not the same as
    // never having stopped, and the difference is a comment.
    expect(bodies().join("\n")).toContain(LOCAL_DEVICE_ID);
    expect(leaseFor(handle.db, item.id)?.grantedAt).not.toBe(claimed.grantedAt);
  });


  it("are taken for the dispatch and given back when it ends", async () => {
    const supervisor = supervisorWith();

    await supervisor.runOnce();

    // Nothing left holding the item, and the run it covered did its
    // work: a lease is a claim on the present, and what happened is the
    // run, the transition and the comments.
    expect(listLeases(handle.db)).toEqual([]);
    expect(listRunsForItem(handle.db, item.id).map((run) => run.status)).toEqual(["succeeded"]);
  });

  it("survive a pause and a resume while the dispatch they cover is still going", async () => {
    // Long enough that the pause below lands mid-run rather than after
    // it: this is about a claim that is covering work right now.
    const supervisor = supervisorWith({
      provider: createFakeProvider({ steps: [{ sleepMs: 150, output: "working" }], result: validImplementResult }),
    });

    const dispatching = supervisor.runOnce();
    await until(() => leaseFor(handle.db, item.id) !== null, "the dispatch to claim the item");

    // A person pauses while an agent is working. `pause()` deliberately
    // leaves a run in flight alone, and `resume()` reconciles — which
    // is how a boot-time hand-back of stale claims reached a live one.
    supervisor.pause();
    supervisor.resume();
    // Awaited rather than assumed: `resume()` fires the pass with
    // `void`, and `reconcile()` joins the one already running rather
    // than starting a second. Without this the assertions below could
    // pass by arriving before the reconciliation they are about.
    await supervisor.reconcile();

    // Still this device's, and still refused to anybody else: another
    // machine starting the same item underneath a live run is the one
    // thing the claim exists to prevent.
    expect(leaseFor(handle.db, item.id)?.deviceId).toBe(LOCAL_DEVICE_ID);
    expect(grantLease(handle.db, { itemId: item.id, deviceId: "anna-laptop", now: clock, ttlMs: TTL })).toBeNull();

    await dispatching;
    // And given back the moment the dispatch it covered ends, as ever.
    expect(leaseFor(handle.db, item.id)).toBeNull();
  });

  it("are handed back at boot, because whatever they covered is over", async () => {
    // What a crash leaves behind: a row claiming this machine is
    // working on the item, taken by a process that no longer exists.
    grantLease(handle.db, { itemId: item.id, deviceId: LOCAL_DEVICE_ID, now: clock, ttlMs: TTL });
    const supervisor = supervisorWith();

    await supervisor.reconcile();

    // Given back at once rather than waited out: this device knows what
    // the expiry sweep would take the lease's whole term to infer.
    expect(leaseFor(handle.db, item.id)).toBeNull();
  });
});

describe("the move at the end of a run", () => {
  it("is a command the record applies, and the item lands where the pipeline says", async () => {
    const supervisor = supervisorWith();

    await supervisor.runOnce();

    // Unchanged for a desktop user, which is the point: the supervisor
    // no longer writes `items.stepId` itself, and nothing about where
    // the item ends up is different for it.
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
    expect(listTransitionsForItem(handle.db, item.id).at(-1)).toMatchObject({
      toStepId: "review",
      actor: implementer.id,
      reason: "run succeeded",
    });
  });
});

describe("a dispatch the record never offered", () => {
  it("claims nothing, because a mention and a reply are not the scheduler's", async () => {
    // A run already going holds the item through the item lock, not
    // through a lease: the lease covers the span the record handed out,
    // and a person's reply is neither offered nor claimable.
    createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "running" });
    const supervisor = supervisorWith();

    await supervisor.runOnce();

    expect(listLeases(handle.db)).toEqual([]);
  });
});

/**
 * A process that is the record and nobody's machine (EO-324,
 * the original design: "work runs on the person's
 * machine. The server never needs the person's disk").
 *
 * A server runs this same supervisor — that is phase 7a's whole claim,
 * that neither half knows which machine it is on — and what it must
 * *not* do is act as a device. It has no backend signed in, no
 * worktrees and no person's files, and its record is in the same
 * process and answers with no network in the way. A device loop here
 * would win every lease and then refuse it at preflight, on a loop,
 * while the desktops that could do the work were never offered it.
 *
 * `dispatches: false` is `platform.hasMachine` in production.
 */
describe("a supervisor that is the record and not a device", () => {
  it("claims nothing and runs nothing, however dispatchable the board is", async () => {
    const supervisor = supervisorWith({ dispatches: false });

    await supervisor.runOnce();

    // The item is sitting on `todo` with an implementer to staff it; a
    // desktop would have claimed and run it on this very tick.
    expect(listLeases(handle.db)).toEqual([]);
    expect(listRunsForItem(handle.db, item.id)).toEqual([]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  it("still offers that work to a device that asks", async () => {
    const supervisor = supervisorWith({ dispatches: false });

    // Which is the whole point of it being here: `record:work` is served
    // through this door, so the record schedules with the same guards
    // and caps a dispatch of its own would have had.
    const offers = await supervisor.offerWork("anna-laptop", 1);

    expect(offers.map((offer) => offer.dispatch.item.id)).toEqual([item.id]);
    expect(leaseFor(handle.db, item.id)?.deviceId).toBe("anna-laptop");
  });

  it("still sweeps a claim nobody renewed, and says so", async () => {
    // The housekeeping is the record's and happens whether or not this
    // process would have run the work. A server whose desktops are all
    // asleep must still release a lease whose machine went quiet, or
    // the item stops being offered to anybody and nothing says why
    // (invariant #8).
    const supervisor = supervisorWith({ dispatches: false });
    record.grantLease({ itemId: item.id, deviceId: "anna-laptop" });
    clock += TTL + 1;

    await supervisor.runOnce();

    expect(listLeases(handle.db)).toEqual([]);
    expect(bodies().join("\n")).toContain("anna-laptop");
  });
});

/**
 * A server's own device role (EO-330,
 * `ARCHITECTURE.md`, "Where a job runs").
 *
 * The paragraph above this one was the whole answer until placement:
 * the server was the record and nobody's machine, and a device loop on
 * it would have won every lease and refused it at preflight. What
 * changed is not the flag but *what the record offers it* — a job a
 * person deliberately put on the organisation server, and nothing else.
 * So the server runs a device loop now, scoped by `runsWhere`, and
 * these are the two halves of that scope.
 *
 * `dispatches: false` above is still a real configuration and still
 * tested: a process that is the record and no kind of device at all.
 */
describe("a supervisor that is a server", () => {
  /** An item a job placed at `runsOn` filed, on the step the fixture's own item sits on. */
  function filedBy(runsOn: "device" | "server"): Item {
    const created = createJob(handle.db, {
      projectId: null,
      name: `A ${runsOn} job`,
      trigger: { kind: "manual" },
      pipelineId: "default",
      template: { type: "developer:story", title: "Monday report", body: null },
      runsOn,
    });
    if (!created.ok) throw new Error(created.problem);
    // Stamped by hand rather than fired, so the item lands on the step
    // this file's fixture uses and the dispatch under test is the one
    // every other test here drives. What placement turns on is the
    // occurrence's join back to the job, and that is written either way.
    const filed = createTestItem(handle.db, { type: "story", title: `Filed by a ${runsOn} job`, stepId: "todo" });
    recordOccurrence(handle.db, {
      jobId: created.job.id as Uuid,
      dueAt: clock,
      status: "fired",
      firedAt: clock,
      itemId: filed.id as Uuid,
    });
    return filed;
  }

  it("runs the work a person put on it, and leaves the desktops' alone", async () => {
    const mine = filedBy("server");
    const hers = filedBy("device");
    const supervisor = supervisorWith({ runsWhere: "server" });

    await supervisor.runOnce();

    expect(listRunsForItem(handle.db, mine.id).map((run) => run.status)).toEqual(["succeeded"]);
    // The fixture's own item and the desktop job's, both untouched:
    // they need somebody's login and somebody's disk, and this process
    // has neither.
    expect(listRunsForItem(handle.db, hers.id)).toEqual([]);
    expect(listRunsForItem(handle.db, item.id)).toEqual([]);
  });

  it("answers a desktop asking for work about the desktop, never about itself", async () => {
    const mine = filedBy("server");
    const supervisor = supervisorWith({ runsWhere: "server" });

    // `record:work` comes through this door, and the machine asking is
    // Anna's laptop. Answering with its own placement would hand a
    // desktop the work a person deliberately put on the server.
    const offers = await supervisor.offerWork("anna-laptop", 2);

    expect(offers.map((offer) => offer.dispatch.item.id)).toContain(item.id);
    expect(offers.map((offer) => offer.dispatch.item.id)).not.toContain(mine.id);
  });
});
