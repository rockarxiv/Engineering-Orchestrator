import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { listPeopleCommand } from "../ipc/identityCommands.js";
import { signInCommand } from "../ipc/sessionCommands.js";
import { NO_POLICY } from "@eo/core";
import { createManagedDirectory } from "./directory.js";
import { createPushClient } from "./pushClient.js";
import { forgetOrganisationState } from "../policy/forget.js";
import { readPolicy, writePolicy } from "../policy/policy.js";
import { listOrganisationSecretNames, storeOrganisationSecret, type OrganisationSecretsOptions } from "../policy/organisationSecrets.js";
import { listSecretNames, storeSecret } from "../modules/secrets.js";
import { markRevoked, readToken, rememberSession, sessionStatus, type SessionStoreOptions } from "./session.js";

/**
 * Meeting a revocation (EO-323, the story's first acceptance criterion).
 *
 * "Revoking the device makes its next request fail with 401 and the
 * desktop shows 'signed out by your organisation'." The first half is
 * the server's and is proved over a real socket in
 * `server/smoke.test.ts`. This is the second half, and specifically the
 * part that is easy to write and easy to get wrong: **a revocation is
 * the one state change nobody asks for.**
 *
 * It is discovered by a request made for some other reason — a picker
 * asking who is on the list — and that request then *succeeds*, because
 * the design says managed mode never stops a person from working and the
 * picker falls back to this machine's own rows. So nothing about the
 * answer says anything happened, and a desktop that only wrote the fact
 * to its database would go on rendering a signed-in session until
 * somebody reloaded the window.
 *
 * What these cases hold is the pairing: the write, and the one
 * announcement that goes with it.
 */
describe("a desktop whose organisation has turned it out", () => {
  let handle: DbHandle;
  let directory: string;
  let session: SessionStoreOptions;

  const keychain = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`sealed:${text}`, "utf8"),
    decryptString: (buffer: Buffer) => buffer.toString("utf8").replace(/^sealed:/, ""),
  };

  const SESSION_BODY = {
    ok: true,
    data: {
      session: {
        token: "a-device-token",
        deviceId: "device-1",
        person: { id: "p1", name: "Anna Ruiz", email: "anna@example.com", isAdmin: false, invitedAt: 1, acceptedAt: 2, credentialKind: "password" },
      },
      problem: null,
    },
  };

  /** What the server answers a revoked device: the door's own sentence, and 401. */
  const REVOKED = new Response(
    JSON.stringify({ ok: false, error: { message: "This EO server did not accept that token. Sign in again, or ask your admin whether this device was revoked." } }),
    { status: 401, headers: { "content-type": "application/json" } },
  );

  beforeEach(async () => {
    handle = openMigratedTestDb();
    directory = mkdtempSync(join(tmpdir(), "eo-managed-"));
    session = { db: handle.db, directory: join(directory, "managed"), store: keychain };

    // Signed in first, through the real command, so what follows begins
    // where a running desktop begins: a session already recorded and a
    // token already in the keychain.
    const answering = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(SESSION_BODY), { status: 200, headers: { "content-type": "application/json" } })),
    ) as unknown as typeof globalThis.fetch;
    await signInCommand(
      { session, fetch: answering, machineName: () => "anna-macbook" },
      { address: "http://127.0.0.1:8765", email: "anna@example.com", password: "a memorable passphrase" },
    );
    expect(sessionStatus(session).state).toBe("signed-in");
  });

  afterEach(() => {
    handle.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /** A server that has stopped accepting this machine, and counts what it refused. */
  function refusing(): { fetch: typeof globalThis.fetch; calls: () => number } {
    const fetched = vi.fn(() => Promise.resolve(REVOKED.clone()));
    return { fetch: fetched as unknown as typeof globalThis.fetch, calls: () => fetched.mock.calls.length };
  }

  it("says so, and says so once, on the next request it makes for any reason", async () => {
    const server = refusing();
    const announced = vi.fn();
    // The production directory and the production client; only the
    // socket under them is the test's.
    const managed = createManagedDirectory(session, { onRevoked: announced });
    vi.stubGlobal("fetch", server.fetch);

    // An ordinary read, made because a picker was opened — not because
    // anybody asked about the session.
    const listed = await listPeopleCommand(handle.db, { managed });

    // It answered, which is the original design: "managed mode never stops a person
    // from working." Nothing in this result says anything happened.
    expect(listed.fromServer).toBe(false);
    expect(listed.people.map((person) => person.name)).toEqual(["you"]);

    // And yet the desktop now knows, and has said so exactly once.
    expect(sessionStatus(session)).toMatchObject({ state: "revoked", address: "http://127.0.0.1:8765", email: "anna@example.com" });
    expect(announced).toHaveBeenCalledTimes(1);
    // The dead credential is gone rather than presented again.
    expect(readToken(session)).toBeNull();

    // A second read finds no session to build a client for, so it never
    // reaches the socket and never announces the same event twice.
    await listPeopleCommand(handle.db, { managed });
    expect(announced).toHaveBeenCalledTimes(1);
    expect(server.calls()).toBe(1);

    vi.unstubAllGlobals();
  });

  it("announces once when several requests meet the 401 together", async () => {
    // What actually happens when an admin presses Revoke: whatever this
    // desktop had in flight all comes back 401 at once. Five
    // announcements would be five invalidations and, on a noisier
    // surface than this one, five notifications about one event.
    const server = refusing();
    const announced = vi.fn();
    const managed = createManagedDirectory(session, { onRevoked: announced });
    vi.stubGlobal("fetch", server.fetch);

    // Three clients built while the session was still good, as three
    // handlers would have built them a moment before the admin pressed
    // Revoke.
    const clients = [managed.client(), managed.client(), managed.client()].filter((client) => client !== null);
    expect(clients).toHaveLength(3);
    await Promise.all(clients.map((client) => client.request("people:list", undefined)));

    expect(announced).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("is quiet where there is nothing to announce", async () => {
    // A solo desktop has no session, so `client()` is null and no
    // request is ever made through it — a 401 from anywhere else is
    // somebody else's problem and must not produce this sentence.
    const announced = vi.fn();
    const solo = createManagedDirectory({ ...session, directory: join(directory, "nothing-here") }, { onRevoked: announced });

    expect(solo.client()).toBeNull();
    expect(announced).not.toHaveBeenCalled();
  });
});

/**
 * What a revoked desktop stops holding (EO-328, ARCHITECTURE.md, "Secrets", review).
 *
 * An explicit sign-out forgot the organisation's secret values and its
 * cached policy; a revocation — the admin pressing Revoke, learned by
 * whichever request next met a 401 — announced itself and forgot
 * neither. So a turned-out desktop went on injecting somebody else's
 * credentials into every module it ran for the projects it still
 * schedules, and went on enforcing an allowed-backends list from a
 * record it no longer belongs to.
 *
 * The two events are the same event from this machine's point of view,
 * and `forgetOrganisationState` is the one function both reach. What
 * these cases hold is that each of the two seams that can *learn* a
 * revocation reaches it: the ordinary request client, and the push
 * stream — a device can be turned out while it is holding a stream open
 * and making no requests at all.
 */
describe("what a revoked desktop forgets", () => {
  let handle: DbHandle;
  let directory: string;
  let session: SessionStoreOptions;
  let secrets: OrganisationSecretsOptions;

  const keychain = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`sealed:${text}`, "utf8"),
    decryptString: (buffer: Buffer) => buffer.toString("utf8").replace(/^sealed:/, ""),
  };

  const REVOKED = new Response(JSON.stringify({ ok: false, error: { message: "This EO server did not accept that token." } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

  /** A desktop mid-life: signed in, on a published policy, holding the values behind it. */
  beforeEach(() => {
    handle = openMigratedTestDb();
    directory = mkdtempSync(join(tmpdir(), "eo-revoked-"));
    session = { db: handle.db, directory: join(directory, "managed"), store: keychain };
    secrets = { directory: join(directory, "organisation-secrets"), store: keychain };

    rememberSession(session, {
      address: "https://eo.example.com",
      email: "anna@example.com",
      token: "a-device-token",
      secretsKey: "a-secrets-key",
      personId: "p1",
      personName: "Anna",
      isAdmin: false,
      deviceId: "device-1",
      deviceName: "anna-macbook",
    });
    writePolicy(handle.db, { ...NO_POLICY, allowedBackends: ["claude"], secretNames: ["FLY_API_TOKEN"], publishedAt: 1 });
    expect(storeOrganisationSecret(secrets, "FLY_API_TOKEN", "tok-1").ok).toBe(true);
    // A secret of the person's own, which must survive: "your sign-ins,
    // local folders and personal secrets are yours" (the design's lock text).
    expect(storeSecret({ directory: join(directory, "module-secrets"), store: keychain }, "FLY_API_TOKEN", "mine").ok).toBe(true);
  });

  afterEach(() => {
    handle.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /** What `startMain` composes: forget what the organisation gave, then announce. */
  function turnedOut(announce: () => void): () => void {
    return () => {
      forgetOrganisationState(handle.db, secrets);
      announce();
    };
  }

  function stillHeld() {
    return {
      policy: readPolicy(handle.db).allowedBackends,
      organisation: listOrganisationSecretNames(secrets),
      mine: listSecretNames({ directory: join(directory, "module-secrets"), store: keychain }),
    };
  }

  it("forgets the organisation's policy and secrets, and keeps the person's own", () => {
    expect(stillHeld()).toEqual({ policy: ["claude"], organisation: ["FLY_API_TOKEN"], mine: ["FLY_API_TOKEN"] });

    forgetOrganisationState(handle.db, secrets);

    expect(stillHeld()).toEqual({ policy: null, organisation: [], mine: ["FLY_API_TOKEN"] });
  });

  it("does it on the ordinary request path, where most revocations are met", async () => {
    const announced = vi.fn();
    const managed = createManagedDirectory(session, { onRevoked: turnedOut(announced) });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(REVOKED.clone())));

    // A read made for some other reason entirely — a picker opening.
    await managed.client()?.request("people:list", undefined);

    expect(announced).toHaveBeenCalledTimes(1);
    expect(sessionStatus(session).state).toBe("revoked");
    expect(stillHeld()).toEqual({ policy: null, organisation: [], mine: ["FLY_API_TOKEN"] });
  });

  it("does it on the push path too, where a device making no requests is turned out", async () => {
    // The seam that matters for a laptop sitting idle with a stream
    // open: it makes no requests, so the ordinary path above never
    // fires, and the 401 arrives on the stream instead.
    const announced = vi.fn();
    const forget = turnedOut(announced);
    const client = createPushClient({
      session: () => ({ address: "https://eo.example.com", token: "a-device-token" }),
      onChanged: () => Promise.resolve(),
      onSignedOut: () => {
        if (markRevoked(session)) forget();
      },
      fetch: vi.fn(() => Promise.resolve(REVOKED.clone())) as unknown as typeof globalThis.fetch,
      firstRetryMs: 5,
      maxRetryMs: 5,
    });

    await vi.waitFor(() => expect(announced).toHaveBeenCalled());
    client.stop();

    expect(sessionStatus(session).state).toBe("revoked");
    expect(stillHeld()).toEqual({ policy: null, organisation: [], mine: ["FLY_API_TOKEN"] });
  });
});
