import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import type { IpcResponse, Skill } from "@eo/core";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../../../query/client";
import { ViewPublisher } from "../../../../shared/view/ViewPublisher";
import { ProjectsSection } from "./ProjectsSection";

/**
 * Settings → Projects in the chat layout: the classic section's
 * archive (EO-347), delete (EO-346), restore, rename, add, move to the
 * record (EO-325) and repository membership (KAN-17), asserted the way
 * `settings/ArchiveProject.test.tsx` and `DeleteProject.test.tsx` assert
 * them on the classic screen.
 */

type Project = IpcResponse<"projects:list">["projects"][number];
type Call = { channel: string; payload: unknown };

function project(overrides: Partial<Project> & Pick<Project, "id" | "name" | "keyPrefix">): Project {
  return { repositoryIds: [], itemCount: 3, managedAt: null, keptLocalAt: null, adoptingAt: null, archivedAt: null, preview: false, costCents: 0, ...overrides };
}

const ARCHIVE_PREVIEW: IpcResponse<"projects:archive"> = {
  archived: false,
  problem: null,
  name: "Shop",
  unfinishedCount: 3,
  running: [{ itemKey: "SHOP-2", title: "Throttle checkout" }],
  activeProjectId: "shop",
};

const DELETE_PREVIEW: IpcResponse<"projects:delete"> = {
  deleted: false,
  problem: null,
  name: "Shop",
  itemCount: 5,
  unfinishedCount: 3,
  running: [{ itemKey: "SHOP-2", title: "Throttle checkout" }],
  uncommitted: [{ itemKey: "SHOP-4", title: "Cart badge", changes: 2 }],
  deletedCount: 0,
  leftoverWorktrees: [],
  activeProjectId: "shop",
};

/** Answers `skills:list` with these, and every other channel as before (EO-470). */
/** Answers `memory:list` with one entry in the scope named, and none anywhere else (EO-481). */
function answeringMemory(scopeId: string, body: string): void {
  const prior = window.eo.ipc.invoke;
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === "memory:consolidations") return { ok: true, data: { consolidations: [] } };
    if (channel !== "memory:list") return prior(channel as never, payload as never);
    const scope = (payload as { scope: { kind: "project" | "workspace"; id: string } }).scope;
    const entries =
      scope.id === scopeId
        ? [{ id: "m1", scope, body, source: { type: "person", personId: null }, createdAt: 0, updatedAt: 0, retiredAt: null, retiredReason: null, consolidationId: null, contradictsRepositoryFile: false }]
        : [];
    return { ok: true, data: { entries } };
  }) as never;
}

/** Answers `itemTypes:list` for the project named with these, and with none for any other (EO-523). */
function answeringItemTypes(projectId: string, types: IpcResponse<"itemTypes:list">["types"]): void {
  const prior = window.eo.ipc.invoke;
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel !== "itemTypes:list") return prior(channel as never, payload as never);
    return { ok: true, data: { types: (payload as { projectId: string }).projectId === projectId ? types : [] } };
  }) as never;
}

function answeringSkills(skills: Skill[]): void {
  const prior = window.eo.ipc.invoke;
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) =>
    channel === "skills:list" ? { ok: true, data: { skills } } : prior(channel as never, payload as never),
  ) as never;
}

function projectSkill(name: string, scope: Skill["scope"], overrides: Partial<Skill> = {}): Skill {
  return { id: `skill-${name}`, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, description: "A procedure.", body: "Step one.", files: [], disableModelInvocation: false, enabled: true, scope, createdAt: 0, updatedAt: 0, archivedAt: null, ...overrides };
}

function renderProjects({
  initial,
  signedIn = false,
  leftover = [],
}: { initial?: Project[]; signedIn?: boolean; leftover?: IpcResponse<"projects:delete">["leftoverWorktrees"] } = {}) {
  let projects = initial ?? [
    project({ id: "shop", name: "Shop", keyPrefix: "SHOP", repositoryIds: ["r1"] }),
    project({ id: "theirs", name: "Theirs", keyPrefix: "ORG", managedAt: 1_700_000_000_000 }),
  ];
  const calls: Call[] = [];
  const fallback = window.eo.ipc.invoke;

  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel === "projects:list") {
      const live = projects.find((entry) => entry.archivedAt === null);
      return { ok: true, data: { projects: [...projects], activeProjectId: live?.id ?? null } };
    }
    if (channel === "repositories:list") {
      return { ok: true, data: { repositories: [{ id: "r1", name: "shop-web" }, { id: "r2", name: "shop-api" }] } };
    }
    if (channel === "session:status") return { ok: true, data: signedIn ? { state: "signed-in" } : { state: "solo" } };
    if (channel === "projects:archive") {
      const asked = payload as { projectId: string; confirm: boolean };
      if (!asked.confirm) return { ok: true, data: ARCHIVE_PREVIEW };
      projects = projects.map((entry) => (entry.id === asked.projectId ? { ...entry, archivedAt: 1_700_000_000_000 } : entry));
      return { ok: true, data: { ...ARCHIVE_PREVIEW, archived: true, activeProjectId: null } };
    }
    if (channel === "projects:restore") {
      const asked = payload as { projectId: string };
      projects = projects.map((entry) => (entry.id === asked.projectId ? { ...entry, archivedAt: null } : entry));
      return { ok: true, data: { restored: true, problem: null, name: "Shop", unfinishedCount: 3 } };
    }
    if (channel === "projects:delete") {
      const asked = payload as { projectId: string; confirm: boolean };
      if (!asked.confirm) return { ok: true, data: DELETE_PREVIEW };
      projects = projects.filter((entry) => entry.id !== asked.projectId);
      return { ok: true, data: { ...DELETE_PREVIEW, deleted: true, deletedCount: 5, leftoverWorktrees: leftover } };
    }
    if (channel === "projects:create" || channel === "projects:update" || channel === "projects:addProject" || channel === "projects:removeProject") {
      return { ok: true, data: { ok: true, problem: null } };
    }
    if (channel === "projects:moveToRecord") return { ok: true, data: { problem: null } };
    if (channel === "workspaces:create") {
      const asked = payload as { projectId: string; config: { repoPath: string } };
      if (asked.config.repoPath === "/not/a/checkout") return { ok: true, data: { ok: false, problem: "/not/a/checkout is not a git repository." } };
      projects = projects.map((entry) => (entry.id === asked.projectId ? { ...entry, repositoryIds: [...entry.repositoryIds, "r2"] } : entry));
      return { ok: true, data: { ok: true, workspace: undefined, problem: null } };
    }
    if (channel === "projects:thread") {
      const asked = payload as { projectId: string };
      return asked.projectId === "theirs"
        ? { ok: true, data: { itemId: null, problem: "This project's notes are on your organisation's record, which could not be reached: fetch failed" } }
        : { ok: true, data: { itemId: `thread-of-${asked.projectId}`, problem: null } };
    }
    return fallback(channel as never, payload as never);
  }) as never;

  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <Routes>
          <Route path="/items/:itemId" element={<OpenedItem />} />
          <Route
            path="*"
            element={
              <ViewPublisher>
                <ProjectsSection />
              </ViewPublisher>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

/** Where the item view would be, saying which item it was opened on. */
function OpenedItem() {
  const { itemId } = useParams<{ itemId: string }>();
  return <p>Item view for {itemId}</p>;
}

const on = (calls: Call[], channel: string) => calls.filter((call) => call.channel === channel).map((call) => call.payload);

describe("the list", () => {
  it("shows each project's key prefix and how much work is on it, in the project's own word", async () => {
    renderProjects();
    expect(await screen.findByLabelText("Rename Shop")).toHaveValue("Shop");
    expect(screen.getByText("SHOP")).toBeInTheDocument();
    expect(screen.getAllByText("3 tickets")).toHaveLength(2);
  });

  it("renames a project when the name loses focus, not on every keystroke", async () => {
    const calls = renderProjects();
    const name = await screen.findByLabelText("Rename Shop");

    fireEvent.change(name, { target: { value: "The shop" } });
    expect(on(calls, "projects:update")).toEqual([]);
    fireEvent.blur(name);

    await waitFor(() => expect(on(calls, "projects:update")).toEqual([{ id: "shop", name: "The shop" }]));
  });

  it("adds and removes a repository from a project", async () => {
    const calls = renderProjects();

    fireEvent.click(await screen.findByRole("button", { name: "Remove shop-web from Shop" }));
    await waitFor(() => expect(on(calls, "projects:removeProject")).toEqual([{ projectId: "shop", repositoryId: "r1" }]));

    fireEvent.click(screen.getByRole("button", { name: "Add shop-api to Shop" }));
    await waitFor(() => expect(on(calls, "projects:addProject")).toEqual([{ projectId: "shop", repositoryId: "r2" }]));
  });
});

describe("adding a repository to a project (EO-603)", () => {
  /** The button sits in the row with Archive and Delete, wherever those are shown. */
  const row = (button: HTMLElement) => button.parentElement!;

  it("offers it on every live project, the organisation's included, beside Archive and Delete", async () => {
    renderProjects();
    const shop = await screen.findByRole("button", { name: "Add a repository to Shop" });

    expect(shop).toHaveTextContent("Add a repository");
    expect(row(shop)).toContainElement(screen.getByRole("button", { name: "Archive Shop" }));
    expect(row(shop)).toContainElement(screen.getByRole("button", { name: "Delete Shop" }));
    expect(screen.getByRole("button", { name: "Add a repository to Theirs" })).toBeInTheDocument();
  });

  it("offers none on an archived project", async () => {
    renderProjects({ initial: [project({ id: "shop", name: "Shop", keyPrefix: "SHOP" }), project({ id: "old", name: "Old shop", keyPrefix: "OLD", archivedAt: 1 })] });

    fireEvent.click(await screen.findByRole("button", { name: "Show archived (1)" }));

    expect(await screen.findByRole("list", { name: "Archived projects" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add a repository to Old shop" })).toBeNull();
  });

  it("offers none on a project mid-move, and offers it again once the move has ended (EO-605)", async () => {
    const initial = [project({ id: "shop", name: "Shop", keyPrefix: "SHOP", adoptingAt: 1 }), project({ id: "other", name: "Other", keyPrefix: "OTH" })];
    renderProjects({ initial });

    expect(await screen.findByRole("button", { name: "Add a repository to Other" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add a repository to Shop" })).toBeNull();

    // Any write refreshes the list, which now reads the move as over.
    initial[0] = { ...initial[0]!, adoptingAt: null };
    const other = screen.getByLabelText("Rename Other");
    fireEvent.change(other, { target: { value: "Another" } });
    fireEvent.blur(other);

    expect(await screen.findByRole("button", { name: "Add a repository to Shop" })).toBeInTheDocument();
  });

  it("offers none on the gallery's Preview project, where saving would make a project instead (EO-604)", async () => {
    renderProjects({ initial: [project({ id: "shop", name: "Shop", keyPrefix: "SHOP" }), project({ id: "rehearsal", name: "Preview", keyPrefix: "PREVIEW", preview: true })] });

    expect(await screen.findByRole("button", { name: "Add a repository to Shop" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive Preview" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add a repository to Preview" })).toBeNull();
  });

  it("opens the repository form, pull-request settings included, naming the project", async () => {
    renderProjects();
    fireEvent.click(await screen.findByRole("button", { name: "Add a repository to Shop" }));

    const form = screen.getByRole("group", { name: "Add a repository to Shop" });
    expect(within(form).getByRole("heading", { name: "Add a repository to Shop" })).toBeInTheDocument();
    expect(within(form).getByLabelText("Repository path")).toBeInTheDocument();
    expect(within(form).getByRole("checkbox", { name: /Open a pull request/ })).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("attaches it to the project whose button was pressed, not the one on screen, and the row shows it", async () => {
    // "shop" is the one on screen; "theirs" is the one being added to.
    const calls = renderProjects();
    fireEvent.click(await screen.findByRole("button", { name: "Add a repository to Theirs" }));
    const form = screen.getByRole("group", { name: "Add a repository to Theirs" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "shop-api" } });
    fireEvent.change(within(form).getByLabelText("Repository path"), { target: { value: "/code/shop-api" } });
    fireEvent.click(within(form).getByRole("checkbox", { name: /Open a pull request/ }));
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(on(calls, "workspaces:create")).toEqual([
        { kind: "git-worktree", projectId: "theirs", config: expect.objectContaining({ name: "shop-api", repoPath: "/code/shop-api", forgeOpenPr: true }) },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole("group", { name: "Add a repository to Theirs" })).toBeNull());
    expect(await screen.findByRole("button", { name: "Remove shop-api from Theirs" })).toBeInTheDocument();
    expect(on(calls, "projects:setActive")).toEqual([]);
  });

  it("keeps the form open and says why when it is refused, and forgets that once closed", async () => {
    renderProjects();
    fireEvent.click(await screen.findByRole("button", { name: "Add a repository to Shop" }));
    const form = screen.getByRole("group", { name: "Add a repository to Shop" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "nope" } });
    fireEvent.change(within(form).getByLabelText("Repository path"), { target: { value: "/not/a/checkout" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    expect(await within(form).findByText("/not/a/checkout is not a git repository.")).toBeInTheDocument();

    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Add a repository to Shop" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add a repository to Shop" }));
    expect(screen.queryByText("/not/a/checkout is not a git repository.")).toBeNull();
  });
});

describe("the repository chips on a row that takes no new ones (EO-607)", () => {
  const SHOP = project({ id: "shop", name: "Shop", keyPrefix: "SHOP" });

  it("offers none to add on Preview, and takes off a repository already there", async () => {
    const calls = renderProjects({ initial: [SHOP, project({ id: "rehearsal", name: "Preview", keyPrefix: "PREVIEW", preview: true, repositoryIds: ["r1"] })] });

    const remove = await screen.findByRole("button", { name: "Remove shop-web from Preview" });
    expect(screen.queryByRole("button", { name: "Add shop-api to Preview" })).toBeNull();

    fireEvent.click(remove);
    await waitFor(() => expect(on(calls, "projects:removeProject")).toEqual([{ projectId: "rehearsal", repositoryId: "r1" }]));
  });

  it("leaves other rows' chips alone, the one that moves a repository off Preview included", async () => {
    const calls = renderProjects({ initial: [SHOP, project({ id: "rehearsal", name: "Preview", keyPrefix: "PREVIEW", preview: true, repositoryIds: ["r1"] })] });

    fireEvent.click(await screen.findByRole("button", { name: "Add shop-web to Shop" }));

    expect(screen.getByRole("button", { name: "Add shop-api to Shop" })).toBeInTheDocument();
    await waitFor(() => expect(on(calls, "projects:addProject")).toEqual([{ projectId: "shop", repositoryId: "r1" }]));
  });

  it("offers none to add mid-move, disables the one it has, and both return once the move has ended", async () => {
    const initial = [project({ id: "moving", name: "Moving", keyPrefix: "MOV", adoptingAt: 1, repositoryIds: ["r1"] }), project({ id: "other", name: "Other", keyPrefix: "OTH" })];
    const calls = renderProjects({ initial });

    const held = await screen.findByRole("button", { name: "Remove shop-web from Moving" });
    expect(held).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add shop-api to Moving" })).toBeNull();
    fireEvent.click(held);
    expect(on(calls, "projects:removeProject")).toEqual([]);
    expect(screen.getByRole("button", { name: "Add shop-web to Other" })).toBeEnabled();

    // Any write refreshes the list, which now reads the move as over.
    initial[0] = { ...initial[0]!, adoptingAt: null };
    const other = screen.getByLabelText("Rename Other");
    fireEvent.change(other, { target: { value: "Another" } });
    fireEvent.blur(other);

    expect(await screen.findByRole("button", { name: "Add shop-api to Moving" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove shop-web from Moving" })).toBeEnabled();
  });
});

describe("skills scoped to a project (EO-470)", () => {
  it("lists under each project the live skills scoped to it, and says so when there are none", async () => {
    answeringSkills([
      projectSkill("E2E suite", { kind: "project", projectId: "shop" }),
      projectSkill("Paused", { kind: "project", projectId: "shop" }, { enabled: false }),
      projectSkill("Gone", { kind: "project", projectId: "shop" }, { archivedAt: 1 }),
      projectSkill("A workspace's", { kind: "workspace", workspaceId: "r1" }),
    ]);
    renderProjects();

    const lines = await screen.findAllByLabelText("Skills scoped to this project");
    await waitFor(() => expect(lines[0]).toHaveTextContent("Skills scoped to this project: E2E suite, Paused (disabled)"));
    expect(lines[0]).not.toHaveTextContent("Gone");
    expect(lines[0]).not.toHaveTextContent("A workspace's");
    expect(lines[1]).toHaveTextContent("No skills are scoped to this project.");
  });
});

describe("adding a project", () => {
  it("creates one with the name and the upper-cased key prefix, and publishes what is typed meanwhile", async () => {
    const calls = renderProjects();
    fireEvent.click(await screen.findByRole("button", { name: "Add a project" }));
    const form = screen.getByLabelText("Add project");

    expect(within(form).getByRole("button", { name: "Create" })).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Payments" } });
    fireEvent.change(within(form).getByLabelText("Key prefix"), { target: { value: "pay" } });
    expect(within(form).getByLabelText("Key prefix")).toHaveValue("PAY");

    await waitFor(() => {
      const publishes = calls.filter((call) => call.channel === "view:publish");
      expect((publishes.at(-1)?.payload as { unsavedEdits: unknown }).unsavedEdits).toEqual([
        { field: "New project name", value: "Payments" },
        { field: "New project key prefix", value: "PAY" },
      ]);
    });

    fireEvent.click(within(form).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(on(calls, "projects:create")).toEqual([{ name: "Payments", keyPrefix: "PAY", repositoryIds: [] }]));
    await waitFor(() => expect(screen.queryByLabelText("Add project")).toBeNull());
  });
});

describe("archiving a project", () => {
  it("offers Archive and Delete on a local project and neither on one on the organisation's record", async () => {
    renderProjects();
    expect(await screen.findByRole("button", { name: "Archive Shop" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Shop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Theirs" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Theirs" })).toBeNull();
  });

  it("asks first, says how many unfinished tickets pause, and names the item whose agent will stop", async () => {
    const calls = renderProjects();

    fireEvent.click(await screen.findByRole("button", { name: "Archive Shop" }));
    const dialog = await screen.findByRole("dialog", { name: "Archive Shop?" });

    await waitFor(() => expect(dialog).toHaveTextContent("3 unfinished tickets pause"));
    expect(within(dialog).getByLabelText("Agents running")).toHaveTextContent("SHOP-2");
    expect(within(dialog).getByLabelText("Agents running")).toHaveTextContent("Archiving stops it");
    expect(on(calls, "projects:archive")).toEqual([{ projectId: "shop", confirm: false }]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(on(calls, "projects:archive")).toEqual([{ projectId: "shop", confirm: false }]);
  });

  it("archives on confirmation, moves it behind Show archived, and restores it from there", async () => {
    const calls = renderProjects();

    fireEvent.click(await screen.findByRole("button", { name: "Archive Shop" }));
    const dialog = await screen.findByRole("dialog", { name: "Archive Shop?" });
    const confirm = within(dialog).getByRole("button", { name: "Archive the project" });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(on(calls, "projects:archive").at(-1)).toEqual({ projectId: "shop", confirm: true });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Archive Shop" })).toBeNull());

    expect(screen.queryByRole("list", { name: "Archived projects" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Show archived (1)" }));
    const archived = await screen.findByRole("list", { name: "Archived projects" });
    expect(within(archived).getByRole("button", { name: "Delete Shop" })).toBeInTheDocument();

    fireEvent.click(within(archived).getByRole("button", { name: "Restore Shop" }));
    await waitFor(() => expect(on(calls, "projects:restore")).toEqual([{ projectId: "shop" }]));
    expect(await screen.findByRole("button", { name: "Archive Shop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show archived/ })).toBeNull();
  });

  it("offers only the way out when the main process refuses", async () => {
    renderProjects();
    const fallback = window.eo.ipc.invoke;
    window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
      if (channel === "projects:archive") return { ok: true, data: { ...ARCHIVE_PREVIEW, problem: "Shop is already being moved to the record." } };
      return fallback(channel as never, payload as never);
    }) as never;

    fireEvent.click(await screen.findByRole("button", { name: "Archive Shop" }));
    const dialog = await screen.findByRole("dialog", { name: "Archive Shop?" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already being moved");
    expect(within(dialog).queryByRole("button", { name: "Archive the project" })).toBeNull();
    // The footer's way out says Close rather than Keep it: there is nothing to keep.
    expect(within(dialog).queryByRole("button", { name: "Keep it" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Close dialog" })).toBeInTheDocument();
  });
});

describe("deleting a project", () => {
  it("asks first, says what goes, and names the items with an agent or uncommitted work", async () => {
    const calls = renderProjects();

    fireEvent.click(await screen.findByRole("button", { name: "Delete Shop" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Shop?" });

    await waitFor(() => expect(dialog).toHaveTextContent("3 unfinished tickets"));
    expect(dialog).toHaveTextContent("(5 tickets in all)");
    expect(dialog).toHaveTextContent("Every ticket on it will be deleted with its history");
    expect(within(dialog).getByLabelText("Agents running")).toHaveTextContent("SHOP-2");
    expect(within(dialog).getByLabelText("Uncommitted changes")).toHaveTextContent("SHOP-4");
    expect(within(dialog).getByLabelText("Uncommitted changes")).toHaveTextContent("keeps the branch");
    expect(on(calls, "projects:delete")).toEqual([{ projectId: "shop", confirm: false }]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(on(calls, "projects:delete")).toEqual([{ projectId: "shop", confirm: false }]);
  });

  it("deletes on confirmation and redraws without the project", async () => {
    const calls = renderProjects();

    fireEvent.click(await screen.findByRole("button", { name: "Delete Shop" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Shop?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete the project and its tickets" });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(on(calls, "projects:delete").at(-1)).toEqual({ projectId: "shop", confirm: true });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Delete Shop" })).toBeNull());
  });

  it("stays open on Escape while the delete is in flight, so what comes back is read", async () => {
    renderProjects();
    fireEvent.click(await screen.findByRole("button", { name: "Delete Shop" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Shop?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete the project and its tickets" });
    await waitFor(() => expect(confirm).toBeEnabled());
    // Hold the delete until the test lets it go.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const invoke = window.eo.ipc.invoke;
    window.eo.ipc.invoke = (async (channel: string, payload: unknown) => {
      if (channel === "projects:delete" && (payload as { confirm: boolean }).confirm) await held;
      return invoke(channel as never, payload as never);
    }) as never;

    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Delete Shop?" })).toBeInTheDocument();

    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("stays up to say where a checkout it could not remove still is", async () => {
    renderProjects({ leftover: [{ itemKey: "SHOP-4", path: "/home/dev/.eo/worktrees/SHOP-4", problem: "The directory is in use." }] });

    fireEvent.click(await screen.findByRole("button", { name: "Delete Shop" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Shop?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete the project and its tickets" });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);

    const after = await screen.findByRole("dialog", { name: "Shop was deleted" });
    expect(after).toHaveTextContent("/home/dev/.eo/worktrees/SHOP-4");
    expect(after).toHaveTextContent("The directory is in use.");
  });

  it("offers Delete on an archived project through the same confirmation", async () => {
    const calls = renderProjects({
      initial: [project({ id: "shop", name: "Shop", keyPrefix: "SHOP" }), project({ id: "old", name: "Old shop", keyPrefix: "OLD", archivedAt: 1_700_000_000_000 })],
    });

    fireEvent.click(await screen.findByRole("button", { name: "Show archived (1)" }));
    const archived = await screen.findByRole("list", { name: "Archived projects" });
    fireEvent.click(within(archived).getByRole("button", { name: "Delete Old shop" }));

    await screen.findByRole("dialog", { name: "Delete Old shop?" });
    expect(on(calls, "projects:delete")).toEqual([{ projectId: "old", confirm: false }]);
  });
});

describe("where a project lives (EO-325)", () => {
  it("says nothing about it on a desktop that has signed in to nothing", async () => {
    renderProjects();
    await screen.findByLabelText("Rename Shop");
    expect(screen.queryByRole("button", { name: "Move Shop to the record" })).toBeNull();
    expect(screen.queryByText("On this machine.")).toBeNull();
  });

  it("offers to move a local project once signed in, and says a managed one is the record's", async () => {
    const calls = renderProjects({ signedIn: true });

    fireEvent.click(await screen.findByRole("button", { name: "Move Shop to the record" }));
    await waitFor(() => expect(on(calls, "projects:moveToRecord")).toEqual([{ projectId: "shop" }]));
    expect(screen.getByText(/On your organisation’s record\./)).toBeInTheDocument();
  });
});

describe("Project notes (EO-471)", () => {
  it("opens the project's thread in the ordinary item view", async () => {
    const calls = renderProjects();

    fireEvent.click(await screen.findByRole("button", { name: "Open Shop's project notes" }));

    expect(await screen.findByText("Item view for thread-of-shop")).toBeInTheDocument();
    expect(on(calls, "projects:thread")).toEqual([{ projectId: "shop" }]);
  });

  it("says why, where the thread cannot be opened", async () => {
    renderProjects();

    fireEvent.click(await screen.findByRole("button", { name: "Open Theirs's project notes" }));

    expect(await screen.findByText(/could not be reached: fetch failed/)).toBeInTheDocument();
  });

  it("is labelled Project notes", async () => {
    renderProjects();
    expect(await screen.findAllByRole("button", { name: /project notes/ })).toHaveLength(2);
    expect(screen.getAllByText("Project notes")).toHaveLength(2);
  });
});

describe("memory (EO-481)", () => {
  it("gives each project a Memory section listing its own entries", async () => {
    renderProjects();
    answeringMemory("shop", "Remember the project.");
    const region = await screen.findByRole("region", { name: "Memory of Shop" });
    expect(await within(region).findByText("1 active entry")).toBeInTheDocument();
    fireEvent.click(within(region).getByRole("button", { name: "Show the memory of Shop" }));
    expect(within(region).getByRole("listitem", { name: "Remember the project." })).toBeInTheDocument();
  });
});

describe("item types, read-only (EO-523)", () => {
  const STORY = {
    id: "t-story",
    projectId: "shop",
    packSlug: "developer",
    slug: "story",
    label: "Story",
    plural: "Stories",
    container: false,
    specShape: {
      type: "object" as const,
      properties: { acceptance_criteria: { type: "array" as const, items: { type: "string" as const }, minItems: 1, description: "What done means." } },
      required: ["acceptance_criteria"],
    },
    itemCount: 4,
  };
  const CASE = {
    id: "t-case",
    projectId: "shop",
    packSlug: "local",
    slug: "case",
    label: "Case",
    plural: "Cases",
    container: true,
    specShape: { type: "object" as const, properties: {}, required: [] },
    itemCount: 1,
  };

  it("shows each project's types and their fields, says which a pack ships, and offers nothing to change them", async () => {
    answeringItemTypes("shop", [STORY, CASE]);
    const calls = renderProjects();

    const shop = await screen.findByLabelText("Shop's item types");
    await waitFor(() => expect(within(shop).getByLabelText("Story")).toHaveTextContent("Story / Stories · story · is the work · from the developer pack · 4 items"));
    expect(within(shop).getByLabelText("Story's fields")).toHaveTextContent("acceptance_criteria — List of text, required — What done means.");
    expect(within(shop).getByLabelText("Case")).toHaveTextContent("Case / Cases · case · holds other items · made here · 1 item");
    expect(within(shop).getByLabelText("Case")).toHaveTextContent("No fields — a title and a description only.");
    expect(shop).toHaveTextContent("to add, change or remove one, ask the assistant");
    expect(within(shop).queryByRole("button")).toBeNull();
    expect(within(shop).queryByRole("textbox")).toBeNull();
    expect(on(calls, "itemTypes:list")).toContainEqual({ projectId: "shop" });

    expect(await screen.findByLabelText("Theirs's item types")).toHaveTextContent("This project has no item types.");
    expect(calls.some((call) => call.channel.startsWith("itemTypes:") && call.channel !== "itemTypes:list")).toBe(false);
  });
});
