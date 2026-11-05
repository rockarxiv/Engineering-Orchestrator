import { readdirSync } from "node:fs";
import { allocateSkillSlugs, type SkillSlugRequest } from "@eo/core";

/**
 * The other half of slug allocation: what is actually there (EO-105).
 *
 * Slug allocation has two halves that must agree and must not live
 * together. `allocateSkillSlugs` decides — it is pure, it is in
 * `packages/core`, and it takes the set of spoken-for slugs as an
 * argument precisely so that it never has to guess at one. This is what
 * answers that argument for a directory on disk, and it is here rather
 * than there because invariant #2 does not let a `node:fs` import
 * anywhere near the deciding half.
 *
 * Keeping them apart is not tidiness. A decider that carries its own
 * idea of what exists is a decider that picks a slug that was free the
 * last time it looked — which is the gap multica still has open as
 * MUL-5550.
 *
 * The directory this reads is the `skills/` folder of a generated plugin
 * directory, and generating one is EO-107. It is a parameter rather than
 * something computed here for the same reason: the layout is that
 * story's to decide, and this only needs to know that a skill occupies a
 * directory named after its slug.
 */

/**
 * The slugs a directory has already spent — its subdirectory names.
 *
 * A missing directory is an empty answer rather than an error: nothing
 * has been generated yet is the ordinary case on a first dispatch, and
 * making every caller catch ENOENT to say "no skills, then" buys
 * nothing. Any other failure — a path that is a file, a directory that
 * cannot be read — is left to throw, because that is a broken
 * installation and not a state to be papered over.
 *
 * Only directories count. A stray `README.md` beside them is not a skill
 * and must not reserve a slug a skill wants.
 */
export function skillSlugsOnDisk(directory: string): Set<string> {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
  return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
}

/**
 * Names a batch of skills so that none of them collides with what the
 * directory already holds.
 *
 * The whole join between the two halves, and deliberately the only one:
 * ask the disk, hand the answer to the pure decider, return what it
 * said. Anything more interesting than that belongs on one side or the
 * other.
 *
 * `extraTaken` is for slugs that are spoken for but not yet written —
 * a caller building a directory in more than one pass has already
 * promised some names that `readdirSync` cannot see yet.
 */
export function allocateSkillSlugsIn(directory: string, requests: readonly SkillSlugRequest[], extraTaken: Iterable<string> = []): string[] {
  const taken = skillSlugsOnDisk(directory);
  for (const slug of extraTaken) taken.add(slug);
  return allocateSkillSlugs(requests, taken);
}
