import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@eo/ui";
import { SECTION_LOCK_TEXT, type GalleryTemplateView } from "@eo/core";
import { createQueryClient } from "../../../query/client";
import { galleryKey } from "../../../query/hooks";
import { GalleryView } from "./GalleryView";

/**
 * The gallery in the chat layout (`gallery/Gallery.test.tsx` is the
 * model): the cards, the form that asks the template's own blanks, the
 * needs check it lands on, and the packs lock it sits behind.
 */

const WEEKLY: GalleryTemplateView = {
  slug: "weekly-report",
  token: "weekly-v1",
  title: "Weekly report",
  description: "Every week, EO reads a folder and writes the report.",
  version: "1.0",
  source: "Bundled with EO",
  bundled: true,
  pipelineName: "Weekly report",
  needs: [
    { key: "role:reporter", line: "An agent for the Reporter steps", met: false, why: "The Reporter steps have no agent to run on yet.", fix: null },
    { key: "workspace", line: "A folder — somewhere its work happens", met: true, why: null, fix: null },
  ],
  blanks: [
    { key: "folder", kind: "folder", label: "Where the material lives", help: "The folder EO reads.", required: true, default: "", valueType: "string", connector: null },
    { key: "schedule", kind: "schedule", label: "When it runs", help: "", required: true, default: "monday 08:00", valueType: "string", connector: null },
    { key: "keyPrefix", kind: "keyPrefix", label: "Report prefix", help: "", required: true, default: "REP", valueType: "string", connector: null },
  ],
  roleSlots: [{ stepId: "approve", name: "Approve" }],
  solo: true,
  previewable: true,
};

const FETCHED: GalleryTemplateView = { ...WEEKLY, slug: "board-pack", token: "board-v24", title: "Board pack", source: "acme.example", version: "2.4", bundled: false };

const NEEDS = [
  { key: "workspace", line: "A folder — somewhere its work happens", met: true, why: null, fix: null },
  {
    key: "backend",
    line: "A coding agent signed in",
    met: false,
    why: "Nothing on this machine is signed in, and this pack was built on claude.",
    fix: { kind: "backend", label: "Sign in", target: "claude" },
  },
];

const PEOPLE = [
  { id: "person-anna", name: "Anna" },
  { id: "person-priya", name: "Priya" },
];

function mockIpc(
  options: {
    templates?: GalleryTemplateView[];
    useProblem?: string | null;
    people?: { id: string; name: string }[];
    republished?: GalleryTemplateView[];
    locked?: string[];
  } = {},
) {
  let listings = 0;
  const invoke = vi.fn(async (channel: string, _payload?: unknown) => {
    switch (channel) {
      case "sections:list":
        return { ok: true, data: { published: [], locked: options.locked ?? [], lockText: SECTION_LOCK_TEXT } };
      case "gallery:list": {
        listings += 1;
        const templates = listings > 1 && options.republished !== undefined ? options.republished : (options.templates ?? [WEEKLY]);
        return { ok: true, data: { templates, fetched: false, people: options.people ?? [] } };
      }
      case "gallery:preview":
        return { ok: true, data: { itemId: "item-1", projectId: "p-preview", problem: null } };
      case "gallery:use":
        return { ok: true, data: { projectId: "p1", pipelineId: "pl1", jobId: "j1", needs: NEEDS, problem: options.useProblem ?? null } };
      case "gallery:needs":
        return { ok: true, data: { needs: NEEDS, jobId: "j1", problem: null } };
      case "runtime:status":
        return { ok: true, data: { runtime: null } };
      case "dialog:pickDirectory":
        return { ok: true, data: { path: "/home/anna/reports" } };
      default:
        return { ok: true, data: {} };
    }
  });
  window.eo.ipc.invoke = invoke as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;
  return invoke;
}

function PipelineBoard() {
  const { pipelineId } = useParams();
  return <span data-testid="pipeline-board">{pipelineId}</span>;
}

function renderGallery(client = createQueryClient()) {
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/gallery"]}>
          <Routes>
            <Route path="/gallery" element={<GalleryView />} />
            <Route path="/items/:itemId" element={<span data-testid="item-page" />} />
            <Route path="/pipelines/:pipelineId" element={<PipelineBoard />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

const sent = (invoke: ReturnType<typeof mockIpc>, channel: string) => invoke.mock.calls.find((call: unknown[]) => call[0] === channel)?.[1];

describe("the cards", () => {
  it("says what each template does and what it still needs", async () => {
    mockIpc();
    renderGallery();

    await screen.findByText("Weekly report");
    expect(screen.getByText("Every week, EO reads a folder and writes the report.")).toBeInTheDocument();
    expect(screen.getByText("What this needs")).toBeInTheDocument();
    expect(screen.getByText("An agent for the Reporter steps")).toBeInTheDocument();
  });

  it("shows a fetched entry's source and version beside the bundled one", async () => {
    mockIpc({ templates: [WEEKLY, FETCHED] });
    renderGallery();

    await screen.findByText("Board pack");
    expect(screen.getByText("acme.example · 2.4")).toBeInTheDocument();
    expect(screen.getByText("Bundled with EO · 1.0")).toBeInTheDocument();
  });

  it("shows no error when the index was not reached", async () => {
    mockIpc();
    renderGallery();

    await screen.findByText("Weekly report");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("takes Preview straight to the item, with the card's own token", async () => {
    const invoke = mockIpc();
    renderGallery();

    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));

    await screen.findByTestId("item-page");
    expect(sent(invoke, "gallery:preview")).toEqual({ slug: "weekly-report", token: "weekly-v1" });
  });

  it("does not offer Preview for a template that cannot be previewed", async () => {
    mockIpc({ templates: [{ ...WEEKLY, previewable: false }] });
    renderGallery();

    expect(await screen.findByRole("button", { name: "Preview" })).toBeDisabled();
  });

  it("says when this build ships no templates", async () => {
    mockIpc({ templates: [] });
    renderGallery();

    expect(await screen.findByText("This build ships no templates.")).toBeInTheDocument();
  });
});

describe("the form", () => {
  it("sends the folder and the Monday schedule the person chose", async () => {
    const invoke = mockIpc();
    renderGallery();

    fireEvent.click(await screen.findByRole("button", { name: "Use this" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose" }));
    await waitFor(() => expect(screen.getByLabelText("Where the material lives")).toHaveValue("/home/anna/reports"));
    fireEvent.change(screen.getByLabelText("When it runs — day"), { target: { value: "monday" } });
    fireEvent.change(screen.getByLabelText("When it runs — time"), { target: { value: "08:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(sent(invoke, "gallery:use")).toBeDefined());
    expect(sent(invoke, "gallery:use")).toEqual({
      slug: "weekly-report",
      token: "weekly-v1",
      answers: { folder: "/home/anna/reports", schedule: "monday 08:00", keyPrefix: "REP" },
      roleSlots: {},
      projectName: "Weekly report",
    });
  });

  it("asks the template's own blanks, hides the role picker in solo mode, and goes back", async () => {
    mockIpc();
    renderGallery();

    fireEvent.click(await screen.findByRole("button", { name: "Use this" }));

    await screen.findByText("Where the material lives");
    expect(screen.getByText("When it runs")).toBeInTheDocument();
    expect(screen.getByLabelText("Report prefix")).toHaveValue("REP");
    expect(screen.queryByLabelText("Approve")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("button", { name: "Use this" })).toBeInTheDocument();
  });

  it("offers the people EO knows outside solo mode, and sends the one chosen", async () => {
    const invoke = mockIpc({ templates: [{ ...WEEKLY, solo: false }], people: PEOPLE });
    renderGallery();

    fireEvent.click(await screen.findByRole("button", { name: "Use this" }));
    const picker = await screen.findByLabelText("Approve");
    expect(picker.tagName).toBe("SELECT");
    expect([...picker.querySelectorAll("option")].map((option) => option.textContent)).toEqual(["Anybody", "Anna", "Priya"]);

    fireEvent.change(picker, { target: { value: "person-priya" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(sent(invoke, "gallery:use")).toBeDefined());
    expect((sent(invoke, "gallery:use") as { roleSlots: Record<string, string> }).roleSlots).toEqual({ approve: "person-priya" });
  });

  it("draws a number as a number and a flag as a choice", async () => {
    const typed: GalleryTemplateView = {
      ...WEEKLY,
      blanks: [
        { key: "post.wait", kind: "stepInput", label: "Seconds to wait", help: "", required: false, default: "900", valueType: "number", connector: null },
        { key: "post.draft", kind: "stepInput", label: "Post as a draft", help: "", required: false, default: "true", valueType: "boolean", connector: null },
      ],
    };
    const invoke = mockIpc({ templates: [typed] });
    renderGallery();

    fireEvent.click(await screen.findByRole("button", { name: "Use this" }));
    const wait = await screen.findByLabelText("Seconds to wait");
    expect(wait).toHaveAttribute("type", "number");
    const draft = screen.getByLabelText("Post as a draft");
    expect(draft.tagName).toBe("SELECT");

    fireEvent.change(wait, { target: { value: "30" } });
    fireEvent.change(draft, { target: { value: "false" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(sent(invoke, "gallery:use")).toBeDefined());
    expect((sent(invoke, "gallery:use") as { answers: Record<string, string> }).answers).toEqual({ "post.wait": "30", "post.draft": "false" });
  });

  /** A pipeline that works on a repository asks for it on the form, not first on the needs check (EO-662). */
  it("asks for the repository on the form, and sends it with the answers", async () => {
    const developer: GalleryTemplateView = {
      ...WEEKLY,
      blanks: [
        { key: "keyPrefix", kind: "keyPrefix", label: "Key prefix", help: "", required: true, default: "ACME", valueType: "string", connector: null },
        { key: "repository", kind: "repository", label: "Repository", help: "The git checkout its work happens in.", required: false, default: "", valueType: "string", connector: null },
      ],
    };
    const invoke = mockIpc({ templates: [developer] });
    renderGallery();

    fireEvent.click(await screen.findByRole("button", { name: "Use this" }));
    const repository = await screen.findByLabelText("Repository");
    expect(repository).toHaveAttribute("placeholder", "/Users/you/code/your-repository");
    fireEvent.change(repository, { target: { value: "/home/anna/code/shop" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(sent(invoke, "gallery:use")).toBeDefined());
    expect((sent(invoke, "gallery:use") as { answers: Record<string, string> }).answers).toEqual({ keyPrefix: "ACME", repository: "/home/anna/code/shop" });
  });

  it("keeps the pack whose form is open when the index republishes the same slug", async () => {
    const republished: GalleryTemplateView = {
      ...WEEKLY,
      token: "weekly-v2",
      blanks: [{ key: "channel", kind: "stepInput", label: "Which channel", help: "", required: true, default: "#general", valueType: "string", connector: null }],
    };
    const invoke = mockIpc({ republished: [republished] });
    const client = createQueryClient();
    renderGallery(client);

    fireEvent.click(await screen.findByRole("button", { name: "Use this" }));
    await screen.findByText("Where the material lives");
    await client.refetchQueries({ queryKey: galleryKey });

    expect(screen.getByText("Where the material lives")).toBeInTheDocument();
    expect(screen.queryByText("Which channel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(sent(invoke, "gallery:use")).toBeDefined());
    expect((sent(invoke, "gallery:use") as { token: string }).token).toBe("weekly-v1");
  });

  it("lands on the needs check, and opens the pipeline it installed", async () => {
    mockIpc();
    renderGallery();

    fireEvent.click(await screen.findByRole("button", { name: "Use this" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));

    await screen.findByText("Weekly report is set up");
    expect(screen.getByText(/1 thing left before real work runs/)).toBeInTheDocument();
    expect(screen.getByText("A coding agent signed in")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Go to the board" }));
    expect(await screen.findByTestId("pipeline-board")).toHaveTextContent("pl1");
  });

  it("stays on the form and says why when the main process refused", async () => {
    mockIpc({ useProblem: "REP is already in use by another project." });
    renderGallery();

    fireEvent.click(await screen.findByRole("button", { name: "Use this" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));

    expect(await screen.findByText("REP is already in use by another project.")).toBeInTheDocument();
    expect(screen.queryByText("Weekly report is set up")).not.toBeInTheDocument();
  });
});

describe("a packs section the organisation publishes", () => {
  it("draws the lock and fences the gallery's controls", async () => {
    mockIpc({ locked: ["packs"] });
    renderGallery();

    expect(await screen.findByTestId("managed-lock-packs")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Use this" })).toBeDisabled();
  });

  it("draws no lock when nothing is published", async () => {
    mockIpc();
    renderGallery();

    await screen.findByText("Weekly report");
    expect(screen.queryByTestId("managed-lock-packs")).toBeNull();
  });
});
