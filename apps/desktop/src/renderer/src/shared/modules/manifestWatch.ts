/**
 * The `watch` flag of a module manifest as the editor holds it — JSON a
 * person is typing (EO-458, ARCHITECTURE.md, "Modules: a step that is a
 * script").
 *
 * The manifest is a text area, so the switch beside it reads the flag out
 * of the text and writes it back in rather than keeping a second copy
 * that could disagree with what is saved. Both layouts' editors use these.
 */

function manifestObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Whether the draft declares `watch: true`, or null while the text is not
 * a JSON object — half-typed, say — and so has no flag to read. Anything
 * but `true` is no, as the manifest schema reads an absent flag.
 */
export function draftWatchFlag(text: string): boolean | null {
  const manifest = manifestObject(text);
  return manifest === null ? null : manifest.watch === true;
}

/**
 * The draft with the flag set or cleared, or the text unchanged when it
 * is not a JSON object. Cleared is the key removed rather than `false`:
 * absent is what every manifest written before the flag existed says, and
 * it means the same.
 */
export function withDraftWatchFlag(text: string, on: boolean): string {
  const manifest = manifestObject(text);
  if (manifest === null) return text;
  const next: Record<string, unknown> = { ...manifest };
  if (on) next.watch = true;
  else delete next.watch;
  return JSON.stringify(next, null, 2);
}

/** The sentence under the switch, the same in both layouts. */
export function watchFlagDescription(flag: boolean | null): string {
  if (flag === null) return "Fix the manifest's JSON to change this here.";
  return "A step set to keep checking may run this module every few minutes; it answers \"waiting\", with any news, until it can return one of its results. Sets watch: true in the manifest.";
}
