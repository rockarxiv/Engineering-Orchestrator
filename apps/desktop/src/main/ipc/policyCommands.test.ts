import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_POLICY, type IpcChannel, type IpcResult, type OrganisationPolicy, type PersonBudget, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listAgents } from "../db/repos/agentsRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { createProject, markProjectOnTheRecord } from "../db/repos/projectsRepo.js";
import { createRun, updateRun } from "../db/repos/runsRepo.js";
import { setSetting } from "../db/repos/settingsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { MANAGED_PERSON_ID_KEY } from "../identity/viewer.js";
import type { ManagedDirectory } from "../managed/directory.js";
import type { ServerClient } from "../managed/serverClient.js";
import { writePolicy } from "../policy/policy.js";
import { getPolicyCommand, type PolicyContext } from "./policyCommands.js";

/**
 * What the top bar is told about a person's day (EO-328,
 * `ARCHITECTURE.md`, "Policy", review).
 *
 * The design's ceiling is **per person**, and a person has more than one
 * machine — so the line beside the board has to read what the dispatch
 * guard reads. This used to compute it from local rows alone while
 * *fetching* and discarding the record's answer, which produced exactly
 * the disagreement the arrangement exists to prevent: Anna spends her
 * day on desktop A, desktop B correctly parks her next item, and desktop
 * B's top bar says "your budget: $0 of $10 today" until replication
 * catches up.
 *
 * The two-desktop case is the whole subject here. `policyGuards.test.ts`
 * is the same fact from the guard's side, and both meet on
 * `personBudgetAcross`, which is core's — so neither end spells the rule
 * and they cannot drift.
 */

const DAY = Date.now();

let handle: DbHandle;
let directory: string;
let secrets: { directory: string; store: { isEncryptionAvailable: () => boolean; encryptString: (text: string) => Buffer; decryptString: (buffer: Buffer) => string } };

const reverse = (text: string) => [...text].reverse().join("");

beforeEach(() => {
  handle = openMigratedTestDb();
  directory = mkdtempSync(join(tmpdir(), "eo policy commands "));
  secrets = {
    directory,
    store: {
      isEncryptionAvailable: () => true,
      encryptString: (text: string) => Buffer.from(reverse(text)),
      decryptString: (buffer: Buffer) => reverse(buffer.toString()),
    },
  };
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

/**
 * This desktop, signed in as Anna, holding one of her projects.
 *
 * Which is what makes the item's owner resolvable and the ceiling
 * applicable: a project nobody on the record owns has no organisation
 * budget to be under.
 */
function annasDesktop(): { projectId: Uuid; personId: Uuid } {
  const anna = createPerson(handle.db, { name: "Anna", email: "anna@example.com" });
  setSetting(handle.db, MANAGED_PERSON_ID_KEY, anna.id);
  const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
  markProjectOnTheRecord(handle.db, project.id, anna.id);
  return { projectId: project.id, personId: anna.id };
}

/** A run that cost money on this machine and has not been shipped to the record yet. */
function spentHere(projectId: Uuid, costCents: number): void {
  const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", projectId });
  const run = createRun(handle.db, { itemId: item.id, agentId: listAgents(handle.db)[0]!.id, action: "implement" });
  updateRun(handle.db, run.id, { status: "succeeded", costCents, startedAt: DAY });
}

/**
 * An organisation whose record answers `policy:get` with this.
 *
 * `yours` is the record-wide figure: every device's runs, which on the
 * real thing is what `personBudgetFor` computes on the server's own
 * database out of the acting device the door stamped.
 */
function organisation(policy: OrganisationPolicy, yours: PersonBudget | null, asked: string[] = []): PolicyContext {
  const client: ServerClient = {
    address: "https://eo.example.com",
    request: <K extends IpcChannel>(channel: K): Promise<IpcResult<unknown>> => {
      asked.push(channel);
      return Promise.resolve(
        channel === "policy:get"
          ? { ok: true, data: { policy, fromServer: true, yours } }
          : { ok: false, error: { message: `unexpected ${channel}` } },
      ) as Promise<IpcResult<never>>;
    },
  } as unknown as ServerClient;
  const managed: ManagedDirectory = { client: () => client };
  return { managed, secrets };
}

/** An organisation whose record cannot be reached. */
function offline(): PolicyContext {
  const client = {
    address: "https://eo.example.com",
    request: () => Promise.resolve({ ok: false, error: { message: "offline" } }),
  } as unknown as ServerClient;
  return { managed: { client: () => client }, secrets };
}

const CEILING: OrganisationPolicy = { ...NO_POLICY, perPersonDailyBudgetCents: 1_000, publishedAt: 1 };

describe("the budget line a managed desktop draws", () => {
  it("reads the record's figure, which its own replica has never heard of", async () => {
    // The regression. Anna spent her whole day on her *other* desktop;
    // this one has no runs at all. A line computed from local rows would
    // say nought while the guard beside it refused her work.
    annasDesktop();
    const asked: string[] = [];

    const answer = await getPolicyCommand(handle.db, organisation(CEILING, { spentCents: 1_000, budgetCents: 1_000 }, asked));

    expect(asked).toContain("policy:get");
    expect(answer.fromServer).toBe(true);
    expect(answer.yours).toEqual({ spentCents: 1_000, budgetCents: 1_000 });
  });

  it("keeps a run of its own the record has not been told about yet", async () => {
    // The other direction, and the reason this is a combination rather
    // than a hand-over: results ship on the tick, so the record is
    // always a moment behind whatever this machine just finished.
    const { projectId } = annasDesktop();
    spentHere(projectId, 700);

    const answer = await getPolicyCommand(handle.db, organisation(CEILING, { spentCents: 300, budgetCents: 1_000 }));

    expect(answer.yours).toEqual({ spentCents: 700, budgetCents: 1_000 });
  });

  it("takes the larger of the two, because each is short in a different way", async () => {
    const { projectId } = annasDesktop();
    spentHere(projectId, 250);

    const answer = await getPolicyCommand(handle.db, organisation(CEILING, { spentCents: 900, budgetCents: 1_000 }));

    // Not the sum: the record may already have been told about this
    // machine's 250, and adding it twice would refuse work that is
    // within the ceiling. The larger reading is the closest honest one.
    expect(answer.yours).toEqual({ spentCents: 900, budgetCents: 1_000 });
  });

  it("falls back to its own rows when the record cannot be reached", async () => {
    // ARCHITECTURE.md, "The record": managed mode never stops a person from working. A ceiling
    // nobody can verify leaves the replica's lower figure standing.
    const { projectId } = annasDesktop();
    writePolicy(handle.db, CEILING);
    spentHere(projectId, 400);

    const answer = await getPolicyCommand(handle.db, offline());

    expect(answer.fromServer).toBe(false);
    expect(answer.yours).toEqual({ spentCents: 400, budgetCents: 1_000 });
  });

  it("says nothing where the organisation publishes no ceiling", async () => {
    const { projectId } = annasDesktop();
    spentHere(projectId, 400);

    const answer = await getPolicyCommand(handle.db, organisation(NO_POLICY, null));

    expect(answer.yours).toBeNull();
  });

  it("says nothing at all on a desktop with no organisation", async () => {
    // A solo installation: no record to ask and no policy to have a
    // ceiling in. Every screen reads this as "there is no line".
    const answer = await getPolicyCommand(handle.db, { secrets });

    expect(answer.fromServer).toBe(false);
    expect(answer.yours).toBeNull();
    expect(answer.policy).toEqual(NO_POLICY);
  });
});
