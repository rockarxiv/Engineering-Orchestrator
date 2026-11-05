import { rmSync } from "node:fs";
import { ipcContract, ORGANISATION_SECRETS_PATH, PUSH_STREAM_PATH, type IpcChannel } from "@eo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { environmentFor, storeSecret } from "../modules/secrets.js";
import { clearHandlerRegistry, dispatchIpc } from "../ipc/registry.js";
import { fakePlatform } from "../testing/platform.js";
import type { Platform } from "../ipc/platform.js";
import { readOrganisationSecretEntry } from "./organisationSecrets.js";
import { readPolicy } from "./policy.js";

/**
 * The story's third acceptance criterion, kept (EO-328,
 * the original design):
 *
 *   *"An organisation secret reaches a module's environment on a device
 *   and is never returned by any query the renderer can make; a test
 *   asserts the value does not appear in any IPC response."*
 *
 * Both halves are here, because they are one claim: the value is
 * genuinely in the hands of the thing that spawns a process, and
 * genuinely absent from everything a screen can ask.
 *
 * The "or an MCP header" half of the design — the same value expanding a
 * generated `${VAR}` — is `agentAttachments/serverEnvironment.test.ts`,
 * which has a real attached server to walk and is where the precedence
 * between an organisation's value and the person's is argued.
 *
 * ## Why the second half is a sweep and not a spot check
 *
 * A test that asked `policy:get` and `moduleSecrets:list` would prove
 * those two channels are careful today. What is actually being claimed
 * is a property of the *transport*: the values are delivered over
 * `ORGANISATION_SECRETS_PATH`, which is not in the contract at all, so
 * there is no channel shaped to carry one — and the way to keep that
 * true as channels are added is to walk the whole contract rather than a
 * list somebody maintains.
 *
 * The sweep cannot call every channel: most take an id of a row this
 * database has not got, and inventing one would be testing a refusal
 * rather than an answer. So it calls every channel it can synthesise a
 * payload for, and separately insists that the channels where a leak
 * would actually be plausible — the ones that list secrets, servers,
 * modules, agents and the policy itself — were among them. That second
 * assertion is what stops the sweep quietly degrading into nothing.
 *
 * ## What this is *not* claiming
 *
 * Not that the value is unrecoverable on the machine. The design is careful
 * and so is this: a module receives it as an environment variable and an
 * agent with a shell reads its own environment. `ORGANISATION_SECRET_LINE`
 * says "not shown here" rather than "never readable" for exactly that
 * reason, and the first half of this file is the evidence that it does
 * reach a process.
 */

const SECRET = "org-secret-value-eo328";
/** The same name, with a different value, set as a *personal* secret. */
const PERSONAL = "personal-secret-value-eo328";
const NAME = "FLY_API_TOKEN";

let handle: DbHandle;
let platform: Platform;
let organisationSecrets: { directory: string; store: Platform["keychain"] };
let moduleSecrets: { directory: string; store: Platform["keychain"] };

beforeAll(async () => {
  handle = openMigratedTestDb();
  // The shared fake machine, with a keychain that actually stores
  // something: its default answers `isEncryptionAvailable: false`, and
  // every secret store in EO refuses to write on such a machine — which
  // would make this whole file pass for the wrong reason.
  platform = fakePlatform({
    keychain: {
      isEncryptionAvailable: () => true,
      encryptString: (plainText: string) => Buffer.from([...plainText].reverse().join("")),
      decryptString: (encrypted: Buffer) => [...encrypted.toString()].reverse().join(""),
    },
  });
  organisationSecrets = { directory: `${platform.userDataPath}/organisation-secrets`, store: platform.keychain };
  moduleSecrets = { directory: `${platform.userDataPath}/module-secrets`, store: platform.keychain };

  const { registerAllHandlers } = await import("../ipc/handlers.js");
  registerAllHandlers(handle.db, undefined, { platform });

  // Set the way an admin sets one: through the channel, on a process
  // that is its own record.
  const set = await dispatchIpc("policy:setSecret", { name: NAME, value: SECRET });
  expect(set).toEqual({ ok: true, data: { saved: true, problem: null } });

  // …and a personal one of the same name, which shadows nothing: the two
  // namespaces are distinct, and this is what makes the assertions below
  // about the organisation's value rather than about "no secret leaks".
  expect(storeSecret(moduleSecrets, NAME, PERSONAL).ok).toBe(true);
});

afterAll(() => {
  clearHandlerRegistry();
  handle.close();
  rmSync(platform.userDataPath, { recursive: true, force: true });
});

describe("an organisation secret reaches a run", () => {
  it("is in the environment a module is given", () => {
    const { env, unreadable } = environmentFor(moduleSecrets, [NAME], null, (name) =>
      readOrganisationSecretEntry(organisationSecrets, name),
    );

    expect(unreadable).toEqual([]);
    expect(env[NAME]).toBe(SECRET);
  });

  it("wins over a personal secret of the same name, which is still there", () => {
    // "A personal secret with the same name shadows nothing; the two
    // namespaces are distinct." The organisation's value is what the run
    // gets; the person's is untouched and is still what every name the
    // organisation has not published resolves to.
    expect(environmentFor(moduleSecrets, [NAME], null).env[NAME]).toBe(PERSONAL);
    expect(environmentFor(moduleSecrets, [NAME], null, (name) => readOrganisationSecretEntry(organisationSecrets, name)).env[NAME]).toBe(SECRET);
  });


  it("is published by name, and only by name", () => {
    const policy = readPolicy(handle.db);
    expect(policy.secretNames).toEqual([NAME]);
    expect(JSON.stringify(policy)).not.toContain(SECRET);
  });
});

describe("and is returned by no query the renderer can make", () => {
  /**
   * The payload a channel will accept with nothing to go on, or null.
   *
   * `undefined` first, because that is what a `z.void()` channel wants
   * and what most reads take; then the empty object, which every channel
   * whose fields are optional or defaulted accepts. Anything needing a
   * real id answers null and is counted rather than silently dropped.
   */
  function payloadFor(channel: IpcChannel): { value: unknown } | null {
    const request = ipcContract[channel].request;
    if (request.safeParse(undefined).success) return { value: undefined };
    if (request.safeParse({}).success) return { value: {} };
    return null;
  }

  /**
   * Where a leak would actually be plausible — everything that lists a
   * secret, a server, a module, an agent or the policy itself.
   *
   * Named so the sweep cannot quietly degrade: if one of these stops
   * being callable with an empty payload, this fails rather than the
   * coverage silently shrinking.
   */
  const MUST_BE_EXERCISED: IpcChannel[] = [
    "policy:get",
    "moduleSecrets:list",
    "mcpServers:list",
    "connectors:list",
    "agents:listDetailed",
    "modules:list",
    "settings:get",
    "people:list",
  ];

  it("appears in no response, on any channel that can be asked", async () => {
    const asked: IpcChannel[] = [];
    const skipped: IpcChannel[] = [];

    for (const channel of Object.keys(ipcContract) as IpcChannel[]) {
      const payload = payloadFor(channel);
      if (payload === null) {
        skipped.push(channel);
        continue;
      }
      // Writes are called too, deliberately. A channel that answered
      // with what it had just been given would be exactly the leak this
      // is looking for, and none of them can do harm on a throwaway
      // in-memory database.
      let answer: unknown;
      try {
        answer = await dispatchIpc(channel, payload.value);
      } catch (error) {
        // A handler that threw told us nothing about a secret. The
        // message is checked anyway, since a thrown error is a string
        // that reaches a screen.
        answer = String(error);
      }
      asked.push(channel);
      expect(JSON.stringify(answer) ?? "").not.toContain(SECRET);
    }

    // The sweep is worth something only if it reached the channels where
    // a leak is conceivable.
    expect(MUST_BE_EXERCISED.filter((channel) => !asked.includes(channel))).toEqual([]);
    // …and it should be reaching a substantial part of the contract
    // rather than a handful. Most channels take an id of a row this
    // database has not got — that is what `skipped` is, and it is the
    // larger number honestly: the sweep is a backstop over the reads,
    // not a claim to have exercised the whole contract. A drop below
    // this floor means payload synthesis stopped working rather than
    // that the app got safer.
    expect({ asked: asked.length >= 60, skipped: skipped.length > 0 }).toEqual({ asked: true, skipped: true });
  });

  it("is delivered over a path that is not a channel at all", () => {
    // The structural half, and the reason the sweep above can be
    // expected to keep passing as channels are added: there is no
    // channel shaped to carry one.
    expect(Object.keys(ipcContract)).not.toContain(ORGANISATION_SECRETS_PATH);
    expect(ORGANISATION_SECRETS_PATH.startsWith("/ipc")).toBe(false);
    expect(ORGANISATION_SECRETS_PATH).not.toBe(PUSH_STREAM_PATH);
  });

  it("lists the name where a screen needs it, and nothing else", async () => {
    const answer = await dispatchIpc("moduleSecrets:list", {});
    expect(answer).toMatchObject({ ok: true, data: { organisation: [NAME] } });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    // The personal value of the same name is not on the wire either —
    // this channel has always been names-only, and the organisation's
    // arrival does not change that.
    expect(JSON.stringify(answer)).not.toContain(PERSONAL);
  });
});

/**
 * Reveal (EO-489, ARCHITECTURE.md §14.2): the two channels that *do*
 * return a secret's value, on the desktop, when the person asks.
 *
 * They are not a crack in the claim above, and this is where that is
 * held: neither takes a payload the sweep can synthesise, so they are
 * asked here by name — with the one name that has both an organisation
 * value and a personal one, which is the case where answering with the
 * wrong store would be a leak. Both answer with the person's own value,
 * and never the organisation's.
 */
describe("revealing a personal secret", () => {
  it("answers a module secret with the personal value, never the organisation's", async () => {
    const answer = await dispatchIpc("moduleSecrets:reveal", { name: NAME });

    expect(answer).toEqual({ ok: true, data: { state: "value", value: PERSONAL } });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  it("answers an MCP server secret with the personal value, never the organisation's", async () => {
    const saved = await dispatchIpc("mcpServers:save", { name: "fly", transport: "stdio", command: "fly-mcp", envNames: [NAME] });
    expect(saved).toMatchObject({ ok: true, data: { problem: null } });
    const serverId = z.object({ data: z.object({ server: z.object({ id: z.string() }) }) }).parse(saved).data.server.id;
    expect(await dispatchIpc("mcpServers:setSecret", { serverId, name: NAME, value: PERSONAL })).toMatchObject({ ok: true, data: { saved: true } });

    const answer = await dispatchIpc("mcpServers:revealSecret", { serverId, name: NAME });

    expect(answer).toEqual({ ok: true, data: { state: "value", value: PERSONAL } });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    // And the list beside it is still names only, with the value now on disk.
    expect(JSON.stringify(await dispatchIpc("mcpServers:list", {}))).not.toContain(PERSONAL);
  });

  it("answers a name only the organisation set with nothing at all", async () => {
    const ORGANISATION_ONLY = "ORG_ONLY_TOKEN";
    expect(await dispatchIpc("policy:setSecret", { name: ORGANISATION_ONLY, value: SECRET })).toMatchObject({ ok: true });

    const answer = await dispatchIpc("moduleSecrets:reveal", { name: ORGANISATION_ONLY });

    expect(answer).toEqual({ ok: true, data: { state: "absent" } });
  });
});
