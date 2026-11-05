/**
 * Just enough tar to unpack an npm tarball (A-08).
 *
 * Written rather than depended upon. The format is a sequence of
 * 512-byte headers each followed by its file's bytes padded to 512, and
 * all we need from it is "give me the regular files" — which is less
 * code than the argument for adding a dependency would be.
 *
 * Deliberately strict about paths: an entry is refused rather than
 * sanitised if it escapes the destination. A tarball is downloaded from
 * the network, and `../../../.bashrc` is the oldest trick there is.
 */

const BLOCK = 512;

export interface TarEntry {
  /** Path with npm's leading `package/` stripped, using forward slashes. */
  path: string;
  contents: Buffer;
  /** From the header. Only the executable bit is acted on. */
  mode: number;
}

/** Thrown for a malformed archive or an entry that tries to escape. */
export class TarError extends Error {}

function readString(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

function readOctal(header: Buffer, start: number, length: number): number {
  const text = readString(header, start, length).trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

/**
 * Every regular file in the archive, in order.
 *
 * npm wraps its tarballs in a single `package/` directory, which is
 * stripped here so callers deal in the paths the package actually
 * declares.
 */
export function extractTar(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);

    // Two consecutive zero blocks end the archive; one is enough to stop.
    if (header[0] === 0) break;

    const name = readString(header, 0, 100);
    const size = readOctal(header, 124, 12);
    const mode = readOctal(header, 100, 8);
    const type = readString(header, 156, 1);
    const prefix = readString(header, 345, 155);
    const full = prefix === "" ? name : `${prefix}/${name}`;

    offset += BLOCK;

    // "0" and "\0" are regular files. Directories, symlinks, and the
    // GNU long-name extensions are skipped: npm packages do not need
    // them, and silently mishandling a symlink is how a tarball writes
    // somewhere it should not.
    if (type === "0" || type === "") {
      entries.push({ path: stripPackagePrefix(full), contents: tar.subarray(offset, offset + size), mode });
    }

    offset += Math.ceil(size / BLOCK) * BLOCK;
  }

  return entries;
}

function stripPackagePrefix(path: string): string {
  return path.startsWith("package/") ? path.slice("package/".length) : path;
}

/**
 * Is this entry safe to write under a destination directory?
 *
 * Absolute paths, drive letters and any `..` segment are refused
 * outright rather than normalised — a tarball has no legitimate reason
 * to contain one, so the only thing normalising achieves is making an
 * attack quieter.
 */
export function isSafeEntryPath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return !path.split(/[/\\]/).includes("..");
}
