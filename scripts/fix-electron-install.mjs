#!/usr/bin/env node
// Leaves every electron package in the workspace with its binary extracted,
// so `pnpm install` is the only step that touches the network for it.
//
// Since Electron 42 the electron package has no postinstall: it downloads
// its binary the first time something asks it for the binary's path
// (`require("electron")`, `npx electron`). Left to that, the download would
// happen in the middle of whatever asked first — a Playwright launch under
// its timeout, electron-vite dev, the packager — so this runs the package's
// own installer (`install.js`, the same code the postinstall used to be)
// for any copy that is not extracted yet.
//
// It also keeps a workaround for a real-world failure mode, not a
// hypothetical one: on some Node versions the installer's extraction
// promise never settled — it neither resolved nor rejected, so the process
// exited 0 with the zip downloaded into the @electron/get cache and the
// binary silently left unextracted. If the binary is still missing after
// the installer, this finishes the job from that cached zip.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function cacheDir() {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Caches", "electron");
  if (process.platform === "win32") {
    const localAppData = process.env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local");
    return path.join(localAppData, "electron", "Cache");
  }
  return path.join(process.env["XDG_CACHE_HOME"] ?? path.join(home, ".cache"), "electron");
}

function platformBinaryRelPath() {
  switch (process.platform) {
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "win32":
      return "electron.exe";
    default:
      return "electron";
  }
}

function findWorkspaceElectronDirs() {
  const store = path.join(repoRoot, "node_modules", ".pnpm");
  if (!existsSync(store)) return [];
  return readdirSync(store)
    .filter((entry) => entry.startsWith("electron@"))
    .map((entry) => path.join(store, entry, "node_modules", "electron"))
    .filter((dir) => existsSync(dir));
}

function isAlreadyExtracted(electronDir, version, binaryRelPath) {
  const pathTxt = path.join(electronDir, "path.txt");
  const versionFile = path.join(electronDir, "dist", "version");
  if (!existsSync(pathTxt) || !existsSync(versionFile)) return false;
  const recordedVersion = readFileSync(versionFile, "utf8").trim().replace(/^v/, "");
  const recordedPath = readFileSync(pathTxt, "utf8").trim();
  if (recordedVersion !== version || recordedPath !== binaryRelPath) return false;
  return existsSync(path.join(electronDir, "dist", binaryRelPath));
}

function findCachedZip(version) {
  const dir = cacheDir();
  if (!existsSync(dir)) return null;
  const wanted = `electron-v${version}-${process.platform}-${process.arch}.zip`;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) stack.push(full);
      else if (entry === wanted) return full;
    }
  }
  return null;
}

function extractZip(zipPath, destDir) {
  if (process.platform === "win32") {
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `Expand-Archive -Force -Path "${zipPath}" -DestinationPath "${destDir}"`],
      { stdio: "inherit" },
    );
  } else {
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", destDir], { stdio: "inherit" });
  }
}

const binaryRelPath = platformBinaryRelPath();

for (const electronDir of findWorkspaceElectronDirs()) {
  const pkg = JSON.parse(readFileSync(path.join(electronDir, "package.json"), "utf8"));
  const version = pkg.version;
  if (isAlreadyExtracted(electronDir, version, binaryRelPath)) continue;

  const installer = path.join(electronDir, "install.js");
  if (existsSync(installer)) {
    console.log(`[fix-electron-install] downloading the binary for electron@${version}`);
    try {
      execFileSync(process.execPath, [installer], { cwd: electronDir, stdio: "inherit" });
    } catch {
      // Reported below if the binary is still missing.
    }
    if (isAlreadyExtracted(electronDir, version, binaryRelPath)) continue;
  }

  const zip = findCachedZip(version);
  if (!zip) {
    console.warn(
      `[fix-electron-install] electron@${version} is not extracted and no cached zip was found. ` +
        `Re-run pnpm install, or check network access to the electron binary CDN.`,
    );
    continue;
  }

  console.log(`[fix-electron-install] finishing incomplete extraction for electron@${version} from ${zip}`);
  const distDir = path.join(electronDir, "dist");
  extractZip(zip, distDir);
  writeFileSync(path.join(electronDir, "path.txt"), binaryRelPath);
  if (process.platform !== "win32") {
    try {
      execFileSync("chmod", ["+x", path.join(distDir, binaryRelPath)]);
    } catch {
      // best-effort; if this fails the subsequent electron launch will surface it
    }
  }
}
