import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSandbox } from "@eo/core";

/**
 * What EO keeps from a sandboxed agent so that it holds no forge
 * sign-in (EO-934, ARCHITECTURE.md §12.7), on both backends alike.
 *
 * EO-932's credentials decision names the `gh` hosts file, git's
 * credential stores, `~/.ssh` and the forge token variables. EO-933
 * measured that this is not enough on Codex: the SSH agent named by
 * `SSH_AUTH_SOCK` still authenticates git over SSH, and `gh` reads its
 * token from the desktop keyring through the session bus. So both are
 * withheld as variables and hidden as sockets by path, since stripping
 * a variable does not take away the socket it named, and a program finds
 * the session bus at `$XDG_RUNTIME_DIR/bus` without one. Claude refuses
 * unix sockets in its sandbox anyway; hiding them there costs nothing.
 *
 * `claudeSandbox.live.test.ts` and `codexSandbox.live.test.ts` hold these
 * lists against the real CLIs (through `testing/sandboxProbe.ts`, which
 * reads them from here).
 *
 * In `providers/` because both adapters ask it again of the environment
 * they actually launch with (`hiddenIn`): the supervisor's answer is from
 * EO's own environment, and a run's variables or an attached server's
 * values can name other places (EO-934 review).
 */

/** The forge token variables EO knows of: GitHub's `gh` and GitLab's `glab` read these. */
export const FORGE_TOKEN_VARIABLES = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GITLAB_TOKEN", "GL_TOKEN"] as const;

/** The two channels to a sign-in that are not files: the SSH agent and the session bus. */
export const SIGN_IN_CHANNEL_VARIABLES = ["SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS"] as const;

/**
 * The credential files EO knows of: the `gh` hosts file, `glab`'s config,
 * git's credential stores and `~/.ssh`. A path that does not exist is
 * listed all the same — EO-933 found that neither backend minds — so the
 * list does not change with what happens to be on disk.
 */
export function credentialFiles(home: string = homedir(), environment: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const config = environment["XDG_CONFIG_HOME"] || join(home, ".config");
  const gh = environment["GH_CONFIG_DIR"] || join(config, "gh");
  const glab = environment["GLAB_CONFIG_DIR"] || join(config, "glab-cli");
  return [join(gh, "hosts.yml"), join(glab, "config.yml"), join(home, ".git-credentials"), join(config, "git", "credentials"), join(home, ".ssh")];
}

/** The SSH agent's socket and the session bus, by path, wherever the environment says they are. */
export function signInSockets(environment: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const sockets: string[] = [];
  const agent = environment["SSH_AUTH_SOCK"];
  if (agent) sockets.push(agent);
  const runtime = environment["XDG_RUNTIME_DIR"];
  if (runtime) sockets.push(join(runtime, "bus"));
  return sockets;
}

/**
 * Everything a sandboxed turn hides, for the environment its CLI is
 * actually launched with (EO-934 review): what the supervisor worked out
 * from EO's own environment, and the same files and sockets wherever
 * this environment says they are — a run's `GH_CONFIG_DIR`,
 * `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR` or `SSH_AUTH_SOCK` moving them —
 * so a location inherited stays hidden and an overridden one is hidden too.
 * Asked before the withheld names are stripped, since a socket's
 * variable going does not take the socket with it.
 */
export function hiddenIn(sandbox: AgentSandbox, environment: Readonly<Record<string, string | undefined>>): AgentSandbox {
  const home = environment["HOME"] || homedir();
  const hidden = [...new Set([...sandbox.hidden, ...credentialFiles(home, environment), ...signInSockets(environment)])];
  return { ...sandbox, hidden };
}
