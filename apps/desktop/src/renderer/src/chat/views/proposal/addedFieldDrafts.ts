import { useSyncExternalStore } from "react";
import type { ProposedAddedField } from "@eo/core";
import { fromText } from "../item/Fields";

/**
 * What a person has typed, before pressing Create, into the fields a
 * project added to a proposed item's type (EO-735) — kept outside any one
 * view, because a proposal's items open in tabs of their own and either
 * Create button files all of them: the one on the item's view and the one
 * on the card in the chat.
 *
 * Kept as typed text, per message and row, with each field's kind, so a
 * half-typed number survives a tab switch; turned into values only when
 * an approval is sent (`addedFieldValues`). A field nobody touched is not
 * here at all, which is how it stays unset on the item.
 */
type RowDrafts = Map<number, Map<string, { kind: ProposedAddedField["kind"]; text: string }>>;

const drafts = new Map<string, RowDrafts>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One row's typed text by field name, re-read whenever any draft changes. */
export function useAddedFieldDraft(messageId: string, row: number): Record<string, string> {
  useSyncExternalStore(subscribe, () => version);
  const fields = drafts.get(messageId)?.get(row);
  return fields === undefined ? {} : Object.fromEntries([...fields].map(([name, entry]) => [name, entry.text]));
}

/** Sets one field's text on one row; blank text takes the field back to unset. */
export function setAddedFieldDraft(messageId: string, row: number, field: ProposedAddedField, text: string): void {
  const rows = drafts.get(messageId) ?? new Map();
  const fields = rows.get(row) ?? new Map();
  if (text.trim() === "") fields.delete(field.name);
  else fields.set(field.name, { kind: field.kind, text });
  rows.set(row, fields);
  drafts.set(messageId, rows);
  changed();
}

/** What `assist:approve` takes for this message: each row's set fields as values, or nothing when none were set. */
export function addedFieldValues(messageId: string): { row: number; values: Record<string, unknown> }[] | undefined {
  const rows = drafts.get(messageId);
  if (rows === undefined) return undefined;
  const sent = [...rows]
    .map(([row, fields]) => ({ row, values: Object.fromEntries([...fields].map(([name, entry]) => [name, fromText({ kind: entry.kind }, entry.text)])) }))
    .filter((entry) => Object.keys(entry.values).length > 0);
  return sent.length === 0 ? undefined : sent;
}

/** Forgets a message's drafts, once its proposal has been filed. */
export function clearAddedFieldDrafts(messageId: string): void {
  if (drafts.delete(messageId)) changed();
}
