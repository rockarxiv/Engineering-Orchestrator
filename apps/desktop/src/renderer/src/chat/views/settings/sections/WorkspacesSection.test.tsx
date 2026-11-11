import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { Skill, WorkspaceView } from "@eo/core";
import { createQueryClient } from "../../../../query/client";
import { ViewPublisher } from "../../../../shared/view/ViewPublisher";
import { WorkspacesSection } from "./WorkspacesSection";

/**
 * Settings → Workspaces in the chat layout (EO-301): the kind first, the
 * row you edit is the row you change, the folder picker (U-09), and what
 * every open form publishes as typed and not saved (EO-192) — the claims
 * `settings/WorkspacesSection.test.tsx` and `Settings.test.tsx` make of
 * the classic section.
 */

type Call = { channel: string; payload: unknown };

function workspace(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    id: "w1",
    projectId: "b1",
    kind: "git-worktree",
    label: "shop-web",
    summary: "/code/shop-web · main",
    problem: null,
    position: 0,
    itemCount: 0,
    config: { name: "shop-web", description: null, repoPath: "/code/shop-web", baseBranch: "main" },
    ...overrides,
  };
}

/** A skill as `skills:list` answers it, scoped where a case says (EO-470). */
function scopedSkill(name: string, scope: Skill["scope"], overrides: Partial<Skill> = {}): Skill {
  return {
    id: `skill-${name}`,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name,
    description: "A procedure.",
    body: "Step one.",
    files: [],
    disableModelInvocation: false,
    enabled: true,
    scope,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null, createdBy: "person", locked: false,
    ...overrides,
  };
}

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

function renderSection(workspaces: WorkspaceView[] = [workspace()], options: { refusal?: string; picked?: string | null; projects?: number; skills?: Skill[]; previewId?: string } = {}) {
  const calls: Call[] = [];
  const fallback = window.eo.ipc.invoke;
  const projects = [
    { id: "b1", name: "Shop", keyPrefix: "SHOP", repositoryIds: ["w1"], itemCount: 0, archivedAt: null, preview: options.previewId === "b1" },
    { id: "b2", name: "Reports", keyPrefix: "REP", repositoryIds: [], itemCount: 0, archivedAt: null, preview: options.previewId === "b2" },
  ].slice(0, options.projects ?? 1);

  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel === "projects:list") return { ok: true, data: { projects, activeProjectId: "b1" } };
    if (channel === "workspaces:list") return { ok: true, data: { workspaces } };
    if (channel === "skills:list") return { ok: true, data: { skills: options.skills ?? [] } };
    if (channel === "dialog:pickDirectory") return { ok: true, data: { path: options.picked === undefined ? "/mnt/share/reports" : options.picked } };
    if (channel === "workspaces:create" || channel === "workspaces:update") {
      if (options.refusal !== undefined) return { ok: true, data: { ok: false, workspace: undefined, problem: options.refusal } };
      return { ok: true, data: { ok: true, workspace: workspaces[0], problem: null } };
    }
    if (channel === "workspaces:remove") return { ok: true, data: { ok: true, problem: null } };
    if (channel === "forge:detect") {
      return {
        ok: true,
        data: { kind: "github", remoteUrl: "git@github.com:acme/shop-web.git", cliInstalled: true, authenticated: false, templatePath: null, problem: null },
      };
    }
    return fallback(channel as never, payload as never);
  }) as never;

  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <ViewPublisher>
          <WorkspacesSection />
        </ViewPublisher>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

const on = (calls: Call[], channel: string) => calls.filter((call) => call.channel === channel).map((call) => call.payload);

function lastUnsavedEdits(calls: Call[]): { field: string; value: string }[] {
  const publishes = calls.filter((call) => call.channel === "view:publish");
  return ((publishes.at(-1)?.payload as { unsavedEdits?: { field: string; value: string }[] } | undefined)?.unsavedEdits) ?? [];
}

describe("the list", () => {
  it("says what kind each workspace is, and gives each the summary its kind has", async () => {
    renderSection([
      workspace(),
      workspace({ id: "w2", kind: "folder", label: "/mnt/share/reports", summary: "/mnt/share/reports · a subfolder per ticket", config: { path: "/mnt/share/reports", perItemSubfolder: true } }),
      workspace({ id: "w3", kind: "scratch", label: "scratch", summary: "scratch — a fresh directory per run", config: {} }),
    ]);

    const section = await screen.findByRole("region", { name: "Workspaces" });
    expect(await within(section).findByText("Repository")).toBeInTheDocument();
    expect(within(section).getByText("Folder")).toBeInTheDocument();
    expect(within(section).getByText("Scratch")).toBeInTheDocument();
    expect(within(section).getByText("/mnt/share/reports · a subfolder per ticket")).toBeInTheDocument();
  });

  it("says what is wrong with a workspace now", async () => {
    renderSection([workspace({ problem: "/code/shop-web is not there any more. If the drive it is on is unmounted, mount it." })]);
    const section = await screen.findByRole("region", { name: "Workspaces" });
    expect(await within(section).findByText("unavailable")).toBeInTheDocument();
    expect(within(section).getByText(/is not there any more/)).toBeInTheDocument();
  });

  it("offers no Edit for the kinds with nothing to configure, and removes one", async () => {
    const calls = renderSection([workspace({ id: "w3", kind: "none", label: "none", summary: "none — no disk.", config: {} })]);
    const section = await screen.findByRole("region", { name: "Workspaces" });
    fireEvent.click(await within(section).findByRole("button", { name: "Remove" }));
    expect(within(section).queryByRole("button", { name: "Edit" })).toBeNull();
    await waitFor(() => expect(on(calls, "workspaces:remove")).toEqual([{ id: "w3" }]));
  });

  it("says a project with nowhere to work runs with no disk", async () => {
    renderSection([]);
    expect(await screen.findByText(/Every step will run with no disk until you attach one/)).toBeInTheDocument();
  });

  it("offers no way to show another project: a repository added here stays on this one", async () => {
    renderSection([workspace()], { projects: 2 });
    await screen.findByText("shop-web");
    expect(screen.queryByText(/Show another project/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Reports" })).toBeNull();
  });
});

describe("skills scoped to a workspace (EO-470)", () => {
  it("lists under each workspace the live skills scoped to it, and none scoped anywhere else", async () => {
    renderSection([workspace(), workspace({ id: "w2", label: "shop-api", summary: "/code/shop-api · main" })], {
      skills: [
        scopedSkill("E2E suite", { kind: "workspace", workspaceId: "w1" }),
        scopedSkill("Release notes", { kind: "workspace", workspaceId: "w1" }, { enabled: false }),
        scopedSkill("Old one", { kind: "workspace", workspaceId: "w1" }, { archivedAt: 1 }),
        scopedSkill("For the project", { kind: "project", projectId: "b1" }),
        scopedSkill("Everywhere", { kind: "global" }),
      ],
    });

    const lines = await screen.findAllByLabelText("Skills scoped to this workspace");
    await waitFor(() => expect(lines[0]).toHaveTextContent("Skills scoped to this workspace: E2E suite, Release notes (disabled)"));
    expect(lines[0]).not.toHaveTextContent("Old one");
    expect(lines[0]).not.toHaveTextContent("For the project");
    expect(lines[1]).toHaveTextContent("No skills are scoped to this workspace.");
  });
});

describe("the Add flow", () => {
  it("asks the kind first, opens on a repository, and never asks for a key prefix", async () => {
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Add a workspace" }));
    const form = screen.getByLabelText("Add workspace");

    expect(within(form).getByLabelText("Kind")).toHaveValue("git-worktree");
    expect(within(form).getByLabelText("Repository path")).toBeInTheDocument();
    expect(within(form).queryByLabelText("Project key prefix")).toBeNull();
  });

  it("replaces the form when the kind changes", async () => {
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Add a workspace" }));
    const form = screen.getByLabelText("Add workspace");

    fireEvent.change(within(form).getByLabelText("Kind"), { target: { value: "folder" } });

    expect(within(form).queryByLabelText("Repository path")).toBeNull();
    expect(within(form).getByLabelText("Folder path")).toBeInTheDocument();
    expect(within(form).getByRole("checkbox", { name: /subfolder of its own/ })).toBeInTheDocument();
    // Nothing to save until there is a path: the directory has to exist already.
    expect(within(form).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("attaches a repository to the project on screen", async () => {
    const calls = renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Add a workspace" }));
    const form = screen.getByLabelText("Add workspace");
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "shop-api" } });
    fireEvent.change(within(form).getByLabelText("Repository path"), { target: { value: "/code/shop-api" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(on(calls, "workspaces:create").at(-1)).toMatchObject({ kind: "git-worktree", projectId: "b1", config: { name: "shop-api", repoPath: "/code/shop-api" } }));
  });

  it("attaches a folder with the path and the layout it was given, on the project on screen", async () => {
    const calls = renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Add a workspace" }));
    const form = screen.getByLabelText("Add workspace");
    fireEvent.change(within(form).getByLabelText("Kind"), { target: { value: "folder" } });

    fireEvent.click(within(form).getByRole("button", { name: "Choose" }));
    await waitFor(() => expect(within(form).getByLabelText("Folder path")).toHaveValue("/mnt/share/reports"));
    fireEvent.click(within(form).getByRole("checkbox", { name: /subfolder of its own/ }));
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(on(calls, "workspaces:create").at(-1)).toEqual({ kind: "folder", projectId: "b1", config: { path: "/mnt/share/reports", perItemSubfolder: true } }),
    );
  });

  it("asks nothing for scratch, and says so", async () => {
    const calls = renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Add a workspace" }));
    const form = screen.getByLabelText("Add workspace");

    fireEvent.change(within(form).getByLabelText("Kind"), { target: { value: "scratch" } });
    expect(within(form).getByText("Nothing to configure.")).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(on(calls, "workspaces:create").at(-1)).toEqual({ kind: "scratch", projectId: "b1", config: {} }));
  });
});

describe("saving a repository with Preview on screen (EO-607)", () => {
  const LINE = "Saving makes a new project named after this repository and switches to it.";
  const addWorkspace = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Add a workspace" }));
    return screen.getByLabelText("Add workspace");
  };

  it("says a new project is made and the window moves, for the Repository kind only", async () => {
    renderSection([], { previewId: "b1" });
    const form = await addWorkspace();
    expect(await within(form).findByText(LINE)).toBeInTheDocument();

    for (const kind of ["folder", "scratch", "none"]) {
      fireEvent.change(within(form).getByLabelText("Kind"), { target: { value: kind } });
      expect(within(form).queryByText(LINE)).toBeNull();
    }

    fireEvent.change(within(form).getByLabelText("Kind"), { target: { value: "git-worktree" } });
    expect(within(form).getByText(LINE)).toBeInTheDocument();
  });

  it("says nothing with another project on screen, while Preview exists", async () => {
    const calls = renderSection([], { projects: 2, previewId: "b2" });
    const form = await addWorkspace();

    // Asked for the project on screen, so `projects:list` has answered.
    await waitFor(() => expect(on(calls, "workspaces:list")).toContainEqual({ projectId: "b1" }));
    expect(within(form).queryByText(LINE)).toBeNull();
  });
});

describe("choosing a repository folder (U-09)", () => {
  async function openAdd(picked: string | null) {
    renderSection([workspace()], { picked });
    fireEvent.click(await screen.findByRole("button", { name: "Add a workspace" }));
    return screen.getByLabelText("Add workspace");
  }

  it("fills the path from the native picker and names the repository after the folder", async () => {
    const form = await openAdd("/home/dev/code/acme-api");
    fireEvent.click(within(form).getByRole("button", { name: "Choose" }));
    await waitFor(() => expect(within(form).getByLabelText("Repository path")).toHaveValue("/home/dev/code/acme-api"));
    expect(within(form).getByLabelText("Name")).toHaveValue("acme-api");
  });

  it("leaves a name the person already typed alone", async () => {
    const form = await openAdd("/home/dev/code/acme-api");
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "The API" } });
    fireEvent.click(within(form).getByRole("button", { name: "Choose" }));
    await waitFor(() => expect(within(form).getByLabelText("Repository path")).toHaveValue("/home/dev/code/acme-api"));
    expect(within(form).getByLabelText("Name")).toHaveValue("The API");
  });

  it("changes nothing when the picker is cancelled, and still takes a typed path", async () => {
    const form = await openAdd(null);
    fireEvent.change(within(form).getByLabelText("Repository path"), { target: { value: "/typed/by/hand" } });
    fireEvent.click(within(form).getByRole("button", { name: "Choose" }));
    await waitFor(() => expect(within(form).getByLabelText("Repository path")).toHaveValue("/typed/by/hand"));
  });
});

describe("editing one", () => {
  it("changes the row it was opened on, and holds the pull-request settings until Save", async () => {
    const calls = renderSection([
      workspace(),
      workspace({ id: "w2", label: "shop-api", summary: "/code/shop-api · main", config: { name: "shop-api", repoPath: "/code/shop-api", baseBranch: "main" } }),
    ]);
    const section = await screen.findByRole("region", { name: "Workspaces" });
    await within(section).findAllByRole("button", { name: "Edit" });
    fireEvent.click(within(section).getAllByRole("button", { name: "Edit" })[1]!);

    const form = screen.getByLabelText("Edit shop-api");
    fireEvent.click(within(form).getByRole("checkbox", { name: /Open a pull request/ }));
    expect(on(calls, "workspaces:update")).toEqual([]);
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const sent = on(calls, "workspaces:update").at(-1) as { id: string; config: { forgeOpenPr: boolean } };
      expect(sent.id).toBe("w2");
      expect(sent.config.forgeOpenPr).toBe(true);
    });
  });

  it("shows the default reviewers with the pull-request settings, and saves what was typed as a list (EO-741)", async () => {
    const calls = renderSection([workspace({ config: { name: "shop-web", repoPath: "/code/shop-web", baseBranch: "main", forgeOpenPr: true, forgeReviewers: ["alice"] } })]);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const form = screen.getByLabelText("Edit shop-web");
    const pullRequests = within(form).getByRole("group", { name: "Pull requests" });

    const field = within(pullRequests).getByLabelText("Default reviewers");
    expect(field).toHaveValue("alice");
    fireEvent.change(field, { target: { value: "alice, bob  acme/backend," } });
    expect(field).toHaveValue("alice, bob  acme/backend,");
    expect(lastUnsavedEdits(calls)).toContainEqual({ field: "Default reviewers", value: "alice,bob,acme/backend" });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const sent = on(calls, "workspaces:update").at(-1) as { id: string; config: { forgeReviewers: string[] } };
      expect(sent.config.forgeReviewers).toEqual(["alice", "bob", "acme/backend"]);
    });
  });

  it("checks an attached repository's forge and says what to fix", async () => {
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const form = screen.getByLabelText("Edit shop-web");
    fireEvent.click(within(form).getByRole("checkbox", { name: /Open a pull request/ }));
    fireEvent.click(within(form).getByRole("button", { name: "Check" }));

    const check = await within(form).findByRole("list", { name: "Forge check" });
    expect(check).toHaveTextContent("github");
    expect(check).toHaveTextContent("Signed inno");
    expect(within(check).getByText("fix this")).toBeInTheDocument();
  });

  it("shows a refused path in full, and keeps the form open so it can be corrected", async () => {
    const refusal = "/not/a/checkout is not a git repository. EO works inside a checkout that already exists on this machine.";
    renderSection([workspace()], { refusal });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const form = screen.getByLabelText("Edit shop-web");
    fireEvent.change(within(form).getByLabelText("Repository path"), { target: { value: "/not/a/checkout" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(screen.getByLabelText("Edit shop-web")).toBeInTheDocument();
  });
});

describe("what is typed and not saved (EO-192)", () => {
  it("reports an Add workspace form and a workspace editor together", async () => {
    const calls = renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(within(screen.getByLabelText("Edit shop-web")).getByLabelText("Base branch"), { target: { value: "release/next" } });
    await waitFor(() => expect(lastUnsavedEdits(calls)).toEqual([{ field: "Base branch", value: "release/next" }]));

    fireEvent.click(screen.getByRole("button", { name: "Add a workspace" }));
    fireEvent.change(within(screen.getByLabelText("Add workspace")).getByLabelText("Name"), { target: { value: "the other repo" } });

    await waitFor(() =>
      expect(lastUnsavedEdits(calls)).toEqual([
        { field: "Base branch", value: "release/next" },
        { field: "Name", value: "the other repo" },
      ]),
    );
  });

  it("says nothing for a form opened and not typed into", async () => {
    const calls = renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Add a workspace" }));
    await screen.findByLabelText("Add workspace");
    expect(lastUnsavedEdits(calls)).toEqual([]);
  });

  it("publishes a folder's layout under the project's word", async () => {
    const calls = renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Add a workspace" }));
    const form = screen.getByLabelText("Add workspace");
    fireEvent.change(within(form).getByLabelText("Kind"), { target: { value: "folder" } });
    fireEvent.click(within(form).getByRole("checkbox", { name: /subfolder of its own/ }));
    await waitFor(() => expect(lastUnsavedEdits(calls)).toEqual([{ field: "A subfolder per ticket", value: "true" }]));
  });
});

describe("memory (EO-481)", () => {
  it("gives each workspace a Memory section listing its own entries", async () => {
    renderSection([workspace()]);
    answeringMemory("w1", "Remember the workspace.");
    const region = await screen.findByRole("region", { name: "Memory of shop-web" });
    expect(await within(region).findByText("1 active entry")).toBeInTheDocument();
    fireEvent.click(within(region).getByRole("button", { name: "Show the memory of shop-web" }));
    expect(within(region).getByRole("listitem", { name: "Remember the workspace." })).toBeInTheDocument();
  });
});
