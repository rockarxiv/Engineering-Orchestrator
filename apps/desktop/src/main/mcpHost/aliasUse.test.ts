import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { clientIdFor, oldNamesStillCalled, readAliasUse, recordToolCall } from "./aliasUse.js";

/**
 * What the Servers screen's row is derived from (KAN-178).
 *
 * The row has to be a fact rather than a guess, and the only place the
 * fact exists is a `tools/call` arriving at the host. These are the
 * rules that turn a stream of calls into one sentence about one client:
 * which spelling it is on, per tool, latest wins.
 */

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

/** The old names a client is still on, as the screen would list them. */
function oldNames(client: string): string[] {
  const record = readAliasUse(handle.db).find((entry) => entry.client === client);
  return record === undefined ? [] : oldNamesStillCalled(record).map((entry) => entry.deprecated);
}

describe("recording what a client calls", () => {
  it("reports a client that called an old name, and says nothing about one that did not", () => {
    recordToolCall(handle.db, "old-client", "ticket_get");
    recordToolCall(handle.db, "new-client", "item_get");

    expect(oldNames("old-client")).toEqual(["ticket_get"]);
    expect(oldNames("new-client")).toEqual([]);
  });

  it("says nothing about a client that only ever called tools with one name", () => {
    recordToolCall(handle.db, "reader", "comment_post");

    expect(oldNames("reader")).toEqual([]);
    // The call is still recorded — "the tool name of each call" — it
    // simply has nothing to say about which spelling anybody is on.
    expect(readAliasUse(handle.db)[0]?.lastToolName).toBe("comment_post");
  });

  /**
   * The reason the record is per tool with the latest spelling winning
   * rather than a set of everything ever called: a warning that cannot
   * be cleared by fixing the thing it warns about is one that gets
   * ignored.
   */
  it("clears the row once the client has moved to EO's own name", () => {
    recordToolCall(handle.db, "updating", "ticket_move");
    expect(oldNames("updating")).toEqual(["ticket_move"]);

    recordToolCall(handle.db, "updating", "item_move");
    expect(oldNames("updating")).toEqual([]);
  });

  it("keeps reporting a tool nothing has said anything new about", () => {
    recordToolCall(handle.db, "mixed", "ticket_get");
    recordToolCall(handle.db, "mixed", "comment_post");
    recordToolCall(handle.db, "mixed", "item_move");

    // `comment_post` and `item_move` say nothing about `ticket_get`, so
    // this client is still on the old name for that one tool.
    expect(oldNames("mixed")).toEqual(["ticket_get"]);
  });

  it("keeps each client's answer to itself", () => {
    recordToolCall(handle.db, "one", "ticket_archive");
    recordToolCall(handle.db, "two", "item_archive");

    expect(oldNames("one")).toEqual(["ticket_archive"]);
    expect(oldNames("two")).toEqual([]);
  });

  it("forgets the client nothing has been heard from for longest, rather than growing without bound", () => {
    for (let index = 0; index < 12; index += 1) {
      recordToolCall(handle.db, `client-${index}`, "ticket_get", new Date(1_700_000_000_000 + index * 1000));
    }

    const remembered = readAliasUse(handle.db).map((entry) => entry.client);
    expect(remembered).toHaveLength(8);
    expect(remembered[0]).toBe("client-11");
    expect(remembered).not.toContain("client-0");
  });

  it("survives a client that sent no usable name for itself", () => {
    recordToolCall(handle.db, "   ", "ticket_get");

    expect(readAliasUse(handle.db)[0]?.client).toBe("an unnamed client");
  });
});

describe("which client a name belongs to", () => {
  /**
   * `clientInfo.name` is whatever the program decided to send, and none
   * of the three is spelled the way EO's own id is.
   */
  it("recognises the three EO can register with, however they spell themselves", () => {
    expect(clientIdFor("claude-code")).toBe("claude-code");
    expect(clientIdFor("Claude Code")).toBe("claude-code");
    expect(clientIdFor("codex-cli")).toBe("codex");
    expect(clientIdFor("claude-ai")).toBe("claude-desktop");
  });

  it("answers null for anything else, which is a row under its own name rather than no row", () => {
    expect(clientIdFor("mcp-remote")).toBe(null);
    expect(clientIdFor("some-script")).toBe(null);
  });
});
