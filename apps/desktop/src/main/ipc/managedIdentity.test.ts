import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verificationLine, type IpcChannel, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { listDevices } from "../db/repos/devicesRepo.js";
import { listGroups } from "../db/repos/groupsRepo.js";
import { listPeople } from "../db/repos/peopleRepo.js";
import { createStep } from "../db/repos/pipelineStepsRepo.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { transitionItem } from "../db/repos/transitionsRepo.js";
import { createManagedDirectory } from "../managed/directory.js";
import type { SessionStoreOptions } from "../managed/session.js";
import { listItemSummaries, listPipelineStepViews } from "./domainQueries.js";
import {
  deleteGroupCommand,
  invitePersonCommand,
  listDevicesCommand,
  listPeopleCommand,
  revokeDeviceCommand,
  saveGroupCommand,
  setAdminCommand,
  setStepOwnerCommand,
} from "./identityCommands.js";
import { signInCommand } from "./sessionCommands.js";

/**
 * A desktop signed in to an organisation (EO-323,
 * `ARCHITECTURE.md`, "Identity").
 *
 * **The bug this file exists for.** The picker on a column head was fed
 * from the server's people list while every write went to this machine's
 * SQLite, so the names a person was offered were names their own
 * installation could not resolve: choosing "Support team" sent a server
 * uuid to a handler that looked it up in a local table, found nothing,
 * and refused — with the screen showing no sign of it. The admin's
 * Devices panel was the same split seen from the other side: it listed a
 * desktop's own `devices` table, which is empty and always will be.
 *
 * So the rule the design already states is the one these cases hold to: **the
 * record owns the list, and a desktop's action on it is a command the
 * record applies.** Every directory and device action goes to the
 * server. `steps:setOwner` is the exception and is tested as one — a
 * step is not on the record until pipelines are published (7c), so it
 * stays here and the name it needs comes with it.
 *
 * Everything below runs against a *real* `ManagedDirectory` over a real
 * `signInCommand`, with only the socket faked, because what was wrong
 * was the wiring rather than any one function.
 */
describe("a desktop signed in to an organisation", () => {
  let handle: DbHandle;
  let directory: string;
  let session: SessionStoreOptions;
  /** Every channel the organisation's server was actually asked for. */
  let asked: { channel: string; payload: unknown }[];

  const keychain = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`sealed:${text}`, "utf8"),
    decryptString: (buffer: Buffer) => buffer.toString("utf8").replace(/^sealed:/, ""),
  };

  /** Dana, an admin, on the organisation's list — and a team of hers. */
  const DANA = { id: "01a0b000-0000-7000-8000-00000000da4a", name: "Dana Okafor", email: "dana@example.com", isAdmin: true, invitedAt: 1, acceptedAt: 2, credentialKind: "password" as const };
  const SUPPORT = { id: "01a0b000-0000-7000-8000-000000005e11", name: "Support team", memberIds: [DANA.id] };
  const DEVICE = {
    id: "01a0b000-0000-7000-8000-0000000debbb",
    personId: DANA.id,
    personName: "Dana Okafor",
    name: "dana-desktop",
    createdAt: 5,
    lastSeenAt: 6,
    revokedAt: null,
  };

  /**
   * The organisation's server, as far as this desktop can tell.
   *
   * Answers per channel, and records what it was asked — which is half
   * of what these cases assert: a write that never left the machine is
   * exactly the failure being tested for.
   */
  function organisation(answers: Partial<Record<IpcChannel, unknown>> = {}): typeof globalThis.fetch {
    return vi.fn((input: unknown, init: { body?: string } = {}) => {
      const channel = decodeURIComponent(String(input).split("/ipc/")[1] ?? "");
      const payload = (JSON.parse(init.body ?? "{}") as { payload?: unknown }).payload;
      asked.push({ channel, payload });

      const body =
        channel in answers
          ? answers[channel as IpcChannel]
          : channel === "people:list"
            ? { people: [DANA], groups: [SUPPORT], fromServer: true }
            : {};
      return Promise.resolve(new Response(JSON.stringify({ ok: true, data: body }), { status: 200, headers: { "content-type": "application/json" } }));
    }) as unknown as typeof globalThis.fetch;
  }

  beforeEach(async () => {
    handle = openMigratedTestDb();
    directory = mkdtempSync(join(tmpdir(), "eo-managed-identity-"));
    session = { db: handle.db, directory: join(directory, "managed"), store: keychain };
    asked = [];

    const signingIn = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, data: { session: { token: "a-device-token", deviceId: DEVICE.id, person: DANA }, problem: null } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    ) as unknown as typeof globalThis.fetch;
    await signInCommand(
      { session, fetch: signingIn, machineName: () => "dana-desktop" },
      { address: "http://127.0.0.1:8765", email: "dana@example.com", password: "a memorable passphrase" },
    );
  });

  afterEach(() => {
    handle.close();
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  /** The context a handler is built with on a signed-in desktop. */
  function managed() {
    return { managed: createManagedDirectory(session) };
  }

  /** A human step of the shipped pipeline, which is this machine's own. */
  function humanStep(id = "approve"): string {
    createStep(handle.db, {
      id,
      pipelineId: "default" as Uuid,
      position: 99,
      name: "Approve",
      type: "user",
      results: [{ key: "approved", label: "Approve", tone: "success", requiresComment: false }],
    });
    return id;
  }

  /** The head of one column, as this machine's own board would draw it. */
  function head(stepId: string): string {
    const view = listPipelineStepViews(handle.db, { pipelineId: "default" });
    const step = view.steps.find((candidate) => candidate.id === stepId);
    if (step === undefined) throw new Error(`no step ${stepId} on the board`);
    return verificationLine(step, view.verification);
  }

  it("takes a group the picker offered and puts it on a step, which is what the head then says", async () => {
    // The whole of the reported failure, in one case. The picker is fed
    // from the server…
    vi.stubGlobal("fetch", organisation());
    const offered = await listPeopleCommand(handle.db, managed());
    expect(offered.fromServer).toBe(true);
    expect(offered.groups.map((group) => group.name)).toEqual(["Support team"]);

    // …and choosing what it offered has to work.
    const chosen = offered.groups[0];
    const step = humanStep();
    expect(await setStepOwnerCommand(handle.db, { stepId: step, personId: null, groupId: chosen?.id ?? "" }, managed())).toEqual({ problem: null });

    // The acceptance criterion, on a managed desktop: "a human step
    // assigned to a group shows 'Support team · anyone claims' on the
    // column head."
    expect(head(step)).toBe("Support team · anyone claims");

    // And the name is this machine's now, under the record's own id, so
    // the board still draws it with the server unreachable (ARCHITECTURE.md, "The record") and
    // the two sides already agree about who this is when sync lands.
    expect(listGroups(handle.db)).toMatchObject([{ id: SUPPORT.id, name: "Support team" }]);
    // Its membership is not copied: who is in a team is the
    // organisation's to say, and this machine was never asked.
    expect(listGroups(handle.db)[0]?.memberIds).toEqual([]);
  });

  it("leaves an item arriving at that step for anybody to claim, on a machine that knows one person", async () => {
    // The regression this file's second review round is about, end to
    // end. A signed-in desktop holds one local row — itself — plus the
    // group it adopted when somebody picked it. Every arrival check that
    // read `owner_person_id` alone therefore saw an unowned step on a
    // "solo" machine and handed the item to whoever was sitting there,
    // under a column head saying anybody could take it.
    vi.stubGlobal("fetch", organisation());
    const step = humanStep("triage");
    await setStepOwnerCommand(handle.db, { stepId: step, personId: null, groupId: SUPPORT.id }, managed());
    // The state the bug needed: this machine can name exactly one
    // person, which is what `isSoloMode` answers yes to.
    expect(listPeople(handle.db).map((person) => person.name)).toEqual(["you"]);

    const item = createTestItem(handle.db, { type: "story", title: "Card declined", stepId: "todo" });
    transitionItem(handle.db, { itemId: item.id, toStepId: step, actor: "human" });

    // Unassigned on the record…
    expect(getItem(handle.db, item.id)?.assigneeId).toBeNull();
    // …offered to anybody on the board…
    const card = listItemSummaries(handle.db, null).items.find((summary) => summary.id === item.id);
    expect(card).toMatchObject({ claimable: true, assigneePerson: null });
    // And the head that promised it is still the head.
    expect(head(step)).toBe("Support team · anyone claims");
  });

  it("does the same for an item created straight onto the team's step", async () => {
    vi.stubGlobal("fetch", organisation());
    const step = humanStep("triage");
    await setStepOwnerCommand(handle.db, { stepId: step, personId: null, groupId: SUPPORT.id }, managed());

    const item = createTestItem(handle.db, { type: "story", title: "Card declined", stepId: step });

    expect(getItem(handle.db, item.id)?.assigneeId).toBeNull();
  });

  it("does the same for a person, which a foreign key leaves no choice about", async () => {
    vi.stubGlobal("fetch", organisation());
    const step = humanStep();

    expect(await setStepOwnerCommand(handle.db, { stepId: step, personId: DANA.id, groupId: null }, managed())).toEqual({ problem: null });

    // `pipeline_steps.owner_person_id` references `people(id)`, so this
    // write is impossible without the row — which is why adopting is not
    // a convenience.
    expect(listPeople(handle.db).map((person) => person.id)).toContain(DANA.id);
    expect(head(step)).toBe("Dana Okafor · approves here");
  });

  it("refuses a name that is on neither list, rather than writing a step nothing can resolve", async () => {
    vi.stubGlobal("fetch", organisation());
    const step = humanStep();

    const refused = await setStepOwnerCommand(handle.db, { stepId: step, personId: null, groupId: "01a0b000-0000-7000-8000-00000000fake" }, managed());

    expect(refused.problem).toContain("not on this list");
    expect(listGroups(handle.db)).toEqual([]);
  });

  it("will not point a step at the organisation's team while this machine has its own of that name", async () => {
    // Rare and real: a group made in solo mode, then a sign-in to an
    // organisation that happens to use the same word. Reconciling them
    // silently would be a column head telling the truth about a
    // different set of people.
    await saveGroupCommand(handle.db, { name: "Support team", memberIds: [] });
    vi.stubGlobal("fetch", organisation());
    const step = humanStep();

    const refused = await setStepOwnerCommand(handle.db, { stepId: step, personId: null, groupId: SUPPORT.id }, managed());

    expect(refused.problem).toContain("already has its own group");
    expect(head(step)).toBe("You approve here");
  });

  it("invites through the organisation rather than minting a link nobody can accept", async () => {
    vi.stubGlobal(
      "fetch",
      organisation({ "people:invite": { person: DANA, invitePath: "/invite/a-code-the-server-issued", expiresAt: 9, problem: null } }),
    );

    const invited = await invitePersonCommand(handle.db, { email: "bo@example.com", isAdmin: false }, managed());

    expect(invited.invitePath).toBe("/invite/a-code-the-server-issued");
    expect(asked).toMatchObject([{ channel: "people:invite", payload: { email: "bo@example.com" } }]);
    // Nothing was written here. A code this machine invented is a code
    // the server would refuse, and the link an admin copies has to be one
    // their colleague can actually follow.
    expect(listPeople(handle.db).map((person) => person.name)).toEqual(["you"]);
  });

  it("lists and revokes the organisation's devices, not this laptop's empty table", async () => {
    vi.stubGlobal(
      "fetch",
      organisation({ "devices:list": { devices: [DEVICE], problem: null }, "devices:revoke": { device: { ...DEVICE, revokedAt: 11 }, problem: null } }),
    );

    const listed = await listDevicesCommand(handle.db, managed());
    expect(listed.devices).toMatchObject([{ name: "dana-desktop", personName: "Dana Okafor" }]);

    const revoked = await revokeDeviceCommand(handle.db, { deviceId: DEVICE.id }, managed());
    expect(revoked.device).toMatchObject({ revokedAt: 11 });
    expect(asked.map((call) => call.channel)).toEqual(["devices:list", "devices:revoke"]);
    // Nothing signs in to a laptop, so its own table stayed as it was.
    expect(listDevices(handle.db)).toEqual([]);
  });

  it("edits groups and admin flags on the record, and says what the record said when it refuses", async () => {
    vi.stubGlobal(
      "fetch",
      organisation({
        "groups:save": { group: { ...SUPPORT, name: "Support" }, problem: null },
        "groups:delete": { deleted: true, problem: null },
        "people:setAdmin": { person: { ...DANA, isAdmin: false }, problem: null },
      }),
    );

    expect((await saveGroupCommand(handle.db, { id: SUPPORT.id, name: "Support", memberIds: [DANA.id] }, managed())).group).toMatchObject({ name: "Support" });
    expect(await deleteGroupCommand(handle.db, { groupId: SUPPORT.id }, managed())).toEqual({ deleted: true, problem: null });
    expect((await setAdminCommand(handle.db, { personId: DANA.id, isAdmin: false }, managed())).person).toMatchObject({ isAdmin: false });

    expect(asked.map((call) => call.channel)).toEqual(["groups:save", "groups:delete", "people:setAdmin"]);
    // Every one of them landed on the organisation's tables and none on
    // this machine's, which is the whole point: a group somebody edits on
    // their laptop is a group their colleagues see.
    expect(listGroups(handle.db)).toEqual([]);
  });

  it("tells a name it could not look up from a name that is not there", async () => {
    // Two different sentences about a colleague, told to somebody who
    // has just picked one off a list. "There is no such person" about
    // somebody who exists is the worse of the two.
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("connection refused"))) as unknown as typeof globalThis.fetch);
    const step = humanStep();

    const unreachable = await setStepOwnerCommand(handle.db, { stepId: step, personId: null, groupId: SUPPORT.id }, managed());
    expect(unreachable.problem).toContain("could not reach your organisation");

    vi.stubGlobal("fetch", organisation());
    const missing = await setStepOwnerCommand(handle.db, { stepId: step, personId: null, groupId: "01a0b000-0000-7000-8000-00000000fake" }, managed());
    expect(missing.problem).toContain("not on this list");
  });

  it("says a server it could not reach could not be reached, rather than answering for it", async () => {
    // The other half of routing a write: it must not silently become a
    // local one. A person told their group was saved, whose organisation
    // never heard of it, is worse off than one told it failed.
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("connection refused"))) as unknown as typeof globalThis.fetch);

    const saved = await saveGroupCommand(handle.db, { name: "Support team", memberIds: [] }, managed());
    const devices = await listDevicesCommand(handle.db, managed());

    expect(saved.group).toBeNull();
    expect(saved.problem).toContain("could not reach");
    expect(listGroups(handle.db)).toEqual([]);
    // And an empty Devices list is never invented: "nobody has signed in"
    // is a sentence about the organisation, and this machine could not
    // ask it.
    expect(devices).toMatchObject({ devices: [], problem: expect.stringContaining("could not reach") });
  });
});
