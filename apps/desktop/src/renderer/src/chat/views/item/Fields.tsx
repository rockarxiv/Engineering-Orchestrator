import { useState, type ReactNode } from "react";
import { criteriaField, specFields, type ItemDetail, type SpecField } from "@eo/core";
import { useChromeVocabulary, useRegistry } from "../../../query/hooks";
import { Button, Facts, Field, GroupLabel, Select, Switch, TextArea, TextInput } from "../../kit";
import { RefText } from "../items/ItemReference";
import { EditorActions, StatusLine } from "./parts";

type Item = ItemDetail["item"];

/** One titled part of the item card: small capitals, its action, and what it holds. */
export function Part({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2 border-t border-line/60 pt-3">
      <GroupLabel trailing={action ?? undefined}>{title}</GroupLabel>
      {children}
    </section>
  );
}

/** One stored value as text: a list one per line, anything else as itself. */
export function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string").join("\n");
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return "";
  return String(value);
}

/**
 * One typed value back out of the box it was edited in. A blank is
 * `undefined` — "not said" rather than "said nothing" — and that comes
 * before the kinds, so a switch nobody moved never becomes `false`.
 */
export function fromText(field: Pick<SpecField, "kind">, raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (field.kind === "boolean") return raw === "true";
  if (field.kind === "number") {
    const parsed = Number(trimmed);
    return Number.isNaN(parsed) ? raw : parsed;
  }
  if (field.kind === "string list") return raw.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return trimmed;
}

/** `must_cover` → "Must cover", for a field whose type this project's registry cannot describe. */
function fieldLabel(key: string): string {
  const words = key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The item's own fields, drawn from its type's shape (KAN-147, ARCHITECTURE.md, "An item type is
 * data").
 *
 * A field per property and a control per kind — a string with an `enum`
 * offered as a choice — looked up by `typeKey`, pack and word together,
 * since two packs may both ship a `case`. The criteria field is left to
 * the section below: two editors writing one list would be two drafts.
 *
 * Saving sends only what somebody touched: a switch has no third position
 * for "unset", so a form that sent every field would decide an optional
 * boolean nobody answered.
 *
 * Where this registry has no row for the type — one deleted in another
 * window, or another project's — there is no shape to edit against, so
 * the values the item holds are shown as they are and nothing offers to
 * change them.
 */
export function SpecSection({
  item,
  busy,
  problem,
  onSave,
  onCancel,
}: {
  item: Item;
  busy: boolean;
  problem: string | null;
  onSave: (spec: Record<string, unknown>) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { registry, isLoading } = useRegistry();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const shape = registry.itemTypes.get(item.typeKey)?.specShape ?? null;
  const spec = item.spec ?? {};

  // Nothing until the registry answers, so a known type never flickers
  // through the read-only drawing on its way to its editor.
  if (isLoading) return null;
  if (shape === null) return <UnknownShape item={item} />;

  const criteria = criteriaField(shape);
  const fields = specFields(shape).filter((field) => field.name !== criteria?.name);
  if (fields.length === 0) return null;
  const filled = fields.filter((field) => asText(spec[field.name]) !== "");

  const open = (): void => {
    setDraft(Object.fromEntries(fields.map((field) => [field.name, asText(spec[field.name])])));
    setEditing(true);
  };

  const save = async (): Promise<void> => {
    if (busy) return;
    const next: Record<string, unknown> = {};
    for (const field of fields) {
      const typed = draft[field.name] ?? "";
      if (typed === asText(spec[field.name])) continue;
      next[field.name] = fromText(field, typed);
    }
    if (Object.keys(next).length === 0) {
      setEditing(false);
      return;
    }
    if (await onSave(next)) setEditing(false);
  };

  const put = (name: string, value: string) => setDraft((current) => ({ ...current, [name]: value }));

  return (
    <Part
      title="Details"
      action={
        editing ? undefined : (
          <Button size="sm" variant="ghost" disabled={busy} onClick={open}>
            {filled.length === 0 ? "Add details" : "Edit details"}
          </Button>
        )
      }
    >
      {editing ? (
        <div className="flex flex-col gap-3">
          {fields.map((field) =>
            field.kind === "boolean" ? (
              <Switch
                key={field.name}
                label={field.label}
                checked={draft[field.name] === "true"}
                disabled={busy}
                onChange={(checked) => put(field.name, checked ? "true" : "false")}
                {...(field.description ? { description: field.description } : {})}
              />
            ) : (
              <Field
                key={field.name}
                label={
                  <>
                    {field.label}
                    {field.required ? <span className="text-danger"> *</span> : null}
                  </>
                }
                hint={field.description}
              >
                {field.values !== undefined ? (
                  // A field nobody has filled in has no value to show, and
                  // starting on the first option would choose for them.
                  <Select aria-label={field.label} value={draft[field.name] ?? ""} disabled={busy} onChange={(event) => put(field.name, event.target.value)}>
                    <option value="">—</option>
                    {field.values.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </Select>
                ) : field.kind === "string list" ? (
                  <TextArea
                    aria-label={`${field.label}, one per line`}
                    value={draft[field.name] ?? ""}
                    rows={3}
                    disabled={busy}
                    placeholder="One per line."
                    onChange={(event) => put(field.name, event.target.value)}
                  />
                ) : (
                  <TextInput
                    aria-label={field.label}
                    type={field.kind === "number" ? "number" : "text"}
                    value={draft[field.name] ?? ""}
                    disabled={busy}
                    onChange={(event) => put(field.name, event.target.value)}
                  />
                )}
              </Field>
            ),
          )}
          <EditorActions>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
              Save details
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                onCancel();
              }}
            >
              Cancel
            </Button>
          </EditorActions>
        </div>
      ) : filled.length === 0 ? (
        <p className="text-[12.5px] text-ink-subtle">None recorded.</p>
      ) : (
        <Facts
          items={filled.map((field) => ({
            term: field.label,
            value: (
              <span className="whitespace-pre-wrap">
                <RefText>{asText(spec[field.name])}</RefText>
              </span>
            ),
          }))}
        />
      )}
      {problem ? (
        <StatusLine tone="danger">
          <RefText>{problem}</RefText>
        </StatusLine>
      ) : null}
    </Part>
  );
}

/** The values of an item whose type this registry has no shape for: read, never edited. */
function UnknownShape({ item }: { item: Item }) {
  // The criteria are drawn as their own list, so the spec field holding
  // them is not printed a second time as a line of text.
  const criteria = new Set(item.acceptanceCriteria);
  const values = Object.entries(item.spec ?? {})
    .filter(([, value]) => !(Array.isArray(value) && value.length > 0 && value.every((entry) => criteria.has(String(entry)))))
    .map(([name, value]) => ({ name, text: Array.isArray(value) ? value.map(String).join(", ") : asText(value) }))
    .filter((entry) => entry.text !== "");
  if (values.length === 0) return null;
  return (
    <Part title="Details">
      <Facts items={values.map((entry) => ({ term: fieldLabel(entry.name), value: <RefText>{entry.text}</RefText> }))} />
    </Part>
  );
}

/**
 * The definition of done, and correcting it (EO-166).
 *
 * Read as a list and edited as text, one per line, because that is how
 * criteria are written everywhere else in EO. Ticking one off is still
 * impossible on purpose: the mark beside each is drawn, not an input —
 * whether a criterion is met is the reviewer's judgement (R-03).
 */
export function CriteriaSection({
  criteria,
  offerToAdd,
  busy,
  problem,
  onSave,
  onCancel,
}: {
  criteria: string[];
  offerToAdd: boolean;
  busy: boolean;
  problem: string | null;
  onSave: (criteria: string[]) => Promise<boolean>;
  onCancel: () => void;
}) {
  const vocabulary = useChromeVocabulary();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  // A container with none keeps the screen it had; everything else shows
  // the heading even empty, because "none recorded" is a fact.
  if (criteria.length === 0 && !offerToAdd) return null;

  const open = (): void => {
    setDraft(criteria.join("\n"));
    setEditing(true);
  };
  const save = async (): Promise<void> => {
    if (busy) return;
    if (await onSave(draft.split("\n").map((line) => line.trim()).filter((line) => line !== ""))) setEditing(false);
  };

  return (
    <Part
      title="Acceptance criteria"
      action={
        editing ? undefined : (
          <Button size="sm" variant="ghost" disabled={busy} onClick={open}>
            {criteria.length === 0 ? "Add criteria" : "Edit criteria"}
          </Button>
        )
      }
    >
      {editing ? (
        <div className="flex flex-col gap-2">
          <TextArea
            aria-label="Acceptance criteria, one per line"
            value={draft}
            rows={Math.max(3, criteria.length + 1)}
            disabled={busy}
            placeholder="One criterion per line."
            onChange={(event) => setDraft(event.target.value)}
          />
          <EditorActions
            note={`One per line. Whoever reviews this work judges it against these, so the change is recorded on the ${vocabulary.item.toLowerCase()} along with what they said before.`}
          >
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
              Save criteria
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                onCancel();
              }}
            >
              Cancel
            </Button>
          </EditorActions>
        </div>
      ) : criteria.length === 0 ? (
        <p className="text-[12.5px] text-ink-subtle">None recorded.</p>
      ) : (
        <ul aria-label="Acceptance criteria" className="flex flex-col gap-1.5 text-[13px] text-ink">
          {criteria.map((criterion) => (
            <li key={criterion} className="flex items-start gap-2">
              <span aria-hidden className="mt-[3px] h-3.5 w-3.5 shrink-0 rounded-[4px] border-[1.5px] border-line-strong" />
              <span className="min-w-0">
                <RefText>{criterion}</RefText>
              </span>
            </li>
          ))}
        </ul>
      )}
      {problem ? (
        <StatusLine tone="danger">
          <RefText>{problem}</RefText>
        </StatusLine>
      ) : null}
    </Part>
  );
}
