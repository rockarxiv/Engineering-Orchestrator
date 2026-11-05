import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FROM_ENVIRONMENT_VARIABLES, ORGANISATION_SECRET_LINE, UNREADABLE_SERVER_SECRET_LINE, type McpKeychainStatus, type McpServerView } from "@eo/core";
import { ipcQuery } from "../../../query/client";
import { mcpServersKey } from "../../../query/hooks";
import { byName, revealLine, useSecretReveal } from "../../../hooks/useSecretReveal";
import { Button, Chip, ErrorLine, TextInput } from "../../kit";

/**
 * The values a server's declared variables hold (EO-104, EO-109) — the
 * chat layout's drawing of `agentTools/ServerSecrets`.
 *
 * The list is names only: the row is told which names are set. A stored
 * value comes back only when the person presses Reveal (EO-489,
 * ARCHITECTURE.md §14.2) — fetched then through the machine half, held in
 * `useSecretReveal`'s state alone, and hidden on Hide, on leaving the
 * screen, or after thirty seconds; never for a name the organisation
 * supplies, nor on a renderer served by a server. What is typed is held until it is
 * sent and cleared once it is stored; a *refused* value stays in its box,
 * because it was stored nowhere and retyping a token to find out what
 * was wrong with it helps nobody.
 */
export function ServerSecrets({
  server,
  keychain,
  organisation = [],
  variables = [],
}: {
  server: McpServerView;
  keychain: McpKeychainStatus;
  /** The names the organisation set (EO-328, ARCHITECTURE.md, "Secrets"): what the spawn gets whatever this machine holds. */
  organisation?: readonly string[];
  /** The shared environment variables' names (EO-488): what fills a declared name no secret does, at spawn. */
  variables?: readonly string[];
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: mcpServersKey });
  const reveal = useSecretReveal((name) => ipcQuery("mcpServers:revealSecret", { serverId: server.id, name }));

  const set = useMutation({
    mutationFn: (input: { name: string; value: string }) => ipcQuery("mcpServers:setSecret", { serverId: server.id, name: input.name, value: input.value }),
    onSuccess: async (result, input) => {
      if (!result.saved) {
        setProblem(result.problem);
        return;
      }
      setValues((current) => ({ ...current, [input.name]: "" }));
      // What was revealed is not what is stored any more.
      reveal.hide(input.name);
      setProblem(null);
      await refresh();
    },
    onError: (error: Error) => setProblem(error.message),
  });

  const clear = useMutation({
    mutationFn: (name: string) => ipcQuery("mcpServers:clearSecret", { serverId: server.id, name }),
    onSuccess: async (_result, name) => {
      reveal.hide(name);
      setProblem(null);
      await refresh();
    },
    onError: (error: Error) => setProblem(error.message),
  });

  if (server.envNames.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 border-t border-line/60 pt-3">
      <p className="text-[11.5px] leading-snug text-ink-subtle">
        Values live in your OS keychain, never in EO&apos;s database and never on the command line — the generated configuration carries{" "}
        <code className="font-mono">${"{NAME}"}</code> and the value arrives through the environment at spawn. A saved value can be replaced,
        cleared{reveal.available ? ", or revealed here for thirty seconds" : ""}.
      </p>
      {keychain.warning !== null ? <p className="text-[12px] text-paused">{keychain.warning}</p> : null}
      <ul aria-label={`Values for ${server.name}`} className="flex flex-col gap-2">
        {server.envNames.map((name) => {
          const theirs = organisation.includes(name);
          const isSet = server.secretsSet.includes(name);
          // Stored, and this machine can no longer decrypt it (EO-489): said
          // so on the row rather than drawn as "Not set", and removable.
          const unreadable = !isSet && (server.secretsUnreadable ?? []).includes(name);
          const fromVariables = !isSet && !unreadable && variables.includes(name);
          const typed = byName(values, name) ?? "";
          // This machine's own stored value, and only where it is what the row is about.
          const revealable = reveal.available && isSet && !theirs;
          const shown = revealable ? reveal.revealed(name) : undefined;
          const line = revealLine(shown);
          return (
            <li key={name} className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="flex min-w-0 basis-full items-center gap-2 @xl:basis-auto @xl:w-52">
                <code className="min-w-0 truncate font-mono text-[12px] text-ink">{name}</code>
                {theirs ? (
                  <span className="text-[11px] text-ink-subtle">{ORGANISATION_SECRET_LINE}</span>
                ) : unreadable ? (
                  <span className="text-[11px] text-danger">{UNREADABLE_SERVER_SECRET_LINE}</span>
                ) : fromVariables ? (
                  <span className="text-[11px] text-ink-subtle">{FROM_ENVIRONMENT_VARIABLES}</span>
                ) : (
                  <Chip tone={isSet ? "running" : "danger"}>{isSet ? "Set" : "Not set"}</Chip>
                )}
              </span>
              <TextInput
                type="password"
                aria-label={`Value for ${name} on ${server.name}`}
                placeholder={isSet || unreadable ? "Replace the stored value" : "Value"}
                autoComplete="off"
                className="min-w-[8rem] flex-1"
                value={typed}
                onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
              />
              <Button
                size="sm"
                aria-label={`Save ${name} for ${server.name}`}
                disabled={typed === "" || keychain.weak || !keychain.available || (set.isPending && set.variables?.name === name)}
                onClick={() => set.mutate({ name, value: typed })}
              >
                Save
              </Button>
              {isSet || unreadable ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Clear ${name} for ${server.name}`}
                  disabled={clear.isPending && clear.variables === name}
                  onClick={() => clear.mutate(name)}
                >
                  Clear
                </Button>
              ) : null}
              {revealable ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={shown === undefined ? `Reveal ${name} for ${server.name}` : `Hide ${name} for ${server.name}`}
                  disabled={shown?.state === "pending"}
                  onClick={() => (shown === undefined ? reveal.reveal(name) : reveal.hide(name))}
                >
                  {shown === undefined ? "Reveal" : "Hide"}
                </Button>
              ) : null}
              {line?.kind === "value" ? (
                <code
                  aria-label={`Value of ${name} on ${server.name}`}
                  className="min-w-0 basis-full break-all rounded-md bg-canvas-subtle px-2 py-1 font-mono text-[12px] text-ink select-all"
                >
                  {line.value}
                </code>
              ) : null}
              {line?.kind === "message" ? (
                <p className={line.danger ? "basis-full text-[11.5px] text-danger" : "basis-full text-[11.5px] text-ink-subtle"}>{line.text}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {problem !== null ? <ErrorLine>{problem}</ErrorLine> : null}
    </div>
  );
}
