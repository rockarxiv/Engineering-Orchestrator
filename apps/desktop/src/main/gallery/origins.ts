import type { PipelineStep } from "@eo/core";
import { sameValue } from "@eo/engine";
import type { Db } from "../db/client.js";
import { getSetting, listStepsForPipeline, pipelinesWithoutOrigin, recordPipelineOrigin, setSetting } from "../db/repos/index.js";
import { compareTemplateVersions, type TemplateHistory, type TemplateVersion } from "./history.js";

/**
 * Origins for the pipelines that predate them (EO-531).
 *
 * A pipeline made from a template since EO-531 records its origin when
 * it is made. Every pipeline before that has none, and the one EO most
 * needs to give one is the seeded Delivery: it is the template, by step
 * id, because the template was generated from it.
 *
 * So once per installation, each pipeline without an origin is matched
 * against the versions the app ships, **by step id**. Nothing else is a
 * fair key. A name is what a person edits, and a pipeline's graph is
 * exactly what a later comparison is going to find the person changed.
 * Step ids survive both, and they are global primary keys that a person
 * drawing a step or importing a pack never chooses — so `worktree`,
 * `merge_request` and the rest are on a pipeline only because it was
 * seeded with them.
 */

/** Where the backfill writes that it has run. */
export const ORIGINS_BACKFILLED_KEY = "templates.originsBackfilledAt";

export interface TemplateMatch {
  version: TemplateVersion;
  /** The template's step ids this pipeline holds, each mapped to itself. */
  stepIds: Record<string, string>;
}

/**
 * The template version a pipeline with these step ids came from, or
 * null.
 *
 * A version **matches** when the pipeline holds more than half of that
 * version's steps. Holding every one is not required: a person may have
 * removed a step, and that is a change of theirs for the comparison to
 * keep, not a reason the pipeline has no template behind it. Holding
 * steps the version does not is allowed for the same reason.
 *
 * Among the versions that match, the one the pipeline holds the **most**
 * steps of wins; then the one it is **missing the fewest** steps of;
 * then the newest. The second rule is the one that decides EO's own
 * Delivery: it holds every step of *Software feature to merge* 1.0 and
 * every step of 1.1 but `pull_request_watch`, so both hold the same
 * number, 1.1 is missing one, and 1.0 — the version before EO-461 — is
 * what it came from.
 *
 * Then, where the caller passes the pipeline's steps, the one whose
 * settings on those steps the pipeline **differs from least** (EO-571).
 * Two versions can have exactly the same step ids — 1.1 and 1.2 differ
 * only in the pull request watch's deadline — and "the newest" would
 * give a pipeline still shaped as 1.1 a 1.2 base. The comparison would
 * then read the week as the person's own setting and never offer the
 * update. This is the one place a graph's content is read here, and only
 * between versions the ids could not tell apart, so a person's edits
 * still never decide whether a pipeline has a template behind it.
 */
export function matchTemplateVersion(stepIds: readonly string[], history: TemplateHistory, steps: readonly PipelineStep[] = []): TemplateMatch | null {
  const held = new Set(stepIds);
  const byId = new Map(steps.map((step) => [step.id as string, step]));
  let best: Candidate | null = null;

  for (const versions of history.values()) {
    for (const version of versions) {
      const ids = version.document.steps.map((step) => step.id);
      const matched = ids.filter((id) => held.has(id)).length;
      const missing = ids.length - matched;
      if (ids.length === 0 || matched * 2 <= ids.length) continue;
      const candidate = { version, matched, missing, differing: differingSettings(version, byId) };
      if (best === null || better(candidate, best)) best = candidate;
    }
  }
  if (best === null) return null;

  const map: Record<string, string> = {};
  for (const step of best.version.document.steps) if (held.has(step.id)) map[step.id] = step.id;
  return { version: best.version, stepIds: map };
}

interface Candidate {
  version: TemplateVersion;
  matched: number;
  missing: number;
  differing: number;
}

/**
 * The settings a version would tell apart from another with the same
 * steps: what kind each is, what it runs, who owns it, how it keeps
 * checking and what it offers. Not inputs or a time limit, which a
 * document leaves to the importing machine and so says nothing about.
 */
const MATCHED_SETTINGS = ["type", "entryAction", "ownerRole", "watch", "results"] as const;

/** How many of a version's step settings the pipeline holds differently. Nought where the caller gave no steps. */
function differingSettings(version: TemplateVersion, steps: ReadonlyMap<string, PipelineStep>): number {
  let differing = 0;
  for (const step of version.document.steps) {
    const held = steps.get(step.id);
    if (held === undefined) continue;
    for (const field of MATCHED_SETTINGS) if (!sameValue(step[field], held[field])) differing += 1;
  }
  return differing;
}

function better(candidate: Candidate, current: Candidate): boolean {
  if (candidate.matched !== current.matched) return candidate.matched > current.matched;
  if (candidate.missing !== current.missing) return candidate.missing < current.missing;
  if (candidate.differing !== current.differing) return candidate.differing < current.differing;
  // Two slugs cannot tie here in practice — step ids are global — so
  // this orders versions of one template.
  return compareTemplateVersions(candidate.version.version, current.version.version) > 0;
}

export interface BackfillResult {
  /** False when it had already run, or had no history to match against. */
  ran: boolean;
  recorded: { pipelineId: string; slug: string; version: string }[];
}

/**
 * Gives every pipeline without an origin one, where its step ids match
 * a shipped template version — once per installation.
 *
 * On an installation being born this is also how the seeded Delivery
 * gets its origin: migrations write it as a version of the template,
 * step for step, and the first launch matches it to that version. The
 * newest, unless a version shipped since the seed was last written —
 * Software feature to merge 1.2 (EO-571) is not a migration — and then
 * the version the seed is, which `applyTemplateUpdates` brings up to
 * date like any other pipeline.
 *
 * A pipeline that matches nothing keeps no origin, and is never
 * compared. An empty history — a build that did not ship the directory —
 * is not counted as having run, so the next launch of a build that does
 * ship it still gets to match.
 */
export function backfillPipelineOrigins(db: Db, history: TemplateHistory): BackfillResult {
  if (getSetting<number | null>(db, ORIGINS_BACKFILLED_KEY, null) !== null) return { ran: false, recorded: [] };
  if (history.size === 0) return { ran: false, recorded: [] };

  const recorded: BackfillResult["recorded"] = [];
  db.transaction(() => {
    for (const pipelineId of pipelinesWithoutOrigin(db)) {
      const steps = listStepsForPipeline(db, pipelineId);
      const match = matchTemplateVersion(
        steps.map((step) => step.id),
        history,
        steps,
      );
      if (match === null) continue;
      // Made from this base long before anybody recorded it, so no moment
      // to count its edits from: every version it has is the person's.
      recordPipelineOrigin(db, { pipelineId, document: match.version.document, stepIds: match.stepIds, baseMovedAt: null });
      recorded.push({ pipelineId, slug: match.version.slug, version: match.version.version });
    }
    setSetting(db, ORIGINS_BACKFILLED_KEY, Date.now());
  });
  return { ran: true, recorded };
}
