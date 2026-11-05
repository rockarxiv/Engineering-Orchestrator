import { HUMAN_MESSAGE_EVENT } from "./execution.js";
import type { TurnStep } from "./ipc-schemas.js";

/**
 * What the engine posts under an assistant turn a person stopped before it
 * answered. Shared so the window that draws the stopped turn's work open
 * above it and the process that posts it cannot spell it differently.
 */
export const TURN_STOPPED_NOTE = "Turn stopped.";

/**
 * A run's events, read as the steps a person scans (`TurnStepSchema`).
 *
 * What Claude Desktop draws between a question and its answer: what the
 * agent said along the way, what it thought, each tool it called with what
 * came back, and the files it changed. Pure, so the main process reads a
 * live turn and a finished one through the same function, and a test needs
 * no database.
 *
 * Nothing is reordered (ARCHITECTURE.md, "The transcript"): steps come out
 * in `seq` order, and a result is folded into the call it answers rather
 * than given a row of its own. A result with no call before it — a
 * backend that reported one bare — keeps a row, since dropping it would be
 * dropping something the run did.
 */
export function turnStepsOf(events: readonly { seq: number; type: string; payload: unknown }[]): TurnStep[] {
  const steps: TurnStep[] = [];
  const callsById = new Map<string, Extract<TurnStep, { kind: "tool" }>>();

  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case "output": {
        const text = typeof payload["text"] === "string" ? payload["text"].trim() : "";
        // An answer written as text under an output schema is JSON, and
        // is the message the turn posts — not narration to repeat above it.
        if (text !== "" && !looksLikeJson(text)) steps.push({ kind: "text", seq: event.seq, text: bounded(text, TEXT_LIMIT) });
        break;
      }
      case "reasoning": {
        const text = typeof payload["text"] === "string" ? payload["text"].trim() : "";
        if (text !== "") steps.push({ kind: "reasoning", seq: event.seq, text: bounded(text, TEXT_LIMIT) });
        break;
      }
      case "tool_call": {
        const name = typeof payload["name"] === "string" ? payload["name"] : "tool";
        // The answer itself, when a backend takes it as a tool call. Its
        // message is the comment that follows; a row saying "used
        // StructuredOutput" tells a person nothing.
        if (isAnswerTool(name)) break;
        const callId = typeof payload["callId"] === "string" ? payload["callId"] : null;
        const step: Extract<TurnStep, { kind: "tool" }> = {
          kind: "tool",
          seq: event.seq,
          callId,
          name,
          label: toolLabel(name, payload["args"]),
          input: inputOf(payload["args"]),
          ok: null,
          output: null,
        };
        steps.push(step);
        if (callId !== null) callsById.set(callId, step);
        break;
      }
      case "tool_result": {
        const callId = typeof payload["callId"] === "string" ? payload["callId"] : null;
        const name = typeof payload["name"] === "string" ? payload["name"] : "tool";
        if (isAnswerTool(name)) break;
        const ok = payload["ok"] !== false;
        const output = typeof payload["output"] === "string" ? bounded(payload["output"], OUTPUT_LIMIT) : null;
        const call = callId === null ? undefined : callsById.get(callId);
        if (call) {
          call.ok = ok;
          call.output = output;
        } else {
          steps.push({ kind: "tool", seq: event.seq, callId, name, label: toolLabel(name, undefined), input: null, ok, output });
        }
        break;
      }
      case "file_edit": {
        const path = typeof payload["path"] === "string" ? payload["path"] : null;
        // Claude reports an edit twice — as the Edit call and as the edit
        // it makes — and the call already says which file.
        if (path !== null && !steps.some((step) => step.kind === "tool" && step.seq === event.seq - 1 && EDIT_TOOLS.has(step.name) && step.input?.includes(path))) {
          steps.push({ kind: "edit", seq: event.seq, path });
        }
        break;
      }
      case "error": {
        const message = typeof payload["message"] === "string" ? payload["message"] : "The backend reported an error.";
        steps.push({ kind: "error", seq: event.seq, message: bounded(message, TEXT_LIMIT) });
        break;
      }
      case HUMAN_MESSAGE_EVENT: {
        const body = typeof payload["body"] === "string" ? payload["body"] : "";
        if (payload["delivered"] === true && body.trim() !== "") steps.push({ kind: "steer", seq: event.seq, text: bounded(body, TEXT_LIMIT) });
        break;
      }
      default:
        break;
    }
  }
  return steps;
}

/**
 * The answer the agent wrote as a call to the structured-output tool, as
 * far as it has been written. Empty when it has not started or the
 * backend writes its answer as text.
 */
export function answerArgsOf(events: readonly { type: string; payload: unknown }[]): unknown {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type !== "tool_call") continue;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (typeof payload["name"] === "string" && isAnswerTool(payload["name"])) return payload["args"];
  }
  return undefined;
}

/** The tool a backend takes a structured answer through — Claude's, under `outputFormat`. */
export function isAnswerTool(name: string): boolean {
  return name === "StructuredOutput";
}

/**
 * What a person reads for one tool call.
 *
 * The backends name their built-in tools differently and an MCP tool is
 * spelt `mcp__server__tool` by one and `server/tool` by the other
 * (ARCHITECTURE.md, "The parity rule"), so both spellings come out as
 * "server · tool". A built-in tool gets a verb and its subject where its
 * arguments name one — the file, the command, the pattern — and its own
 * name otherwise. Never more than a line.
 */
export function toolLabel(name: string, args: unknown): string {
  const input = args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const text = (key: string): string | null => (typeof input[key] === "string" && input[key] !== "" ? (input[key] as string) : null);
  const subject = (verb: string, value: string | null): string => (value === null ? verb : `${verb} ${oneLine(value)}`);

  switch (name) {
    case "Read":
      return subject("Read", text("file_path"));
    case "Write":
      return subject("Wrote", text("file_path"));
    case "Edit":
    case "MultiEdit":
      return subject("Edited", text("file_path"));
    case "NotebookEdit":
      return subject("Edited", text("notebook_path"));
    case "Bash":
    case "command_execution":
      return subject("Ran", text("command"));
    case "Grep":
      return subject("Searched for", text("pattern"));
    case "Glob":
      return subject("Listed", text("pattern"));
    case "WebFetch":
      return subject("Fetched", text("url"));
    case "WebSearch":
    case "web_search":
      return subject("Searched the web for", text("query"));
    case "Task":
    case "Agent":
      return subject("Asked a subagent to", text("description"));
    case "TodoWrite":
    case "todo_list":
      return "Updated the plan";
    case "ToolSearch":
      return "Looked up tools";
    default:
      break;
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name) ?? /^([^/\s]+)\/(.+)$/.exec(name);
  if (mcp) return `${mcp[1]} · ${mcp[2]}`;
  return name;
}

/** The tools whose call already names the file a following `file_edit` reports. */
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const TEXT_LIMIT = 8000;
const OUTPUT_LIMIT = 4000;
const INPUT_LIMIT = 2000;
const LABEL_LIMIT = 120;

function inputOf(args: unknown): string | null {
  if (args === undefined || args === null) return null;
  if (typeof args === "object" && !Array.isArray(args) && Object.keys(args).length === 0) return null;
  try {
    return bounded(JSON.stringify(args, null, 2), INPUT_LIMIT);
  } catch {
    return null;
  }
}

function oneLine(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > LABEL_LIMIT ? `${line.slice(0, LABEL_LIMIT - 1)}…` : line;
}

function bounded(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… ${text.length - limit} more characters` : text;
}

function looksLikeJson(text: string): boolean {
  const body = text.replace(/^```(?:json)?\s*/i, "");
  return body.startsWith("{");
}
