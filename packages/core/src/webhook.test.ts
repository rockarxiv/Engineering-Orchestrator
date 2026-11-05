import { describe, expect, it } from "vitest";
import {
  EMPTY_WEBHOOK_MAPPING,
  WEBHOOK_PATH_PREFIX,
  WebhookMappingSchema,
  describeJobEventOutcome,
  isJsonPointer,
  resolveJsonPointer,
  webhookFieldText,
  sampleWebhookPayload,
  webhookPath,
  webhookSigningString,
  withJsonPointer,
  WEBHOOK_TEST_MARKER,
} from "./webhook.js";

describe("where a webhook is delivered", () => {
  it("hangs the job's own segment off one prefix", () => {
    expect(webhookPath("deploys")).toBe(`${WEBHOOK_PATH_PREFIX}deploys`);
  });
});

describe("what a webhook signs", () => {
  it("covers the timestamp and the body exactly as sent", () => {
    // The timestamp is *inside* the signature rather than beside it: a
    // header nothing is signed over is a header an attacker rewrites,
    // and the window would then protect nothing.
    expect(webhookSigningString(1_700_000_000_000, '{"a":1}')).toBe('1700000000000.{"a":1}');
  });
});

describe("following a pointer into a payload", () => {
  const payload = {
    id: "evt-1",
    issue: { fields: { summary: "Disk full", priority: 2, resolved: false, labels: ["ops", "urgent"] } },
    "a/b": "slashed",
    "c~d": "tilded",
    nothing: null,
  };

  it("reads a nested field, an array element and the whole document", () => {
    expect(resolveJsonPointer(payload, "/issue/fields/summary")).toBe("Disk full");
    expect(resolveJsonPointer(payload, "/issue/fields/labels/1")).toBe("urgent");
    expect(resolveJsonPointer(payload, "")).toEqual(payload);
  });

  it("unescapes ~1 as a slash and ~0 as a tilde, in that order", () => {
    expect(resolveJsonPointer(payload, "/a~1b")).toBe("slashed");
    expect(resolveJsonPointer(payload, "/c~0d")).toBe("tilded");
  });

  it("answers nothing for a pointer that does not resolve", () => {
    expect(resolveJsonPointer(payload, "/issue/fields/assignee")).toBeUndefined();
    expect(resolveJsonPointer(payload, "/issue/fields/labels/7")).toBeUndefined();
    // Not a pointer at all: RFC 6901 says `""` or a leading slash.
    expect(resolveJsonPointer(payload, "issue")).toBeUndefined();
    expect(isJsonPointer("issue")).toBe(false);
    // The reserved "one past the end" token has nothing to read.
    expect(resolveJsonPointer(payload, "/issue/fields/labels/-")).toBeUndefined();
    // A leading zero is not an index the standard admits.
    expect(resolveJsonPointer(payload, "/issue/fields/labels/00")).toBeUndefined();
  });

  it("tells an explicit null from a field that is not there", () => {
    // Both become "nothing to put here" for a title, and they are not
    // the same fact and are not resolved as one.
    expect(resolveJsonPointer(payload, "/nothing")).toBeNull();
    expect(resolveJsonPointer(payload, "/missing")).toBeUndefined();
  });

  it("does not walk into an object's prototype", () => {
    expect(resolveJsonPointer(payload, "/constructor/name")).toBeUndefined();
    expect(resolveJsonPointer(payload, "/__proto__")).toBeUndefined();
  });
});

describe("what a resolved pointer puts in a field", () => {
  it("spells a number or a boolean, and JSON-encodes anything structured", () => {
    expect(webhookFieldText("Disk full")).toBe("Disk full");
    expect(webhookFieldText(2)).toBe("2");
    expect(webhookFieldText(false)).toBe("false");
    expect(webhookFieldText(["ops"])).toBe('["ops"]');
  });

  it("answers null for nothing at all, so the template's own text stands", () => {
    expect(webhookFieldText(undefined)).toBeNull();
    expect(webhookFieldText(null)).toBeNull();
  });
});

describe("a mapping", () => {
  it("names nothing by default", () => {
    expect(WebhookMappingSchema.parse({})).toEqual(EMPTY_WEBHOOK_MAPPING);
  });

  it("carries a pointer per field and per spec field", () => {
    expect(WebhookMappingSchema.parse({ title: "/summary", spec: { severity: "/level" } })).toEqual({
      title: "/summary",
      body: null,
      eventKey: null,
      spec: { severity: "/level" },
    });
  });
});

describe("the words an outcome is read under", () => {
  it("has one for every outcome the endpoint can record", () => {
    expect(describeJobEventOutcome("created")).toBe("Created");
    expect(describeJobEventOutcome("held")).toBe("Waiting");
    expect(describeJobEventOutcome("rejected_signature")).toBe("Bad signature");
    expect(describeJobEventOutcome("rejected_replay")).toBe("Outside the time window");
  });
});

/**
 * The sample a Send test event press posts (EO-333, ARCHITECTURE.md, "The inbox, the archive and
 * jobs").
 *
 * Shaped by the job's own mapping, because the question the button is
 * actually asked is "have I written these pointers correctly?" — and
 * because a job that declares an event key is refused as `malformed`
 * when the payload has nothing there, so a fixed sample would fail on
 * exactly the jobs that configured the most.
 */
describe("writing a value at a pointer", () => {
  it("round-trips with the reader, one level down and several", () => {
    const shallow = withJsonPointer({}, "/summary", "Printer on fire");
    const deep = withJsonPointer({}, "/issue/fields/summary", "Printer on fire");

    expect(resolveJsonPointer(shallow, "/summary")).toBe("Printer on fire");
    expect(resolveJsonPointer(deep, "/issue/fields/summary")).toBe("Printer on fire");
  });

  it("keeps what was already there beside what it writes", () => {
    const payload = withJsonPointer({ id: "e-1", issue: { key: "HD-9" } }, "/issue/summary", "Printer on fire");

    expect(payload).toEqual({ id: "e-1", issue: { key: "HD-9", summary: "Printer on fire" } });
  });

  it("leaves the caller's document alone", () => {
    const original = { issue: { key: "HD-9" } };
    withJsonPointer(original, "/issue/summary", "Printer on fire");

    expect(original).toEqual({ issue: { key: "HD-9" } });
  });

  it("writes nothing where there is nowhere to write — the whole document is not a field", () => {
    expect(withJsonPointer({ id: "e-1" }, "", "x")).toEqual({ id: "e-1" });
    expect(withJsonPointer({ id: "e-1" }, "summary", "x")).toEqual({ id: "e-1" });
  });

  it("unescapes a token the way the reader does", () => {
    const payload = withJsonPointer({}, "/a~1b", "x");

    expect(resolveJsonPointer(payload, "/a~1b")).toBe("x");
  });
});

describe("the sample a test event posts", () => {
  const mapping = {
    title: "/issue/fields/summary",
    body: "/issue/fields/description",
    eventKey: "/delivery_id",
    spec: { severity: "/issue/fields/priority" },
  };

  it("puts something at every pointer the mapping names", () => {
    const payload = sampleWebhookPayload(mapping, "nonce-1");

    expect(webhookFieldText(resolveJsonPointer(payload, "/issue/fields/summary"))).toBe("Test event from EO");
    expect(webhookFieldText(resolveJsonPointer(payload, "/issue/fields/description"))).toContain("nonce-1");
    expect(resolveJsonPointer(payload, "/issue/fields/priority")).toBe("Test value for severity");
    expect(resolveJsonPointer(payload, "/delivery_id")).toBe("nonce-1");
  });

  it("says it is a test, in a field no sender uses", () => {
    expect(sampleWebhookPayload(EMPTY_WEBHOOK_MAPPING, "nonce-1")[WEBHOOK_TEST_MARKER]).toBe(true);
  });

  it("is a different event each press, so a second one is not deduplicated", () => {
    const first = JSON.stringify(sampleWebhookPayload(mapping, "nonce-1"));
    const second = JSON.stringify(sampleWebhookPayload(mapping, "nonce-2"));

    expect(first).not.toBe(second);
  });

  it("keeps the key even where a spec pointer names the same place", () => {
    const payload = sampleWebhookPayload({ title: null, body: null, eventKey: "/id", spec: { ref: "/id" } }, "nonce-1");

    expect(resolveJsonPointer(payload, "/id")).toBe("nonce-1");
  });
});
