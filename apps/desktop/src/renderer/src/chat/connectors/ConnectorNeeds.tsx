import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectorView, McpKeychainStatus } from "@eo/core";
import { cn } from "@eo/ui";
import { machineAvailable } from "../../ipc/bridge";
import { ipcQuery } from "../../query/client";
import { connectorsKey, connectorsRootKey } from "../../query/hooks";
import { useInvalidateOnPush } from "../../query/useInvalidateOnPush";
import { Button, Loading, StatusDot, TextInput } from "../kit";

/**
 * "What this agent can reach", one line per connector, in the chat
 * layout's terms (EO-315, ARCHITECTURE.md, "A connector is an MCP server with a setup flow",
 * "What a person sees first").
 *
 * The same list for three questions — what a step can reach, what this
 * installation has connected, and why the needs check's line is red — so
 * a green line here and a red one there cannot be two renderings of one
 * fact. A line is a **capability**, never a tool name, and a red line
 * **says why** and carries the one button that fixes it.
 */

/**
 * The `token` kind: one box per name still missing, and a Connect that
 * sends every value at once — connected by all of them or by none. What
 * is typed is cleared on success; a refused value stays in its box,
 * because it was stored nowhere and clearing it would make somebody
 * retype a token to learn what was wrong with it.
 */
function TokenForm({ connector, keychain, onDone }: { connector: ConnectorView; keychain: McpKeychainStatus; onDone: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const serverId = connector.serverId;

  const connect = useMutation({
    mutationFn: () => ipcQuery("connectors:connectToken", { serverId: serverId ?? "", values }),
    onSuccess: (result) => {
      if (!result.connected) {
        setProblem(result.problem);
        return;
      }
      setValues({});
      setProblem(null);
      onDone();
    },
    onError: (error: Error) => setProblem(error.message),
  });

  const missing = connector.secretNames.filter((name) => !connector.secretsSet.includes(name));
  const ready = missing.every((name) => (values[name] ?? "") !== "");

  return (
    <div className="flex flex-col gap-2 rounded-[10px] bg-canvas-subtle px-3 py-2.5">
      {keychain.warning !== null ? <p className="text-[12px] text-paused">{keychain.warning}</p> : null}
      {missing.map((name) => (
        <div key={name} className="flex min-w-0 flex-wrap items-center gap-2">
          <code className="w-44 max-w-full shrink-0 truncate font-mono text-[12px] text-ink">{name}</code>
          <TextInput
            type="password"
            aria-label={`Value for ${name} on ${connector.label}`}
            placeholder="Value"
            className="min-w-[10rem] flex-1"
            value={values[name] ?? ""}
            onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
          />
        </div>
      ))}
      <div>
        <Button
          variant="primary"
          size="sm"
          disabled={!ready || connect.isPending || keychain.weak || !keychain.available || serverId === null}
          onClick={() => connect.mutate()}
        >
          {connect.isPending ? "Connecting…" : `Connect ${connector.label}`}
        </Button>
      </div>
      {problem !== null ? <p className="text-[12px] text-danger">{problem}</p> : null}
    </div>
  );
}

function ConnectorRow({ connector, keychain, onChanged }: { connector: ConnectorView; keychain: McpKeychainStatus; onChanged: () => void }) {
  const [typing, setTyping] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const serverId = connector.serverId;

  const signIn = useMutation({
    mutationFn: () => ipcQuery("connectors:connectOAuth", { serverId: serverId ?? "" }),
    onSuccess: (result) => {
      setProblem(result.connected ? null : result.problem);
      if (result.connected) onChanged();
    },
    onError: (error: Error) => setProblem(error.message),
  });

  const disconnect = useMutation({
    mutationFn: () => ipcQuery("connectors:disconnect", { serverId: serverId ?? "" }),
    onSuccess: (result) => {
      setProblem(result.disconnected ? null : result.problem);
      if (result.disconnected) onChanged();
    },
    onError: (error: Error) => setProblem(error.message),
  });

  // `none` has no flow and so no button; a connector with no catalogue row
  // has nothing to act on; and an `oauth` sign-in needs a browser on the
  // machine the person is at (EO-319). A Connect that did nothing is the
  // control invariant 12 rules out, for a person as for an agent.
  const connectable = connector.setup !== "none" && serverId !== null && (connector.setup !== "oauth" || machineAvailable());

  return (
    <li className="flex min-w-0 flex-col gap-2 py-2.5">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-[6px]">
          <StatusDot tone={connector.connected ? "running" : "danger"} label={connector.connected ? "Connected" : "Not connected"} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn("text-[13px]", connector.connected ? "text-ink" : "text-danger")}>
            <span className="font-medium">{connector.label}</span> — {connector.capability}
          </span>
          {/* Why the line is red, in the main process's words, so the
              same sentence is on the step, here and in the needs check. */}
          {connector.problem !== null ? <span className="text-[12px] text-danger">{connector.problem}</span> : null}
          {/* Signed in and still reaching nothing: its own sentence. */}
          {connector.connected && !connector.deliverable ? (
            <span className="text-[12px] text-paused">
              The <code className="font-mono">{connector.serverName}</code> server is switched off, so no dispatch is given it.
            </span>
          ) : null}
        </div>
        {connectable && !connector.connected && connector.setup === "token" ? (
          <Button size="sm" onClick={() => setTyping((open) => !open)}>
            {typing ? "Cancel" : "Connect"}
          </Button>
        ) : null}
        {connectable && !connector.connected && connector.setup === "oauth" ? (
          <Button size="sm" disabled={signIn.isPending} onClick={() => signIn.mutate()}>
            {/* Said rather than spun: the browser is where the next thing happens. */}
            {signIn.isPending ? "Waiting for your browser…" : "Connect"}
          </Button>
        ) : null}
        {connectable && connector.connected && connector.secretNames.length > 0 ? (
          <Button size="sm" variant="ghost" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
            Disconnect
          </Button>
        ) : null}
      </div>
      {typing && connector.setup === "token" ? (
        <div className="pl-[19px]">
          <TokenForm
            connector={connector}
            keychain={keychain}
            onDone={() => {
              setTyping(false);
              onChanged();
            }}
          />
        </div>
      ) : null}
      {problem !== null ? <p className="pl-[19px] text-[12px] text-danger">{problem}</p> : null}
    </li>
  );
}

/**
 * The list itself.
 *
 * `role` narrows it to what a step owned by that role would reach; null is
 * everything the installation has. `servers` narrows it to the connectors
 * one needs-check line is about (EO-317), and `onChanged` tells a caller
 * with its own list to refresh.
 */
export function ConnectorNeeds({
  role,
  empty,
  servers,
  onChanged,
}: {
  role: string | null;
  empty: string;
  servers?: readonly string[];
  onChanged?: () => void;
}) {
  const queryClient = useQueryClient();
  const connectors = useQuery({ queryKey: connectorsKey(role), queryFn: () => ipcQuery("connectors:list", { role }) });
  // Connecting announces `config:changed`, so a sign-in made in one window
  // turns the red line green in the other too.
  useInvalidateOnPush("config:changed", connectorsRootKey);

  // The root rather than this key: connecting changes every narrowing of
  // the question at once.
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: connectorsRootKey });
    onChanged?.();
  };

  const all = connectors.data?.connectors ?? [];
  const rows = servers === undefined ? all : all.filter((connector) => servers.includes(connector.serverName));
  if (connectors.isLoading) return <Loading>Reading what is connected…</Loading>;
  if (rows.length === 0) return <p className="text-[12.5px] text-ink-subtle">{empty}</p>;

  const keychain = connectors.data?.keychain ?? { available: false, backend: null, weak: false, warning: null };

  return (
    <ul aria-label="Connectors" className="flex min-w-0 flex-col [&>li+li]:border-t [&>li+li]:border-line/60">
      {rows.map((connector) => (
        <ConnectorRow key={connector.serverName} connector={connector} keychain={keychain} onChanged={refresh} />
      ))}
    </ul>
  );
}
