import { ipcContract, machineContract, recordContract, type IpcChannel, type MachineChannel, type RecordChannel } from "@eo/core";
import { describe, expect, it } from "vitest";
import { describeAgentRemoval, TOOLS } from "./catalog.js";
import { toolsFor } from "./gate.js";
import { GUIDES } from "./guides.js";
import { renderGuards, renderProjects } from "./render.js";
import { SERVER_INSTRUCTIONS } from "./server.js";

/**
 * Not catalogued, and the decision that says so.
 *
 * This list is the point of the whole file. `ipcContract` is EO's
 * capability inventory, so a channel that is neither offered as a tool
 * nor written down here is a capability nobody decided about — and the
 * way that happens is somebody adding a channel and never thinking about
 * MCP at all. Subtracting the catalog from the contract and comparing
 * the remainder against this literal makes the decision compulsory: add
 * a channel and this test fails until a line appears below saying which
 * bucket it belongs in.
 *
 * A reason has to be a *decision*. Twenty of these once said "pending",
 * which satisfied the sweep while meaning "not done yet", and the
 * channels behind that word stayed unoffered for as long as nobody
 * happened to ask for one — the list said everything had been considered
 * when half of it had only been deferred. So the reasons are checked
 * too, below: a placeholder is refused, and what is left has to be
 * something that will still be true next year rather than a note to
 * come back.
 *
 * In two halves since KAN-127, keyed by `RecordChannel` and
 * `MachineChannel` so that which half a channel is in is the compiler's
 * answer rather than this file's. This one is the record half: nothing
 * here is refused because of where EO is running, so an organisation
 * server that implements the record half and none of the machine half
 * (ARCHITECTURE.md, "Where the seams are") inherits exactly these
 * judgements. Writing a machine channel into it will not compile.
 *
 * It is reachable.test.ts's idea pointed the other way. That one proves
 * nothing in the contract is unreachable from the UI; this one proves
 * nothing in the contract is unconsidered from MCP.
 */
const NOT_CATALOGUED: Partial<Record<RecordChannel, string>> = {
  // What the organisation published, and the two writes that publish it
  // (EO-329). Publishing is an act on the record, performed by an admin
  // in a browser the server serves; the system agent runs on a desktop,
  // where the record is somewhere else and both writes are refused at
  // the server's door as admin-only regardless. A tool for them would be
  // a tool that cannot work from where the only agent holding it stands.
  //
  // The read is excluded for a plainer reason: an agent learns a section
  // is managed by being refused, in a sentence that names the section
  // and says to stop (`sectionLockedMessage`). A list of locks it could
  // consult first would be a second account of the same fact, able to be
  // a page out of date at exactly the moment it mattered.
  // Which backend and model an agent runs on is this machine's own
  // (EO-329, ARCHITECTURE.md, "An agent is a row") — the person's choice between the CLIs they have
  // installed and signed in to. An agent able to write it would be
  // moving itself, or another agent, onto a backend nobody at this
  // keyboard chose, and `agent_save` already offers the half that is
  // the organisation's or the person's to edit rather than the
  // machine's.
  "agents:setBinding": "which backend a machine runs an agent on is the person at that machine's choice, not an agent's",
  // A project's own agents (EO-475). `agent_save` already takes a
  // `projectId` and `agent_attachments_set` a tick, which is the whole
  // of a copy; the copy is one command for the Agents screen's sake, so
  // that a person's click cannot leave a project an agent without its
  // tools. The staffing summary is a project's settings drawing the
  // staffing rule for the person deciding whether the project needs an
  // agent of its own — the scheduler applies the rule itself, and no
  // agent's work waits on reading it.
  "agents:customise": "a screen's one-click copy of what agent_save and agent_attachments_set already do between them",
  "projects:staffing": "a project's settings drawing the staffing rule for a person; dispatch applies the rule and needs nobody to read it",
  "sections:list": "an agent learns a section is managed from the refusal that names it, not from a list it polls",
  // Suggesting a change *is* offered — `pipeline_suggest`, which is the
  // move the refusal above now points at (EO-331). These four are the
  // rest of that story, and each is out for its own reason.
  //
  // The two reads are screens rather than work: "is this machine's copy
  // edited locally" draws a line and a chip, and the suggestion review
  // is a diff, a needs list and two buttons for the administrator
  // deciding. An agent that polled either would be reading a screen,
  // and `pipeline_versions` already answers the only question about a
  // graph an agent has business asking.
  "pipelines:divergence": "a line and a chip on this machine's own screens, not a fact an agent acts on",
  "roleActions:inspect":
    "the agent screen's read of one action: the provider schema drawn for a person, and the routed keys behind its warning before a save. An agent reads the catalog and each action's uses from registry_get and a pipeline's routes from pipeline_get",
  "suggestions:detail": "the administrator's review screen — a diff and two buttons for the person deciding",
  // Discarding is destructive in the one direction nothing else here
  // is: it throws away edits that exist on no other machine and in no
  // version history, because a diverged copy files none. A person who
  // spent an afternoon on a graph may decide that; an agent tidying up
  // after a refusal must not be able to.
  "pipelines:discardEdits": "throws away local edits that exist nowhere else — the person's decision, never an agent's",
  // The record's own end of `pipeline_suggest`. It is the server half
  // of a channel already offered, reached by the desktop on the
  // person's behalf, and an agent given it directly could file a
  // suggestion in somebody else's name from a machine that diverged
  // nothing.
  "suggestions:create": "the server half of pipeline_suggest, which a desktop sends on the person's behalf",
  "sections:publish": "publishing is the administrator's act on the record, and a desktop agent is refused it at the door",
  "sections:publishPreflight": "the count behind a publish is for the administrator deciding to publish, which an agent never is",

  // The organisation's list (EO-323, ARCHITECTURE.md, "Identity").
  //
  // Out as a set, on invariant 11. Who is on an organisation's list, who
  // may administer it and which machines hold a key to it is the
  // person's authority — delegated to EO's own system agent through
  // `eo_admin` if to anything at all, never to whatever editor happens
  // to have connected to this installation's MCP server. An agent that
  // could invite would be adding a colleague; one that could revoke
  // would be cutting a machine off; one that could set the admin flag
  // would be granting itself the other two through a person's account.
  //
  // The two reads go with the writes rather than being offered alone. A
  // list of an organisation's staff and their email addresses, and a
  // list of the machines they work from with when each was last seen, is
  // exactly the reconnaissance a compromised client would want, and
  // nothing an agent doing EO's work needs: a dispatch is told who it is
  // acting for, and `ticket_get` carries the assignee.
  "people:list": "an organisation's staff list is the person's, not an agent's to enumerate",
  // Who is asking, and what is waiting on everybody (EO-326, ARCHITECTURE.md, "Identity").
  //
  // `people:me` answers about *the caller*, and an agent reached through
  // the MCP host is not one: its request carries no credential of its
  // own, so the honest answer would be the person whose machine it is
  // running on — which is telling an agent who its operator is, in a
  // tool, for nothing it needs. A dispatch is already told who it is
  // acting for.
  //
  // `mentions:open` is the reconnaissance the two lists above are kept
  // out for, in one call: every unanswered question on the record, who
  // asked it and who it waits on, across every project. It exists for a
  // person reading an organisation, and its scoping is a *visibility*
  // rule rather than an access boundary — which is exactly why it must
  // not be handed to a client whose transcript leaves the machine.
  "people:me": "answers about the caller, and an agent reached through this host is not one",
  "mentions:open": "every open question on the record, with the person each waits on — reconnaissance rather than work",
  "people:invite": "adding somebody to the organisation is the person's authority, delegated to eo_admin if to anything (invariant 11)",
  "people:setAdmin": "granting the flag that grants everything else",
  "devices:list": "which machines hold a key, and when each was last seen, is reconnaissance rather than work",
  "devices:revoke": "cutting a colleague's machine off mid-run is not an agent's decision",
  "groups:save": "who is in a team decides who work is offered to",
  "groups:delete": "and deleting one silently unnames every step that waited on it",
  // Who waits at a human step (EO-323). Refused on the same grounds
  // `items:assign` is: who holds a piece of work is not a thing a client
  // decides on a person's behalf — and one step further, since a step's
  // owner decides that for every item that will ever arrive there.
  "steps:setOwner": "who waits at a step decides who holds every item that arrives there",
  // Letting a webhook pipeline send unread (EO-405). Accepting that risk
  // is a person's, in the pipeline's editor — not the system agent's
  // either, which is this story's own decision (invariant 11).
  "pipelines:setWebhookUnattended": "accepting that a webhook's payload is sent on unread is a person's decision, made by pressing the button on the assistant's card for it",
  // The front door (EO-323). These two are the only channels in the
  // contract a caller reaches without a token, which is precisely why
  // they are not tools: a client holding EO's MCP token has already
  // authenticated, and offering it a password prompt would put an
  // organisation's credentials into its transcript. `auth:signIn`
  // answers with a device token in plain text, which settles it twice
  // over.
  "auth:signIn": "answers with a device token in plain text, to a caller that is already authenticated",
  "auth:acceptInvitation": "carries a person's chosen password, and is meant for the browser a link was opened in",
  // The record contract (EO-324, ARCHITECTURE.md,
  // "The record"). Out as a set, and on the plainest grounds in this file:
  // these are not things a person does, they are how one *machine*
  // talks to the record on that person's behalf. A device asks for
  // work, says its claims still stand, and replays what it did.
  //
  // Offering any of them to an editor's MCP client would hand it the
  // scheduler. `record:work` leases an item to whoever asks, which is a
  // client taking work away from the laptop that would have run it;
  // `record:apply` writes moves, comments and run transcripts under
  // whatever device id it names, which is a client filing history as
  // somebody else's machine. An agent that needed to move an item has
  // `ticket_move`, which goes through the record like everything else.
  "record:work": "leases work to whichever machine asks, which is the scheduler rather than a thing a person does",
  "record:renew": "a machine saying it is still alive; a client claiming it would hold another laptop's work open",
  "record:release": "hands back a claim a client never held",
  "record:apply": "writes moves, comments and run transcripts as a named device — history filed under somebody else's machine",
  "record:changes": "the replica's own catch-up read; an agent reads a thread with ticket_get and the board with items_list",
  // EO-328. A device's dispatch asks this about the person whose work it
  // is about to start. An agent offered it could read any person's spend
  // across the organisation, which is money somebody else's, and could
  // act on none of it — the same dead end every other excluded read is.
  "record:spend": "reports what another person has spent, which is neither an agent's business nor anything it could act on",
  // EO-433. A module's run asks this under the lease its device holds;
  // creating work from a run is custom modules' alone, and step-owning
  // agents get no creation tool in that feature.
  "record:createItem": "creates work on the organisation's board as a named device's module run, which no agent is",
  "record:attachment": "hands out a file by id to whoever asks; an agent reads what is attached to the item it is working on",
  // EO-471. A desktop's own question about a project the organisation
  // holds, answered with a row for its replica.
  "record:projectThread": "a replica's request for a row to copy; an agent reads a thread with ticket_get once it has the item",
  // EO-600: a desktop asking the record to make the change items:update
  // was asked for, on an item the organisation holds.
  "record:changeDependencies": "a replica's request for the record to make a change items:update was asked for; an agent changes what an item waits for with item_update",
  // EO-533: a desktop asking the record for the chat about a conflict it
  // holds, on behalf of an admin pressing Fix with assistant.
  "record:updateConflict": "a desktop's own question to its organisation's record, asked for pipeline_update_conflict — which is the tool an agent calls",
  "record:resolveUpdateConflict": "an administrator's desktop resolving a held template update on its organisation's record, from a person's Publish or Keep my pipeline; never an agent's",
  "record:updateConflictChat": "a replica's request for a chat to copy, made when a person presses Fix with assistant; an agent reads the conflict with its own tool",
  // EO-536: the head of a pipeline's board and Graph view, and a
  // desktop's question to the record for one it holds. What it says an
  // agent already reads whole: the held update with
  // pipeline_update_conflict, and who filed each version with
  // pipeline_versions.
  "pipeline:templateStatus": "the chips on a pipeline's head; an agent reads a held update with pipeline_update_conflict and a version's author with pipeline_versions",
  "record:templateStatus": "a desktop's own question to its organisation's record, asked for a pipeline's head; an agent reads the same facts with pipeline_update_conflict and pipeline_versions",
  // EO-482. A desktop's own writes to a moved project's memory, as a
  // named device; an agent writes memory with memory_note on the eo server.
  "record:memory": "writes a moved project's memory as a named device's run or person, which no agent is; an agent notes with memory_note",
  "record:memoryConsolidations": "a replica's question about consolidations its record ran; memory:consolidations is the reading",
  "record:restoreMemoryConsolidation": "undoes a record's consolidation as a named device's person; memory:restoreConsolidation is the action",
  // EO-471. The Settings button behind "Project notes". What is said on
  // the thread is a comment like any other, and EO's own features post
  // there through `ItemRecord.projectThread` rather than through a
  // client.
  "projects:thread": "the Settings button that opens a project's notes; what is said there reaches an agent as any thread does",
  // EO-325. Handing somebody's project to their organisation is
  // irreversible in this version and is theirs to decide, not an
  // assistant's to perform on their behalf — the sheet and the settings
  // screen are where it is offered, with the sentence saying there is
  // no way back.
  "record:adopt": "hands a whole project's history to an organisation, permanently; the person chooses this, not an assistant",

  // Renderer draft lifecycle, or the viewer itself.
  // `attachments:preview` answers with the whole file base64'd into a
  // data URL when it is an image and null when it is not: a picture for
  // somebody to look at, which is what the renderer does with it.
  // Everything a client can act on — each attachment's id, name, type
  // and size — is already on ticket_get, and attachment_delete is what
  // acts on it.
  "attachments:stage": "composer draft lifecycle",
  "attachments:discard": "composer draft lifecycle",
  "attachments:preview": "a whole image inlined for the renderer's viewer",

  // The assistant's room, whose whole subject is the screen somebody
  // is looking at. An external client is on no screen, so the route
  // descriptor these take could only ever be asserted rather than
  // observed — which is precisely the prose-instead-of-facts failure the
  // descriptor exists to prevent (EO-189). Everything an assist turn can
  // reach for is already catalogued on its own terms: ticket_get,
  // pipeline_get, agents_list, settings_read.
  "assist:open": "context is the window the person is in, which a client is not",
  "assist:send": "context is the window the person is in, which a client is not",
  // The buttons on that room's cards (EO-190), and out for a second
  // reason on top of the first: each one is a person reading a card and
  // deciding. A client offered `assist:approve` would be approving its
  // own proposal, which is the gate itself. Where an external client
  // legitimately needs to build work it has agreed with somebody, that
  // is `work_submit_plan`.
  // Clearing is the person putting their own conversation away (EO-193).
  // A client that could archive the thread somebody is mid-sentence in
  // would be reaching into a window it cannot see.
  "assist:clear": "a person putting away the conversation in front of them",
  // The list of a person's threads and going back to one: the same act
  // as Clear from the other side, and as far out of a client's reach.
  "assist:list": "a person's own conversations with the assistant, read to pick one",
  "assist:resume": "a person choosing which of their own conversations the window in front of them shows",
  // Starting another beside it (EO-391): the same choice, of an empty one.
  "assist:new": "a person starting a conversation in the window in front of them",
  // Fix with assistant on a conflict notice (EO-533): the person opening
  // the chat about their own held template update. The assistant reads
  // the conflict itself through its own tool.
  "assist:openUpdateConflict": "a person pressing Fix with assistant on a notice in front of them",
  // Resolving a held template update (EO-534) is the person's: by
  // publishing a draft from its chat, or by Keep my pipeline on a card.
  // The assistant reads the conflict with pipeline_update_conflict and
  // proposes; it never resolves one, so neither door is a tool.
  "assist:draftPublished": "a person's Publish on a draft card, which resolves the template update its chat holds; an agent proposes drafts and never publishes one",
  "pipeline:keepOwnVersion": "a person pressing Keep my pipeline on a card, which skips a held template update; an agent offers the card and never presses it",
  "assist:publishOnRecord": "a person's Publish on a draft card resolving a template update the organisation's record holds; an agent proposes drafts and never publishes one",
  // Dragging one to another place in the list (EO-438): how a person
  // arranges the rail in front of them, and nothing a client has a view of.
  "assist:reorder": "a person arranging their own conversations in the window in front of them",
  // Removing one for good (EO-390), behind a warning a client is not shown.
  "assist:remove": "a person permanently removing one of their own conversations, after a warning",
  // Several at once (EO-442), from the rail's selection, behind the same kind of warning.
  "assist:removeMany": "a person permanently removing several of their own conversations at once, after a warning",
  // Stopping a turn, choosing what the next ones run with, and forking:
  // a person steering the conversation in front of them.
  "assist:stop": "a person stopping the turn running in the conversation in front of them",
  "assist:settings": "a person choosing the model and reasoning for their own conversation",
  "assist:prewarm": "a person typing in the window in front of them",
  "assist:withdraw": "a person taking back their own message before the assistant reads it",
  "assist:earlier": "a person scrolling back through their own conversation in the window in front of them",
  "assist:fork": "a person branching their own conversation into a new one in the window in front of them",
  "assist:answer": "a person answering a card in front of them",
  // A run's steps as a chat draws them: `run_events` already reads the same run whole.
  "runs:steps": "the run_events tool reads the same run, whole",
  "runs:live": "the words a run is writing are drawn for whoever is watching and never stored; run_events reads what was",
  "assist:approve": "a person approving a card in front of them",
  // One card at full length, for the view that opens a proposed item
  // beside the conversation (EO-408). The proposal is the agent's own,
  // and what it holds is already in the turn that made it.
  "assist:proposal": "a person reading a card in front of them",
  "assist:draft": "a person publishing a card in front of them",
  "assist:publishNew": "a person publishing a card in front of them",
  // Approve and publish (EO-581): approving a module is a person's act on
  // every door, and so is publishing what it runs in.
  "assist:approveAndPublish": "a person approving a draft's modules and publishing it from a card in front of them; an agent proposes drafts and never approves or publishes one",
  "assist:applyChange": "a person applying a change to a module that a card in front of them proposed",
  // Approve design (EO-587): granting a draft's modules trial-only
  // permission to run is the person's act; the assistant proposes a design.
  "assist:approveDesign": "a person approving the design on a card in front of them, which grants its modules trial-only permission and starts the trial; an agent proposes designs and never approves one",
  "assist:publishTrial": "a person publishing a tested draft from the publish card in front of them, which approves its modules for live work; an agent asks for the card and never publishes one",
  // The cards for what only a person may do (EO-521). Pressing one
  // exports, imports or deletes a pipeline, or throws this machine's
  // edits away — and the last of those is never an agent's on any door.
  "assist:card": "a person reading a card in front of them",
  "assist:applyCard":
    "a person pressing the button on a card in front of them — exporting, importing or deleting a pipeline, discarding this machine's edits to one, " +
    "letting its webhook items through unread, setting a step's own secret or variable to a value they typed, adding, changing or removing an item type, " +
    "or keeping a pipeline as it is and skipping its held template update — " +
    "none of which is ever an agent's to do",
  "scenario:open": "a person opening the chat on the module page in front of them",
  "scenario:send": "a person talking in the chat on the module page in front of them",
  "scenario:clear": "a person putting away the conversation in front of them",
  "scenario:answer": "a person answering a card in front of them",
  "scenario:apply": "a person applying a change to a module that a card in front of them proposed",

  // Spawns a provider CLI when refreshModels is set.
  "providers:capabilities": "spawns a CLI",

  // Two channels for one listing, and the detailed one is a superset:
  // agents_list answers from it.
  "agents:list": "superseded by agents:listDetailed",

  // The import flow, all three of it. Bringing work in is being removed
  // from EO as a job of its own: the product owner will take a Jira issue
  // as *context* and propose from it, the same way it does from a
  // description someone typed. Until then it is not something a client
  // outside the app should be doing, and `search` and `preview` exist
  // only to feed `import` — a browser for an import you cannot perform
  // is the same dead end the discussion tools were.
  "jira:search": "the import flow is not an external client's job",
  "jira:preview": "the import flow is not an external client's job",
  "jira:import": "the import flow is not an external client's job",

  // The server's own controls. A connected client must not be able to
  // read its own bearer token or open its own destructive gate, so these
  // are excluded outright rather than gated — see the test below, which
  // is what actually enforces it. Its other two controls are machine-local
  // as well as its own, and are in the half below.
  "mcp:getStatus": "the server must not expose its own token",
  "mcp:setConfig": "the server must not open its own gate",
  "mcp:regenerateToken": "the server must not rotate its own credential",

  // Repository intelligence's rollout switch (EO-148) and the three
  // things a person can do to an index (EO-154). Not a security property
  // like the three above, but the same shape of judgement: turning this
  // on has EO fetch a binary onto somebody's machine and spawn it
  // against their checkout, each operation spawns an indexer against
  // one, and rebuild deletes a directory on it. Those are decisions for
  // the person sitting at the machine rather than for whatever is
  // holding a token.
  //
  // The read follows the writes out — a client that can see the switch
  // and the statuses but move neither can only report on a subsystem it
  // has no business acting on, and every tool that answers a question a
  // client cannot act on is excluded here already.
  //
  // Record-half channels for all that: what they configure is stored in
  // the database and is a fact about a project rather than about this
  // desktop, even though acting on one reaches the disk.
  // Connectors (EO-315). The setup flow, and it is out on invariant 11
  // exactly: connecting one is what puts an MCP server in front of an
  // agent on its next dispatch. An agent that could call
  // `connectors:connectToken` would be deciding what it will be
  // dispatched with, which is the thing no step-owning agent may do —
  // and the read follows the writes out on the same grounds as
  // `repositoryIntelligence:getConfig` below, since a client that can
  // see which connectors are red and connect none of them can only
  // report on a surface it has no business acting on. What a *dispatch*
  // may reach is already answered on its own terms: `mcpServers:list`
  // is catalogued, and it is the catalogue's own account of the servers.
  // Policy (EO-328, ARCHITECTURE.md, "Policy"). The writes are out on invariant 11 in its
  // plainest form: the allowed-backends list decides what an agent may
  // be bound to, and the published MCP servers decide what it may be
  // served. An agent that could publish a policy would be deciding what
  // it will be dispatched with next, which is the thing no step-owning
  // agent may do — and the system agent's exception is about
  // reconfiguring the installation a person owns, not about rewriting
  // what the organisation allows on every machine.
  //
  // The read follows the writes out, on the grounds `connectors:list`
  // and `repositoryIntelligence:getConfig` already state: a client that
  // can see the organisation's ceiling and change none of it can only
  // report on a surface it has no business acting on. What a *dispatch*
  // may actually reach is answered on its own terms — `mcpServers:list`
  // is catalogued and is the catalogue's own account of the servers, and
  // a run stopped by a budget says so in the thread like every other
  // guard.
  "policy:get": "reports an organisation's ceiling to a client that may change none of it",
  "policy:save": "an agent publishing what agents are allowed to run on is invariant 11 exactly",
  "policy:setSecret": "sets a credential for every desktop in the organisation; the admin does this, not an agent",
  "policy:clearSecret": "takes a credential away from every desktop in the organisation",

  "connectors:list": "reports a surface a client is not allowed to connect",
  "connectors:connectToken": "connecting a server is an agent giving itself a tool (invariant 11)",
  "connectors:disconnect": "taking a server away from every agent is the person's decision, not an agent's",

  "repositoryIntelligence:setConfig": "fetches a binary onto the machine — the person at it decides",
  "repositoryIntelligence:getConfig": "reports a subsystem a client is not allowed to touch",
  "repositoryIntelligence:initializeRepositoryIndex": "spawns an indexer against somebody's checkout — the person at it decides",
  "repositoryIntelligence:syncRepositoryIndex": "spawns an indexer against somebody's checkout — the person at it decides",
  "repositoryIntelligence:rebuildRepositoryIndex": "deletes a directory on the machine — the person at it decides",

  // Making an item type (ARCHITECTURE.md, "An item type is data", KAN-164). A type carries the spec
  // shape
  // creation is validated against and the action overrides that decide
  // what a run's result is held to, routes as and is recorded by — so an
  // agent able to add or reshape one could decide what it will be
  // dispatched with and what its own answer is checked against, which is
  // invariant 11 exactly. The read follows the writes out for the reason
  // the repository-intelligence read does, and because it is nearly a
  // duplicate of `registry_get`, which is catalogued and answers what a
  // client actually needs: what this project's types are and what fields
  // each demands. What it withholds is the row id, which is the handle
  // these writes take.
  // Read by item_types_list (EO-523). The writes are a person's, pressed
  // on the assistant's item-type card through `assist:applyCard`.
  "itemTypes:create": "a type decides what a run is held to — an agent adding one would be widening its own surface; a person adds one by pressing the assistant's card for it",
  "itemTypes:update": "a type decides what a run is held to — an agent reshaping one would be widening its own surface; a person changes one by pressing the assistant's card for it",
  "itemTypes:delete": "a type decides what a run is held to — an agent removing one would be widening its own surface; a person removes one by pressing the assistant's card for it",

  // Correcting what a ticket has produced (EO-298, ARCHITECTURE.md, "The output is a comment"). The
  // output is
  // the thing somebody approves, and this channel exists so that the
  // *approver's* version is the one the next step sends — which is the
  // whole of the design. A client setting it would
  // be an agent deciding that its own work is what a person signed off,
  // which is `assist:approve`'s exclusion in a different costume.
  //
  // Nothing is withheld by this. An agent with something to offer as an
  // output posts one itself, through the `comment` tool with
  // `kind: output` — the same comment, derived the same way. What it
  // cannot do is overwrite a person's correction with its own.
  "items:setOutput": "a person's correction of what an agent produced; an agent posts its own with the comment tool",

  // The screens' read of an item (EO-540), its thread windowed to the
  // newest page since EO-559, with older pages read on demand. item_get
  // reads the same item through items:getSections, which answers it
  // whole — thread and all — when it is asked for nothing narrower and
  // only the parts named when it is.
  "items:get": "the screens' item read, its thread a page at a time; item_get answers the whole item through items:getSections, which can also read part of it",
  "items:earlierComments": "the item page reading back older comments a page at a time; item_get answers the whole thread, or the part asked for, through items:getSections",

  // Claiming and assigning (EO-305). Who has a piece of work is a
  // person's word about their own hands: "I am taking this" is not
  // something a client can say on somebody's behalf, and an agent that
  // could claim would be putting a person's name on work they have not
  // seen. Assigning is the same sentence pointed at somebody else, and
  // is 7b's to gate once there is a server that knows who is asking.
  // Nothing is withheld — an agent that wants a person on an item
  // mentions them, which is what the inbox is for.
  "items:claim": "a person putting their own name on a piece of work",
  "items:assign": "handing work to a named person, which is the person's word and not a client's",
  // EO-368. Taking an item from the person holding it is a person's act
  // after a warning naming them, and an agent that could do it would be
  // taking work out of somebody's hands that nobody had been warned
  // about. Who may act on an item is a question a screen asks before
  // offering a button; an agent is told by the refusal itself.
  "items:takeOver": "taking an item from the person holding it, which a person confirms after a warning naming them",
  "items:authority": "which buttons a screen offers the person looking at it on a group's step; the refusal is what an agent hears",

  // Jobs (EO-304). A job is a standing claim on the owner's machine,
  // their logins and their budget: it fires while EO is open here
  // (ARCHITECTURE.md, "Where a job runs"), fills the owner's inbox and spends against their
  // ceiling. A
  // client that could make one, run one or remove one would be choosing
  // what this machine does when nobody is watching, which is the
  // person's decision and stays on the Jobs page. The read is withheld
  // with the writes rather than offered alone: the only thing a client
  // could do with the list is act on an entry, and every act is here.
  "jobs:list": "a job is the person's standing claim on this machine, not a list a client acts on",
  "jobs:create": "committing this machine to recurring work is the owner's decision",
  "jobs:get": "reading a job is reading the owner's standing claim on this machine — see jobs:list",
  "jobs:update": "rewriting when this machine commits its own time and money is the owner's, not a client's",
  "jobs:runNow": "spending the owner's budget on demand is a button they press, not a call a client makes",
  "jobs:delete": "removing the owner's standing commitment is theirs to do",
  "jobs:pause": "stopping the owner's standing commitment is theirs to do, and a client that could pause a job could switch its work off quietly",
  "jobs:resume": "starting one again commits the machine to spending, which is the owner's decision — see jobs:runNow",
  "jobs:cost": "what the owner has spent is their business, not a figure a client reads off the machine",

  // A webhook job's own three (EO-333, ARCHITECTURE.md, "The inbox, the archive and jobs").
  // Withheld with the eight
  // above, and two of them on a second ground of their own. Replacing
  // the signing secret invalidates whatever the helpdesk at the other
  // end is configured with, so a client that could call it could take a
  // team's intake down without a person hearing about it; and sending a
  // test event files an item on the owner's board and spends against
  // the owner's budget, which is `jobs:runNow`'s argument with a
  // different button on it. The read is withheld with the writes for
  // `jobs:list`'s reason — and because those rows carry the payloads
  // strangers sent, which is the last thing to hand a client that
  // asked for a list.
  "jobs:events": "a job's deliveries are the owner's record, payloads and all — see jobs:list",
  "jobs:regenerateSecret": "invalidating the secret the other end is configured with takes a team's intake down; the owner presses this one",
  "jobs:testEvent": "filing an item and spending the owner's budget on demand is a button they press — see jobs:runNow",

  // The gallery (EO-316). Two of these three write an installation into
  // existence — a project, a pipeline, item types and **agent rows** —
  // and that is invariant #11's subject rather than a matter of taste:
  // a client that could call `gallery:use` could give this machine an
  // agent with a tool surface of its own choosing, by shipping a pack
  // that names one. The list is withheld with them because offering it
  // alone would be a catalogue of exactly the calls a client cannot
  // make.
  "gallery:list": "the two calls this list is for are withheld below, so a catalogue of them tells a client only what it may not do",
  "gallery:preview": "writing a project and an item to rehearse in is a person's gesture at their own machine, and it creates agent rows",
  "gallery:use": "a client that could install a pack of its choosing could give this machine an agent with a tool surface it chose — invariant #11",
  "gallery:needs": "the needs check is a person reading their own machine's sign-ins, folders and secrets — the three calls it is for are withheld above",
  "gallery:attachWorkspace": "choosing which disk EO works in is the owner's, and a client that could point a project at a directory could point it at any directory",
  "gallery:openFirstItemChat": "the way out of a person's own first run, onto a chat with the assistant on show in the window in front of them",
  "gallery:staffAssistant": "pointing the assistant at a backend is spending the owner's subscription, and invariant #11 keeps the system agent's own binding out of an agent's hands",
  "gallery:staffRole": "pointing an agent at a backend is spending the owner's subscription, and invariant #11 keeps an agent's own tool surface out of an agent's hands",

  // First run (EO-317). Answering the product's first question, and
  // saying it has been answered, is the person in front of the machine
  // — not a client that could skip them past the flow or put them back
  // at the start of it.
  "firstRun:state": "where somebody is in their own first run is the window's business, not a client's",
  "firstRun:setMode": "solo or organisation is the owner's answer about their own installation",
  "firstRun:finish": "a client that could end first run could end it for somebody standing in the middle of it",
  "firstRun:tourState": "whether the window shows its own tour is the window's business, not a client's",
  "firstRun:tourSeen": "a client that could mark the tour seen could take it away from the person it is for",

  // Small UI affordances.
  "app:getVersion": "folded into the MCP initialize handshake",

  // Memory (EO-478). A person reads and edits a scope's memory in the
  // project's and workspace's settings, and an agent reaches it through
  // the `eo` server's own memory tools, held to the scopes its run was
  // given. A client reads it through memories_search, memory_get and
  // memory_consolidations_list (EO-545), and writes it as a person
  // through memory_add, memory_edit, memory_retire, memory_restore and
  // memory_consolidation_restore (EO-546).
  "memory:list": "one scope's entries as the memory panel draws them; memories_search reads every scope, with this scope as one filter",
};

/**
 * And the machine half of the same decision (KAN-127).
 *
 * Keyed by `MachineChannel`, so a channel can only be written down here
 * if the contract agrees it is machine-local — the hand-kept version of
 * this distinction is what `catalog.ts` describes above `ToolSpec.channels`,
 * and it lived in prose in the list above until the contract could say it.
 *
 * Being machine-local is not by itself a reason to withhold something.
 * Nine of the machine half's twenty-five channels *are* offered —
 * `runtime_status`, `worktrees_list`, `view_current` and their
 * neighbours — because "what does this machine have" is a fair question
 * for a client to ask. What is written down here is the subset that
 * additionally needs somebody standing at the machine: a dialog for them
 * to answer, a browser they are looking at, or a restart of the very
 * process the client is connected to.
 *
 * So each one still carries its own reason, and the sweeps below hold
 * both halves to the same rule.
 */
const NOT_CATALOGUED_MACHINE: Partial<Record<MachineChannel, string>> = {
  // How this machine is getting on with its organisation's record
  // (EO-324, ARCHITECTURE.md, "The record"). A fact about a link and a
  // queue on one laptop, which is what the machine half *is*: an agent
  // connected over MCP is not that laptop, and "offline since 09:12" is
  // a sentence for the person sitting at it rather than an input to any
  // work. Whether a move has reached the record is also not something
  // an agent can act on — the queue replays on its own.
  "sync:status": "an outage on one person's laptop is a sentence for them, not an input to an agent's work",

  // Revealing a personal secret (EO-489, ARCHITECTURE.md §14.2). The only
  // two channels that return a secret's value, and the reason they exist
  // is a person at this desktop who pressed a button and wants to read it
  // for thirty seconds. A tool built on either would put the value in a
  // client's transcript, which is the one place EO has always promised it
  // never goes — the writes are offered precisely because nothing hands a
  // value back. `module_secrets_list` and `mcp_servers_list` stay names only.
  "moduleSecrets:reveal": "returns a secret's value, which is for the person at the desktop and never for a transcript",
  "mcpServers:revealSecret": "returns a secret's value, which is for the person at the desktop and never for a transcript",

  // EO-325, the machine half. "Which of your projects are still
  // yours" is a question about this installation, and the two answers
  // change where a person's work lives for good. An assistant offering
  // them would be one able to move somebody's project to their
  // employer's server in the middle of a sentence about something else.
  "projects:undecided": "the keep-or-move sheet's own list; what an agent needs about a project is on projects_list",
  "projects:keepLocal": "a person's answer about where their own work lives, which is not an assistant's to give",
  "projects:moveToRecord": "hands a project to an organisation with no way back; the person decides this at the sheet or in Settings",

  // Where a job runs (EO-330, ARCHITECTURE.md, "Where a job runs"). The machine half of a decision
  // whose other half is already withheld above: every `jobs:*` channel
  // is out because a job is the owner's standing claim on their own
  // machine, their logins and their budget, and a client that could
  // read where one runs is a client one call away from the update that
  // moves it. The read is withheld with the write, exactly as
  // `jobs:list` is.
  //
  // And it would be answering about the wrong computer anyway. What it
  // reports is how *this* desktop is signed in and what is on *this*
  // disk; an agent connected over MCP is somewhere else, and the honest
  // thing for it to read about placement is the Job page a person is
  // looking at.
  "jobs:placement": "where a job runs is the owner's standing claim on their own machine — see jobs:list, and the update that moves it",

  // Signing a connector in (EO-315). Out on two grounds at once, and
  // either would do. It opens a browser window on the machine somebody
  // is sitting at and waits up to five minutes for them to press a
  // consent screen — there is nobody at the far end of an MCP
  // connection to press it. And what it ends with is a credential that
  // makes a server deliverable to an agent, so an agent that could call
  // it would be widening its own tool surface, which is what invariant
  // 11 exists to prevent.
  "connectors:connectOAuth": "opens a browser for a person to sign in, and ends with a server an agent would have given itself",
  // Updating EO itself (EO-201). Deliberately the person's decision and
  // nobody else's: `updates:install` exits the very process the client is
  // connected to — an agent calling it would be terminating its own host
  // mid-run — and the other three exist only as steps towards it. There
  // is nothing an external client could do with "0.5.0 is available"
  // except act on it, and acting on it is the one thing it must not do.
  "updates:status": "replacing the binary is the person's decision, and install exits the process the client is talking to",
  "updates:check": "replacing the binary is the person's decision, and install exits the process the client is talking to",
  "updates:download": "replacing the binary is the person's decision, and install exits the process the client is talking to",
  "updates:install": "replacing the binary is the person's decision, and install exits the process the client is talking to",

  // Open a native modal parented to a window. No window is guaranteed
  // when an MCP client calls, and nobody is there to click.
  "dialog:pickDirectory": "native dialog",
  "attachments:pick": "native dialog",
  "attachments:save": "native dialog",
  // Saving the output somewhere (EO-311). A dialog like the one above,
  // and nothing withheld by leaving it out: what the file would contain
  // is the item's current output, which `ticket_get` already carries in
  // full.
  "items:exportOutput": "native dialog",
  // An OS-viewer launch, on the machine EO happens to be running on.
  "attachments:open": "shells out to the OS viewer",

  // The window saying what it is showing (EO-192). One direction only:
  // `view_current` reads the snapshot and is in the catalogue, and the
  // write is the renderer's alone. A tool that could publish one would
  // let an agent tell EO what screen the person is looking at and then
  // read its own claim back as a fact — the renderer-asserts-facts
  // failure this feature is built to prevent, wearing a tool's clothes.
  "view:publish": "the window telling main what it is showing — an agent describing the screen to itself is the one thing this must not allow",

  // The canvas's window (EO-383). There has to *be* a somebody: it
  // raises a real OS window on the desktop this process is running on,
  // and an MCP client is somewhere else entirely. And one reason more:
  // the tabs it carries are where a person's attention is, and an agent
  // that could move them would be rearranging the screen `view_current`
  // then reports back to it as what the person chose to look at.
  "canvas:window": "opens a window on this desktop, and an MCP client is not sitting at it",
  "canvas:open": "moves the person's own canvas, which is theirs to move",
  "canvas:close": "closes a window on this desktop that a person opened",
  "canvas:ask": "moves the person's own cursor to the conversation, from a window they are sitting at",
  "canvas:state": "describes this desktop's windows, which `view_current` already answers for what matters",

  // The main window's own title bar (EO-668): the renderer and the window
  // it is drawn in, talking about that window's chrome.
  "window:state": "describes whether the window on this desktop is full screen, which is about drawing its top row and nothing an agent acts on",
  "window:titleBar": "colours the window controls on this desktop to match the person's theme, which is theirs to choose",

  // Debug mode (EO-392). The switch decides whether every agent's
  // prompts and instructions are written down, which is a person's to
  // decide: an agent that could flip it would be choosing what is
  // recorded about itself and its colleagues. The window is on a desktop
  // an MCP client is not sitting at. Nothing is *withheld* by leaving
  // the read out — a recorded send is a `run_events` row like any other,
  // and the `run_events` tool pages a run's log, those rows included.
  "debug:getMode": "a person's setting about what this desktop records",
  "debug:setMode": "decides what is recorded about every agent's dispatches, which is a person's to decide",
  "debug:window": "opens a window on this desktop, and an MCP client is not sitting at it",
  "debug:runs": "fills that window; a run's own log, recorded sends included, is what `run_events` already answers",

  // The server's own controls again, and these two are machine-local on
  // top of it: one runs other clients' CLIs on this desktop, the other
  // writes EO into a configuration file on it.
  "mcp:detectClients": "the server must not enumerate what else could connect to it",
  "mcp:registerWith": "the server must not hand itself to another client",

  // Signing in needs a person at the machine (EO-83). The flow opens a
  // browser on somebody's desktop and then waits for them to read a URL
  // and type a code back — a client that started one could not finish
  // it, which is the same dead end the discussion tools were. Starting
  // one is destructive on top of that: both `codex login` paths delete
  // ~/.codex/auth.json on the way in, so a client that began a sign-in
  // and walked away would have signed the machine out for its trouble.
  "runtime:startSignIn": "needs a person at the browser, and signs Codex out on the way in",
  "runtime:submitSignInCode": "carries a credential from a browser only a person is looking at",
  "runtime:cancelSignIn": "addresses a session only the sign-in dialog can hold",

  // And an API key is a person's billable secret (EO-84). A client
  // holding one has it from somewhere EO cannot see, and a tool that
  // accepts one would put it in that client's transcript on the way —
  // which is the one journey this whole story exists to keep it off.
  // Removing one is the mirror: a client must not be able to sign this
  // machine out of a runtime it is not paying for.
  //
  // These two are all that is left of that argument, and EO-115 is what
  // narrowed it to them. The server catalogue's `setSecret` and
  // `clearSecret` were held here beside these, in the same words — a
  // third-party token must not travel through a client's transcript, a
  // client must not drop a credential this machine's agents run on — and
  // they are offered now, because the words were true of the wrong
  // thing. What stays excluded here is *EO's own* operating credential:
  // billed to the person, spent by every dispatch on that backend, and a
  // client able to set or drop it could move where this machine's work
  // goes and who is paying for it. A GitHub PAT for a server somebody
  // catalogued is a third-party token for a third-party service, which
  // is what `module_secret_set` already accepts — gated, warned, and
  // one-way into the keychain — so a server's secrets went with the
  // module secrets rather than here. The last test in this file is where
  // that is argued out.
  "runtime:signInWithApiKey": "a billable secret must not travel through a client's transcript",
  "runtime:removeApiKey": "a client must not drop the credential this machine runs on",

  // This machine's sign-in to its organisation (EO-323). The address and
  // the password are typed by the person who owns the machine, and what
  // they earn is a device token that then speaks for it: a client that
  // could sign this desktop in would be choosing whose record its work
  // lands in, and one that could sign it out would be cutting it off
  // from the record mid-run. Neither is a thing an agent decides on
  // somebody's behalf, and the status is no more use without them —
  // "you are signed in to acme.example.com" is not something a client
  // can act on.
  "session:status": "which organisation this machine answers to is the person's own to change, and knowing without changing buys nothing",
  "session:signIn": "an agent must not choose whose record this machine's work lands in",
  "session:signOut": "an agent must not cut this machine off from the record it is working against",

  // Each backend's small model (EO-477). The read's default for Codex is
  // asked of the CLI installed here, so it spawns one, as
  // `providers:capabilities` does; the write is a person choosing a
  // model on the Runtimes card in front of them. An agent changing the
  // model EO's own calls about it run on would be an agent reaching
  // into how it is itself served (invariant 11).
  "sideCalls:smallModels": "spawns a CLI",
  "sideCalls:setSmallModel": "a person choosing a model on the Runtimes card in front of them; an agent must not choose what EO's own calls about it run on",
};

/**
 * The two halves as the sweeps read them.
 *
 * Merged rather than checked twice: every rule below — accounted for,
 * not also offered, reason is a decision — is about an exclusion,
 * whichever half it came from. The halves exist so that a channel cannot
 * be filed under the wrong one, not so that it can be judged by a
 * different rule.
 */
const ALL_EXCLUSIONS: Record<string, string> = { ...NOT_CATALOGUED, ...NOT_CATALOGUED_MACHINE };

/**
 * A reason that is a note to come back, rather than a decision.
 *
 * Every one of these words means the same thing — not done yet — and
 * none of them can be part of a reason that is still true next year.
 * "Pending" is the one that actually happened: twenty channels wore it,
 * the sweep above stayed green the whole time, and each of those
 * channels was found by somebody asking for it and being told no. The
 * others are here because a word that gets refused is a word the next
 * person spells differently.
 */
const PLACEHOLDER_REASON = /\b(?:pending|todo|tbd|fixme|wip|for now|not yet)\b/i;

/**
 * The exclusions whose reason decides nothing.
 *
 * A blank reason counts as one: an entry with nothing written against it
 * is the same silence as a note to come back, spelled shorter.
 *
 * Takes the list as an argument rather than closing over it, so the
 * proof below can hand it one with a placeholder written into it on
 * purpose. A check that has only ever run against a list with nothing
 * wrong in it is a check nobody knows can fail — which is exactly what
 * "pending" was.
 */
function placeholderExclusions(reasons: Record<string, string>): string[] {
  return Object.entries(reasons)
    .filter(([, reason]) => reason.trim() === "" || PLACEHOLDER_REASON.test(reason))
    .map(([channel]) => channel);
}

const catalogued = new Set<string>(TOOLS.flatMap((tool) => tool.channels));

/**
 * Words the instructions might name that are, or once were, tools.
 *
 * Listed rather than inferred so a withdrawn tool is still checked: the
 * failure being guarded against is prose that outlives the tool it names,
 * and a set built only from what exists today could not see it.
 */
const KNOWN_TOOL_WORDS = new Set([
  ...TOOLS.map((tool) => tool.name),
  "discussion_send",
  "discussion_answer",
  "discussion_approve",
  "discussion_get",
  "ticket_create",
]);

describe("the MCP tool catalog", () => {
  it("names only channels that exist in the contract", () => {
    const invented = [...catalogued].filter((channel) => !(channel in ipcContract));

    expect(invented).toEqual([]);
  });

  it("accounts for every channel in the contract", () => {
    const unaccounted = (Object.keys(ipcContract) as IpcChannel[]).filter(
      (channel) => !catalogued.has(channel) && !(channel in ALL_EXCLUSIONS),
    );

    // If this fails you have added a channel. Offer it as a tool, or add
    // a line to one of the two lists saying why not — the compiler will
    // tell you which one it belongs in. Both are fine; neither being
    // true is not.
    expect(unaccounted).toEqual([]);
  });

  it("does not write down an exclusion for a channel it also offers", () => {
    // The two drifting apart is how an exclusion note comes to describe
    // something that has since been catalogued.
    const both = [...catalogued].filter((channel) => channel in ALL_EXCLUSIONS);

    expect(both).toEqual([]);
  });

  it("does not write down an exclusion for a channel that no longer exists", () => {
    // Since KAN-127 this one cannot fail: both lists are keyed by a half
    // of the contract, so a channel that no longer exists is a compile
    // error at the line that names it rather than a failure here. Kept
    // as the runtime mirror of that — if either list is ever widened
    // back to `string` keys, this is what notices.
    const stale = Object.keys(ALL_EXCLUSIONS).filter((channel) => !(channel in ipcContract));

    expect(stale).toEqual([]);
  });

  it("files each exclusion under the half its channel is in", () => {
    // What the two lists buy, stated where somebody reading the failures
    // can see it: a machine-local channel cannot be written into the
    // record half, which is the list an organisation server inherits
    // (ARCHITECTURE.md, "Where the seams are"). The type is what enforces
    // it; this asserts the same thing at runtime so the arrangement is
    // visible from the test names rather than only from the types.
    expect(Object.keys(NOT_CATALOGUED).filter((channel) => channel in machineContract)).toEqual([]);
    expect(Object.keys(NOT_CATALOGUED_MACHINE).filter((channel) => channel in recordContract)).toEqual([]);
  });

  it("gives every exclusion a reason that is a decision", () => {
    // The rule that makes the sweep above worth anything. An exclusion
    // saying "pending" accounts for a channel the way an IOU accounts
    // for money: the test passes, nobody is reminded, and the capability
    // is missing until a person asks for it by name. A reason has to be
    // something that will read as true next year — what the channel does
    // that cannot be done from outside the app, or what EO decided not
    // to hand out.
    expect(placeholderExclusions(ALL_EXCLUSIONS)).toEqual([]);
  });

  it("catches a placeholder added to that list, so the check above is known to be able to fail", () => {
    // Each of these is a reason that was really written down here once.
    for (const reason of ["pending — write set", "TODO", "TODO: decide before release", "Pending a headless seam", "  "]) {
      expect(placeholderExclusions({ ...ALL_EXCLUSIONS, "items:list": reason }), reason).toEqual(["items:list"]);
    }
  });

  it("offers no way for a client to read its own token or open its own gate", () => {
    // The one exclusion that is a security property rather than a
    // judgement about usefulness. `mcp:getStatus` returns the bearer
    // token in full, and `mcp:setConfig` is the destructive-operations
    // switch — a client that could call either would be holding the door
    // it is standing behind.
    const selfControl = [...catalogued].filter((channel) => channel.startsWith("mcp:"));

    expect(selfControl).toEqual([]);
  });

  it("offers no tool that returns a secret's value", () => {
    // The other security property here (EO-489, ARCHITECTURE.md §14.2).
    // A personal secret may be shown on the desktop when the person
    // presses Reveal, and these two channels are how; no eo_admin tool may
    // reach either, because a tool's answer lands in a transcript.
    const revealing: IpcChannel[] = ["moduleSecrets:reveal", "mcpServers:revealSecret"];

    expect([...catalogued].filter((channel) => revealing.includes(channel as IpcChannel))).toEqual([]);
    for (const channel of revealing) expect(channel in machineContract, channel).toBe(true);
  });

  it("gives every tool a unique, well-formed name", () => {
    const names = TOOLS.map((tool) => tool.name);

    expect(names.filter((name) => !/^[a-z][a-z0-9_]*$/.test(name))).toEqual([]);
    expect(names.length).toBe(new Set(names).size);
  });

  it("marks readOnlyHint on exactly the read tools", () => {
    const wrong = TOOLS.filter((tool) => (tool.annotations.readOnlyHint === true) !== (tool.kind === "read"));

    expect(wrong.map((tool) => tool.name)).toEqual([]);
  });

  it("has something behind the gate at all", () => {
    // Reclassifying every gated tool as an ordinary write left this
    // whole file green. A catalog with an empty gate is the failure
    // state, not a precondition too obvious to assert.
    expect(TOOLS.filter((tool) => tool.kind === "dangerous").length).toBeGreaterThanOrEqual(10);
  });

  /**
   * The tools that take something away and cannot give it back.
   *
   * Written down rather than inferred from the name, because the names
   * do not divide cleanly: `ticket_archive` reads as removal and is
   * reversible in the same call, while `module_secret_set` reads as an
   * ordinary write and irrecoverably overwrites a value nothing can read
   * back. A regex over names got both of those wrong.
   *
   * `destructiveHint` is what a well-behaved client shows a person
   * before running one, so a tool missing from this list is a tool that
   * deletes something quietly.
   */
  const DESTRUCTIVE = [
    "run_cancel",
    // Both names of the one tool, for as long as both resolve
    // (KAN-162). Written out rather than derived, because an alias is
    // exactly as destructive as what it is an alias for and a list that
    // widened itself would stop being the written-down decision this is.
    "ticket_delete",
    "item_delete",
    "comment_delete",
    "attachment_delete",
    // A project and every ticket on it (EO-346): the comments, the runs
    // and the files go with them, and no channel puts any of it back.
    "project_delete",
    "pipeline_delete",
    "module_archive",
    // A test case goes outright (EO-352): no archive keeps it, and no
    // channel puts it back. The last run's result keeps its description,
    // which is a record of what ran, not a copy of the case.
    "module_test_delete",
    "module_secret_set",
    "module_secret_clear",
    // A variable's value goes with it (EO-485). Not its setter: the list
    // returns the old value, so a client can put it back.
    "environment_variable_clear",
    "runtime_remove",
    "repository_remove",
    // The same act over every kind (EO-301), and destructive for
    // `repository_remove`'s reason rather than a new one: what it takes
    // away is EO's record of a disk — the folder's path and its
    // per-ticket layout, the repository's commands and forge settings —
    // and no channel puts one back. Nothing on disk is touched either
    // way, which is what the sentence it answers with says.
    "workspace_remove",
    "worktree_release",
    // Both take something away that is not anywhere else. Disconnecting
    // drops the repository's status map and field values, and takes the
    // site's token with it when nothing else is using that site;
    // removing a connection deletes the credential outright. The first
    // is an ordinary write all the same — what it destroys is EO's own
    // configuration, which the person who wrote it can write again —
    // and destructiveHint is what asks them first.
    "jira_disconnect",
    "jira_connection_remove",
    // Archiving either catalogue, which is `module_archive`'s case and
    // not `ticket_archive`'s. `items:setArchived` takes a boolean and
    // reverses in the same call; `mcpServers:archive` and
    // `skills:archive` only archive, and no channel un-archives — the
    // row survives for the attachments and runs that point at it, and a
    // person who wants the entry back in the catalogue has to write it
    // again. Saving and switching are the reversible half and stay
    // unwarned.
    "mcp_server_archive",
    "skill_archive",
    // Retiring an agent, which is the same act one level up (EO-186):
    // the row is kept so its runs and its comments still resolve, no
    // channel un-archives it, and `agent_save` with `enabled: false` is
    // the reversible half.
    "agent_archive",
    // Deleting one (EO-350): the tombstone keeps the name on its runs
    // and comments, and nothing else about the agent survives.
    "agent_delete",
    // Both halves of a server's secrets, which is `module_secret_set`'s
    // case rather than a new one: clearing a value destroys it, and so
    // does setting one over a value already there, because nothing can
    // read either back to put it anywhere first. The setter is the
    // reason this list is written down instead of inferred from names.
    "mcp_server_set_secret",
    "mcp_server_clear_secret",
    // A definition is removed outright, with no archive behind it (EO-425).
    "role_action_delete",
  ];

  it("warns a client before every tool that destroys something", () => {
    const unwarned = DESTRUCTIVE.filter(
      (name) => TOOLS.find((tool) => tool.name === name)?.annotations.destructiveHint !== true,
    );

    expect(unwarned).toEqual([]);
  });

  it("does not warn about tools that destroy nothing", () => {
    // The other half: a hint on everything is a hint on nothing. Named
    // reversals in particular — archiving keeps every row it touches.
    const unwarranted = TOOLS.filter(
      (tool) => tool.annotations.destructiveHint === true && !DESTRUCTIVE.includes(tool.name),
    );

    expect(unwarranted.map((tool) => tool.name)).toEqual([]);
  });

  it("describes every tool", () => {
    // A tool a model cannot tell apart from its neighbour is a tool it
    // picks at random.
    expect(TOOLS.filter((tool) => tool.description.length < 40).map((tool) => tool.name)).toEqual([]);
  });

  it("names no tool in its instructions that it does not offer", () => {
    // The instructions are the first thing a model reads and it cannot
    // check them. Naming `discussion_send` after the tool was withdrawn
    // sent every reader at a door that is not there — the same defect a
    // review already caught in a renderer that pointed at `discussion_get`.
    const offered = new Set(TOOLS.map((tool) => tool.name));
    const mentioned = [...SERVER_INSTRUCTIONS.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)].map((match) => match[1]!);

    // Only words shaped like a tool name, and only ones that were ever
    // tools — prose is allowed to contain underscores.
    const named = [...new Set(mentioned)].filter((word) => word.startsWith("eo_") || KNOWN_TOOL_WORDS.has(word));

    // The instructions name the guides as well, and a guide name is the
    // same promise a tool name is: renamed or withdrawn, it leaves the
    // reader at a door that is not there. So guides are checked against
    // `GUIDES` rather than exempted from the check.
    const reachable = new Set([...offered, ...GUIDES.map((guide) => guide.name)]);

    expect(named.filter((word) => !reachable.has(word))).toEqual([]);
    // And it does name some, or the check above passes on an empty set.
    expect(named.length).toBeGreaterThan(0);
  });

  it("advertises an object schema for every tool", () => {
    const wrong = TOOLS.filter((tool) => tool.inputSchema["type"] !== "object" || "$schema" in tool.inputSchema);

    expect(wrong.map((tool) => tool.name)).toEqual([]);
  });

  it("lets a caller change one guardrail without restating the other six", () => {
    // `GuardConfigSchema` demands every field, which is right for a form
    // holding all seven and wrong for a caller that wants the daily
    // budget raised. The tool is the read-merge-write that closes the
    // gap, and both halves are declared — which is also what accounts
    // for `guards:set` in the sweep above, rather than an exclusion.
    const set = TOOLS.find((tool) => tool.name === "guardrails_set");

    expect(set?.kind).toBe("write");
    expect(set?.channels).toEqual(["guards:get", "guards:set"]);
    // Nothing required: a field left out is a field left alone, and a
    // schema that demanded any of them would be the thing being fixed.
    expect(set?.inputSchema["required"]).toBeUndefined();
    expect(Object.keys((set?.inputSchema["properties"] ?? {}) as Record<string, unknown>)).toContain("dailyBudgetCents");
  });

  it("treats EO's own configuration as an ordinary write", () => {
    // By the rule the gate runs on: these delete nothing, write no
    // secret and approve nothing, and every one of them can be read back
    // and corrected. `settings_read` is a read for the same reason.
    expect(TOOLS.find((tool) => tool.name === "settings_read")?.kind).toBe("read");
    for (const name of ["settings_write", "guardrails_set"]) {
      expect(TOOLS.find((tool) => tool.name === name)?.kind, name).toBe("write");
    }
  });

  it("does not let pipeline_save restore who a step waits on (EO-359)", () => {
    // `restoredFrom` puts back a version's step owners, and who waits at a
    // step is the decision `steps:setOwner` keeps out of this catalog.
    const save = TOOLS.find((tool) => tool.name === "pipeline_save");

    expect(Object.keys((save?.inputSchema["properties"] ?? {}) as Record<string, unknown>)).toEqual(
      expect.arrayContaining(["pipelineId", "steps", "routes", "entryStepId"]),
    );
    expect(Object.keys((save?.inputSchema["properties"] ?? {}) as Record<string, unknown>)).not.toContain("restoredFrom");
  });

  it("lets a caller move an agent onto a different model without restating its prompt", () => {
    // `agents:save` is the settings screen's form: it wants the whole
    // agent, and the screen has the whole agent in front of it. A client
    // that wants one field changed does not, and a model made to restate
    // an instructions block it never read will paraphrase it. So this is
    // the second composite, and both halves are declared — which is what
    // accounts for `agents:save` in the sweep above rather than an
    // exclusion.
    const save = TOOLS.find((tool) => tool.name === "agent_save");

    expect(save?.kind).toBe("write");
    expect(save?.channels).toEqual(["agents:listDetailed", "agents:save"]);
    // Nothing required: a create is checked in the tool, where the
    // message can say what a create needs, rather than by a schema that
    // would demand the same four fields of an edit.
    expect(save?.inputSchema["required"]).toBeUndefined();
    expect(Object.keys((save?.inputSchema["properties"] ?? {}) as Record<string, unknown>)).toEqual(
      expect.arrayContaining(["id", "name", "role", "provider", "model", "instructions", "enabled"]),
    );
    // And the description says the thing a caller would otherwise learn
    // by having an edit refused.
    expect(save?.description).toMatch(/role[^.]*fixed/);
  });

  it("lets a client see the runtimes it is allowed to act on", () => {
    // The gap this closes. `runtime_install` and `runtime_remove` were
    // offered while nothing reported what was installed, so a caller
    // could act on runtimes it could not inspect. Both reads are
    // ungated; both writes stay behind the switch.
    const status = TOOLS.find((tool) => tool.name === "runtime_status");
    const describe = TOOLS.find((tool) => tool.name === "runtime_describe");

    expect(status?.kind).toBe("read");
    expect(describe?.kind).toBe("read");
    // Asking about every backend is the default, because a caller that
    // does not know the provider ids is exactly the one this is for.
    expect(status?.inputSchema["required"]).toBeUndefined();
    for (const name of ["runtime_install", "runtime_remove"]) {
      expect(TOOLS.find((tool) => tool.name === name)?.kind, name).toBe("dangerous");
    }
  });

  it("marks the one read that leaves the machine as open-world", () => {
    // Every other tool answers from EO's own database or disk.
    // `runtime_describe` asks the npm registry how big a package is, so
    // it is only as available as npm is — and a client planning around
    // that has to be told which tool it is.
    expect(TOOLS.find((tool) => tool.name === "runtime_describe")?.annotations.openWorldHint).toBe(true);
    expect(TOOLS.find((tool) => tool.name === "runtime_status")?.annotations.openWorldHint).toBe(false);
  });

  it("keeps the switch that installs a runtime behind the gate, whatever it is called", () => {
    // `runtime:setAutomaticUpdates` reads as a checkbox and is not one:
    // turning it on grants the durable download consent and reconciles
    // the provider on the spot, which for a backend with nothing on disk
    // is the install. Offered ungated it would be a way around the gate
    // `runtime_install` stands behind.
    const auto = TOOLS.find((tool) => tool.name === "runtime_set_automatic_updates");

    expect(auto?.kind).toBe("dangerous");
    // And it is honest about reaching the network, for the same reason
    // `runtime_install` is.
    expect(auto?.annotations.openWorldHint).toBe(true);
    // Not destructive, though: it removes nothing, and warning about it
    // alongside the deletes would blunt the warning that matters.
    expect(auto?.annotations.destructiveHint).toBeUndefined();
  });

  it("lets a client author a module without offering it any way to approve one", () => {
    // The asymmetry that makes `module_save` an ordinary write. A module
    // is arbitrary code EO will later run unsandboxed with the person's
    // privileges — but an unapproved one runs nowhere, because EO refuses
    // to publish a pipeline naming it, and its tests run it against a
    // scripted ctx where nothing real happens (EO-352). Writing one is
    // therefore inert; approving one is not, and stays behind the gate.
    const save = TOOLS.find((tool) => tool.name === "module_save");
    const approve = TOOLS.find((tool) => tool.name === "module_approve");

    expect(save?.kind).toBe("write");
    expect(approve?.kind).toBe("dangerous");
    // Not merely absent from `required`: a client must not be shown the
    // field at all. What stops a crafted call that sends it anyway is the
    // override reaching the handler, which dispatch.test.ts asserts.
    expect(Object.keys((save?.inputSchema["properties"] ?? {}) as Record<string, unknown>)).not.toContain("approve");
    // And the description says so, because a model that does not know its
    // module is inert will wait for it to run — and one that does not know
    // approving is a person's job will go looking for a way to do it.
    expect(save?.description).toContain("unapproved");
    expect(save?.description).toMatch(/person[^.]*approv/);
  });

  it("lets a client set EO up, and keeps the one setup channel that removes something gated", () => {
    // "One-time setup" was a claim about how often somebody does this,
    // not about whether they can — and a person connecting a fresh EO
    // has no other way to reach any of it. None of the six deletes,
    // stores a secret or approves anything, and every one can be read
    // back and corrected, so all six are ordinary writes.
    for (const name of [
      "project_create",
      "project_update",
      "project_add_repository",
      "project_remove_repository",
      "repository_create",
      "repository_update",
    ]) {
      expect(TOOLS.find((tool) => tool.name === name)?.kind, name).toBe("write");
    }

    // The exception, and the reason the rule is about what a call takes
    // away rather than about which screen it belongs to.
    expect(TOOLS.find((tool) => tool.name === "repository_remove")?.kind).toBe("dangerous");
  });

  it("lets the system agent delete a project only behind the gate, and only once it has asked (EO-346)", () => {
    const remove = TOOLS.find((tool) => tool.name === "project_delete");

    expect(remove?.channels).toEqual(["projects:delete"]);
    expect(remove?.kind).toBe("dangerous");
    // The first call is the question; the description has to say so,
    // or an agent reads "delete a project" and passes confirm at once.
    expect(remove?.description).toMatch(/without confirm first/);
    expect(remove?.description).toMatch(/confirm: true only once they have said/);
    expect(remove?.description).toMatch(/organisation's record is refused/);
    // The system agent's server serves every dangerous tool (EO-182),
    // so this is how it reaches it — and an external client does not
    // until a person opens the gate.
    expect(toolsFor(true, "admin").map((tool) => tool.name)).toContain("project_delete");
    expect(toolsFor(false, "external").map((tool) => tool.name)).not.toContain("project_delete");
  });

  it("lets the system agent delete or archive an agent only once it has asked (EO-350)", () => {
    const remove = TOOLS.find((tool) => tool.name === "agent_delete");
    const archive = TOOLS.find((tool) => tool.name === "agent_archive");

    expect(remove?.channels).toEqual(["agents:delete"]);
    expect(remove?.kind).toBe("dangerous");
    expect(toolsFor(true, "admin").map((tool) => tool.name)).toContain("agent_delete");
    expect(toolsFor(false, "external").map((tool) => tool.name)).not.toContain("agent_delete");
    // Both take the same confirmation, and both descriptions have to say
    // the first call is the question.
    for (const tool of [remove, archive]) {
      expect(tool?.description, tool?.name).toMatch(/without confirm first/);
      expect(tool?.description, tool?.name).toMatch(/confirm: true only once they have said/);
    }
  });

  it("tells the caller what removing an agent would take away, in the order the screen does", () => {
    const impact = {
      agentName: "Reviewer",
      role: "reviewer",
      steps: [{ stepId: "s1", stepName: "Review", pipelineId: "p1", pipelineName: "Delivery" }],
      leavesStepsWithNobody: true,
      coveredBy: [],
      activeRuns: [{ runId: "r1", itemId: "i1", itemKey: "EO-7", itemTitle: "Thing" }],
      lastSystemAgent: false,
    };
    const said = describeAgentRemoval(impact);

    expect(said).toContain('"Review" (Delivery)');
    expect(said).toMatch(/will have nobody/);
    expect(said).toContain("EO-7");
    expect(describeAgentRemoval({ ...impact, leavesStepsWithNobody: false, coveredBy: ["Second"], activeRuns: [] })).toMatch(/Still covered by Second/);
    expect(describeAgentRemoval({ ...impact, leavesStepsWithNobody: false, coveredBy: ["Second"] })).not.toMatch(/nobody/);
  });

  it("lets the system agent archive and restore a project, asking first before it archives (EO-347)", () => {
    const archive = TOOLS.find((tool) => tool.name === "project_archive");
    const restore = TOOLS.find((tool) => tool.name === "project_restore");

    expect(archive?.channels).toEqual(["projects:archive"]);
    expect(restore?.channels).toEqual(["projects:restore"]);
    // Reversible, so ordinary writes, as ticket_archive and ticket_hold
    // are — and not in the destructive list above.
    expect(archive?.kind).toBe("write");
    expect(restore?.kind).toBe("write");
    // It stops agents, so the first call is the question, and the
    // description has to say so.
    expect(archive?.description).toMatch(/without confirm first/);
    expect(archive?.description).toMatch(/confirm: true only once they have said/);
    expect(archive?.description).toMatch(/organisation's record is refused/);
    // The system agent's server has both.
    const admin = toolsFor(true, "admin").map((tool) => tool.name);
    expect(admin).toEqual(expect.arrayContaining(["project_archive", "project_restore"]));
  });

  it("says which projects are archived when it lists them, and will not switch the window to one (EO-347)", () => {
    const listing = TOOLS.find((tool) => tool.name === "projects_list");
    expect(listing?.description).toMatch(/Archived projects are listed too, and marked archived/);

    const text = renderProjects({
      projects: [
        { id: "p1", name: "Shop", keyPrefix: "SHOP", repositoryIds: [], itemCount: 1, managedAt: null, keptLocalAt: null, adoptingAt: null, archivedAt: null, preview: false, costCents: 0 },
        { id: "p2", name: "Old", keyPrefix: "OLD", repositoryIds: [], itemCount: 1, managedAt: null, keptLocalAt: null, adoptingAt: null, archivedAt: 1, preview: false, costCents: 0 },
      ],
      activeProjectId: "p1",
    });
    expect(text).toMatch(/- Shop \(id: p1, key prefix: SHOP\) — \*\*the project the window is showing\*\*$/m);
    expect(text).toMatch(/- Old \(id: p2, key prefix: OLD\) — archived/);
  });

  it("says that taking a repository off a project is what moves it, because it belongs to one", () => {
    // This used to be about Jira: the removal cleared `jiraProjectId`
    // when it was the repository being taken off, and a caller had to be
    // able to read that consequence before calling rather than only in
    // the reply. KAN-130 made the binding the project's own, so removal
    // cannot reach it and there is nothing to warn about.
    //
    // What did become a consequence worth reading first is the other
    // half of the same change: a workspace belongs to one project, so
    // adding it elsewhere takes it off here and this leaves it belonging
    // to nothing. Both tools say so.
    const remove = TOOLS.find((tool) => tool.name === "project_remove_repository");
    const add = TOOLS.find((tool) => tool.name === "project_add_repository");

    expect(remove?.description).toMatch(/one project at a time/);
    expect(add?.description).toMatch(/one project at a time/);
    // And nothing here still offers a Jira choice that no longer exists
    // (invariant 12: no control that would do nothing).
    expect(remove?.description).not.toMatch(/jiraProjectId/);
  });

  it("says, in the description of the one tool that moves the window, that it moves the window", () => {
    // The whole reason `projects:setActive` was withheld. Offering it is
    // right — it is a thing the app does and a person can ask for — but
    // a model that does not know it moves someone's window will call it
    // to set up a read, and the person watching will have their project
    // changed under them. So the disclosure is asserted, not merely
    // written once and hoped for.
    const active = TOOLS.find((tool) => tool.name === "project_set_active");

    expect(active?.kind).toBe("write");
    expect(active?.description).toMatch(/window/);
    expect(active?.description).toMatch(/person at the keyboard/);
    // And it reads before it writes, so an id EO does not have is refused
    // by name rather than answered with the project that is already
    // active — which is what the channel alone does.
    expect(active?.channels).toEqual(["projects:list", "projects:setActive"]);
    // Nothing else may switch it: the reads take an explicit projectId
    // precisely so that looking at a project never means moving to it.
    const switchers = TOOLS.filter((tool) => tool.channels.includes("projects:setActive"));
    expect(switchers.map((tool) => tool.name)).toEqual(["project_set_active"]);
  });

  it("offers the whole of connecting EO to a tracker, and gates only what carries a credential", () => {
    // "Settings-screen minutiae" was a judgement about how interesting a
    // capability looked, not about whether it could work. These ten are
    // the whole of wiring EO to Jira and of seeing what it can reach a
    // forge with — none deletes anything a person cannot write again,
    // none stores a secret, and every one can be read back through
    // jira_connections_list or repositories_list.
    for (const name of [
      "jira_connections_list",
      "jira_test",
      "jira_fields",
      "jira_statuses",
      "jira_outbox",
      "forge_detect",
      "jira_save_config",
      "jira_save_status_map",
      "jira_save_transition_fields",
      "jira_disconnect",
    ]) {
      const tool = TOOLS.find((candidate) => candidate.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.kind, name).not.toBe("dangerous");
    }

    // The three that carry or bind a credential. `jira_connection_save`
    // takes a token inward and stores it, `jira_connection_remove`
    // deletes one, and `jira_connect` binds a repository to the site the
    // credential belongs to.
    for (const name of ["jira_connection_save", "jira_connection_remove", "jira_connect"]) {
      expect(TOOLS.find((tool) => tool.name === name)?.kind, name).toBe("dangerous");
    }
  });

  it("offers exactly one tool that takes a Jira token, and takes it inward", () => {
    // The rule this surface would be worth withdrawing over: nothing
    // reports a credential. No response in `ipcContract` carries one, so
    // the way it could break here is a tool inventing a field — and the
    // only place a token legitimately appears is the input of the gated
    // save, which stores it in the OS keychain and cannot read it back.
    // Asserted over the wire too, against a connection that has one, in
    // http.test.ts.
    //
    // Written down field by field rather than counted, because there is
    // a second field a heuristic on the word "token" now finds and a
    // count would not explain: `mcp_server_save.bearerTokenEnvName`
    // (EO-117) is the *name* of an environment variable, never a value
    // — the token it stands for goes in through `mcp_server_set_secret`,
    // which is gated and one-way. Listing both means a field that
    // really did carry a credential has to be written here before this
    // passes, which is the decision this file exists to make compulsory.
    const takesAToken = TOOLS.flatMap((tool) =>
      Object.keys((tool.inputSchema["properties"] ?? {}) as Record<string, unknown>)
        .filter((field) => /token/i.test(field))
        .map((field) => `${tool.name}.${field}`),
    );

    expect(takesAToken.sort()).toEqual(["jira_connection_save.token", "mcp_server_save.bearerTokenEnvName"]);
    expect(TOOLS.find((tool) => tool.name === "jira_connection_save")?.kind).toBe("dangerous");
  });

  it("lets a caller change one Jira setting without restating the other three", () => {
    // `jira:saveConfig` is the settings screen's form and demands all
    // four, which is right for a screen holding all four and wrong for a
    // client that wants EO to stop creating an issue for every item.
    // A model made to restate the issue types to say so is a repository
    // that quietly starts creating Tasks instead of Stories.
    const save = TOOLS.find((tool) => tool.name === "jira_save_config");

    expect(save?.kind).toBe("write");
    expect(save?.channels).toEqual(["repositories:list", "jira:saveConfig"]);
    expect(save?.inputSchema["required"]).toEqual(["repositoryId"]);
  });

  it("says that the status map is replaced rather than merged into", () => {
    // The one write here that can take something away by omission: a
    // step left out of the map stops moving its issue, and nothing in
    // the reply would say so. A caller has to know that before it calls,
    // not after a release stops appearing in Jira.
    const map = TOOLS.find((tool) => tool.name === "jira_save_status_map");

    expect(map?.description).toMatch(/replaces the whole map/);
    expect(map?.description).toMatch(/repositories_list/);
  });

  it("says that disconnecting a repository can take the site's token with it", () => {
    // Ungated, because what it destroys is EO's own configuration and a
    // person can write it again. But on the last repository using a site
    // the stored credential goes too, and that one cannot be written
    // again from anything EO holds — so it is said in the description
    // and warned about in the annotations.
    const disconnect = TOOLS.find((tool) => tool.name === "jira_disconnect");

    expect(disconnect?.kind).toBe("write");
    expect(disconnect?.annotations.destructiveHint).toBe(true);
    expect(disconnect?.description).toMatch(/token/);
    expect(disconnect?.description).toMatch(/status map/);
  });

  it("says only the attempt limit applies to the system agent, in what guardrails_get offers and what it answers (EO-616)", () => {
    expect(TOOLS.find((tool) => tool.name === "guardrails_get")?.description).toMatch(/only the attempt limit applies to the system agent/);
    expect(renderGuards({ inactivityTimeoutMs: 0 } as never)).toMatch(/system agent: of the limits on a run, only the attempt limit applies/);
  });

  it("reports the spend the budget guardrails are measured against, both figures of it", () => {
    // guardrails_get has said what the two budgets are since they were
    // offered, and nothing said what had been spent against them — a
    // limit nobody can take a reading against is a number, not a
    // guardrail. Both channels are declared, which is what accounts for
    // them in the sweep above rather than an exclusion.
    const spend = TOOLS.find((tool) => tool.name === "spend_read");

    expect(spend?.kind).toBe("read");
    // And the one a ticket's key is resolved through, since it takes a ticket (EO-539).
    expect(spend?.channels).toEqual(["costs:getDaily", "costs:getForItem", "items:resolveKey"]);
    // Nothing required: today's spend across everything is what a caller
    // gets for asking nothing, and it is the figure the daily budget
    // stops work on.
    expect(spend?.inputSchema["required"]).toBeUndefined();
    expect(Object.keys((spend?.inputSchema["properties"] ?? {}) as Record<string, unknown>)).toEqual(
      expect.arrayContaining(["ticketId", "date"]),
    );
    // And the description names both guards, because a figure with no
    // limit beside it decides nothing.
    expect(spend?.description).toMatch(/budget guardrails are measured against/);
    expect(spend?.description).toMatch(/dailyBudgetCents/);
    expect(spend?.description).toMatch(/perTicketBudgetCents/);
  });

  it("lets a client pin the comment a thread should be read from, and take the pin off again", () => {
    const pin = TOOLS.find((tool) => tool.name === "comment_pin");

    // An ordinary write by the rule the gate runs on: it takes nothing
    // away — an unpinned comment is still in the thread — and ticket_get
    // marks what is pinned, so it reads back and corrects.
    expect(pin?.kind).toBe("write");
    expect(pin?.annotations.destructiveHint).toBeUndefined();
    // Unpinning is this tool with a false in it, not a tool that is missing.
    expect(Object.keys((pin?.inputSchema["properties"] ?? {}) as Record<string, unknown>)).toEqual(
      expect.arrayContaining(["commentId", "pinned"]),
    );
    // And it says what a pin is for, which a boolean called `pinned`
    // does not: surviving the truncation that drops the rest of a long
    // thread out of an agent's context.
    expect(pin?.description).toMatch(/truncation/);
  });

  it("puts deleting an attached file behind the same switch as every other delete", () => {
    const remove = TOOLS.find((tool) => tool.name === "attachment_delete");

    expect(remove?.kind).toBe("dangerous");
    expect(remove?.annotations.destructiveHint).toBe(true);
    // Where an id comes from. Nothing else in the catalog would say, and
    // a model that cannot find one constructs it.
    expect(remove?.description).toMatch(/ticket_get/);
    // And that the delete reaches Jira as well, with no flag to stop it
    // — comment_delete has `deleteInJira` and this channel has nothing,
    // so a caller that expected the local copy to go alone would find
    // out from the issue.
    expect(remove?.description).toMatch(/Jira/);
    // Queued, and said so. EO's own copy is gone when the call returns;
    // Jira's goes when the outbox drains, and stays if that keeps
    // failing. The description said "Nothing keeps a copy" once, which
    // promised something about somebody else's server that this call
    // cannot deliver — a caller deleting a screenshot because it should
    // not have been shared would have read that as done.
    expect(remove?.description).toMatch(/queued/i);
    expect(remove?.description).toMatch(/outbox|drains/i);
    // Written as an absence because this is the sentence that keeps
    // coming back: "nothing else holds a copy" first, then "Nothing
    // keeps a copy". Both are a promise about a server EO does not own,
    // and somebody deleting a screenshot that should not have been
    // shared is exactly who would act on it.
    expect(remove?.description).not.toMatch(/nothing (?:else )?(?:keeps|holds|has) a copy/i);
  });

  it("tells a caller attaching a repository that EO clones nothing", () => {
    // A path on disk, not a URL. A model that thinks otherwise will send
    // `https://github.com/acme/api` and get a refusal it cannot act on,
    // so the tool says what the field is before it is filled in.
    const create = TOOLS.find((tool) => tool.name === "repository_create");

    expect(create?.description).toMatch(/clones nothing/);
    expect(create?.description).toMatch(/already a git repository/);
    // And when attaching one moves the window, which is the surprise
    // `project_set_active` exists to avoid being.
    expect(create?.description).toMatch(/window stays where it is/);
    expect(create?.description).toMatch(/window switches to it/);
  });

  it("says a repository joins a project on both doors that attach one (EO-603)", () => {
    for (const name of ["repository_create", "workspace_create"]) {
      const description = TOOLS.find((tool) => tool.name === name)?.description;

      expect(description).toMatch(/`projectId`, or the project the (app )?window is showing/);
      expect(description).not.toMatch(/project of its own/);
    }
  });

  it("lets a client make a pipeline without the switch that lets it delete one", () => {
    // Creating is offered ungated because an empty pipeline is inert:
    // nothing is placed on it and nothing runs through it until a graph
    // is published into it, and `pipeline_save` already refuses a graph
    // naming an unapproved module. Deleting is the asymmetric half —
    // archiving a pipeline archives the items on it — so it stays
    // where it was.
    const ungated = toolsFor(false).map((tool) => tool.name);

    expect(ungated).toContain("pipeline_manage");
    expect(ungated).not.toContain("pipeline_delete");
    expect(TOOLS.find((tool) => tool.name === "pipeline_delete")?.kind).toBe("dangerous");
  });

  it("tells a caller that the pipeline it just made is empty until a graph is published into it", () => {
    // A pipeline with no steps is a name and nothing else. A model that
    // does not know that has created something it believes is running
    // work, and will go looking for why nothing moved.
    const manage = TOOLS.find((tool) => tool.name === "pipeline_manage");

    expect(manage?.description).toContain("pipeline_save");
    expect(manage?.description).toMatch(/no steps/);
  });

  it("lets a client read what EO gives its agents, and asks nothing of it to do so", () => {
    // The three the exclusion list above used to hold, and the
    // distinction they were released on: reading an agent's surface is
    // not choosing it. Each is a read by `kind`, which is what keeps it
    // in front of a client that has not opened the destructive gate —
    // the sweep over `readOnlyHint` is what stops one of them being
    // filed as a write by accident.
    for (const name of ["mcp_servers_list", "skills_list", "agent_attachments_list"]) {
      const tool = TOOLS.find((candidate) => candidate.name === name);

      expect(tool, name).toBeDefined();
      expect(tool?.kind, name).toBe("read");
      expect(tool?.annotations.readOnlyHint, name).toBe(true);
      expect(toolsFor(false).map((offered) => offered.name), name).toContain(name);
      // Nothing required. A client that does not yet know an agent id or
      // whether it wants the archived rows is exactly the one asking, and
      // a schema that demanded either would refuse the first call every
      // caller makes.
      expect(tool?.inputSchema["required"], name).toBeUndefined();
    }
  });

  it("says, on the one tool that answers in ids, where those ids are read", () => {
    // `agentAttachments:list` is the join and carries ids rather than
    // rows, deliberately — a second copy of a catalogue row is a stale
    // copy. That makes the reply unusable on its own, so the tool has to
    // name the three reads that turn an id into something a person
    // recognises, or a model will go looking for a resolver that is not
    // there.
    const attachments = TOOLS.find((tool) => tool.name === "agent_attachments_list");

    expect(attachments?.description).toContain("agents_list");
    expect(attachments?.description).toContain("mcp_servers_list");
    expect(attachments?.description).toContain("skills_list");
  });

  it("lets a client write both catalogues, as the ordinary writes they are", () => {
    // The six the exclusion list above used to hold, released on a
    // distinction the reads did not need: a catalogue row added through
    // a client is a person's request relayed, not code an agent wrote
    // for itself. Ordinary writes by the rule the gate runs on — they
    // delete nothing, write no secret and approve nothing — so they are
    // in front of a client that has not opened the destructive gate,
    // which is the whole point of offering them.
    for (const name of [
      "mcp_server_save",
      "mcp_server_set_enabled",
      "mcp_server_archive",
      "skill_save",
      "skill_set_enabled",
      "skill_archive",
    ]) {
      const tool = TOOLS.find((candidate) => candidate.name === name);

      expect(tool, name).toBeDefined();
      expect(tool?.kind, name).toBe("write");
      expect(toolsFor(false).map((offered) => offered.name), name).toContain(name);
    }
  });

  it("warns before archiving a catalogue entry and stays quiet about saving or switching one", () => {
    // Both directions, because the two sweeps above only prove what
    // `DESTRUCTIVE` says: this is the claim that list is making. An
    // archived row is kept — an attachment still resolves against it —
    // but nothing here brings it back into the catalogue, and a save or
    // a switch is correctable by calling the same tool again.
    for (const name of ["mcp_server_archive", "skill_archive", "agent_archive"]) {
      expect(TOOLS.find((tool) => tool.name === name)?.annotations.destructiveHint, name).toBe(true);
    }
    for (const name of ["mcp_server_save", "mcp_server_set_enabled", "skill_save", "skill_set_enabled", "agent_save"]) {
      expect(TOOLS.find((tool) => tool.name === name)?.annotations.destructiveHint, name).toBeUndefined();
    }
  });

  it("says, on the tool that adds a server, what a name may be and which one is taken", () => {
    // Both are refusals a caller meets by having a save rejected, and
    // one of them cannot be guessed at all: `eo` is EO's own server,
    // every agent already has it, and nothing about the field says so.
    const save = TOOLS.find((tool) => tool.name === "mcp_server_save");

    expect(save?.description).toContain("`eo`");
    expect(save?.description).toMatch(/lowercase letters, digits, hyphens and underscores/);
    // And that a saved row is inert: a model that thinks saving is
    // enough has handed an agent nothing and will go looking for why.
    expect(save?.description).toMatch(/until it is attached/);
  });

  it("points a caller at the reversible half before the one that is not", () => {
    // `destructiveHint` is a flag a client may or may not act on. The
    // description is the part a model reads either way, and switching a
    // catalogue entry off does what archiving does to a dispatch while
    // leaving it recoverable.
    expect(TOOLS.find((tool) => tool.name === "mcp_server_archive")?.description).toContain("mcp_server_set_enabled");
    expect(TOOLS.find((tool) => tool.name === "skill_archive")?.description).toContain("skill_set_enabled");
    // The agent's reversible half is a field on its save rather than a
    // switch of its own, so the sentence has to name both (EO-186).
    expect(TOOLS.find((tool) => tool.name === "agent_archive")?.description).toContain("agent_save with `enabled: false`");
  });

  it("promises, in the tool that lists them, that a stored secret cannot be read back", () => {
    // The reply carries which of a server's declared environment
    // variables has a value and never the value, and a model told only
    // "GITHUB_TOKEN (set)" would reasonably go looking for the tool that
    // reads it out. Saying there is none is cheaper than the search, and
    // it is the same sentence `module_secret_set` makes. That the text
    // and the structured reply actually hold to it is proved against a
    // stored secret in dispatch.test.ts.
    const servers = TOOLS.find((tool) => tool.name === "mcp_servers_list");

    expect(servers?.description).toMatch(/never be read back/);
    // Said the same way about the names it does carry, because "set" is
    // only useful if a reader knows it is a name and not a value.
    expect(servers?.description).toMatch(/[Nn]ames only/);
  });

  /**
   * The exclusion this replaces, and why it was not simply deleted.
   *
   * `agentAttachments:set` was the last of the three attachment and
   * catalogue arguments to be held, and the list called it the sharpest:
   * the reads only enumerate an agent's surface and the catalogue writes
   * only fill a shelf, while a tick here decides what the next dispatch
   * is actually built with. The reason written against it was that a
   * client reached *through* one MCP server, choosing the set of servers
   * EO's agents get, is a tool granting itself tools with the
   * indirection taken out.
   *
   * That reading was rejected here because it names the wrong party. The
   * client is not the agent — it is a person's request relayed, which is
   * the standing under which it already calls `agent_save`, deciding the
   * prompt and the model the next dispatch runs on, and `module_save`,
   * writing code EO later runs unsandboxed with the person's privileges.
   * Handing an agent a row a person already approved onto the shelf is
   * not the larger of those three.
   *
   * The reading is kept where it is literally true, which is
   * eoServer.mjs — the `eo` server injected into EO's own dispatched
   * agents. There the actor really is the agent and there is no
   * indirection to argue about, and EO-107's `settingSources` lockdown
   * exists so that "this agent has these tools" is a true statement; a
   * running agent that could attach a server to itself would make it
   * false again. That service gains nothing here, and eoServer.test.ts
   * asserting its tool list exactly is what keeps that so.
   */
  it("lets a client choose what EO gives its agents, and asks nothing of it to do so", () => {
    // The exclusion above used to hold this one alone. It is an ordinary
    // write by the rule the gate runs on — it deletes nothing, writes no
    // secret and approves nothing — so it stands in front of a client
    // that has not opened the destructive gate, which is the whole point
    // of offering it.
    const set = TOOLS.find((tool) => tool.name === "agent_attachments_set");

    expect(set).toBeDefined();
    expect(set?.kind).toBe("write");
    expect(toolsFor(false).map((offered) => offered.name)).toContain("agent_attachments_set");
  });

  it("stays quiet before a detach, because detaching destroys nothing", () => {
    // The judgement this story had to make, and the sweep over tools
    // that destroy nothing is what enforces it: detaching drops the join
    // row and leaves the catalogue entry where it is, so the same call
    // with `attached: true` puts it back. `mcp_server_archive` is the
    // one-way half and carries the hint; a hint here would put a warning
    // in front of the reversible act and teach a client to click through
    // the one that matters.
    expect(TOOLS.find((tool) => tool.name === "agent_attachments_set")?.annotations.destructiveHint).toBeUndefined();
    expect(TOOLS.find((tool) => tool.name === "agent_attachments_set")?.annotations.idempotentHint).toBe(true);
  });

  it("says, on the tool that ticks an entry on, where each of its three ids is read", () => {
    // It takes an agent id and a catalogue id and answers in ids again,
    // so a model with none of them has to be told all three doors. The
    // same claim `agent_attachments_list` makes, on the tool that has to
    // name them before the call rather than after it.
    const set = TOOLS.find((tool) => tool.name === "agent_attachments_set");

    expect(set?.description).toContain("agents_list");
    expect(set?.description).toContain("mcp_servers_list");
    expect(set?.description).toContain("skills_list");
    // And that a tick is not retroactive, which is the thing a caller
    // watching a run in flight would otherwise wait for.
    expect(set?.description).toMatch(/next dispatch/);
  });

  /**
   * The last two exclusions, and the precedent they were decided
   * against (EO-115).
   *
   * `mcpServers:setSecret` and `mcpServers:clearSecret` were held back
   * when the rest of the catalogues were offered, and on different
   * ground from all of them. Every other channel here turned on who is
   * asking — a client is a person's request relayed, not an agent
   * writing its own surface — and these turned on the value: that a
   * third-party token must not travel through a client's transcript, and
   * that a client must not drop a credential this machine's agents run
   * on.
   *
   * That is word for word what `runtime:signInWithApiKey` and
   * `runtime:removeApiKey` are still excluded on, so this was not
   * decided by extending the earlier argument. It was decided by asking
   * which of two precedents a server's token belongs to. The runtime key
   * is EO's own operating credential — billed to the person, spent by
   * every dispatch on that backend — and a client able to write it could
   * move where this machine's work goes and who pays for it. A GitHub
   * PAT for a server somebody catalogued is a third-party token for a
   * third-party service, and EO already accepts those through
   * `module_secret_set`, on terms that meet the transcript objection
   * rather than dismissing it: the value goes into the OS keychain, no
   * channel hands one back, and the most anything says afterwards is
   * that a name has something behind it.
   *
   * So the terms are copied rather than reinvented, which is what the
   * first test below asserts against `module_secret_set` itself, and the
   * second is the promise the description has to make for the gate to be
   * an informed choice. That no value escapes into a reply is proved
   * where a value actually exists, in dispatch.test.ts.
   *
   * With these offered, the whole catalogue is: a client can add a
   * server, give it a token and tick it onto an agent without a second
   * hand anywhere. That is the residual EO-113 wrote down when it
   * declined an approval gate and EO-114 widened, restated here because
   * this is the story that finished it — the gate a person turns on is
   * now the only thing in front of it, and if EO ever becomes a shared
   * or multi-person installation this is the first thing to revisit.
   * eoServer.mjs is untouched throughout: a dispatched agent still
   * cannot give itself a server, a skill or a secret.
   */
  it("takes a server's secrets on module_secret_set's terms, down to the annotations", () => {
    // The precedent is read out of the catalog rather than restated, so
    // this cannot pass while the two have quietly drifted apart.
    const precedent = TOOLS.find((tool) => tool.name === "module_secret_set");
    const set = TOOLS.find((tool) => tool.name === "mcp_server_set_secret");
    const clear = TOOLS.find((tool) => tool.name === "mcp_server_clear_secret");

    expect(precedent?.kind).toBe("dangerous");
    for (const tool of [set, clear]) {
      expect(tool).toBeDefined();
      expect(tool?.kind, tool?.name).toBe("dangerous");
      expect(tool?.annotations, tool?.name).toEqual(precedent?.annotations);
      // Which is the whole point of the kind: dangerous operations are
      // off by default, so neither of these is offered to a client until
      // somebody at the machine turns them on.
      expect(toolsFor(false).map((offered) => offered.name), tool?.name).not.toContain(tool?.name);
      expect(toolsFor(true).map((offered) => offered.name), tool?.name).toContain(tool?.name);
    }
  });

  it("says on both of them that a value goes in and can never be read back out", () => {
    // The sentence a person is agreeing to when they open the gate. A
    // client that does not know the value is one-way will offer to read
    // one back, or overwrite one believing it can be restored — and
    // `destructiveHint` is a flag some clients act on, while this is the
    // part every model reads.
    for (const name of ["mcp_server_set_secret", "mcp_server_clear_secret"]) {
      const description = TOOLS.find((tool) => tool.name === name)?.description ?? "";

      expect(description, name).toMatch(/goes in and can never be read back out/);
      // And where the id comes from, since a secret is filed against a
      // server and there is one door to that.
      expect(description, name).toContain("mcp_servers_list");
    }
  });

  it("tells a client submitting a plan how its Jira keys are read, and that one bad key refuses the plan", () => {
    // The refusal worth spelling out here rather than on the first
    // attempt: a plan is many items, and a submitter mirroring an epic
    // copies keys down a list. Learning after the fact that a repeated
    // key created nothing at all — rather than most of it — is what
    // lets the next send be the right one.
    const submit = TOOLS.find((tool) => tool.name === "work_submit_plan")?.description ?? "";

    expect(submit).toContain("jiraKey");
    expect(submit).toContain("jira_key");
    // And that attaching reads the issue in (EO-127): a submitter that
    // thinks its wording is final will not notice that Jira's replaced
    // it, and would send the plan again to "fix" it.
    expect(submit).toMatch(/reads each issue in|read in from Jira/i);
    expect(submit).toContain("jira_pull");
    expect(submit).toMatch(/creates nothing|nothing is created/i);
    expect(submit).toContain("jiraSync");
    expect(submit).toContain("jira_sync");
  });

  it("tells a client editing an item that it can attach, detach and silence Jira", () => {
    // An agent reading the old description — "title, body, priority or
    // type" — had no reason to think attaching an issue was possible at
    // all, so it would ask a person to do it or, worse, file a second
    // item. The switch is the same problem: nothing else in the tool
    // list says an item can be told to stop talking to Jira.
    const update = TOOLS.find((tool) => tool.name === "ticket_update")?.description ?? "";

    expect(update).toContain("jiraKey");
    expect(update).toContain("jiraKey: null");
    expect(update).toContain("jiraSync");
    // And the trap the submit tools already warn about, the other way
    // round since EO-127: attaching reads the issue in, so a model that
    // sends a title alongside a key gets Jira's title, not its own.
    expect(update).toMatch(/reads the issue in/i);
    expect(update).toContain("jira_pull");
  });

  it.each(["ticket_update", "item_update"])("tells a client that %s changes dependencies after filing (EO-600)", (name) => {
    const tool = TOOLS.flatMap((candidate) => [candidate, ...(candidate.twin === undefined ? [] : [candidate.twin])]).find((candidate) => candidate.name === name);
    const description = (tool?.description ?? "").replace(/\s+/g, " ");

    expect(description).toContain("Dependencies can be changed after filing");
    expect(description).toContain("addDependsOn");
    expect(description).toContain("removeDependsOn");
    expect(description).toMatch(/refuses the whole call/);
  });

  it("tells a client submitting an item that a Jira key attaches and reads the issue in", () => {
    // The surprise a model cannot recover from otherwise (EO-127): it
    // sends a carefully written body beside a key, and the issue's own
    // text replaces it moments later. Said here so the submitter knows
    // Jira's wording wins rather than reading it as EO losing the send.
    const submit = TOOLS.find((tool) => tool.name === "work_submit_ticket")?.description ?? "";

    expect(submit).toContain("jiraKey");
    expect(submit).toMatch(/reads the issue in/i);
    expect(submit).toContain("jira_pull");
    // And the switch: what off means, and that omitting it inherits
    // rather than defaulting to on under a feature that is silent.
    expect(submit).toContain("jiraSync");
    expect(submit).toMatch(/inherit/i);
  });

  /**
   * A field named `priority` says nothing about which way it sorts, nor
   * what its numbers are called (EO-568). Each tool that takes one says
   * so, in the same words the guide and the board use.
   */
  it.each(["work_submit_plan", "work_submit_ticket", "ticket_update"])("says what priority means on %s", (name) => {
    const description = TOOLS.find((tool) => tool.name === name)?.description ?? "";

    expect(description).toMatch(/priority/i);
    expect(description).toContain("integer, 0 or more");
    expect(description).toContain("highest first");
    expect(description).toContain("0 Normal, 1 High, 2 Urgent");
  });

  it("tells a client submitting a plan that a story does not inherit its feature's priority", () => {
    const submit = TOOLS.find((tool) => tool.name === "work_submit_plan")?.description ?? "";

    expect(submit).toContain("a story sent without one is 0 whatever the feature's is");
    expect(submit).toMatch(/negative or fractional one refuses the whole plan/i);
  });

  it("tells a client that a bug keeps acceptance criteria, without demanding them", () => {
    // EO-205. The field is carried on a bug now, and a description that
    // still read as story-only would keep callers from sending what
    // they have — the criteria would stay in the caller's conversation,
    // which is where EO cannot see them.
    const submit = TOOLS.find((tool) => tool.name === "work_submit_ticket")?.description ?? "";

    expect(submit).toMatch(/acceptanceCriteria is optional on a bug and kept when you send it/i);
    // And the guide, which is where a first-time submitter is sent.
    expect(GUIDES.find((guide) => guide.name === "eo_submit_work")?.body).toMatch(/not required to declare any/i);
  });
});
