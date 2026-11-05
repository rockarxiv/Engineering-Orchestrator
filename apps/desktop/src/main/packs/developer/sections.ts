import { ATTACHMENT_ADD_TOOL_NAME, CLARIFY_ACTION, eoToolName, GIT_WORKTREE_KIND, REFINE_ACTION } from "@eo/core";
import type { SectionRenderer } from "@eo/engine";
import { TICKET_FILES_DIRECTORY } from "./workspace/ticketFiles.js";

/**
 * The most of an output this section will inline (EO-298).
 *
 * The same bargain `MAX_SEED_COMMENT_CHARS` strikes in the engine, and
 * for a sharper reason: a git output is a whole diff, and a diff has no
 * natural size. Pasting an eighty-thousand-character one into a section
 * truncation is not allowed to touch would push the comment thread out
 * of the prompt to make room for it, and an agentic loop would pay for
 * it again on every turn.
 *
 * Generous enough to carry an ordinary story's change whole, and a
 * reviewer that meets the marker is a reviewer standing in the checkout
 * the diff was taken from — it can read the rest where it lives.
 */
const MAX_OUTPUT_SECTION_CHARS = 12_000;

const COMMENT_READ = eoToolName("comment_read");
const ATTACHMENT_READ = eoToolName("attachment_read");
const ATTACHMENT_ADD = eoToolName(ATTACHMENT_ADD_TOOL_NAME);

/**
 * Closes a code fence an excerpt cut in half.
 *
 * An output that is not prose arrives fenced — the supervisor wraps a
 * diff in one so that its `---`, `+++` and `@@` lines survive being read
 * as markdown. Cutting that body at a character count lands inside the
 * fence about as often as not, and the opening marker then has nothing
 * to close it: **everything below this section** — the acceptance
 * criteria, the thread, the census — reads as part of the code block,
 * because this section is anchored above all of them.
 *
 * Toggled on the marker rather than counted, since a fence is closed
 * only by one at least as long as the one that opened it, and a diff
 * legitimately contains shorter runs of backticks in its own added
 * lines.
 */
function closeCutFence(text: string): string {
  let open: string | null = null;
  for (const line of text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker === undefined) continue;
    if (open === null) open = marker;
    else if (marker[0] === open[0] && marker.length >= open.length) open = null;
  }
  return open === null ? text : `${text}\n${open}`;
}

/**
 * The four prompt sections that are this pack's opinion rather than
 * EO's (ARCHITECTURE.md, "The core is domain-neutral", KAN-161).
 *
 * They were written into `packages/engine/src/context.ts`, which made
 * the engine's prompt assembly know that work is judged against
 * acceptance criteria, that an agent has a checkout somebody can
 * inspect afterwards, and that `refine` means two different things
 * depending on whether the item decomposes. None of that is true of an
 * installation that drafts weekly reports, and all of it is true of this
 * one — so it lives here, beside the hook that does the checking and the
 * gate that enforces the criteria.
 *
 * The words are unchanged and so is where they land: each renderer is
 * anchored after the engine section it used to be part of, and the
 * assembled prompt is byte-identical to the one EO sent before.
 */
export const developerSectionRenderers: SectionRenderer[] = [
  /**
   * What `refine` means when the work arrived already written (KAN-19).
   *
   * The product owner's prompt has one `refine` section and it describes
   * decomposition, because until this existed `refine` only ever met a
   * feature. An imported issue reaches the same pipeline stage with the
   * same role and the same action, and asking it to decompose would
   * produce stories nobody wanted out of a story someone already wrote.
   *
   * So the task is restated here rather than switched on in the prompt
   * file: this section is the whole difference, it appears only for the
   * dispatch it applies to, and a container's prompt is byte-identical
   * to what it was.
   *
   * Which dispatches those are is the type's answer and not this file's
   * (KAN-163). It asked whether the item was a container until now, and a
   * flag cannot tell a leaf that is checked apart from a leaf whose
   * `refine` a pack gave some third meaning (ARCHITECTURE.md, "An item type is data"). So it
   * asks what shape *this* run must answer in: these are the words that
   * go with the clarify shape, and a type answering in any other shape
   * gets whatever words go with that one. Still `refine` only, because
   * the paragraph tells an agent to ignore the `refine` section of its
   * instructions, which is a sentence about that action and no other.
   */
  {
    id: "clarify",
    after: "task",
    // `packAction` first (EO-422): a role that defined `refine` for
    // itself answers in its own shape, whatever the type's override
    // says the pack's `refine` answers in, and has no `refine` section
    // of this pack's to be told to ignore.
    render: ({ action, item, packAction }) =>
      !packAction || action !== REFINE_ACTION || item.actionOverrides.get(action)?.schema !== CLARIFY_ACTION
        ? null
        : [
            "## This is already written — do not decompose it",
            "",
            "This ticket was not produced by decomposing a feature. A person wrote it, and it is being brought in as it stands. Ignore the `refine` section of your instructions: you are not producing stories, and producing them would replace their work with your own.",
            "",
            "Your only job is to decide whether it can be implemented as written. Read it and the whole thread, and read the code where the answer is in the code — a question the codebase can answer is not a question for a person.",
            "",
            "If something genuinely cannot be settled without them — a scope boundary, a decision between readings that changes the design, an acceptance criterion that cannot be checked — return `{ \"outcome\": { \"status\": \"clarification_required\", \"questions\": [...] } }` rather than writing a comment. Your run ends there and the ticket waits until every question you asked has an answer, so ask all of them at once.",
            "",
            "If it can be implemented as written, return your result. Do not ask a question you could answer yourself, and do not ask one to be safe: every question here stops the work and waits for a human.",
          ].join("\n"),
  },
  /**
   * What makes plan mode's instruction more than a request (KAN-18).
   *
   * The engine's plan-mode section asks the implementer to change
   * nothing; this is the sentence that says the promise is checked, and
   * it is here because the checking is — `worktreeIsClean`, a hook this
   * same pack supplies. An installation with no workspace to inspect
   * would be claiming a verification nobody performs (invariant 5).
   *
   * Anchored after the plan-mode section and rendered on exactly the
   * dispatches it is, so the text reads as its closing line, which is
   * what it was.
   */
  {
    id: "planModeCheck",
    after: "planMode",
    // On exactly the dispatches the engine's plan-mode section is, which
    // since EO-422 leaves out an `implement` the dispatched role defined
    // for itself: nothing asked that run to hold off, and the git kind
    // checks nothing of it.
    render: ({ action, planMode, packAction }) =>
      planMode && packAction && action === "implement"
        ? "The worktree is checked after this run: leaving changes in it is a failure of this instruction, not a head start."
        : null,
  },
  /**
   * What the work is judged against (EO-213, EO-200).
   *
   * A story states its acceptance criteria and a review is dispatched to
   * hold it to them — the same list `createDispatchGate` refuses a
   * review without and `reviewCoverage` checks a verdict against. Every
   * dispatch gets it, not only the review: an implementer that cannot
   * read what it will be judged by is being asked to guess.
   */
  /**
   * What the last step produced, and what this one works from (EO-298,
   * ARCHITECTURE.md, "The output is a comment").
   *
   * The engine derives no output and renders none: *how* an output is
   * worth showing is a pack's judgement, and this pack's judgement is
   * that a diff is worth stating and not worth repeating at any length.
   * An installation that drafts weekly reports would inline the whole
   * report here, because the report is the work; a reviewer is standing
   * in the checkout the diff was taken from, so what it needs is the
   * shape of the change and a way to the rest of it.
   *
   * The point of the section, and the whole of the design: the current
   * output is the one a person may have *edited*. An agent reading up
   * the thread for "what did the implementer produce" finds what the
   * implementer produced; this names what stands now instead. A step
   * that sends, posts or publishes must send this and nothing else.
   *
   * Anchored after the item, which is where a deliverable reads as an
   * answer to the thing it is a deliverable for.
   */
  {
    id: "currentOutput",
    after: "item",
    // The one section here a resumed thread is shown again (EO-298).
    // The other three are instructions, and an agent carrying on a
    // conversation already has them; this is state, and the whole reason
    // it is in the prompt is that it may have changed since — a second
    // implement attempt is dispatched precisely because somebody looked
    // at the first one's output, and may have corrected it.
    volatile: true,
    render: ({ currentOutput }) => {
      if (currentOutput === null) return null;

      const excess = currentOutput.body.length - MAX_OUTPUT_SECTION_CHARS;
      const body =
        excess <= 0
          ? currentOutput.body
          : `${closeCutFence(currentOutput.body.slice(0, MAX_OUTPUT_SECTION_CHARS))}\n\n[${excess} more characters — read the whole of it with \`${COMMENT_READ}\` on ${currentOutput.id}]`;

      const lines = [
        "## The current output",
        "",
        currentOutput.parentId === null
          ? "What this ticket has produced so far. Work from this rather than from anything further up the thread."
          : "What this ticket has produced so far, as it stands now. It supersedes an earlier version — somebody may have corrected it, so work from this and not from what is further up the thread.",
        "",
        body,
      ];

      if (currentOutput.attachments.length > 0) {
        lines.push(
          "",
          `Files it carries (metadata only; use \`${ATTACHMENT_READ}\` for content):`,
          ...currentOutput.attachments.map(
            (attachment) => `- ID: ${attachment.id}; name: ${attachment.name}; MIME type: ${attachment.mimeType}; size: ${attachment.size} bytes`,
          ),
        );
      }

      return lines.join("\n");
    },
  },
  {
    id: "acceptanceCriteria",
    after: "item",
    render: ({ item }) =>
      item.acceptanceCriteria.length === 0
        ? null
        : ["## Acceptance Criteria", ...item.acceptanceCriteria.map((item) => `- ${item}`)].join("\n"),
  },
  /**
   * Where a file goes that is for the ticket and not for the branch
   * (EO-413).
   *
   * An agent attaches with a tool that takes files from the directory it
   * works in, and on a git workspace that directory is a checkout: a
   * screenshot written beside the code is one `git add -A` from being
   * part of the change under review. `worktrees.ts` excludes one
   * directory from git for exactly this, and an exclusion nobody was
   * told about is a directory nobody uses — so this is the sentence.
   *
   * Only on a git workspace. A folder is the person's own files and a
   * scratch directory is thrown away, so neither has a branch for a file
   * to stray onto, and what a run leaves in either is already copied
   * onto the ticket; a run with no disk has nothing to attach from.
   * Telling any of them about a directory git ignores would be an
   * instruction about a thing they do not have.
   *
   * Not volatile: it is an instruction, and a resumed thread already
   * holds it.
   */
  {
    id: "ticketFiles",
    after: "item",
    render: ({ item }) =>
      item.workspaceKind !== GIT_WORKTREE_KIND
        ? null
        : [
            "## Files for the ticket, not the branch",
            "",
            `A file you make only to put on this ticket — a screenshot, a captured log, a test report — goes in \`${TICKET_FILES_DIRECTORY}/\` at the top of your checkout, and is attached with \`${ATTACHMENT_ADD}\`. Git does not see that directory: nothing in it is staged by \`git add -A\`, committed, or counted as uncommitted work. A file that belongs to the change itself goes where it belongs in the repository, as always.`,
          ].join("\n"),
  },
];
