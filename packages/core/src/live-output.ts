import { unwrapOutcome } from "./schemas/clarification.js";

/**
 * What to show while an agent is still writing (Discussions).
 *
 * The chat shows the run's output as it arrives, before the final comment
 * lands. But an agent under constrained generation is not writing prose —
 * it is writing the JSON its schema asks for, and the person watching saw
 * `{"outcome":{"message":"I'll first trace how..." ,"questions":[],...`
 * on screen, braces and all.
 *
 * Two things were wrong. The reader looked for a top-level `message`,
 * which no result has: `outputSchemaFor` nests everything under `outcome`
 * so one provider's API will accept a union at all. And it parsed each
 * output event on its own, so a message split across chunks — which is
 * what streaming *is* — never parsed at any point.
 *
 * So the chunks are glued back together first, and the result is read
 * tolerantly: a complete object gives its `message`, and an incomplete
 * one gives as much of the message as has arrived. Nothing else is ever
 * shown. Half-written JSON is not a status update.
 */
export function liveMessageOf(chunks: string[]): string {
  const inside = messageInside(chunks.join(""));
  // Not JSON at all: a provider with no structured output, or a model
  // narrating in plain text. Shown as written, blocks separated.
  return inside ?? chunks.join("\n\n");
}

/**
 * The `message` inside a structured result, however much of it exists.
 *
 * Null means "this is not a structured result", which is different from
 * "" — the empty string is a result whose message has not started
 * arriving yet, and the honest thing to show for it is nothing.
 */
function messageInside(raw: string): string | null {
  // A model asked for JSON often writes it in a fence. The closing half
  // may not have arrived, so only the opening one is required.
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  if (!text.startsWith("{")) return null;

  try {
    const value = unwrapOutcome(JSON.parse(text));
    if (typeof value === "object" && value !== null && typeof (value as { message?: unknown }).message === "string") {
      return (value as { message: string }).message;
    }
    // Valid JSON with no message — a clarification, or a shape this
    // function knows nothing about. Not something to put on screen.
    return "";
  } catch {
    return partialMessage(text);
  }
}

/** Reads the message field of a JSON object that is still being written. */
function partialMessage(text: string): string {
  const key = /"message"\s*:\s*"/.exec(text);
  if (!key) return ""; // still writing the wrapper; there is nothing to say yet

  const start = key.index + key[0].length;
  let end = start;
  while (end < text.length) {
    if (text[end] === "\\") {
      end += 2; // an escape and whatever it escapes, including a quote
      continue;
    }
    if (text[end] === '"') break;
    end += 1;
  }

  return decodeStringBody(text.slice(start, Math.min(end, text.length)));
}

/**
 * Turns the raw bytes of a JSON string body into the text it denotes.
 *
 * Done by re-quoting and parsing rather than by hand, so `\n`, `\"` and
 * `\uXXXX` all mean what JSON says they mean. The tail is trimmed when it
 * cuts an escape in half — the only way a well-formed prefix can fail to
 * parse — and no further than the longest escape there is.
 */
function decodeStringBody(body: string): string {
  for (let cut = body.length; cut >= Math.max(0, body.length - 6); cut--) {
    try {
      return JSON.parse(`"${body.slice(0, cut)}"`) as string;
    } catch {
      // one more character of a half-arrived escape
    }
  }
  return "";
}
