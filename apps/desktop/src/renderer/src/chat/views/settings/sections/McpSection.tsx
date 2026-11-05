import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { aliasNotice, mcpConnectCommand, type McpAliasUse, type McpClientView } from "@eo/core";
import { cn } from "@eo/ui";
import { useAliasesRetired } from "../../../../hooks/useAppVersion";
import { ipcQuery } from "../../../../query/client";
import { useChromeVocabulary } from "../../../../query/hooks";
import { mcpClientsKey, mcpStatusKey } from "../../../../shared/settings/mcp";
import { Button, CardSection, Chip, ErrorLine, Field, Loading, Notice, Switch, Tabs, TextInput, type Tone } from "../../../kit";

/**
 * Settings → MCP server: EO's own MCP server for external clients, in the
 * chat layout's terms.
 *
 * Turning it on lets another program — Claude Code, Codex, Claude Desktop
 * — do what this window can do, so the copy's job is to be accurate about
 * what is handed out: what listens, who can reach it, what the token is
 * for, and what the second switch unlocks.
 */

type SnippetId = "claude-code" | "codex" | "other";

/**
 * The commands come from `@eo/core`'s `mcpConnect`, the same builders
 * main registers with, so the token is only ever on the line that sets a
 * variable and never in an argument someone pastes (EO-601). Codex is
 * shown as its `config.toml` rather than a command, so it is a file the
 * person keeps, not a command line.
 */
function connectionSnippets(port: number, token: string): { value: SnippetId; label: string; body: string }[] {
  const url = `http://127.0.0.1:${port}/mcp`;
  return [
    { value: "claude-code", label: "Claude Code", body: mcpConnectCommand("claude-code", url, token) },
    {
      value: "codex",
      label: "Codex",
      body: `# ~/.codex/config.toml\n[mcp_servers.eo]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${token}" }`,
    },
    {
      value: "other",
      label: "Anything else",
      body: `# Clients that only speak stdio can bridge to it:\n${mcpConnectCommand("mcp-remote", url, token)}`,
    },
  ];
}

/** "Copy", then "Copied" for two seconds, so a second copy does not look like it did nothing. */
function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  return [
    copied,
    (text: string) => {
      void navigator.clipboard?.writeText(text);
      setCopied(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    },
  ];
}

/**
 * A client still calling EO by the names it renamed (KAN-178): the
 * person's copy of what the tool descriptions tell only the model. Amber
 * while the old names resolve, red once the retiring release is running.
 * Never a button — what has to change is in somebody else's program. The
 * names are behind a link: they matter only to whoever is about to edit
 * them.
 */
function OldNames({ use, retired, label }: { use: McpAliasUse; retired: boolean; label: string | null }) {
  const [showing, setShowing] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={cn("text-[12.5px]", retired ? "text-danger" : "text-paused")}>
          {label === null ? "" : `${label} `}
          {aliasNotice("client", retired)}
        </span>
        <button type="button" className="text-[12px] text-ink-subtle underline hover:text-ink" onClick={() => setShowing(!showing)}>
          {showing ? "Hide the new names" : "Show the new names"}
        </button>
      </div>
      {showing ? (
        <div className="flex min-w-0 flex-col gap-0.5">
          {use.names.map((name) => (
            <p key={name.deprecated} className="text-[12px] text-ink-subtle">
              <code className="font-mono">{name.deprecated}</code> → <code className="font-mono">{name.replacement}</code>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ServerState({ listeningPort, enabled, problem }: { listeningPort: number | null; enabled: boolean; problem: string | null }) {
  const [tone, text]: [Tone, string] =
    listeningPort !== null ? ["running", `listening on 127.0.0.1:${listeningPort}`] : problem !== null ? ["danger", "not listening"] : ["neutral", enabled ? "starting" : "off"];
  return <Chip tone={tone}>{text}</Chip>;
}

export function McpSection() {
  const queryClient = useQueryClient();
  const vocabulary = useChromeVocabulary();
  const items = vocabulary.items.toLowerCase();
  const [revealed, setRevealed] = useState(false);
  const [portDraft, setPortDraft] = useState<string | null>(null);
  const [tokenCopied, copyToken] = useCopied();
  const [client, setClient] = useState<SnippetId>("claude-code");
  /** Which clients the person asked to see the command for, having not used the button. */
  const [showing, setShowing] = useState<Record<string, boolean>>({});

  const status = useQuery({ queryKey: mcpStatusKey, queryFn: () => ipcQuery("mcp:getStatus", undefined) });

  const configure = useMutation({
    mutationFn: (patch: { enabled?: boolean; dangerousOperations?: boolean; port?: number }) => ipcQuery("mcp:setConfig", patch),
    onSuccess: (next) => {
      setPortDraft(null);
      queryClient.setQueryData(mcpStatusKey, next);
    },
  });

  const clients = useQuery({ queryKey: mcpClientsKey, queryFn: () => ipcQuery("mcp:detectClients", undefined) });
  const aliasesRetired = useAliasesRetired();
  const detected = clients.data?.clients ?? [];
  const oldNameUse = clients.data?.oldNameUse ?? [];
  /**
   * Every recorded client with no detected row to hang its warning on —
   * detection runs the clients' own CLIs and can come back short, and the
   * warning must not vanish exactly when EO knows least (KAN-178).
   */
  const unattached = oldNameUse.filter((use) => !detected.some((each) => each.id === use.clientId));

  const register = useMutation({
    mutationFn: (id: McpClientView["id"]) => ipcQuery("mcp:registerWith", { id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mcpClientsKey }),
  });

  const regenerate = useMutation({
    mutationFn: () => ipcQuery("mcp:regenerateToken", undefined),
    onSuccess: (next) => {
      setRevealed(false);
      queryClient.setQueryData(mcpStatusKey, next);
    },
  });

  const data = status.data;
  if (!data) {
    return (
      <CardSection title="MCP server" description="Lets another program drive EO the way this window does.">
        {status.error ? <ErrorLine>{status.error.message}</ErrorLine> : <Loading />}
      </CardSection>
    );
  }

  const token = data.token ?? "";
  const port = data.listeningPort ?? data.port;
  const snippets = connectionSnippets(port, token);

  const commitPort = () => {
    const parsed = Number(portDraft);
    if (portDraft !== null && Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535) configure.mutate({ port: parsed });
    else setPortDraft(null);
  };

  return (
    <>
      <CardSection
        title="MCP server"
        description={`Lets another program drive EO the way this window does — reading the board, posting comments, moving ${items}. Off unless you turn it on.`}
        actions={<ServerState listeningPort={data.listeningPort} enabled={data.enabled} problem={data.problem} />}
      >
        <Switch label="Enable the MCP server" checked={data.enabled} disabled={configure.isPending} onChange={(enabled) => configure.mutate({ enabled })} />
        <div className="flex flex-col gap-1.5 text-[12.5px] leading-relaxed text-ink-subtle">
          <p>It listens on 127.0.0.1 only, so nothing outside this machine can reach it. Everything on this machine can, which is what the token is for.</p>
          <p>
            Whoever holds the token can do what you can do here, including mentioning an agent to put it to work on a repository. Treat it as you
            would access to this window.
          </p>
          {/* The two surfaces point in opposite directions and share a word (EO-109). */}
          <p>
            This is EO serving its tools outwards. For the MCP servers and skills EO gives its own agents, see{" "}
            <Link to="/agent-tools" className="text-accent-soft hover:underline">
              Agent tools
            </Link>
            .
          </p>
        </div>

        {data.problem !== null ? (
          <Notice
            tone="danger"
            action={
              <Button size="sm" onClick={() => configure.mutate({ port: 0 })} disabled={configure.isPending}>
                Pick a free port
              </Button>
            }
          >
            {data.problem}
          </Notice>
        ) : null}

        <Field label="Port" hint="1024–65535. Saved when you leave the field." className="max-w-[12rem]">
          <TextInput
            inputMode="numeric"
            className="font-mono"
            value={portDraft ?? String(data.port)}
            onChange={(event) => setPortDraft(event.target.value)}
            onBlur={commitPort}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitPort();
              if (event.key === "Escape") setPortDraft(null);
            }}
          />
        </Field>
        {configure.error ? <ErrorLine>{configure.error.message}</ErrorLine> : null}
      </CardSection>

      <CardSection
        title="Token"
        description="Stored in your OS keychain, never in EO's database. Unlike every other credential here it can be read back, because you have to paste it into the other program's configuration."
      >
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <code aria-label="The token" className="min-w-[10rem] flex-1 truncate rounded-[10px] bg-canvas-raised px-2.5 py-1.5 font-mono text-[12.5px] text-ink">
            {token === "" ? "none yet — enable the server to mint one" : revealed ? token : "••••••••••••••••••••"}
          </code>
          <Button size="sm" onClick={() => setRevealed(!revealed)} disabled={token === ""}>
            {revealed ? "Hide" : "Reveal"}
          </Button>
          <Button size="sm" disabled={token === ""} onClick={() => copyToken(token)}>
            {tokenCopied ? "Copied" : "Copy"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
            Regenerate
          </Button>
        </div>
        <p className="text-[12px] text-ink-subtle">Regenerating disconnects everything using the old token until you update its configuration.</p>
        {regenerate.error ? <ErrorLine>{regenerate.error.message}</ErrorLine> : null}
      </CardSection>

      <CardSection
        title="Destructive operations"
        description={`With this off, a connected program gets ${data.toolCount} tools and can read the board, comment, move ${items}, cancel runs and edit pipelines. Turning it on additionally lets it delete ${items}, comments, conversations and pipelines; approve module code; read and set module secrets; change Jira credentials and the licence; and install or remove agent runtimes. EO does not sandbox any of it.`}
      >
        <Switch
          label="Allow destructive operations"
          checked={data.dangerousOperations}
          disabled={configure.isPending}
          onChange={(dangerousOperations) => configure.mutate({ dangerousOperations })}
        />
      </CardSection>

      <CardSection
        title="Apps on this machine"
        description={
          <>
            Your own installs — the <code className="font-mono">claude</code> and <code className="font-mono">codex</code> on your PATH, and Claude Desktop.
            Not the agent runtimes EO downloads for itself; nothing reads those but EO. Each is registered through its own command, so EO never edits a
            configuration file it does not own.
          </>
        }
      >
        {clients.isLoading ? <Loading>Looking…</Loading> : null}
        {clients.error ? <ErrorLine>{clients.error.message}</ErrorLine> : null}

        {detected.length > 0 || unattached.length > 0 ? (
          <ul aria-label="Apps" className="flex min-w-0 flex-col [&>li+li]:border-t [&>li+li]:border-line/60">
            {detected.map((each) => (
              <ClientRow
                key={each.id}
                client={each}
                listening={data.listeningPort !== null}
                registering={register.isPending}
                onRegister={() => register.mutate(each.id)}
                showing={showing[each.id] === true}
                onShow={() => setShowing({ ...showing, [each.id]: true })}
                oldNames={oldNameUse.filter((use) => use.clientId === each.id)}
                retired={aliasesRetired}
              />
            ))}
            {/* Everything that has called EO and has no row above, named by what it called itself. */}
            {unattached.map((use) => (
              <li key={use.client} className="py-2.5">
                <OldNames use={use} retired={aliasesRetired} label={use.client} />
              </li>
            ))}
          </ul>
        ) : null}
        {register.error ? <ErrorLine>{register.error.message}</ErrorLine> : null}

        {data.listeningPort === null ? <p className="text-[12.5px] text-ink-subtle">Turn the server on first — there is nothing for them to connect to yet.</p> : null}
      </CardSection>

      {data.listeningPort !== null && token !== "" ? (
        <CardSection title="Connect a client" description="These carry the real token. Treat them as you would a password.">
          <Tabs label="Client" value={client} tabs={snippets.map(({ value, label }) => ({ value, label }))} onChange={setClient} />
          <pre role="tabpanel" aria-label={`${snippets.find((snippet) => snippet.value === client)?.label ?? "Client"} configuration`} className="overflow-x-auto rounded-[10px] bg-canvas-raised px-3 py-2.5 font-mono text-[12px] text-ink">
            {snippets.find((snippet) => snippet.value === client)?.body}
          </pre>
        </CardSection>
      ) : null}
    </>
  );
}

function ClientRow({
  client,
  listening,
  registering,
  onRegister,
  showing,
  onShow,
  oldNames,
  retired,
}: {
  client: McpClientView;
  listening: boolean;
  registering: boolean;
  onRegister: () => void;
  showing: boolean;
  onShow: () => void;
  oldNames: McpAliasUse[];
  retired: boolean;
}) {
  const [copied, copy] = useCopied();
  const manual = client.manual;
  // Shown whenever the button could not finish the job — it failed, EO
  // could not tell, or there is no CLI to drive — and on request otherwise.
  const manualOpen = manual !== null && (client.problem !== null || client.registered === null || showing);

  return (
    <li className="flex min-w-0 flex-col gap-2 py-2.5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="text-[13px] text-ink">{client.label}</span>
        {!client.installed ? (
          <Chip>not installed</Chip>
        ) : client.registered === true ? (
          <Chip tone="running">added</Chip>
        ) : (
          <Button size="sm" disabled={registering || !listening} onClick={onRegister}>
            {client.registered === null ? "Add anyway" : "Add EO"}
          </Button>
        )}
      </div>
      {client.problem !== null ? <p className="text-[12.5px] text-danger">{client.problem}</p> : null}
      {client.caveat !== null ? <p className="text-[12.5px] text-ink-subtle">{client.caveat}</p> : null}
      {/* Derived from what this client actually called (KAN-178). */}
      {oldNames.map((use) => (
        <OldNames key={use.client} use={use} retired={retired} label={null} />
      ))}
      {manual !== null && manualOpen ? (
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="text-[12px] text-ink-subtle">{manual.label}</span>
            <Button size="sm" onClick={() => copy(manual.text)}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <pre className="overflow-x-auto rounded-[10px] bg-canvas-raised px-3 py-2 font-mono text-[12px] text-ink">{manual.text}</pre>
        </div>
      ) : manual !== null && client.registered !== true ? (
        <button type="button" className="self-start text-[12px] text-ink-subtle underline hover:text-ink" onClick={onShow}>
          or do it yourself
        </button>
      ) : null}
    </li>
  );
}
