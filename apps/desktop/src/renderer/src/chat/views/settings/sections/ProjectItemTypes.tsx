import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isPackShipped, SPEC_FIELD_KIND_LABELS, SPEC_FIELD_KINDS, specFields, type ItemTypeView, type SpecFieldDraft, type SpecFieldKind } from "@eo/core";
import { ipcQuery } from "../../../../query/client";
import { itemTypesKey, registryKey } from "../../../../query/hooks";
import { Button, Select, TextInput } from "../../../kit";

/**
 * Under a project in Settings → Projects: the kinds of item it files,
 * and each one's fields (EO-523). A type is added, changed or removed by
 * asking the assistant, whose card does it — so this says what is there
 * and which of it a pack ships.
 *
 * The one thing changed here is a pack's type's own optional fields
 * (EO-735): a project may add fields beside the pack's, rename them and
 * remove them, and they are drawn apart from the pack's, which nothing
 * here offers to touch. Every change goes through `itemTypes:update`,
 * whose refusals — a name a pack field has, a field items hold a value
 * for — are shown under the type.
 */
export function ProjectItemTypes({ projectId, projectName }: { projectId: string; projectName: string }) {
  const types = useQuery({ queryKey: itemTypesKey(projectId), queryFn: () => ipcQuery("itemTypes:list", { projectId }) });
  const rows = types.data?.types ?? [];

  return (
    <div aria-label={`${projectName}'s item types`} className="flex flex-col gap-1 text-[11.5px] leading-snug text-ink-subtle">
      <p>
        Item types{rows.length === 0 ? "" : ` (${rows.length})`} — to add, change or remove one, ask the assistant. A pack&apos;s type can take optional fields of
        this project&apos;s own, added here.
      </p>
      {types.error ? <p className="text-danger">{types.error.message}</p> : null}
      {types.data !== undefined && rows.length === 0 ? <p>This project has no item types.</p> : null}
      {rows.length > 0 ? (
        <ul aria-label="Item types" className="flex flex-col gap-1">
          {rows.map((type) => (
            <ItemTypeRow key={type.id} type={type} projectId={projectId} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ItemTypeRow({ type, projectId }: { type: ItemTypeView; projectId: string }) {
  const packShipped = isPackShipped(type);
  const all = specFields(type.specShape);
  // On a type made here every field is its own; only a pack's type has two lists.
  const own = packShipped ? all.filter((field) => !field.added) : all;
  return (
    <li aria-label={type.label} className="flex flex-col gap-0.5">
      <span>
        <span className="text-ink">{type.label}</span> / {type.plural} · <span className="font-mono">{type.slug}</span> ·{" "}
        {type.container ? "holds other items" : "is the work"} · {packShipped ? `from the ${type.packSlug} pack` : "made here"} · {type.itemCount}{" "}
        {type.itemCount === 1 ? "item" : "items"}
      </span>
      {own.length === 0 ? (
        <span className="pl-3">{packShipped ? `No fields from the ${type.packSlug} pack.` : "No fields — a title and a description only."}</span>
      ) : (
        <ul aria-label={`${type.label}'s fields`} className="flex flex-col pl-3">
          {own.map((field) => (
            <li key={field.name}>
              <span className="font-mono text-ink">{field.name}</span> — {SPEC_FIELD_KIND_LABELS[field.kind]}
              {field.required ? ", required" : ""}
              {field.description === undefined ? "" : ` — ${field.description}`}
            </li>
          ))}
        </ul>
      )}
      {packShipped ? <AddedFields type={type} projectId={projectId} /> : null}
    </li>
  );
}

/** What is being typed: a new field, or a new name for one already added. */
type Editing = { kind: "add"; name: string; fieldKind: SpecFieldKind } | { kind: "rename"; from: string; name: string } | null;

/**
 * A pack's type's fields added in this project (EO-735): each optional,
 * and the only ones on the type this screen changes.
 *
 * Every press sends the whole list — the pack's fields as the row has
 * them and the added ones as they would be — because that is what
 * `itemTypes:update` judges: a pack field missing or changed is refused,
 * and so is an added one items hold a value for that the list removes or
 * renames.
 */
function AddedFields({ type, projectId }: { type: ItemTypeView; projectId: string }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Editing>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const fields = specFields(type.specShape);
  const packFields: SpecFieldDraft[] = fields.filter((field) => !field.added).map(({ name, kind, required }) => ({ name, kind, required }));
  const added: SpecFieldDraft[] = fields.filter((field) => field.added).map(({ name, kind }) => ({ name, kind, required: false }));

  const save = useMutation({
    mutationFn: (next: SpecFieldDraft[]) => ipcQuery("itemTypes:update", { id: type.id, fields: [...packFields, ...next] }),
    onSuccess: (result) => {
      setProblem(result.problem);
      if (result.problem === null) setEditing(null);
      void queryClient.invalidateQueries({ queryKey: itemTypesKey(projectId) });
      // The item form and the hand-over doors read the type from the registry.
      void queryClient.invalidateQueries({ queryKey: registryKey });
    },
    onError: (failure: unknown) => setProblem(failure instanceof Error ? failure.message : String(failure)),
  });

  const label = type.label;
  const busy = save.isPending;

  const begin = (next: Editing): void => {
    setProblem(null);
    setEditing(next);
  };

  const submit = (): void => {
    if (editing === null || busy) return;
    if (editing.kind === "add") save.mutate([...added, { name: editing.name, kind: editing.fieldKind, required: false }]);
    else save.mutate(added.map((field) => (field.name === editing.from ? { ...field, name: editing.name } : field)));
  };

  return (
    <section aria-label={`Fields added to ${label} in this project`} className="flex flex-col gap-1 pl-3">
      <span>Added in this project — optional, and left empty on an item until somebody sets them:</span>
      {added.length === 0 ? <span className="pl-3">None yet.</span> : null}
      {added.length > 0 ? (
        <ul aria-label={`${label}'s added fields`} className="flex flex-col gap-1 pl-3">
          {added.map((field) =>
            editing?.kind === "rename" && editing.from === field.name ? (
              <li key={field.name} className="flex items-center gap-1.5">
                <TextInput
                  aria-label={`New name for ${field.name}`}
                  value={editing.name}
                  disabled={busy}
                  onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                  className="h-7 max-w-48 text-[12px]"
                />
                <Button size="sm" variant="primary" disabled={busy || editing.name.trim() === ""} onClick={submit}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </li>
            ) : (
              <li key={field.name} aria-label={field.name} className="flex items-center gap-1.5">
                <span>
                  <span className="font-mono text-ink">{field.name}</span> — {SPEC_FIELD_KIND_LABELS[field.kind]}, optional
                </span>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => begin({ kind: "rename", from: field.name, name: field.name })}>
                  Rename
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    begin(null);
                    save.mutate(added.filter((other) => other.name !== field.name));
                  }}
                >
                  Remove
                </Button>
              </li>
            ),
          )}
        </ul>
      ) : null}
      {editing?.kind === "add" ? (
        <div className="flex items-center gap-1.5 pl-3">
          <TextInput
            aria-label={`New field on ${label}`}
            placeholder="automerge"
            value={editing.name}
            disabled={busy}
            onChange={(event) => setEditing({ ...editing, name: event.target.value })}
            className="h-7 max-w-48 text-[12px]"
          />
          <Select
            aria-label={`Kind of the new field on ${label}`}
            value={editing.fieldKind}
            disabled={busy}
            onChange={(event) => setEditing({ ...editing, fieldKind: event.target.value as SpecFieldKind })}
            className="max-w-36"
          >
            {SPEC_FIELD_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {SPEC_FIELD_KIND_LABELS[kind]}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="primary" disabled={busy || editing.name.trim() === ""} onClick={submit}>
            Add
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
            Cancel
          </Button>
        </div>
      ) : (
        <span className="pl-3">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => begin({ kind: "add", name: "", fieldKind: "boolean" })}>
            Add a field to {label}
          </Button>
        </span>
      )}
      {problem !== null ? (
        <p role="alert" className="pl-3 text-danger">
          {problem}
        </p>
      ) : null}
    </section>
  );
}
