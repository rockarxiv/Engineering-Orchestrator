import { moduleInputProblems, type GalleryNeedView, type ModuleInputType, type PipelineExport, type StepInputs, type TemplateBlankKind } from "@eo/core";
import type { ImportPreflight } from "../modules/pipelineTransfer.js";

/**
 * The template's own blanks, and what it still needs (EO-316,
 * `ARCHITECTURE.md`, "The gallery", "The needs check", "What a person sees first").
 *
 * The original design is the reason this exists at all: "a template … asks its
 * own blanks rather than sending the person into a blank conversation".
 * The template already knows what somebody wants; what it lacks is
 * which folder, which day, who approves — four or five fields, not a
 * conversation.
 *
 * Two lists come out of one pack, and they are different questions:
 *
 *  - **Blanks** are what a person types *before* anything is created.
 *    They come from two places — `pipeline_steps.inputs`, which is what
 *    a module step sets for the inputs its module declares, and the
 *    pack's own `template.blanks`, which is the folder, the connector,
 *    the schedule and the key prefix.
 *  - **Needs** are what is still missing *after*, which is the needs
 *    check (ARCHITECTURE.md, "The needs check"). Derived from the import preflight rather than
 *    invented here, so a line on a card and a line on the needs check
 *    cannot come to disagree.
 */

/** One field of the short form "Use this" puts up (ARCHITECTURE.md, "The gallery"). */
export interface GalleryBlank {
  /** For a `stepInput`, `<document step id>.<input name>`; otherwise the pack's own key. */
  key: string;
  kind: TemplateBlankKind;
  label: string;
  help: string;
  required: boolean;
  /**
   * What the field starts at, always as text.
   *
   * A string on the wire whatever `valueType` says, because a form field
   * holds text and the IPC payload is what a form field produced. What
   * the value *is* is `valueType`'s business, and `stepInputValues`
   * is where the two meet.
   */
  default: string;
  /**
   * The type a module declared for this input (EO-316).
   *
   * `string` for every blank that is not a `stepInput`, and for a module
   * input declared as one.
   *
   * Here because a module's inputs are typed and a form's are not.
   * `ModuleInputSchema` allows `string`, `number` and `boolean`, and
   * `pipeline_steps.inputs` stores what it is given; without this the
   * gallery wrote `"900"` where the manifest said `900`, the install
   * reported success, and the step's first real run was refused by
   * `moduleInputProblems` for a type mismatch nobody could see the
   * origin of. Carried to the screen as well, so the field is drawn as
   * what it is rather than as a box.
   */
  valueType: ModuleInputType;
  /** For `connector`, which of the pack's connectors this is about. */
  connector: string | null;
}

/**
 * One slot the template names rather than filling (the original design).
 *
 * "A template names role slots ('Approver'), never people." A slot is a
 * **human step that decides**: a step whose whole content is somebody
 * choosing between the results it declares, and which has nobody to
 * choose until this machine says who. An agent step's role is a
 * different question with a different answer — it is filled by an agent,
 * the import creates one, and where it cannot the needs check says so.
 * Only a person can be pre-filled with "you".
 *
 * **A terminal step is not one**, and neither is a human step with
 * nothing to decide. "Done" and "Filed" are where work comes to rest:
 * nothing is routed out of them, nobody presses anything on them, and
 * the shipped Delivery pipeline's own terminal step has carried no owner
 * since it existed. Asking "who owns Filed?" on the form is a question
 * with no consequence — and answering it on the person's behalf, which
 * is what solo mode does with every slot, writes an owner onto a column
 * that has no decision to make. So the test is the step's own declared
 * results as well as its place: a `user` step that is routed out of and
 * offers buttons is a decision, and one that is terminal, or offers
 * none, is a destination.
 */
export interface GalleryRoleSlot {
  /** The document's own step id. Ids are re-minted on import, so this is matched by position afterwards. */
  stepId: string;
  /** What the step is called: "Approve". */
  name: string;
}

/**
 * One line of the needs check: what is missing, whether it is, why, and
 * the one button that fixes it (ARCHITECTURE.md, "The needs check").
 *
 * The wire type itself rather than a twin of it (EO-317). This is the
 * only thing that composes one and the needs check is the only thing
 * that reads one, so a second declaration here would be a second place
 * to add a field to — and the failure that would follow is a `why` the
 * main process writes and the screen has no room for.
 */
export type GalleryNeed = GalleryNeedView;

/**
 * The blanks, in the order the form asks them.
 *
 * Step inputs first, because they are about the pipeline itself and the
 * pack's blanks are about this installation — and within each, the
 * document's own order, so an author controls what is asked first.
 */
export function galleryBlanks(document: PipelineExport): GalleryBlank[] {
  const blanks: GalleryBlank[] = [];

  // What a module step will set for its module's declared inputs.
  //
  // Derived from the manifest rather than carried in the document,
  // because `inputs` is deliberately omitted from an export (EO-78): what
  // a step sets is a fact about the installation that exported it. The
  // *questions* travel anyway, because the manifest does — so a template
  // can ask "which channel" without the pack carrying somebody else's
  // answer to it.
  for (const step of document.steps) {
    if (step.type !== "module" || step.entryAction === null) continue;
    const module = document.modules.find((candidate) => candidate.slug === step.entryAction);
    if (module === undefined) continue;
    for (const [name, input] of Object.entries(module.manifest.inputs)) {
      blanks.push({
        key: `${step.id}.${name}`,
        kind: "stepInput",
        label: `${step.name} · ${name}`,
        help: input.description ?? "",
        // A declared default is the module author's answer, so the field
        // starts there and the person may leave it. One without is a
        // question nobody has answered yet.
        required: input.default === undefined || input.default === null,
        default: input.default === undefined || input.default === null ? "" : String(input.default),
        valueType: input.type,
        connector: null,
      });
    }
  }

  for (const blank of document.template?.blanks ?? []) {
    blanks.push({
      key: blank.key,
      kind: blank.kind,
      label: blank.label,
      help: blank.help,
      required: blank.required,
      default: blank.default,
      // A template's own blanks are a folder, a schedule, a key prefix
      // or a connector, and every one of them is text.
      valueType: "string",
      connector: blank.connector,
    });
  }

  return blanks;
}

/** Every human step the document draws that somebody has to decide, in pipeline order. */
export function galleryRoleSlots(document: PipelineExport): GalleryRoleSlot[] {
  return [...document.steps]
    .filter((step) => step.type === "user" && !step.isTerminal && step.results.length > 0)
    .sort((left, right) => left.position - right.position)
    .map((step) => ({ stepId: step.id, name: step.name }));
}

/**
 * "What this needs", off the pack's own preflight (ARCHITECTURE.md, "The needs check").
 *
 * One line per thing that has to be true before real work runs, each
 * saying whether it is, **why it is not, and the one button that fixes
 * it** (EO-317, ARCHITECTURE.md, "What a person sees first"). The preflight is the source for
 * every one of them, which is the point: the gallery card, the "Use
 * this" form and the needs check are three views of one answer rather
 * than three opinions about it.
 *
 * The three parts of a red line are not decoration. A line that only
 * says "not connected" leaves a person to guess between a token they
 * never set, an account they signed into twice and a folder somebody
 * renamed — so `why` carries whichever of those the check actually
 * found, in its own words, and `fix` names the one gesture that changes
 * it. Where nothing anybody can press would help — a binary that is not
 * on this machine's PATH — the button is absent rather than apologetic.
 */
export function galleryNeeds(preflight: ImportPreflight, extra: readonly GalleryNeed[] = [], signedIn: readonly string[] = []): GalleryNeed[] {
  const needs: GalleryNeed[] = [];

  for (const slot of preflight.roleSlots) {
    // One sentence, two situations, and they are fixed by different
    // buttons — which is the whole of "the one button that fixes it"
    // being a real promise rather than a shape.
    //
    // **Nothing is signed in.** Then there is nothing to point an agent
    // at, and the button is the sign-in: sending somebody to make an
    // agent row first would send them past the thing that is actually
    // missing.
    //
    // **Something is signed in, and the role still has nobody.** This is
    // where an import lands, every time: a pack's role names no backend
    // — a backend is a fact about the installing machine, not about the
    // pack — so `writeRoles` creates the agent pointed at nothing and
    // switched off. The line cannot go green by signing in, because the
    // row was never the problem's subject. So the button says which
    // backend it will use and does it.
    const backend = slot.recommendedBackend;
    // The pack's own recommendation where this machine has it, and
    // otherwise whatever it does have: any signed-in backend can play a
    // role whose pack named none, which is most of them.
    const usable = backend !== null && signedIn.includes(backend) ? backend : (signedIn[0] ?? null);
    needs.push({
      key: `role:${slot.slug}`,
      line: `An agent for "${slot.slug}"`,
      met: slot.filled,
      why: slot.filled
        ? null
        : usable === null
          ? backend === null
            ? `Nothing on this machine is signed in, so there is nothing for the "${slot.slug}" steps to run on.`
            : `This pack was built on ${backend}, and nothing on this machine is signed in to ${backend}.`
          : `No agent here plays "${slot.slug}" yet — the one this pack brought names no backend, so it has nothing to run on.`,
      fix: slot.filled
        ? null
        : usable === null
          ? { kind: "backend", label: backend === null ? "Sign in" : `Sign in to ${backend}`, target: backend }
          : { kind: "role", label: `Use ${usable} for this`, target: slot.slug },
    });
  }

  for (const connector of preflight.connectors) {
    needs.push({
      key: `connector:${connector.slug}`,
      line: `${connector.label} — ${connector.description}`,
      met: connector.connected,
      why: connector.connected ? null : `Nothing on this machine is signed in to ${connector.label} yet, so anything sent through it would go nowhere.`,
      // The server name rather than the connector's slug, because the
      // button hands off to EO-315's own row — which is keyed by the
      // name the model sees in every tool id, and is the same line read
      // for the third time (see `ConnectorNeeds`).
      fix:
        connector.connected || connector.server === null
          ? null
          : { kind: "connector", label: `Connect ${connector.label}`, target: connector.server },
    });
  }

  for (const secret of preflight.missingSecrets) {
    needs.push({
      key: `secret:${secret.name}`,
      line: `${secret.name}, for ${secret.wantedBy.join(", ")}`,
      met: false,
      why: `EO has no value for ${secret.name} on this machine, so ${secret.wantedBy.join(", ")} would run without it.`,
      fix: { kind: "secret", label: "Set it", target: secret.name },
    });
  }

  for (const binary of preflight.missingBinaries) {
    needs.push({
      key: `binary:${binary.name}`,
      line: `${binary.name} on your PATH, for ${binary.wantedBy.join(", ")}`,
      met: false,
      // No button, deliberately. Installing somebody's compiler is not a
      // thing EO can do on their behalf, and a button that opened a web
      // page would be EO pretending to fix something it cannot.
      why: `No directory on this machine's PATH provides ${binary.name}. Install it, then come back to this line.`,
      fix: null,
    });
  }

  if (preflight.moduleCount > 0) {
    needs.push({
      key: "modules",
      line: `${preflight.moduleCount} module${preflight.moduleCount === 1 ? "" : "s"} to read and approve`,
      met: false,
      why: `A module is code from somebody else's machine. EO runs none of it until you have read it in Settings → Modules and said so.`,
      fix: null,
    });
  }

  return [...needs, ...extra];
}

/**
 * What a module step will be given, parsed into the types its manifest
 * declares (EO-316).
 *
 * The form answers in text — a field holds text — and
 * `pipeline_steps.inputs` holds `string | number | boolean`. Between the
 * two somebody has to read `"900"` as `900`, and it has to be here
 * rather than at the field, because the authority on what an input *is*
 * is the module's manifest and the manifest is in this document.
 *
 * Held to that manifest by `moduleInputProblems` — the same function
 * `validatePipeline` and `runModule` apply, so the gallery cannot come
 * to disagree with them about what a valid value is. That matters more
 * than it sounds: the failure this closes was an install that reported
 * success and a first run refused for a type mismatch, which is the
 * worst possible place to find out.
 *
 * An empty answer is **absent** rather than empty-string, which is what
 * `StepInputsSchema` means by an unset input: the manifest's own default
 * applies, and a step that stored `""` for a number would be a step
 * overriding a default with nonsense.
 */
export function stepInputValues(
  document: PipelineExport,
  blanks: readonly GalleryBlank[],
  answers: Record<string, string>,
): { ok: true; byStep: Map<string, StepInputs> } | { ok: false; problems: string[] } {
  const byStep = new Map<string, StepInputs>();
  const problems: string[] = [];

  for (const blank of blanks) {
    if (blank.kind !== "stepInput") continue;
    const at = blank.key.lastIndexOf(".");
    if (at <= 0) continue;
    const stepId = blank.key.slice(0, at);
    const name = blank.key.slice(at + 1);

    const written = (answers[blank.key] ?? blank.default).trim();
    if (written === "") continue;

    const value = parseInputValue(written, blank.valueType);
    if (value === null) {
      problems.push(`"${blank.label}" expects a ${blank.valueType}, and "${written}" is not one.`);
      continue;
    }
    byStep.set(stepId, { ...(byStep.get(stepId) ?? {}), [name]: value });
  }

  // And the manifest's own word on the result, so a type this file
  // learns to parse and the module host does not is caught here.
  for (const [stepId, inputs] of byStep) {
    const step = document.steps.find((candidate) => candidate.id === stepId);
    const module = document.modules.find((candidate) => candidate.slug === step?.entryAction);
    if (module === undefined) continue;
    problems.push(...moduleInputProblems(module.manifest, inputs).map((problem) => `${step?.name ?? stepId}: ${problem}`));
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, byStep };
}

/**
 * One typed value out of what somebody typed, or null where the text is
 * not that type.
 *
 * `Number` rather than `parseFloat`, so `"12abc"` is refused rather than
 * silently read as 12 — a step configured with half of what a person
 * meant is worse than one that would not save. And the two words for a
 * boolean rather than JavaScript's truthiness, which would make the
 * string "false" true.
 */
function parseInputValue(written: string, type: ModuleInputType): string | number | boolean | null {
  if (type === "string") return written;
  if (type === "boolean") {
    if (written === "true") return true;
    if (written === "false") return false;
    return null;
  }
  const value = Number(written);
  return Number.isFinite(value) ? value : null;
}
