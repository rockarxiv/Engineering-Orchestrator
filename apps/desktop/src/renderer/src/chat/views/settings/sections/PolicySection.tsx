import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NOT_ALLOWED_BY_YOUR_ORGANISATION, ORGANISATION_SECRET_LINE, moneyLabel, type OrganisationPolicy, type PublishedMcpServer } from "@eo/core";
import { PROVIDERS } from "../../../../shared/agents/catalog";
import { ipcQuery } from "../../../../query/client";
import { mcpServersKey, policyKey, usePolicy } from "../../../../query/hooks";
import { Button, CardSection, Checkbox, Chip, ErrorLine, Field, GroupLabel, Notice, Switch, TextInput } from "../../../kit";

/**
 * Settings → Policy: what an organisation decides for everybody (EO-328,
 * `ARCHITECTURE.md`, "Policy", "Secrets"),
 * in the chat layout's terms.
 *
 * What may run here, what an agent may be served and what a person may
 * spend — plus the values that travel with the second. A surface that may
 * not publish (`mayPublish`, never `fromServer`) is shown the policy
 * read-only with one line saying where it is set; the Publish button and
 * the secret form are left out rather than drawn inert.
 */
export function PolicySection() {
  const { policy, fromServer, mayPublish } = usePolicy();

  return (
    <>
      <PublishPanel mayPublish={mayPublish} fromServer={fromServer} />
      <SecretsPanel mayPublish={mayPublish} fromServer={fromServer} names={policy.secretNames} />
    </>
  );
}

/** Where a surface that cannot publish is told to go (ARCHITECTURE.md, "Publish, lock and versions"): its admin, or where to sign in. */
function whereToPublish(fromServer: boolean): string {
  return fromServer
    ? "Your organisation publishes this, on its server. Ask your admin to change it."
    : "What an organisation would decide for everybody. Signing in to a server is where this is published from — Settings → Organisation.";
}

/**
 * The three fields as one value: a person who edits the budget and
 * presses Publish publishes the other two as well — the design's section is
 * written whole — so the moment one becomes theirs, all three freeze.
 */
interface Draft {
  /** Null is "the organisation has not said", which is not an empty list. */
  backends: string[] | null;
  /** Text, so an empty box is "no ceiling" rather than nought. */
  budget: string;
  /** The ids of the catalogue rows being published. */
  published: string[];
}

function draftOf(policy: OrganisationPolicy): Draft {
  return {
    backends: policy.allowedBackends,
    budget: policy.perPersonDailyBudgetCents === null ? "" : String(policy.perPersonDailyBudgetCents),
    published: policy.mcpServers.map((server) => server.id),
  };
}

function centsFrom(typed: string): number | null {
  const trimmed = typed.trim();
  if (trimmed === "") return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function PublishPanel({ mayPublish, fromServer }: { mayPublish: boolean; fromServer: boolean }) {
  const queryClient = useQueryClient();
  const { policy } = usePolicy();
  const servers = useQuery({ queryKey: mcpServersKey, queryFn: () => ipcQuery("mcpServers:list", {}) });

  /**
   * The published policy until somebody edits it, and their edit from then
   * on (EO-328, review). Null-until-edited rather than seeded state: a
   * draft seeded on the first render — before `policy:get` resolves —
   * published an empty policy over the real one. While nothing is typed
   * this *is* the policy; once anything is, no refetch can reach it.
   */
  const [edited, setEdited] = useState<Draft | null>(null);
  const draft = edited ?? draftOf(policy);
  const edit = (patch: Partial<Draft>): void => setEdited({ ...draft, ...patch });

  const save = useMutation({
    mutationFn: (input: { allowedBackends: string[] | null; perPersonDailyBudgetCents: number | null; mcpServers: PublishedMcpServer[] }) =>
      ipcQuery("policy:save", input),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: policyKey }),
  });

  // Bound out of the draft so the narrowing survives into the callbacks.
  const restricted = draft.backends;
  const live = (servers.data?.servers ?? []).filter((server) => server.archivedAt === null);

  const definitions = (servers.data?.servers ?? [])
    .filter((server) => draft.published.includes(server.id))
    .map<PublishedMcpServer>((server) => ({
      id: server.id,
      name: server.name,
      description: server.description,
      config: server.config,
      // Names, never values: what is behind them is an organisation secret.
      envNames: server.envNames,
    }));

  const cents = centsFrom(draft.budget);

  return (
    <CardSection
      title="Policy"
      description={
        mayPublish
          ? "Published to every signed-in desktop. A device may not bind an agent to a backend outside the list, and nothing dispatches outside it either."
          : whereToPublish(fromServer)
      }
      actions={
        mayPublish ? (
          <Button
            variant="primary"
            disabled={save.isPending}
            onClick={() => save.mutate({ allowedBackends: draft.backends, perPersonDailyBudgetCents: cents, mcpServers: definitions })}
          >
            Publish
          </Button>
        ) : null
      }
    >
      <div role="group" aria-label="Allowed backends" className="flex min-w-0 flex-col gap-2">
        <GroupLabel>Allowed backends</GroupLabel>
        {/* "Not said" and "nothing" are opposite answers, so the switch between them is its own control. */}
        <Switch
          checked={draft.backends !== null}
          onChange={(on) => edit({ backends: on ? PROVIDERS.map((choice) => choice.id) : null })}
          label="Restrict which backends may be used"
        />
        {restricted === null ? (
          <p className="text-[12.5px] text-ink-subtle">Every backend a person has signed in to may be used.</p>
        ) : (
          <div className="flex min-w-0 flex-col gap-1.5 pl-11">
            {PROVIDERS.map((choice) => (
              <div key={choice.id} className="flex min-w-0 flex-wrap items-center gap-2">
                <Checkbox
                  checked={restricted.includes(choice.id)}
                  onChange={(checked) =>
                    edit({ backends: checked ? [...restricted, choice.id] : restricted.filter((backend) => backend !== choice.id) })
                  }
                  label={choice.label}
                />
                {restricted.includes(choice.id) ? null : <span className="text-[11.5px] text-ink-subtle">{NOT_ALLOWED_BY_YOUR_ORGANISATION}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cents, as every budget field in EO is, and text so an empty box is "no ceiling" rather than nought. */}
      <Field
        label="Daily budget per person (cents)"
        hint={cents === null ? "Empty is no ceiling." : `Each person may spend ${moneyLabel(cents)} a day. They see their own line in the top bar.`}
        className="max-w-[20rem]"
      >
        <TextInput
          inputMode="numeric"
          aria-label="Daily budget per person in cents"
          placeholder="No ceiling"
          value={draft.budget}
          onChange={(event) => edit({ budget: event.target.value })}
        />
      </Field>

      <div role="group" aria-label="Published MCP servers" className="flex min-w-0 flex-col gap-2">
        <GroupLabel>Published MCP servers</GroupLabel>
        {live.length === 0 ? (
          <p className="text-[12.5px] text-ink-subtle">This record has no MCP servers to publish. Settings → MCP servers is where one is added.</p>
        ) : (
          live.map((server) => (
            <div key={server.id} className="flex min-w-0 flex-wrap items-center gap-2">
              <Checkbox
                checked={draft.published.includes(server.id)}
                onChange={(checked) =>
                  edit({ published: checked ? [...draft.published, server.id] : draft.published.filter((id) => id !== server.id) })
                }
                label={
                  <>
                    <span className="sr-only">{`Publish ${server.name}`}</span>
                    <span aria-hidden>{server.name}</span>
                  </>
                }
              />
              <Chip>{server.config.transport}</Chip>
            </div>
          ))
        )}
      </div>

      {save.data?.problem ? <ErrorLine>{save.data.problem}</ErrorLine> : null}
      {save.error ? <ErrorLine>{save.error.message}</ErrorLine> : null}
      {save.data?.saved ? <p role="status" className="text-[12.5px] text-ink-subtle">Published to every signed-in desktop.</p> : null}
    </CardSection>
  );
}

/**
 * The organisation's secrets, by name. A value goes in and nothing comes
 * back: each row says `ORGANISATION_SECRET_LINE`, which is deliberately not
 * "never readable" — an agent with a shell reads its own environment
 * (`ARCHITECTURE.md`, "Secrets"). EO does not display it; that is the whole
 * of what it undertakes.
 */
function SecretsPanel({ mayPublish, fromServer, names }: { mayPublish: boolean; fromServer: boolean; names: readonly string[] }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: policyKey });

  const set = useMutation({
    mutationFn: (input: { name: string; value: string }) => ipcQuery("policy:setSecret", input),
    onSuccess: async (result) => {
      // Off the screen once sent, whatever happened to it.
      setValue("");
      if (result.saved) {
        setName("");
        setProblem(null);
        await refresh();
      } else {
        setProblem(result.problem);
      }
    },
    onError: (error: Error) => setProblem(error.message),
  });

  const clear = useMutation({
    mutationFn: (input: { name: string }) => ipcQuery("policy:clearSecret", input),
    onSuccess: async (result) => {
      setProblem(result.problem);
      await refresh();
    },
    onError: (error: Error) => setProblem(error.message),
  });

  return (
    <CardSection
      title="Organisation secrets"
      description="Set once here and delivered to every signed-in desktop, where a module or an MCP server is given it at spawn. EO never shows it again."
    >
      {names.length === 0 ? (
        <p className="text-[12.5px] text-ink-subtle">Nothing set.</p>
      ) : (
        <ul aria-label="Organisation secrets" className="flex min-w-0 flex-col [&>li+li]:border-t [&>li+li]:border-line/60">
          {names.map((secret) => (
            <li key={secret} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5">
                <code className="font-mono text-[12.5px] text-ink">{secret}</code>
                <span className="text-[11.5px] text-ink-subtle">{ORGANISATION_SECRET_LINE}</span>
              </span>
              {mayPublish ? (
                <Button size="sm" variant="ghost" disabled={clear.isPending} aria-label={`Clear ${secret}`} onClick={() => clear.mutate({ name: secret })}>
                  Clear
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {mayPublish ? (
        <div className="flex min-w-0 flex-wrap items-end gap-2 border-t border-line/60 pt-3">
          <Field label="Name" className="min-w-[10rem] flex-1">
            <TextInput className="font-mono" aria-label="Secret name" placeholder="FLY_API_TOKEN" value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Value" className="min-w-[10rem] flex-1">
            <TextInput type="password" aria-label="Secret value" value={value} onChange={(event) => setValue(event.target.value)} />
          </Field>
          <Button disabled={name.trim() === "" || value === "" || set.isPending} onClick={() => set.mutate({ name: name.trim(), value })}>
            Set
          </Button>
        </div>
      ) : (
        <Notice>
          {fromServer
            ? "An organisation secret is set on your organisation's server. A secret of your own is under Settings → Modules, and the two namespaces are separate — one of yours never replaces one of theirs, and never has to."
            : "An organisation secret is set on a server. A secret of your own is under Settings → Modules, and the two namespaces are separate — one of yours never replaces one of theirs, and never has to."}
        </Notice>
      )}
      {problem !== null ? <ErrorLine>{problem}</ErrorLine> : null}
    </CardSection>
  );
}
