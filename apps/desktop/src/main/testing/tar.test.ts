import { describe, expect, it } from "vitest";
import { fixtureTar } from "./tar.js";

/**
 * The tar the archive fixtures run (EO-389): the system one by absolute
 * path on Windows, whatever shell started the suite, and plain `tar`
 * everywhere else.
 */
describe("the tar a fixture builds its archive with", () => {
  it("is the system tar by absolute path on Windows, with or without SystemRoot", () => {
    expect(fixtureTar("win32", { SystemRoot: "D:\\WINNT" })).toBe("D:\\WINNT\\System32\\tar.exe");
    expect(fixtureTar("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("is tar on PATH everywhere else", () => {
    expect(fixtureTar("linux", {})).toBe("tar");
    expect(fixtureTar("darwin", { SystemRoot: "C:\\Windows" })).toBe("tar");
  });
});
