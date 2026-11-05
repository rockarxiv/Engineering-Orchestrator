import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developerRegistry, outputSchemaFor, SECTION_LOCK_TEXT, toRegistryView } from "@eo/core";
import type { ActionRouteUse, ActionUse, RegistryView } from "@eo/core";
import { createQueryClient } from "../../../query/client";
import { setBridge } from "../../../ipc/bridge";
import { ActionsSection } from "./ActionsSection";

/**
 * The Actions section of the agent screen (EO-427), against a main
 * process that behaves like the real one where it matters: a save is
 * kept, so reopening reads what was written, and `registry:get` answers
 * with it from then on.
 */

type ActionView = NonNullable<RegistryView["roleActions"]>[number]["actions"][number];
type Call = { channel: string; payload: unknown };

interface Options {
  /** Definitions already saved, by role. */
  defined?: Record<string, ActionView[]>;
  locked?: boolean;
  /** The steps dispatching a pair, by `role action`, each with the keys it routes — what `roleActions:inspect` answers. */
  uses?: Record<string, ActionRouteUse[]>;
  /** `roleActions:inspect` answered some other way: never, or with a failure. */
  inspect?: () => Promise<unknown>;
  /** What the save refuses with, instead of saving. */
  refuse?: string[];
}

const QUALITY: ActionUse = { pipelineId: "p1", pipelineName: "Quality", stepId: "s1", stepName: "Check" };

function mockIpc(options: Options = {}): Call[] {
  const calls: Call[] = [];
  const defined = new Map(Object.entries(options.defined ?? {}).map(([role, actions]) => [role, [...actions]]));
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    switch (channel) {
      case "registry:get":
        return {
          ok: true,
          data: { ...toRegistryView(developerRegistry()), roleActions: [...defined].map(([role, actions]) => ({ role, actions })) } satisfies RegistryView,
        };
      case "roleActions:save": {
        if (options.refuse) return { ok: true, data: { saved: false, definition: null, problems: options.refuse } };
        const draft = payload as { role: string; action: string; description: string; results: ActionView["results"]; fields: Record<string, unknown> };
        const previous = defined.get(draft.role) ?? [];
        const kept = previous.find((entry) => entry.action === draft.action);
        const saved: ActionView = { action: draft.action, description: draft.description, results: draft.results, fields: draft.fields, packShipped: false, usedBy: kept?.usedBy ?? [] };
        defined.set(draft.role, [...previous.filter((entry) => entry.action !== draft.action), saved]);
        return { ok: true, data: { saved: true, definition: { id: "d1", ...draft, createdAt: 1, updatedAt: 1 }, problems: [] } };
      }
      case "roleActions:delete": {
        const { role, action } = payload as { role: string; action: string };
        defined.set(role, (defined.get(role) ?? []).filter((entry) => entry.action !== action));
        return { ok: true, data: { deleted: true, problem: null, usedBy: [] } };
      }
      case "roleActions:inspect": {
        if (options.inspect) return options.inspect();
        const { role, action } = payload as { role: string; action: string };
        // A pack's action in the pack's own shape, as the main process answers; a role's own is drawn from the draft and not read from here.
        return { ok: true, data: { providerSchema: outputSchemaFor(developerRegistry(), action, undefined, role) ?? null, uses: options.uses?.[`${role} ${action}`] ?? [] } };
      }
      case "sections:list":
        return {
          ok: true,
          data: {
            published: options.locked
              ? [{ section: "agents", subjectId: "", versionId: null, versionNumber: null, publishedAt: 1, publishedBy: "dana-id", publishedByName: "Dana", document: null }]
              : [],
            locked: options.locked ? ["agents"] : [],
            lockText: SECTION_LOCK_TEXT,
          },
        };
      default:
        return { ok: true, data: {} };
    }
  }) as never;
  return calls;
}

/** One section per role given — two of one role is two agents sharing it, as the agent screen would draw them in turn. */
function renderSections(options: Options, ...roles: string[]): Call[] {
  const calls = mockIpc(options);
  render(
    <QueryClientProvider client={createQueryClient()}>
      {roles.map((role, index) => (
        <div key={index} data-testid={`agent-${String(index)}`}>
          <ActionsSection role={role} locked={options.locked === true} />
        </div>
      ))}
    </QueryClientProvider>,
  );
  return calls;
}

async function row(action: string, within_: HTMLElement = document.body) {
  const list = await within(within_).findByRole("list", { name: "Actions" });
  return within(list).findByRole("listitem", { name: action });
}

/** Presses a save once it is offered: a change of result keys is held until what it affects has been worked out. */
async function press(scope: HTMLElement, name: string) {
  const button = within(scope).getByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

function saves(calls: Call[]): Record<string, unknown>[] {
  return calls.filter((call) => call.channel === "roleActions:save").map((call) => call.payload as Record<string, unknown>);
}

const ALIGNMENT: ActionView = {
  action: "alignment",
  description: "Check the work against the brief.",
  results: [
    { key: "aligned", label: "Aligned", meaning: "Every criterion is met." },
    { key: "gaps_found", label: "Gaps found", meaning: "At least one is not." },
  ],
  packShipped: false,
  fields: { type: "object", properties: { notes: { type: "string" } }, required: ["notes"] },
  usedBy: [QUALITY],
};

afterEach(() => {
  cleanup();
  setBridge(undefined);
});

describe("the list", () => {
  it("shows the shipped reviewer's review, read-only, with its three result keys", async () => {
    renderSections({}, "reviewer");
    const review = await row("review");

    const keys = within(review).getByLabelText("Results of review");
    expect(within(keys).getByText("approved")).toBeInTheDocument();
    expect(within(keys).getByText("changes_requested")).toBeInTheDocument();
    expect(within(keys).getByText("needs_user_input")).toBeInTheDocument();
    expect(within(review).getByText(/read-only/)).toBeInTheDocument();

    // Opened, it is a description of the action: nothing to type into and nothing to save.
    expect(within(review).queryByRole("button", { name: "Edit review" })).toBeNull();
    fireEvent.click(within(review).getByRole("button", { name: "View review" }));
    const open = within(review).getByRole("region", { name: "Action review" });
    expect(within(open).queryAllByRole("textbox")).toHaveLength(0);
    expect(within(open).queryByRole("button", { name: /Save|Delete/ })).toBeNull();
  });

  it("shows a shipped action's provider schema as the main process holds it, not one generated from its keys", async () => {
    const calls = renderSections({}, "reviewer");
    fireEvent.click(within(await row("review")).getByRole("button", { name: "View review" }));

    const schema = await screen.findByLabelText("Provider schema");
    expect(calls.find((call) => call.channel === "roleActions:inspect")?.payload).toEqual({ role: "reviewer", action: "review" });
    expect(JSON.parse(schema.textContent ?? "")).toEqual(JSON.parse(JSON.stringify(outputSchemaFor(developerRegistry(), "review", undefined, "reviewer"))));
    // The reviewer's verdict shape: nothing a list of result keys could have produced.
    expect(schema.textContent).toContain('"verdict"');
  });

  it("says so rather than drawing nothing when the shipped schema cannot be read", async () => {
    renderSections({ inspect: async () => ({ ok: false, error: { message: "the registry would not load" } }) }, "reviewer");
    fireEvent.click(within(await row("review")).getByRole("button", { name: "View review" }));

    expect(await screen.findByText("the registry would not load")).toBeInTheDocument();
    expect(screen.queryByLabelText("Provider schema")).toBeNull();
  });

  it("lists every action a role defines for itself, with its keys and the steps that use it", async () => {
    renderSections({ defined: { qa: [ALIGNMENT, { ...ALIGNMENT, action: "smoke", results: [{ key: "passed", label: "Passed" }], usedBy: [] }] } }, "qa");

    const alignment = await row("alignment");
    expect(within(within(alignment).getByLabelText("Results of alignment")).getByText("gaps_found")).toBeInTheDocument();
    expect(within(alignment).getByText("used by 1 step")).toBeInTheDocument();
    expect(within(await row("smoke")).getByText("not used by a step")).toBeInTheDocument();

    fireEvent.click(within(alignment).getByRole("button", { name: "Edit alignment" }));
    const uses = within(alignment).getByRole("list", { name: "Steps using this action" });
    expect(within(uses).getByText('"Check" (Quality)')).toBeInTheDocument();
  });

  it("says so where a role has no actions at all", async () => {
    renderSections({}, "qa");
    expect(await screen.findByText(/This role defines no actions yet/)).toBeInTheDocument();
  });
});

describe("creating and reopening", () => {
  it("saves two results and a required text field, and shows the same values when reopened", async () => {
    const calls = renderSections({}, "qa");
    fireEvent.click(await screen.findByRole("button", { name: "New action" }));
    const form = screen.getByRole("region", { name: "New action" });

    fireEvent.change(within(form).getByLabelText("Action"), { target: { value: "alignment" } });
    fireEvent.change(within(form).getByLabelText("Description"), { target: { value: "Check the work against the brief." } });
    fireEvent.change(within(form).getByLabelText("Result 1 key"), { target: { value: "aligned" } });
    fireEvent.change(within(form).getByLabelText("Result 1 when to return it"), { target: { value: "Every criterion is met." } });
    fireEvent.click(within(form).getByRole("button", { name: "Add result" }));
    fireEvent.change(within(form).getByLabelText("Result 2 key"), { target: { value: "gaps_found" } });
    fireEvent.change(within(form).getByLabelText("Result 2 label"), { target: { value: "Gaps found" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add field" }));
    fireEvent.change(within(form).getByLabelText("Field 1 name"), { target: { value: "notes" } });
    fireEvent.click(within(form).getByLabelText("Field 1 required"));
    await press(form, "Create action");

    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(saves(calls)[0]).toEqual({
      role: "qa",
      action: "alignment",
      description: "Check the work against the brief.",
      results: [
        { key: "aligned", label: "", meaning: "Every criterion is met." },
        { key: "gaps_found", label: "Gaps found", meaning: "" },
      ],
      fields: { type: "object", properties: { notes: { type: "string" } }, required: ["notes"] },
    });

    // Closed on a save, and read back from the registry rather than from what was typed.
    const saved = await row("alignment");
    expect(screen.queryByRole("region", { name: "New action" })).toBeNull();
    fireEvent.click(within(saved).getByRole("button", { name: "Edit alignment" }));
    const reopened = within(saved).getByRole("region", { name: "Action alignment" });
    expect(within(reopened).getByLabelText("Action")).toHaveValue("alignment");
    expect(within(reopened).getByLabelText("Action")).toBeDisabled();
    expect(within(reopened).getByLabelText("Description")).toHaveValue("Check the work against the brief.");
    expect(within(reopened).getByLabelText("Result 1 key")).toHaveValue("aligned");
    expect(within(reopened).getByLabelText("Result 2 key")).toHaveValue("gaps_found");
    expect(within(reopened).getByLabelText("Result 2 label")).toHaveValue("Gaps found");
    expect(within(reopened).getByLabelText("Field 1 name")).toHaveValue("notes");
    expect(within(reopened).getByLabelText("Field 1 type")).toHaveValue("text");
    expect(within(reopened).getByLabelText("Field 1 required")).toBeChecked();
  });

  it("shows two agents sharing a role the same actions, and an edit from either on the other", async () => {
    renderSections({ defined: { qa: [ALIGNMENT] } }, "qa", "qa");
    const first = screen.getByTestId("agent-0");
    const second = screen.getByTestId("agent-1");
    expect(await row("alignment", first)).toBeInTheDocument();
    expect(await row("alignment", second)).toBeInTheDocument();

    fireEvent.click(within(first).getByRole("button", { name: "Edit alignment" }));
    fireEvent.change(within(first).getByLabelText("Result 2 key"), { target: { value: "off_brief" } });
    await press(first, "Save action");

    await waitFor(() => expect(within(within(second).getByLabelText("Results of alignment")).getByText("off_brief")).toBeInTheDocument());
    expect(within(second).queryByText("gaps_found")).toBeNull();
  });

  it("refreshes an untouched editor, and a read-only view, already open on the other agent", async () => {
    renderSections({ defined: { qa: [ALIGNMENT] } }, "qa", "qa");
    const first = screen.getByTestId("agent-0");
    const second = screen.getByTestId("agent-1");
    fireEvent.click(within(await row("alignment", first)).getByRole("button", { name: "Edit alignment" }));
    fireEvent.click(within(await row("alignment", second)).getByRole("button", { name: "Edit alignment" }));
    expect(within(second).getByLabelText("Result 2 key")).toHaveValue("gaps_found");

    fireEvent.change(within(first).getByLabelText("Result 2 key"), { target: { value: "off_brief" } });
    fireEvent.change(within(first).getByLabelText("Description"), { target: { value: "Reworded." } });
    fireEvent.change(within(first).getByLabelText("Field 1 name"), { target: { value: "remarks" } });
    await press(first, "Save action");

    // The editor nobody typed into follows the save: its results, its fields and the schema drawn from them.
    await waitFor(() => expect(within(second).getByLabelText("Result 2 key")).toHaveValue("off_brief"));
    expect(within(second).getByLabelText("Description")).toHaveValue("Reworded.");
    expect(within(second).getByLabelText("Field 1 name")).toHaveValue("remarks");
    expect(within(second).getByLabelText("Provider schema").textContent).toContain('"off_brief"');
    expect(within(second).getByLabelText("Provider schema").textContent).not.toContain('"gaps_found"');
    expect(within(second).queryByText(/changed somewhere else/)).toBeNull();
  });

  it("refreshes a managed read-only view that is open when the definition changes", async () => {
    const calls = mockIpc({ defined: { qa: [ALIGNMENT] } });
    const client = createQueryClient();
    render(
      <QueryClientProvider client={client}>
        <div data-testid="managed">
          <ActionsSection role="qa" locked />
        </div>
        <div data-testid="editing">
          <ActionsSection role="qa" locked={false} />
        </div>
      </QueryClientProvider>,
    );
    const managed = screen.getByTestId("managed");
    const editing = screen.getByTestId("editing");
    fireEvent.click(within(await row("alignment", managed)).getByRole("button", { name: "View alignment" }));
    fireEvent.click(within(await row("alignment", editing)).getByRole("button", { name: "Edit alignment" }));

    fireEvent.change(within(editing).getByLabelText("Result 2 key"), { target: { value: "off_brief" } });
    await press(editing, "Save action");

    await waitFor(() => expect(within(managed).getByLabelText("Result 2 key")).toHaveValue("off_brief"));
    expect(within(managed).getByLabelText("Result 2 key")).toBeDisabled();
    expect(saves(calls)).toHaveLength(1);
  });

  it("asks before a draft somebody has typed into is saved over a change made elsewhere", async () => {
    const calls = renderSections({ defined: { qa: [ALIGNMENT] } }, "qa", "qa");
    const first = screen.getByTestId("agent-0");
    const second = screen.getByTestId("agent-1");
    fireEvent.click(within(await row("alignment", first)).getByRole("button", { name: "Edit alignment" }));
    fireEvent.click(within(await row("alignment", second)).getByRole("button", { name: "Edit alignment" }));

    // The second editor has a draft of its own when the first one saves.
    fireEvent.change(within(second).getByLabelText("Description"), { target: { value: "Mine." } });
    fireEvent.change(within(first).getByLabelText("Result 2 key"), { target: { value: "off_brief" } });
    await press(first, "Save action");

    expect(await within(second).findByText(/changed somewhere else/)).toBeInTheDocument();
    // Neither replaced nor saveable until somebody has said which.
    expect(within(second).getByLabelText("Description")).toHaveValue("Mine.");
    expect(within(second).getByLabelText("Result 2 key")).toHaveValue("gaps_found");
    expect(within(second).getByRole("button", { name: "Save action" })).toBeDisabled();

    fireEvent.click(within(second).getByRole("button", { name: "Load the saved version" }));
    expect(within(second).getByLabelText("Description")).toHaveValue("Check the work against the brief.");
    expect(within(second).getByLabelText("Result 2 key")).toHaveValue("off_brief");
    expect(within(second).queryByText(/changed somewhere else/)).toBeNull();
    expect(saves(calls)).toHaveLength(1);
  });

  it("saves a kept draft over the change only once that was chosen", async () => {
    const calls = renderSections({ defined: { qa: [ALIGNMENT] } }, "qa", "qa");
    const first = screen.getByTestId("agent-0");
    const second = screen.getByTestId("agent-1");
    fireEvent.click(within(await row("alignment", first)).getByRole("button", { name: "Edit alignment" }));
    fireEvent.click(within(await row("alignment", second)).getByRole("button", { name: "Edit alignment" }));
    fireEvent.change(within(second).getByLabelText("Description"), { target: { value: "Mine." } });
    fireEvent.change(within(first).getByLabelText("Description"), { target: { value: "Theirs." } });
    await press(first, "Save action");

    fireEvent.click(await within(second).findByRole("button", { name: "Keep my edits" }));
    await waitFor(() => expect(within(second).getByRole("button", { name: "Save action" })).toBeEnabled());
    await press(second, "Save action");

    await waitFor(() => expect(saves(calls)).toHaveLength(2));
    expect(saves(calls)[1]).toMatchObject({ description: "Mine." });
  });

  it("deletes a definition only once asked twice", async () => {
    const calls = renderSections({ defined: { qa: [{ ...ALIGNMENT, usedBy: [] }] } }, "qa");
    fireEvent.click(within(await row("alignment")).getByRole("button", { name: "Edit alignment" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete action" }));
    expect(calls.some((call) => call.channel === "roleActions:delete")).toBe(false);

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete action" }));
    await waitFor(() => expect(calls.find((call) => call.channel === "roleActions:delete")?.payload).toEqual({ role: "qa", action: "alignment" }));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "alignment" })).toBeNull());
  });
});

describe("the field list and the JSON view", () => {
  async function openAlignment(options: Options = { defined: { qa: [ALIGNMENT] } }) {
    const calls = renderSections(options, "qa");
    const item = await row("alignment");
    fireEvent.click(within(item).getByRole("button", { name: "Edit alignment" }));
    return { calls, form: within(item).getByRole("region", { name: "Action alignment" }) };
  }
  const toJson = (form: HTMLElement) => fireEvent.click(within(form).getByRole("radio", { name: "JSON" }));
  const toList = (form: HTMLElement) => fireEvent.click(within(form).getByRole("radio", { name: "List" }));
  const schemaIn = (form: HTMLElement) => JSON.parse((within(form).getByLabelText("Fields schema") as HTMLTextAreaElement).value) as Record<string, unknown>;

  it("shows an edit made in the list in the JSON view", async () => {
    const { form } = await openAlignment();
    fireEvent.click(within(form).getByRole("button", { name: "Add field" }));
    fireEvent.change(within(form).getByLabelText("Field 2 name"), { target: { value: "gaps" } });
    fireEvent.change(within(form).getByLabelText("Field 2 type"), { target: { value: "text_list" } });

    toJson(form);
    expect(schemaIn(form)).toEqual({ type: "object", properties: { notes: { type: "string" }, gaps: { type: "array", items: { type: "string" } } }, required: ["notes"] });
  });

  it("shows an edit made in the JSON view in the list", async () => {
    const { form } = await openAlignment();
    toJson(form);
    fireEvent.change(within(form).getByLabelText("Fields schema"), {
      target: { value: JSON.stringify({ type: "object", properties: { blocking: { type: "boolean" }, score: { type: "number" } }, required: ["score"] }) },
    });

    toList(form);
    expect(within(form).getByLabelText("Field 1 name")).toHaveValue("blocking");
    expect(within(form).getByLabelText("Field 1 type")).toHaveValue("boolean");
    expect(within(form).getByLabelText("Field 1 required")).not.toBeChecked();
    expect(within(form).getByLabelText("Field 2 name")).toHaveValue("score");
    expect(within(form).getByLabelText("Field 2 type")).toHaveValue("number");
    expect(within(form).getByLabelText("Field 2 required")).toBeChecked();
  });

  it("marks a field the list cannot express as JSON-only, and saves it unchanged from the list view", async () => {
    const fields = {
      type: "object",
      properties: { severity: { type: "string", enum: ["low", "high"] }, notes: { type: "string" } },
      required: ["severity"],
      additionalProperties: false,
    };
    const { calls, form } = await openAlignment({ defined: { qa: [{ ...ALIGNMENT, fields }] } });

    const severity = within(within(form).getByRole("list", { name: "Fields" })).getByRole("listitem", { name: "severity" });
    expect(within(severity).getByText("Editable in the JSON view only")).toBeInTheDocument();
    expect(within(severity).queryByRole("textbox")).toBeNull();
    expect(within(severity).queryByRole("combobox")).toBeNull();

    // A save made from the list, after a change to the field beside it.
    fireEvent.click(within(form).getByLabelText("Field 2 required"));
    await press(form, "Save action");

    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    const saved = saves(calls)[0]!["fields"] as typeof fields;
    expect(saved.properties.severity).toEqual({ type: "string", enum: ["low", "high"] });
    expect(saved).toEqual({ ...fields, required: ["severity", "notes"] });
  });

  it("keeps a JSON-only property named __proto__ when another row is changed from the list", async () => {
    // As it arrives over IPC: parsed JSON, where `__proto__` is an own property like any other.
    const fields = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string","enum":["low","high"]},"notes":{"type":"string"}}}') as Record<string, unknown>;
    const { calls, form } = await openAlignment({ defined: { qa: [{ ...ALIGNMENT, fields }] } });

    const proto = within(within(form).getByRole("list", { name: "Fields" })).getByRole("listitem", { name: "__proto__" });
    expect(within(proto).getByText("Editable in the JSON view only")).toBeInTheDocument();

    fireEvent.click(within(form).getByLabelText("Field 2 required"));
    toJson(form);
    expect((within(form).getByLabelText("Fields schema") as HTMLTextAreaElement).value).toContain('"__proto__"');
    await press(form, "Save action");

    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(JSON.stringify(saves(calls)[0]!["fields"])).toBe(
      '{"type":"object","properties":{"__proto__":{"type":"string","enum":["low","high"]},"notes":{"type":"string"}},"required":["notes"]}',
    );
  });

  it("saves a schema the list never touched byte for byte", async () => {
    const fields = { properties: { when: { type: "string", format: "date" } }, $defs: { x: { type: "integer" } } };
    const { calls, form } = await openAlignment({ defined: { qa: [{ ...ALIGNMENT, fields }] } });
    fireEvent.change(within(form).getByLabelText("Description"), { target: { value: "Reworded." } });
    await press(form, "Save action");

    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(JSON.stringify(saves(calls)[0]!["fields"])).toBe(JSON.stringify(fields));
  });

  it("will not save text that is not JSON, and says what the parser said", async () => {
    const { calls, form } = await openAlignment();
    toJson(form);
    fireEvent.change(within(form).getByLabelText("Fields schema"), { target: { value: '{ "type": ' } });

    let parsers = "";
    try {
      JSON.parse('{ "type": ');
    } catch (error) {
      parsers = (error as Error).message;
    }
    expect(within(form).getByText(parsers)).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Save action" })).toBeDisabled();

    // And the list does not pretend to show it.
    toList(form);
    expect(within(form).getByText(/not JSON yet/)).toBeInTheDocument();
    expect(saves(calls)).toHaveLength(0);
  });

  it("shows the compiler's own message when the save refuses a schema it cannot compile, and keeps the draft", async () => {
    const compilers = 'The fields are not a JSON Schema EO can read: schema is invalid: data/properties/notes/type must be equal to one of the allowed values';
    const { form } = await openAlignment({ defined: { qa: [ALIGNMENT] }, refuse: [compilers] });
    toJson(form);
    const bad = JSON.stringify({ type: "object", properties: { notes: { type: "strnig" } } });
    fireEvent.change(within(form).getByLabelText("Fields schema"), { target: { value: bad } });
    await press(form, "Save action");

    const refusal = await within(form).findByRole("alert");
    expect(within(refusal).getByText(compilers)).toBeInTheDocument();
    expect(within(form).getByLabelText("Fields schema")).toHaveValue(bad);
  });

  it("shows the exact provider schema: result as an enum of the declared keys, summary required, then the fields", async () => {
    const { form } = await openAlignment();
    const read = () => JSON.parse(within(form).getByLabelText("Provider schema").textContent ?? "") as { properties: { outcome: { anyOf: Record<string, unknown>[] } } };
    const answer = () => read().properties.outcome.anyOf[1] as { properties: Record<string, { enum?: string[] }>; required: string[] };

    expect(answer().properties["result"]).toEqual({ type: "string", enum: ["aligned", "gaps_found"] });
    expect(answer().required).toEqual(["result", "summary", "notes"]);
    expect(Object.keys(answer().properties)).toEqual(["result", "summary", "notes"]);

    // Drawn from the draft, so it is what a save would hand over.
    fireEvent.change(within(form).getByLabelText("Result 2 key"), { target: { value: "off_brief" } });
    expect(answer().properties["result"]?.enum).toEqual(["aligned", "off_brief"]);
  });
});

describe("what a change of keys does to the steps that route on them", () => {
  const CHECK: ActionRouteUse = { ...QUALITY, routedKeys: ["aligned", "gaps_found"] };
  const OLDER: ActionRouteUse = { pipelineId: "p2", pipelineName: "Delivery", stepId: "s9", stepName: "Audit", routedKeys: ["aligned", "gaps_found"], finishing: { version: 3, items: 2 } };

  async function openUsed(options: Options) {
    const calls = renderSections({ defined: { qa: [ALIGNMENT] }, ...options }, "qa");
    const item = await row("alignment");
    fireEvent.click(within(item).getByRole("button", { name: "Edit alignment" }));
    return { calls, form: within(item).getByRole("region", { name: "Action alignment" }) };
  }

  it("names the pipeline and step routing on a key that is being removed, before saving", async () => {
    const { form } = await openUsed({ uses: { "qa alignment": [CHECK] } });
    expect(within(form).queryByRole("list", { name: "Routes affected" })).toBeNull();

    fireEvent.click(within(form).getByRole("button", { name: "Remove result 2" }));
    const affected = await within(form).findByRole("list", { name: "Routes affected" });
    expect(within(affected).getByText(/Removing "gaps_found": "Check" \(Quality\) routes on it/)).toBeInTheDocument();
  });

  it("names the steps that will have no route for a key that is being added", async () => {
    const { form } = await openUsed({ uses: { "qa alignment": [CHECK] } });
    fireEvent.click(within(form).getByRole("button", { name: "Add result" }));
    fireEvent.change(within(form).getByLabelText("Result 3 key"), { target: { value: "blocked" } });

    const affected = await within(form).findByRole("list", { name: "Routes affected" });
    expect(within(affected).getByText(/Adding "blocked": "Check" \(Quality\) will have no route for it/)).toBeInTheDocument();
  });

  it("says nothing about a removed key no step routed on, or an added one a step already routes", async () => {
    const { form } = await openUsed({ uses: { "qa alignment": [{ ...CHECK, routedKeys: ["aligned", "blocked"] }] } });
    fireEvent.click(within(form).getByRole("button", { name: "Remove result 2" }));
    fireEvent.click(within(form).getByRole("button", { name: "Add result" }));
    fireEvent.change(within(form).getByLabelText("Result 2 key"), { target: { value: "blocked" } });

    // Worked out, and nothing to say: the save is offered.
    await waitFor(() => expect(within(form).getByRole("button", { name: "Save action" })).toBeEnabled());
    expect(within(form).queryByRole("list", { name: "Routes affected" })).toBeNull();
  });

  it("includes a step only an older version still has, naming the version and the work finishing on it", async () => {
    const { form } = await openUsed({ uses: { "qa alignment": [CHECK, OLDER] } });
    fireEvent.click(within(form).getByRole("button", { name: "Remove result 2" }));
    fireEvent.click(within(form).getByRole("button", { name: "Add result" }));
    fireEvent.change(within(form).getByLabelText("Result 2 key"), { target: { value: "blocked" } });

    const affected = await within(form).findByRole("list", { name: "Routes affected" });
    expect(within(affected).getByText(/Removing "gaps_found": "Check" \(Quality\), "Audit" \(Delivery v3, 2 tickets still finishing on it\) routes on it/)).toBeInTheDocument();
    expect(within(affected).getByText(/Adding "blocked": "Check" \(Quality\), "Audit" \(Delivery v3, 2 tickets still finishing on it\) will have no route for it/)).toBeInTheDocument();
    expect(within(form).getByText(/A step of an older version cannot be edited/)).toBeInTheDocument();
  });

  it("does not offer the save while what a change of keys affects is still being worked out", async () => {
    let answer: (value: { ok: false; error: { message: string } }) => void = () => undefined;
    const { calls, form } = await openUsed({ inspect: () => new Promise((resolve) => (answer = resolve)) });
    // Nothing about the keys has changed yet, so there is nothing to wait for.
    fireEvent.change(within(form).getByLabelText("Description"), { target: { value: "Reworded." } });
    expect(within(form).getByRole("button", { name: "Save action" })).toBeEnabled();

    fireEvent.click(within(form).getByRole("button", { name: "Remove result 2" }));
    expect(within(form).getByRole("button", { name: "Save action" })).toBeDisabled();
    expect(within(form).getByText(/Checking which steps route on these results/)).toBeInTheDocument();

    // And a failure is said, and is not "nothing is affected".
    answer({ ok: false, error: { message: "the pipelines could not be read" } });
    expect(await within(form).findByText("the pipelines could not be read")).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Save action" })).toBeDisabled();
    expect(within(form).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(saves(calls)).toHaveLength(0);
  });

  it("does not offer the save against an answer that is being replaced, and shows the new one's steps first", async () => {
    // Read per call, so the installation can change under an open editor.
    const options: Options = { defined: { qa: [ALIGNMENT] }, uses: { "qa alignment": [CHECK] } };
    const calls = mockIpc(options);
    const client = createQueryClient();
    render(
      <QueryClientProvider client={client}>
        <ActionsSection role="qa" locked={false} />
      </QueryClientProvider>,
    );
    const item = await row("alignment");
    fireEvent.click(within(item).getByRole("button", { name: "Edit alignment" }));
    const form = within(item).getByRole("region", { name: "Action alignment" });
    // The first answer has arrived and is in the cache.
    await waitFor(() => expect(calls.some((call) => call.channel === "roleActions:inspect")).toBe(true));
    await waitFor(() => expect(client.isFetching()).toBe(0));

    // A pipeline is published somewhere else: the answer is invalidated, and the next one is slow.
    let answer: (value: unknown) => void = () => undefined;
    options.inspect = () => new Promise((resolve) => (answer = resolve));
    void client.invalidateQueries({ queryKey: ["registry"] });
    fireEvent.click(within(form).getByRole("button", { name: "Remove result 2" }));

    await waitFor(() => expect(within(form).getByText(/Checking which steps route on these results/)).toBeInTheDocument());
    expect(within(form).getByRole("button", { name: "Save action" })).toBeDisabled();
    // Not the old answer's warning either: it names the steps from before.
    expect(within(form).queryByRole("list", { name: "Routes affected" })).toBeNull();

    answer({ ok: true, data: { providerSchema: null, uses: [CHECK, { ...OLDER, finishing: undefined, stepName: "Audit" }] } });
    const affected = await within(form).findByRole("list", { name: "Routes affected" });
    expect(within(affected).getByText(/Removing "gaps_found": "Check" \(Quality\), "Audit" \(Delivery\) routes on it/)).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Save action" })).toBeEnabled();
    expect(saves(calls)).toHaveLength(0);
  });

  it("finds the steps already dispatching an action that is only now being defined", async () => {
    const calls = renderSections({ uses: { "qa smoke": [{ ...QUALITY, routedKeys: ["done", "needs_user_input"] }, { ...OLDER, routedKeys: ["passed"] }] } }, "qa");
    fireEvent.click(await screen.findByRole("button", { name: "New action" }));
    const form = screen.getByRole("region", { name: "New action" });

    fireEvent.change(within(form).getByLabelText("Action"), { target: { value: "smoke" } });
    fireEvent.change(within(form).getByLabelText("Result 1 key"), { target: { value: "passed" } });

    const uses = await within(form).findByRole("list", { name: "Steps using this action" });
    expect(within(uses).getByText('"Check" (Quality)')).toBeInTheDocument();
    expect(calls.filter((call) => call.channel === "roleActions:inspect").at(-1)?.payload).toEqual({ role: "qa", action: "smoke" });

    const affected = within(form).getByRole("list", { name: "Routes affected" });
    // The live step routes a key this will not return, and lacks the one it will. The engine's own key is not held against it.
    expect(within(affected).getByText('"Check" (Quality) routes on "done", which this action will not return.')).toBeInTheDocument();
    expect(within(affected).getByText('"passed": "Check" (Quality) has no route for it.')).toBeInTheDocument();
    expect(within(affected).queryByText(/needs_user_input/)).toBeNull();
    // The older version's step already routes it, and is not named.
    expect(within(affected).queryByText(/Audit/)).toBeNull();
    expect(within(form).getByRole("button", { name: "Create action" })).toBeEnabled();
  });

  it("does not offer to create an action before the steps dispatching its name have been looked for", async () => {
    renderSections({ inspect: () => new Promise(() => undefined) }, "qa");
    fireEvent.click(await screen.findByRole("button", { name: "New action" }));
    const form = screen.getByRole("region", { name: "New action" });
    fireEvent.change(within(form).getByLabelText("Action"), { target: { value: "smoke" } });

    expect(within(form).getByText(/Checking which steps route on these results/)).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Create action" })).toBeDisabled();
  });
});

describe("under an organisation lock on the agents section", () => {
  it("is read-only and says the organisation manages it", async () => {
    const calls = renderSections({ defined: { qa: [ALIGNMENT] }, locked: true }, "qa");
    const item = await row("alignment");

    expect(await screen.findByText(SECTION_LOCK_TEXT, { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New action" })).toBeNull();
    expect(within(item).queryByRole("button", { name: "Edit alignment" })).toBeNull();

    fireEvent.click(within(item).getByRole("button", { name: "View alignment" }));
    const form = within(item).getByRole("region", { name: "Action alignment" });
    expect(within(form).getByLabelText("Description")).toBeDisabled();
    expect(within(form).getByLabelText("Result 1 key")).toBeDisabled();
    expect(within(form).getByLabelText("Field 1 name")).toBeDisabled();
    expect(within(form).queryByRole("button", { name: /Save action|Delete action/ })).toBeNull();

    // Still readable either way, and still unchangeable.
    fireEvent.click(within(form).getByRole("radio", { name: "JSON" }));
    expect(within(form).getByLabelText("Fields schema")).toBeDisabled();
    expect(within(form).getByLabelText("Provider schema")).toBeInTheDocument();
    expect(saves(calls)).toHaveLength(0);
  });
});
