import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The renderer's content security policy, read from the `index.html` that
 * ships rather than restated here.
 *
 * jsdom does not enforce CSP, so a component test of `AttachmentCard`
 * passes whether or not the browser would ever load its `data:` preview —
 * which is how every image preview came to be blocked without a single
 * test failing (EO-349). This reads the policy itself.
 */
const indexHtml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8");

function shippedPolicy(): Map<string, string[]> {
  const document = new DOMParser().parseFromString(indexHtml, "text/html");
  const metas = document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
  expect(metas).toHaveLength(1);
  const content = metas[0]?.getAttribute("content") ?? "";
  const directives = new Map<string, string[]>();
  for (const directive of content.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name) directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

describe("renderer content security policy", () => {
  it("allows data: URLs for images, which is how attachment previews arrive", () => {
    expect(shippedPolicy().get("img-src")).toEqual(expect.arrayContaining(["'self'", "data:"]));
  });

  it("allows data: nowhere but images", () => {
    for (const [name, sources] of shippedPolicy()) {
      if (name === "img-src") continue;
      expect(sources, name).not.toContain("data:");
    }
  });

  it("leaves every other directive as it was", () => {
    const policy = shippedPolicy();
    expect(policy.get("default-src")).toEqual(["'self'"]);
    expect(policy.get("script-src")).toEqual(["'self'"]);
    expect(policy.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect([...policy.keys()].sort()).toEqual(["default-src", "img-src", "script-src", "style-src"]);
  });
});
