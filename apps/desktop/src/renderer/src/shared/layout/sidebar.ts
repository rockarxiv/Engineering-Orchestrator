import type { PipelineIcon } from "@eo/core";
import { Boxes, Database, type LucideIcon, Monitor, SquareStack, Workflow } from "lucide-react";

/**
 * A pipeline's glyph and the list of places, for both layouts' rails
 * (EO-519): the classic `layout/Sidebar.tsx` and the chat layout's
 * `chat/ChatRail.tsx`.
 */

/** Pipelines get a glyph so the list scans as marks rather than as prose. */
const PIPELINE_ICONS: LucideIcon[] = [SquareStack, Boxes, Database, Monitor, Workflow];

/** The names `pipelines.icon` can carry (`PIPELINE_ICON_NAMES`, which a help-chat draft is held to). Anything else falls back to the position. */
const ICONS_BY_NAME: Record<PipelineIcon, LucideIcon> = {
  "square-stack": SquareStack,
  boxes: Boxes,
  database: Database,
  monitor: Monitor,
  workflow: Workflow,
};

/**
 * A pipeline's own icon when it named one, its position otherwise.
 *
 * Position alone was the whole rule, which meant the column a pipeline
 * happened to sort into chose its glyph — reordering the sidebar silently
 * reassigned every icon.
 */
export function pipelineIcon(name: string | null, index: number): LucideIcon {
  return (name ? (ICONS_BY_NAME as Record<string, LucideIcon | undefined>)[name] : undefined) ?? PIPELINE_ICONS[index % PIPELINE_ICONS.length]!;
}

/**
 * The places, in the order the rail offers them.
 *
 * A function rather than a constant because the first one is the only
 * row in this rail whose word is not EO's own: it lists every item on
 * the project across every pipeline, so the design says it is named by the
 * pack when there is one pack and by the core when there is a mixture.
 * Everything below it is a screen rather than a collection, and a
 * screen is called what it is called.
 */
export const places = (items: string, organisation: boolean) => [
  { to: "/items", label: items },
  { to: "/inbox", label: "Inbox" },
  // Every unanswered question on the record, with the person it waits on
  // (EO-326, ARCHITECTURE.md, "Identity"). Directly under the inbox, because the pair is the
  // point: one is what is waiting on you, the other is what is waiting
  // on everybody, and reading them beside each other is how an admin
  // tells their own work from the organisation's.
  //
  // Absent where there is no organisation, which is every desktop. With
  // one person and one inbox the two rows would be the same list twice,
  // and a screen that says "across every project you can see" to
  // somebody who can see one is the app describing a scale it does not
  // have.
  ...(organisation ? [{ to: "/mentions", label: "All open mentions" }] : []),
  { to: "/archive", label: "Archive" },
  // EO-316. Among the Places rather than under the project, because a
  // template makes a project rather than belonging to one — and it is
  // where somebody goes to start their second pipeline as much as their
  // first (ARCHITECTURE.md, "The gallery").
  { to: "/gallery", label: "Templates" },
  { to: "/agents", label: "Agents" },
  // Beside Agents rather than inside Settings (EO-109). What is on it is
  // what an agent is given, so it belongs next to the agents it is given
  // to — and Settings already has an "MCP server" section meaning the
  // opposite thing, which is the confusion this route exists to avoid.
  { to: "/agent-tools", label: "Agent tools" },
  { to: "/settings", label: "Settings" },
];
