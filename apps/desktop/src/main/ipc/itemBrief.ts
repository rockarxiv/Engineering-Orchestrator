import { VERDICT_COMMENT_KINDS, fieldLabel, specFields, type Agent, type Comment, type IpcPayload, type IpcResponse, type Item, type ItemBriefPart, type PipelineStep, type Run, type StepBriefPart, type Transition, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { authorName } from "./domainQueries.js";
import { currentOutputOf, getItem, getItemType, getStep, graphForItem, listAgents, listCommentsForItem, listRunsForItem, listTransitionsForItem, stepForItem } from "../db/repos/index.js";

/**
 * What a person's decision on an item is about: the brief behind "Show
 * details" on the item page's decision bar (EO-827, ARCHITECTURE.md, "The
 * decision's brief"), as `items:brief` answers.
 *
 * Resolved here rather than in the engine, which cannot read a thread
 * (invariant 2), and rather than in the renderer, which holds a page of
 * the thread and not the runs that say which step wrote what.
 *
 * The step the item stands on decides what is shown. One that declares no
 * brief shows the default: its instructions summary, the item's current
 * output, and the newest verdict the step before it gave. One that declares
 * a brief shows exactly its parts, in order. Read by the item's own version
 * of the step, so an item finishing on an older version is briefed as that
 * version says.
 */
export function getItemBrief(db: Db, { itemId }: IpcPayload<"items:brief">): IpcResponse<"items:brief"> {
  const item = getItem(db, itemId as Uuid);
  if (item === undefined) return null;
  const step = stepForItem(db, item);
  if (step === undefined) return { declared: false, parts: [] };

  const thread = new Thread(db, item);
  if (step.brief === null) {
    return {
      declared: false,
      parts: [
        ...(step.instructionsSummary === null || step.instructionsSummary.trim() === ""
          ? []
          : [part("summary", "What this step asks", step.instructionsSummary)]),
        thread.currentOutput(),
        thread.verdictBefore(step),
      ],
    };
  }
  return { declared: true, parts: step.brief.map((declared) => thread.declared(declared)) };
}

function part(show: ItemBriefPart["show"], heading: string, body: string | null, comment?: { author: string; createdAt: number }): ItemBriefPart {
  return { show, heading, body, author: comment?.author ?? null, createdAt: comment?.createdAt ?? null };
}

/** One item's thread, read once, with what says which step wrote each comment. */
class Thread {
  private readonly comments: Comment[];
  private readonly runs: Map<string, Run>;
  /** Every move, oldest first. */
  private readonly moves: Transition[];
  private readonly agents: Map<string, Agent>;

  constructor(
    private readonly db: Db,
    private readonly item: Item,
  ) {
    // Oldest first, ties by id: uuidv7 mints monotonically, so the later id is the later comment.
    this.comments = listCommentsForItem(db, item.id);
    this.runs = new Map(listRunsForItem(db, item.id).map((run) => [run.id as string, run]));
    this.moves = [...listTransitionsForItem(db, item.id)].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    this.agents = new Map(listAgents(db).map((agent) => [agent.id as string, agent]));
  }

  currentOutput(): ItemBriefPart {
    const output = currentOutputOf(this.db, this.item.id);
    return output === undefined ? part("output", "Current output", null) : this.shown("output", "Current output", output);
  }

  /**
   * The newest verdict — an approval, a rejection or a decision — from the
   * step the item came to this one from. Null where the item was filed
   * straight onto it, or that step said nothing of the kind.
   */
  verdictBefore(step: PipelineStep): ItemBriefPart {
    const arrival = [...this.moves].reverse().find((move) => move.toStepId === step.id);
    const before = arrival?.fromStepId ?? null;
    if (arrival === undefined || before === null) return part("comment", "Verdict from the step before", null);
    const heading = `Verdict from ${this.stepName(before)}`;
    const verdict = this.newest(
      (comment) => VERDICT_COMMENT_KINDS.includes(comment.kind) && comment.createdAt <= arrival.ts && this.stepOf(comment) === before,
    );
    return verdict === undefined ? part("comment", heading, null) : this.shown("comment", heading, verdict);
  }

  declared(declared: StepBriefPart): ItemBriefPart {
    if (declared.show === "output") {
      const heading = `Output of ${this.stepName(declared.step)}`;
      const output = this.newest((comment) => comment.kind === "output" && this.stepOf(comment) === declared.step);
      return output === undefined ? part("output", heading, null) : this.shown("output", heading, output);
    }
    if (declared.show === "comment") {
      const heading = [declared.kind === undefined ? "Newest comment" : `Newest ${declared.kind}`, declared.role === undefined ? "" : ` by ${declared.role}`].join("");
      const found = this.newest(
        (comment) => (declared.kind === undefined || comment.kind === declared.kind) && (declared.role === undefined || this.roleOf(comment) === declared.role),
      );
      return found === undefined ? part("comment", heading, null) : this.shown("comment", heading, found);
    }
    const shape = getItemType(this.db, this.item.typeId)?.specShape;
    const field = shape === undefined ? undefined : specFields(shape).find((each) => each.name === declared.field);
    return part("field", field?.label ?? fieldLabel(declared.field), fieldText(this.item.spec?.[declared.field]));
  }

  private shown(show: ItemBriefPart["show"], heading: string, comment: Comment): ItemBriefPart {
    return part(show, heading, comment.body, { author: this.authorOf(comment), createdAt: comment.createdAt });
  }

  private newest(matches: (comment: Comment) => boolean): Comment | undefined {
    for (let index = this.comments.length - 1; index >= 0; index -= 1) {
      const comment = this.comments[index]!;
      if (matches(comment)) return comment;
    }
    return undefined;
  }

  /**
   * Which step wrote a comment: its run's, where a run wrote it, and
   * otherwise the step the item stood on when it was posted. A person's
   * decision is posted just before the move it causes, so a move in the
   * same millisecond is read as coming after it.
   */
  private stepOf(comment: Comment): string | null {
    const run = comment.runId === null ? undefined : this.runs.get(comment.runId);
    if (run?.stepId !== null && run?.stepId !== undefined) return run.stepId;
    let standing: string | null = this.moves[0]?.fromStepId ?? this.item.stepId;
    for (const move of this.moves) {
      if (move.ts >= comment.createdAt) break;
      standing = move.toStepId;
    }
    return standing;
  }

  /** An agent's role, or the kind of author anybody else is: `human`, `engine`, `module`. */
  private roleOf(comment: Comment): string {
    if (comment.authorType !== "agent") return comment.authorType;
    return (comment.authorId === null ? undefined : this.agents.get(comment.authorId)?.role) ?? "agent";
  }

  private authorOf(comment: Comment): string {
    return authorName(comment, this.agents);
  }

  private stepName(id: string): string {
    return graphForItem(this.db, this.item).steps.find((step) => step.id === id)?.name ?? getStep(this.db, id)?.name ?? id;
  }
}

/** A field's value as the brief shows it: text as written, a list as a list, nothing as null. */
function fieldText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (Array.isArray(value)) return value.length === 0 ? null : value.map((entry) => `- ${String(entry)}`).join("\n");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  return String(value);
}
