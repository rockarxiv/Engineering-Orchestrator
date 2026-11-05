import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useWaitingOnYou } from "../chat/parts";
import { archivedKey } from "../shared/pipeline/archive";
import { createQueryClient, ipcQuery } from "./client";
import { itemsKey, stepAuthorityKey, useStepAuthority } from "./hooks";
import { useInvalidateOnPush } from "./useInvalidateOnPush";
import { useProjects } from "./useRepositories";

/**
 * EO-560: a push is acted on once per thing it names, however many
 * components on screen listen for it.
 */

type Listener = (payload: unknown) => void;

/** The bridge, recording every subscription and every call. */
function fakeBridge() {
  const listeners = new Map<string, Set<Listener>>();
  const calls: { channel: string; payload: unknown }[] = [];
  window.eo.ipc.subscribe = vi.fn((channel: string, callback: Listener) => {
    const set = listeners.get(channel) ?? new Set<Listener>();
    set.add(callback);
    listeners.set(channel, set);
    return () => set.delete(callback);
  }) as never;
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    switch (channel) {
      case "projects:list":
        return { ok: true, data: { projects: [], activeProjectId: null } };
      case "inbox:list":
        return { ok: true, data: { items: [], summary: { openCount: 0, blockingCount: 0, everythingBlocked: false } } };
      case "items:authority":
        return { ok: true, data: { authority: null } };
      case "items:list":
      case "items:listArchived":
        return { ok: true, data: { items: [] } };
      default:
        return { ok: true, data: {} };
    }
  }) as never;
  return {
    calls,
    count: (channel: string, where: (payload: unknown) => boolean = () => true) => calls.filter((call) => call.channel === channel && where(call.payload)).length,
    /** How many listeners the bridge holds on a channel. */
    listening: (channel: string) => listeners.get(channel)?.size ?? 0,
    push: (channel: string, payload: unknown) =>
      act(async () => {
        listeners.get(channel)?.forEach((listener) => listener(payload));
        await Promise.resolve();
      }),
  };
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

function wrap(children: ReactNode, client = createQueryClient()) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** A switcher, a picker and a header: three of `useProjects`'s twenty callers, on screen at once. */
function ProjectsConsumer() {
  useProjects();
  return null;
}

/** The rail's count, the home screen and the inbox all read what is waiting. */
function InboxConsumer() {
  useWaitingOnYou();
  return null;
}

/** A claimable board card. */
function Card({ itemId }: { itemId: string }) {
  useStepAuthority(itemId);
  return null;
}

describe("one listener per channel and key, app-wide", () => {
  it("asks projects:list, inbox:list and each card's authority once per push, however many consumers are mounted", async () => {
    const bridge = fakeBridge();
    render(
      wrap(
        <>
          <ProjectsConsumer />
          <ProjectsConsumer />
          <ProjectsConsumer />
          <InboxConsumer />
          <InboxConsumer />
          <InboxConsumer />
          <Card itemId="a" />
          <Card itemId="b" />
          <Card itemId="c" />
        </>,
      ),
    );
    await waitFor(() => expect(bridge.count("items:authority")).toBe(3));
    await settle();
    expect(bridge.count("projects:list")).toBe(1);
    expect(bridge.count("inbox:list")).toBe(1);
    // One bridge listener each on items:changed: projects, inbox, authority.
    expect(bridge.listening("items:changed")).toBe(3);

    await bridge.push("items:changed", {});
    await settle();
    expect(bridge.count("projects:list")).toBe(2);
    expect(bridge.count("inbox:list")).toBe(2);
    // A push naming no item may concern any card: each is asked once.
    expect(bridge.count("items:authority")).toBe(6);

    await bridge.push("config:changed", {});
    await settle();
    expect(bridge.count("projects:list")).toBe(3);
    expect(bridge.count("items:authority")).toBe(9);
  });

  it("asks only the named item's authority when a push names one", async () => {
    const bridge = fakeBridge();
    render(
      wrap(
        <>
          <Card itemId="a" />
          <Card itemId="b" />
        </>,
      ),
    );
    await waitFor(() => expect(bridge.count("items:authority")).toBe(2));

    await bridge.push("items:changed", { itemId: "b" });
    await settle();
    expect(bridge.count("items:authority", (payload) => (payload as { itemId: string }).itemId === "b")).toBe(2);
    expect(bridge.count("items:authority", (payload) => (payload as { itemId: string }).itemId === "a")).toBe(1);
  });

  it("keeps the shared listener while any consumer is mounted, and lets it go with the last", async () => {
    const bridge = fakeBridge();
    let hide: (count: number) => void = () => {};
    function Some() {
      const [shown, setShown] = useState(2);
      hide = setShown;
      return (
        <>
          {shown >= 1 && <ProjectsConsumer />}
          {shown >= 2 && <ProjectsConsumer />}
        </>
      );
    }
    render(wrap(<Some />));
    await waitFor(() => expect(bridge.count("projects:list")).toBe(1));
    expect(bridge.listening("items:changed")).toBe(1);

    act(() => hide(1));
    expect(bridge.listening("items:changed")).toBe(1);
    await bridge.push("items:changed", {});
    await waitFor(() => expect(bridge.count("projects:list")).toBe(2));

    act(() => hide(0));
    expect(bridge.listening("items:changed")).toBe(0);
    expect(bridge.listening("config:changed")).toBe(0);
  });

  it("acts on a push when any one of the subscribers' filters wants it, and only once", async () => {
    const bridge = fakeBridge();
    function Version({ only }: { only: string }) {
      useQuery({ queryKey: ["probe"], queryFn: () => ipcQuery("projects:list", undefined) });
      useInvalidateOnPush("items:changed", ["probe"], { filter: (payload) => payload.itemId === only });
      return null;
    }
    render(
      wrap(
        <>
          <Version only="a" />
          <Version only="b" />
        </>,
      ),
    );
    await waitFor(() => expect(bridge.count("projects:list")).toBe(1));
    expect(bridge.listening("items:changed")).toBe(1);

    await bridge.push("items:changed", { itemId: "c" });
    await settle();
    expect(bridge.count("projects:list")).toBe(1);

    await bridge.push("items:changed", { itemId: "b" });
    await settle();
    expect(bridge.count("projects:list")).toBe(2);
  });
});

describe("the board's list is a key of its own (EO-560)", () => {
  it("invalidating itemsKey re-reads the board, not the archive or any card's authority", async () => {
    const bridge = fakeBridge();
    const client = createQueryClient();
    function Screen() {
      useQuery({ queryKey: itemsKey, queryFn: () => ipcQuery("items:list", undefined) });
      useQuery({ queryKey: archivedKey, queryFn: () => ipcQuery("items:listArchived", undefined) });
      useQuery({ queryKey: stepAuthorityKey("a"), queryFn: () => ipcQuery("items:authority", { itemId: "a" }) });
      return null;
    }
    render(wrap(<Screen />, client));
    await waitFor(() => expect(bridge.count("items:authority")).toBe(1));
    await settle();

    await act(() => client.invalidateQueries({ queryKey: itemsKey }));
    await settle();
    expect(bridge.count("items:list")).toBe(2);
    expect(bridge.count("items:listArchived")).toBe(1);
    expect(bridge.count("items:authority")).toBe(1);
  });
});
