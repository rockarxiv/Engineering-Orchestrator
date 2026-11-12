import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  describeJobEventOutcome,
  isJsonPointer,
  resolveJsonPointer,
  specFields,
  webhookFieldText,
  type ItemTypeEntry,
  type JobEventRow,
  type WebhookMapping,
  type WebhookTrigger,
} from "@eo/core";
import type { JobDraft } from "../../../shared/jobs/draft";
import { whenOf } from "../../../shared/jobs/format";
import { webhookAddress } from "../../../shared/jobs/webhook";
import { ipcQuery } from "../../../query/client";
import { Button, CardSection, EmptyState, TextInput } from "../../kit";
import { ItemKeyLink } from "../inbox/references";

/**
 * A webhook job's own surface (EO-333, `ARCHITECTURE.md`, "The inbox, the archive and jobs",
 * "Results and routes", "Webhooks"):
 * the address and the secret to paste into the other end, a test event
 * through the real door, the mapping with a preview from the last
 * delivery, and the events — including the ones that filed nothing.
 */

/**
 * The address, the secret, and the two buttons that act at once.
 *
 * Its own card above the form because nothing here is a draft:
 * Regenerate invalidates the old secret as it answers, and Send test
 * event files an item. A Save over either would offer to undo something
 * that has already happened.
 */
export function WebhookAddress({ jobId, trigger, onChanged }: { jobId: string; trigger: WebhookTrigger; onChanged: () => void }) {
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [tested, setTested] = useState<{ key: string; id: string } | null>(null);
  const { url, reachable } = webhookAddress(trigger.path);

  const regenerate = useMutation({
    mutationFn: () => ipcQuery("jobs:regenerateSecret", { jobId }),
    onSuccess: (result) => {
      setConfirmingRegenerate(false);
      setTested(null);
      setSaid(result.problem ?? "A new secret. The old one stops working now — paste this one into the other end.");
      if (result.job !== null) onChanged();
    },
  });

  const test = useMutation({
    mutationFn: () => ipcQuery("jobs:testEvent", { jobId }),
    onSuccess: (result) => {
      setTested(result.itemKey === null || result.itemId === null ? null : { key: result.itemKey, id: result.itemId });
      // The door's answer in EO's own words: a held or refused test is
      // the job saying what it would have said to the other end.
      setSaid(
        result.outcome === null
          ? (result.problem ?? "EO could not send it.")
          : `${describeJobEventOutcome(result.outcome)}.${result.problem === null ? "" : ` ${result.problem}`}`,
      );
      onChanged();
    },
  });

  return (
    <CardSection title="Webhook" description="Where events arrive, and what signs them.">
      <Copyable label="URL" value={url} hint={reachable ? "Post signed events here." : undefined} />
      {reachable ? null : (
        <p className="text-[12.5px] text-ink-subtle">
          Put your server&apos;s own address in front of it — this desktop does not have one, and a webhook always arrives at the server.
        </p>
      )}
      {/* In plain text, the trigger's own decision: a secret a person cannot read back is one they cannot configure the other end with. */}
      <Copyable label="Signing secret" value={trigger.secret} hint="HMAC-SHA256 over the timestamp, a full stop, and the body." />

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => test.mutate()} disabled={test.isPending}>
          Send test event
        </Button>
        {confirmingRegenerate ? (
          <>
            <span className="text-[12.5px] text-ink-muted">Everything sending with the old secret starts being refused.</span>
            <Button variant="danger" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
              Regenerate anyway
            </Button>
            <Button variant="ghost" onClick={() => setConfirmingRegenerate(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => setConfirmingRegenerate(true)}>
            Regenerate
          </Button>
        )}
      </div>

      {said === null ? null : (
        <p className="text-[13px] text-ink-muted">
          {said}{" "}
          {/* The id with the key: an item made a moment ago must link before the catalogue has heard of it. */}
          {tested === null ? null : <ItemKeyLink itemKey={tested.key} itemId={tested.id} className="text-[11.5px]" />}
        </p>
      )}
    </CardSection>
  );
}

/** A string to paste, with the button that puts it on the clipboard. */
function Copyable({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[12px] font-medium text-ink-muted">{label}</span>
        {hint === undefined ? null : <span className="text-[11.5px] text-ink-subtle">{hint}</span>}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-[10px] bg-canvas-raised px-2.5 py-1.5 font-mono text-[12px] text-ink">{value}</code>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

/**
 * One row per template field, a pointer, and what the last payload has
 * there. Part of the form — nothing changes until Save — and the preview
 * reads the same `resolveJsonPointer` the door does, so changing a
 * pointer previews without sending anything.
 */
export function WebhookMappingTable({
  draft,
  itemType,
  lastPayload,
  onChange,
}: {
  draft: JobDraft;
  itemType: ItemTypeEntry | undefined;
  lastPayload: string | null;
  onChange: (next: JobDraft) => void;
}) {
  const webhook = draft.webhook;
  if (webhook === null) return null;
  const mapping = webhook.mapping;
  const document = parsePayload(lastPayload);

  const setMapping = (next: WebhookMapping) => onChange({ ...draft, webhook: { ...webhook, mapping: next } });
  const rows: { key: string; label: string; pointer: string; set: (pointer: string) => void }[] = [
    { key: "title", label: "Title", pointer: mapping.title ?? "", set: (pointer) => setMapping({ ...mapping, title: blankIsNothing(pointer) }) },
    { key: "body", label: "Body", pointer: mapping.body ?? "", set: (pointer) => setMapping({ ...mapping, body: blankIsNothing(pointer) }) },
    ...(itemType === undefined ? [] : specFields(itemType.specShape)).map((field) => ({
      key: `spec.${field.name}`,
      label: field.label,
      pointer: mapping.spec[field.name] ?? "",
      set: (pointer: string) => {
        const spec = { ...mapping.spec };
        // Removed rather than kept empty: an empty pointer would be read
        // as "nothing there" on every delivery.
        if (pointer.trim() === "") delete spec[field.name];
        else spec[field.name] = pointer;
        setMapping({ ...mapping, spec });
      },
    })),
    { key: "eventKey", label: "Event key", pointer: mapping.eventKey ?? "", set: (pointer) => setMapping({ ...mapping, eventKey: blankIsNothing(pointer) }) },
  ];

  return (
    <section aria-label="Field mapping" className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="text-[12px] font-medium text-ink-muted">Field mapping</span>
        <span className="text-[11.5px] leading-snug text-ink-subtle">
          JSON pointers into the payload — /issue/fields/summary. A field left empty keeps what the template says. The event key is the sender&apos;s
          own id for an event, and is what stops a retry filing a second item.
        </span>
      </div>
      <ul className="flex min-w-0 flex-col [&>li+li]:border-t [&>li+li]:border-line/60">
        {rows.map((row) => (
          <li key={row.key} className="grid min-w-0 grid-cols-[minmax(5rem,8rem)_minmax(0,1fr)] items-center gap-x-3 gap-y-1 py-2">
            <span className="truncate text-[12.5px] text-ink-muted">{row.label}</span>
            <TextInput aria-label={`${row.label} pointer`} className="font-mono text-[12px]" value={row.pointer} onChange={(event) => row.set(event.target.value)} />
            <span className="col-start-2 min-w-0 text-[12px]">
              <Preview document={document} pointer={row.pointer} hasPayload={lastPayload !== null} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What a pointer finds, in the words each kind of nothing deserves. */
function Preview({ document, pointer, hasPayload }: { document: unknown; pointer: string; hasPayload: boolean }) {
  if (pointer.trim() === "") return <span className="text-ink-subtle">The template&apos;s own text</span>;
  if (!isJsonPointer(pointer)) return <span className="text-danger">Not a pointer — it has to start with /</span>;
  if (!hasPayload) return <span className="text-ink-subtle">Nothing has arrived yet</span>;
  const found = webhookFieldText(resolveJsonPointer(document, pointer));
  if (found === null) return <span className="text-ink-subtle">Nothing there</span>;
  return <span className="break-all text-ink">{found}</span>;
}

function blankIsNothing(pointer: string): string | null {
  return pointer.trim() === "" ? null : pointer;
}

function parsePayload(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Every delivery, newest first — including the ones that produced
 * nothing, which are the ones a person comes here about. With concurrency
 * at 1 a burst also needs "38 waiting" said, or the team sees one item
 * and assumes the rest were lost (ARCHITECTURE.md, "Webhooks").
 */
export function JobEvents({
  events,
  heldCount,
  timeZone,
  showKeys = false,
  empty = "Nothing has been delivered here yet.",
}: {
  events: JobEventRow[];
  heldCount: number;
  timeZone: string | undefined;
  /** Each row's event key, for a watch job (EO-754), whose keys are its module's names for what it found. A webhook's are often a hash. */
  showKeys?: boolean;
  empty?: string;
}) {
  return (
    <section aria-label="Events" className="flex min-w-0 flex-col gap-2">
      {heldCount === 0 ? null : (
        <p className="text-[13px] text-ink-muted">{heldCount} waiting. EO files them in the order they arrived, as the job&apos;s own limit lets it.</p>
      )}
      {events.length === 0 ? (
        <EmptyState title={empty} />
      ) : (
        <ul className="flex min-w-0 flex-col [&>li+li]:border-t [&>li+li]:border-line/60">
          {events.map((event) => (
            <li key={event.id} className="flex min-w-0 items-start gap-3 py-2">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[13px] text-ink">
                  {describeJobEventOutcome(event.outcome)}
                  {showKeys ? <span className="ml-2 font-mono text-[12px] text-ink-muted">{event.eventKey}</span> : null}
                </span>
                {event.reason ? <span className="text-[12px] leading-snug text-ink-muted">{event.reason}</span> : null}
                <span className="text-[11px] text-ink-subtle">{whenOf(event.receivedAt, timeZone)}</span>
              </div>
              {event.itemKey === null || event.itemId === null ? null : (
                <ItemKeyLink itemKey={event.itemKey} itemId={event.itemId} className="shrink-0 text-[11.5px] text-ink-subtle" />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
