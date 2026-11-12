import { z } from "zod";

/**
 * Where a job's work happens, and why the other place is not offered
 * (EO-330, `ARCHITECTURE.md`, "Where a job runs", invariant 12).
 *
 * Phase 7a made the server able to run work — the schedulers, the
 * engine and the packs are all on the other side of `startMain` and
 * neither half knows which machine it is on — so a job finally has two
 * places it could run and a person finally has a choice to make. This
 * file is the half of that choice EO is responsible for: **the person
 * is never allowed to pick a place where the job would quietly fail.**
 *
 * The design lists the reasons in both directions, and the shape of this
 * module follows that list rather than generalising it:
 *
 *  - **machine-bound** — a step's agent is signed in with a personal
 *    login; a secret it reads is the person's; its workspace is a path
 *    on this disk; an MCP server it is served exists only in this
 *    machine's catalogue. Any one of these greys *organisation server*.
 *  - **server-bound** — a step reads an organisation secret, or is
 *    served an MCP server the organisation publishes and this machine
 *    has not installed. Any one of these greys *this machine*.
 *
 * The second direction is the design's, and it is the one that is easy
 * to argue away: EO-328 does deliver an organisation's secret to a
 * device, so a job reading one *could* run on a laptop. The design says
 * it should not, and the reason is the one that finding gives — a
 * module receives its secrets as environment variables and an agent
 * with a shell can read its own environment, so an organisation's
 * credential handed to a machine the organisation does not administer
 * is a credential the organisation has lost track of. Placement is
 * where that is said out loud rather than discovered.
 *
 * ## Why the reasons are data and not prose
 *
 * A greyed option needs three things at once: a list a screen can draw
 * one row per, a fix beside each row, and a summary somebody can paste
 * into a message to their admin. A single sentence gives the first and
 * neither of the others. So a reason is a row — what kind, what it is
 * about, which step raised it — and the words for it are composed here,
 * once, so that the greyed option, the command's refusal and the
 * copyable summary cannot come to describe the same fact three ways.
 *
 * Pure, and in `@eo/core` for `policy.ts`'s reason: the main process
 * gathers the facts (it is the only half that can spawn a CLI or read a
 * keychain) and this decides what they mean, which is what lets the
 * whole of the decision be tested without a machine under it.
 */

/**
 * `device` — the person's machine — or `server`, the organisation's.
 *
 * Spelled for the topology rather than for the screen: `device` is the
 * word the record/device split already uses for the half that has
 * somebody's files and logins on it (`record/device.ts`), and a second
 * vocabulary for the same distinction is how two halves of one system
 * come to disagree about which is which. What a person *reads* is
 * `runsOnLabel` below, and that says "this machine".
 */
export const JobRunsOnSchema = z.enum(["device", "server"]);
export type JobRunsOn = z.infer<typeof JobRunsOnSchema>;

/**
 * Every job written before this story, and every job made in solo mode.
 *
 * Device rather than "whatever is available", because the default has
 * to be the one that is true of an installation with no server: a job
 * has always run on the machine EO is open on, and a migration that
 * moved existing jobs somewhere else would move work a person never
 * asked to move.
 */
export const DEFAULT_JOB_RUNS_ON: JobRunsOn = "device";

/** The two options as the design words them, for the control and for every sentence composed here. */
export function runsOnLabel(where: JobRunsOn): string {
  return where === "device" ? "this machine" : "organisation server";
}

/**
 * What made a place impossible — a closed set, the way
 * `JobSkipReasonSchema` is one.
 *
 * A kind rather than only a sentence because the screen groups by it
 * and because the fix is a property of the kind: every personal secret
 * is fixed the same way, and a reason carrying only prose would leave
 * the page parsing English to decide what button to offer.
 */
export const PlacementReasonKindSchema = z.enum([
  "personal-login",
  "personal-secret",
  "local-workspace",
  "local-mcp-server",
  "organisation-secret",
  "organisation-mcp-server",
  "watch-intake",
]);
export type PlacementReasonKind = z.infer<typeof PlacementReasonKindSchema>;

export const PlacementReasonSchema = z.object({
  kind: PlacementReasonKindSchema,
  /** What it is about: the agent, the secret's name, the workspace, the server. */
  subject: z.string(),
  /** Which step raised it. Null for a reason about the job rather than about one of its steps. */
  stepName: z.string().nullable(),
  /** The fact, in one sentence. */
  line: z.string(),
  /** What to do about it — the person's own fix where there is one, and "ask your admin" where there is not. */
  fix: z.string(),
});
export type PlacementReason = z.infer<typeof PlacementReasonSchema>;

/**
 * Where a job may run, and everything standing in the way of the place
 * it may not.
 *
 * Both lists travel together rather than "the allowed set plus a
 * sentence", because the screen draws the reasons under the option they
 * grey and has to know which is which. Either list being empty is the
 * ordinary case: a solo installation has nothing published, so it never
 * has a server-bound reason, and most pipelines are machine-bound for
 * the plain reason that they are somebody's work on somebody's disk.
 */
export const JobPlacementSchema = z.object({
  /** What the job says today. */
  runsOn: JobRunsOnSchema,
  /** Why it cannot run on the organisation server. Empty means it could. */
  machineBound: z.array(PlacementReasonSchema),
  /** Why it cannot run on this machine. Empty means it could. */
  serverBound: z.array(PlacementReasonSchema),
});
export type JobPlacement = z.infer<typeof JobPlacementSchema>;

/** A job whose pipeline asks for nothing either machine lacks. */
export const ANYWHERE: JobPlacement = Object.freeze({
  runsOn: DEFAULT_JOB_RUNS_ON,
  machineBound: [],
  serverBound: [],
});

/** The reasons that grey `where`. Machine-bound reasons grey the server, and the other way about. */
export function reasonsAgainst(placement: JobPlacement, where: JobRunsOn): readonly PlacementReason[] {
  return where === "server" ? placement.machineBound : placement.serverBound;
}

/** Whether this job could run there at all. */
export function placementAllows(placement: JobPlacement, where: JobRunsOn): boolean {
  return reasonsAgainst(placement, where).length === 0;
}

/**
 * The state the design does not name and a managed installation can reach:
 * greyed in both directions.
 *
 * A pipeline with a personal login on one step and an organisation
 * secret on another has nowhere to run, and saying so is the only
 * honest thing a screen can do — an option EO knows would fail is not
 * made available because the other one is worse.
 */
export function placementStranded(placement: JobPlacement): boolean {
  return !placementAllows(placement, "device") && !placementAllows(placement, "server");
}

/**
 * The words beside an option a person may not choose.
 *
 * Deliberately the same register as
 * `NOT_ALLOWED_BY_YOUR_ORGANISATION` — short, lower case, read under a
 * control where the only question is "why is this one greyed". The
 * reasons carry the rest.
 */
export const NOT_AVAILABLE_FOR_THIS_JOB = "not available for this job";

/** The closing half of a fix EO cannot offer the person a button for. */
export const ASK_YOUR_ADMIN = "Ask your admin.";

/** What a reason is about, for a sentence that has to name the step and may not have one. */
export interface PlacementReasonInput {
  kind: PlacementReasonKind;
  /** The agent, the secret's name, the workspace's name, the server's name. */
  subject: string;
  stepName: string | null;
  /**
   * The one extra fact the sentence for this kind wants: the backend a
   * personal login belongs to, the path a workspace is at. Absent
   * wherever the kind does not use it.
   */
  detail?: string | null;
}

/**
 * A reason, with its sentence and its fix composed from its kind.
 *
 * One switch, so that the six wordings are read together and stay in
 * one voice. Every `line` states the fact and names the step that
 * raised it; every `fix` says what would clear it, and ends in
 * `ASK_YOUR_ADMIN` exactly where the thing to be done is not the
 * person's to do.
 */
export function placementReason(input: PlacementReasonInput): PlacementReason {
  const step = input.stepName === null ? "This job" : `"${input.stepName}"`;
  const where = input.detail ?? null;
  const base = { kind: input.kind, subject: input.subject, stepName: input.stepName };

  switch (input.kind) {
    case "personal-login":
      return {
        ...base,
        line: `${step} runs on "${input.subject}", which is signed in to ${where ?? "its backend"} with a personal login.`,
        fix:
          `A personal login belongs to this machine and the organisation server has no copy of it. ` +
          `Bind "${input.subject}" to a backend your organisation allows an API key for, and this clears.`,
      };
    case "personal-secret":
      return {
        ...base,
        line: `${step} reads ${input.subject}, a secret set on this machine.`,
        fix: `The organisation server has no value for ${input.subject}, so the step would run without it. ${ASK_YOUR_ADMIN}`,
      };
    case "local-workspace":
      return {
        ...base,
        line: `${step} works in "${input.subject}"${where === null ? "" : ` (${where})`}, which is a folder on this machine.`,
        fix:
          `The organisation server has no copy of it. Point the step at a workspace that needs no disk, ` +
          `or leave this job on this machine.`,
      };
    case "local-mcp-server":
      return {
        ...base,
        line: `${step} is served the "${input.subject}" MCP server, which is configured on this machine only.`,
        fix: `The organisation server has no definition of "${input.subject}" to serve. ${ASK_YOUR_ADMIN}`,
      };
    case "organisation-secret":
      return {
        ...base,
        line: `${step} reads ${input.subject}, a secret your organisation set.`,
        fix:
          `Your organisation's credential runs where your organisation keeps it — a module is handed its secrets as ` +
          `environment variables, and an agent with a shell can read them. ${ASK_YOUR_ADMIN}`,
      };
    case "organisation-mcp-server":
      return {
        ...base,
        line: `${step} is served "${input.subject}", which your organisation publishes and this machine has not installed.`,
        fix: `The organisation server serves it and this one does not. ${ASK_YOUR_ADMIN}`,
      };
    // A watch job (EO-753): its intake runs the module on this machine,
    // while EO is open, and the organisation server runs no intake check.
    case "watch-intake":
      return {
        ...base,
        line: `${step} is a watch intake: it runs "${input.subject}" on this machine to find work.`,
        fix: "A watch intake runs its module on this machine, so the job stays here.",
      };
  }
}

/**
 * Why a save was refused, as the command layer answers it (the design's rule
 * for a lock, applied to a placement).
 *
 * Refused in the domain command and not only greyed on the screen,
 * because the screen is not the only door: the system agent's admin MCP
 * server reaches the same handlers, and a control that was merely
 * hidden in the renderer would let a job be placed from a chat where it
 * cannot run. One sentence and then the reasons, so that whoever meets
 * it — a person or an agent reading a typed refusal — is told the same
 * thing the option's grey says.
 */
export function placementRefusal(placement: JobPlacement, where: JobRunsOn): string {
  const reasons = reasonsAgainst(placement, where);
  if (reasons.length === 0) return "";
  return (
    `This job cannot run on ${runsOnLabel(where)}, so nothing was saved. ` +
    reasons.map((reason) => `${reason.line} ${reason.fix}`).join(" ")
  );
}

/**
 * The summary beside the greyed option, for copying (the original design: "each reason
 * carries its fix or 'ask your admin' with a copyable summary").
 *
 * What a person pastes into a message to their admin, so it has to
 * stand on its own: which job, which place, and every reason with its
 * fix. A bulleted list rather than a paragraph — a person forwarding
 * four reasons wants four lines, and an admin reading it wants to be
 * able to answer them one at a time.
 */
export function placementSummary(input: { jobName: string; placement: JobPlacement; where: JobRunsOn }): string {
  const reasons = reasonsAgainst(input.placement, input.where);
  const place = runsOnLabel(input.where);
  if (reasons.length === 0) return `"${input.jobName}" can run on ${place}.`;
  return [`"${input.jobName}" cannot run on ${place}.`, ...reasons.map((reason) => `• ${reason.line} ${reason.fix}`)].join("\n");
}

/**
 * The machine a device job runs on, as the design asks it to be named in
 * managed mode.
 *
 * Two fields because the sentence has two halves and each can be absent
 * on its own: a machine that has never presented its token has no
 * `lastSeenAt`, and there is no machine at all to name until somebody
 * has signed in. In solo mode this is never asked for — the control is
 * hidden and the page says what it has always said.
 */
export const JobMachineSchema = z.object({
  /** What the device called itself at sign-in — "Anna's MacBook". */
  name: z.string(),
  /** When it last presented its token, or null for one that never has. */
  lastSeenAt: z.number().nullable(),
});
export type JobMachine = z.infer<typeof JobMachineSchema>;

/**
 * "Runs while EO is open on Anna's MacBook · last online 3h ago"
 * (the original design, review the design's resolution, quoted there in those words).
 *
 * Capitalised where the design quotes it lower case, because it is the
 * managed-mode replacement for the Job page's own "Runs while EO is
 * open on this machine." — the same line about the same thing, gaining
 * a name and a time. Two registers for one sentence, three inches
 * apart, would read as two different claims.
 *
 * The elapsed half is coarse on purpose. What the sentence is for is
 * "should I expect this to have run", and to the minute is a precision
 * the answer does not have — a laptop seen 40 seconds ago and one seen
 * 90 are the same laptop. So it reads *now* under a few minutes and
 * rounds down after that, which is the direction that never claims a
 * machine was online more recently than it was.
 */
export function jobMachineLine(machine: JobMachine, now: number): string {
  return `Runs while EO is open on ${machine.name} · ${lastOnline(machine.lastSeenAt, now)}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function lastOnline(lastSeenAt: number | null, now: number): string {
  if (lastSeenAt === null) return "never online";
  const elapsed = Math.max(0, now - lastSeenAt);
  if (elapsed < 5 * MINUTE) return "online now";
  if (elapsed < HOUR) return `last online ${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `last online ${Math.floor(elapsed / HOUR)}h ago`;
  return `last online ${Math.floor(elapsed / DAY)}d ago`;
}
