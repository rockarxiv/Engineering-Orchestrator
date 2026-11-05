import { describe, expect, it } from "vitest";
import { explainOutput, readCommitSha, readFileListing, readIndexReport, readSymbolListing, readSyncReport, readVersion } from "./output.js";

/**
 * Reading CodeWiki's own summaries (EO-146).
 *
 * The fixtures are transcripts, not inventions: every block below was
 * printed by v0.2.1 against a real repository and pasted in unedited,
 * down to the column alignment and the em dash. A parser tested against
 * output its author imagined is a parser that agrees with its author.
 *
 * What each case is really asserting is the refusal. These functions
 * answer null for anything they do not recognise, and the provider turns
 * null into a failed build — so a version whose summary line has moved
 * on is reported as "EO could not read this" rather than as an index
 * that is ready to query.
 */

/** `codewiki status --path <root>`, on a two-file TypeScript repository. */
const STATUS = `CodeWiki Index Status
  Root:              /tmp/cwexp
  Nodes:             4
  Edges:             3
  Files:             2
  Unresolved refs:   1
  DB size:           148 KB
  Journal mode:      wal

  Nodes by kind:
    function             2
    file                 2

  Files by language:
    TypeScript           2
`;

/**
 * `codewiki query nudgeFor --limit 4`, against this repository's own
 * index. Pasted unedited, column alignment and all.
 */
const QUERY = `KIND         LANGUAGE     NAME                                     LOCATION
--------------------------------------------------------------------------------
function     typescript   nudgeFor                                 /home/someone/.eo/worktrees/EO-173/apps/desktop/src/main/repositoryIntelligence/broadSearch.ts:751
`;

/** The same command against a name nothing is declared under. */
const QUERY_EMPTY = `No matches.\n`;

/** `codewiki files --prefix packages/core/src/agent-c`, footer included. */
const FILES = `LANGUAGE         SIZE  NODES  PATH
------------------------------------------------------------
TypeScript       4574      9  /home/someone/.eo/worktrees/EO-173/packages/core/src/agent-capabilities.ts

1 file(s) total.
`;

/** And when it is asked about a prefix it holds nothing under. */
const FILES_EMPTY = `No files indexed.\n`;

describe("what the index holds, read off a listing", () => {
  it("reads a symbol and its file out of a real query answer", () => {
    expect(readSymbolListing(QUERY)).toEqual([
      { name: "nudgeFor", path: "/home/someone/.eo/worktrees/EO-173/apps/desktop/src/main/repositoryIntelligence/broadSearch.ts" },
    ]);
  });

  it("reads the files out of a real listing, and skips its header, rule and footer", () => {
    expect(readFileListing(FILES)).toEqual([
      {
        name: "/home/someone/.eo/worktrees/EO-173/packages/core/src/agent-capabilities.ts",
        path: "/home/someone/.eo/worktrees/EO-173/packages/core/src/agent-capabilities.ts",
      },
    ]);
  });

  it("tells 'it holds nothing like that' apart from 'EO could not read the answer'", () => {
    // The distinction the caller depends on. Both end in no suggestion,
    // but only one of them is the index answering — and a version whose
    // table has moved on must not be read as an empty index, because
    // that is how a real answer becomes silence nobody notices.
    expect(readSymbolListing(QUERY_EMPTY)).toEqual([]);
    expect(readFileListing(FILES_EMPTY)).toEqual([]);
    expect(readSymbolListing("")).toBeNull();
    expect(readFileListing("")).toBeNull();
    expect(readSymbolListing(STATUS)).toBeNull();
    expect(readFileListing(QUERY)).toBeNull();
    expect(readSymbolListing(FILES)).toBeNull();
  });

  it("keeps a path with a space in it whole", () => {
    // EO's own fixtures put spaces in directory names on purpose,
    // because a repository path is user-controlled. Counting columns
    // from the right reads `/home/some one/repo/a.ts:9` as a symbol
    // called `some`, which is the kind of wrong that passes every test
    // written against a path without a space in it.
    const spaced = `KIND         LANGUAGE     NAME                                     LOCATION
--------------------------------------------------------------------------------
function     typescript   alpha                                    /home/some one/eo checkout/src/alpha.ts:1
`;
    expect(readSymbolListing(spaced)).toEqual([{ name: "alpha", path: "/home/some one/eo checkout/src/alpha.ts" }]);

    const spacedFiles = `LANGUAGE         SIZE  NODES  PATH
------------------------------------------------------------
TypeScript        128      1  /home/some one/eo checkout/src/alpha.ts

1 file(s) total.
`;
    expect(readFileListing(spacedFiles)?.[0]?.path).toBe("/home/some one/eo checkout/src/alpha.ts");
  });

  it("reads every row of a longer answer", () => {
    const many = `KIND         LANGUAGE     NAME                                     LOCATION
--------------------------------------------------------------------------------
interface    typescript   QuotaEvent                               /repo/packages/core/src/agent-provider.ts:311
function     typescript   worthSuggesting                          /repo/apps/desktop/src/main/repositoryIntelligence/broadSearch.ts:887
function     typescript   refusal                                  /repo/apps/desktop/src/main/repositoryIntelligence/codewiki/provider.ts:283
`;
    expect(readSymbolListing(many)?.map((hit) => hit.name)).toEqual(["QuotaEvent", "worthSuggesting", "refusal"]);
  });
});

describe("what the index says it holds", () => {
  it("reads the counters out of a real status block", () => {
    expect(readIndexReport(STATUS)).toEqual({ files: 2, nodes: 4, edges: 3 });
  });

  it("reads an index that is initialised and empty, which is a fact rather than an absence", () => {
    // The state between `init` and `index`, and also a repository with
    // nothing in a language CodeWiki parses. There *is* an index here;
    // it describes nothing. Calling that unreadable would send the
    // service round a loop rebuilding something that is already what it
    // is going to be.
    const empty = "CodeWiki Index Status\n  Nodes:             0\n  Edges:             0\n  Files:             0\n";

    expect(readIndexReport(empty)).toEqual({ files: 0, nodes: 0, edges: 0 });
  });

  it("refuses output that is not a status block", () => {
    expect(readIndexReport("")).toBeNull();
    expect(readIndexReport("no index found at /tmp/x/.codewiki/codewiki.db; run `codewiki init` first")).toBeNull();
    // Half a summary — output cut short, or a bounded capture that kept
    // the wrong end. Two counters out of three is not an index EO has
    // read, and reporting one would be the guess this module exists to
    // refuse.
    expect(readIndexReport("CodeWiki Index Status\n  Nodes:             4\n  Edges:             3\n")).toBeNull();
  });

  it("refuses counter-shaped lines with no status block above them", () => {
    // The shape on its own is not evidence. Anything can print three
    // numbers — a build script, a linter, a binary somebody configured
    // that is not CodeWiki — and without the signature there is nothing
    // to say the thing describing an index *was* the index. Read as one,
    // this output takes a checkout that was never indexed all the way to
    // READY.
    expect(readIndexReport("Files: 1\nNodes: 2\nEdges: 3\n")).toBeNull();
    expect(readIndexReport("  Files:             2\n  Nodes:             4\n  Edges:             3\n")).toBeNull();
    // And with it, the same numbers are an index.
    expect(readIndexReport("CodeWiki Index Status\nFiles: 1\nNodes: 2\nEdges: 3\n")).toEqual({ files: 1, nodes: 2, edges: 3 });
  });

  it("does not read a count out of a sentence that merely contains the word", () => {
    // Anchored to a line of its own, so a path or a message mentioning
    // files cannot become a number EO believes.
    expect(readIndexReport("Skipped Files: 12 of them, in fact\n")).toBeNull();
  });
});

describe("what a sync did", () => {
  it("reads the three counts and sums them into one changed-file count", () => {
    expect(readSyncReport("Sync complete: 0 added, 1 modified, 0 removed (2 ms)\n")).toEqual({
      added: 0,
      modified: 1,
      removed: 0,
      changedFileCount: 1,
    });
    expect(readSyncReport("Sync complete: 3 added, 2 modified, 1 removed (41 ms)\nResolved 7 references\n")).toEqual({
      added: 3,
      modified: 2,
      removed: 1,
      changedFileCount: 6,
    });
  });

  it("reads a sync that found nothing to do as a sync of nothing, not as unreadable output", () => {
    // Printed verbatim, em dash included. A handover where the
    // implementer changed nothing since the last sync is ordinary, and
    // failing it would fail the common case.
    expect(readSyncReport("Nothing to sync — index is up to date.\n")).toEqual({ added: 0, modified: 0, removed: 0, changedFileCount: 0 });
  });

  it("refuses output that reports no summary at all", () => {
    expect(readSyncReport("")).toBeNull();
    expect(readSyncReport("codewiki: Parsing…\nResolved 1 references\n")).toBeNull();
    expect(readSyncReport("Sync complete: some files changed\n")).toBeNull();
  });
});

describe("what version answered", () => {
  it("reads the version out of the binary's own answer", () => {
    expect(readVersion("codewiki 0.2.1\n")).toBe("0.2.1");
    expect(readVersion("  codewiki 12.7.3  ")).toBe("12.7.3");
  });

  it("answers null rather than guessing", () => {
    // Null is the port's "no opinion", and the service treats it as
    // exactly that: an index whose version cannot be established is left
    // alone rather than marked stale, because a machine that cannot
    // answer this cannot rebuild either.
    expect(readVersion("")).toBeNull();
    expect(readVersion("codewiki\n")).toBeNull();
    expect(readVersion("0.2.1\n")).toBeNull();
    // Said its version and then something else. A binary EO does not
    // understand is one EO has no version for, and the extra line is
    // exactly the case where reading the first half is a guess.
    expect(readVersion("codewiki 0.2.1\nwarning: this build is unsupported\n")).toBeNull();
  });

  /**
   * The disclosure this rule exists to make impossible.
   *
   * `provider_version` is the one value read out of a process's output
   * that EO *stores* — on the row, and from there onto a card — so a
   * permissive read here is not a wrong answer, it is somebody's source
   * on somebody's screen. A bounded suffix would have limited how much
   * of it came back; an alphabet of digits and dots decides that none of
   * it can.
   *
   * A pre-release version is the deliberate cost. `0.3.0-rc.1` reads as
   * null and the index keeps "no opinion" rather than a string whose
   * contents were somebody else's binary's decision.
   */
  it("cannot return a suffix, whoever printed it", () => {
    const secret = "SUPER_SECRET_TOKEN_abc123_that_lives_only_in_a_source_file";

    expect(readVersion(`codewiki 1.2.3-${secret}\n`)).toBeNull();
    expect(readVersion(`1.2.3-${secret}\n`)).toBeNull();
    expect(readVersion(`const pinned = "1.2.3-${secret}";\n`)).toBeNull();
    expect(readVersion(`codewiki 0.2.1\n  |  const pinned = "1.2.3-${secret}";\n`)).toBeNull();
    // And the shape that used to be accepted, now refused on principle
    // rather than on length.
    expect(readVersion("codewiki 1.0.0-rc.2\n")).toBeNull();
    expect(readVersion("codewiki 1.2.3-alpha\n")).toBeNull();
  });
});

describe("the commit a checkout is on", () => {
  it("reads a sha and nothing that is merely near one", () => {
    expect(readCommitSha("6f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6\n")).toBe("6f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6");
    expect(readCommitSha("  abc1234  ")).toBe("abc1234");
    // git answered with something else, or with nothing: an empty
    // checkout with no HEAD, an error on stdout, a detached message. None
    // of them is a commit, and storing one as if it were is how a row
    // ends up saying the index was built from a sentence.
    expect(readCommitSha("")).toBeNull();
    expect(readCommitSha("fatal: ambiguous argument 'HEAD'")).toBeNull();
    expect(readCommitSha("abc123 and then some words")).toBeNull();
    expect(readCommitSha("zzzzzzz")).toBeNull();
  });
});

describe("what EO says about output it did not expect", () => {
  it("answers a recognised diagnostic in EO's own words", () => {
    // v0.2.1's own messages, and the point is that none of these come
    // back as themselves: EO explains what they mean rather than
    // repeating what was printed.
    expect(explainOutput("", "no index found at /w/.codewiki/codewiki.db; run `codewiki init` first\n")).toBe(
      "CodeWiki reports there is no index in that directory yet.",
    );
    expect(explainOutput("Already initialized at /w\n", "")).toBe("CodeWiki reports an index directory is already there.");
    expect(explainOutput("", "indexing failed: found 3 source file(s) to index but indexed 0\n")).toBe(
      "CodeWiki reports that indexing failed and may have left the index incomplete.",
    );
  });

  it("answers anything else with how much was said, never with what was said", () => {
    expect(explainOutput("", "one\ntwo\n")).toBe("It printed 2 lines on stderr that EO does not recognise.");
    expect(explainOutput("only this\n", "")).toBe("It printed 1 line EO does not recognise.");
    expect(explainOutput("", "")).toBe("It printed nothing.");
    expect(explainOutput("  \n\n", "")).toBe("It printed nothing.");
  });

  /**
   * The whole reason this function exists.
   *
   * A parser that cannot read a file has the offending line in its hand,
   * and printing it is the helpful thing for a parser to do. What EO
   * returns reaches `repository_indexes.error_message` and from there a
   * comment on somebody's item, so the one thing that must never
   * survive this call is the text it was given.
   */
  it("never repeats a byte of what it was handed", () => {
    const secret = 'const apiKey = "sk-live-9d8f7a6b5c4d3e2f";';
    const complaint = `error: could not parse /w/src/keys.ts:1\n  |  ${secret}\n`;

    for (const explained of [explainOutput("", complaint), explainOutput(complaint, ""), explainOutput(complaint, complaint)]) {
      expect(explained).not.toContain(secret);
      expect(explained).not.toContain("sk-live");
      expect(explained).not.toContain("apiKey");
    }
  });
});

/**
 * The general form of the bug this module has now been given twice.
 *
 * Each reader was tightened after somebody found output it would repeat:
 * a status block that was only three numbers, a version that was
 * anything without a space in it. The pattern behind both is that a
 * reader's *return type* was never the thing being constrained — so this
 * asserts the property directly, of all of them at once, and will fail
 * on the next reader added with a permissive capture in it.
 *
 * **The two listing readers are deliberately not in the list below, and
 * adding them would be asserting the wrong thing** (EO-173). They exist
 * to carry names and paths out of an index, so a promise that they
 * cannot repeat what they were shown is a promise they are built to
 * break. Their guarantee is about where what they return can *go*, which
 * is not a property of this module: `provider.test.ts` asserts it, by
 * showing that what comes back is two fields, both consumed by a
 * boolean, and that nothing carrying either reaches a sentence, a
 * comment or a row.
 */
describe("nothing any reader returns can carry what it was given", () => {
  const SECRET = "SUPER_SECRET_TOKEN_abc123_that_lives_only_in_a_source_file";

  const HOSTILE = [
    `codewiki 1.2.3-${SECRET}`,
    `1.2.3-${SECRET}`,
    `CodeWiki Index Status\n  Files:             1\n  Nodes:             2\n  Edges:             3\n  Root: ${SECRET}\n`,
    `Sync complete: 1 added, 0 modified, 0 removed (1 ms) ${SECRET}\n`,
    `Nothing to sync — ${SECRET}\n`,
    `abc1234${SECRET}`,
    `error: could not parse /w/src/keys.ts:1\n  |  const key = "${SECRET}";\n`,
    `no index found at /w/${SECRET}/.codewiki/codewiki.db\n`,
    SECRET,
  ];

  it("holds for every reader, on output built to break each of them", () => {
    for (const hostile of HOSTILE) {
      // Structured readers answer in numbers, so there is nothing for a
      // string to survive in; the two that answer in strings answer in
      // alphabets that cannot spell one.
      expect(JSON.stringify(readIndexReport(hostile))).not.toContain(SECRET);
      expect(JSON.stringify(readSyncReport(hostile))).not.toContain(SECRET);
      expect(readVersion(hostile) ?? "").not.toContain(SECRET);
      expect(readCommitSha(hostile) ?? "").not.toContain(SECRET);
      expect(explainOutput(hostile, hostile)).not.toContain(SECRET);
    }
  });

  it("holds because of what they can answer, not because of what they were shown", () => {
    // The stronger statement, and the one that survives an input nobody
    // thought of: whatever comes back from the two string-valued readers
    // is drawn from an alphabet with no letters in it beyond the word
    // this file already knows.
    for (const hostile of [...HOSTILE, "codewiki 0.2.1", "6f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6"]) {
      const version = readVersion(hostile);
      if (version !== null) expect(version).toMatch(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
      const sha = readCommitSha(hostile);
      if (sha !== null) expect(sha).toMatch(/^[0-9a-f]{7,64}$/);
    }
  });
});
