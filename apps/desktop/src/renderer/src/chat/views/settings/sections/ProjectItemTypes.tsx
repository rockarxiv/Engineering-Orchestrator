import { useQuery } from "@tanstack/react-query";
import { isPackShipped, specFields, type SpecFieldKind } from "@eo/core";
import { ipcQuery } from "../../../../query/client";
import { itemTypesKey } from "../../../../query/hooks";

/** What a field's kind is called, as the editor's Types section called it. */
const KIND_LABELS: Record<SpecFieldKind, string> = {
  string: "Text",
  number: "Number",
  boolean: "Yes / no",
  "string list": "List of text",
};

/**
 * Under a project in Settings → Projects: the kinds of item it files,
 * and each one's fields (EO-523). Read-only — a type is added, changed
 * or removed by asking the assistant, whose card does it — so this says
 * what is there and which of it a pack ships, and offers nothing to press.
 */
export function ProjectItemTypes({ projectId, projectName }: { projectId: string; projectName: string }) {
  const types = useQuery({ queryKey: itemTypesKey(projectId), queryFn: () => ipcQuery("itemTypes:list", { projectId }) });
  const rows = types.data?.types ?? [];

  return (
    <div aria-label={`${projectName}'s item types`} className="flex flex-col gap-1 text-[11.5px] leading-snug text-ink-subtle">
      <p>
        Item types{rows.length === 0 ? "" : ` (${rows.length})`} — to add, change or remove one, ask the assistant.
      </p>
      {types.error ? <p className="text-danger">{types.error.message}</p> : null}
      {types.data !== undefined && rows.length === 0 ? <p>This project has no item types.</p> : null}
      {rows.length > 0 ? (
        <ul aria-label="Item types" className="flex flex-col gap-1">
          {rows.map((type) => {
            const fields = specFields(type.specShape);
            return (
              <li key={type.id} aria-label={type.label} className="flex flex-col gap-0.5">
                <span>
                  <span className="text-ink">{type.label}</span> / {type.plural} · <span className="font-mono">{type.slug}</span> ·{" "}
                  {type.container ? "holds other items" : "is the work"} · {isPackShipped(type) ? `from the ${type.packSlug} pack` : "made here"} ·{" "}
                  {type.itemCount} {type.itemCount === 1 ? "item" : "items"}
                </span>
                {fields.length === 0 ? (
                  <span className="pl-3">No fields — a title and a description only.</span>
                ) : (
                  <ul aria-label={`${type.label}'s fields`} className="flex flex-col pl-3">
                    {fields.map((field) => (
                      <li key={field.name}>
                        <span className="font-mono text-ink">{field.name}</span> — {KIND_LABELS[field.kind]}
                        {field.required ? ", required" : ""}
                        {field.description === undefined ? "" : ` — ${field.description}`}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
