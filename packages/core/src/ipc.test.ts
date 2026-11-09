import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AGENT_ACTED_CHANNELS,
  isAgentActedChannel,
  withActingAgent,
  ACTOR_SCOPED_CHANNELS,
  DEVICE_SCOPED_CHANNELS,
  ipcContract,
  isActorScopedChannel,
  isDeviceScopedChannel,
  isMachineChannel,
  ipcRequestBytes,
  MAX_ATTACHMENT_BASE64_CHARS,
  MAX_IPC_REQUEST_BYTES,
  machineContract,
  machineOnlyRefusal,
  recordContract,
  withActingDevice,
  withDeviceIdentity,
  type IpcChannel,
  type IpcPayload,
  type IpcRequest,
  type MachineChannel,
  type RecordChannel,
} from "./ipc.js";
import { JiraIssueKeySchema } from "./ipc-schemas.js";

/**
 * The record half and the machine half (KAN-127,
 * ARCHITECTURE.md, "Where the seams are").
 *
 * `ipcContract` is their union, so every reader sees what it always saw.
 * What the halves add is a boundary a type can check: an organisation
 * server (phase 7a) implements the record half and none of the machine
 * half, and the way that goes wrong quietly is a channel drifting into
 * both lists, or a new one being added to neither and nobody noticing
 * which side of the boundary it landed on.
 *
 * Type assertions rather than only runtime ones because the failure they
 * describe is a compile-time one — and because `RecordChannel` is what
 * the MCP catalogue's exclusion list is now keyed by, so a half that
 * quietly overlapped would take that check down with it.
 */
describe("the two halves of the contract", () => {
  it("puts no channel in both halves", () => {
    // The one that a union can hide. `{...record, ...machine}` would
    // simply let the machine entry win, leaving two schemas for one
    // channel and no error anywhere.
    expectTypeOf<RecordChannel & MachineChannel>().toEqualTypeOf<never>();
  });

  it("leaves no channel in neither half", () => {
    // True by construction today — `ipcContract` is derived from the two
    // and cannot be written into directly. Asserted anyway, because the
    // way that construction gets undone is somebody adding "just one"
    // channel to the union literal, and this is the line that would
    // stop them.
    expectTypeOf<IpcChannel>().toEqualTypeOf<RecordChannel | MachineChannel>();
  });

  it("is known to be able to fail", () => {
    // The two assertions above pointed at something that is not true.
    // An unused `@ts-expect-error` is itself a compile error, so each
    // directive here fails the build the moment the check above stops
    // being a check — the trick catalog.test.ts plays on its exclusion
    // sweep, at the type level.
    // @ts-expect-error — every record channel is in a half, so it cannot be `never`.
    expectTypeOf<RecordChannel>().toEqualTypeOf<never>();
    // @ts-expect-error — the contract is not the record half alone.
    expectTypeOf<IpcChannel>().toEqualTypeOf<RecordChannel>();
  });

  it("adds up at runtime too", () => {
    // The same two facts where the type system cannot reach: duplicate
    // keys collapse in a spread, so a count that adds up is the runtime
    // proof that nothing is in both.
    const record = Object.keys(recordContract);
    const machine = Object.keys(machineContract);

    expect(Object.keys(ipcContract).length).toBe(record.length + machine.length);
    expect(record.filter((channel) => channel in machineContract)).toEqual([]);
    expect(machine.filter((channel) => channel in recordContract)).toEqual([]);
  });

  it("carries the same schemas the union does", () => {
    // A half that answered with a different schema object than the one
    // the union hands a handler would be two contracts wearing one name.
    for (const [name, half] of [["record", recordContract], ["machine", machineContract]] as const) {
      for (const [channel, spec] of Object.entries(half)) {
        expect(ipcContract[channel as IpcChannel], `${name}: ${channel}`).toBe(spec);
      }
    }
  });

  it("keeps the machine half to what only the machine can answer", () => {
    // Spelled out rather than derived from a prefix rule: what makes a
    // channel machine-local is that answering it needs the desktop this
    // process is running on — a dialog somebody clicks, the window they
    // are looking at, the CLIs installed here, this binary's own update,
    // the checkouts on this disk, the editors to register with. Written
    // down so that moving one is a visible decision rather than a
    // rename.
    expect(Object.keys(machineContract).sort()).toEqual(
      [
        "attachments:open",
        "attachments:pick",
        "attachments:save",
        // The canvas's own desktop window (EO-383): popping it out,
        // sending it somewhere, closing it and asking whether it is out
        // are all about a window on this machine, and a browser tab
        // served the same renderer has none to be given.
        "canvas:ask",
        "canvas:close",
        "canvas:open",
        "canvas:state",
        "canvas:window",
        // A connector's OAuth (EO-315): a browser window on this
        // machine and a person to press the consent screen in it —
        // `runtime:startSignIn`'s shape exactly. The other three
        // connector channels are answered from the record and the
        // keychain, and are in the other half.
        "connectors:connectOAuth",
        // Debug mode (EO-392): a switch on this installation, a window
        // on this desktop, and a read that exists only to fill it.
        "debug:getMode",
        "debug:runs",
        "debug:setMode",
        "debug:window",
        "dialog:pickDirectory",
        "items:exportOutput",
        // Where a job may run (EO-330, ARCHITECTURE.md, "Where a job runs"). Machine-half because
        // every reason it can give is a fact about *this* desktop —
        // which backend it is signed in to and how, which secrets are
        // on this disk, which MCP servers this catalogue holds. A
        // server answering it would be describing its own sign-ins to
        // somebody asking about their laptop.
        "jobs:placement",
        "mcp:detectClients",
        "mcp:registerWith",
        // Revealing a personal secret (EO-489, ARCHITECTURE.md §14.2).
        // The value is in this machine's keychain and the person asking
        // is the one at it; a server holds no personal secret to show,
        // and a browser served by one draws no Reveal button.
        "mcpServers:revealSecret",
        "moduleSecrets:reveal",
        // The keep-or-move decision (EO-325). Machine-half because
        // what it decides is whether *this installation's* existing
        // work is handed to an organisation, which is a question about
        // the machine the work is on and one a server has no standing
        // to answer.
        "projects:keepLocal",
        "projects:moveToRecord",
        "projects:undecided",
        "runtime:cancelSignIn",
        "runtime:describe",
        "runtime:install",
        "runtime:remove",
        "runtime:removeApiKey",
        "runtime:setAutomaticUpdates",
        "runtime:setEnabled",
        "runtime:signInWithApiKey",
        "runtime:startSignIn",
        "runtime:status",
        "runtime:submitSignInCode",
        // This machine's sign-in to an organisation server (EO-323).
        // Machine-local on the sharpest grounds in the list: the address
        // is a preference of this installation, the token it earns lands
        // in this machine's keychain, and a server asked to sign in to
        // itself is a question with no answer. The *list* those three
        // reach — people, groups, devices — is in the record half, where
        // a list of people belongs.
        "session:signIn",
        "session:signOut",
        "session:status",
        // Each backend's small model (EO-477): a setting beside the CLIs
        // installed here, whose Codex default only this machine's CLI can
        // report.
        "sideCalls:setSmallModel",
        "sideCalls:smallModels",
        "sync:status",
        "updates:check",
        "updates:download",
        "updates:install",
        "updates:openReleasePage",
        "updates:status",
        "view:current",
        "view:publish",
        // The main window's own title bar (EO-668): whether that window
        // is full screen, and the colours of the controls drawn over it.
        "window:state",
        "window:titleBar",
        "worktrees:list",
        "worktrees:release",
      ].sort(),
    );
  });
});

/**
 * What an installation with no machine says when asked for one
 * (EO-319, `ARCHITECTURE.md`, "The server").
 *
 * The refusal is in core rather than in the server because two
 * independent places produce it — the server's HTTP door and the
 * renderer's own transport, which short-circuits rather than spending a
 * round trip — and the whole value of a typed refusal is that both
 * answers are one answer.
 */
describe("the refusal a server answers a machine channel with", () => {
  it("names the channel and carries a code a program can branch on", () => {
    const refusal = machineOnlyRefusal("worktrees:list");

    expect(refusal.ok).toBe(false);
    expect(refusal.error.code).toBe("machine-only");
    expect(refusal.error.message).toContain("worktrees:list");
    expect(refusal.error.message).toContain("not available on a server");
  });

  it("recognises every machine channel and no record one", () => {
    // Derived from the contract rather than from a prefix: `connectors:*`
    // has three channels in the record half and one in the machine half,
    // so anything reading the name would get that one wrong.
    for (const channel of Object.keys(machineContract)) expect(isMachineChannel(channel), channel).toBe(true);
    for (const channel of Object.keys(recordContract)) expect(isMachineChannel(channel), channel).toBe(false);
    expect(isMachineChannel("not:a-channel")).toBe(false);
    // Not answered from the prototype chain: `hasOwn` rather than `in`.
    expect(isMachineChannel("toString")).toBe(false);
  });

  it("narrows the channel it is handed", () => {
    const channel: string = "updates:install";
    if (isMachineChannel(channel)) expectTypeOf(channel).toEqualTypeOf<MachineChannel>();
  });
});

/**
 * The maximum the contract puts on a request (EO-319).
 *
 * This exists because it was got wrong twice, in the same place, each
 * time by choosing a number instead of stating a rule.
 *
 * The first was 8 MiB, picked by the server's HTTP door on the strength
 * of a comment claiming `attachments:stage` carries paths rather than
 * bytes. It carries bytes, so every attachment over about 6 MB was
 * refused 413 before a schema saw it.
 *
 * The second looked derived and was not: reading the cap off that one
 * channel made it right for attachments and still wrong for everything
 * else, because 368 request strings in the record half carry no `.max()`
 * and the arrays holding them carry no length. A schema-valid
 * `items:setOutput` could exceed the cap and be refused by a door that
 * believed it was enforcing the contract.
 *
 * The answer was not a third number. It was for the contract to have a
 * maximum at all, which `channel()` now gives every request in both
 * halves — one shared bound on all request content, covering the arrays
 * and record keys that 368 per-field bounds would still have left open.
 * These are the tests of that rule, and of the arithmetic a transport
 * needs to match it.
 */
describe("the maximum a request may be", () => {
  it("refuses a record request that is over it, whatever the field", () => {
    // The reviewer's case, and the one no per-field `.max()` covered:
    // `items:setOutput.body` is an unbounded string in the record half.
    // It is bounded now — not by a `.max()` of its own, but by the rule
    // the whole request is measured against.
    const tooBig = ipcContract["items:setOutput"].request.safeParse({
      itemId: "i1",
      body: "a".repeat(MAX_IPC_REQUEST_BYTES + 1),
    });

    expect(tooBig.success).toBe(false);
    expect(tooBig.error?.issues[0]?.message).toContain("EO carries at most");
  });

  it("refuses one that is over it only in total, with every field small", () => {
    // What a per-field bound could never have caught: nothing here is
    // individually large. An unbounded *array* of bounded strings is the
    // same hole seen from the other side.
    const story = { title: "t", body: "b".repeat(100_000), acceptance_criteria: [], touches: [], repository: null };

    const tooBig = ipcContract["work:submitPlan"].request.safeParse({
      projectId: "p",
      pipeline: "dev",
      title: "t",
      understanding: "u",
      decisions: [],
      stories: Array.from({ length: 400 }, () => ({ ...story })),
    });

    expect(tooBig.success).toBe(false);
  });

  it("carries the largest attachment the contract allows", () => {
    // And the other direction, which is the bug that started all this: a
    // payload at the limit of its own field has to go through.
    const parsed = ipcContract["attachments:stage"].request.safeParse({
      name: "big.bin",
      dataBase64: "A".repeat(MAX_ATTACHMENT_BASE64_CHARS),
    });

    expect(parsed.success).toBe(true);
  });

  it("leaves a `z.void()` channel alone", () => {
    // The rule is applied by `channel()` to every request including the
    // ones that carry nothing, so this is worth one line: `undefined` is
    // zero bytes and not a violation.
    expect(ipcRequestBytes(undefined)).toBe(0);
    expect(ipcContract["projects:list"].request.safeParse(undefined).success).toBe(true);
  });

  it("measures the bytes a transport counts, not the characters", () => {
    // The two sides have to agree in *unit* as well as in number. A door
    // counts UTF-8 off a socket; a string of `é` is one UTF-16 unit and
    // two bytes, and an emoji is two units and four. Measuring length
    // here would let the contract accept what the door then refused.
    expect(ipcRequestBytes("é")).toBe(4); // two quotes, two bytes
    expect(ipcRequestBytes("😀")).toBe(6); // two quotes, four bytes
    expect(ipcRequestBytes({ a: "b" })).toBe(JSON.stringify({ a: "b" }).length);
  });

  it("is big enough for an attachment and its envelope both", () => {
    // The headroom is not decoration: `attachments:stage` sends a name
    // and JSON punctuation alongside the base64, and a limit equal to the
    // base64 alone would refuse the largest legal file by a few bytes.
    const envelope = JSON.stringify({ name: "a".repeat(255), dataBase64: "" });

    expect(MAX_IPC_REQUEST_BYTES).toBeGreaterThan(envelope.length + MAX_ATTACHMENT_BASE64_CHARS);
  });

  it("is the base64 of the 20 MiB a file may actually be", () => {
    // `MAX_ATTACHMENT_BYTES` is in the desktop's storage layer, which
    // core cannot import — so the relationship is written down here
    // instead of being left in two files with nothing between them.
    const maxAttachmentBytes = 20 * 1024 * 1024;

    expect(MAX_ATTACHMENT_BASE64_CHARS).toBeGreaterThanOrEqual(Math.ceil(maxAttachmentBytes / 3) * 4);
  });
});

/**
 * That nothing in either half escapes the rule.
 *
 * `channel()` is the only way an entry is built, so this is true by
 * construction — and asserted anyway, because "by construction" lasted
 * exactly as long as it took somebody to read a cap off one channel and
 * call it the contract's.
 */
describe("every channel's request", () => {
  it("carries the size rule, in both halves", () => {
    // Asked of the schema rather than demonstrated with an oversized
    // payload, because there is no payload that is *declared* content on
    // all 162 channels at once — and undeclared content is stripped
    // before the rule sees it, which is the next test's subject.
    for (const channel of Object.keys(ipcContract) as IpcChannel[]) {
      const checks = (ipcContract[channel].request as unknown as { _zod: { def: { checks?: unknown[] } } })._zod.def.checks ?? [];

      expect(checks.length, channel).toBeGreaterThan(0);
    }
  });

  it("measures what it will carry, not what it was sent", () => {
    // Zod strips unknown keys, so the rule is applied to the payload a
    // handler actually receives. Padding a request with content no
    // channel declares therefore parses — the padding is gone by then.
    const padded = ipcContract["items:get"].request.safeParse({
      itemId: "i1",
      padding: "a".repeat(MAX_IPC_REQUEST_BYTES + 1),
    });

    expect(padded.success).toBe(true);
    expect(padded.data).toEqual({ itemId: "i1" });

    // Which leaves exactly one residual, written down here rather than
    // found later: the server's door counts raw bytes off the socket
    // before anything can be parsed or stripped, because a transport
    // that buffered first and measured afterwards would be a transport
    // anybody could exhaust. So a body of undeclared padding is refused
    // there with a 413 that names the limit, while this parse would have
    // accepted it. It is not reachable by sending EO's own contract:
    // every door serialises declared fields, and declared content over
    // the limit is refused identically by both.
  });
});

describe("attachment submission contracts", () => {
  const nine = Array.from({ length: 9 }, (_, index) => `attachment-${index}`);

  it("rejects more than eight attachments on every submission surface", () => {
    // `items:create` was a surface until the form that used it was
    // removed, and `discussions:send` until Discussions was (EO-526).
    expect(ipcContract["comments:post"].request.safeParse({ itemId: "item", body: "", attachmentIds: nine }).success).toBe(false);
    expect(ipcContract["scenario:send"].request.safeParse({ moduleId: "m", conversationId: null, body: "", attachmentIds: nine }).success).toBe(false);
    expect(ipcContract["scenario:send"].request.safeParse({ moduleId: "m", conversationId: null, body: "", attachmentIds: nine.slice(0, 8) }).success).toBe(true);
  });

  it("allows attachment-only comments through validation for main to persist", () => {
    expect(ipcContract["comments:post"].request.safeParse({ itemId: "item", body: "", attachmentIds: ["attachment"] }).success).toBe(true);
  });
});

/**
 * That a default stays a default.
 *
 * `IpcRequest` is what a caller must produce and `IpcPayload` is what a
 * handler is handed. They are the two sides of one schema and differ
 * only where a field carries a `.default()` — which is precisely where
 * conflating them does damage: with both defined as `z.infer`, adding
 * `.default({})` to `items:list` made a required argument out of
 * nothing and broke ten call sites that had no interest in the change.
 *
 * Type assertions rather than runtime ones because the failure is a
 * compile error, and without these the next person to collapse the two
 * would find every test still green.
 */
describe("what a caller sends and what a handler receives", () => {
  it("lets a caller omit everything a channel defaults", () => {
    expectTypeOf<undefined>().toExtend<IpcRequest<"items:list">>();
    expectTypeOf<undefined>().toExtend<IpcRequest<"inbox:list">>();
    expectTypeOf<{ pipelineId: string }>().toExtend<IpcRequest<"pipelines:export">>();
    expectTypeOf<{ runId: string }>().toExtend<IpcRequest<"runs:listEvents">>();
  });

  it("hands the handler those same fields already filled in", () => {
    // The other half. A handler that had to ask whether `fromSeq`
    // arrived would be reimplementing the default it declared.
    expectTypeOf<IpcPayload<"runs:listEvents">>().toHaveProperty("fromSeq").toEqualTypeOf<number>();
    expectTypeOf<IpcPayload<"runs:listEvents">>().toHaveProperty("limit").toEqualTypeOf<number>();
  });

  it("agrees with what the schema actually does at runtime", () => {
    // The types above are only worth having if they describe the parse.
    expect(ipcContract["items:list"].request.safeParse(undefined)).toMatchObject({ success: true, data: {} });
    expect(ipcContract["runs:listEvents"].request.safeParse({ runId: "r" })).toMatchObject({
      success: true,
      data: { fromSeq: 0, limit: 200 },
    });
  });
});

/**
 * The Jira issue key, validated in one place (EO-122).
 *
 * One schema so the submit paths and the update path cannot drift: each
 * growing its own regex is how a key comes to be accepted by
 * `work_submit_ticket` and refused by `ticket_update`.
 */
describe("JiraIssueKeySchema", () => {
  it("accepts a well-formed key and hands back the canonical spelling", () => {
    // Trimmed and upper-cased because a key is pasted more often than
    // typed, and `findByJiraKey` and `jira/pull.ts` both match exactly —
    // so what is stored has to be what Jira calls the issue.
    expect(JiraIssueKeySchema.parse("KAN-123")).toBe("KAN-123");
    expect(JiraIssueKeySchema.parse("  kan-123  ")).toBe("KAN-123");
    expect(JiraIssueKeySchema.parse("\tacme_2-4589\n")).toBe("ACME_2-4589");
    // Two characters is Jira's floor for a project key, and it has no
    // ceiling EO can know about — the maximum is a per-site setting — so
    // only the floor is enforced.
    expect(JiraIssueKeySchema.parse("ab-1")).toBe("AB-1");
    expect(JiraIssueKeySchema.parse("VERYLONGPROJECT-999999")).toBe("VERYLONGPROJECT-999999");
  });

  it("rejects anything that is not one", () => {
    // `A-1` among them: Jira will not create a one-character project
    // key, so accepting it would normalise a string into a key no site
    // could have issued.
    for (const bad of ["", "KAN", "KAN-", "-123", "123", "A-1", "a-1", "KAN 123", "KAN-12x", "1KAN-2", "KAN-1-2", "KAN--1", "KA N-1", "https://x/browse/KAN-1"]) {
      expect(JiraIssueKeySchema.safeParse(bad).success, `"${bad}" is not a Jira issue key`).toBe(false);
    }
  });

  it("explains what one looks like rather than printing a regex at somebody", () => {
    const result = JiraIssueKeySchema.safeParse("nope");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("A Jira issue key looks like KAN-123.");
  });
});

/**
 * What an item handed over from outside may say about Jira (EO-123).
 *
 * Both fields optional, and staying optional: every submission written
 * before they existed still describes work EO alone knows about, and
 * making either required would refuse it.
 */
describe("work:submitItem and Jira", () => {
  const submission = { type: "bug", title: "Importer stops", body: "b", stepsToReproduce: "s", expected: "e", actual: "a", environment: "env" };

  it("takes a submission that mentions neither field", () => {
    const parsed = ipcContract["work:submitItem"].request.safeParse(submission);

    expect(parsed.success).toBe(true);
    expect(parsed.data?.jiraKey).toBeUndefined();
    expect(parsed.data?.jiraSync).toBeUndefined();
  });

  it("takes a key and a switch, and hands the handler the canonical key", () => {
    // The same schema `itemsRepo.linkJiraKey` validates against, so a
    // key accepted here cannot be one the update path would refuse.
    const parsed = ipcContract["work:submitItem"].request.safeParse({ ...submission, jiraKey: " kan-123 ", jiraSync: false });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.jiraKey).toBe("KAN-123");
    expect(parsed.data?.jiraSync).toBe(false);
  });

  it("refuses something that is not a Jira key at the boundary", () => {
    const parsed = ipcContract["work:submitItem"].request.safeParse({ ...submission, jiraKey: "https://acme.atlassian.net/browse/KAN-1" });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toContain("A Jira issue key looks like KAN-123.");
  });
});

/**
 * What an edit may say about Jira (EO-125).
 *
 * The half that makes the setting a setting rather than a submit-time
 * decision. Both fields optional, so every edit written before them
 * still parses — and `jiraKey` deliberately *not* validated here, so
 * that all three of its refusals reach the caller the same way.
 */
describe("items:update and Jira", () => {
  it("takes an edit that mentions neither field", () => {
    const parsed = ipcContract["items:update"].request.safeParse({ itemId: "t1", title: "Renamed" });

    expect(parsed.success).toBe(true);
    expect(parsed.data && "jiraKey" in parsed.data).toBe(false);
    expect(parsed.data?.jiraSync).toBeUndefined();
  });

  it("tells an omitted key apart from one that is explicitly null", () => {
    // The whole distinction the detach path runs on: absent leaves the
    // link alone, `null` takes it away. A schema that collapsed the two
    // would unlink an item every time somebody renamed it.
    expect(ipcContract["items:update"].request.safeParse({ itemId: "t1", jiraKey: null }).data?.jiraKey).toBeNull();
    expect(ipcContract["items:update"].request.safeParse({ itemId: "t1" }).data?.jiraKey).toBeUndefined();
  });

  it("passes a key that is not one through, so the handler can answer with a problem", () => {
    // Unlike `work:submitItem`, whose one key is the whole submission.
    // An edit carries a title and a body too: refusing the payload here
    // would answer `Invalid request payload` for the malformed key and
    // a named `problem` for the two refusals the database has to find,
    // so one of the three would arrive differently from its siblings.
    // The same correction EO-124 made to a plan's keys.
    const parsed = ipcContract["items:update"].request.safeParse({ itemId: "t1", jiraKey: "not-a-key" });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.jiraKey).toBe("not-a-key");
  });

  it("answers an edit with why it changed nothing", () => {
    const parsed = ipcContract["items:update"].response.safeParse({ updated: false, problem: "SVC-2 is already linked to KAN-1." });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.problem).toBe("SVC-2 is already linked to KAN-1.");
  });
});

/**
 * What a plan handed over from outside may say about Jira (EO-124).
 *
 * The feature's key is the plan's; each story carries its own. Both
 * optional at every level, and staying optional: a plan for work Jira
 * has never heard of is the ordinary one, and every plan written before
 * these fields existed still parses.
 */
describe("work:submitPlan and Jira", () => {
  const submission = {
    title: "Rate limit the importer",
    understanding: "We agreed to cap it.",
    stories: [{ title: "Cap it", body: "b", acceptance_criteria: ["it caps"] }],
  };

  it("takes a plan that mentions no Jira at all", () => {
    const parsed = ipcContract["work:submitPlan"].request.safeParse(submission);

    expect(parsed.success).toBe(true);
    expect(parsed.data?.jiraKey).toBeUndefined();
    expect(parsed.data?.jiraSync).toBeUndefined();
    expect(parsed.data?.stories[0]?.jira_key).toBeUndefined();
  });

  it("takes the feature's key, the plan's switch, and a key per story", () => {
    const parsed = ipcContract["work:submitPlan"].request.safeParse({
      ...submission,
      jiraKey: "KAN-10",
      jiraSync: false,
      stories: [{ ...submission.stories[0], jira_key: "KAN-11", jira_sync: true }],
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.jiraKey).toBe("KAN-10");
    expect(parsed.data?.jiraSync).toBe(false);
    expect(parsed.data?.stories[0]?.jira_key).toBe("KAN-11");
    expect(parsed.data?.stories[0]?.jira_sync).toBe(true);
  });

  it("passes a key that is not one through, so the handler can answer with a problem", () => {
    // Unlike `work:submitItem`, whose one key is the whole submission:
    // a plan's keys are refused three ways, and only the format is
    // visible from a schema. Refusing it here would answer one of the
    // three with `Invalid request payload` while the other two come back
    // as the `problem` the channel documents, so the format check lives
    // with the other two instead.
    for (const payload of [
      { ...submission, jiraKey: "KAN" },
      { ...submission, stories: [{ ...submission.stories[0], jira_key: "KAN" }] },
    ]) {
      expect(ipcContract["work:submitPlan"].request.safeParse(payload).success).toBe(true);
    }
  });
});

/**
 * The channels that say which device is asking (EO-324, ARCHITECTURE.md, "The record").
 *
 * The list is what `server/http.ts` stamps an authenticated identity
 * onto, and the failure it guards against is not a typo: a channel that
 * carried `deviceId` and was left off it would go on believing whatever
 * a client wrote there — which is any signed-in device claiming
 * another's work and signing another's transcript.
 *
 * So both directions are checked. An entry that has no such field is an
 * entry describing a channel that no longer exists in that shape; a
 * record channel that *has* one and is missing from the list is the
 * dangerous half, and the one a person adding a channel will hit.
 */
describe("the channels bound to the asking device", () => {
  const namesADevice = (channel: keyof typeof ipcContract): boolean =>
    ipcContract[channel].request.safeParse({}).error?.issues.some((issue) => issue.path[0] === "deviceId") === true;

  it("names a device on every channel it lists", () => {
    expect(DEVICE_SCOPED_CHANNELS.filter((channel) => !namesADevice(channel))).toEqual([]);
  });

  it("lists every record channel that acts as one", () => {
    // Scoped to `record:`, and the exclusion is the point rather than a
    // convenience. `devices:revoke` carries a `deviceId` too and is
    // deliberately *not* here: it names a device as the thing being
    // acted on — an admin turning somebody's laptop out — where these
    // four name the device doing the acting. Stamping the caller's own
    // id over that one would turn "revoke Anna's machine" into "revoke
    // mine", which is a different instruction and a worse bug than the
    // one being guarded against.
    //
    // So the rule is about the `record:` half, where a `deviceId` is
    // always the subject, and a new channel there that names one has to
    // be listed or this fails.
    const acting = (Object.keys(recordContract) as (keyof typeof recordContract)[]).filter(
      (channel) => channel.startsWith("record:") && namesADevice(channel),
    );

    expect(acting.filter((channel) => !isDeviceScopedChannel(channel))).toEqual([]);
    expect(acting.length).toBe(DEVICE_SCOPED_CHANNELS.length);
  });

  it("leaves alone a channel that names a device as the thing being acted on", () => {
    // The admin's revoke, which must keep the id it was given.
    expect(isDeviceScopedChannel("devices:revoke")).toBe(false);
    expect(withDeviceIdentity("devices:revoke", { deviceId: "annas-laptop" }, "danas-laptop")).toEqual({ deviceId: "annas-laptop" });
  });

  it("replaces what a caller sent rather than trusting it", () => {
    const stamped = withDeviceIdentity("record:work", { deviceId: "somebody-else", capacity: 1 }, "the-caller");

    expect(stamped).toEqual({ deviceId: "the-caller", capacity: 1 });
    // And leaves alone the channels that name no device: a pull is not
    // an identity claim, and rewriting one would be inventing a field.
    expect(withDeviceIdentity("record:changes", { limit: 5 }, "the-caller")).toEqual({ limit: 5 });
  });
});

/**
 * The channels answered on behalf of a person (EO-326,
 * `ARCHITECTURE.md`, "Identity").
 *
 * `DEVICE_SCOPED_CHANNELS`' argument one door along, and the failure it
 * guards against is the same shape and worse. A channel that declared
 * `actingDeviceId` and was left off this list would go on believing
 * whatever a client wrote in it — which is any signed-in device reading
 * another person's inbox, listing projects it is not on, and filing a
 * decision under somebody else's name, from a token that is perfectly
 * valid for itself.
 *
 * Both directions again: an entry whose channel no longer declares the
 * field is stale, and a channel that declares it and is not listed is
 * the dangerous half.
 */
describe("the channels answered on behalf of a person", () => {
  // Asked by sending the wrong type for it, rather than by reading
  // `.shape`: three of these channels default an absent payload, which
  // wraps the object in a `ZodDefault` that has no shape to read. A
  // channel that declares the field complains about *this* field; one
  // that does not strips the key silently, which is Zod's rule for
  // anything it was not told about.
  const namesAnActor = (channel: keyof typeof ipcContract): boolean =>
    ipcContract[channel].request.safeParse({ actingDeviceId: 7 }).error?.issues.some((issue) => issue.path[0] === "actingDeviceId") === true;

  it("declares the field on every channel it lists", () => {
    expect(ACTOR_SCOPED_CHANNELS.filter((channel) => !namesAnActor(channel))).toEqual([]);
  });

  it("lists every channel that declares it", () => {
    const declaring = (Object.keys(ipcContract) as IpcChannel[]).filter(namesAnActor);

    expect(declaring.filter((channel) => !isActorScopedChannel(channel))).toEqual([]);
    expect(declaring.length).toBe(ACTOR_SCOPED_CHANNELS.length);
  });

  it("is a record-half concept, because only a record has callers", () => {
    // A machine channel is answered by the machine somebody is sitting
    // at, where the caller is the person at the keyboard. Stamping one
    // would be asking a laptop which of its users was asking.
    expect(ACTOR_SCOPED_CHANNELS.filter(isMachineChannel)).toEqual([]);
  });

  it("replaces what a caller sent rather than trusting it", () => {
    expect(withActingDevice("inbox:list", { projectId: null, actingDeviceId: "somebody-else" }, "the-caller")).toEqual({
      projectId: null,
      actingDeviceId: "the-caller",
    });
  });

  it("stamps null rather than leaving the field out, for a key that is not a device", () => {
    // The distinction the operator's key turns on. Absent means "no door
    // was crossed", which is a desktop and resolves to the local person;
    // null means "a door was crossed by something that is not a person".
    // A door that left it absent would hand a server's own local-person
    // row an inbox and a name on a transition.
    expect(withActingDevice("people:me", undefined, null)).toEqual({ actingDeviceId: null });
    expect(withActingDevice("projects:list", {}, null)).toEqual({ actingDeviceId: null });
  });

  it("leaves alone a channel that is nobody's in particular", () => {
    expect(withActingDevice("items:get", { itemId: "an-item" }, "the-caller")).toEqual({ itemId: "an-item" });
  });

  it("carries a person's id as the thing being acted on, not as the caller", () => {
    // `items:assign` names two people and they are different people:
    // `personId` is who is being handed the work, and the caller is who
    // is handing it over. Stamping over the first would turn "give this
    // to Anna" into "give this to me".
    const stamped = withActingDevice("items:assign", { itemId: "an-item", personId: "anna" }, "danas-browser");

    expect(stamped).toEqual({ itemId: "an-item", personId: "anna", actingDeviceId: "danas-browser" });
  });
});

/**
 * The channels a system agent can act on in its own name (EO-585).
 *
 * Stamped only by EO's administrative MCP host, from the credential a
 * system agent's turn holds; every other door strips it. Held both
 * directions, as the person's list above is.
 */
describe("the channels a system agent acts on as itself", () => {
  const namesAnAgent = (channel: keyof typeof ipcContract): boolean =>
    ipcContract[channel].request.safeParse({ actingAgentId: 7 }).error?.issues.some((issue) => issue.path[0] === "actingAgentId") === true;

  it("declares the field on exactly the channels it lists", () => {
    const declaring = (Object.keys(ipcContract) as IpcChannel[]).filter(namesAnAgent);
    expect([...declaring].sort()).toEqual([...AGENT_ACTED_CHANNELS].sort());
  });

  it("takes off what a caller sent, and puts back only the agent the door names", () => {
    expect(withActingAgent("items:decide", { itemId: "an-item", actingAgentId: "a-claim" }, undefined)).toEqual({ itemId: "an-item" });
    expect(withActingAgent("items:decide", { itemId: "an-item", actingAgentId: "a-claim" }, "the-agent")).toEqual({ itemId: "an-item", actingAgentId: "the-agent" });
  });

  it("stamps no agent on a channel no agent acts on", () => {
    expect(withActingAgent("items:move", { itemId: "an-item" }, "the-agent")).toEqual({ itemId: "an-item" });
    expect(isAgentActedChannel("items:move")).toBe(false);
    expect(withActingAgent("people:me", undefined, "the-agent")).toBeUndefined();
  });
});

/**
 * One rule for a priority, at every door that writes one (EO-568): an
 * integer, 0 or more. Optional on each, so a payload written before the
 * field existed still parses.
 */
describe("priority on the channels that write one", () => {
  const item = { type: "story", title: "Cap it", body: "b", acceptanceCriteria: ["it caps"] };
  const story = { title: "Cap it", body: "b", acceptance_criteria: ["it caps"] };
  const plan = { title: "Rate limit the importer", understanding: "We agreed to cap it.", stories: [story] };

  const accepts = [
    ["work:submitItem", { ...item, priority: 2 }],
    ["work:submitPlan", { ...plan, priority: 1, stories: [{ ...story, priority: 2 }] }],
    ["items:update", { itemId: "i", priority: 5 }],
  ] as const;

  it.each(accepts)("accepts one on %s", (channel, payload) => {
    expect(ipcContract[channel].request.safeParse(payload).success).toBe(true);
  });

  it.each([
    ["work:submitItem", item],
    ["work:submitPlan", plan],
  ] as const)("leaves %s without one at no priority, for the handler to make 0", (channel, payload) => {
    const parsed = ipcContract[channel].request.safeParse(payload);

    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("priority");
  });

  it.each([
    ["work:submitItem", { ...item, priority: -1 }],
    ["work:submitItem", { ...item, priority: 1.5 }],
    ["work:submitPlan", { ...plan, priority: -1 }],
    ["work:submitPlan", { ...plan, stories: [{ ...story, priority: 0.5 }] }],
    ["items:update", { itemId: "i", priority: -1 }],
  ] as const)("refuses a negative or fractional one on %s", (channel, payload) => {
    expect(ipcContract[channel].request.safeParse(payload).success).toBe(false);
  });
});
