import { describe, expect, it } from "vitest";
import { ipcContract, sectionLockedRefusal, type IpcChannel } from "./ipc.js";
import {
  lockedSectionsFor,
  publishConfirmation,
  PUBLISHED_SECTIONS,
  SECTION_LOCK_TEXT,
  SECTION_LOCKED_CHANNELS,
  sectionLockedMessage,
} from "./sections.js";

describe("the sections an organisation publishes", () => {
  it("locks channels that exist", () => {
    const invented = PUBLISHED_SECTIONS.flatMap((section) =>
      SECTION_LOCKED_CHANNELS[section].filter((channel) => !(channel in ipcContract)),
    );

    // The map is what the command layer refuses on. A channel renamed
    // out from under it would be a section that had quietly stopped
    // locking, with every test still green.
    expect(invented).toEqual([]);
  });

  it("never locks a read", () => {
    // Every locked channel is a write. A lock over a read would be an
    // organisation hiding its own configuration from the people using
    // it, which is not what the design asks for and not what the lock text
    // says: it promises the *editing* is theirs, never the looking.
    const reads = PUBLISHED_SECTIONS.flatMap((section) =>
      SECTION_LOCKED_CHANNELS[section].filter((channel) => /:(list|get|versions|validate|preflight)$/i.test(channel)),
    );

    expect(reads).toEqual([]);
  });

  it("leaves what §4.3 says is the person's alone", () => {
    // The lock text promises "your sign-ins, local folders and personal
    // secrets are yours", and these are the channels that would make it
    // false. Named one by one rather than inferred, so that adding any
    // of them to a section is a conversation rather than a commit.
    const theirs: IpcChannel[] = [
      "connectors:connectToken",
      "connectors:connectOAuth",
      "connectors:disconnect",
      "settings:set",
      "mcpServers:setSecret",
      "moduleSecrets:set",
      "workspaces:create",
      "workspaces:update",
      "session:signIn",
      "session:signOut",
    ];

    expect(theirs.filter((channel) => lockedSectionsFor(channel).length > 0)).toEqual([]);
  });

  it("answers the same section for a channel several sections cover", () => {
    // Installing a pack writes the graph, the agents staffing it, the
    // skills it brings and the connectors it declares — so every one of
    // those locks refuses it, and the order is fixed, so the refusal
    // names the same section however the map is written.
    expect(lockedSectionsFor("gallery:use")).toEqual(["pipelines", "agents", "packs", "connectors"]);
    expect(lockedSectionsFor("pipelines:import")).toEqual(["pipelines", "agents", "packs", "connectors"]);
    expect(lockedSectionsFor("items:move")).toEqual([]);
    // The local half of an agent is in no section at all (ARCHITECTURE.md, "Publish, lock and
    // versions"): it is
    // what stops a locked agents section stranding somebody signed in
    // to one backend and not the other. What narrows it is policy's own
    // allowed-backends list, checked in `setAgentBinding` (EO-328).
    expect(lockedSectionsFor("agents:setBinding")).toEqual([]);
  });

  it("locks nothing under policy, because policy is published by its own story", () => {
    // EO-328 does the whole of the design — allowed backends, per-person
    // budgets, which MCP servers exist, organisation secrets — with its
    // own publish and its own refusals, per *row*: a published server
    // may not be edited or archived on a desktop, and whether it is
    // switched on there stays the person's. A section lock over the
    // same channels would contradict that on the one control it leaves
    // alone, and would take the installation's guardrails with it.
    expect(SECTION_LOCKED_CHANNELS.policy).toEqual([]);
    for (const channel of ["guards:set", "mcpServers:save", "mcpServers:setEnabled", "mcpServers:archive"] as const) {
      expect(lockedSectionsFor(channel)).toEqual([]);
    }
    // The name stays, because the design names five sections and a person
    // reads five.
    expect(PUBLISHED_SECTIONS).toContain("policy");
  });

  it("says what is locked, who published it and that nothing was written", () => {
    const message = sectionLockedMessage({ locked: true, section: "agents", publishedBy: "Dana" });

    expect(message).toContain("agents");
    expect(message).toContain("Dana");
    expect(message).toContain("Nothing has been written");
    // The next move, because an agent told only "no" tries the tool
    // beside it. For four of the five sections there is no next move,
    // and saying so is the answer.
    expect(message).toContain("stop");

    // Pipelines are the fifth, and since EO-331 they have a route out
    // that is not a way round: the refusal names it, because an agent
    // told only "no" offers the person nothing and the door goes
    // undiscovered.
    const pipelines = sectionLockedMessage({ locked: true, section: "pipelines", publishedBy: "Dana" });
    expect(pipelines).toContain("suggest");
    expect(pipelines).toContain("administrator");
    // And it is still the person's to ask for. An assistant that filed
    // one because it seemed helpful would be asking an organisation for
    // something in somebody's name without being asked to.
    expect(pipelines).toContain("only if they say yes");

    // A publish EO has no name for says less rather than inventing one.
    expect(sectionLockedMessage({ locked: true, section: "policy", publishedBy: null })).not.toContain("published it");
  });

  it("carries the refusal typed as well as written", () => {
    const refusal = sectionLockedRefusal({ locked: true, section: "pipelines", publishedBy: null });

    expect(refusal.ok).toBe(false);
    expect(refusal.error.code).toBe("section-locked");
    expect(refusal.error.lock).toEqual({ locked: true, section: "pipelines", publishedBy: null });
    expect(refusal.error.message).toBe(sectionLockedMessage({ locked: true, section: "pipelines", publishedBy: null }));
  });

  it("says what a publish costs in the words §8.3 uses", () => {
    expect(publishConfirmation({ items: 3, devices: 2, finishOn: 6 })).toBe("3 items in flight across 2 desktops finish on v6.");
    // One of each, because "1 items across 1 desktops finish" is the
    // sentence everybody writes and nobody reads twice.
    expect(publishConfirmation({ items: 1, devices: 1, finishOn: 6 })).toBe("1 item in flight across 1 desktop finishes on v6.");
    // Nothing in flight is the ordinary case, and a warning about
    // nothing reads as a warning.
    expect(publishConfirmation({ items: 0, devices: 4, finishOn: null })).toBe("Nothing is in flight. Every desktop takes this version.");
  });

  it("keeps both halves of the lock text", () => {
    expect(SECTION_LOCK_TEXT).toBe(
      "Steps, routes and prompts are managed by your organisation. Your sign-ins, local folders and personal secrets are yours.",
    );
  });
});
