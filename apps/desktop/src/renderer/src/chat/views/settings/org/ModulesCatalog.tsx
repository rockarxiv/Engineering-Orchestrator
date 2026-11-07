import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import {
  aliasNotice,
  deprecatedContextMethodsCalledIn,
  ModuleManifestSchema,
  portabilityWarnings,
  versionLabel,
  type DeprecatedToolName,
  type ModuleManifest,
  type ModuleVersion,
  type ModuleView,
  type PortabilityWarning,
} from "@eo/core";
import { cn } from "@eo/ui";
import { useAliasesRetired } from "../../../../hooks/useAppVersion";
import { ipcQuery } from "../../../../query/client";
import { modulesKey, useChromeVocabulary, useModules } from "../../../../query/hooks";
import { Button, CardSection, Chip, EmptyState, Field, Loading, Switch, TextArea, TextInput } from "../../../kit";
import { MachineSpecificValues } from "../../../modules/MachineSpecificValues";
import { useDraftMachineSpecific } from "../../../../shared/modules/draftMachineSpecific";
import { ModuleHistory } from "../../../modules/ModuleHistory";
import { EnvironmentVariables } from "../../../modules/EnvironmentVariables";
import { ModuleSecrets } from "../../../modules/ModuleSecrets";
import { ENVIRONMENT_VARIABLES_COPY } from "../../../../shared/modules/environmentVariableStatus";
import { ModuleTests } from "../../../modules/ModuleTests";
import { useModuleApproval } from "../../../modules/useModuleApproval";
import { draftWatchFlag, watchFlagDescription, withDraftWatchFlag } from "../../../../shared/modules/manifestWatch";

/**
 * The module catalogue (KAN-103), in the chat layout's terms.
 *
 * A module is deterministic work a step runs that EO did not ship — the
 * deploy that was a script before agents existed. This is the record:
 * what exists, what each one needs, and which are approved to run. Cards
 * are summaries until asked (EO-357): one module's warnings, tests and
 * history at a time, so the page stays a list rather than a scroll.
 */

const STARTER_MANIFEST_VALUE = {
  name: "Deploy",
  description: "Builds and deploys the current branch to staging.",
  inputs: { environment: { type: "string", default: "staging" } },
  needs: { bin: ["pnpm"], env: [], network: false, item: false, comment: false, attach: false, create: false },
  results: ["deployed", "failed"],
};

const STARTER_CODE = `export const manifest = {
  name: "Deploy",
  description: "Builds and deploys the current branch to staging.",
  inputs: { environment: { type: "string", default: "staging" } },
  needs: { bin: ["pnpm"], env: [], network: false, item: false, comment: false, attach: false, create: false },
  results: ["deployed", "failed"],
};

export default async function run(ctx) {
  await ctx.exec("pnpm", ["build"]);
  return { ok: true, result: "deployed", detail: "Deployed " + ctx.inputs.environment };
}
`;

const STARTER_MANIFEST = JSON.stringify(STARTER_MANIFEST_VALUE, null, 2);

interface Restoring {
  moduleId: string;
  number: number;
  /** How many test cases the version holds — what the restore puts back. */
  testCount: number;
  /** How many the module has now — what the restore replaces. */
  currentTestCount: number;
  /** The version's cases themselves, so the editor can scan what the restore would put back (EO-449). */
  tests: { description: string; source: string }[];
}

export interface ModuleDraft {
  id?: string;
  slug: string;
  name: string;
  description: string;
  code: string;
  manifest: string;
  /**
   * Set when the draft is an older version being restored (EO-361):
   * saving goes through `moduleVersions:restore`, and the editor is
   * read-only, because the restore is one write that takes no edits.
   */
  restoring?: Restoring;
}

const BLANK: ModuleDraft = { slug: "", name: "", description: "", code: STARTER_CODE, manifest: STARTER_MANIFEST };

const cases = (count: number) => `${count} test case${count === 1 ? "" : "s"}`;

/** The manifest in the draft, checked against the schema the save is checked against. */
function parseManifest(text: string): ModuleManifest {
  const parsed = ModuleManifestSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
  return parsed.data;
}

function draftOf(module: ModuleView): ModuleDraft {
  return {
    id: module.id,
    slug: module.slug,
    name: module.name,
    description: module.description,
    code: module.code,
    manifest: JSON.stringify(module.manifest, null, 2),
  };
}

/** The module as it is, with an older version's code and manifest in the editor. */
function restoreDraftOf(module: ModuleView, version: ModuleVersion): ModuleDraft {
  return {
    ...draftOf(module),
    code: version.code,
    manifest: JSON.stringify(version.manifest, null, 2),
    restoring: { moduleId: module.id, number: version.number, testCount: version.tests.length, currentTestCount: module.testCount, tests: version.tests },
  };
}

/**
 * What a person is being asked to judge when they approve: the declared
 * needs, which can be weighed without reading JavaScript. A secret and the
 * open network are the module reaching past EO, so they are amber; reading
 * work and commenting are EO's own channel used as intended (EO-74, EO-75).
 * Attaching files (EO-414) is said beside commenting and counts as a need:
 * a module that declares nothing else still puts files where they can be
 * uploaded, and "needs nothing" would hide that from whoever approves it.
 */
export function Needs({ module }: { module: ModuleView }) {
  const vocabulary = useChromeVocabulary();
  const { bin, env, network, item, comment, attach, create } = module.manifest.needs;
  if (bin.length === 0 && env.length === 0 && !network && !item && !comment && !attach && !create)
    return <span className="text-[12px] text-ink-subtle">Needs nothing outside the worktree.</span>;

  return (
    <div aria-label={`What ${module.name} needs`} className="flex min-w-0 flex-wrap items-center gap-1">
      {bin.map((name) => (
        <Chip key={`bin-${name}`} className="font-mono">
          {name}
        </Chip>
      ))}
      {env.map((name) => (
        <Chip key={`env-${name}`} tone="paused" className="font-mono">
          {name}
        </Chip>
      ))}
      {network ? <Chip tone="paused">network</Chip> : null}
      {item ? <Chip>reads {vocabulary.items.toLowerCase()}</Chip> : null}
      {comment ? <Chip>comments</Chip> : null}
      {attach ? <Chip>attaches files</Chip> : null}
      {create ? <Chip>creates {vocabulary.items.toLowerCase()}</Chip> : null}
    </div>
  );
}

/**
 * What the module looks like it would need on somebody else's machine
 * (EO-80). Advice, and worded as advice: the scan reads text, so a
 * sentence can set it off, and what a module may import is decided by the
 * loader when it runs. Given the warnings rather than the module, because
 * the card scans what was saved and the editor scans the draft.
 */
function Portability({ warnings }: { warnings: PortabilityWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[12px] bg-paused/12 px-3.5 py-2.5">
      <p className="text-[12.5px] leading-relaxed text-ink">
        This looks like it imports something that is not a Node builtin, so it would not run on a machine that imported this pipeline. EO
        decides what a module may actually import when it runs; this is a read of the text, so a sentence can set it off.
      </p>
      {warnings.map((warning) => (
        <p key={`${warning.line}-${warning.specifier}`} className="text-[12px] text-ink-subtle">
          line {warning.line}: <code className="font-mono">{warning.specifier}</code>
        </p>
      ))}
    </div>
  );
}

/**
 * A module still calling the module host by the name EO renamed (KAN-178),
 * where approving it is actionable. Advice beside `Portability`; neither
 * disables a button, because `ctx.ticket()` works today.
 */
function AliasedCalls({ calls, retired }: { calls: DeprecatedToolName[]; retired: boolean }) {
  if (calls.length === 0) return null;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 rounded-[12px] px-3.5 py-2.5", retired ? "bg-danger/12" : "bg-paused/12")}>
      <p className={cn("text-[12.5px] leading-relaxed", retired ? "text-danger" : "text-ink")}>
        This module {aliasNotice("module", retired)}. It still runs; what changes is the release after this one.
      </p>
      {calls.map((call) => (
        <p key={call.deprecated} className="text-[12px] text-ink-subtle">
          <code className="font-mono">{call.deprecated}()</code> → <code className="font-mono">{call.replacement}()</code>
        </p>
      ))}
    </div>
  );
}

function ModuleEditor({
  draft,
  onChange,
  onCancel,
  onSave,
  problem,
  saving,
}: {
  draft: ModuleDraft;
  onChange: (draft: ModuleDraft) => void;
  onCancel: () => void;
  onSave: (approve: boolean) => void;
  problem: string | null;
  saving: boolean;
}) {
  const vocabulary = useChromeVocabulary();
  // Read off the textarea rather than what was last saved (EO-80,
  // KAN-178): the advice has to come before the approval, not after it.
  const warnings = useMemo(() => portabilityWarnings(draft.code), [draft.code]);
  // Values that only hold on this machine (EO-449), read off the same
  // draft — code and manifest as they are typed — and the module's cases.
  const machineSpecific = useDraftMachineSpecific(draft);
  const aliased = useMemo(() => deprecatedContextMethodsCalledIn(draft.code), [draft.code]);
  const aliasesRetired = useAliasesRetired();
  const readOnly = draft.restoring !== undefined;
  const watchFlag = draftWatchFlag(draft.manifest);
  const items = vocabulary.items.toLowerCase();
  const title = draft.restoring ? `Restoring ${draft.name}` : draft.id === undefined ? "New module" : `Edit ${draft.name}`;
  // Opened from a card that may be far up the list: brought into view once
  // per thing being edited, so a narrow canvas does not hide it below.
  const anchor = useRef<HTMLDivElement>(null);
  const subject = `${draft.id ?? "new"}:${draft.restoring?.number ?? ""}`;
  useEffect(() => {
    anchor.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [subject]);

  return (
    <div ref={anchor} className="flex min-w-0 flex-col">
      <CardSection title={title} className="shadow-[inset_0_0_0_1px_var(--color-line)]">
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name">
            <TextInput readOnly={readOnly} value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
          </Field>
          <Field label="Slug" hint="Stable; what an exported pipeline names.">
            <TextInput readOnly={readOnly} className="font-mono" value={draft.slug} onChange={(event) => onChange({ ...draft, slug: event.target.value })} />
          </Field>
        </div>
        <Field label="Description" hint="How anyone — including the architect — finds this again.">
          <TextInput readOnly={readOnly} value={draft.description} onChange={(event) => onChange({ ...draft, description: event.target.value })} />
        </Field>
        {draft.restoring ? (
          <p
            role="note"
            aria-label={`Restoring ${versionLabel(draft.restoring.number)}`}
            className="rounded-[12px] bg-accent-subtle/60 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink"
          >
            Saving restores {versionLabel(draft.restoring.number)} including its {cases(draft.restoring.testCount)}, replacing the current{" "}
            {draft.restoring.currentTestCount}. It is shown as that version holds it; to change it, save the restore and then edit the module.
            Nothing changes until you save; Cancel leaves the module as it is.
          </p>
        ) : null}
        <Field label="Manifest" hint="Inputs, needs, results.">
          <TextArea className="h-40 font-mono text-[12px]" readOnly={readOnly} value={draft.manifest} onChange={(event) => onChange({ ...draft, manifest: event.target.value })} />
        </Field>
        {/* The manifest's `watch` flag (EO-458), read from and written
            into the text above so there is one copy of it. */}
        <Switch
          checked={watchFlag === true}
          disabled={readOnly || watchFlag === null}
          onChange={(on) => onChange({ ...draft, manifest: withDraftWatchFlag(draft.manifest, on) })}
          label="Can keep checking"
          description={watchFlagDescription(watchFlag)}
        />
        <Field label="Code" hint="Node builtins only; ctx is the whole surface.">
          <TextArea className="h-64 font-mono text-[12px]" readOnly={readOnly} value={draft.code} onChange={(event) => onChange({ ...draft, code: event.target.value })} />
        </Field>
        {/* Neither button below is disabled by these: they are advice. */}
        <Portability warnings={warnings} />
        <MachineSpecificValues warnings={machineSpecific} />
        <AliasedCalls calls={aliased} retired={aliasesRetired} />
        {/* One line per failing case when approval was refused, so kept as written. */}
        {problem ? (
          <p role="alert" className="whitespace-pre-line text-[12.5px] text-danger">
            {problem}
          </p>
        ) : null}
        {/* Said plainly: there is no sandbox, and `needs.item` is the
            author's word rather than a gate (EO-74, EO-75). */}
        <p className="text-[12px] leading-relaxed text-ink-subtle">
          A module runs on this machine with your permissions. EO injects only the secrets it declares and refuses a binary it did not, and it
          can read your {items} and their comments and post comments of its own — its manifest says whether it means to, but that is the
          author’s word rather than a limit EO enforces. A comment it posts is signed with its name, cannot mention anyone, and is mirrored to
          Jira like any other. Approving one is trusting whoever wrote it.
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Approving is its own act after the save: it runs the tests on
              what was just saved (EO-353), so an edit never approves itself. */}
          <Button variant="primary" disabled={saving} onClick={() => onSave(true)}>
            {saving ? "Working…" : "Save and approve"}
          </Button>
          <Button disabled={saving} onClick={() => onSave(false)}>
            Save
          </Button>
          <Button variant="ghost" disabled={saving} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </CardSection>
    </div>
  );
}

/** One module, as a summary until it is opened. */
function ModuleCard({
  module,
  expanded,
  onToggle,
  onEdit,
  onDelete,
  onRestore,
}: {
  module: ModuleView;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRestore: (version: ModuleVersion) => void;
}) {
  const detailsId = useId();
  const aliasesRetired = useAliasesRetired();
  return (
    <li className="flex min-w-0 flex-col gap-2 py-3">
      <div className="flex min-w-0 items-start gap-2">
        {/* Its own control rather than the whole header, so Edit and Delete never open the card. */}
        <button
          type="button"
          aria-label={`Details of ${module.name}`}
          aria-expanded={expanded}
          aria-controls={expanded ? detailsId : undefined}
          onClick={onToggle}
          className="mt-0.5 grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[8px] text-ink-subtle hover:bg-canvas-raised hover:text-ink"
        >
          <ChevronRight aria-hidden size={14} className={cn("transition-transform", expanded && "rotate-90")} />
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-[13.5px] font-medium text-ink">{module.name}</h3>
            {/* Unapproved is the state that matters: a pipeline naming one is refused at publish. */}
            {module.approvedAt === null ? <Chip tone="paused">Not approved</Chip> : <Chip tone="running">Approved</Chip>}
            <code className="font-mono text-[11.5px] text-ink-subtle">{module.slug}</code>
          </div>
          <p className="text-[12.5px] leading-snug text-ink-muted">{module.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 pl-[34px]">
        <Needs module={module} />
        <p className="text-[11.5px] text-ink-subtle">
          Returns {module.manifest.results.join(", ")}
          {module.manifest.watch === true ? " · can keep checking" : ""} · used by {module.usedByStepCount} step{module.usedByStepCount === 1 ? "" : "s"}
        </p>
        {/* Unmounted when collapsed, so an open "Add scenario" chat closes with it. */}
        {expanded ? (
          <div id={detailsId} className="flex min-w-0 flex-col gap-2.5 pt-1">
            <Portability warnings={module.portability} />
            <MachineSpecificValues warnings={module.machineSpecific} />
            <AliasedCalls calls={deprecatedContextMethodsCalledIn(module.code)} retired={aliasesRetired} />
            <ModuleTests module={module} />
            <ModuleHistory module={module} onRestore={onRestore} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function ModulesCatalog() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ModuleDraft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [archiveProblem, setArchiveProblem] = useState<string | null>(null);
  // One card open at a time (EO-357), local and unpersisted.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Subscribed to `config:changed` (EO-354): a background test run ends with it.
  const modules = useModules();

  // Approved: the editor's work is done. Refused, or the coverage window
  // cancelled: the module is saved and unapproved, and the editor stays
  // open on it with the reason (EO-353).
  const approval = useModuleApproval({
    onApproved: () => {
      setDraft(null);
      setProblem(null);
      void queryClient.invalidateQueries({ queryKey: modulesKey });
    },
  });

  const save = useMutation({
    mutationFn: async (input: { draft: ModuleDraft; approve: boolean }) => {
      // A restore is the save, and the whole of it (EO-361).
      const restoring = input.draft.restoring;
      if (restoring !== undefined) {
        const restored = await ipcQuery("moduleVersions:restore", { moduleId: restoring.moduleId, number: restoring.number });
        if (!restored.restored || restored.module === null) return { saved: false, module: null, problem: restored.problem ?? "It was not restored." };
        return { saved: true, module: restored.module, problem: null };
      }
      // Parsed here so a typo in the JSON is reported beside the field.
      return ipcQuery("modules:save", {
        ...(input.draft.id === undefined ? {} : { id: input.draft.id }),
        slug: input.draft.slug,
        name: input.draft.name,
        description: input.draft.description,
        code: input.draft.code,
        manifest: parseManifest(input.draft.manifest),
        originalScript: null,
        source: "user",
      });
    },
    onSuccess: (result, input) => {
      if (!result.saved) {
        setProblem(result.problem);
        return;
      }
      setProblem(null);
      void queryClient.invalidateQueries({ queryKey: modulesKey });
      // A restore that came back approved is code a person already approved.
      if (input.approve && result.module !== null && !(input.draft.restoring && result.module.approvedAt !== null)) {
        // Held open on what was saved, now with its id, so a refusal
        // leaves the person editing the module rather than a new copy.
        setDraft(draftOf(result.module));
        approval.approve(result.module);
        return;
      }
      setDraft(null);
    },
    onError: (error: Error) => setProblem(error.message),
  });

  const archive = useMutation({
    mutationFn: (id: string) => ipcQuery("modules:archive", { id }),
    onSuccess: (result) => {
      if (!result.archived) {
        setArchiveProblem(`Still used by ${result.usedByStepCount} step(s). Take it off those steps first.`);
        return;
      }
      setArchiveProblem(null);
      void queryClient.invalidateQueries({ queryKey: modulesKey });
    },
    onError: (error: Error) => setArchiveProblem(error.message),
  });

  const rows = modules.data?.modules ?? [];

  return (
    <>
      <CardSection
        title="Modules"
        description="Deterministic work a step can run — a deploy, a release tag, a check. No agent, because there is no judgement in it."
        actions={
          <Button
            icon={<Plus size={13} />}
            disabled={draft !== null}
            onClick={() => {
              setProblem(null);
              setDraft(BLANK);
            }}
          >
            New module
          </Button>
        }
      >
        {modules.isLoading ? <Loading>Reading the modules…</Loading> : null}
        {!modules.isLoading && rows.length === 0 && draft === null ? (
          <EmptyState title="No modules yet">A module is what a step runs when the work would have been a script before agents existed.</EmptyState>
        ) : null}
        {rows.length > 0 ? (
          <ul aria-label="Modules" className="flex min-w-0 flex-col [&>li+li]:border-t [&>li+li]:border-line/60">
            {rows.map((module) => (
              <ModuleCard
                key={module.id}
                module={module}
                expanded={expandedId === module.id}
                onToggle={() => setExpandedId(expandedId === module.id ? null : module.id)}
                onEdit={() => {
                  setProblem(null);
                  setDraft(draftOf(module));
                }}
                onDelete={() => archive.mutate(module.id)}
                onRestore={(version) => {
                  setProblem(null);
                  setDraft(restoreDraftOf(module, version));
                }}
              />
            ))}
          </ul>
        ) : null}
        {archiveProblem ? <p className="text-[12.5px] text-danger">{archiveProblem}</p> : null}
      </CardSection>

      {draft !== null ? (
        <ModuleEditor
          draft={draft}
          onChange={setDraft}
          onCancel={() => {
            setDraft(null);
            setProblem(null);
          }}
          onSave={(approve) => save.mutate({ draft, approve })}
          problem={problem ?? approval.problem}
          saving={save.isPending || approval.approving}
        />
      ) : null}
      {approval.dialog}

      {/* Names only, until the person presses Reveal on a row (EO-489); a module is given only the names it declares. */}
      <CardSection
        title="Secrets"
        description={
          <>
            Stored in your OS keychain, never in EO&apos;s database. A module is given only the names it declares in{" "}
            <code className="font-mono">needs.env</code>, and their values are stripped from anything it prints. These are the shared values — a
            step can have its own, set through the assistant on a card.
          </>
        }
      >
        <ModuleSecrets />
      </CardSection>

      {/* Values that are not secret (EO-486): shown in full, and given to more than modules. */}
      <CardSection title="Environment variables" description={ENVIRONMENT_VARIABLES_COPY}>
        <EnvironmentVariables />
      </CardSection>
    </>
  );
}
