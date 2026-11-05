import { ACTOR_SCOPED_CHANNELS, ipcContract } from "@eo/core";
import { describe, expect, it } from "vitest";
import { TOOLS } from "./catalog.js";
import { inputSchemaFor, isVoidChannel, withoutCallerIdentity } from "./toolSchema.js";

describe("deriving a tool's input schema", () => {
  it("translates a void request into the empty argument list", () => {
    // z.toJSONSchema throws on z.void() rather than producing something
    // awkward, so this is a branch taken before zod is asked, not a
    // fallback after it fails.
    expect(inputSchemaFor(ipcContract["agents:list"].request)).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("keeps defaulted fields optional, which is what io: input buys", () => {
    // Under io: "output" all three would be required, and a model would
    // be asked for two numbers EO was going to fill in anyway. This is
    // the assertion that pins that choice down.
    const schema = inputSchemaFor(ipcContract["runs:listEvents"].request);

    expect(schema["required"]).toEqual(["runId"]);
    expect(schema["properties"]).toMatchObject({ fromSeq: { default: 0 }, limit: { default: 200 } });
  });

  it("closes every object schema to unknown properties", () => {
    // Zod strips unknown keys silently, so without this a misspelled
    // argument reaches the handler as an absence and the call quietly
    // does something other than what was asked.
    expect(inputSchemaFor(ipcContract["items:get"].request)["additionalProperties"]).toBe(false);
  });

  it("does not carry the JSON Schema dialect into an inline tool schema", () => {
    expect(inputSchemaFor(ipcContract["items:get"].request)).not.toHaveProperty("$schema");
  });
});

describe("isVoidChannel", () => {
  it("recognises the channels that take nothing", () => {
    expect(isVoidChannel("agents:list")).toBe(true);
    expect(isVoidChannel("items:get")).toBe(false);
  });

  it("agrees with what those channels actually accept", () => {
    // The reason the predicate exists: `{}` — which is what every MCP
    // client sends for a tool with an empty schema — is rejected by
    // z.void() as firmly as a string would be.
    expect(ipcContract["agents:list"].request.safeParse({}).success).toBe(false);
    expect(ipcContract["agents:list"].request.safeParse(undefined).success).toBe(true);
  });
});

describe("every catalogued tool", () => {
  it("advertises a schema a client can send against", () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema["type"], tool.name).toBe("object");
      expect(tool.inputSchema, tool.name).not.toHaveProperty("$schema");
    }
  });

  it("defaults the worktree listing to every repository", () => {
    // The channel's own schema has repositoryId nullable but *required*,
    // so without the override a client would have to be told to send an
    // explicit null — and a model told that will forget.
    const worktrees = TOOLS.find((tool) => tool.name === "worktrees_list");

    expect(worktrees?.inputSchema["required"]).toBeUndefined();
  });
});

/**
 * The caller's identity is never a tool argument (EO-326, ARCHITECTURE.md, "Identity").
 *
 * `ACTOR_SCOPED_CHANNELS` carry an `actingDeviceId` that a server's door
 * stamps from the credential a request arrived on. An agent reached
 * through this host is a *caller*, not a door — so a tool that advertised
 * the field would be inviting a model to say which device it is, and a
 * model that said one would be reading somebody else's inbox and filing
 * a decision under their name.
 *
 * Both halves are asserted, because a description nobody enforces is a
 * suggestion: the schema does not mention it, and a call that sends it
 * anyway has it removed before it reaches the channel that declares it.
 */
describe("what a tool may not say about who is asking", () => {
  it("advertises no acting device on any tool", () => {
    const leaking = TOOLS.filter((tool) => {
      const properties = tool.inputSchema["properties"];
      return properties !== undefined && Object.hasOwn(properties as Record<string, unknown>, "actingDeviceId");
    });

    expect(leaking.map((tool) => tool.name)).toEqual([]);
  });

  it("covers every actor-scoped channel a tool offers", () => {
    // The half that would rot quietly: a channel added to
    // `ACTOR_SCOPED_CHANNELS` *and* catalogued as a tool is the case
    // this rule exists for, and there has to be at least one for the
    // assertion above to be worth anything.
    const offered = new Set(TOOLS.flatMap((tool) => tool.channels));

    expect(ACTOR_SCOPED_CHANNELS.filter((channel) => offered.has(channel)).length).toBeGreaterThan(0);
  });

  it("takes the field out of a schema that declares it, and leaves the rest alone", () => {
    const stripped = inputSchemaFor(withoutCallerIdentity(ipcContract["items:decide"].request));

    expect(Object.keys(stripped["properties"] as Record<string, unknown>).sort()).toEqual(["comment", "itemId", "resultKey"]);
  });

  it("hands back a schema that never declared it, by identity", () => {
    // What lets `channelTool` tell "this needed changing" from "this did
    // not", which is the same bargain `boundaryArguments` makes.
    const untouched = ipcContract["items:get"].request;

    expect(withoutCallerIdentity(untouched)).toBe(untouched);
  });

  it("drops the field from a call that sent it anyway", async () => {
    // The enforcing half. `boundary.accepts` is loose by design, so a
    // client that invented the argument would otherwise reach a channel
    // that *does* declare it — acting as a device it named for itself.
    const tool = TOOLS.find((candidate) => candidate.channels.includes("items:decide"))!;
    const sent: unknown[] = [];

    await tool.run(async (_channel, payload) => {
      sent.push(payload);
      return { ok: true, data: { decided: false, toStepId: null, toStepName: null, toPipelineId: null, commentId: null, problem: "no" } };
    }, { ticketId: "an-item", resultKey: "approved", comment: "", actingDeviceId: "somebody-elses-laptop" });

    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty("actingDeviceId");
  });
});
