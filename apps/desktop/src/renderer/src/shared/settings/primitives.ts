/** The detailed-agent query key, shared by the agents screen and anything that saves one. */
export const agentDetailsKey = ["agents", "detailed"] as const;

/** Last path segment, for naming a workspace after the folder it lives in. Works for both separators. */
export function basename(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
}

/**
 * What has been typed into a form and not saved (EO-192).
 *
 * One rule for every editor on this screen: **a field is unsaved when it
 * differs from what is stored behind it.** That single comparison covers
 * both cases without either being special. A field *cleared* still
 * differs — an empty branch prefix is never saved, deliberately, so an
 * emptied box is exactly the kind of value nothing in EO holds and the
 * kind an agent must not read back as configuration. And a field on a
 * form for a row that does not exist yet is compared against blank, so
 * what has been typed is unsaved and an untouched form publishes
 * nothing.
 *
 * Published so an agent asked "what did I just set the base branch to"
 * can answer, and — the half that matters — cannot mistake any of it for
 * what is stored.
 */
export function unsavedEditsBetween<T extends object>(
  draft: T,
  saved: T,
  // Keyed by the field, so the labels are the enumeration: a field with
  // no label is a field this screen has decided not to publish, which is
  // how a credential typed into Jira or a licence key stays out.
  labels: Partial<Record<keyof T, string>>,
): { field: string; value: string }[] {
  return (Object.keys(labels) as (keyof T)[]).flatMap((key) => {
    const label = labels[key];
    const [typed, stored] = [asText(draft[key]), asText(saved[key])];
    return label === undefined || typed === stored ? [] : [{ field: label, value: typed }];
  });
}

/** A field's contents as the person sees them. Null and undefined are both an empty box. */
function asText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}
