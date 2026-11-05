import type { VersionDiff as VersionDiffValue } from "@eo/core";
import { CardSection, Chip, type Tone } from "../../kit";

/**
 * What changed between two graphs (EO-327 ARCHITECTURE.md, "Publish, lock and versions", EO-331
 * ARCHITECTURE.md, "Divergence and suggestions"), drawn in
 * the chat layout's terms. Reads a value and does nothing else — the
 * version picker belongs to the screen comparing, the buttons to the
 * screen deciding.
 */

type FieldChange = { field: string; before: string | null; after: string | null };

function changeTone(change: string): Tone {
  if (change === "added") return "running";
  if (change === "removed") return "danger";
  return "neutral";
}

function Fields({ fields }: { fields: readonly FieldChange[] }) {
  if (fields.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 pl-1 pt-1">
      {fields.map((field) => (
        <li key={field.field} className="text-[11.5px] leading-relaxed text-ink-muted">
          <span className="font-mono text-ink-subtle">{field.field}</span>: <s className="text-ink-subtle">{field.before ?? "—"}</s> →{" "}
          <span className="text-ink">{field.after ?? "—"}</span>
        </li>
      ))}
    </ul>
  );
}

export function VersionDiff({ diff }: { diff: Pick<VersionDiffValue, "steps" | "routes"> & Partial<Pick<VersionDiffValue, "entryRules">> }) {
  return (
    <>
      <CardSection title="Steps">
        {diff.steps.length === 0 ? (
          <p className="text-[12.5px] text-ink-subtle">No step was added, removed or edited.</p>
        ) : (
          <ul className="flex flex-col [&>li+li]:border-t [&>li+li]:border-line/60">
            {diff.steps.map((step) => (
              <li key={step.stepId} className="py-2 text-[13px]">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-ink">{step.name}</span>
                  <Chip tone={changeTone(step.change)}>{step.change}</Chip>
                </span>
                {/* Field by field, so "the prompt changed" and "it was
                    renamed" are not one undifferentiated line. */}
                <Fields fields={step.fields} />
              </li>
            ))}
          </ul>
        )}
      </CardSection>
      <CardSection title="Routes">
        {diff.routes.length === 0 ? (
          <p className="text-[12.5px] text-ink-subtle">No route changed.</p>
        ) : (
          <ul className="flex flex-col [&>li+li]:border-t [&>li+li]:border-line/60">
            {diff.routes.map((route) => (
              <li key={`${route.fromStepName} ${route.resultKey}`} className="py-2 text-[13px] text-ink-muted">
                <span className="flex flex-wrap items-center gap-2">
                  <span>
                    <span className="text-ink">{route.fromStepName}</span> · <span className="font-mono text-[12px]">{route.resultKey}</span>
                  </span>
                  <Chip tone={changeTone(route.change)}>{route.change}</Chip>
                </span>
                <Fields fields={route.fields} />
              </li>
            ))}
          </ul>
        )}
      </CardSection>
      {diff.entryRules == null ? null : (
        <CardSection title="Entry rules">
          <Fields fields={[{ field: "needs", before: diff.entryRules.before, after: diff.entryRules.after }]} />
        </CardSection>
      )}
    </>
  );
}
