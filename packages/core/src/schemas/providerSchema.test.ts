import { describe, expect, it } from "vitest";
import { developerRegistry } from "../registry/developer.js";
import { outputSchemaFor } from "./index.js";

// The registry as EO ships it (KAN-124): these snapshots are the developer
// pack's schemas, which is whose provider schemas this file pins.
const registry = developerRegistry();

/**
 * The JSON Schema each provider is handed for constrained generation,
 * byte for byte (EO-217).
 *
 * The snapshot was written against the zod-only `outputSchemaFor`,
 * before schemas started travelling behind the `OutputSchema` interface.
 * Its job is to prove that wrapping changed nothing a provider can see:
 * the same `$schema` dialect at the root, the same `outcome` wrapper,
 * the clarification branch first, every field and `required` list where
 * it was. A change here is a change in what every agent is asked to
 * produce, and it should be made on purpose.
 *
 * `refine` is listed twice because it is two actions wearing one name
 * (KAN-19): a feature decomposes, anything else is asked whether it is
 * ready.
 */
const PROVIDER_SCHEMAS: ReadonlyArray<readonly [action: string, itemType: string | undefined]> = [
  ["intake", undefined],
  ["refine", undefined],
  ["refine", "feature"],
  ["refine", "story"],
  ["refine", "bug"],
  ["implement", undefined],
  ["review", undefined],
  ["plan_comment_response", undefined],
  ["review_plan", undefined],
  ["assist", undefined],
  ["respond", undefined],
  ["interpret", undefined],
];

/**
 * The type row each of these words names (KAN-146, KAN-163).
 *
 * `outputSchemaFor` takes the item's *type* rather than its word now —
 * the flag it used to take went the same way — and the rows keep the
 * word so that the snapshot names still say which item each shape is
 * for. The point of this file is that the shape handed to a provider for
 * a feature, a story and a bug is byte-identical to what it was before
 * either replacement, so the types are the pack's own rather than
 * fixtures written here.
 */
const typeNamed = (slug: string) => registry.itemTypes.get(`developer:${slug}`);

/**
 * Two things about `intake` changed on purpose in KAN-147, and the
 * snapshot is where they are visible.
 *
 * Its shape is composed from the item types now rather than written as a
 * three-branch union, so the document EO ships it as is a JSON Schema
 * rather than zod's emission of one. The branches came out byte-identical
 * — which is the point, and which is why the bug branch below is
 * unchanged to the character — with two differences:
 *
 * - The story's `acceptance_criteria` carries a `title` and a
 *   `description`. They are the words `submitItem` used to refuse with,
 *   which are the type's data now; the provider sees them because a
 *   `description` is *for* whoever has to produce the value.
 * - `outcome` is required at the root. It was optional for one reason:
 *   zod cannot type the input side of a root `preprocess`, so its emitter
 *   left the property out, and intake was the only schema with one. The
 *   preprocess is gone with the union, so intake now says what every
 *   other action already said.
 *
 * `refine` on a container moved for the same reason and in the same
 * story: a decomposition answers with `children` of a stated type, each
 * carrying that type's own fields, so its document is composed from the
 * project's work types rather than written as a `stories` array of one
 * shape. A leaf's `refine` — the clarify shape — is untouched, which is
 * what the two leaf rows below still pin.
 */

/**
 * `implement` and `review` — each of review's three verdicts — gained
 * `memoryUsed` in EO-597, on purpose: an optional list of the memory
 * entries the run relied on, which EO holds to what the run was given.
 * Optional, so an answer that leaves it out is the answer it always was.
 */
describe("the JSON Schema each provider receives", () => {
  it.each(PROVIDER_SCHEMAS)("is unchanged for %s (%s)", (action, itemType) => {
    const schema = outputSchemaFor(registry, action, itemType === undefined ? undefined : typeNamed(itemType));
    expect(schema).toBeDefined();
    // Serialised rather than compared as an object: key order is part of
    // what the provider sees on the wire, and `toEqual` would not notice
    // it moving.
    expect(JSON.stringify(schema, null, 2)).toMatchSnapshot();
  });

  it("hands nothing to a provider for an action no schema is registered under", () => {
    expect(outputSchemaFor(registry, "a_pipeline_defined_its_own")).toBeUndefined();
  });
});
