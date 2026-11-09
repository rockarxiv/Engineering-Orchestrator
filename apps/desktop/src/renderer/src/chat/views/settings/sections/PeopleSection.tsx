import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { machineAvailable } from "../../../../ipc/bridge";
import { ipcQuery } from "../../../../query/client";
import { devicesKey, peopleKey, usePeople } from "../../../../query/hooks";
import { useInvalidateOnPush } from "../../../../query/useInvalidateOnPush";
import { lastSeen } from "../../../../shared/settings/people";
import { Button, CardSection, Checkbox, Chip, ErrorLine, Field, Loading, Notice, TextInput } from "../../../kit";

/**
 * Settings → People: the organisation's list, for whoever administers it
 * (EO-323, `ARCHITECTURE.md`, "Identity"), in the chat layout's terms.
 *
 * Three cards in the order an admin meets them — the people, the groups a
 * human step can wait on, and the machines that hold a key. Every channel
 * is in the record half, so the same section works in the browser an
 * admin opened the server's address in and on a desktop.
 *
 * A solo desktop is not shown Invite or Devices: a link minted there
 * points at a server that has never heard of it, and nothing signs in to
 * a laptop. Left out rather than shown doing nothing (invariant #12), with
 * one line saying where signing in is.
 */
export function PeopleSection() {
  const { fromServer } = usePeople();
  // A browser served by an organisation server *is* the record.
  const organisation = !machineAvailable() || fromServer;

  return (
    <>
      <PeoplePanel organisation={organisation} />
      <GroupsPanel />
      {organisation ? <DevicesPanel /> : null}
    </>
  );
}

// ── People ──────────────────────────────────────────────────────────

function PeoplePanel({ organisation }: { organisation: boolean }) {
  const queryClient = useQueryClient();
  const { people, fromServer, isLoading } = usePeople();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [asAdmin, setAsAdmin] = useState(false);

  const invite = useMutation({
    mutationFn: (input: { email: string; name?: string; isAdmin: boolean }) => ipcQuery("people:invite", input),
    onSuccess: (result) => {
      if (result.problem === null) {
        setEmail("");
        setName("");
        setAsAdmin(false);
      }
      void queryClient.invalidateQueries({ queryKey: peopleKey });
    },
  });

  const setAdmin = useMutation({
    mutationFn: (input: { personId: string; isAdmin: boolean }) => ipcQuery("people:setAdmin", input),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: peopleKey }),
  });

  return (
    <CardSection
      title="People"
      description={
        fromServer
          ? "Everybody on your organisation's list. Invite somebody and send them the link."
          : "Everybody this installation knows. Signing in to an organisation server replaces this with its list."
      }
    >
      {!isLoading && people.length === 0 ? <p className="text-[12.5px] text-ink-subtle">Nobody yet.</p> : null}
      {people.length > 0 ? (
        <ul aria-label="People" className="flex min-w-0 flex-col [&>li+li]:border-t [&>li+li]:border-line/60">
          {people.map((person) => (
            <li key={person.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="text-[13px] text-ink">{person.name}</span>
                  {person.isAdmin ? <Chip tone="tag">admin</Chip> : null}
                  {/* An invitation nobody has answered, said plainly. */}
                  {person.invitedAt !== null && person.acceptedAt === null ? <Chip tone="paused">invited</Chip> : null}
                </div>
                <span className="flex min-w-0 flex-wrap gap-x-2 text-[11.5px] text-ink-subtle">
                  {person.email === null ? null : <span className="truncate">{person.email}</span>}
                  {person.acceptedAt !== null && person.credentialKind !== null ? <span>signs in with a {person.credentialKind}</span> : null}
                </span>
              </div>
              <Button size="sm" disabled={setAdmin.isPending} onClick={() => setAdmin.mutate({ personId: person.id, isAdmin: !person.isAdmin })}>
                {person.isAdmin ? "Remove admin" : "Make admin"}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {setAdmin.data?.problem ? <ErrorLine>{setAdmin.data.problem}</ErrorLine> : null}

      {organisation ? (
        <div className="flex min-w-0 flex-wrap items-end gap-2 border-t border-line/60 pt-3">
          <Field label="Email" className="min-w-[12rem] flex-1">
            <TextInput value={email} aria-label="Email" type="email" onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <Field label="Name (optional)" className="min-w-[10rem] flex-1">
            <TextInput value={name} aria-label="Name" onChange={(event) => setName(event.target.value)} />
          </Field>
          <span className="flex h-8 items-center">
            <Checkbox checked={asAdmin} onChange={setAsAdmin} label="Administrator" />
          </span>
          <Button
            variant="primary"
            disabled={email.trim() === "" || invite.isPending}
            onClick={() => invite.mutate({ email: email.trim(), ...(name.trim() === "" ? {} : { name: name.trim() }), isAdmin: asAdmin })}
          >
            Invite
          </Button>
        </div>
      ) : (
        // Said rather than left to be discovered: there is nobody to invite *to*.
        <p className="text-[12.5px] text-ink-subtle">Inviting somebody needs an organisation server. Settings → Organisation is where this machine signs in to one.</p>
      )}

      {invite.data?.problem ? <ErrorLine>{invite.data.problem}</ErrorLine> : null}
      {invite.error ? <ErrorLine>{invite.error.message}</ErrorLine> : null}
      {invite.data?.invitePath ? <InvitationLink path={invite.data.invitePath} expiresAt={invite.data.expiresAt} /> : null}
    </CardSection>
  );
}

/**
 * The link to send, resolved against the address this browser is on —
 * the server does not reliably know its own public one. Shown rather than
 * sent, because EO has no mail transport, and saying so is the difference
 * between an admin copying it into a mail and waiting for one that never
 * comes.
 */
function InvitationLink({ path, expiresAt }: { path: string; expiresAt: number | null }) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const reachable = origin.startsWith("http");
  const link = reachable ? `${origin}${path}` : path;
  const [copied, setCopied] = useState(false);
  return (
    <Notice
      title="Invitation ready"
      action={
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(link);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      }
    >
      <span>
        EO does not send email. Copy this one-time link and send it to them
        {expiresAt === null ? "" : ` — it works until ${new Date(expiresAt).toLocaleDateString()}`}.
      </span>
      <code className="break-all font-mono text-[12px] text-ink">{link}</code>
      {reachable ? null : (
        <span className="text-ink-subtle">Put your server&apos;s own address in front of it — this desktop does not know what your colleagues can reach it at.</span>
      )}
    </Notice>
  );
}

// ── Groups ──────────────────────────────────────────────────────────

/**
 * Groups, so a human step can say "Support team · anyone claims". The
 * membership editor is checkboxes and one Save, because `groups:save`
 * replaces the whole set — a screen whose shape disagreed with the write
 * would be how a half-applied change gets saved.
 */
function GroupsPanel() {
  const queryClient = useQueryClient();
  const { people, groups } = usePeople();
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [members, setMembers] = useState<string[]>([]);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: peopleKey });

  const save = useMutation({
    mutationFn: (input: { id?: string; name: string; memberIds: string[] }) => ipcQuery("groups:save", input),
    onSuccess: (result) => {
      if (result.problem === null) {
        setName("");
        setEditing(null);
      }
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (groupId: string) => ipcQuery("groups:delete", { groupId }),
    onSettled: () => refresh(),
  });

  return (
    <CardSection title="Groups" description="A human step can wait on a group, and anybody in it may claim the work.">
      {groups.length > 0 ? (
        <ul aria-label="Groups" className="flex min-w-0 flex-col [&>li+li]:border-t [&>li+li]:border-line/60">
          {groups.map((group) => (
            <li key={group.id} className="flex min-w-0 flex-col gap-2 py-2.5">
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[13px] text-ink">{group.name}</span>
                  <span className="text-[11.5px] text-ink-subtle">{group.memberIds.length === 1 ? "1 member" : `${group.memberIds.length} members`}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    aria-expanded={editing === group.id}
                    onClick={() => {
                      setEditing(editing === group.id ? null : group.id);
                      setMembers([...group.memberIds]);
                    }}
                  >
                    {editing === group.id ? "Close" : "Members"}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(group.id)}>
                    Delete
                  </Button>
                </div>
              </div>
              {editing === group.id ? (
                <div role="group" aria-label={`Members of ${group.name}`} className="flex min-w-0 flex-col gap-2 rounded-[12px] bg-canvas-subtle px-3.5 py-3">
                  {people.map((person) => (
                    <MemberBox
                      key={person.id}
                      label={person.name}
                      accessibleName={`${person.name} in ${group.name}`}
                      checked={members.includes(person.id)}
                      onChange={(checked) => setMembers((current) => (checked ? [...current, person.id] : current.filter((id) => id !== person.id)))}
                    />
                  ))}
                  <div>
                    <Button size="sm" variant="primary" disabled={save.isPending} onClick={() => save.mutate({ id: group.id, name: group.name, memberIds: members })}>
                      Save members
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-ink-subtle">No groups yet.</p>
      )}

      <div className="flex min-w-0 flex-wrap items-end gap-2 border-t border-line/60 pt-3">
        <Field label="New group" className="min-w-[12rem] flex-1">
          <TextInput value={name} aria-label="Group name" onChange={(event) => setName(event.target.value)} />
        </Field>
        <Button disabled={name.trim() === "" || save.isPending} onClick={() => save.mutate({ name: name.trim(), memberIds: [] })}>
          Add
        </Button>
      </div>
      {save.data?.problem ? <ErrorLine>{save.data.problem}</ErrorLine> : null}
      {remove.data?.problem ? <ErrorLine>{remove.data.problem}</ErrorLine> : null}
    </CardSection>
  );
}

/**
 * A membership checkbox named "Anna in Support team" for a screen reader
 * while it reads "Anna" on screen — the kit's checkbox is named by its
 * visible words, and a list of bare names under several groups would name
 * none of them.
 */
function MemberBox({ label, accessibleName, checked, onChange }: { label: string; accessibleName: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <Checkbox
      checked={checked}
      onChange={onChange}
      label={
        <>
          <span aria-hidden>{label}</span>
          <span className="sr-only">{accessibleName}</span>
        </>
      }
    />
  );
}

// ── Devices ─────────────────────────────────────────────────────────

/**
 * The machines that hold a key (ARCHITECTURE.md, "Identity"). Revoked rows stay, because the list
 * is a record of what has held one — "Anna's MacBook · revoked" is the
 * answer an admin opens this with after a laptop goes missing.
 */
function DevicesPanel() {
  const queryClient = useQueryClient();
  const devices = useQuery({ queryKey: devicesKey, queryFn: () => ipcQuery("devices:list", undefined) });
  useInvalidateOnPush("config:changed", devicesKey);

  const revoke = useMutation({
    mutationFn: (deviceId: string) => ipcQuery("devices:revoke", { deviceId }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: devicesKey }),
  });

  const rows = devices.data?.devices ?? [];
  // A list this window could not fetch is not an empty list.
  const unreachable = devices.data?.problem ?? null;

  return (
    <CardSection title="Devices" description="Every machine somebody has signed in from. Revoking one stops its next request.">
      {devices.isLoading ? (
        <Loading>Reading the devices…</Loading>
      ) : devices.error ? (
        <ErrorLine>{devices.error.message}</ErrorLine>
      ) : unreachable !== null ? (
        <Notice tone="paused">{unreachable}</Notice>
      ) : devices.isSuccess && rows.length === 0 ? (
        <p className="text-[12.5px] text-ink-subtle">Nobody has signed in from a desktop yet.</p>
      ) : (
        <ul aria-label="Devices" className="flex min-w-0 flex-col [&>li+li]:border-t [&>li+li]:border-line/60">
          {rows.map((device) => (
            <li key={device.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-mono text-[12.5px] text-ink">{device.name}</span>
                <span className="text-[11.5px] text-ink-subtle">
                  {device.personName} · {lastSeen(device.lastSeenAt)}
                </span>
              </div>
              {device.revokedAt === null ? (
                <Button size="sm" variant="danger" disabled={revoke.isPending} onClick={() => revoke.mutate(device.id)}>
                  Revoke
                </Button>
              ) : (
                <Chip tone="paused">revoked</Chip>
              )}
            </li>
          ))}
        </ul>
      )}
      {revoke.data?.problem ? <ErrorLine>{revoke.data.problem}</ErrorLine> : null}
    </CardSection>
  );
}
