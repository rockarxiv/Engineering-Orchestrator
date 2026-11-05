/**
 * Whether a path in the index is one the agent's search was looking for
 * (EO-173).
 *
 * **Why this exists at all.** The interception asks the index whether it
 * holds what a search is after before it suggests querying it, and half
 * of what a search is after is a *filename pattern* — `find . -name
 * '*.test.ts'`, `Glob **\/*.ts`, `fd claudeSdk`. The pinned CodeWiki has
 * no glob query: `files` lists what it holds and `--prefix` narrows by
 * directory, so the matching is EO's to do. Doing it here rather than
 * inline in the provider is what makes each rule below a case a test can
 * name.
 *
 * **It is deliberately the provider's answer, not the port's.** The port
 * asks a question in EO's own words and each implementation answers it
 * however its index is actually asked; an index that can match globs
 * itself should do that instead of listing everything past this
 * function. Nothing above the port imports this.
 *
 * **The semantics are the ones the agent typed**, which is the only
 * defensible reading of a pattern EO did not invent:
 *
 *  - A pattern with no separator in it matches the *filename*, because
 *    that is what `find -name` and `fd` match. `claude.ts` is a question
 *    about a file called that, wherever it is.
 *  - A pattern with a separator matches the whole path relative to the
 *    checkout, because that is what a glob is. `src/**\/*.ts` is a
 *    question about a place.
 *  - `*` crosses no separator and `**` crosses any number, which is the
 *    one convention every glob implementation agrees on.
 *
 * **A pattern it cannot read matches nothing**, and nothing is what the
 * caller turns into silence. This is a check on whether a suggestion is
 * worth making, so failing to understand the question has to end in not
 * making one — the alternative is guessing, and guessing wrong is the
 * entire cost this story is paying to avoid.
 */

/**
 * How long a pattern may be before it is refused outright.
 *
 * A bound rather than a judgement. This compiles a caller-supplied
 * string into a regular expression and runs it against every path in the
 * index, inside a hook a tool call is waiting on; a pattern nobody would
 * type is not worth the backtracking. Real ones are under twenty
 * characters.
 */
const LONGEST_PATTERN = 200;

/**
 * The glob's own syntax, and everything that means something to a
 * regular expression but nothing to a glob.
 *
 * One expression so that the rewrite is one pass: whichever alternative
 * matches at a position is the one that gets replaced, and nothing a
 * replacement produces is looked at again.
 */
const GLOB_TOKEN = /\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g;

/**
 * The pattern as a regular expression over a path, or null when it is
 * not one this understands.
 *
 * One pass with one alternation, rather than a chain of replacements
 * through a placeholder. A chain has to park `**` somewhere while `*` is
 * rewritten, and every character available to park it in is a character
 * a filename is allowed to contain — the version of this that used one
 * left the placeholder itself in the output.
 *
 * The order inside the alternation is the whole of the correctness here:
 * `**\/` is offered before `**`, and `**` before `*`, so the longest
 * spelling wins. Read the other way round, `src/**\/*.ts` is two
 * separator-refusing stars and matches only what sits directly in `src`.
 */
function asRegExp(pattern: string): RegExp | null {
  if (pattern === "" || pattern.length > LONGEST_PATTERN) return null;
  const source = pattern.replace(GLOB_TOKEN, (token) => {
    // `**/` swallows the separator with it, so `**/*.ts` is every `.ts`
    // in the tree rather than only the nested ones.
    if (token === "**/") return "(?:.*/)?";
    if (token === "**") return ".*";
    if (token === "*") return "[^/]*";
    if (token === "?") return "[^/]";
    // Everything else the alternation matches is a character a regular
    // expression would act on and a glob would not.
    return `\\${token}`;
  });
  try {
    return new RegExp(`^${source}$`);
  } catch {
    return null;
  }
}

/** The last segment of a path, which is what `find -name` and `fd` match against. */
function filenameOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? path : path.slice(at + 1);
}

/**
 * Does this checkout-relative path answer that filename pattern?
 *
 * Both spellings of a separator are normalised on the way in, so a path
 * the tool printed with backslashes on Windows is matched by a pattern
 * the agent typed with forward ones.
 */
export function matchesFilePattern(path: string, pattern: string): boolean {
  const wanted = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  const expression = asRegExp(wanted);
  if (expression === null) return false;
  const normalised = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return wanted.includes("/") ? expression.test(normalised) : expression.test(filenameOf(normalised));
}
