import type { CustomModule, Item, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { activeTrialGrants, getModule, latestTrialGrant, listTrialGrantsForModule, needsBeyondGrant, stepForItem } from "../db/repos/index.js";
import { answerToLastAsk } from "../roles/answers.js";
import type { BuiltinContext, BuiltinOutcome, BuiltinRunner } from "../supervisor/builtins.js";
import { postModuleAttachment, postModuleComment } from "./moduleComments.js";
import { recordFor } from "../record/localRecord.js";
import type { ItemRecord } from "../record/record.js";
import type { RunFileStore } from "../supervisor/runAttachments.js";
import { wouldHaveSentLine } from "../preview.js";
import { resolveInputs, runModule, type ModuleHostLauncher } from "./runModule.js";
import { environmentFor, type ModuleSecretsOptions, type SecretRead } from "./secrets.js";
import { readOrganisationSecretEntry, type OrganisationSecretsOptions } from "../policy/organisationSecrets.js";
import { stepScopeFor } from "../trials/stepModes.js";

/**
 * Turns a module id into something the supervisor already knows how to
 * run (KAN-105).
 *
 * A `BuiltinRunner`, deliberately. `runBuiltin` already gives a
 * non-agent step everything a module needs — a run row, an elapsed time,
 * park-on-failure at `awaiting_input`, an escalation comment carrying
 * answer options, and a result key looked up in `step_routes`. Matching
 * the existing shape is what reuses all of it rather than writing a
 * second, slightly different version of each.
 */

export interface ModuleRegistryOptions {
  db: Db;
  launcher: ModuleHostLauncher;
  secrets: ModuleSecretsOptions;
  /**
   * The organisation's named values, where this installation has any
   * (EO-328, ARCHITECTURE.md, "Secrets").
   *
   * Absent on a solo installation and in every test that does not care,
   * which leaves the resolution exactly as it was. Present, the
   * organisation's value for a name wins over both the step override and
   * the shared one — `environmentFor` is where that is argued.
   */
  organisationSecrets?: OrganisationSecretsOptions;
  /**
   * Where the bytes of a file a module attaches are kept (EO-414) — the
   * store the supervisor keeps a run's artifacts in.
   *
   * Absent on an installation with nowhere to keep one, where
   * `ctx.attach()` is refused in the transcript rather than dropped.
   */
  attachments?: RunFileStore;
  /**
   * Told the id of each item a module creates (EO-433), so open windows
   * can be told a board gained a card. Absent where nothing is
   * listening, which changes nothing about the creation.
   */
  onItemCreated?: (itemId: Uuid) => void;
  /**
   * The record a creation is asked of (EO-433).
   *
   * On a desktop this is the device record, which sends a creation for
   * a project the organisation holds to the organisation's record and
   * performs one for a project kept here itself. Absent — a test, or a
   * caller driving the engine without one — it is this database, which
   * is the record for everything in it.
   */
  record?: Pick<ItemRecord, "createItemFromModule">;
}

/**
 * Why an unapproved module may not run on this item under a trial grant,
 * or null where it may (EO-583, ARCHITECTURE.md, "Modules: a step that is
 * a script").
 *
 * A grant is for one trial's items and nothing else: an item without
 * the trial mark, or on another pipeline, is refused whatever the module
 * holds. On its own trial the grant has to still hold, and the module's
 * needs have to be inside it — checked here as well as at every save,
 * because this is the moment the code runs.
 */
export function trialGrantRefusal(db: Db, module: CustomModule, item: Pick<Item, "trialAt" | "pipelineId">): string | null {
  const notApproved = `"${module.name}" has not been approved`;
  if (item.trialAt === null || item.pipelineId === null) {
    return `${notApproved}, so it runs only on the test items of a trial it was granted for, and this is not a test item. Approve it under Settings → Modules before live work runs it.`;
  }
  const grant = activeTrialGrants(db, module.id).find((each) => each.trialPipelineId === item.pipelineId);
  if (grant === undefined) {
    const withdrawn = latestTrialGrant(db, module.id, item.pipelineId);
    if (withdrawn !== undefined) {
      const beyond = needsBeyondGrant(module.manifest, withdrawn.needs);
      return (
        `${notApproved}, and its trial grant on this trial was withdrawn when its declared needs grew past what was granted` +
        (beyond.length > 0 ? ` (it now needs ${beyond.join(", ")})` : "") +
        ". The person has to grant it again before it runs here."
      );
    }
    return `${notApproved}, and its trial grant is for another trial, not this one, so it does not run on this item.`;
  }
  const beyond = needsBeyondGrant(module.manifest, grant.needs);
  if (beyond.length > 0) {
    return `${notApproved}, and it now needs ${beyond.join(", ")}, which its trial grant does not cover. The person has to grant it again before it runs.`;
  }
  return null;
}

/**
 * Resolves the runner for a `module` step's action, or undefined.
 *
 * Undefined for an id that names nothing, an archived module, or one
 * nobody approved and nobody ever granted a trial — and the supervisor's
 * existing "not one of EO's functions" path turns that into a parked
 * item and a comment. The approval check is here as well as in the
 * validator because a pipeline can be published and a module unapproved
 * afterwards, and the gate has to hold at the moment of running rather
 * than only at the moment of saving.
 *
 * A module holding a trial grant (EO-583) resolves to a runner, because
 * whether it may run depends on the item and the lookup is not told
 * which: the runner asks first (`trialGrantRefusal`), and an item it is
 * not granted for is refused with the reason, which the supervisor
 * parks and posts as it does every refusal (invariant #8).
 */
/**
 * The organisation's store as `environmentFor` takes it, or nothing.
 *
 * Bound outside the closure so the narrowing holds: a member read
 * through `options` inside a callback is optional again at every call,
 * which is the difference between this and a non-null assertion.
 */
function organisationReader(store: OrganisationSecretsOptions | undefined): ((name: string) => SecretRead) | undefined {
  if (store === undefined) return undefined;
  return (name: string) => readOrganisationSecretEntry(store, name);
}

export function createModuleRunnerLookup(options: ModuleRegistryOptions): (action: string) => BuiltinRunner | undefined {
  return (action: string) => {
    const module = getModule(options.db, action);
    if (!module || module.archivedAt !== null) return undefined;
    const onTrialGrant = module.approvedAt === null;
    // Any grant, held or withdrawn: a module whose grant was withdrawn is
    // refused by the runner, which can say why, rather than here.
    if (onTrialGrant && listTrialGrantsForModule(options.db, module.id).length === 0) return undefined;

    return async (context: BuiltinContext): Promise<BuiltinOutcome> => {
      // Before anything else, the preview included: an unapproved module
      // runs on its own trial's items or not at all.
      if (onTrialGrant) {
        const refusal = trialGrantRefusal(options.db, module, context.item);
        if (refusal !== null) return { ok: false, reason: refusal };
      }

      // A preview never runs the module (EO-313, ARCHITECTURE.md, "Preview").
      //
      // First, before the worktree, the secrets and the host — before
      // anything with an effect outside this function. A module's whole
      // job is the side effect, so "run it and ignore what it returns"
      // is not a weaker version of this: the message is already in the
      // channel. Preparing a workspace would be a branch cut for a
      // rehearsal, and reading the secrets would hand a token to a run
      // that was told it needs none.
      //
      // The first declared result, so the item *moves*. A preview that
      // stopped at the first module step would show a person the half of
      // the machine that does not include the end of it, which is the
      // half they came to see. `manifest.results` is ordered, is
      // non-empty by schema, and its first entry is the module author's
      // own "this worked" — the same order `validatePipeline` reads.
      if (context.item.previewAt !== null) {
        // The step *as this item's version defines it* (EO-327, ARCHITECTURE.md, "Publish, lock and
        // versions"),
        // here as much as below: a rehearsal that reported the values a
        // later save wrote would be describing a run this item would
        // never have had.
        const step = stepForItem(options.db, context.item);
        context.report(wouldHaveSentLine(module.name, resolveInputs(module, step?.inputs ?? {})));
        return { ok: true, result: module.manifest.results[0]!, detail: "" };
      }

      // The same idempotent preparation an agent dispatch does. A module
      // works in the item's worktree or it works in whatever directory
      // happened to be current, and the second is not a thing to leave to
      // chance when the module runs `git push`.
      //
      // The name rather than the id, because a refusal says what it would
      // have been running. In quotes so it cannot read as an action the
      // kind treats specially, whatever somebody called their module.
      const prepared = await context.prepareWorkspace(context.item, `"${module.name}"`);
      if (!prepared.ok) return { ok: false, reason: prepared.reason, ...(prepared.options ? { options: prepared.options } : {}) };

      // Read at dispatch, not at registration: a secret set while EO is
      // running should be usable without a restart.
      //
      // Scoped to the step the item is on, so the same module deploying
      // to staging and to production reads a different token at each —
      // falling back, name by name, to the shared value. A step a trial
      // plan redirects reads its trial-only values in place of its own,
      // on a trial item and nowhere else (EO-584).
      const { env, unreadable, dangling, variables, notRedirected } = environmentFor(
        options.secrets,
        module.manifest.needs.env,
        stepScopeFor(options.db, context.item, context.item.stepId),
        // Read at dispatch like everything else through this seam, so a
        // secret the last sync withdrew is gone from the next run rather
        // than from the next launch.
        organisationReader(options.organisationSecrets),
      );

      // Named apart from the unset ones, because the fix is different:
      // this value is on disk and the keychain that wrote it is gone, so
      // "set it" means set it again rather than set it at last.
      if (unreadable.length > 0) {
        return {
          ok: false,
          reason: `"${module.name}" cannot read ${unreadable.join(", ")} — ${unreadable.length === 1 ? "it was" : "they were"} stored by another machine or before this one's keychain was reset. Set ${unreadable.length === 1 ? "it" : "them"} again.`,
        };
      }

      // A reference that found nothing (EO-416), and a third sentence
      // because it is a third fix. The name *is* configured — saying "not
      // set" would send the person to a field that is already filled in —
      // and nothing about the module is wrong. What is missing is on the
      // machine: the variable, in the environment EO was launched with.
      // That EO reads it once, at start, is the half nobody guesses:
      // exporting it in a terminal afterwards changes nothing here.
      if (dangling.length > 0) {
        const each = dangling.map(({ name, variable }) => `${name} from its environment variable ${variable}`);
        const variables = [...new Set(dangling.map(({ variable }) => variable))];
        return {
          ok: false,
          reason:
            `"${module.name}" was not run: EO is set to read ${each.join(", and ")}, and ${variables.join(", ")} ${variables.length === 1 ? "is" : "are"} missing or empty there. ` +
            `EO reads its environment when it starts, so set ${variables.length === 1 ? "it" : "them"} where EO is launched from and restart EO — ` +
            `or store ${dangling.length === 1 ? "a value" : "values"} instead under Settings → Modules.`,
        };
      }

      // A redirected step whose own values name something its trial-only
      // ones do not (EO-584). Its own would point the real code at the
      // live target, and so would the shared value they were set up to
      // replace, so neither is given — and the fix is the trial's.
      if (notRedirected !== undefined) {
        return {
          ok: false,
          reason:
            `"${module.name}" was not run: this step is redirected on this trial, and ${notRedirected.join(", ")} ${notRedirected.length === 1 ? "is" : "are"} set on the step ` +
            `but not for its trial. A redirected step is never given the step's own values or the shared ones they replace — set ${notRedirected.length === 1 ? "a trial-only value" : "trial-only values"} for ${notRedirected.length === 1 ? "it" : "them"}, or run the step for real.`,
        };
      }

      const missing = module.manifest.needs.env.filter((name) => !(name in env));
      if (missing.length > 0) {
        return {
          ok: false,
          reason: `"${module.name}" needs ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not set. Add ${missing.length === 1 ? "it" : "them"} under Settings → Modules, or ask the assistant to set ${missing.length === 1 ? "a value" : "values"} on this step.`,
        };
      }

      // What this step sets for the inputs the module declares (EO-78).
      //
      // Read at dispatch and from the step the item is on, exactly as
      // the secrets above are, and for the same reason: two steps can run
      // one module and mean different things by it. The merge module
      // waits for CI, and eight minutes on one repository is ninety
      // seconds on another.
      //
      // `resolveInputs` lays these over the manifest's defaults, so a name
      // left unset is the module's own default rather than a blank — and
      // a name the manifest no longer declares is dropped there rather
      // than breaking anything here. Whether they are the *right type* is
      // checked in `runModule`, which is what owns the write to
      // `ctx.inputs`.
      // …and by the item's own version (EO-327, ARCHITECTURE.md, "Publish, lock and versions"). A
      // module step is
      // the sharpest case for it in the whole story: `inputs` and
      // `timeoutMs` are *executable* configuration, so an item that
      // entered on v1 and is dispatched after v2 retuned the step would
      // be run against numbers nobody agreed to for it — a merge module
      // told to wait ninety seconds for a repository whose CI takes
      // eight minutes, and a failure that looks like the module's.
      const step = stepForItem(options.db, context.item);

      // `ctx.run`, `ctx.workspace` and `ctx.project` (EO-711): read once,
      // here, after the workspace is prepared — the directory it was
      // prepared as is what `ctx.workspace` describes — and sent with
      // the run. Absent where the launcher has no reader, which a module
      // reads as nothing known.
      const snapshot = await options.launcher.items?.context({ item: context.item, runId: context.runId, workspace: prepared.workspace });

      // The transcript, through the run's own reporter rather than a
      // buffer of this module's own (EO-77). `run_events.seq` is
      // allocated in memory per buffer, so a second one over the same run
      // would hand out numbers the supervisor's had already used and the
      // transcript would silently drop rows. It also gets a module what
      // it never had: the throttled push that makes output appear while
      // it is still running, instead of only once the run ends.
      //
      // Output arrives here already redacted; a secret must never reach a
      // substrate nothing can take it back out of.
      return await runModule(options.launcher, {
        module,
        item: context.item,
        cwd: prepared.workspace.cwd,
        inputs: step?.inputs ?? {},
        // How long this step may take (EO-162). Read from the same step
        // row the inputs came from, and for the same reason: the merge
        // module waits for CI, and how long that repository's CI takes is
        // not a property of the code that waits. Absent when the step set
        // none, which is `DEFAULT_MODULE_TIMEOUT_MS` — so nothing changes
        // for anybody who has not configured one.
        //
        // Never clamped against the run timeout here. It cannot exceed it:
        // both writes refuse to store a pair that contradicts, so by the
        // time a value reaches this line it is already a number EO agreed
        // to (see `timeLimitBoundProblem`).
        ...(step?.timeoutMs == null ? {} : { timeoutMs: step.timeoutMs }),
        // What `ctx.answer()` will hand the module (EO-183).
        //
        // Read here rather than in the host because this side is the one
        // with a writable handle's worth of context: the shared reader
        // consults the agents table to tell a system agent's reading of a
        // reply from any other agent's comment, and the host's handle is
        // opened read-only for one item. Read at dispatch, like the
        // secrets and the inputs above, because the answer arrives
        // between two runs — that is the whole point of it.
        answer: answerToLastAsk(options.db, context.item.id),
        ...(snapshot === undefined ? {} : { context: snapshot }),
        env,
        // Which of those are environment variables (EO-485): not
        // secret, so left in the transcript rather than redacted.
        variables,
        ...(context.signal ? { signal: context.signal } : {}),
        // The run's own systemd scope and memory limit (EO-738).
        ...(context.processScope ? { scope: context.processScope } : {}),
        onOutput: context.report,
        // The other half of the channel (EO-75). The host asked; this
        // is the side that holds the writable handle, so this is where
        // `postComment` runs — with the mentions, the Jira mirror and
        // the push to open windows a direct insert would skip.
        //
        // Each of the three names the run, so on a check of a step that
        // keeps checking — which has no run row until it has something
        // to record (EO-456) — the row is made first.
        onComment: (comment) => {
          context.ensureRun?.();
          return postModuleComment(options.db, { module, item: context.item, runId: context.runId }, comment);
        },
        // And files (EO-414), by the same route and for the same reason.
        onAttach: (attach) => {
          context.ensureRun?.();
          return postModuleAttachment(options.db, options.attachments, { module, item: context.item, runId: context.runId }, attach);
        },
        // And work (EO-433): an item is created here for the reason a
        // comment is posted here, and the answer goes back to the host
        // because the module needs the new item's key.
        //
        // Asked of the record that owns this item rather than written
        // to this database outright: on a signed-in desktop these
        // tables are a replica of an organisation's project, and an
        // item created only here is one the organisation never sees.
        onCreate: (creation, limits) => {
          context.ensureRun?.();
          return (options.record ?? recordFor(options.db)).createItemFromModule({
            module,
            item: context.item,
            runId: context.runId,
            creation,
            atCap: limits.atCap,
            ...(options.onItemCreated === undefined ? {} : { onCreated: options.onItemCreated }),
          });
        },
      });
    };
  };
}
