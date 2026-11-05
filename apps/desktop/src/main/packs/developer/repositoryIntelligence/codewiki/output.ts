/**
 * Reading what CodeWiki says, as against what it exits with (EO-141).
 *
 * An exit status is a claim that a process finished, and this feature
 * needs two things an exit status cannot carry: whether there is an
 * index to query, and how much work a sync did. Invariant #5 covers a
 * subprocess as squarely as it covers an agent — where EO can check for
 * itself, it must — so the answers come from what the tool reports about
 * its own index and are parsed here, in a pure module, where each shape
 * is a case a test can name.
 *
 * Every function answers with null for output it does not recognise,
 * and null is a failure the caller reports rather than a shrug. A
 * summary line that changed shape means EO is reading a version it does
 * not know, and reporting "indexed successfully" on the strength of an
 * exit code is precisely the trust this module exists to withhold.
 *
 * The shapes are v0.2.1's, taken from the CLI's own source and confirmed
 * by running it — `commands/status.rs`, `commands/sync.rs`. They are
 * matched loosely enough to survive whitespace and a trailing detail and
 * no more: a pattern that would match anything would report a number
 * nobody produced.
 *
 * `explainOutput` at the foot of this file is the other half of the same
 * job and the more important half. Reading is how EO learns what
 * happened; explaining is how EO says so without ever repeating a byte
 * the tool printed, because what a provider returns ends up in a comment
 * and a source file must never get there.
 */

/** What the tool says its index currently holds. */
export interface IndexReport {
  files: number;
  nodes: number;
  edges: number;
}

/** What one update did. */
export interface SyncReport {
  added: number;
  modified: number;
  removed: number;
  /**
   * The three of them together: what "how many files changed" means to
   * whoever asked.
   *
   * Summed here rather than at the call site so that every caller means
   * the same thing by it, including the measurement story that will
   * read these rows without having watched a sync.
   */
  changedFileCount: number;
}

function count(stdout: string, label: string): number | null {
  // Anchored to the start of a line so a count is read from the tool's
  // own summary rather than from a path or a message that happens to
  // contain the word.
  const match = new RegExp(`^\\s*${label}:\\s+(\\d+)\\s*$`, "m").exec(stdout);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * The line `codewiki status` opens its report with.
 *
 * Required, and not merely for tidiness. Three counter-shaped lines are
 * a shape anything can print — a build script, a linter, a binary
 * somebody configured that is not CodeWiki at all — and without a
 * signature to anchor on, `Files: 1 / Nodes: 2 / Edges: 3` on stdout
 * from a process that exited 0 would be read as a healthy index and
 * carried all the way to READY. The counters say how big the index is;
 * this says the thing describing it was the index.
 */
const STATUS_SIGNATURE = /^CodeWiki Index Status\s*$/m;

/**
 * The index's own description of itself, or null when the output is not
 * one.
 *
 * The signature and all three counters are required. Any subset would
 * match half a summary — output cut short by a crash, or by a bounded
 * capture that kept the wrong end — and a half-read summary is exactly
 * the case where reporting "there is an index here" would be a guess.
 */
export function readIndexReport(stdout: string): IndexReport | null {
  if (!STATUS_SIGNATURE.test(stdout)) return null;
  const files = count(stdout, "Files");
  const nodes = count(stdout, "Nodes");
  const edges = count(stdout, "Edges");
  if (files === null || nodes === null || edges === null) return null;
  return { files, nodes, edges };
}

/**
 * What a sync did, or null when the output does not say.
 *
 * Two shapes, and the second is not a failure: a sync that found
 * nothing to do prints a sentence rather than a row of zeroes, and
 * reading that as unparseable would fail every handover where the
 * implementer changed nothing.
 */
export function readSyncReport(stdout: string): SyncReport | null {
  const summary = /^Sync complete:\s*(\d+) added,\s*(\d+) modified,\s*(\d+) removed\b/m.exec(stdout);
  if (summary) {
    const [added, modified, removed] = [Number(summary[1]), Number(summary[2]), Number(summary[3])];
    return { added, modified, removed, changedFileCount: added + modified + removed };
  }
  // Matched on the opening words alone: the rest of that line carries an
  // em dash, and a pattern that depended on it would be one encoding
  // accident away from reporting a healthy no-op as unreadable output.
  if (/^Nothing to sync\b/m.test(stdout)) return { added: 0, modified: 0, removed: 0, changedFileCount: 0 };
  return null;
}

/**
 * The entire answer `codewiki --version` is allowed to give.
 *
 * Anchored at both ends and matched against the whole of what the
 * process printed, not searched for inside it. A binary that prints its
 * version *and* something else has said something EO does not
 * understand, and the safe reading of that is no reading at all.
 *
 * The capture is digits and dots. That is the part that matters, and it
 * is a different guarantee from the one this had before: a *bounded*
 * suffix limits how much of somebody's source can come back, an
 * *alphabet* decides whether any of it can. `1.2.3-SUPER_SECRET_TOKEN`
 * is not a version this can return, however it was printed and whatever
 * surrounded it.
 *
 * The shape is upstream's own — clap prints `<crate name> <version>`,
 * and `binary/version.test.ts` already asserts the real binary answers
 * exactly `codewiki 0.2.1`.
 */
const VERSION_ANSWER = /^codewiki (\d{1,4}\.\d{1,4}\.\d{1,4})$/;

/**
 * The version the binary answers with, or null when it did not answer
 * with one.
 *
 * Asked only of a binary somebody configured by hand: what EO
 * downloaded is the version EO pinned, and resolution says so without
 * spawning anything. A configured path is somebody else's build, and
 * the difference decides whether an index built by it is recorded as
 * skew or as nothing at all.
 *
 * This is the one value read out of a process's output that EO *stores*
 * — `repository_indexes.provider_version`, from there onto a card — so
 * it is the one place where a permissive read is not a wrong answer but
 * a disclosure. Hence an allowlist rather than a filter: a pre-release
 * build like `0.3.0-rc.1` is deliberately not recognised and comes back
 * null, which the service already treats as "no opinion" and leaves
 * alone. The cost is a machine that cannot detect skew against an
 * unusual build; the alternative is a field whose contents depend on
 * what somebody else's binary decided to print.
 */
export function readVersion(stdout: string): string | null {
  return VERSION_ANSWER.exec(stdout.trim())?.[1] ?? null;
}

/**
 * The commit a checkout sits on, or null when git did not answer with
 * one.
 *
 * Git rather than CodeWiki, and validated all the same. This is the one
 * other place a subprocess's output becomes a value EO stores, and the
 * rule this module exists to make checkable is that *every* byte a
 * subprocess printed passes through here before it can become a value or
 * a sentence — `provider.test.ts` asserts exactly that, by stripping
 * these calls out of the provider and finding no stream left. A rule
 * with an exception in it is a rule nobody can check.
 *
 * The shape is what makes it safe: hexadecimal, one line, nothing else.
 * A `rev-parse` that answered with an error, an empty checkout with no
 * HEAD, or anything else surprising is null rather than a string EO
 * would go on to call a commit.
 */
export function readCommitSha(stdout: string): string | null {
  return /^[0-9a-f]{7,64}$/.exec(stdout.trim())?.[0] ?? null;
}

/**
 * One thing an index listing named: what it is called, and where it is
 * (EO-173).
 *
 * Absolute, exactly as the tool printed it. Making it relative needs the
 * checkout root, which this module deliberately does not have — a parser
 * that resolved paths would be a parser with an opinion about which
 * checkout it was reading.
 */
export interface IndexListing {
  name: string;
  path: string;
}

/**
 * Reading a listing the tool prints for a person, and why that is worth
 * doing at all (EO-173).
 *
 * The interception has to know whether the index holds the thing an
 * agent is searching for *before* it suggests looking there, and the
 * pinned version has no machine-readable output — no `--json`, no
 * `--format`. So what there is to read is a fixed-column table, and
 * reading it is this module's job for the same reason reading a sync
 * summary is: invariant #5 says EO checks rather than trusts, and a
 * check whose parser lives at the call site is a parser nobody tests.
 *
 * **Three shapes, and everything else is null.** A table with the header
 * the tool prints; the sentence it prints when it found nothing, which
 * is an *answer* and comes back as the empty list; and anything else,
 * which is a version whose output has moved or a binary that is not
 * CodeWiki, and comes back as null. Null is not an error to report here
 * — the one caller turns it into silence — but it must not be confused
 * with an empty index, because "the index holds nothing matching" and
 * "EO could not read the answer" would otherwise both read as "say
 * nothing about something that is really there".
 *
 * **Rows are matched, not split.** A path may contain spaces — EO's own
 * gate fixtures put them in directory names on purpose — so the columns
 * before the path are matched as runs of non-space and the path takes
 * the whole of the rest of the line. Splitting on whitespace and
 * counting from the end reads `/home/some one/repo/a.ts:9` as a symbol
 * called `some`, which is the kind of wrong that looks right in a test
 * written against a path without a space in it.
 *
 * A line that does not match a row is skipped rather than failing the
 * parse: the rule under the header and the `55 file(s) total.` footer
 * are lines, and neither is a row.
 */
const QUERY_HEADER = /^KIND\s+LANGUAGE\s+NAME\s+LOCATION\s*$/m;

/** What `codewiki query` prints when the index holds nothing like it. */
const QUERY_FOUND_NOTHING = /^No matches\.\s*$/m;

/**
 * `<kind> <language> <name> <path>:<line>`.
 *
 * The trailing line number is required, because it is what tells a row
 * apart from a sentence with four words in it. It is then discarded: a
 * suggestion is about which call to make, and the agent gets the line
 * from the index itself.
 */
const QUERY_ROW = /^(?:\S+)\s+(?:\S+)\s+(\S+)\s+(\S.*):\d+$/;

/** What `codewiki files` prints above its listing. */
const FILES_HEADER = /^LANGUAGE\s+SIZE\s+NODES\s+PATH\s*$/m;

/** And when it holds none at all. */
const FILES_FOUND_NOTHING = /^No files indexed\.\s*$/m;

/** `<language> <size> <nodes> <path>`, the two counts being what tells it from the footer. */
const FILES_ROW = /^(?:\S+)\s+\d+\s+\d+\s+(\S.*?)\s*$/;

function rowsOf<T>(stdout: string, read: (line: string) => T | null): T[] {
  const found: T[] = [];
  for (const line of stdout.split("\n")) {
    const row = read(line.trimEnd());
    if (row !== null) found.push(row);
  }
  return found;
}

/**
 * The symbols `codewiki query` answered with, or null when that output
 * was not one of its answers.
 *
 * The names come back as the index holds them rather than as the caller
 * asked, which is the whole point: this tool matches loosely, and
 * `quota` answering with `QuotaEvent` is a fact the caller has to be
 * able to see in order to reject.
 */
export function readSymbolListing(stdout: string): IndexListing[] | null {
  if (QUERY_FOUND_NOTHING.test(stdout)) return [];
  if (!QUERY_HEADER.test(stdout)) return null;
  return rowsOf(stdout, (line) => {
    const row = QUERY_ROW.exec(line);
    return row === null ? null : { name: row[1] as string, path: row[2] as string };
  });
}

/**
 * The files `codewiki files` listed, or null when that output was not a
 * listing.
 *
 * A file's name is its path, which is what the index holds it under and
 * all a caller could compare against a filename pattern.
 */
export function readFileListing(stdout: string): IndexListing[] | null {
  if (FILES_FOUND_NOTHING.test(stdout)) return [];
  if (!FILES_HEADER.test(stdout)) return null;
  return rowsOf(stdout, (line) => {
    const row = FILES_ROW.exec(line);
    return row === null ? null : { name: row[1] as string, path: row[1] as string };
  });
}

/**
 * What CodeWiki said about a failure — in EO's words, never its own.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE, and the reason nothing else
 * in this directory ever interpolates `stdout` or `stderr` into a
 * sentence: what a provider returns reaches `repository_indexes.error_message`,
 * a comment on the item and a card on the board, and a diagnostic that
 * quotes the line it choked on would carry somebody's source there with
 * it. EO-141 is explicit — paths and counts, never bodies — and a rule
 * kept by remembering to sanitise each new message is a rule that lasts
 * until the next message.
 *
 * So the output is *classified*, not quoted. A recognised diagnostic
 * comes back as EO's own sentence about it; anything else comes back as
 * a count of lines, which says how much the tool had to say without
 * saying any of it. The failure EO already knows about — the exit
 * status, the timeout, the binary that would not start — is the
 * caller's to add, and that part is EO's sentence too.
 *
 * The cost is real and worth naming: an unrecognised failure loses the
 * detail that would have explained it, and somebody debugging one is
 * left with a shape rather than a message. The alternative is a
 * guarantee that holds only until a tool prints something nobody
 * predicted, which is not a guarantee.
 *
 * The patterns are v0.2.1's own messages, read from its source rather
 * than guessed at. A version whose wording has moved on falls through to
 * the count, which is safe and says less — the right direction for this
 * to fail in.
 */
const DIAGNOSTICS: ReadonlyArray<{ pattern: RegExp; meaning: string }> = [
  { pattern: /\bno index found\b/i, meaning: "CodeWiki reports there is no index in that directory yet." },
  { pattern: /\balready initiali[sz]ed\b/i, meaning: "CodeWiki reports an index directory is already there." },
  { pattern: /\bindexing failed\b/i, meaning: "CodeWiki reports that indexing failed and may have left the index incomplete." },
  { pattern: /\bno source files? to index\b/i, meaning: "CodeWiki reports the checkout holds nothing it can index." },
];

function countLines(text: string): number {
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

function lines(count: number): string {
  return count === 1 ? "1 line" : `${count} lines`;
}

export function explainOutput(stdout: string, stderr: string): string {
  for (const { pattern, meaning } of DIAGNOSTICS) {
    if (pattern.test(stderr) || pattern.test(stdout)) return meaning;
  }
  // stderr first: a tool that failed explains itself there, and saying
  // which stream had the output is a fact about the shape of the
  // failure rather than about its content.
  const complaints = countLines(stderr);
  if (complaints > 0) return `It printed ${lines(complaints)} on stderr that EO does not recognise.`;
  const spoke = countLines(stdout);
  if (spoke > 0) return `It printed ${lines(spoke)} EO does not recognise.`;
  return "It printed nothing.";
}
