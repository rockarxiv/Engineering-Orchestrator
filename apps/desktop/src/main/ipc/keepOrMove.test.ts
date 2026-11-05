import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEEP_OR_MOVE_LINE, type RecordAdoptCounts, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createProject, getProject } from "../db/repos/projectsRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { setSetting } from "../db/repos/settingsRepo.js";
import { PREVIEW_PROJECT_KEY } from "../gallery/commands.js";
import type { AdoptRequest } from "../record/adopt.js";
import {
  keepProjectLocalCommand,
  moveProjectToRecordCommand,
  undecidedProjectsCommand,
  type KeepOrMoveContext,
} from "./projectCommands.js";

/**
 * The three channels behind the keep-or-move sheet (EO-325,
 * `ARCHITECTURE.md`, "What a person sees first", "Identity").
 *
 * `record/keepOrMove.test.ts` is where the move itself is proved, with
 * a record on the other end of it. What is proved here is the door:
 * that a solo desktop is never asked, that EO's own rehearsal is never
 * on the list, and that a move with nowhere to go is refused in a
 * sentence rather than half-performed.
 */

let handle: DbHandle;
let personId: Uuid;

beforeEach(() => {
  handle = openMigratedTestDb();
  personId = createPerson(handle.db, { name: "Anna", email: "anna@example.com" }).id;
});

afterEach(() => {
  handle.close();
});

/** A signed-in desktop whose record answers whatever the test says it does. */
function context(overrides: Partial<KeepOrMoveContext> = {}): KeepOrMoveContext {
  return {
    db: handle.db,
    signedIn: () => true,
    personId: () => personId,
    personName: () => "Anna",
    send: async () => ({ ok: false, problem: "EO could not reach https://eo.example." }),
    ...overrides,
  };
}

/**
 * A record that takes everything it is sent.
 *
 * Counted from the page rather than hard-coded, because the move now
 * compares the two and stops on a shortfall — a stub that answered
 * zero would be a stub that failed every move, and one that answered
 * a fixed number would stop being true the moment a fixture grew.
 */
function took(page: AdoptRequest["page"]): RecordAdoptCounts {
  return {
    itemTypes: page.itemTypes.length,
    pipelines: page.pipelines.length,
    steps: page.pipelines.reduce((total, one) => total + one.steps.length, 0),
    routes: page.pipelines.reduce((total, one) => total + one.routes.length, 0),
    agents: page.agents.length,
    jobs: page.jobs.length,
    occurrences: page.occurrences.length,
    items: page.items.length,
    runs: page.runs.length,
    runEvents: page.runEvents.reduce((total, batch) => total + batch.events.length, 0),
    transitions: page.transitions.length,
    comments: page.comments.length,
    mentions: page.mentions.length,
    deps: page.deps.length,
    extensions: page.extensions.length,
    attachments: page.attachments.length,
    memories: page.memories.length,
    skills: page.skills.length,
    skipped: [],
  };
}

function project(name: string, prefix: string): Uuid {
  const made = createProject(handle.db, { name, keyPrefix: prefix, managed: false });
  createTestItem(handle.db, { type: "story", title: `A ${name} thing`, stepId: "todo", projectId: made.id });
  return made.id;
}

describe("which projects the sheet asks about", () => {
  it("asks about nothing on a desktop that is not signed in", () => {
    project("Support", "SUP");

    const answer = undecidedProjectsCommand(context({ signedIn: () => false }));

    // A solo desktop has no record to move anything to, so there is no
    // question to put in front of anybody — and the sheet opens on a
    // list, so an empty list is no sheet.
    expect(answer.projects).toEqual([]);
    expect(answer.line).toBe(KEEP_OR_MOVE_LINE);
  });

  it("asks about the projects somebody already had", () => {
    project("Support", "SUP");
    project("Marketing", "MKT");

    expect(undecidedProjectsCommand(context()).projects.map((one) => one.name).sort()).toEqual(["Marketing", "Support"]);
  });

  it("never asks about the Preview project", () => {
    const preview = project("Preview", "PRV");
    project("Support", "SUP");
    // An installation that had a rehearsal before this story existed.
    setSetting(handle.db, PREVIEW_PROJECT_KEY, preview as string);

    expect(undecidedProjectsCommand(context()).projects.map((one) => one.name)).toEqual(["Support"]);
  });

  it("stops asking once a project has an answer", () => {
    const support = project("Support", "SUP");

    keepProjectLocalCommand(context(), { projectId: support });

    expect(undecidedProjectsCommand(context()).projects).toEqual([]);
    // Kept is local, which is what the switcher groups under "Local".
    expect(getProject(handle.db, support)?.managedAt).toBeNull();
    expect(getProject(handle.db, support)?.keptLocalAt).not.toBeNull();
  });
});

describe("moving one", () => {
  it("is refused, whole, when the record cannot be reached", async () => {
    const support = project("Support", "SUP");

    const answer = await moveProjectToRecordCommand(context(), { projectId: support });

    expect(answer.problem).toContain("EO could not reach");
    expect(answer.moved).toBeNull();
    // Untouched: still local, still undecided, still on the sheet —
    // which is the state it is safe to be left in.
    expect(getProject(handle.db, support)?.managedAt).toBeNull();
    expect(undecidedProjectsCommand(context()).projects.map((one) => one.name)).toEqual(["Support"]);
  });

  it("is refused when this machine is signed in to nothing at all", async () => {
    const support = project("Support", "SUP");

    const answer = await moveProjectToRecordCommand(context({ personId: () => null }), { projectId: support });

    expect(answer.problem).toContain("not signed in");
    expect(getProject(handle.db, support)?.managedAt).toBeNull();
  });

  it("marks it the record's, and whose, once every page has landed", async () => {
    const support = project("Support", "SUP");
    const sent: string[] = [];

    const answer = await moveProjectToRecordCommand(
      context({
        send: async (request) => {
          sent.push(
            [
              request.page.itemTypes.length > 0 ? "types" : "",
              request.page.pipelines.length > 0 ? "pipelines" : "",
              request.page.items.length > 0 ? "items" : "",
            ]
              .filter(Boolean)
              .join("+"),
          );
          return {
            ok: true,
            accepted: took(request.page),
          };
        },
      }),
      { projectId: support },
    );

    expect(answer.problem).toBeNull();
    expect(getProject(handle.db, support)?.managedAt).not.toBeNull();
    expect(getProject(handle.db, support)?.ownerId).toBe(personId);
    // The structure before the items, which is the dependency order the
    // record's foreign keys require and the only part of the sequence
    // that cannot be rearranged.
    expect(sent.indexOf("types+pipelines")).toBeLessThan(sent.indexOf("items"));
  });

  it("cannot be kept afterwards, because there is no way back", async () => {
    const support = project("Support", "SUP");
    await moveProjectToRecordCommand(
      context({
        send: async (request) => ({ ok: true, accepted: took(request.page) }),
      }),
      { projectId: support },
    );

    const answer = keepProjectLocalCommand(context(), { projectId: support });

    expect(answer.problem).toContain("already on the record");
    expect(getProject(handle.db, support)?.managedAt).not.toBeNull();
  });
});
