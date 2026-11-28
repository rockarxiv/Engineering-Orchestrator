import { join } from "node:path";
import { vi } from "vitest";

/**
 * A machine's sign-in locations, fixed for a test of a sandboxed launch
 * (EO-934): both adapters hide the credential files and sockets wherever
 * the environment they launch with says they are (`hiddenIn`), so a test
 * that read the real `HOME` would expect paths of whoever ran it.
 *
 * Only tests import this module; see `testing/git.ts` for why that is
 * safe and `testing.test.ts` for what holds it.
 */
export const SANDBOX_ENVIRONMENT = {
  HOME: "/home/me",
  XDG_CONFIG_HOME: "/home/me/.config",
  GH_CONFIG_DIR: "/home/me/.config/gh",
  GLAB_CONFIG_DIR: "/home/me/.config/glab-cli",
  XDG_RUNTIME_DIR: "/run/user/1000",
  SSH_AUTH_SOCK: "/run/user/1000/ssh-agent",
} as const;

/**
 * What EO hides on a machine with `SANDBOX_ENVIRONMENT`, in the order it
 * lists them — joined the way this platform joins paths, as EO joins
 * them, so the same list holds on Windows (`\\home\\me\\…`).
 */
export const SANDBOX_HIDDEN = [
  join("/home/me/.config/gh", "hosts.yml"),
  join("/home/me/.config/glab-cli", "config.yml"),
  join("/home/me", ".git-credentials"),
  join("/home/me/.config", "git", "credentials"),
  join("/home/me", ".ssh"),
  "/run/user/1000/ssh-agent",
  join("/run/user/1000", "bus"),
];

/** Stubs `SANDBOX_ENVIRONMENT` into `process.env`. Undo with `vi.unstubAllEnvs()`. */
export function stubSandboxEnvironment(): void {
  for (const [name, value] of Object.entries(SANDBOX_ENVIRONMENT)) vi.stubEnv(name, value);
}
