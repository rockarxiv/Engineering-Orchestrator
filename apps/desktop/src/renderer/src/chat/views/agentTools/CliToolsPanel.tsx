import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { cliToolCommandProblem } from "@eo/core";
import type { CliTool, CliToolDescriptionDraft, CliToolDetection, IpcRequest } from "@eo/core";
import { machineAvailable } from "../../../ipc/bridge";
import { ipcQuery } from "../../../query/client";
import { cliToolDetectionKey, cliToolsKey } from "../../../query/hooks";
import { useInFlight } from "../../../query/useInFlight";
import { useViewParameters } from "../../../shared/view/ViewPublisher";
import { Button, Card, Chip, EmptyState, ErrorLine, Field, Loading, TextArea, TextInput } from "../../kit";
import { AttachedCliAgents, useNextDispatchNote } from "./attach";

/**
 * The catalogue of command-line tools a person added (EO-818, EO-821):
 * the third panel beside MCP servers and skills, drawn the way they are.
 *
 * A row is information, not a grant — it tells an agent a program exists
 * and what it is for — so the panel only ever writes what a person typed.
 * Entering a command asks this machine whether it is installed and for a
 * description drafted from its own `--help`; the draft
 * fills the box and goes nowhere until the person saves. Whether each
 * row's command is installed is asked afresh here every time the panel
 * is drawn, because the row's word for it would be wrong the first time
 * somebody uninstalled the program (invariant 5).
 */

interface CliDraft {
  id?: string;
  name: string;
  command: string;
  description: string;
}

const BLANK: CliDraft = { name: "", command: "", description: "" };

/** What checking a command found: whether it is installed, and the description it suggests. */
interface Probe {
  command: string;
  detection: CliToolDetection;
  draft: CliToolDescriptionDraft;
}

const SERVED_ELSEWHERE =
  "This window is served by the organisation's server, which cannot see what is installed on the desktop that runs your agents. Open EO on that desktop to check a command.";

/** Found, with where, or not — the same words on a row and in the editor. */
function DetectionLine({ detection }: { detection: CliToolDetection }) {
  if (!detection.found) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Chip tone="paused">Not found on this machine</Chip>
        <span className="text-[11.5px] text-ink-subtle">An agent it is given is not told about it until it is installed.</span>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Chip tone="success">Found</Chip>
      <span className="truncate font-mono text-[11.5px] text-ink-subtle" title={detection.path}>
        {detection.path}
      </span>
    </div>
  );
}

/** Whether a saved row's command is installed here, asked every time the row is drawn. */
function RowDetection({ command }: { command: string }) {
  const reachable = machineAvailable();
  const query = useQuery({
    queryKey: cliToolDetectionKey(command),
    queryFn: () => ipcQuery("cliTools:detect", { command }),
    enabled: reachable,
    // A program installed or removed since is a fact nothing pushes.
    staleTime: 0,
  });
  if (!reachable) {
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        <Chip title={SERVED_ELSEWHERE}>Not checked here</Chip>
      </div>
    );
  }
  if (query.isPending) return <Loading>Checking this machine…</Loading>;
  if (query.isError) return <ErrorLine>{query.error.message}</ErrorLine>;
  return <DetectionLine detection={query.data.detection} />;
}

function CliEditor({
  draft,
  onChange,
  onCheck,
  probe,
  checking,
  checkProblem,
  onCancel,
  onSave,
  problem,
  saving,
}: {
  draft: CliDraft;
  onChange: (draft: CliDraft) => void;
  /** `again` when the person pressed Check, rather than left the box. */
  onCheck: (again: boolean) => void;
  /** What the last check found, when it was for the command in the box. */
  probe: Probe | null;
  checking: boolean;
  checkProblem: string | null;
  onCancel: () => void;
  onSave: () => void;
  problem: string | null;
  saving: boolean;
}) {
  const reachable = machineAvailable();
  return (
    <section aria-label="CLI editor" className="flex min-w-0 flex-col gap-3 rounded-[14px] bg-canvas px-[18px] py-4 shadow-[inset_0_0_0_1.5px_var(--color-accent)]">
      <h2 className="text-[14px] font-medium text-ink">{draft.id === undefined ? "New command-line tool" : `Edit ${draft.name || "command-line tool"}`}</h2>

      <div className="flex min-w-0 items-end gap-1.5">
        <Field label="Command (what an agent types)" className="flex-1">
          <TextInput
            className="font-mono"
            value={draft.command}
            placeholder="gh"
            onChange={(event) => onChange({ ...draft, command: event.target.value })}
            onBlur={() => onCheck(false)}
          />
        </Field>
        <Button disabled={!reachable || checking || draft.command.trim() === ""} aria-busy={checking} onClick={() => onCheck(true)}>
          {checking ? "Checking…" : "Check"}
        </Button>
      </div>
      {!reachable ? <p className="text-[11.5px] leading-snug text-ink-subtle">{SERVED_ELSEWHERE}</p> : null}
      {checkProblem !== null ? <ErrorLine>{checkProblem}</ErrorLine> : null}
      {probe !== null ? (
        <div role="status" aria-label="What this machine has">
          <DetectionLine detection={probe.detection} />
        </div>
      ) : null}

      <Field label="Name">
        <TextInput value={draft.name} placeholder="GitHub CLI" onChange={(event) => onChange({ ...draft, name: event.target.value })} />
      </Field>
      <Field
        label="What it is and when to use it (told to every agent it is given to)"
        hint={probe !== null && probe.draft.description !== "" ? "Drafted from the program's own --help. Edit it before you save: it is your words an agent reads." : undefined}
      >
        <TextArea
          value={draft.description}
          placeholder="Reads and opens pull requests and issues on GitHub. Use it instead of the web UI."
          onChange={(event) => onChange({ ...draft, description: event.target.value })}
        />
      </Field>
      <p className="text-[11.5px] leading-snug text-ink-subtle">
        Nothing is granted: an agent runs the program through the shell it already has. It is only told the program is here and what it is for,
        and only on a machine where it is installed.
      </p>

      {problem !== null ? <p role="alert" className="whitespace-pre-line text-[12.5px] text-danger">{problem}</p> : null}

      <div className="flex items-center gap-1.5">
        <Button variant="primary" disabled={saving} onClick={onSave}>
          {draft.id === undefined ? "Add CLI" : "Save changes"}
        </Button>
        <Button variant="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

type CliRowAction = "archive" | "restore";

function CliCard({ tool, pending, onEdit, onArchive, onRestore }: { tool: CliTool; pending: CliRowAction | undefined; onEdit: () => void; onArchive: () => void; onRestore: () => void }) {
  const archived = tool.archivedAt !== null;
  return (
    <Card label={tool.name}>
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-[16rem] flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <h3 className="mr-0.5 truncate text-[14px] font-medium text-ink">{tool.name}</h3>
            <Chip tone="tag">
              <span className="font-mono">{tool.command}</span>
            </Chip>
            {archived ? <Chip tone="paused">Archived</Chip> : null}
          </div>
          {tool.description === "" ? (
            <p className="text-[12.5px] text-ink-subtle">No description yet — an agent is told only its name and command.</p>
          ) : (
            <p className="text-[12.5px] text-ink-muted">{tool.description}</p>
          )}
          <RowDetection command={tool.command} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" disabled={pending !== undefined} onClick={onEdit}>
            Edit
          </Button>
          {archived ? (
            <Button size="sm" variant="ghost" disabled={pending !== undefined} aria-busy={pending === "restore"} onClick={onRestore}>
              {pending === "restore" ? "Restoring…" : "Restore"}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" disabled={pending !== undefined} aria-busy={pending === "archive"} onClick={onArchive}>
              {pending === "archive" ? "Archiving…" : "Archive"}
            </Button>
          )}
        </div>
      </div>
      <AttachedCliAgents cliToolId={tool.id} entryName={tool.name} />
    </Card>
  );
}

export function CliToolsPanel() {
  const queryClient = useQueryClient();
  const note = useNextDispatchNote();
  const [draft, setDraft] = useState<CliDraft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [rowProblem, setRowProblem] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [checkProblem, setCheckProblem] = useState<string | null>(null);
  // The command in the box now, so an answer for one typed before it is not drawn as this one's.
  const currentCommand = useRef("");
  // The description the last check put in the box, so a later check replaces its own draft and never the person's words.
  const prefilled = useRef("");
  // The command last checked, and whether its answer is in (see `runCheck`).
  const asked = useRef<{ command: string; settled: boolean } | null>(null);

  useViewParameters({ filter: { text: "", facets: { archived: showArchived ? "true" : "false" } } });

  const tools = useQuery({ queryKey: cliToolsKey, queryFn: () => ipcQuery("cliTools:list", { includeArchived: true }) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: cliToolsKey });

  const open = (next: CliDraft | null) => {
    setDraft(next);
    setProblem(null);
    setProbe(null);
    setCheckProblem(null);
    currentCommand.current = next?.command.trim() ?? "";
    prefilled.current = "";
    asked.current = null;
  };

  const check = useMutation({
    mutationFn: async (command: string): Promise<Probe> => {
      const [detected, drafted] = await Promise.all([ipcQuery("cliTools:detect", { command }), ipcQuery("cliTools:draft", { command })]);
      return { command, detection: detected.detection, draft: drafted.draft };
    },
    onSuccess: (result) => {
      if (result.command !== currentCommand.current) return;
      setProbe(result);
      setCheckProblem(null);
      // The row on the list asks the same question; this answer is the newer one.
      queryClient.setQueryData(cliToolDetectionKey(result.command), { detection: result.detection });
      const suggestion = result.draft.description;
      if (suggestion === "") return;
      setDraft((current) => {
        if (current === null) return current;
        const untouched = current.description.trim() === "" || current.description === prefilled.current;
        if (!untouched) return current;
        prefilled.current = suggestion;
        return { ...current, description: suggestion };
      });
    },
    onError: (error: Error) => setCheckProblem(error.message),
  });

  // Leaving the box asks once per command; Check asks again, because a
  // program installed since is the reason somebody presses it. Either
  // way not twice at once: leaving the box by pressing Check fires both.
  const runCheck = (again: boolean) => {
    if (draft === null || !machineAvailable()) return;
    const command = draft.command.trim();
    if (command === "") return;
    if (asked.current?.command === command && (!again || !asked.current.settled)) return;
    const refused = cliToolCommandProblem(command);
    if (refused !== null) {
      setProbe(null);
      setCheckProblem(refused);
      return;
    }
    const attempt = { command, settled: false };
    asked.current = attempt;
    check.mutate(command, { onSettled: () => (attempt.settled = true) });
  };

  const save = useMutation({
    mutationFn: (payload: IpcRequest<"cliTools:save">) => ipcQuery("cliTools:save", payload),
    onSuccess: async (result) => {
      if (!result.saved) {
        setProblem(result.problem);
        return;
      }
      open(null);
      await refresh();
    },
    onError: (error: Error) => setProblem(error.message),
  });

  const archive = useMutation({
    mutationFn: (id: string) => ipcQuery("cliTools:archive", { id }),
    onSuccess: async (result) => {
      if (!result.archived) {
        setRowProblem(result.problem);
        return;
      }
      setRowProblem(null);
      await refresh();
    },
    onError: (error: Error) => setRowProblem(error.message),
  });

  const restore = useMutation({
    mutationFn: (id: string) => ipcQuery("cliTools:restore", { id }),
    onSuccess: async (result) => {
      if (!result.restored) {
        setRowProblem(result.problem);
        return;
      }
      setRowProblem(null);
      await refresh();
    },
    onError: (error: Error) => setRowProblem(error.message),
  });

  const rowActions = useInFlight<string, CliRowAction>();
  const runRow = (id: string, action: CliRowAction, task: () => Promise<unknown>) => {
    void rowActions.run(id, action, task).catch(() => undefined);
  };

  const all = tools.data?.cliTools ?? [];
  const live = all.filter((tool) => tool.archivedAt === null);
  const archived = all.filter((tool) => tool.archivedAt !== null);
  const rows = showArchived ? [...live, ...archived] : live;

  const editor =
    draft === null ? null : (
      <CliEditor
        draft={draft}
        onChange={(next) => {
          currentCommand.current = next.command.trim();
          setDraft(next);
        }}
        onCheck={runCheck}
        probe={probe !== null && probe.command === draft.command.trim() ? probe : null}
        checking={check.isPending}
        checkProblem={checkProblem}
        onCancel={() => open(null)}
        onSave={() => save.mutate({ ...(draft.id === undefined ? {} : { id: draft.id }), name: draft.name, command: draft.command, description: draft.description })}
        problem={problem}
        saving={save.isPending}
      />
    );
  const editingInPlace = draft?.id !== undefined && rows.some((tool) => tool.id === draft.id);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {draft === null ? (
          <Button icon={<Plus size={13} />} onClick={() => open(BLANK)}>
            New CLI
          </Button>
        ) : null}
        {archived.length > 0 ? (
          <Button variant="ghost" onClick={() => setShowArchived((shown) => !shown)}>
            {showArchived ? "Hide archived" : `Show archived (${String(archived.length)})`}
          </Button>
        ) : null}
      </div>

      {rowProblem !== null ? <p role="alert" className="whitespace-pre-line text-[12.5px] text-danger">{rowProblem}</p> : null}

      {editingInPlace ? null : editor}

      {tools.isLoading ? <Loading /> : null}
      {tools.error ? <ErrorLine>{tools.error.message}</ErrorLine> : null}
      {!tools.isLoading && all.length === 0 && draft === null ? (
        <EmptyState title="No command-line tools yet.">
          Add a program installed on this machine — <code className="font-mono">gh</code>, <code className="font-mono">kubectl</code>, your team&apos;s
          own — then tick which agents are told about it.
        </EmptyState>
      ) : null}

      {rows.map((tool) =>
        editingInPlace && draft?.id === tool.id ? (
          <div key={tool.id}>{editor}</div>
        ) : (
          <CliCard
            key={tool.id}
            tool={tool}
            pending={rowActions.pending.get(tool.id)}
            onEdit={() => open({ id: tool.id, name: tool.name, command: tool.command, description: tool.description })}
            onArchive={() => runRow(tool.id, "archive", () => archive.mutateAsync(tool.id))}
            onRestore={() => runRow(tool.id, "restore", () => restore.mutateAsync(tool.id))}
          />
        ),
      )}

      <p className="text-[11.5px] leading-snug text-ink-subtle">{note}</p>
    </div>
  );
}
