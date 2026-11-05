import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes } from "lucide-react";
import type { ModuleView } from "@eo/core";
import { ipcQuery } from "../../query/client";
import { moduleTestsKey, modulesKey, useChromeVocabulary, useModulesWithDeleted } from "../../query/hooks";
import { Button, Chip, Dialog, ErrorLine, Facts, Loading } from "../kit";
import { CoverageBadge } from "./CoverageBadge";
import { MachineSpecificValues } from "./MachineSpecificValues";
import { ModuleTestList } from "./ModuleTestList";
import { useModuleApproval } from "./useModuleApproval";

/**
 * A module the assistant proposed, where the conversation is (EO-398):
 * what it is called, where it stands, and the two things a person does
 * with one — read it, and approve it.
 *
 * A module proposed on its own, that no pipeline draft needs. One the
 * draft card lists is approved with the draft, by its one Approve and
 * publish (EO-581), and drawn as a `DraftModuleRow` there instead — which
 * shares this card's code view, `ModuleSource`.
 *
 * It is given a slug and reads everything else from the catalog. Nothing
 * about the module is taken from the message it arrived in, so the card
 * is right however the module came to be approved — here, in Settings →
 * Modules, in another window — and says so when it has since been
 * deleted. `config:changed` and every approval refresh the catalog, and
 * this with it.
 *
 * Approve is `useModuleApproval`: the same `modules:approve` call Settings
 * makes, which runs the tests at that moment. A refusal names each failing
 * case; line coverage under the bar is asked about with the figure.
 */
export function ModuleProposal({
  slug,
  replaced = null,
}: {
  slug: string;
  /**
   * The catalog no longer holds what this card proposed (EO-401): a
   * corrected module replaced it, on a card `below` or `elsewhere`. The
   * card then offers neither button over code it never described, and
   * says where the module is approved instead.
   */
  replaced?: "below" | "elsewhere" | null;
}) {
  const queryClient = useQueryClient();
  const catalog = useModulesWithDeleted();
  const [reading, setReading] = useState(false);
  const approval = useModuleApproval({
    onApproved: () => {
      void queryClient.invalidateQueries({ queryKey: modulesKey });
    },
  });

  const module = catalog.data?.modules?.find((candidate) => candidate.slug === slug);

  // Not known yet is not the same as gone: nothing is said until the catalog answers.
  if (!catalog.data) {
    return (
      <div className="flex items-center gap-2 text-[12.5px] text-ink-muted">
        <Boxes size={14} className="shrink-0" />
        <code className="font-mono text-[12px]">{slug}</code>
      </div>
    );
  }

  if (!module || module.archivedAt !== null) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[12.5px] text-ink-muted">
          <Boxes size={14} className="shrink-0" />
          <b className="text-[13px] font-semibold text-ink">{module?.name ?? slug}</b>
          <code className="font-mono text-[12px]">{slug}</code>
          <Chip tone="danger">Deleted</Chip>
        </div>
        <p className="text-[12.5px] leading-relaxed text-ink-muted">
          This module is no longer in the catalog, so there is nothing here to approve. Ask for it again if it is still wanted.
        </p>
      </div>
    );
  }

  if (replaced) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[12.5px] text-ink-muted">
          <Boxes size={14} className="shrink-0" />
          <b className="text-[13px] font-semibold text-ink">{module.name}</b>
          <code className="font-mono text-[12px]">{module.slug}</code>
          <Chip>Replaced</Chip>
        </div>
        <p className="text-[12.5px] leading-relaxed text-ink-muted">
          {replaced === "below"
            ? "A newer version of this module is below. Read and approve it there."
            : "This module was changed after this card was posted, so the card no longer describes it. It is approved on its newest card, or in Settings → Modules."}
        </p>
      </div>
    );
  }

  const approved = module.approvedAt !== null;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-[12.5px] text-ink-muted">
        <Boxes size={14} className="shrink-0" />
        <b className="text-[13px] font-semibold text-ink">{module.name}</b>
        <code className="font-mono text-[12px]">{module.slug}</code>
        <Chip tone={approved ? "success" : "paused"}>{approved ? "Approved" : "Not approved"}</Chip>
      </div>
      <p className="text-[13.5px] leading-[1.55] text-ink">{module.description}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-[12px] text-ink-muted">
        <span>{testCases(module.testCount)}</span>
        <CoverageBadge run={module.testRun} testCount={module.testCount} />
      </div>
      {/* Values that only hold on this machine (EO-449): advice before
          Approve, and nothing about Approve waits on it. */}
      <MachineSpecificValues warnings={module.machineSpecific} />
      <div className="flex flex-wrap items-center gap-2">
        {approved ? null : (
          <Button variant="primary" size="sm" disabled={approval.approving} onClick={() => approval.approve(module)}>
            {approval.approving ? "Running its tests…" : "Approve"}
          </Button>
        )}
        <Button size="sm" onClick={() => setReading(true)}>
          View code
        </Button>
        {approved ? null : <span className="text-[11px] text-ink-subtle">Approving runs its tests</span>}
      </div>
      {/* One line per failing case, so kept as written. */}
      {approval.problem && !approved ? (
        <p role="alert" className="whitespace-pre-line text-[12.5px] text-danger">
          {approval.problem}
        </p>
      ) : null}
      {approval.dialog}
      {reading ? <ModuleCode module={module} onClose={() => setReading(false)} /> : null}
    </div>
  );
}

function testCases(count: number): string {
  return count === 1 ? "1 test case" : `${count} test cases`;
}

/**
 * A module read in full, in a window over the conversation: its code,
 * what its manifest says it reaches for, and its test cases with how each
 * last went.
 *
 * A window rather than a link to Settings → Modules, because the person
 * was asked to approve it here, and approving is reading it first. It
 * changes nothing — there is no editor in it and no delete.
 */
export function ModuleCode({ module, onClose }: { module: ModuleView; onClose: () => void }) {
  const vocabulary = useChromeVocabulary();
  const tests = useQuery({ queryKey: moduleTestsKey(module.id), queryFn: () => ipcQuery("moduleTests:list", { moduleId: module.id }) });
  const { needs, results } = module.manifest;

  return (
    <Dialog
      open
      onClose={onClose}
      title={module.name}
      description={module.description}
      width="w-[52rem]"
      footer={
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex min-w-0 flex-col gap-4">
        <section aria-label="What it declares" className="flex min-w-0 flex-col gap-2">
          <h3 className="text-[13px] font-medium text-ink">What it declares</h3>
          <Facts
            items={[
              { term: "Slug", value: <code className="font-mono text-[12px]">{module.slug}</code> },
              { term: "Binaries", value: needs.bin.length > 0 ? <Names names={needs.bin} /> : "None" },
              { term: "Environment variables", value: needs.env.length > 0 ? <Names names={needs.env} /> : "None" },
              { term: "Network access", value: needs.network ? "Yes" : "No" },
              { term: `Reads ${vocabulary.items.toLowerCase()}`, value: needs.item ? "Yes" : "No" },
              { term: "Posts comments", value: needs.comment ? "Yes" : "No" },
              { term: "Attaches files", value: needs.attach ? "Yes" : "No" },
              { term: `Creates ${vocabulary.items.toLowerCase()}`, value: needs.create ? "Yes" : "No" },
              { term: "Results", value: <Names names={results} /> },
            ]}
          />
        </section>

        <ModuleSource module={module} />

        <section aria-label={`Tests of ${module.name}`} className="flex min-w-0 flex-col gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="text-[13px] font-medium text-ink">Tests</h3>
            <CoverageBadge run={module.testRun} testCount={module.testCount} />
          </div>
          {module.testsStale ? (
            <p className="text-[12px] text-ink-subtle">The code or the cases changed since the last run, so no case has run against what is saved now.</p>
          ) : null}
          {tests.data ? <ModuleTestList tests={tests.data.tests ?? []} run={module.testRun} stale={module.testsStale} /> : <Loading>Loading its test cases…</Loading>}
          {tests.data?.problem ? <ErrorLine>{tests.data.problem}</ErrorLine> : null}
        </section>
      </div>
    </Dialog>
  );
}

/**
 * What a module takes and the code it runs: the half of `ModuleCode` a
 * person reads to know what they are approving, shared with the draft
 * card's module rows (EO-581), which show it behind an expand.
 */
export function ModuleSource({ module }: { module: ModuleView }) {
  const declared = Object.entries(module.manifest.inputs);
  return (
    <>
      <section aria-label="Inputs" className="flex min-w-0 flex-col gap-2">
        <h3 className="text-[13px] font-medium text-ink">Inputs</h3>
        {declared.length === 0 ? (
          <p className="text-[12.5px] text-ink-subtle">It declares no inputs.</p>
        ) : (
          <ul className="flex min-w-0 flex-col gap-1 text-[12.5px] text-ink">
            {declared.map(([name, input]) => (
              <li key={name} className="min-w-0 break-words">
                <code className="font-mono text-[12px]">{name}</code> <span className="text-ink-subtle">· {input.type}</span>
                {input.default !== undefined && input.default !== null ? <span className="text-ink-subtle"> · default {String(input.default)}</span> : null}
                {input.description ? <span className="text-ink-muted"> — {input.description}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Code" className="flex min-w-0 flex-col gap-2">
        <h3 className="text-[13px] font-medium text-ink">Code</h3>
        <pre aria-label={`Code of ${module.name}`} className="max-h-[26rem] overflow-auto relative rounded-[10px] bg-canvas-raised px-3 py-2 font-mono text-[12px] text-ink">
          <code>{module.code}</code>
        </pre>
      </section>
    </>
  );
}

export function Names({ names }: { names: readonly string[] }) {
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {names.map((name) => (
        <Chip key={name} className="font-mono">
          {name}
        </Chip>
      ))}
    </span>
  );
}
