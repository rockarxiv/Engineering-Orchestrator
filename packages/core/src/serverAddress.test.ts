import { describe, expect, it } from "vitest";
import { addressHost, isLoopbackHost, normalizeServerAddress, serverAddressFault, serverAddressRefusal } from "./serverAddress.js";

/**
 * TLS, or loopback, and nothing else (EO-323, ARCHITECTURE.md, "The server", the story's third
 * acceptance criterion).
 *
 * "Plain HTTP to a non-loopback address is refused with the stated
 * reason." What the refusal protects is specific: a sign-in carries a
 * password and comes back with a device token that is then on every
 * request this machine makes for the life of the installation.
 */
describe("what a desktop will sign in to", () => {
  it("refuses plain http to a non-loopback address, and says what would be sent in the clear", () => {
    expect(serverAddressFault("http://eo.example.com")).toEqual({ kind: "insecure", host: "eo.example.com" });

    const refusal = serverAddressRefusal("http://eo.example.com");

    // The one line, and the two things in it that make it a reason
    // rather than a rule: what would cross the network, and what to type
    // instead.
    expect(refusal).toContain("eo.example.com");
    expect(refusal).toContain("in the clear");
    expect(refusal).toContain("https://eo.example.com");
    expect(refusal?.split("\n")).toHaveLength(1);
  });

  it("accepts https anywhere", () => {
    for (const address of ["https://eo.example.com", "https://eo.example.com:8443/", "https://192.0.2.7"]) {
      expect(serverAddressFault(address), address).toBeNull();
    }
  });

  it("accepts plain http to this machine, because there is no wire to read it off", () => {
    for (const address of ["http://localhost:8765", "http://127.0.0.1:8765", "http://127.0.0.2", "http://[::1]:8765"]) {
      expect(serverAddressFault(address), address).toBeNull();
    }
  });

  it("is not fooled by a loopback name in the userinfo or the path", () => {
    // `http://127.0.0.1@evil.example.com` connects to evil.example.com.
    // A check that read the host by splitting on the first `:` or by
    // asking whether the string contains "127.0.0.1" would wave it
    // through, which is the whole reason `addressHost` takes the
    // userinfo off first.
    expect(addressHost("http://127.0.0.1@evil.example.com/x")).toBe("evil.example.com");
    expect(serverAddressFault("http://127.0.0.1@evil.example.com")).toEqual({ kind: "insecure", host: "evil.example.com" });
    expect(serverAddressFault("http://evil.example.com/127.0.0.1")).toEqual({ kind: "insecure", host: "evil.example.com" });
  });

  it("says what is wrong with something that is not an address at all", () => {
    expect(serverAddressRefusal("")).toContain("https://eo.example.com");
    expect(serverAddressRefusal("eo.example.com")).toContain("starts with https://");
    expect(serverAddressRefusal("ftp://eo.example.com")).toContain("ftp");
    expect(serverAddressRefusal("https:///items")).toContain("no server in it");
  });

  it("knows the whole loopback range, and does not count 0.0.0.0 as an address anybody types", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.255.255.254")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    // A bind address rather than a destination: as somewhere to *reach*
    // it means "this machine" on Linux and nothing portable elsewhere.
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.example.com")).toBe(false);
  });

  it("stores an address with no trailing slash, so a path is never doubled", () => {
    expect(normalizeServerAddress(" https://eo.example.com/// ")).toBe("https://eo.example.com");
    expect(normalizeServerAddress("https://eo.example.com")).toBe("https://eo.example.com");
  });
});
