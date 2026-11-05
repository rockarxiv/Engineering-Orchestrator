import type { ReactNode } from "react";
import {
  AtSign,
  Archive,
  Bot,
  Columns3,
  FilePlus2,
  FileText,
  GitCompareArrows,
  GitFork,
  Inbox,
  LayoutGrid,
  ListChecks,
  Plug,
  Settings,
  SquareTerminal,
  Workflow,
} from "lucide-react";
import { DEFAULT_PIPELINE_ID } from "@eo/core";
import { useChromeVocabulary } from "../../query/hooks";
import { useItemKey, usePipelineName } from "./shared";
import { useJobName } from "./jobs/useJobName";
import { BoardView } from "./board/BoardView";
import { GraphView } from "./board/GraphView";
import { PipelineChangesView } from "./changes/PipelineChangesView";
import { ItemView } from "./item/ItemView";
import { RunsView } from "./item/RunsView";
import { ProposedItemView } from "./proposal/ProposedItemView";
import { useProposal } from "./proposal/useProposal";
import { ItemsView } from "./items/ItemsView";
import { InboxView } from "./inbox/InboxView";
import { MentionsView } from "./mentions/MentionsView";
import { ArchiveView } from "./archive/ArchiveView";
import { JobsView } from "./jobs/JobsView";
import { JobView } from "./jobs/JobView";
import { GalleryView } from "./gallery/GalleryView";
import { AgentsView } from "./agents/AgentsView";
import { AgentToolsView } from "./agentTools/AgentToolsView";
import { SettingsView } from "./settings/SettingsView";

/**
 * Every place the chat layout can show beside the conversation.
 *
 * Each is the address the classic screen for the same thing already has
 * — a board at `/pipelines/:id`, Settings at `/settings` — because the
 * assistant reads the address to know what is open (`ViewPublisher`,
 * `pageDescriptorFor`), and links from anywhere in the app keep working.
 * Only the drawing is the chat layout's own: no classic screen is ever
 * mounted in this layout.
 *
 * A view reads its own query parameters (`?section=`, `?step=`,
 * `?changes`) with `useSearchParams`; what is here is only which view
 * an address names and which tab it belongs in.
 */
export type ChatView =
  | { kind: "board"; pipelineId: string }
  | { kind: "graph"; pipelineId: string }
  /** What changed between two versions, read-only (EO-524). What is compared is in its query (`changesComparedOf`). */
  | { kind: "changes"; pipelineId: string }
  | { kind: "item"; itemId: string }
  | { kind: "runs"; itemId: string }
  /** An item a work proposal would create, before it is filed (EO-408): the card's message and the item's place among its rows. */
  | { kind: "proposedItem"; messageId: string; index: number }
  | { kind: "items" }
  | { kind: "inbox" }
  | { kind: "mentions" }
  | { kind: "archive" }
  | { kind: "jobs" }
  | { kind: "job"; jobId: string }
  | { kind: "gallery" }
  | { kind: "agents" }
  | { kind: "agentTools" }
  | { kind: "settings" };

export type ChatViewKind = ChatView["kind"];

const decode = (segment: string) => decodeURIComponent(segment);

/**
 * The view an address names, or null for the home and for an address
 * nothing draws.
 *
 * Discussions is gone (EO-526): planning work and changing a pipeline
 * are things the person says in the conversation, which is the one room
 * in this layout. Its old addresses (a link in an old comment, a
 * bookmark) come home to it.
 */
export function chatViewFor(pathname: string, search: string): ChatView | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  const params = new URLSearchParams(search);
  const graph = params.get("view") === "graph";
  const exact: Record<string, ChatView> = {
    "/items": { kind: "items" },
    "/inbox": { kind: "inbox" },
    "/mentions": { kind: "mentions" },
    "/archive": { kind: "archive" },
    "/jobs": { kind: "jobs" },
    "/gallery": { kind: "gallery" },
    "/agents": { kind: "agents" },
    "/agent-tools": { kind: "agentTools" },
    "/settings": { kind: "settings" },
  };
  if (path in exact) return exact[path]!;
  if (path === "/project") return graph ? { kind: "graph", pipelineId: DEFAULT_PIPELINE_ID } : { kind: "board", pipelineId: DEFAULT_PIPELINE_ID };
  // The editor that drew this address is gone (EO-525): the frame
  // replaces it with the graph's (`movedAddressOf`), and until it has,
  // it is the graph.
  let match = /^\/pipelines\/([^/]+)\/configure$/.exec(path);
  if (match) return { kind: "graph", pipelineId: decode(match[1]!) };
  // `PIPELINE_CHANGES_ROUTE`.
  match = /^\/pipelines\/([^/]+)\/changes$/.exec(path);
  if (match) return { kind: "changes", pipelineId: decode(match[1]!) };
  match = /^\/pipelines\/([^/]+)$/.exec(path);
  if (match) return graph ? { kind: "graph", pipelineId: decode(match[1]!) } : { kind: "board", pipelineId: decode(match[1]!) };
  match = /^\/items\/([^/]+)\/runs$/.exec(path);
  if (match) return { kind: "runs", itemId: decode(match[1]!) };
  match = /^\/items\/([^/]+)$/.exec(path);
  if (match) return { kind: "item", itemId: decode(match[1]!) };
  // `PROPOSED_ITEM_ROUTE`. A place that is not a whole number names no row, so it names no view.
  match = /^\/proposals\/([^/]+)\/(\d+)$/.exec(path);
  if (match) return { kind: "proposedItem", messageId: decode(match[1]!), index: Number(match[2]) };
  match = /^\/jobs\/([^/]+)$/.exec(path);
  if (match) return { kind: "job", jobId: decode(match[1]!) };
  return null;
}

/**
 * Where an address this layout no longer draws has gone, or null for
 * every other address.
 *
 * Only a pipeline's configure address (EO-525): the editor that drew it
 * is gone, and a pipeline is changed through the assistant. A link to it
 * — an old comment, a refusal, a bookmark — is replaced by the pipeline's
 * Graph view, which shows the same setup read-only. Replaced rather than
 * only drawn as the graph, so the address the assistant reads
 * (`view:current`) is the graph's and not an editor's that is not there.
 */
export function movedAddressOf(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  const match = /^\/pipelines\/([^/]+)\/configure$/.exec(path);
  return match ? `/pipelines/${match[1]!}?view=graph` : null;
}

/**
 * Which tab a view belongs in. A pipeline's board, graph and changes
 * are one tab, as an item and its runs are: they are one thing seen three
 * ways, and a row of tabs reading "Weekly report, Weekly report ·
 * pipeline, Weekly report · changes" is a row nobody can use.
 *
 * Each proposed item is its own tab, as each item is: three opened from
 * one proposal are three things to read side by side.
 */
export function tabKeyOf(view: ChatView): string {
  switch (view.kind) {
    case "board":
    case "graph":
    case "changes":
      return `pipeline:${view.pipelineId}`;
    case "item":
    case "runs":
      return `item:${view.itemId}`;
    case "proposedItem":
      return `proposal:${view.messageId}:${view.index}`;
    case "job":
      return `job:${view.jobId}`;
    default:
      return view.kind;
  }
}

/**
 * Views drawn for the whole width — a settings page, an agent editor — open
 * with the conversation folded to its strip. One press brings it back.
 */
const WIDE: ReadonlySet<ChatViewKind> = new Set(["settings", "agents", "agentTools", "gallery", "jobs", "job"]);

export function isWide(view: ChatView): boolean {
  return WIDE.has(view.kind);
}

/** The view itself. Keyed by the caller on the address, so two items are two mounts. */
export function ViewBody({ view }: { view: ChatView }) {
  switch (view.kind) {
    case "board":
      return <BoardView pipelineId={view.pipelineId} />;
    case "graph":
      return <GraphView pipelineId={view.pipelineId} />;
    case "changes":
      return <PipelineChangesView pipelineId={view.pipelineId} />;
    case "item":
      return <ItemView itemId={view.itemId} />;
    case "runs":
      return <RunsView itemId={view.itemId} />;
    case "proposedItem":
      return <ProposedItemView messageId={view.messageId} index={view.index} tabKey={tabKeyOf(view)} />;
    case "items":
      return <ItemsView />;
    case "inbox":
      return <InboxView />;
    case "mentions":
      return <MentionsView />;
    case "archive":
      return <ArchiveView />;
    case "jobs":
      return <JobsView />;
    case "job":
      return <JobView jobId={view.jobId} />;
    case "gallery":
      return <GalleryView />;
    case "agents":
      return <AgentsView />;
    case "agentTools":
      return <AgentToolsView />;
    case "settings":
      return <SettingsView />;
  }
}

/** What a tab, and the conversation's context chip, call a view. */
export function ViewLabel({ view }: { view: ChatView }): ReactNode {
  const vocabulary = useChromeVocabulary();
  switch (view.kind) {
    case "board":
    case "graph":
    case "changes":
      return <PipelineLabel view={view} />;
    case "item":
    case "runs":
      return <ItemLabel view={view} />;
    case "proposedItem":
      return <ProposedItemLabel view={view} />;
    case "job":
      return <JobLabel jobId={view.jobId} />;
    case "items":
      return labelled(<ListChecks size={14} />, vocabulary.items);
    case "inbox":
      return labelled(<Inbox size={14} />, "Inbox");
    case "mentions":
      return labelled(<AtSign size={14} />, "Open questions");
    case "archive":
      return labelled(<Archive size={14} />, "Archive");
    case "jobs":
      return labelled(<Workflow size={14} />, "Jobs");
    case "gallery":
      return labelled(<LayoutGrid size={14} />, "Gallery");
    case "agents":
      return labelled(<Bot size={14} />, "Agents");
    case "agentTools":
      return labelled(<Plug size={14} />, "Agent tools");
    case "settings":
      return labelled(<Settings size={14} />, "Settings");
  }
}

function labelled(icon: ReactNode, text: string) {
  return (
    <>
      {icon}
      <span className="truncate">{text}</span>
    </>
  );
}

function PipelineLabel({ view }: { view: Extract<ChatView, { kind: "board" | "graph" | "changes" }> }) {
  const name = usePipelineName(view.pipelineId);
  const icon =
    view.kind === "board" ? (
      <Columns3 size={14} />
    ) : view.kind === "graph" ? (
      <GitFork size={14} />
    ) : (
      <GitCompareArrows size={14} />
    );
  return labelled(icon, name);
}

function ItemLabel({ view }: { view: Extract<ChatView, { kind: "item" | "runs" }> }) {
  const key = useItemKey(view.itemId);
  return labelled(view.kind === "item" ? <FileText size={14} /> : <SquareTerminal size={14} />, key);
}

/** A proposed item's tab: its title, since it has no key — and its key, once approving has given it one. */
function ProposedItemLabel({ view }: { view: Extract<ChatView, { kind: "proposedItem" }> }) {
  const vocabulary = useChromeVocabulary();
  const { proposal } = useProposal(view.messageId);
  const row = proposal?.rows[view.index];
  if (row?.kind === "new" && row.created) return labelled(<FileText size={14} />, row.created.key);
  if (row?.kind === "change") return labelled(<FileText size={14} />, row.itemKey);
  return labelled(<FilePlus2 size={14} />, row?.title ?? `Proposed ${vocabulary.item.toLowerCase()}`);
}

function JobLabel({ jobId }: { jobId: string }) {
  const name = useJobName(jobId);
  return labelled(<Workflow size={14} />, name);
}
