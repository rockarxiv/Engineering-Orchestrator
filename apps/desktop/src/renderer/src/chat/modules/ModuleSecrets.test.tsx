import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ipcContract, MODULE_ENV_NAME_MESSAGE, MODULE_ENV_NAME_PATTERN, ModuleNeedsSchema, ORGANISATION_SECRET_LINE, type IpcResponse } from "@eo/core";
import { renderSection, sent, ipcStub, type Answers } from "../views/settings/org/testing";
import { ModuleSecrets } from "./ModuleSecrets";

/** The shared stub, installed where only a test may put it. */
function stubIpc(answers?: Answers) {
  const stub = ipcStub(answers);
  window.eo.ipc.invoke = stub.invoke as never;
  return stub.calls;
}

/**
 * Setting the named values a module declares (KAN-105), in the chat
 * layout: values go in and come back only on Reveal (EO-489,
 * `hooks/useSecretReveal.test.tsx`), a refused one stays in its
 * box, a step's value falls back to the shared one, and the organisation's
 * names read as the one sentence EO can honestly say (EO-328).
 */

describe("a module's secrets", () => {
  it("reads 'set by your organisation · not shown here' for a name they set", async () => {
    stubIpc({ "moduleSecrets:list": { names: [], overrides: [], organisation: ["FLY_API_TOKEN"] } });
    renderSection(<ModuleSecrets />);

    const name = await screen.findByText("FLY_API_TOKEN");
    expect(name.parentElement).toHaveTextContent(ORGANISATION_SECRET_LINE);
    expect(document.body.textContent).not.toContain("never readable");
  });

  it("leaves the person's own value of the same name theirs to set", async () => {
    const calls = stubIpc({
      "moduleSecrets:list": { names: ["FLY_API_TOKEN"], overrides: [], organisation: ["FLY_API_TOKEN"] },
      "moduleSecrets:set": { saved: true, problem: null },
    });
    renderSection(<ModuleSecrets />);

    fireEvent.change(await screen.findByLabelText("Value for FLY_API_TOKEN"), { target: { value: "mine" } });
    fireEvent.click(screen.getByRole("button", { name: "Save FLY_API_TOKEN" }));

    await waitFor(() => expect(sent(calls, "moduleSecrets:set")[0]).toMatchObject({ name: "FLY_API_TOKEN", value: "mine", stepId: null }));
    // Off the screen once sent.
    await waitFor(() => expect(screen.getByLabelText("Value for FLY_API_TOKEN")).toHaveValue(""));
  });

  it("is untouched on an installation nobody has published to, and offers Remove for a shared value", async () => {
    const calls = stubIpc({ "moduleSecrets:list": { names: ["FLY_API_TOKEN"], overrides: [], organisation: [] }, "moduleSecrets:clear": { cleared: true } });
    renderSection(<ModuleSecrets />);

    const name = await screen.findByText("FLY_API_TOKEN");
    expect(name.parentElement).toHaveTextContent("Set");
    expect(document.body.textContent).not.toContain(ORGANISATION_SECRET_LINE);
    fireEvent.click(screen.getByRole("button", { name: "Remove FLY_API_TOKEN" }));
    await waitFor(() => expect(sent(calls, "moduleSecrets:clear")).toEqual([{ name: "FLY_API_TOKEN", stepId: null }]));
  });

  it("keeps a refused value in its box and says why", async () => {
    stubIpc({
      "moduleSecrets:list": { names: [], overrides: [], organisation: [] },
      "moduleSecrets:set": { saved: false, problem: "The keychain is locked." },
    });
    renderSection(<ModuleSecrets declared={["DEPLOY_TOKEN"]} />);

    expect(await screen.findByText("Not set")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Value for DEPLOY_TOKEN"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Save DEPLOY_TOKEN" }));

    expect(await screen.findByText("The keychain is locked.")).toBeInTheDocument();
    expect(screen.getByLabelText("Value for DEPLOY_TOKEN")).toHaveValue("abc");
    // With a manifest, every name it could be given is already a row.
    expect(screen.queryByLabelText("Secret name")).not.toBeInTheDocument();
  });

  it("says which step overrides a name, and falls back to the shared value on request", async () => {
    const calls = stubIpc({
      "moduleSecrets:list": { names: ["A", "B"], overrides: ["A"], organisation: [] },
      "moduleSecrets:clear": { cleared: true },
    });
    renderSection(<ModuleSecrets stepId="step-1" declared={["A", "B"]} />);

    expect(await screen.findByText("Set for this step")).toBeInTheDocument();
    expect(screen.getByText("A").parentElement).toHaveTextContent("Set for this step");
    expect(screen.getByText("B").parentElement).toHaveTextContent("Using the shared value");
    expect(screen.queryByRole("button", { name: "Use the shared value for B" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use the shared value for A" }));
    await waitFor(() => expect(sent(calls, "moduleSecrets:clear")).toEqual([{ name: "A", stepId: "step-1" }]));
  });

  it("adds a value under a new name when there is no manifest to work from", async () => {
    const calls = stubIpc({ "moduleSecrets:list": { names: [], overrides: [], organisation: [] }, "moduleSecrets:set": { saved: true, problem: null } });
    renderSection(<ModuleSecrets />);

    expect(await screen.findByText("Nothing set.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Secret name"), { target: { value: "FLY_API_TOKEN" } });
    fireEvent.change(screen.getByLabelText("Secret value"), { target: { value: "v" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent(calls, "moduleSecrets:set")).toEqual([{ name: "FLY_API_TOKEN", value: "v", stepId: null }]));
    await waitFor(() => expect(screen.getByLabelText("Secret value")).toHaveValue(""));
  });

  it("says why a step cannot hold values yet, and asks nothing", () => {
    const calls = stubIpc();
    renderSection(<ModuleSecrets stepId="draft" unavailable="Publish the step first." />);
    expect(screen.getByText("Publish the step first.")).toBeInTheDocument();
    expect(sent(calls, "moduleSecrets:list")).toEqual([]);
  });
});

/**
 * A name read from one of EO's own variables instead of stored (EO-417).
 *
 * Names and booleans are all this is told: which variable a name reads
 * and whether EO was started with it. Never what the variable holds.
 */

type List = IpcResponse<"moduleSecrets:list">;

function list(answer: Partial<List>): List {
  return { names: [], overrides: [], organisation: [], references: [], stored: { shared: [], step: [] }, ...answer };
}

const SAVED = { saved: true, problem: null, replaced: null };

describe("a module's reference to one of EO's variables", () => {
  it("offers the choice on a declared name, prefills the variable with it, and saves the reference", async () => {
    const calls = stubIpc({ "moduleSecrets:list": list({}), "moduleSecrets:set": SAVED });
    renderSection(<ModuleSecrets declared={["JAVA_HOME"]} />);

    expect(await screen.findByText("Not set")).toBeInTheDocument();
    const group = screen.getByRole("radiogroup", { name: "How JAVA_HOME is supplied" });
    expect(within(group).getByRole("radio", { name: "Store a value" })).toBeChecked();
    expect(screen.queryByLabelText("Variable for JAVA_HOME")).not.toBeInTheDocument();

    fireEvent.click(within(group).getByRole("radio", { name: "Read from EO's environment" }));
    expect(screen.getByLabelText("Variable for JAVA_HOME")).toHaveValue("JAVA_HOME");
    expect(screen.queryByLabelText("Value for JAVA_HOME")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Variable for JAVA_HOME"), { target: { value: "JDK21_HOME" } });
    fireEvent.click(screen.getByRole("button", { name: "Save JAVA_HOME" }));
    await waitFor(() => expect(sent(calls, "moduleSecrets:set")).toEqual([{ name: "JAVA_HOME", reference: { variable: "JDK21_HOME" }, stepId: null }]));
  });

  it("saves a step's reference against the step", async () => {
    const calls = stubIpc({ "moduleSecrets:list": list({}), "moduleSecrets:set": SAVED });
    renderSection(<ModuleSecrets stepId="step-1" declared={["JAVA_HOME"]} />);

    fireEvent.click(await screen.findByRole("radio", { name: "Read from EO's environment" }));
    fireEvent.click(screen.getByRole("button", { name: "Save JAVA_HOME" }));
    await waitFor(() => expect(sent(calls, "moduleSecrets:set")).toEqual([{ name: "JAVA_HOME", reference: { variable: "JAVA_HOME" }, stepId: "step-1" }]));
  });

  it("says which variable a referenced name reads, and opens the row on it", async () => {
    stubIpc({
      "moduleSecrets:list": list({ names: ["JAVA_HOME"], references: [{ name: "JAVA_HOME", variable: "JDK21_HOME", scope: "shared", available: true }] }),
    });
    renderSection(<ModuleSecrets />);

    const status = await screen.findByText("Reads JDK21_HOME from EO's environment");
    expect(status).not.toHaveClass("text-danger");
    expect(within(screen.getByRole("radiogroup", { name: "How JAVA_HOME is supplied" })).getByRole("radio", { name: "Read from EO's environment" })).toBeChecked();
    expect(screen.getByLabelText("Variable for JAVA_HOME")).toHaveValue("JDK21_HOME");
  });

  it("says so in the tone of 'Not set' when EO was started without the variable", async () => {
    // In neither `names` nor `overrides`, because no dispatch would get a
    // value — and still a row, with no manifest to put it there.
    stubIpc({ "moduleSecrets:list": list({ references: [{ name: "JAVA_HOME", variable: "JDK21_HOME", scope: "shared", available: false }] }) });
    renderSection(<ModuleSecrets />);

    const status = await screen.findByText("Reads JDK21_HOME from EO's environment · EO was started without it");
    expect(status).toHaveClass("text-danger");
    expect(screen.getByRole("button", { name: "Remove JAVA_HOME" })).toBeInTheDocument();
  });

  it("shows the shared entry's status on a step with no entry of its own, whichever kind it is", async () => {
    stubIpc({
      "moduleSecrets:list": list({
        names: ["A", "B"],
        references: [
          { name: "B", variable: "B_HERE", scope: "shared", available: true },
          { name: "C", variable: "C", scope: "shared", available: false },
        ],
      }),
    });
    renderSection(<ModuleSecrets stepId="step-1" declared={["A", "B", "C", "D"]} />);

    expect(await screen.findByText("Using the shared value")).toBeInTheDocument();
    expect(screen.getByText("A").parentElement).toHaveTextContent("Using the shared value");
    expect(screen.getByText("B").parentElement).toHaveTextContent("Using the shared entry · reads B_HERE from EO's environment");
    const missing = screen.getByText("Using the shared entry · reads C from EO's environment · EO was started without it");
    expect(missing).toHaveClass("text-danger");
    expect(screen.getByText("D").parentElement).toHaveTextContent("Not set");
    // Nothing of the step's own to clear, and the step's row opens on storing a value.
    expect(screen.queryByRole("button", { name: /^Use the shared value for/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Variable for B")).not.toBeInTheDocument();
  });

  it("puts a step's own reference before the shared entry, even one EO cannot resolve", async () => {
    stubIpc({
      "moduleSecrets:list": list({
        names: ["A", "B"],
        overrides: ["A"],
        references: [
          { name: "A", variable: "A_STEP", scope: "step", available: true },
          { name: "B", variable: "B_STEP", scope: "step", available: false },
        ],
      }),
    });
    renderSection(<ModuleSecrets stepId="step-1" declared={["A", "B"]} />);

    expect(await screen.findByText("Reads A_STEP from EO's environment for this step")).toBeInTheDocument();
    expect(screen.getByText("A").parentElement).toHaveTextContent("Reads A_STEP from EO's environment for this step");
    // It does not fall back, so "Using the shared value" would describe a value this step is never given.
    const dangling = screen.getByText("Reads B_STEP from EO's environment for this step · EO was started without it");
    expect(dangling).toHaveClass("text-danger");
    expect(screen.getByRole("button", { name: "Use the shared value for B" })).toBeInTheDocument();
  });

  it("shows the organisation's line and offers no reference where the organisation supplies the name", async () => {
    stubIpc({
      "moduleSecrets:list": list({
        organisation: ["FLY_API_TOKEN"],
        references: [{ name: "FLY_API_TOKEN", variable: "FLY_API_TOKEN", scope: "shared", available: true }],
      }),
    });
    renderSection(<ModuleSecrets declared={["FLY_API_TOKEN"]} />);

    expect(await screen.findByText(ORGANISATION_SECRET_LINE)).toBeInTheDocument();
    expect(screen.getByText("FLY_API_TOKEN").parentElement).toHaveTextContent(ORGANISATION_SECRET_LINE);
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Variable for FLY_API_TOKEN")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Value for FLY_API_TOKEN")).toBeInTheDocument();
  });

  it("warns before a reference replaces a stored value, and saves only once that is confirmed", async () => {
    const calls = stubIpc({
      "moduleSecrets:list": list({ names: ["JAVA_HOME"], stored: { shared: ["JAVA_HOME"], step: [] } }),
      "moduleSecrets:set": { saved: true, problem: null, replaced: "value" },
    });
    renderSection(<ModuleSecrets />);

    fireEvent.click(within(await screen.findByRole("radiogroup", { name: "How JAVA_HOME is supplied" })).getByRole("radio", { name: "Read from EO's environment" }));
    fireEvent.click(screen.getByRole("button", { name: "Save JAVA_HOME" }));

    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent("JAVA_HOME has a stored value here. Reading JAVA_HOME from EO's environment removes it, and it cannot be read back.");
    expect(sent(calls, "moduleSecrets:set")).toEqual([]);

    // Declined: nothing is sent and the choice is still on the screen.
    fireEvent.click(screen.getByRole("button", { name: "Keep the stored value of JAVA_HOME" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(sent(calls, "moduleSecrets:set")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Save JAVA_HOME" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove the stored value of JAVA_HOME" }));
    await waitFor(() => expect(sent(calls, "moduleSecrets:set")).toEqual([{ name: "JAVA_HOME", reference: { variable: "JAVA_HOME" }, stepId: null }]));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("warns about a step's own stored value and not about the shared one beneath it", async () => {
    const calls = stubIpc({ "moduleSecrets:list": list({ names: ["A", "B"], overrides: ["A"], stored: { shared: ["A", "B"], step: ["A"] } }), "moduleSecrets:set": SAVED });
    renderSection(<ModuleSecrets stepId="step-1" declared={["A", "B"]} />);

    // B is stored only in the shared scope, which a step's reference leaves alone.
    fireEvent.click(within(await screen.findByRole("radiogroup", { name: "How B is supplied" })).getByRole("radio", { name: "Read from EO's environment" }));
    fireEvent.click(screen.getByRole("button", { name: "Save B" }));
    await waitFor(() => expect(sent(calls, "moduleSecrets:set")).toEqual([{ name: "B", reference: { variable: "B" }, stepId: "step-1" }]));

    fireEvent.click(within(screen.getByRole("radiogroup", { name: "How A is supplied" })).getByRole("radio", { name: "Read from EO's environment" }));
    fireEvent.click(screen.getByRole("button", { name: "Save A" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A has a stored value for this step.");
    expect(sent(calls, "moduleSecrets:set")).toHaveLength(1);
  });

  it("warns before a reference replaces a stored value that can no longer be read", async () => {
    // In neither `names` nor `overrides` — no dispatch would get it — so
    // the row says it cannot be read (EO-486). It is on disk all the same,
    // and a reference saved over it removes it for good.
    const calls = stubIpc({ "moduleSecrets:list": list({ stored: { shared: ["JAVA_HOME"], step: ["JAVA_HOME"] } }), "moduleSecrets:set": { saved: true, problem: null, replaced: "value" } });
    renderSection(<ModuleSecrets stepId="step-1" declared={["JAVA_HOME"]} />);

    expect(await screen.findByText("Stored as a secret for this step, but it cannot be read")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Read from EO's environment" }));
    fireEvent.click(screen.getByRole("button", { name: "Save JAVA_HOME" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("JAVA_HOME has a stored value for this step.");
    expect(sent(calls, "moduleSecrets:set")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Remove the stored value of JAVA_HOME" }));
    await waitFor(() => expect(sent(calls, "moduleSecrets:set")).toEqual([{ name: "JAVA_HOME", reference: { variable: "JAVA_HOME" }, stepId: "step-1" }]));
  });

  it("does not warn on a step about an unreadable value held only in the shared scope", async () => {
    const calls = stubIpc({ "moduleSecrets:list": list({ stored: { shared: ["JAVA_HOME"], step: [] } }), "moduleSecrets:set": SAVED });
    renderSection(<ModuleSecrets stepId="step-1" declared={["JAVA_HOME"]} />);

    expect(await screen.findByText("Stored as a secret, but it cannot be read")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Read from EO's environment" }));
    fireEvent.click(screen.getByRole("button", { name: "Save JAVA_HOME" }));
    await waitFor(() => expect(sent(calls, "moduleSecrets:set")).toHaveLength(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears a reference with Remove, and the row then reads 'Not set'", async () => {
    let held: List = list({ names: ["JAVA_HOME"], references: [{ name: "JAVA_HOME", variable: "JAVA_HOME", scope: "shared", available: true }] });
    const calls = stubIpc({
      "moduleSecrets:list": () => held,
      "moduleSecrets:clear": () => {
        held = list({});
        return { cleared: true };
      },
    });
    renderSection(<ModuleSecrets declared={["JAVA_HOME"]} />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove JAVA_HOME" }));
    await waitFor(() => expect(sent(calls, "moduleSecrets:clear")).toEqual([{ name: "JAVA_HOME", stepId: null }]));
    expect(await screen.findByText("Not set")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove JAVA_HOME" })).not.toBeInTheDocument();
    // Back on storing a value, since the row no longer holds a reference.
    expect(screen.getByRole("radio", { name: "Store a value" })).toBeChecked();
  });

  it("clears a step's reference, and the row then shows the shared entry's status", async () => {
    const shared = { name: "JAVA_HOME", variable: "JDK21_HOME", scope: "shared" as const, available: true };
    let held: List = list({ names: ["JAVA_HOME"], references: [shared, { name: "JAVA_HOME", variable: "JDK17_HOME", scope: "step", available: false }] });
    const calls = stubIpc({
      "moduleSecrets:list": () => held,
      "moduleSecrets:clear": () => {
        held = list({ names: ["JAVA_HOME"], references: [shared] });
        return { cleared: true };
      },
    });
    renderSection(<ModuleSecrets stepId="step-1" declared={["JAVA_HOME"]} />);

    expect(await screen.findByText("Reads JDK17_HOME from EO's environment for this step · EO was started without it")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use the shared value for JAVA_HOME" }));
    await waitFor(() => expect(sent(calls, "moduleSecrets:clear")).toEqual([{ name: "JAVA_HOME", stepId: "step-1" }]));
    expect(await screen.findByText("Using the shared entry · reads JDK21_HOME from EO's environment")).toBeInTheDocument();
  });

  it("refuses a variable name that is not one, in the words needs.env uses, and keeps what was typed", async () => {
    const calls = stubIpc({ "moduleSecrets:list": list({}), "moduleSecrets:set": SAVED });
    renderSection(<ModuleSecrets declared={["JAVA_HOME"]} />);

    fireEvent.click(await screen.findByRole("radio", { name: "Read from EO's environment" }));
    fireEvent.change(screen.getByLabelText("Variable for JAVA_HOME"), { target: { value: "JDK-21 HOME" } });
    fireEvent.click(screen.getByRole("button", { name: "Save JAVA_HOME" }));

    expect(await screen.findByText(MODULE_ENV_NAME_MESSAGE)).toBeInTheDocument();
    // The sentence the manifest is refused with, not a paraphrase of it.
    expect(ModuleNeedsSchema.safeParse({ env: ["JDK-21 HOME"] }).error?.issues[0]?.message).toBe(MODULE_ENV_NAME_MESSAGE);
    expect(screen.getByLabelText("Variable for JAVA_HOME")).toHaveValue("JDK-21 HOME");
    expect(sent(calls, "moduleSecrets:set")).toEqual([]);
  });

  it("creates a reference for a typed name from the add row", async () => {
    const calls = stubIpc({ "moduleSecrets:list": list({}), "moduleSecrets:set": SAVED });
    renderSection(<ModuleSecrets />);

    expect(await screen.findByText("Nothing set.")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "How the new name is supplied" })).getByRole("radio", { name: "Read from EO's environment" }));
    fireEvent.change(screen.getByLabelText("Secret name"), { target: { value: "JAVA_HOME" } });
    // Prefilled with the name as it is typed, and the person's once they write over it.
    expect(screen.getByLabelText("Variable to read")).toHaveValue("JAVA_HOME");
    expect(screen.queryByLabelText("Secret value")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Variable to read"), { target: { value: "JDK21_HOME" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(sent(calls, "moduleSecrets:set")).toEqual([{ name: "JAVA_HOME", reference: { variable: "JDK21_HOME" }, stepId: null }]));
    await waitFor(() => expect(screen.getByLabelText("Secret name")).toHaveValue(""));
    expect(screen.getByLabelText("Secret value")).toHaveValue("");
  });

  it("warns from the add row too when the typed name already holds a stored value", async () => {
    const calls = stubIpc({ "moduleSecrets:list": list({ names: ["JAVA_HOME"], stored: { shared: ["JAVA_HOME"], step: [] } }), "moduleSecrets:set": SAVED });
    renderSection(<ModuleSecrets />);

    await screen.findByText("Set");
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "How the new name is supplied" })).getByRole("radio", { name: "Read from EO's environment" }));
    fireEvent.change(screen.getByLabelText("Secret name"), { target: { value: "JAVA_HOME" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("JAVA_HOME has a stored value here.");
    expect(sent(calls, "moduleSecrets:set")).toEqual([]);
  });

  it("is given names and booleans only, and draws no variable's value", async () => {
    const answer = list({
      names: ["JAVA_HOME"],
      overrides: ["JAVA_HOME"],
      organisation: ["FLY_API_TOKEN"],
      stored: { shared: ["NODE_HOME"], step: ["FLY_API_TOKEN"] },
      references: [
        { name: "JAVA_HOME", variable: "JDK21_HOME", scope: "shared", available: true },
        { name: "JAVA_HOME", variable: "JDK17_HOME", scope: "step", available: true },
        { name: "NODE_HOME", variable: "NODE_HOME", scope: "shared", available: false },
      ],
    });
    // The contract, held shut: a field that could carry a value would be
    // an unknown key here, and `strict` is what refuses one.
    const response = ipcContract["moduleSecrets:list"].response;
    const reference = response.shape.references.unwrap().element;
    expect(Object.keys(response.shape).sort()).toEqual(["names", "organisation", "overrides", "references", "stored"]);
    expect(Object.keys(reference.shape).sort()).toEqual(["available", "name", "scope", "variable"]);
    expect(response.extend({ references: z.array(reference.strict()), stored: response.shape.stored.unwrap().strict() }).strict().safeParse(answer).success).toBe(true);
    // Every leaf of what the component is handed is a name, a scope or a boolean.
    const leaves = (value: unknown): unknown[] => (Array.isArray(value) ? value.flatMap(leaves) : typeof value === "object" && value !== null ? Object.values(value).flatMap(leaves) : [value]);
    for (const leaf of leaves(answer)) {
      expect(typeof leaf === "boolean" || (typeof leaf === "string" && (leaf === "shared" || leaf === "step" || MODULE_ENV_NAME_PATTERN.test(leaf)))).toBe(true);
    }

    stubIpc({ "moduleSecrets:list": answer });
    renderSection(<ModuleSecrets stepId="step-1" declared={["JAVA_HOME", "NODE_HOME", "FLY_API_TOKEN"]} />);
    await screen.findByText("Reads JDK17_HOME from EO's environment for this step");

    // The only thing a field arrives holding is a variable's name.
    const held = [...document.querySelectorAll("input")].filter((input) => input.type !== "radio").map((input) => input.value);
    expect(held).toEqual(["JDK17_HOME", "", ""]);
  });

  /**
   * The other list (EO-486): within one scope a name is a secret or an
   * environment variable, never both, so a declared name that is a
   * variable has no secret — and is not a debt the person owes.
   */
  it("reads 'Set as an environment variable' for a name whose value is a variable, not 'Not set'", async () => {
    const calls = stubIpc({
      "moduleSecrets:list": { names: [], overrides: [], organisation: [] },
      "environmentVariables:list": (payload: unknown) => ({
        variables: [
          { name: "REGION", value: "eu-west-1", scope: "shared" },
          ...((payload as { stepId?: string | null }).stepId === "step-1" ? [{ name: "BUCKET", value: "logs", scope: "step" }] : []),
        ],
      }),
    });
    renderSection(<ModuleSecrets declared={["REGION", "FLY_API_TOKEN"]} />);

    const region = await screen.findByText("REGION");
    await waitFor(() => expect(region.parentElement).toHaveTextContent("Set as an environment variable"));
    expect(region.parentElement).not.toHaveTextContent("Not set");
    expect(screen.getByText("FLY_API_TOKEN").parentElement).toHaveTextContent("Not set");
    expect(sent(calls, "environmentVariables:list")).toContainEqual({ stepId: null });
  });

  it("says so for a step's own variable, and for a shared one the step falls back to", async () => {
    stubIpc({
      "moduleSecrets:list": { names: [], overrides: [], organisation: [] },
      "environmentVariables:list": {
        variables: [
          { name: "REGION", value: "eu-west-1", scope: "shared" },
          { name: "BUCKET", value: "logs", scope: "step" },
        ],
      },
    });
    renderSection(<ModuleSecrets stepId="step-1" declared={["REGION", "BUCKET"]} />);

    await waitFor(() => expect(screen.getByText("BUCKET").parentElement).toHaveTextContent("Set as an environment variable for this step"));
    expect(screen.getByText("REGION").parentElement).toHaveTextContent("Set as an environment variable");
  });

  it("says a step's own variable beats a shared secret of the same name", async () => {
    stubIpc({
      "moduleSecrets:list": { names: ["REGION"], overrides: [], organisation: [] },
      "environmentVariables:list": { variables: [{ name: "REGION", value: "eu-west-1", scope: "step" }] },
    });
    renderSection(<ModuleSecrets stepId="step-1" declared={["REGION"]} />);

    await waitFor(() => expect(screen.getByText("REGION").parentElement).toHaveTextContent("Set as an environment variable for this step"));
    expect(screen.getByText("REGION").parentElement).not.toHaveTextContent("Using the shared value");
  });

  /** An unreadable step secret stops the fallback, so no shared variable is what the step gets. */
  it("says a step secret that cannot be read is the step's answer, not a shared variable", async () => {
    stubIpc({
      "moduleSecrets:list": { names: [], overrides: [], organisation: [], stored: { shared: [], step: ["REGION"] } },
      "environmentVariables:list": { variables: [{ name: "REGION", value: "eu-west-1", scope: "shared" }] },
    });
    renderSection(<ModuleSecrets stepId="step-1" declared={["REGION"]} />);

    await waitFor(() => expect(screen.getByText("REGION").parentElement).toHaveTextContent("Stored as a secret for this step, but it cannot be read"));
    expect(screen.getByText("REGION").parentElement).not.toHaveTextContent("Set as an environment variable");
  });
});
