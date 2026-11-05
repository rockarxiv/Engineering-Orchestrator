import { describe, expect, it } from "vitest";
import { windowsSystemExecutable, windowsSystemTar } from "./systemTar.js";

describe("Windows' own programs, by absolute path (EO-389)", () => {
  it("are found under the configured system root, whichever spelling the variable has", () => {
    expect(windowsSystemExecutable("taskkill.exe", { SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\taskkill.exe");
    expect(windowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell.exe", { SYSTEMROOT: "D:\\Win" })).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(windowsSystemTar({ SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\tar.exe");
  });

  it("fall back to C:\\Windows for a root that is unset, empty or relative, and never consult PATH", () => {
    for (const env of [{}, { SystemRoot: "" }, { SystemRoot: "Windows" }]) {
      expect(windowsSystemExecutable("taskkill.exe", { ...env, PATH: "C:\\elsewhere" })).toBe("C:\\Windows\\System32\\taskkill.exe");
    }
  });
});
