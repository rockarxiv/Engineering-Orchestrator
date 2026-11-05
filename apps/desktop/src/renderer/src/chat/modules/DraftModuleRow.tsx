import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Boxes, ChevronRight } from "lucide-react";
import type { ModuleView } from "@eo/core";
import { cn } from "@eo/ui";
import { ipcQuery } from "../../query/client";
import { moduleTestsKey, useChromeVocabulary, useModulesWithDeleted } from "../../query/hooks";
import { Button, Chip, ErrorLine, Facts, Loading } from "../kit";
import { CoverageBadge } from "./CoverageBadge";
import { MachineSpecificValues } from "./MachineSpecificValues";
import { ModuleSource, Names } from "./ModuleProposal";
import { ModuleTestList } from "./ModuleTestList";

/**
 * A module a pipeline draft needs, as a row on the draft card (EO-581).
 *
 * Collapsed, it says what a person is granting: a one-sentence
 * description, the needs the module declares — binaries, environment
 * variables and secrets, network, outside effects, item creation — and
 * how its tests last went. The needs are on the row rather than behind
 * the expand because the description is the assistant's claim and the
 * needs are what the person is approving. The code is behind the expand,
 * drawn by `ModuleSource`, the view the module card's View code opens.
 *
 * There is no Approve here. The draft card's one button approves every
 * module it lists and publishes the pipeline, together or not at all;
 * `refusal` is what that button said about this module when it did not.
 *
 * Read from the catalog by slug, as `ModuleProposal` is, so the row is
 * right however the module came to be approved or deleted.
 */
export function DraftModuleRow({ slug, refusal = null }: { slug: string; refusal?: string | null }) {
  const catalog = useModulesWithDeleted();
  const [open, setOpen] = useState(false);
  const codeId = useId();
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
          This module is no longer in the catalog, so this draft cannot be published. Ask for the draft again.
        </p>
      </div>
    );
  }

  const approved = module.approvedAt !== null;
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-[12.5px] text-ink-muted">
        <Boxes size={14} className="shrink-0" />
        <b className="text-[13px] font-semibold text-ink">{module.name}</b>
        <code className="font-mono text-[12px]">{module.slug}</code>
        <Chip tone={approved ? "success" : "paused"}>{approved ? "Approved" : "Not approved"}</Chip>
      </div>
      <p className="text-[13.5px] leading-[1.55] text-ink">{module.description}</p>
      <ModuleNeeds module={module} />
      <ModuleTestResults module={module} />
      {/* Values that only hold on this machine (EO-449): advice, and nothing about the button waits on it. */}
      <MachineSpecificValues warnings={module.machineSpecific} />
      {/* One line per failing case, so kept as written. */}
      {refusal !== null && !approved ? (
        <p role="alert" className="whitespace-pre-line text-[12.5px] text-danger">
          {refusal}
        </p>
      ) : null}
      <div>
        <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={codeId} onClick={() => setOpen((was) => !was)}>
          <ChevronRight aria-hidden size={13} className={cn("shrink-0 transition-transform", open && "rotate-90")} />
          {open ? "Hide code" : "Show code"}
        </Button>
      </div>
      {open ? (
        <div id={codeId} className="flex min-w-0 flex-col gap-4">
          <ModuleSource module={module} />
        </div>
      ) : null}
    </div>
  );
}

/** What the module declares it reaches for: the part of its manifest a person is granting. */
function ModuleNeeds({ module }: { module: ModuleView }) {
  const vocabulary = useChromeVocabulary();
  const { needs, sideEffects } = module.manifest;
  return (
    <Facts
      label={`What ${module.name} needs`}
      items={[
        { term: "Binaries", value: needs.bin.length > 0 ? <Names names={needs.bin} /> : "None" },
        { term: "Environment variables and secrets", value: needs.env.length > 0 ? <Names names={needs.env} /> : "None" },
        { term: "Network access", value: needs.network ? "Yes" : "No" },
        // The author's word (EO-334). Absent is a module nobody asked, and is said so rather than read as No.
        { term: "Outside effects", value: sideEffects === undefined ? "Not declared" : sideEffects ? "Yes" : "No" },
        { term: `Creates ${vocabulary.items.toLowerCase()}`, value: needs.create ? "Yes" : "No" },
      ]}
    />
  );
}

/** How its tests last went: the coverage figure and each case, with the source of a case behind that case's own expand. */
function ModuleTestResults({ module }: { module: ModuleView }) {
  const tests = useQuery({ queryKey: moduleTestsKey(module.id), queryFn: () => ipcQuery("moduleTests:list", { moduleId: module.id }) });
  return (
    <section aria-label={`Tests of ${module.name}`} className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-[12px] text-ink-muted">
        <span>{module.testCount === 1 ? "1 test case" : `${module.testCount} test cases`}</span>
        <CoverageBadge run={module.testRun} testCount={module.testCount} />
      </div>
      {module.testsStale ? (
        <p className="text-[12px] text-ink-subtle">The code or the cases changed since the last run, so no case has run against what is saved now.</p>
      ) : null}
      {tests.data ? <ModuleTestList tests={tests.data.tests ?? []} run={module.testRun} stale={module.testsStale} /> : <Loading>Loading its test cases…</Loading>}
      {tests.data?.problem ? <ErrorLine>{tests.data.problem}</ErrorLine> : null}
    </section>
  );
}
