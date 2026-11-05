import { readFileSync } from "node:fs";
import { SERVER_SECRET_KEY_BYTES } from "./serverStore.js";

/**
 * Where a server's secret key comes from, and what EO says when it
 * does not come at all (EO-320, `ARCHITECTURE.md`,
 * "Secrets").
 *
 * A desktop never answers this question: `safeStorage` asks the login
 * keyring and the person unlocked that when they logged in. A server
 * has to be *given* the key, and the two ways an operator gives a
 * container a secret are an environment variable and a file they
 * mounted — Docker and Kubernetes both spell the second one, and it is
 * the better of the two because a file is not in `/proc/1/environ` and
 * not in `docker inspect`.
 *
 * ### Why it never generates one
 *
 * The story is explicit and it is the whole of this module's opinion: a
 * key EO invented on first boot is a key nobody wrote down. The volume
 * survives the container, the key does not, and the first restart onto
 * a fresh filesystem — or the first time somebody restores yesterday's
 * volume into a new container — turns every stored secret into
 * unreadable bytes with no way back. So the absence of a key is a
 * refusal to start, in one line, naming the variable to set. Compare
 * `EO_SERVER_TOKEN` in `server/config.ts`, which refuses for the mirror
 * reason: what is dangerous there is a default anyone could guess, and
 * what is dangerous here is a value only this boot ever knew.
 */

/** The key itself, for an operator who is willing to put it in the environment. */
export const SERVER_SECRET_KEY_VARIABLE = "EO_SERVER_SECRET_KEY";
/** The path to a file holding it — what a mounted Docker or Kubernetes secret looks like. */
export const SERVER_SECRET_KEY_FILE_VARIABLE = "EO_SERVER_SECRET_KEY_FILE";
/** The key to rotate *onto*. Only `rotateCommand.ts` reads these two. */
export const NEW_SERVER_SECRET_KEY_VARIABLE = "EO_SERVER_NEW_SECRET_KEY";
export const NEW_SERVER_SECRET_KEY_FILE_VARIABLE = "EO_SERVER_NEW_SECRET_KEY_FILE";

/** How to make one, said everywhere EO says a key is missing or malformed. */
const HOW_TO_MAKE_ONE = "Make one with `openssl rand -base64 32`.";

export type SecretKeyResult = { ok: true; key: Buffer } | { ok: false; problem: string };

export interface SecretKeyNames {
  /** The variable that may hold the key itself. */
  value: string;
  /** The variable that may hold a path to it. */
  file: string;
  /** The flag that may hold a path to it, without the leading dashes. */
  fileFlag: string;
}

export interface SecretKeyRequest {
  /** What the value variable held, if anything. */
  value?: string | undefined;
  /** What the file variable or the flag held, if anything. */
  file?: string | undefined;
  names: SecretKeyNames;
  /** Completes "…to the key this server ⟨purpose⟩." */
  purpose: string;
}

/**
 * The key, or the one sentence that says which variable is missing.
 *
 * A result rather than a throw, for the reason `readServerConfig` gives:
 * this is the boundary between an operator's environment and EO, and a
 * stack trace is the wrong way to tell somebody they forgot a variable.
 *
 * The file wins over the variable when both are set, because the file is
 * the safer of the two and an operator who arranged one meant it.
 */
export function readSecretKey(request: SecretKeyRequest): SecretKeyResult {
  const { names } = request;
  const path = present(request.file);

  if (path !== null) {
    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch (error) {
      return { ok: false, problem: `EO could not read the key file at ${path} that ${names.file} names: ${message(error)}` };
    }
    return parseSecretKey(contents, `The key file at ${path}`);
  }

  const inline = present(request.value);
  if (inline !== null) return parseSecretKey(inline, names.value);

  return {
    ok: false,
    problem:
      `Set ${names.value} (or ${names.file}, or pass --${names.fileFlag}) to the key this server ${request.purpose}. ` +
      `EO will not generate one: a key it made up is a key nobody backed up, and every secret on this volume would be unreadable the ` +
      `first time the container starts without it. ${HOW_TO_MAKE_ONE}`,
  };
}

/**
 * 32 bytes, as base64 or hex, and nothing else.
 *
 * Not a passphrase, deliberately, and not a passphrase stretched into a
 * key either: a KDF here would accept `hunter2` and turn a refusal an
 * operator can fix in one command into a weakness nobody can see. Both
 * encodings because `openssl rand` writes base64 and every other tool
 * writes hex, and base64url as well because that is what a generator
 * that expects to go in a URL produces.
 *
 * Whitespace goes first: a key file written by `openssl rand -base64 32
 * > key` ends in a newline, and refusing that would be a refusal about
 * nothing.
 *
 * @param source what to call it in a refusal — a variable's name, or a path
 */
export function parseSecretKey(text: string, source: string): SecretKeyResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, problem: `${source} is empty. EO wants ${String(SERVER_SECRET_KEY_BYTES)} random bytes as base64 or hex. ${HOW_TO_MAKE_ONE}` };
  }

  const decoded = decode(trimmed);
  if (decoded === null || decoded.length !== SERVER_SECRET_KEY_BYTES) {
    const size = decoded === null ? "is not base64 or hex at all" : `decodes to ${String(decoded.length)}`;
    return {
      ok: false,
      problem: `${source} is not a ${String(SERVER_SECRET_KEY_BYTES)}-byte key — it ${size}. ${HOW_TO_MAKE_ONE}`,
    };
  }
  return { ok: true, key: decoded };
}

/**
 * Hex, then base64 (either alphabet), and null for anything else.
 *
 * Checked against a pattern rather than handed to `Buffer.from`, which
 * decodes base64 leniently: it drops characters it does not recognise
 * and answers with however many bytes survived, so a sentence somebody
 * pasted by mistake can come back as a short buffer instead of as an
 * error. The length check would still catch it; saying *why* is better.
 */
function decode(text: string): Buffer | null {
  if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0) return Buffer.from(text, "hex");
  if (/^[A-Za-z0-9+/\-_]+={0,2}$/.test(text)) return Buffer.from(text, "base64");
  return null;
}

/** Empty is unset, for the reason `chosen` in `server/config.ts` gives. */
function present(value: string | undefined): string | null {
  return value !== undefined && value.trim().length > 0 ? value.trim() : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
