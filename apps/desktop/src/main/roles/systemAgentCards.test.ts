import { describe, expect, it } from "vitest";
import { loadRolePrompt } from "./prompts.js";

/**
 * What the system agent is taught about the four things only a person
 * may do with a pipeline (EO-521): export it, import a file, delete it,
 * and discard this machine's edits to one the organisation manages.
 *
 * Held here because the prompt is the only place the agent learns the
 * cards exist and when to offer each. Before this it was told the button
 * for discarding was on the configuration screen — which is going — and
 * it holds `pipeline_delete` and `pipeline_import` among its tools, so a
 * prompt that did not say otherwise would have it write round the card.
 */

const prompt = loadRolePrompt("system")!;
const flat = prompt.replace(/\s+/g, " ");

/** A section, from its heading to the next heading of any depth, with its whitespace flattened. */
function section(heading: string): string {
  const start = prompt.indexOf(heading);
  expect(start).toBeGreaterThan(-1);
  const next = /\n#{1,3} /.exec(prompt.slice(start + 1));
  return (next ? prompt.slice(start, start + 1 + next.index) : prompt.slice(start)).replace(/\s+/g, " ");
}

describe("what the system agent's prompt says about cards for what only a person may do", () => {
  const cards = () => section("### Cards for what only a person may do");

  it("names the route among the ways it changes anything", () => {
    expect(section("## How you change anything")).toContain("**What only a person may do is a card with its button on it.**");
    expect(section("## How you change anything")).toContain("see **Cards for what only a person may do**");
  });

  it("gives each card's shape and says when to offer it", () => {
    expect(cards()).toContain('`{ "kind": "pipelineExport", "pipelineId": "…" }`');
    expect(cards()).toContain("Offer it when somebody wants a pipeline as a file");
    expect(cards()).toContain('`{ "kind": "pipelineImport", "attachmentId": "…" }`');
    expect(cards()).toContain("Only a file attached to this chat");
    expect(cards()).toContain('`{ "kind": "pipelineDelete", "pipelineId": "…" }`');
    expect(cards()).toContain("Offer it when somebody asks for a pipeline to be deleted");
    expect(cards()).toContain('`{ "kind": "pipelineDiscardEdits", "pipelineId": "…" }`');
    expect(cards()).toContain("Only for a pipeline the organisation manages whose copy here is **edited locally**");
  });

  it("says what each card shows before it is pressed", () => {
    expect(cards()).toContain("asks about every module the file shares a slug with");
    expect(cards()).toContain("says how many items the pipeline holds and that it goes to the Archive");
    expect(cards()).toContain("The card says those updates resume once it is pressed.");
  });

  it("says nothing happens until the person presses it, once, and that the agent does none of it itself", () => {
    expect(cards()).toContain("Nothing is exported, imported, archived or discarded until they do");
    expect(cards()).toContain("each card is pressed once");
    expect(cards()).toContain("**never import it with `pipeline_import`**");
    expect(cards()).toContain("**Never delete it with `pipeline_delete`**");
    expect(cards()).toContain("never say it is done");
  });

  it("no longer sends the person to a configuration screen to discard their edits", () => {
    expect(flat).not.toContain("the button for it is on their configuration screen");
    expect(section("### A section the organisation manages")).toContain("offer the card whose button does it");
    expect(section("### A section the organisation manages")).toContain("no tool of yours can");
  });

  it("says a card comes on its own", () => {
    expect(cards()).toContain("`card` comes on its own — no `draft`, `modules`, `change` or `proposals` beside it");
  });

  it("is a new version of the prompt", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(25);
  });
});

describe("what the system agent's prompt says about the settings that are a person's (EO-522)", () => {
  const cards = () => section("### Cards for what only a person may do");

  it("names them among what only a person may do", () => {
    expect(section("## How you change anything")).toContain("letting a pipeline's webhook items reach a sending step unread");
    expect(section("## How you change anything")).toContain("setting or clearing a step's own secret or environment variable");
  });

  it("gives the webhook card's shape, says it is a risk only a person may accept, and that pipeline_save refuses it", () => {
    expect(cards()).toContain('`{ "kind": "pipelineWebhookUnattended", "pipelineId": "…", "unattended": true }`');
    expect(cards()).toContain("It is a risk only a person may accept");
    expect(cards()).toContain("`pipeline_save` refuses a graph carrying `webhookUnattended`; the card is the only way.");
  });

  it("gives the step cards' shape, and says the person types the value on the card and the agent never sees it", () => {
    expect(cards()).toContain('`{ "kind": "stepSecret", "stepId": "…", "name": "…", "action": "set" }`');
    expect(cards()).toContain('`"stepVariable"`');
    expect(cards()).toContain("**The person types the value on the card**");
    expect(cards()).toContain("you never see it, so never ask for it in the chat");
    expect(cards()).toContain("The card says whether the step already has a value of its own, never what it is");
    expect(cards()).toContain("`environment_variables_list` names a step's own variables without their values");
    expect(cards()).toContain("a step's own value is the card's to set");
  });

  it("is a newer version than the one that taught the first four cards", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(26);
  });
});

describe("what the system agent's prompt says about item types (EO-523)", () => {
  const cards = () => section("### Cards for what only a person may do");

  it("names them among what only a person may do", () => {
    expect(section("## How you change anything")).toContain("adding, changing or removing an item type are each returned as `card`");
  });

  it("describes the read tool: each type's fields, and whether a pack ships it", () => {
    expect(cards()).toContain("Read a project's types with `item_types_list` first");
    expect(cards()).toContain("its fields, and **whether a pack ships it**");
  });

  it("gives the three cards' shapes, with null for what a change leaves as it is", () => {
    expect(cards()).toContain('`{ "kind": "itemTypeCreate", "projectId": "…", "label": "Case", "plural": "Cases", "container": false, "fields": [');
    expect(cards()).toContain('`{ "kind": "itemTypeUpdate", "itemTypeId": "…", "label": "…", "plural": null, "container": null, "fields": null }`');
    expect(cards()).toContain('`{ "kind": "itemTypeDelete", "itemTypeId": "…" }`');
    expect(cards()).toContain("`null` to leave it as it is");
  });

  it("says a pack's type can be renamed and take optional fields of the project's own, and that a refusal is shown on the card", () => {
    expect(cards()).toContain("**A pack's type can be renamed, and can take optional fields of the project's own**");
    expect(cards()).toContain("each with `\"required\": false`");
    expect(cards()).toContain("the card shows that refusal in place of its button");
    expect(cards()).toContain("No tool adds, changes or removes a type; the card is the only way.");
  });

  it("is a newer version than the one that taught the settings' cards", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(27);
  });
});

describe("what the system agent's prompt says about a held template update (EO-534)", () => {
  const held = () => section("### A held template update");
  const cards = () => section("### Cards for what only a person may do");

  it("explains what an update conflict is and that nothing of a held update is applied", () => {
    expect(held()).toContain("remembers the version it came from — its *base*");
    expect(held()).toContain("**nothing** from that version is applied, not even the parts that do not conflict");
    expect(held()).toContain("**Fix with assistant**");
  });

  it("says to read the conflict with pipeline_update_conflict first, named by its server and not by any backend's spelling", () => {
    expect(held()).toContain("**Read the conflict first.** Call `pipeline_update_conflict`, on the MCP server EO registers as `eo_admin`");
    expect(held()).toContain("the person's own edits since the base");
    expect(held()).not.toMatch(/mcp__|eo_admin\//);
  });

  it("asks it to keep both intents, using the release notes for the template's", () => {
    expect(held()).toContain("**Keep both intents.**");
    expect(held()).toContain("the release notes say what the template's change is for");
  });

  it("allows at most three options, recommended first, each saying in one line what it keeps, with take-the-template and keep-mine among them", () => {
    expect(held()).toContain("**Offer at most three options, the one you recommend first.**");
    expect(held()).toContain("`alternatives` holds up to two more drafts of the same pipeline");
    expect(held()).toContain("**one line** saying what it keeps from the person's version and what from the template's");
    expect(held()).toContain("a plain **take the template** option");
    expect(held()).toContain('a plain **keep mine** option: the card `{ "kind": "pipelineKeepMine", "pipelineId": "…" }`');
    expect(held()).toContain("That is three at most, the Keep card included");
  });

  it("requires every draft to validate, and never applies anything", () => {
    expect(held()).toContain("**Every draft must validate.** Check each one with `pipeline_validate`");
    expect(held()).toContain("**Never apply anything.** Not with `pipeline_save`");
  });

  it("gives EO's own Delivery as the worked example of the recommendation", () => {
    expect(held()).toContain("`opened` → Watching pull request, and its `ready` → `merge_pr`, with `reportReady` on");
    // Ready is reachable where nobody approves on the forge, which is EO's case.
    expect(held()).toContain('`{ "reportReady": true, "readyWhen": "mergeable" }`');
  });

  it("says a fresh id for a template's step is named in templateStepIds, so the next version still knows it", () => {
    expect(held()).toContain("say which template step it is in the draft's `templateStepIds`");
  });

  it("lists the Keep my pipeline card among the cards, the one that may come beside a draft", () => {
    expect(cards()).toContain('**Keep my pipeline** — `{ "kind": "pipelineKeepMine", "pipelineId": "…" }`');
    expect(cards()).toContain("The one exception is Keep my pipeline, which comes beside the drafts resolving a held template update.");
    expect(section("## How you change anything")).toContain("so is keeping a pipeline as it is and skipping a held template update");
  });

  it("is a newer version than the one before held template updates", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(30);
  });
});

describe("what the system agent's prompt says about the publish card after trials (EO-588)", () => {
  it("lists the card, and says when it is offered and that it comes alone", () => {
    expect(section("### Cards for what only a person may do")).toContain('**Publish a tested draft** — `{ "kind": "trialPublish" }`');
    const done = section("### Testing a draft with real runs");
    expect(done).toContain('return the publish card, `{ "kind": "trialPublish" }`, on its own, with no draft');
    expect(done).toContain("Never call a mocked step tested.");
    expect(done).toContain("say plainly which test items did not end where they were expected to");
  });

  it("is a newer version than the one before the publish card", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(36);
  });
});

describe("what the entry step needs (EO-610)", () => {
  const needs = (): string => section("### What the entry step needs");

  it("is under Pipeline drafts, ahead of how a graph is routed", () => {
    expect(prompt.indexOf("## Pipeline drafts")).toBeLessThan(prompt.indexOf("### What the entry step needs"));
    expect(prompt.indexOf("### What the entry step needs")).toBeLessThan(prompt.indexOf("### Results and routes"));
  });

  it("has the assistant work out what the entry step needs whenever it designs or changes a pipeline, and say why", () => {
    expect(needs()).toContain("When you design or change a pipeline, work out what its entry step needs in order to start without stopping to ask");
    expect(needs()).toContain("propose entry rules for exactly that, in `entryRules` on the draft");
    expect(needs()).toContain("Say why in a sentence");
  });

  it("holds it back from guessing, repeating a type's requirements and asking for what nothing needs", () => {
    expect(needs()).toContain("ask the person rather than guessing");
    expect(needs()).toContain("Do not restate what an item type already requires");
    expect(needs()).toContain("Propose none where nothing is needed");
  });

  it("leaves it to the person, as with any draft", () => {
    expect(needs()).toContain("Nothing takes effect until the person publishes, as with any draft");
  });
});

describe("what the system agent's prompt says about jobs (EO-786)", () => {
  const cards = () => section("### Cards for what only a person may do");

  it("names them among what only a person may do", () => {
    expect(section("## How you change anything")).toContain("So are creating, changing and deleting a job, and a webhook job's new secret and test event.");
  });

  it("says to read the jobs first, and that no tool writes one", () => {
    expect(cards()).toContain("**Read the jobs with `jobs_list` or `job_get` first**");
    expect(cards()).toContain("You have no tool that writes a job; the card is the only way.");
  });

  it("gives the four cards' shapes, with null for what a change leaves and \"none\" to clear a limit", () => {
    expect(cards()).toContain('`{ "kind": "jobCreate", "projectId": "…", "name": "Monday report", "trigger": { "kind": "schedule"');
    expect(cards()).toContain('`{ "kind": "jobUpdate", "jobId": "…", "name": null, "trigger": null');
    expect(cards()).toContain("`\"none\"` removes a budget or a cap");
    expect(cards()).toContain('`{ "kind": "jobDelete", "jobId": "…" }`');
    expect(cards()).toContain('`{ "kind": "jobWebhook", "jobId": "…", "action": "regenerateSecret" }`');
    expect(cards()).toContain("the old one stops working the moment the button is pressed");
    expect(cards()).toContain("**A webhook job's signing secret is in no card, answer or chat message**");
  });

  it("no longer says it has no tool for jobs, or sends the person to the Jobs screen", () => {
    expect(flat).not.toContain("you have no tool that creates jobs");
    expect(flat).not.toContain("A watch intake is set up on the Jobs screen");
    expect(flat).not.toContain("add a watch job there");
    expect(section("### Modules, and when to reach for one instead of an agent")).toContain("offer a `jobCreate` card with a `watch` trigger");
  });

  it("is a newer version than the one before job cards", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(56);
  });
});

describe("what the system agent's prompt says about command-line tools (EO-822)", () => {
  const cards = () => section("### Cards for what only a person may do");

  it("names them among what only a person may do", () => {
    expect(section("## How you change anything")).toContain(
      "So are adding a command-line tool to the catalogue and giving one to an agent or taking it away.",
    );
  });

  it("says to read the catalogue first, and that no tool of its own writes or attaches a CLI", () => {
    expect(cards()).toContain("**Read the catalogue with `cli_tools_list` first**");
    expect(cards()).toContain("you have no tool that adds, changes, archives or attaches a CLI — `agent_attachments_set` refuses one from you — and the card is the only way.");
  });

  it("gives the two cards' shapes, and says a CLI grants nothing", () => {
    expect(cards()).toContain('`{ "kind": "cliToolAdd", "name": "GitHub CLI", "command": "gh", "description": "Pull requests, issues and checks on GitHub." }`');
    expect(cards()).toContain('`{ "kind": "cliToolAttach", "agentId": "…", "cliToolId": "…", "attached": true }`');
    expect(cards()).toContain("A CLI grants nothing: an agent runs it through the shell it already has");
  });

  it("is a newer version than the one before CLI cards", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(58);
  });
});

describe("what the system agent's prompt says about report-only teams (EO-848)", () => {
  const teams = () => section("### A report-only team on an agent step");

  it("offers `team` on a draft's agent step, and `\"none\"` for one agent again", () => {
    expect(flat).toContain("- **An `agent` step may set `team`** — the report-only team it runs as,");
    expect(teams()).toContain("A team is configured only through a draft and published from its card; `pipeline_save` takes the key off.");
  });

  it("says every member is report-only, and what it cannot do", () => {
    expect(teams()).toContain("posts an attributed report on the thread, and cannot edit the work, run commands, change anything outside EO or widen what it may use.");
  });

  it("gives both coordination modes, their completion and limits", () => {
    expect(teams()).toContain('"coordination": "independent"');
    expect(teams()).toContain('"coordination": "leader"');
    expect(teams()).toContain("A required participant that could not contribute fails the team");
    expect(teams()).toContain("Left out they are 4, 2, 1 and 2.");
  });

  it("sends an independent team to the action catalogue, and to a custom action of its own rather than a pack's", () => {
    expect(teams()).toContain("read the actions with `registry_get`");
    expect(teams()).toContain("carry a definition of your own in `actions` beside the draft");
    expect(teams()).toContain("never point the team at a pack's action");
  });

  it("says what is refused before a card, that live work keeps its version, and how a mocked team is reported on a trial", () => {
    expect(teams()).toContain("**What is refused**, and named, before a card is offered");
    expect(teams()).toContain("**Publishing a team files a new version.**");
    expect(teams()).toContain("do not report the team as tested from a mocked result.");
  });

  it("is a newer version than the one before teams were drafted", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(60);
  });
});
