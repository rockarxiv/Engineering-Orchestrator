import { describe, expect, it } from "vitest";
import { withAbsoluteAssets } from "./http.js";

/**
 * Making the app's own page findable from a route (EO-319).
 *
 * `electron-vite` emits `./assets/index-DIJ_ibVJ.js`, because the
 * desktop loads the page off disk and a leading `/` there is the root of
 * the filesystem. Over HTTP that reference means something different at
 * every depth: at `/` it is `/assets/…` and at `/items/01a0…` it is
 * `/items/assets/…`, which is not a file. Both the script and the
 * stylesheet 404 and the page comes up blank — on the deep link somebody
 * was sent, and again on the refresh they press when it looks wrong.
 *
 * One `<base href="/">` settles it for every depth at once, which is why
 * it is this rather than a rewrite of each reference: a regex over
 * `src=` and `href=` would have to know which of them are assets, which
 * are anchors and which are inside a script, and would get the next
 * bundler's output wrong.
 */
describe("the page a server hands a browser", () => {
  const built = '<!doctype html><html lang="en"><head><meta charset="UTF-8" /><script type="module" src="./assets/index-a1b2.js"></script></head><body><div id=root></div></body></html>';

  it("declares a base of `/`, before anything that would resolve against it", () => {
    const served = withAbsoluteAssets(built);

    // Immediately after `<head>`: `<base>` governs only what follows it,
    // so one placed after the script tag would be decoration.
    expect(served).toContain('<head><base href="/">');
    expect(served.indexOf("<base")).toBeLessThan(served.indexOf("./assets/"));
  });

  it("changes nothing else about the page", () => {
    // The references themselves are left alone. What they mean changes;
    // what they say does not, so a bundler that renames its output has
    // nothing to disagree with here.
    expect(withAbsoluteAssets(built).replace('<base href="/">', "")).toBe(built);
  });

  it("leaves a page that already declares its own base alone", () => {
    // Two `<base href>` elements are not an error, they are the second
    // one being ignored — so adding one would be quietly disagreeing
    // with a page about where it thinks it is.
    const own = '<!doctype html><html><head><base href="/eo/"><script src="./assets/a.js"></script></head></html>';

    expect(withAbsoluteAssets(own)).toBe(own);
  });

  it("copes with a head that carries attributes, or none at all", () => {
    expect(withAbsoluteAssets('<html><head data-theme="dark"><p>')).toContain('<head data-theme="dark"><base href="/">');
    // A fragment with no `<head>` is not a page EO builds, but answering
    // it with a base rather than throwing keeps a malformed bundle a
    // cosmetic problem instead of a 500.
    expect(withAbsoluteAssets("<p>no head here")).toBe('<base href="/"><p>no head here');
  });

  it("is case-insensitive, as HTML is", () => {
    expect(withAbsoluteAssets("<HTML><HEAD><P>")).toContain('<HEAD><base href="/">');
    expect(withAbsoluteAssets('<head><BASE HREF="/x/"></head>')).toBe('<head><BASE HREF="/x/"></head>');
  });
});
