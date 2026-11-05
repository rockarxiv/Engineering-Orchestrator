/**
 * Deciding what a batch of skills is called (EO-105).
 *
 * A skill has two names. The display name is what a person typed and
 * what they recognise it by; the **slug** is the only identifier a model
 * can invoke — it is the directory a skill is written to and the `name`
 * in its frontmatter. Multica shipped that the other way round and
 * tracked it as MUL-5529: a skill called "PR review" was listed to the
 * model verbatim, and the name did not resolve to anything it could
 * call.
 *
 * Slug allocation has two halves that must agree and must not live
 * together. This is the pure half: given some skills and the slugs that
 * are already spoken for, it decides what each one is called, and it
 * does it the same way every time. It is here rather than beside a
 * filesystem for the reason invariant #2 gives — no `node:*`, no
 * `electron`, nothing to mock — and the package's own lint config
 * forbids those imports so it stays that way.
 *
 * The other half asks what is *actually* on disk and hands the answer in
 * as `taken` (`main/skills/slugsOnDisk.ts`). Keeping the question and
 * the answer in one function is the gap multica still has open as
 * MUL-5550: a decider that guesses at what exists picks a slug that was
 * free the last time it looked.
 */

/**
 * What a slug may be.
 *
 * Lowercase alphanumerics in hyphen-separated words, because this is a
 * directory name on three filesystems and an identifier the model types
 * back. No underscore, no leading or trailing hyphen and no doubled one:
 * a narrower shape than a module slug on purpose, since a module slug is
 * only ever read by EO and this one is read by somebody else's binary.
 */
export const SKILL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * How long a slug may be.
 *
 * A path component, so the ceiling that matters is the filesystem's 255
 * bytes — but a slug is also a thing a model has to reproduce exactly,
 * and one that runs to a paragraph is one it will get wrong. Sixty-four
 * is generous for a name and short enough to read.
 */
export const SKILL_SLUG_MAX_LENGTH = 64;

/**
 * What a name with nothing sluggable left in it becomes.
 *
 * "🎉" and "!!!" are both legal display names and both slugify to the
 * empty string, which is not a directory. Answered with a real slug that
 * then goes through collision resolution like any other, so two of them
 * become `skill` and `skill-2` rather than two attempts to write the
 * same nameless directory.
 */
export const FALLBACK_SKILL_SLUG = "skill";

/** Trailing hyphens, left behind by truncation or by punctuation at the end. */
function trimHyphens(value: string): string {
  return value.replace(/^-+/, "").replace(/-+$/, "");
}

/**
 * The slug a display name wants, before anybody checks whether it is
 * free.
 *
 * Accents are decomposed and dropped rather than replaced with hyphens,
 * so "Résumé review" is `resume-review` and not `r-sum-review`. Anything
 * else outside `[a-z0-9]` collapses to a single hyphen — one run, one
 * hyphen, so "PR  --  review" does not become `pr------review`.
 */
export function slugifySkillName(name: string): string {
  const withoutAccents = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const collapsed = trimHyphens(withoutAccents.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  const truncated = trimHyphens(collapsed.slice(0, SKILL_SLUG_MAX_LENGTH));
  return truncated === "" ? FALLBACK_SKILL_SLUG : truncated;
}

/** One skill waiting to be told what it is called. */
export interface SkillSlugRequest {
  /** The display name. Used when no slug was asked for. */
  name: string;
  /**
   * A slug somebody asked for, if they did.
   *
   * Slugified rather than trusted: it arrives from a form, from an
   * import or from an agent's output, and a request for `PR Review` is
   * a request for `pr-review` rather than an error — the caller that
   * wants a malformed slug refused reads `readSkillDraft` instead.
   */
  slug?: string | null;
}

/**
 * Names a batch of skills, in order, avoiding each other and `taken`.
 *
 * Deterministic in the strict sense: same requests and same `taken`,
 * same array out, every time. Nothing here reads a clock, a random
 * source or a directory — the second is what a caller must supply, and
 * supplying it is the whole seam this function exists to have.
 *
 * First come, first served, and a collision takes a number: `pr-review`,
 * then `pr-review-2`, then `pr-review-3`. Numbering rather than hashing
 * because a person reads these in a directory listing and has to be able
 * to tell which one they meant.
 */
export function allocateSkillSlugs(requests: readonly SkillSlugRequest[], taken: Iterable<string> = []): string[] {
  const used = new Set<string>(taken);
  return requests.map((request) => {
    const wanted = request.slug === undefined || request.slug === null || request.slug.trim() === "" ? slugifySkillName(request.name) : slugifySkillName(request.slug);
    return claim(wanted, used);
  });
}

/**
 * Takes `wanted` if it is free, or the first numbered variant that is.
 *
 * The stem is re-truncated for every suffix so the result still fits:
 * a 64-character name colliding for the hundredth time gives up two
 * characters, not none, and the slug stays under the ceiling instead of
 * quietly going over it.
 *
 * Terminates: every `attempt` produces a candidate no earlier one did —
 * each ends in `-<attempt>` — and `used` is finite.
 */
function claim(wanted: string, used: Set<string>): string {
  if (!used.has(wanted)) {
    used.add(wanted);
    return wanted;
  }

  for (let attempt = 2; ; attempt += 1) {
    const suffix = `-${attempt}`;
    const stem = trimHyphens(wanted.slice(0, SKILL_SLUG_MAX_LENGTH - suffix.length)) || FALLBACK_SKILL_SLUG;
    const candidate = `${stem}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}
