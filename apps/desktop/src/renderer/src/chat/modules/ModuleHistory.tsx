import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { versionLabel, type ModuleVersion, type ModuleView } from "@eo/core";
import { cn } from "@eo/ui";
import { ipcQuery } from "../../query/client";
import { moduleVersionKey, moduleVersionsKey } from "../../query/hooks";
import { Button, Chip, ErrorLine, GroupLabel, Loading } from "../kit";

/**
 * A module's kept versions, newest first, and a way back to any of them
 * (EO-361), in the chat layout's terms.
 *
 * Looking is read-only — a version's code, manifest and case descriptions
 * in plain text, because history is never edited. Restore writes nothing
 * either: it reads the version whole and hands it to the screen's editor
 * as a draft; saving that draft is what goes through
 * `moduleVersions:restore`, and Cancel leaves the module as it was.
 */
export function ModuleHistory({ module, onRestore }: { module: ModuleView; onRestore: (version: ModuleVersion) => void }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);

  const list = useQuery({ queryKey: moduleVersionsKey(module.id), queryFn: () => ipcQuery("moduleVersions:list", { moduleId: module.id }) });
  const versions = list.data?.versions ?? [];

  const restore = useMutation({
    mutationFn: (number: number) =>
      queryClient.fetchQuery({
        queryKey: moduleVersionKey(module.id, number),
        queryFn: () => ipcQuery("moduleVersions:get", { moduleId: module.id, number }),
      }),
    onSuccess: (result) => {
      if (result.version !== null) onRestore(result.version);
    },
  });

  const problem = list.error?.message ?? list.data?.problem ?? restore.error?.message ?? restore.data?.problem ?? null;

  return (
    <section aria-label={`History of ${module.name}`} className="flex min-w-0 flex-col gap-2 rounded-[12px] bg-canvas-subtle px-3.5 py-3">
      <div className="flex flex-col gap-0.5">
        <h4 className="text-[13px] font-medium text-ink">History</h4>
        <p className="text-[12px] leading-snug text-ink-subtle">
          Every version kept, newest first. Restoring one opens it in the editor; nothing changes until you save it, which files it as a
          new version with its test cases.
        </p>
      </div>
      {list.isLoading ? <Loading>Reading the versions…</Loading> : null}
      <ol aria-label={`Versions of ${module.name}`} className="flex min-w-0 flex-col [&>li+li]:border-t [&>li+li]:border-line/60">
        {versions.map((version) => {
          const label = versionLabel(version.number);
          const open = selected === version.number;
          return (
            <li key={version.number} aria-label={label} className="flex min-w-0 flex-col gap-2 py-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  aria-label={`Show ${label}`}
                  aria-expanded={open}
                  onClick={() => setSelected(open ? null : version.number)}
                  className="flex min-h-9 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 rounded-[10px] px-2 text-left hover:bg-canvas-raised"
                >
                  <ChevronRight aria-hidden size={13} className={cn("shrink-0 text-ink-subtle transition-transform", open && "rotate-90")} />
                  <span className="font-mono text-[12px] text-ink">{label}</span>
                  <span className="text-[11.5px] text-ink-subtle">{new Date(version.createdAt).toLocaleString()}</span>
                  {version.approved ? <Chip tone="running">Approved</Chip> : null}
                  {version.current ? <Chip>Current</Chip> : null}
                  <span className="text-[11.5px] text-ink-subtle">
                    {version.testCount} test case{version.testCount === 1 ? "" : "s"}
                  </span>
                </button>
                {/* The current version is already what the module is. */}
                {version.current ? null : (
                  <Button size="sm" aria-label={`Restore ${label}`} disabled={restore.isPending} onClick={() => restore.mutate(version.number)}>
                    Restore
                  </Button>
                )}
              </div>
              {open ? <VersionDetail moduleId={module.id} number={version.number} /> : null}
            </li>
          );
        })}
      </ol>
      {problem ? <ErrorLine>{problem}</ErrorLine> : null}
    </section>
  );
}

/** One version whole, read-only: what restoring it would bring back. */
function VersionDetail({ moduleId, number }: { moduleId: string; number: number }) {
  const answer = useQuery({
    queryKey: moduleVersionKey(moduleId, number),
    queryFn: () => ipcQuery("moduleVersions:get", { moduleId, number }),
  });
  const label = versionLabel(number);

  if (answer.isLoading) return <Loading>Reading {label}…</Loading>;
  const problem = answer.error?.message ?? answer.data?.problem ?? null;
  const version = answer.data?.version ?? null;
  if (version === null) return <ErrorLine>{problem ?? `${label} could not be read.`}</ErrorLine>;

  const block = "max-h-72 overflow-auto relative rounded-[10px] bg-canvas-raised px-3 py-2 font-mono text-[12px] text-ink";
  return (
    <div className="flex min-w-0 flex-col gap-2.5 pl-2">
      <div className="flex min-w-0 flex-col gap-1">
        <GroupLabel>Manifest</GroupLabel>
        <pre aria-label={`Manifest of ${label}`} className={block}>
          {JSON.stringify(version.manifest, null, 2)}
        </pre>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <GroupLabel>Code</GroupLabel>
        <pre aria-label={`Code of ${label}`} className={block}>
          {version.code}
        </pre>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <GroupLabel>Test cases</GroupLabel>
        {version.tests.length === 0 ? (
          <p className="text-[12.5px] text-ink-subtle">No test cases went with this version.</p>
        ) : (
          <ul aria-label={`Test cases of ${label}`} className="list-disc pl-5 text-[12.5px] text-ink">
            {version.tests.map((test) => (
              <li key={test.id}>{test.description}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
