import type { Agent } from "@eo/core";
import { describe, expect, it } from "vitest";
import { agentSandboxFor, credentialFiles, signInSockets, withAgentSandbox } from "./agentSandbox.js";
import { NOTHING_ATTACHED } from "./workspaceKind.js";

/**
 * What EO keeps from a sandboxed agent (EO-934, ARCHITECTURE.md §12.7):
 * the credential files it knows of and both sign-in sockets hidden by
 * path, the forge token variables and both sign-in channels withheld.
 */
const HOME = "/home/me";
const ENVIRONMENT = { SSH_AUTH_SOCK: "/run/user/1000/ssh-agent.socket", XDG_RUNTIME_DIR: "/run/user/1000" };

function agent(config: Record<string, unknown>): Agent {
  return { config } as unknown as Agent;
}

describe("what a sandboxed agent is kept from", () => {
  it("hides the gh hosts file, glab's config, git's credential stores, ~/.ssh, the SSH agent's socket and the session bus", () => {
    expect(agentSandboxFor([], HOME, ENVIRONMENT).hidden).toEqual([
      "/home/me/.config/gh/hosts.yml",
      "/home/me/.config/glab-cli/config.yml",
      "/home/me/.git-credentials",
      "/home/me/.config/git/credentials",
      "/home/me/.ssh",
      "/run/user/1000/ssh-agent.socket",
      "/run/user/1000/bus",
    ]);
  });

  it("withholds every forge token variable EO knows of, SSH_AUTH_SOCK and DBUS_SESSION_BUS_ADDRESS", () => {
    expect(agentSandboxFor([], HOME, ENVIRONMENT).withheld).toEqual(
      expect.arrayContaining(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GITLAB_TOKEN", "GL_TOKEN", "SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS"]),
    );
  });

  it("follows the configuration directories the environment names", () => {
    expect(credentialFiles(HOME, { XDG_CONFIG_HOME: "/cfg", GH_CONFIG_DIR: "/gh" })).toEqual(["/gh/hosts.yml", "/cfg/glab-cli/config.yml", "/home/me/.git-credentials", "/cfg/git/credentials", "/home/me/.ssh"]);
  });

  it("names no socket the environment does not", () => {
    expect(signInSockets({})).toEqual([]);
  });
});

describe("which turns are sandboxed", () => {
  it("puts no sandbox on an agent whose setting is off, or is anything but true", () => {
    for (const config of [{}, { sandboxed: false }, { sandboxed: "true" }, { sandboxed: null }, { sandboxed: 1 }]) {
      expect(withAgentSandbox({ ...NOTHING_ATTACHED, sandboxWritable: ["/wt"] }, agent(config), "/wt").sandbox).toBeUndefined();
    }
  });

  it("sandboxes a sandboxed agent's turn with what its workspace lent it", () => {
    const sandbox = withAgentSandbox({ ...NOTHING_ATTACHED, sandboxWritable: ["/wt", "/repo/.git/objects"] }, agent({ sandboxed: true }), "/wt").sandbox;
    expect(sandbox?.writable).toEqual(["/wt", "/repo/.git/objects"]);
    expect(sandbox?.hidden.length).toBeGreaterThan(0);
    expect(sandbox?.withheld).toContain("GH_TOKEN");
  });

  it("sandboxes a sandboxed agent's turn on a workspace that lends nothing to the directory it runs in, and with no directory to nothing more", () => {
    expect(withAgentSandbox(NOTHING_ATTACHED, agent({ sandboxed: true }), "/scratch/EO-1").sandbox?.writable).toEqual(["/scratch/EO-1"]);
    expect(withAgentSandbox(NOTHING_ATTACHED, agent({ sandboxed: true }), null).sandbox?.writable).toEqual([]);
  });
});
