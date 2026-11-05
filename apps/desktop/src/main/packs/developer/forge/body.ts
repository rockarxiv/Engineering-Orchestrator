/**
 * Composing what the pull request says (F-06).
 *
 * Pure, and deliberately so: this is the part most worth testing, and it
 * should not need a repository, a network or an agent to run.
 *
 * Two halves. The prose is the agent's — the reviewer filled the
 * repository's template, or wrote a description where there is none.
 * The facts below it are EO's, and every one of them is derived from
 * something recorded rather than something claimed.
 */

/** Machine-derived, every field. Nothing here comes from an agent's word for it. */
export interface PullRequestFacts {
  itemKey: string;
  itemTitle: string;
  branch: string;
  baseBranch: string;
  acceptanceCriteria: string[];
  /**
   * What G-02 actually ran and what it found — from `runs.verification`,
   * never from `ImplementOutput.tests_run`.
   *
   * The implementer *claims* it ran the tests. The verifier ran them.
   * Invariant #5 is the difference, and a pull request repeating a claim
   * as though it were a check is exactly the kind of thing that makes
   * the claim worth nothing.
   */
  checks: { name: string; passed: boolean }[];
  jiraKey: string | null;
  jiraUrl: string | null;
  /**
   * The Reference that names this work (EO-638) — the item's own, or its
   * feature's when the item has no Jira key of its own — or null when
   * the work is named by the Jira key or the EO key. When set, it is
   * the title's name and the facts block names nothing else: no EO key,
   * no Jira key, and no branch, which carries the EO key.
   */
  reference: string | null;
}

export interface BuildPullRequestBodyInput {
  /** The reviewer's prose: the filled template, or a description. Absent is normal and handled. */
  agentBody?: string | null;
  /** The repository's template, used unfilled when the agent supplied nothing. */
  template?: string | null;
  /** The implementer's own summary — the last resort before the item's body. */
  implementSummary?: string | null;
  itemBody?: string | null;
  facts: PullRequestFacts;
}

export interface PullRequestBody {
  text: string;
  /** True when no agent wrote the prose, so the item can say so. */
  fallback: boolean;
}

/** GitLab has no `--description-file`, so the body travels as an argv entry. Windows caps a command line at 32767. */
export const MAX_BODY_CHARS = 20_000;

export function buildPullRequestTitle(facts: PullRequestFacts): string {
  return `${facts.reference ?? facts.jiraKey ?? facts.itemKey}: ${facts.itemTitle}`;
}

export function buildPullRequestBody(input: BuildPullRequestBodyInput): PullRequestBody {
  const chosen = choseProse(input);
  const body = `${chosen.prose.trim()}\n\n---\n\n${factsBlock(input.facts)}`;

  return {
    text: body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n\n_(truncated by EO)_` : body,
    fallback: chosen.fallback,
  };
}

/**
 * The prose, in order of how much anyone should trust it.
 *
 * An unfilled template beats a written-from-scratch paragraph when the
 * repository has one: a repository that requires a template usually has CI
 * checking its headings, and headings a human completes are better than
 * a body that fails the check.
 */
function choseProse(input: BuildPullRequestBodyInput): { prose: string; fallback: boolean } {
  const agent = input.agentBody?.trim();
  if (agent) return { prose: agent, fallback: false };

  const template = input.template?.trim();
  if (template) return { prose: template, fallback: true };

  const summary = input.implementSummary?.trim();
  if (summary) return { prose: summary, fallback: true };

  const itemBody = input.itemBody?.trim();
  if (itemBody) return { prose: itemBody, fallback: true };

  return { prose: "_No description was written for this change._", fallback: true };
}

/**
 * The block EO signs its name to.
 *
 * Delimited by an HTML comment so a later version can find and replace
 * it without touching whatever a human has added underneath.
 */
function factsBlock(facts: PullRequestFacts): string {
  // Under a Reference the key line is the Reference alone: the branch
  // contains the EO key, and the forge already shows both branches.
  const lines = [
    "<!-- eo:facts -->",
    facts.reference !== null ? `**${facts.reference}**` : `**${facts.itemKey}** · \`${facts.branch}\` → \`${facts.baseBranch}\``,
  ];

  if (facts.acceptanceCriteria.length > 0) {
    lines.push("", "**Acceptance criteria**", ...facts.acceptanceCriteria.map((criterion) => `- ${criterion}`));
  }

  if (facts.checks.length > 0) {
    const rendered = facts.checks.map((check) => `${check.name} ${check.passed ? "✓" : "✗"}`).join(" · ");
    lines.push("", `**Checks** — ${rendered}`);
  }

  if (facts.jiraKey && facts.reference === null) {
    lines.push("", `**Jira** — ${facts.jiraUrl ? `[${facts.jiraKey}](${facts.jiraUrl})` : facts.jiraKey}`);
  }

  // Deliberately no "Fixes #123": EO has no issue number, and a guess
  // auto-closes someone else's issue the moment this is merged.
  lines.push("", "Opened by EO.");
  return lines.join("\n");
}
