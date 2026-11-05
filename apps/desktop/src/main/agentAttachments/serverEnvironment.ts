import type { Db } from "../db/client.js";
import { resolveAgentAttachments } from "../db/repos/agentAttachmentsRepo.js";
import { readMcpServerSecretEntry, type McpServerSecretsOptions } from "../mcp/serverSecrets.js";
import { deliverableAttachments } from "./pluginDirectory.js";

/**
 * The values behind the names a generated `.mcp.json` refers to
 * (EO-107).
 *
 * This is the other half of "secrets never enter a generated file". The
 * file carries `${GITHUB_TOKEN}`; this is what makes that expand to
 * something. The value goes into the environment of the CLI process EO
 * spawns, where the config parser expands it and the server subprocess
 * receives it — verified against the binary rather than assumed.
 *
 * Two properties matter more than the twelve lines below.
 *
 * **It is read at spawn, never held.** A provider is cached per agent
 * and outlives any number of keychain edits, so a value read once at
 * construction would go on being injected after somebody cleared it.
 * `providers/claude.ts` already reads the API key this way and says why;
 * this is a second reader of the same rule. It is also what keeps a
 * secret out of the provider cache key, which `engine.ts` records the
 * reasoning for.
 *
 * **It never crosses IPC and never reaches SQLite.** The values live in
 * the OS keychain with their ciphertext under `userData`; this function
 * is inside the main process, and what it returns goes straight into a
 * child process's environment.
 */

/**
 * What an organisation's store answers about one name.
 *
 * Structurally `OrganisationSecretRead`, spelled here so this module
 * goes on knowing nothing about where an organisation's secrets live —
 * the same reason `modules/secrets.ts` takes a function rather than a
 * store.
 */
export type OrganisationRead = { state: "value"; value: string } | { state: "absent" } | { state: "unreadable" };

export interface AttachmentEnvironment {
  /** Variable name to value, for every declared name the keychain or the run's environment variables could answer. */
  env: Record<string, string>;
  /**
   * The names it could not, with the server that wanted them.
   *
   * Kept apart from `env` rather than defaulted to empty strings,
   * because the two are different sentences to a server: an unset
   * variable is usually "you are not signed in", and a variable set to
   * nothing at all is a credential that is present and wrong. This is
   * also what a failure to start can be explained by.
   */
  unresolved: { server: string; name: string; reason: "absent" | "unreadable" }[];
  /**
   * The names whose value must not be stood in for by anything else in
   * the CLI's environment (EO-488): an organisation value that is there
   * and cannot be read.
   *
   * Not only "not in `env`". A name EO simply has nothing for is left to
   * whatever the CLI inherited, as it always was; a withheld one is
   * taken out of the run's environment variables and the inherited
   * environment alike, so neither a variable nor the person's shell
   * hands the server a value in place of the organisation's. The same
   * answer Codex's reader gives as `SECRET_WITHHELD`.
   */
  withheld: string[];
}

/**
 * What one agent's attached servers need in their environment, right
 * now.
 *
 * Only the servers that are actually delivered: a disabled or archived
 * one is not in the generated directory, so reading its secrets would
 * put a value into a process for a server that is not there.
 *
 * The environment is flat and a variable name is a variable name, so two
 * servers declaring the same one cannot both be served with different
 * values. The first by server name wins, deterministically rather than
 * by whichever row read first. Worth knowing about; not worth a
 * mechanism until somebody hits it.
 */
export function attachmentEnvironment(
  db: Db,
  agentId: string,
  secrets: McpServerSecretsOptions,
  /**
   * The organisation's value for a name, where this installation has
   * one (EO-328, ARCHITECTURE.md, "Secrets").
   *
   * **It wins over the machine's own, and a personal value of the same
   * name shadows nothing** — the same precedence, and the same sentence
   * from the story, that `modules/secrets.ts` sets out at length. This
   * is the "or an MCP header" half of "a module's environment or an MCP
   * header": the generated configuration still carries `${GITHUB_TOKEN}`
   * and this is still what makes it expand to something, from a value
   * this machine holds under its own keychain and never displays.
   *
   * **Three states and not a nullable value**, and that is the whole
   * reason this is not `(name) => string | null`. It was, and it was
   * wrong in the one way that matters: an organisation value that is
   * *there but unreadable* — written before this machine's keychain was
   * reset, or by another machine — collapsed to null and fell through to
   * the person's own value of the same name. So a personal secret could
   * shadow an organisation one in exactly the failure state where
   * nobody would notice, which is the substitution this story says must
   * not happen. Unreadable is now its own answer, and it stops the
   * fallback rather than passing it: the server is delivered with the
   * variable unset, and the gap is reported.
   *
   * Omitted leaves the behaviour exactly as it was before this story.
   */
  organisation?: (name: string) => OrganisationRead,
  /**
   * The run's environment variables (EO-488): every shared one with the
   * run's step's own over them, as `agentRunVariables` composes them.
   *
   * **The last thing asked, and only for a declared name.** An
   * organisation value wins, then the server's own secret, and only a
   * name neither holds is filled from here — the order ARCHITECTURE.md
   * §14.2 sets out, and the one `codexServerSecretReader` applies on the
   * other backend. A secret on this server that no longer decrypts is
   * not a value either, so a variable of the same name fills it, as the
   * CLI's inherited environment always has; an organisation value that
   * cannot be read is different, and stops the fallback here as it does
   * everywhere (`withheld`).
   *
   * Only for the servers that are delivered, which is what the walk
   * below already is: a disabled or archived server is given nothing.
   *
   * Omitted is the same as none.
   */
  variables: Readonly<Record<string, string>> = {},
): AttachmentEnvironment {
  const { servers } = deliverableAttachments(resolveAgentAttachments(db, agentId));
  // A Map and own properties out of it, for the reason
  // `agentRunVariables` gives: `__proto__` is a name a server may
  // declare, and assigning it on a plain object calls a setter.
  const env = new Map<string, string>();
  const unresolved: AttachmentEnvironment["unresolved"] = [];
  const withheld: string[] = [];

  for (const server of [...servers].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const name of server.envNames) {
      if (env.has(name) || withheld.includes(name)) continue;
      const theirs = organisation?.(name) ?? { state: "absent" as const };
      if (theirs.state === "value") {
        env.set(name, theirs.value);
        continue;
      }
      if (theirs.state === "unreadable") {
        // Named against the *organisation* rather than against this
        // machine's own store, because that is where the value somebody
        // has to fix actually is. A wrong credential is worse than no
        // credential, so nothing falls through.
        unresolved.push({ server: "your organisation", name, reason: "unreadable" });
        withheld.push(name);
        continue;
      }
      const read = readMcpServerSecretEntry(secrets, server.id, name);
      if (read.state === "value") env.set(name, read.value);
      else unresolved.push({ server: server.name, name, reason: read.state });
    }
  }

  // The variables only once every delivered server's secrets have been
  // asked, and only for a name none of them filled. The environment is
  // flat, so filling a name from a variable while walking the servers
  // let a server earlier by name, with no secret of its own, take the
  // name from a later server that has one — a variable displacing a
  // stored secret, which is the order the other way round.
  const filled = new Set<string>();
  for (const gap of unresolved) {
    if (env.has(gap.name) || withheld.includes(gap.name) || !Object.hasOwn(variables, gap.name)) continue;
    env.set(gap.name, variables[gap.name] as string);
    filled.add(gap.name);
  }

  return { env: Object.fromEntries(env), unresolved: unresolved.filter((gap) => !filled.has(gap.name)), withheld };
}
