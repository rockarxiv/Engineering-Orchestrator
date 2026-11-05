import type { RepositoryIndexAnswers, RepositoryIndexHit, RepositoryIndexQuestion } from "@eo/core";

/*
 * The question an adapter asks about one tool call, and the answer it
 * carries back (EO-165, KAN-126).
 *
 * These were declared in `claude.ts` while Claude's was the only adapter
 * that delivered a nudge. Codex's delivers the same one (EO-379), so they
 * sit beside both: one judgement, supplied by the composition root, and
 * two deliveries that must not each have a shape of their own for it.
 */

/**
 * One tool call, and what this turn knows about its index, as the
 * question a `SearchNudge` is asked.
 *
 * The shape `repositoryIntelligence/broadSearch.ts`'s `NudgeRequest`
 * has, declared here so the adapter names what it needs without naming
 * where it comes from: a nudge that satisfies this is one the adapter
 * can carry, whichever pack wrote it.
 */
export interface SearchNudgeRequest {
  /** The tool name the backend reports — `Bash`, `Grep`, `Glob`. */
  tool: string;
  /** Its arguments, unvalidated, straight off the wire. */
  input: unknown;
  /** The index's own tool names, from the provider that supplied the server. */
  answers: RepositoryIndexAnswers;
  /** How to ask the index whether it holds what this search is after (EO-173). */
  knows: (question: RepositoryIndexQuestion) => Promise<RepositoryIndexHit[]>;
  /** Turns a bare tool name into the id this backend's model actually sees. */
  qualify: (tool: string) => string;
  /** The checkout the agent works in, so a path naming it reads as the whole tree. */
  root: string;
}

/**
 * What a nudge decided: the sentence, and the classification that
 * produced it, so the record of the firing (EO-168) and the model are
 * told the same thing.
 */
export interface SearchNudgeInterception {
  /** What the search was asking for, in the classifier's own vocabulary. */
  kind: string;
  /** What it was looking for, when the command said. Null for a bare tree walk. */
  needle: string | null;
  /** What the agent is told, verbatim. */
  nudge: string;
}

/** The whole decision, as one call: what to say about this tool call, or nothing. */
export type SearchNudge = (request: SearchNudgeRequest) => Promise<SearchNudgeInterception | null>;
