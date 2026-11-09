import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { managedServerRefusal } from "@eo/core";
import type { IpcRequest, McpAuthKind, McpKeychainStatus, McpServerView, McpTransport } from "@eo/core";
import { ipcQuery } from "../../../query/client";
import { mcpServersKey } from "../../../query/hooks";
import { useInFlight } from "../../../query/useInFlight";
import { useViewParameters } from "../../../shared/view/ViewPublisher";
import { BLANK, authLabel, draftOf, summarize, toSave, type ServerDraft } from "../../../shared/agentTools/mcpServers";
import { Button, Card, Chip, EmptyState, ErrorLine, Field, Loading, Notice, Select, TextArea, TextInput } from "../../kit";
import { AttachedAgents, useNextDispatchNote } from "./attach";
import { toggleLabel, type RowAction } from "./rowActions";
import { ServerSecrets } from "./ServerSecrets";

/**
 * The catalogue of MCP servers a person added (EO-104, EO-109), in the
 * chat layout's own terms.
 *
 * Every behaviour is the classic `McpServers`': the form holds a flat
 * draft read back into the stored shape by the same `toSave`, a header
 * line without a colon is a sentence before anything is sent, `enabled`
 * travels on its own channel, a refused save stays in the editor and a
 * refused row action stays above the list, and a server the organisation
 * published cannot be edited or archived here — only switched off.
 */

function ServerEditor({
  draft,
  onChange,
  onCancel,
  onSave,
  problem,
  saving,
}: {
  draft: ServerDraft;
  onChange: (draft: ServerDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  problem: string | null;
  saving: boolean;
}) {
  const remote = draft.transport !== "stdio";
  return (
    <section aria-label="Server editor" className="flex min-w-0 flex-col gap-3 rounded-[14px] bg-canvas px-[18px] py-4 shadow-[inset_0_0_0_1.5px_var(--color-accent)]">
      <h2 className="text-[14px] font-medium text-ink">{draft.id === undefined ? "New server" : `Edit ${draft.name || "server"}`}</h2>
      <div className="grid gap-3 @xl:grid-cols-2">
        <Field label="Name (what the model sees in every tool id)">
          <TextInput value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
        </Field>
        <Field label="Transport">
          <Select aria-label="Transport" value={draft.transport} onChange={(event) => onChange({ ...draft, transport: event.target.value as McpTransport })}>
            <option value="stdio">stdio (a local command)</option>
            <option value="http">http</option>
            <option value="sse">sse</option>
          </Select>
        </Field>
      </div>

      {/* What it does, in the person's words (EO-314) — what the pack import gate shows as a capability. */}
      <Field label="What it does (shown wherever an agent is given this server)">
        <TextInput value={draft.description} placeholder="reads your Slack channels" onChange={(event) => onChange({ ...draft, description: event.target.value })} />
      </Field>

      {remote ? (
        <>
          <Field label="URL">
            <TextInput value={draft.url} placeholder="https://example.com/mcp" onChange={(event) => onChange({ ...draft, url: event.target.value })} />
          </Field>
          <Field label="Headers (one Name: value per line)">
            <TextArea
              className="font-mono text-[12px]"
              value={draft.headers}
              placeholder={"Authorization: Bearer ${GITHUB_TOKEN}"}
              onChange={(event) => onChange({ ...draft, headers: event.target.value })}
            />
          </Field>
          {/* A remote idea only: a stdio server is handed its values in its environment, whatever kind it claims (EO-377). */}
          <Field label="Authentication">
            <Select aria-label="Authentication" value={draft.authKind} onChange={(event) => onChange({ ...draft, authKind: event.target.value as McpAuthKind })}>
              <option value="none">none (the server is open, or authenticates some other way)</option>
              <option value="bearer">bearer (a token, held in your keychain)</option>
              <option value="header">header (whatever you write above)</option>
            </Select>
          </Field>
          {draft.authKind === "bearer" ? (
            <>
              <Field label="Token variable (the name, not the token)">
                <TextInput
                  className="font-mono"
                  value={draft.bearerTokenEnvName}
                  placeholder="LINEAR_TOKEN"
                  onChange={(event) => onChange({ ...draft, bearerTokenEnvName: event.target.value })}
                />
              </Field>
              <p className="text-[11.5px] leading-snug text-ink-subtle">
                The name of an environment variable, not the token itself. It is added to the variables below when you save, and the value goes in
                your OS keychain from there.
              </p>
            </>
          ) : null}
        </>
      ) : (
        <>
          <Field label="Command">
            <TextInput value={draft.command} placeholder="npx" onChange={(event) => onChange({ ...draft, command: event.target.value })} />
          </Field>
          <Field label="Arguments (one per line)">
            <TextArea
              className="font-mono text-[12px]"
              value={draft.args}
              placeholder={"-y\n@modelcontextprotocol/server-github"}
              onChange={(event) => onChange({ ...draft, args: event.target.value })}
            />
          </Field>
        </>
      )}

      <Field label="Environment variables it needs (one name per line)">
        <TextArea
          className="font-mono text-[12px]"
          value={draft.envNames}
          placeholder="GITHUB_TOKEN"
          onChange={(event) => onChange({ ...draft, envNames: event.target.value })}
        />
      </Field>
      {/* Names, not values, said where the mistake would be made. */}
      <p className="text-[11.5px] leading-snug text-ink-subtle">
        Names only — write <code className="font-mono">${"{GITHUB_TOKEN}"}</code> in an argument or a header, and set what it holds below once this
        is saved. A server runs a command on this machine with your permissions, exactly as running it in a terminal would.
      </p>

      {problem !== null ? <p role="alert" className="whitespace-pre-line text-[12.5px] text-danger">{problem}</p> : null}

      <div className="flex items-center gap-1.5">
        <Button variant="primary" disabled={saving} onClick={onSave}>
          {draft.id === undefined ? "Create server" : "Save changes"}
        </Button>
        <Button variant="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

function ServerCard({
  server,
  managed,
  keychain,
  organisation,
  variables,
  pending,
  onEdit,
  onToggle,
  onArchive,
}: {
  server: McpServerView;
  /** What a press on this row is still doing (EO-562): its buttons wait and say so. */
  pending: RowAction | undefined;
  managed: boolean;
  keychain: McpKeychainStatus;
  organisation: readonly string[];
  /** The shared environment variables' names (EO-488). */
  variables: readonly string[];
  onEdit: () => void;
  onToggle: () => void;
  onArchive: () => void;
}) {
  const auth = authLabel(server);
  return (
    <Card label={server.name}>
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-[16rem] flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <h3 className="mr-0.5 truncate text-[14px] font-medium text-ink">{server.name}</h3>
            <Chip>{server.config.transport}</Chip>
            {auth !== null ? <Chip>{auth}</Chip> : null}
            {server.archivedAt !== null ? <Chip tone="paused">Archived</Chip> : server.enabled ? null : <Chip>Disabled</Chip>}
            {/* Said rather than inferred: an edit to one of these is overwritten by the next sync (EO-328, ARCHITECTURE.md, "Policy"). */}
            {managed ? <Chip tone="tag">from your organisation</Chip> : null}
          </div>
          {/* What it does, before what it is (EO-314). */}
          {server.description === "" ? null : <p className="text-[12.5px] text-ink-muted">{server.description}</p>}
          {managed ? <p className="text-[12px] text-ink-subtle">{managedServerRefusal(server.name)}</p> : null}
          <p className="truncate font-mono text-[11.5px] text-ink-subtle" title={summarize(server)}>
            {summarize(server)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Published: the definition is the organisation's, so Edit is greyed and Archive is not offered.
              Whether it runs here stays the person's. */}
          <Button size="sm" disabled={managed} onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" disabled={pending !== undefined} aria-busy={pending === "enable" || pending === "disable"} onClick={onToggle}>
            {toggleLabel(pending, server.enabled)}
          </Button>
          {server.archivedAt === null && !managed ? (
            <Button size="sm" variant="ghost" disabled={pending !== undefined} aria-busy={pending === "archive"} onClick={onArchive}>
              {pending === "archive" ? "Archiving…" : "Archive"}
            </Button>
          ) : null}
        </div>
      </div>
      <AttachedAgents kind="mcpServer" entryId={server.id} entryName={server.name} />
      <ServerSecrets server={server} keychain={keychain} organisation={organisation} variables={variables} />
    </Card>
  );
}

export function ServersPanel() {
  const queryClient = useQueryClient();
  const note = useNextDispatchNote();
  const [draft, setDraft] = useState<ServerDraft | null>(null);
  // Two slots: a refused save belongs beside the field, a refused row action above the list.
  const [problem, setProblem] = useState<string | null>(null);
  const [rowProblem, setRowProblem] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // Whether the archived rows are on screen (EO-192), merged with the tab the view publishes.
  useViewParameters({ filter: { text: "", facets: { archived: showArchived ? "true" : "false" } } });

  const servers = useQuery({ queryKey: mcpServersKey, queryFn: () => ipcQuery("mcpServers:list", { includeArchived: true }) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: mcpServersKey });

  const save = useMutation({
    mutationFn: (payload: IpcRequest<"mcpServers:save">) => ipcQuery("mcpServers:save", payload),
    onSuccess: async (result) => {
      if (!result.saved) {
        setProblem(result.problem);
        return;
      }
      setDraft(null);
      setProblem(null);
      await refresh();
    },
    onError: (error: Error) => setProblem(error.message),
  });

  const setEnabled = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) => ipcQuery("mcpServers:setEnabled", input),
    onSuccess: async (result) => {
      if (result.problem !== null) {
        setRowProblem(result.problem);
        return;
      }
      setRowProblem(null);
      await refresh();
    },
    onError: (error: Error) => setRowProblem(error.message),
  });

  const archive = useMutation({
    mutationFn: (id: string) => ipcQuery("mcpServers:archive", { id }),
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

  // Per row, not the mutation's own `isPending`, which would hold every
  // row's buttons for one press; held until the list has been read again.
  const rowActions = useInFlight<string, RowAction>();
  const runRow = (id: string, action: RowAction, task: () => Promise<unknown>) => {
    // A refusal is said above the list by the mutation itself.
    void rowActions.run(id, action, task).catch(() => undefined);
  };

  const all = servers.data?.servers ?? [];
  // No list, no keychain answer — and guessing one would be guessing this machine can hold a token.
  const keychain: McpKeychainStatus = servers.data?.keychain ?? { available: false, backend: null, weak: false, warning: null };
  const managedIds = servers.data?.managedIds ?? [];
  const unavailable = servers.data?.unavailable ?? [];
  const organisation = servers.data?.organisationSecrets ?? [];
  const variables = servers.data?.environmentVariables ?? [];
  const live = all.filter((server) => server.archivedAt === null);
  const archived = all.filter((server) => server.archivedAt !== null);
  const rows = showArchived ? [...live, ...archived] : live;

  const editor =
    draft === null ? null : (
      <ServerEditor
        draft={draft}
        onChange={setDraft}
        onCancel={() => {
          setDraft(null);
          setProblem(null);
        }}
        onSave={() => {
          // Read before sending, so a header line this screen cannot make sense of is a sentence here.
          const payload = toSave(draft);
          if (!payload.ok) {
            setProblem(payload.problem);
            return;
          }
          save.mutate(payload.value);
        }}
        problem={problem}
        saving={save.isPending}
      />
    );
  // An edit opens in place of its row; a new server, or a row that has
  // left the list while it was open, at the top.
  const editingInPlace = draft?.id !== undefined && rows.some((server) => server.id === draft.id);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {draft === null ? (
          <Button
            icon={<Plus size={13} />}
            onClick={() => {
              setProblem(null);
              setDraft(BLANK);
            }}
          >
            New server
          </Button>
        ) : null}
        {/* Archived rows are kept because an agent may still hold one (invariant #3), and hidden because they are rarely what anybody wants. */}
        {archived.length > 0 ? (
          <Button variant="ghost" onClick={() => setShowArchived((shown) => !shown)}>
            {showArchived ? "Hide archived" : `Show archived (${String(archived.length)})`}
          </Button>
        ) : null}
      </div>

      {rowProblem !== null ? <p role="alert" className="whitespace-pre-line text-[12.5px] text-danger">{rowProblem}</p> : null}

      {/* What the organisation publishes and this machine has not got (EO-328): there is no row to say it beside. */}
      {unavailable.map((server) => (
        <Notice key={server.name} tone="paused" role="status">
          {server.problem}
        </Notice>
      ))}

      {editingInPlace ? null : editor}

      {servers.isLoading ? <Loading /> : null}
      {servers.error ? <ErrorLine>{servers.error.message}</ErrorLine> : null}
      {!servers.isLoading && all.length === 0 && draft === null ? (
        <EmptyState title="No MCP servers yet.">Add one here, then tick which agents get it — nothing is given to an agent until you do.</EmptyState>
      ) : null}

      {rows.map((server) =>
        editingInPlace && draft?.id === server.id ? (
          <div key={server.id}>{editor}</div>
        ) : (
          <ServerCard
            key={server.id}
            server={server}
            managed={managedIds.includes(server.id)}
            keychain={keychain}
            organisation={organisation}
            variables={variables}
            onEdit={() => {
              setProblem(null);
              setDraft(draftOf(server));
            }}
            pending={rowActions.pending.get(server.id)}
            onToggle={() =>
              runRow(server.id, server.enabled ? "disable" : "enable", () => setEnabled.mutateAsync({ id: server.id, enabled: !server.enabled }))
            }
            onArchive={() => runRow(server.id, "archive", () => archive.mutateAsync(server.id))}
          />
        ),
      )}

      <p className="text-[11.5px] leading-snug text-ink-subtle">{note}</p>
    </div>
  );
}
