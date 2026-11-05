import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Reading a directory tree in tests, in one place.
 *
 * Eight test files walked a directory with their own recursive `walk`,
 * and they did not agree with each other about the one detail that
 * matters on Windows: whether the keys they built were normalised to
 * `/`. Two did, two did not, and the two that did not were correct only
 * because they compared their own output with itself. A test asserting
 * one of those keys against a literal would have been the fourth POSIX
 * assumption the v0.4.1 release build found.
 *
 * Keys are always repository-relative and always `/`-separated here, on
 * every platform, so a test can write the path it means.
 *
 * Only tests import this module; see `testing/git.ts` for why that is
 * safe and `testing.test.ts` for what holds it.
 */

export interface TreeOptions {
  /** Directory or file names to leave out at any depth — `.git`, `node_modules`, an index. */
  skip?: readonly string[];
}

/** Every file under `root`, as absolute paths in a stable order. */
export function filesUnder(root: string, options: TreeOptions = {}): string[] {
  const skip = new Set(options.skip ?? []);
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      // A symlink counts as a file here, as it did in every walker this
      // replaces: a snapshot of a tree that can hold a link must show the
      // link, and reading a dangling one throws the way it always did.
      else if (entry.isFile() || entry.isSymbolicLink()) found.push(path);
    }
  };
  // A missing root throws, as `readdirSync` does. Returning an empty tree
  // for a directory that is not there would let "nothing was written"
  // pass for "the place it would be written does not exist".
  walk(root);
  return found.sort();
}

/** The same key for the same file on every platform: relative to `root`, `/`-separated. */
export function relativeKey(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/**
 * Every file under `root` as `relative/posix/path -> content`.
 *
 * The shape a test wants when it is asking "what exactly is on disk
 * now" — a snapshot it can compare with another snapshot, or assert a
 * single entry of by the path it means.
 */
export function readTree(root: string, options: TreeOptions & { encoding?: BufferEncoding } = {}): Record<string, string> {
  const tree: Record<string, string> = {};
  for (const path of filesUnder(root, options)) tree[relativeKey(root, path)] = readFileSync(path, options.encoding ?? "utf8");
  return tree;
}
