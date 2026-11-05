import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { DiscussionSettings } from "@eo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipcStub, renderSection, sent } from "../views/settings/org/testing";
import { ChatSettings } from "./ChatSettings";

const settings = (over: Partial<DiscussionSettings> = {}): DiscussionSettings => ({
  agentId: "a",
  agentName: "Assistant",
  provider: "claude",
  model: null,
  defaultModel: "claude-opus-5-5",
  reasoningEffort: null,
  defaultReasoningEffort: "high",
  reasoningEfforts: ["low", "medium", "high", "max"],
  showReasoning: true,
  configurable: true,
  ...over,
});

const models = {
  capabilities: { provider: "claude", models: [], modelsAreLive: true, reasoningEfforts: ["low", "medium", "high"] },
  models: [
    { value: "claude-opus-5-5", label: "Opus 5.5", supportsEffort: true, effortLevels: ["low", "medium", "high", "max", "ultra"] },
    { value: "claude-sonnet-5-5", label: "Sonnet 5.5", supportsEffort: true, effortLevels: ["low", "high"] },
  ],
  problem: null,
};

/** The chat's model, effort and thinking, in the box's row (`ChatSettings.tsx`). */
describe("a chat's model and reasoning", () => {
  it("reads the backend's models when opened and writes what is chosen", async () => {
    const stub = ipcStub({ "providers:capabilities": models });
    window.eo.ipc.invoke = stub.invoke as never;
    const onChange = vi.fn();
    renderSection(<ChatSettings settings={settings()} onChange={onChange} />);

    const chip = screen.getByRole("button", { name: /Model and reasoning: claude-opus-5-5, high/ });
    expect(sent(stub.calls, "providers:capabilities")).toEqual([]);
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Sonnet 5.5/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("radio", { name: /Sonnet 5.5/ }));
    expect(onChange).toHaveBeenLastCalledWith({ model: "claude-sonnet-5-5" });
    fireEvent.click(screen.getByRole("radio", { name: /Default/ }));
    expect(onChange).toHaveBeenLastCalledWith({ model: null });
    // The chosen model's own effort levels.
    // Only levels the save accepts: the model's "ultra" is not on the backend's list.
    expect(screen.queryByRole("radio", { name: "ultra" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "max" }));
    expect(onChange).toHaveBeenLastCalledWith({ reasoningEffort: "max" });
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenLastCalledWith({ showReasoning: false });
  });

  it("closes on Escape", async () => {
    window.eo.ipc.invoke = ipcStub({ "providers:capabilities": models }).invoke as never;
    renderSection(<ChatSettings settings={settings()} onChange={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Model and reasoning/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    // And the keyboard is back where it was.
    expect(screen.getByRole("button", { name: /Model and reasoning/ })).toHaveFocus();
  });

  describe("with a long model list", () => {
    // Default plus fifteen, as Claude reports today.
    const many = {
      ...models,
      models: Array.from({ length: 15 }, (_, index) => ({
        value: `model-${index}`,
        label: `Model ${index}`,
        description: `The ${index}th`,
        supportsEffort: true,
        effortLevels: ["low", "high"],
      })),
    };
    afterEach(() => vi.restoreAllMocks());

    it("scrolls the models in a bounded list and keeps Effort and Show thinking outside it", async () => {
      window.eo.ipc.invoke = ipcStub({ "providers:capabilities": many }).invoke as never;
      renderSection(<ChatSettings settings={settings()} onChange={() => undefined} />);
      fireEvent.click(screen.getByRole("button", { name: /Model and reasoning/ }));
      await waitFor(() => expect(screen.getByRole("radio", { name: /Model 14/ })).toBeInTheDocument());

      const list = screen.getByRole("radiogroup", { name: "Model" });
      // Bounded, and it scrolls itself rather than growing the panel.
      expect(list).toHaveClass("max-h-52", "overflow-y-auto");
      // "Default" is the list's first row, not pinned above it.
      expect(list.firstElementChild).toBe(screen.getByRole("radio", { name: /Default/ }));
      expect(list).toContainElement(screen.getByRole("radio", { name: /Model 14/ }));
      // What sits below is always in view.
      expect(list).not.toContainElement(screen.getByRole("radiogroup", { name: "Reasoning effort" }));
      expect(list).not.toContainElement(screen.getByRole("switch"));
      expect(list).not.toContainElement(screen.getByText("Applies from the next message."));
    });

    it("brings the chosen model into the list's view once the models load, without scrolling anything else", async () => {
      // jsdom has no layout: a row is 48px tall, laid out in order, and the
      // list shows 208px of them.
      const ROW = 48;
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("role") === "radio" ? ROW : 0;
      });
      vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
        const parent = this.parentElement;
        return parent ? Array.from(parent.children).indexOf(this) * ROW : 0;
      });
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("role") === "radiogroup" ? 208 : 0;
      });
      const scrollIntoView = vi.fn();
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
      const focus = vi.spyOn(HTMLElement.prototype, "focus");

      window.eo.ipc.invoke = ipcStub({ "providers:capabilities": many }).invoke as never;
      renderSection(<ChatSettings settings={settings({ model: "model-13" })} onChange={() => undefined} />);
      fireEvent.click(screen.getByRole("button", { name: /Model and reasoning/ }));
      const chosen = await screen.findByRole("radio", { name: /Model 13/ });
      expect(chosen).toHaveAttribute("aria-checked", "true");

      // Model 13 is the 15th row (Default is the first): 14 × 48 to 15 × 48.
      const list = screen.getByRole("radiogroup", { name: "Model" });
      await waitFor(() => expect(list.scrollTop).toBe(15 * ROW - 208));
      // Only the list moved: nothing asked the page to scroll.
      expect(scrollIntoView).not.toHaveBeenCalled();
      for (const [options] of focus.mock.calls) expect(options).toEqual({ preventScroll: true });
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    });
  });

  it("offers nothing on a backend with nothing to choose", () => {
    const { container } = renderSection(<ChatSettings settings={settings({ provider: "fake", configurable: false })} onChange={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
