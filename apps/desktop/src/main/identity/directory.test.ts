import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcceptInvitationRequestSchema, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { deviceByTokenHash, listDevices, revokeDevice } from "../db/repos/devicesRepo.js";
import { findPersonByEmail, getPerson, listPeople } from "../db/repos/peopleRepo.js";
import { acceptInvitation, invitePerson, signIn } from "./directory.js";
import { hashSecret, INVITATION_LIFETIME_MS } from "./secrets.js";

/**
 * The front door, end to end (EO-323, `ARCHITECTURE.md`, "Identity", the
 * story's first acceptance criterion).
 *
 * "An invited person accepts, signs in from a desktop, and appears with
 * a device in the admin's list; revoking the device makes its next
 * request fail with 401." Everything but the 401 is here — that is the
 * server's door, and `server/smoke.test.ts` drives it over a real
 * socket. What this file holds is the record those two ends share.
 */
describe("the organisation's front door", () => {
  let handle: DbHandle;
  const password = "a memorable passphrase";

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  function invite(email = "anna@example.com"): string {
    const invited = invitePerson(handle.db, { email, name: "Anna Ruiz" });
    if (!invited.ok) throw new Error(invited.problem);
    return invited.value.code;
  }

  it("walks an invitation through to a device in the admin's list", () => {
    const code = invite();

    // Invited, and visibly not yet a colleague: an admin has to be able
    // to tell somebody who joined from somebody who never opened the
    // mail.
    const pending = findPersonByEmail(handle.db, "anna@example.com");
    expect(pending).toMatchObject({ name: "Anna Ruiz", email: "anna@example.com", acceptedAt: null, credentialKind: null });

    const accepted = acceptInvitation(handle.db, { code, password });
    expect(accepted).toMatchObject({ ok: true, value: { email: "anna@example.com", credentialKind: "password" } });
    expect(getPerson(handle.db, pending?.id as Uuid)).toMatchObject({ credentialKind: "password" });

    const session = signIn(handle.db, { email: "anna@example.com", password, deviceName: "anna-macbook", runsWork: true });
    if (!session.ok) throw new Error(session.problem);

    // The device is in the admin's list, under the name the machine
    // gave, belonging to the person who signed in.
    expect(listDevices(handle.db)).toMatchObject([{ name: "anna-macbook", personName: "Anna Ruiz", revokedAt: null }]);
    // And the token opens the door — which is the whole of what a device
    // token is.
    expect(deviceByTokenHash(handle.db, hashSecret(session.value.token))).toMatchObject({ personName: "Anna Ruiz", isAdmin: false });
  });

  it("stops the token the moment it is revoked, and tells nothing apart from an unknown one", () => {
    const code = invite();
    acceptInvitation(handle.db, { code, password });
    const session = signIn(handle.db, { email: "anna@example.com", password, deviceName: "anna-macbook", runsWork: true });
    if (!session.ok) throw new Error(session.problem);

    revokeDevice(handle.db, session.value.deviceId, 1_700_000_000_000);

    // Undefined, exactly as for a token that was never issued: the door
    // answers one 401 to both, because an answer that varied would be a
    // way to learn which tokens once existed.
    expect(deviceByTokenHash(handle.db, hashSecret(session.value.token))).toBeUndefined();
    // And the row stays, because the list is a record of what has held a
    // key.
    expect(listDevices(handle.db)).toMatchObject([{ name: "anna-macbook", revokedAt: 1_700_000_000_000 }]);
  });

  it("re-issues onto the same row when a machine signs in again, rather than growing the list", () => {
    const code = invite();
    acceptInvitation(handle.db, { code, password });
    const first = signIn(handle.db, { email: "anna@example.com", password, deviceName: "anna-macbook", runsWork: true });
    if (!first.ok) throw new Error(first.problem);
    revokeDevice(handle.db, first.value.deviceId);

    const second = signIn(handle.db, { email: "anna@example.com", password, deviceName: "anna-macbook", runsWork: true, deviceId: first.value.deviceId });
    if (!second.ok) throw new Error(second.problem);

    expect(second.value.deviceId).toBe(first.value.deviceId);
    expect(listDevices(handle.db)).toHaveLength(1);
    // Revoking took the token away, not the machine: signing in again
    // with a password issues a new one and the row works again.
    expect(listDevices(handle.db)[0]?.revokedAt).toBeNull();
    expect(deviceByTokenHash(handle.db, hashSecret(second.value.token))).toBeDefined();
    // And the old token is dead, because the row holds one hash.
    expect(deviceByTokenHash(handle.db, hashSecret(first.value.token))).toBeUndefined();
  });

  it("will not move a device row to somebody else on their say-so", () => {
    acceptInvitation(handle.db, { code: invite(), password });
    acceptInvitation(handle.db, { code: invite("bo@example.com"), password });
    const anna = signIn(handle.db, { email: "anna@example.com", password, deviceName: "anna-macbook", runsWork: true });
    if (!anna.ok) throw new Error(anna.problem);

    const bo = signIn(handle.db, { email: "bo@example.com", password, deviceName: "bo-laptop", runsWork: true, deviceId: anna.value.deviceId });
    if (!bo.ok) throw new Error(bo.problem);

    expect(bo.value.deviceId).not.toBe(anna.value.deviceId);
    expect(listDevices(handle.db)).toHaveLength(2);
    // Anna's token still works: a stranger naming her device id did not
    // take it from her.
    expect(deviceByTokenHash(handle.db, hashSecret(anna.value.token))).toMatchObject({ deviceId: anna.value.deviceId });
  });

  it("uses a code once, and answers one sentence to every link that does not work", () => {
    const code = invite();
    expect(acceptInvitation(handle.db, { code, password }).ok).toBe(true);

    const again = acceptInvitation(handle.db, { code, password });
    const never = acceptInvitation(handle.db, { code: "a-code-nobody-issued", password });

    expect(again.ok).toBe(false);
    expect(never.ok).toBe(false);
    // The same sentence, because "already used", "expired" and "never
    // existed" are one thing from where the person stands — and three
    // sentences would be three ways to learn which codes are real.
    expect(again).toEqual(never);
  });

  it("lets an expired link go, and lets the admin mint a fresh one on the same row", () => {
    const invited = invitePerson(handle.db, { email: "anna@example.com" }, 1_000);
    if (!invited.ok) throw new Error(invited.problem);

    const late = acceptInvitation(handle.db, { code: invited.value.code, password }, 1_000 + INVITATION_LIFETIME_MS + 1);
    expect(late.ok).toBe(false);

    const again = invitePerson(handle.db, { email: "anna@example.com" });
    if (!again.ok) throw new Error(again.problem);
    expect(again.value.person.id).toBe(invited.value.person.id);
    expect(again.value.code).not.toBe(invited.value.code);
    expect(acceptInvitation(handle.db, { code: again.value.code, password }).ok).toBe(true);
    // One person, one row: `idx_people_email` and the re-invitation path
    // agree about that rather than colliding over it.
    expect(listPeople(handle.db).filter((person) => person.email === "anna@example.com")).toHaveLength(1);
    // The dead code stays dead.
    expect(acceptInvitation(handle.db, { code: invited.value.code, password }).ok).toBe(false);
  });

  it("refuses to re-invite somebody who is already here", () => {
    acceptInvitation(handle.db, { code: invite(), password });

    expect(invitePerson(handle.db, { email: "Anna@Example.com" })).toMatchObject({ ok: false, problem: expect.stringContaining("already on") });
  });

  it("treats one mailbox as one person however it is spelled", () => {
    acceptInvitation(handle.db, { code: invite("Anna@Example.com"), password });

    expect(findPersonByEmail(handle.db, "ANNA@example.com")).toBeDefined();
    expect(signIn(handle.db, { email: " Anna@EXAMPLE.com ", password, deviceName: "anna-macbook", runsWork: true }).ok).toBe(true);
  });

  it("records what it actually stored, and cannot be told otherwise", () => {
    // "Record the choice", read as what it has to mean: the column says
    // how this person gets in, and the only way in this version can
    // verify is a password. A caller claiming otherwise — a browser one
    // version ahead, somebody with `curl` — must not be able to write a
    // credential kind EO did not create, because a row saying `passkey`
    // beside a password hash is EO answering its own data's one question
    // wrongly. Zod strips it; this is the assertion that it stays
    // stripped.
    // Parsed through the channel's own schema rather than handed
    // straight to the function, because the stripping is the schema's
    // and a call that skipped it would prove nothing.
    const claimed = AcceptInvitationRequestSchema.parse({ code: invite(), password, credentialKind: "passkey" });
    const accepted = acceptInvitation(handle.db, claimed);

    expect(accepted).toMatchObject({ ok: true, value: { credentialKind: "password" } });
    expect(findPersonByEmail(handle.db, "anna@example.com")?.credentialKind).toBe("password");
    expect(signIn(handle.db, { email: "anna@example.com", password, deviceName: "anna-macbook", runsWork: true }).ok).toBe(true);
  });

  it("answers one sentence to a wrong password and to an address nobody has", () => {
    acceptInvitation(handle.db, { code: invite(), password });

    const wrong = signIn(handle.db, { email: "anna@example.com", password: "not it", deviceName: "anna-macbook", runsWork: true });
    const stranger = signIn(handle.db, { email: "nobody@example.com", password, deviceName: "anna-macbook", runsWork: true });

    expect(wrong.ok).toBe(false);
    expect(stranger.ok).toBe(false);
    // Telling them apart is how an organisation's staff list is
    // enumerated from outside it.
    expect(wrong).toEqual(stranger);
    // And nothing was written for the attempt.
    expect(listDevices(handle.db)).toEqual([]);
  });

  it("will not sign in somebody who has not accepted yet", () => {
    invite();

    expect(signIn(handle.db, { email: "anna@example.com", password, deviceName: "anna-macbook", runsWork: true }).ok).toBe(false);
  });

  it("carries the admin flag onto the person, so the door can read it", () => {
    const invited = invitePerson(handle.db, { email: "dana@example.com", isAdmin: true });
    if (!invited.ok) throw new Error(invited.problem);
    acceptInvitation(handle.db, { code: invited.value.code, password });
    const session = signIn(handle.db, { email: "dana@example.com", password, deviceName: "dana-desktop", runsWork: true });
    if (!session.ok) throw new Error(session.problem);

    expect(session.value.person.isAdmin).toBe(true);
    expect(deviceByTokenHash(handle.db, hashSecret(session.value.token))).toMatchObject({ isAdmin: true });
  });

  it("refuses an address that is not one", () => {
    expect(invitePerson(handle.db, { email: "   " })).toMatchObject({ ok: false });
    expect(invitePerson(handle.db, { email: "anna" })).toMatchObject({ ok: false, problem: expect.stringContaining("not an email address") });
  });
});
