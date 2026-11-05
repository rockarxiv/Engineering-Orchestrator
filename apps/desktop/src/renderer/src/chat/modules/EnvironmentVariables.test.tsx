import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MODULE_ENV_NAME_MESSAGE, ORGANISATION_SECRET_LINE, type EnvironmentVariable } from "@eo/core";
import { ThemeProvider } from "@eo/ui";
import { createQueryClient, ipcQuery } from "../../query/client";
import { mcpServersKey } from "../../query/hooks";
import { EnvironmentVariables, type EnvironmentVariablesProps } from "./EnvironmentVariables";

/**
 * The Environment variables list (EO-486), in the chat layout. These
 * were held to both layouts while both shipped (two copies, and one
 * saying something different from the other about the same stored value
 * is a screen that is wrong); the classic copy went with EO-529.
 */

interface Call {
  channel: string;
  payload: unknown;
}

interface World {
  variables?: EnvironmentVariable[];
  secrets?: { names?: string[]; overrides?: string[]; organisation?: string[]; stored?: { shared: string[]; step: string[] } };
  /** What `environmentVariables:set` answers with; absent saves and updates the list. */
  refuse?: string;
}

/**
 * The main process, as far as this list reaches it: a variables list
 * that a save and a clear change, so a test reads what the screen shows
 * after the round trip rather than what it sent.
 */
function stubIpc(world: World = {}): Call[] {
  const calls: Call[] = [];
  let variables = [...(world.variables ?? [])];
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel === "environmentVariables:list") return { ok: true, data: { variables } };
    // The server list's half of what a shared variable changes (EO-488).
    if (channel === "mcpServers:list") {
      const shared = variables.filter((variable) => variable.scope === "shared").map((variable) => variable.name);
      return { ok: true, data: { servers: [], keychain: { available: true, backend: null, weak: false, warning: null }, managedIds: [], organisationSecrets: [], environmentVariables: shared, unavailable: [] } };
    }
    if (channel === "moduleSecrets:list") {
      return {
        ok: true,
        data: {
          names: world.secrets?.names ?? [],
          overrides: world.secrets?.overrides ?? [],
          organisation: world.secrets?.organisation ?? [],
          stored: world.secrets?.stored ?? { shared: [], step: [] },
        },
      };
    }
    if (channel === "environmentVariables:set") {
      if (world.refuse !== undefined) return { ok: true, data: { saved: false, problem: world.refuse } };
      const { name, value, stepId } = payload as { name: string; value: string; stepId: string | null };
      const scope = stepId === null ? "shared" : "step";
      variables = [...variables.filter((variable) => !(variable.name === name && variable.scope === scope)), { name, value, scope }];
      return { ok: true, data: { saved: true, problem: null } };
    }
    if (channel === "environmentVariables:clear") {
      const { name, stepId } = payload as { name: string; stepId: string | null };
      const scope = stepId === null ? "shared" : "step";
      variables = variables.filter((variable) => !(variable.name === name && variable.scope === scope));
      return { ok: true, data: { cleared: true } };
    }
    return { ok: true, data: {} };
  }) as never;
  return calls;
}

const sent = (calls: Call[], channel: string) => calls.filter((call) => call.channel === channel).map((call) => call.payload);

describe("the environment variables list, chat layout", () => {
  const draw = (props: EnvironmentVariablesProps = {}) =>
    render(
      <ThemeProvider>
        <QueryClientProvider client={createQueryClient()}>
          <EnvironmentVariables {...props} />
        </QueryClientProvider>
      </ThemeProvider>,
    );

  it("adds a shared variable and shows it with its value in full", async () => {
    const calls = stubIpc();
    draw();

    expect(await screen.findByText("No environment variables.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Variable name"), { target: { value: "REGION" } });
    fireEvent.change(screen.getByLabelText("Variable value"), { target: { value: "eu-west-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));

    await waitFor(() => expect(sent(calls, "environmentVariables:set")).toEqual([{ name: "REGION", value: "eu-west-1", stepId: null }]));
    // In full, in a box that is not a password field.
    const box = await screen.findByLabelText("Value of variable REGION");
    expect(box).toHaveValue("eu-west-1");
    expect(box).not.toHaveAttribute("type", "password");
    // And the add row is empty again for the next one.
    await waitFor(() => expect(screen.getByLabelText("Variable name")).toHaveValue(""));
    expect(screen.getByLabelText("Variable value")).toHaveValue("");
  });

  /**
   * The MCP server list says "From environment variables" from the shared
   * variables' names (EO-488), so a save or a removal here must refresh
   * it — within the query's stale window, which is when somebody comes
   * back to the server screen from Settings.
   */
  it("refreshes the MCP server list when a shared variable is added or removed", async () => {
    stubIpc();
    const client = createQueryClient();
    function ServerListProbe() {
      const servers = useQuery({ queryKey: mcpServersKey, queryFn: () => ipcQuery("mcpServers:list", { includeArchived: true }) });
      return <p data-testid="filled">{servers.data === undefined ? "loading" : servers.data.environmentVariables.join(",") || "none"}</p>;
    }
    render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <ServerListProbe />
          <EnvironmentVariables />
        </QueryClientProvider>
      </ThemeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("filled")).toHaveTextContent("none"));
    fireEvent.change(await screen.findByLabelText("Variable name"), { target: { value: "REGION" } });
    fireEvent.change(screen.getByLabelText("Variable value"), { target: { value: "eu-west-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    await waitFor(() => expect(screen.getByTestId("filled")).toHaveTextContent("REGION"));

    fireEvent.click(await screen.findByRole("button", { name: "Remove variable REGION" }));
    await waitFor(() => expect(screen.getByTestId("filled")).toHaveTextContent("none"));
  });

  it("edits a shared variable in place", async () => {
    const calls = stubIpc({ variables: [{ name: "REGION", value: "eu-west-1", scope: "shared" }] });
    draw();

    const box = await screen.findByLabelText("Value of variable REGION");
    expect(box).toHaveValue("eu-west-1");
    // Nothing to save until it differs from what is stored.
    expect(screen.getByRole("button", { name: "Save variable REGION" })).toBeDisabled();

    fireEvent.change(box, { target: { value: "us-east-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save variable REGION" }));

    await waitFor(() => expect(sent(calls, "environmentVariables:set")).toEqual([{ name: "REGION", value: "us-east-2", stepId: null }]));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save variable REGION" })).toBeDisabled());
    expect(screen.getByLabelText("Value of variable REGION")).toHaveValue("us-east-2");
  });

  it("removes a shared variable", async () => {
    const calls = stubIpc({ variables: [{ name: "REGION", value: "eu-west-1", scope: "shared" }] });
    draw();

    fireEvent.click(await screen.findByRole("button", { name: "Remove variable REGION" }));

    await waitFor(() => expect(sent(calls, "environmentVariables:clear")).toEqual([{ name: "REGION", stepId: null }]));
    await waitFor(() => expect(screen.queryByLabelText("Value of variable REGION")).not.toBeInTheDocument());
    expect(screen.getByText("No environment variables.")).toBeInTheDocument();
  });

  it.each([
    ["a name already a secret", "REGION", "REGION is already in the Secrets list. A name is a secret or an environment variable, never both — remove it from Secrets first to make it a variable."],
    ["a reserved name", "PATH", "EO sets PATH itself for every run, so it cannot be an environment variable here."],
  ])("shows the save's sentence for %s and keeps what was typed", async (_case, name, sentence) => {
    stubIpc({ refuse: sentence });
    draw();

    fireEvent.change(await screen.findByLabelText("Variable name"), { target: { value: name } });
    fireEvent.change(screen.getByLabelText("Variable value"), { target: { value: "eu-west-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(sentence);
    expect(screen.getByLabelText("Variable name")).toHaveValue(name);
    expect(screen.getByLabelText("Variable value")).toHaveValue("eu-west-1");
  });

  it("refuses a name that is not one, in the schema's words, and keeps what was typed", async () => {
    const calls = stubIpc();
    draw();

    fireEvent.change(await screen.findByLabelText("Variable name"), { target: { value: "1 REGION" } });
    fireEvent.change(screen.getByLabelText("Variable value"), { target: { value: "eu-west-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(MODULE_ENV_NAME_MESSAGE);
    expect(sent(calls, "environmentVariables:set")).toEqual([]);
    expect(screen.getByLabelText("Variable name")).toHaveValue("1 REGION");
    expect(screen.getByLabelText("Variable value")).toHaveValue("eu-west-1");
  });

  /**
   * A valid name that an ordinary object inherits something under. What
   * is typed is held by name, and a lookup that read the prototype drew
   * `[object Object]` where the stored value belongs.
   */
  it.each(["__proto__", "constructor", "toString"])("shows and edits the stored value of a variable called %s", async (name) => {
    const calls = stubIpc({ variables: [{ name, value: "eu-west-1", scope: "shared" }] });
    draw();

    const box = await screen.findByLabelText(`Value of variable ${name}`);
    expect(box).toHaveValue("eu-west-1");
    expect(screen.getByRole("button", { name: `Save variable ${name}` })).toBeDisabled();

    fireEvent.change(box, { target: { value: "us-east-2" } });
    expect(screen.getByLabelText(`Value of variable ${name}`)).toHaveValue("us-east-2");
    fireEvent.click(screen.getByRole("button", { name: `Save variable ${name}` }));

    await waitFor(() => expect(sent(calls, "environmentVariables:set")).toEqual([{ name, value: "us-east-2", stepId: null }]));
    await waitFor(() => expect(screen.getByRole("button", { name: `Save variable ${name}` })).toBeDisabled());
    expect(screen.getByLabelText(`Value of variable ${name}`)).toHaveValue("us-east-2");
  });

  describe("on an agent step (EO-487)", () => {
    it("lists every shared variable and the step's own, saying which the step uses, and adds one to the step", async () => {
      const calls = stubIpc({
        variables: [
          { name: "REGION", value: "eu-west-1", scope: "shared" },
          { name: "TIER", value: "standard", scope: "shared" },
          { name: "REGION", value: "us-east-2", scope: "step" },
          { name: "BUCKET", value: "artefacts", scope: "step" },
        ],
      });
      draw({ stepId: "todo" });

      // Every name a run on this step is given, the step's own value in the box.
      const region = await screen.findByText("REGION");
      await waitFor(() => expect(region.parentElement).toHaveTextContent("Set for this step"));
      expect(screen.getByLabelText("Value of variable REGION")).toHaveValue("us-east-2");
      expect(screen.getByText("TIER").parentElement).toHaveTextContent("Using the shared value · standard");
      expect(screen.getByText("BUCKET").parentElement).toHaveTextContent("Set for this step");
      // An agent run is given no secret, so the Secrets list is not asked.
      expect(sent(calls, "moduleSecrets:list")).toEqual([]);
      expect(sent(calls, "environmentVariables:list")).toContainEqual({ stepId: "todo" });
      // Back to the shared value where there is one; removed where there is not.
      expect(screen.getByRole("button", { name: "Use the shared variable for REGION" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Remove variable BUCKET" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^(Remove variable|Use the shared variable for) TIER$/ })).toBeNull();

      fireEvent.change(screen.getByLabelText("Variable name"), { target: { value: "ZONE" } });
      fireEvent.change(screen.getByLabelText("Variable value"), { target: { value: "b" } });
      fireEvent.click(screen.getByRole("button", { name: "Add variable" }));

      await waitFor(() => expect(sent(calls, "environmentVariables:set")).toEqual([{ name: "ZONE", value: "b", stepId: "todo" }]));
      await waitFor(() => expect(screen.getByText("ZONE").parentElement).toHaveTextContent("Set for this step"));

      fireEvent.click(screen.getByRole("button", { name: "Remove variable BUCKET" }));
      await waitFor(() => expect(sent(calls, "environmentVariables:clear")).toEqual([{ name: "BUCKET", stepId: "todo" }]));
      await waitFor(() => expect(screen.queryByText("BUCKET")).toBeNull());
    });
  });

  describe("on a module step", () => {
    it("lists the declared names, says where each is filled from, and saves against the step", async () => {
      const calls = stubIpc({
        variables: [{ name: "REGION", value: "eu-west-1", scope: "shared" }],
        secrets: { names: ["FLY_API_TOKEN"], organisation: ["ORG_TOKEN"] },
      });
      draw({ stepId: "deploy", declared: ["REGION", "FLY_API_TOKEN", "ORG_TOKEN", "BUCKET"] });

      const region = await screen.findByText("REGION");
      // The shared value is not a secret, so it is spelled out.
      await waitFor(() => expect(region.parentElement).toHaveTextContent("Using the shared value · eu-west-1"));
      expect(screen.getByText("FLY_API_TOKEN").parentElement).toHaveTextContent("Set as a secret");
      expect(screen.getByText("ORG_TOKEN").parentElement).toHaveTextContent(ORGANISATION_SECRET_LINE);
      expect(screen.getByText("BUCKET").parentElement).toHaveTextContent("Not set");
      // A step lists declared names only; there is no row to invent one.
      expect(screen.queryByLabelText("Variable name")).not.toBeInTheDocument();
      expect(sent(calls, "environmentVariables:list")).toContainEqual({ stepId: "deploy" });

      fireEvent.change(screen.getByLabelText("Value of variable REGION"), { target: { value: "us-east-2" } });
      fireEvent.click(screen.getByRole("button", { name: "Save variable REGION" }));

      await waitFor(() => expect(sent(calls, "environmentVariables:set")).toEqual([{ name: "REGION", value: "us-east-2", stepId: "deploy" }]));
      await waitFor(() => expect(screen.getByText("REGION").parentElement).toHaveTextContent("Set for this step"));

      // Back to the shared value, rather than unsetting the name.
      fireEvent.click(screen.getByRole("button", { name: "Use the shared variable for REGION" }));
      await waitFor(() => expect(sent(calls, "environmentVariables:clear")).toEqual([{ name: "REGION", stepId: "deploy" }]));
      await waitFor(() => expect(screen.getByText("REGION").parentElement).toHaveTextContent("Using the shared value · eu-west-1"));
    });

    /**
     * A step secret that is stored but cannot be read stops the fallback
     * (`environmentFor`): the step is not given the shared variable, so
     * this list must not say it is.
     */
    it("does not claim the shared value where an unreadable step secret blocks it", async () => {
      stubIpc({
        variables: [{ name: "REGION", value: "eu-west-1", scope: "shared" }],
        secrets: { names: [], overrides: [], stored: { shared: [], step: ["REGION"] } },
      });
      draw({ stepId: "deploy", declared: ["REGION"] });

      const region = await screen.findByText("REGION");
      await waitFor(() => expect(region.parentElement).toHaveTextContent("Stored as a secret for this step, but it cannot be read"));
      expect(region.parentElement).not.toHaveTextContent("Using the shared value");
    });

    it("says an unpublished step must be published first, and takes no value", () => {
      const calls = stubIpc();
      draw({ stepId: "new-step", declared: ["REGION"], unavailable: "Publish this pipeline first, then you can give this step its own values." });

      expect(screen.getByText("Publish this pipeline first, then you can give this step its own values.")).toBeInTheDocument();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(calls).toEqual([]);
    });
  });
});
