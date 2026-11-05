import { describe, expect, it } from "vitest";
import { blankRow, fieldsFromRows, fieldsFromText, fieldsToText, kindOf, rowProblems, rowsFromFields, withKind } from "./actionFields";

/**
 * The list is a view of the schema, so what is held here is that it
 * reads the four shapes, writes them as the core writes a proposed
 * field, and leaves everything else in the document as it found it.
 */

describe("which fields the list can express", () => {
  it("reads the four types, with or without a description", () => {
    expect(kindOf({ type: "string" })).toBe("text");
    expect(kindOf({ type: "number" })).toBe("number");
    expect(kindOf({ type: "boolean" })).toBe("boolean");
    expect(kindOf({ type: "array", items: { type: "string" } })).toBe("text_list");
    expect(kindOf({ type: "string", description: "What was found." })).toBe("text");
  });

  it("calls anything that narrows or nests JSON-only", () => {
    expect(kindOf({ type: "string", enum: ["low", "high"] })).toBeNull();
    expect(kindOf({ type: "integer" })).toBeNull();
    expect(kindOf({ type: "array", items: { type: "number" } })).toBeNull();
    expect(kindOf({ type: "object", properties: { a: { type: "string" } } })).toBeNull();
    expect(kindOf({ $ref: "#/$defs/gap" })).toBeNull();
    expect(kindOf(true)).toBeNull();
  });

  it("keeps a field's description when its type is changed", () => {
    const row = withKind({ name: "gaps", required: true, schema: { type: "string", description: "The gaps." } }, "text_list");
    expect(row).toEqual({ name: "gaps", required: true, schema: { type: "array", items: { type: "string" }, description: "The gaps." } });
  });
});

describe("reading and writing the schema", () => {
  const RICH = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      severity: { type: "string", enum: ["low", "high"] },
      notes: { type: "string" },
      gaps: { type: "array", items: { $ref: "#/$defs/gap" }, minItems: 1 },
    },
    required: ["severity", "phantom"],
    additionalProperties: false,
    $defs: { gap: { type: "object", properties: { where: { type: "string" } } } },
  };

  it("writes back, untouched, a document nobody edited — key for key and in order", () => {
    const rows = rowsFromFields(RICH);
    expect(rows?.map((row) => [row.name, row.required])).toEqual([
      ["severity", true],
      ["notes", false],
      ["gaps", false],
    ]);
    expect(JSON.stringify(fieldsFromRows(RICH, rows!))).toBe(JSON.stringify(RICH));
  });

  it("changes only what a row changed, and leaves what the list cannot express as written", () => {
    const rows = rowsFromFields(RICH)!;
    const next = fieldsFromRows(RICH, [rows[0]!, { ...rows[1]!, required: true }, rows[2]!, { name: "count", required: false, schema: { type: "number" } }]);

    expect(next["properties"]).toEqual({ ...RICH.properties, count: { type: "number" } });
    // A name already required keeps its place, one only the JSON said stays, the new one goes last.
    expect(next["required"]).toEqual(["severity", "phantom", "notes"]);
    expect(next["$defs"]).toEqual(RICH.$defs);
    expect(next["additionalProperties"]).toBe(false);
    expect(Object.keys(next)).toEqual(Object.keys(RICH));
  });

  it("carries a property named __proto__ through as an own property, not as the map's prototype", () => {
    // JSON may carry the name and a schema may use it; assigning it to an object would set a prototype and lose the field.
    const base = JSON.parse('{"properties":{"__proto__":{"type":"string","enum":["low","high"]},"notes":{"type":"string"}}}') as Record<string, unknown>;
    const rows = rowsFromFields(base)!;
    expect(rows.map((row) => row.name)).toEqual(["__proto__", "notes"]);

    const next = fieldsFromRows(base, [rows[0]!, { ...rows[1]!, required: true }]);
    expect(JSON.stringify(next)).toBe('{"properties":{"__proto__":{"type":"string","enum":["low","high"]},"notes":{"type":"string"}},"required":["notes"]}');
    expect(Object.getPrototypeOf(next["properties"])).toBe(Object.prototype);
  });

  it("leaves an empty schema empty, and writes a first field the way the core does", () => {
    expect(fieldsFromRows({}, [])).toEqual({});
    expect(fieldsFromRows({}, [{ ...blankRow(), name: "notes", required: true }])).toEqual({ type: "object", properties: { notes: { type: "string" } }, required: ["notes"] });
  });

  it("drops a field's name from required when the field is removed or renamed", () => {
    const base = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    expect(fieldsFromRows(base, [])).toEqual({ type: "object", properties: {}, required: [] });
    expect(fieldsFromRows(base, [{ name: "b", required: true, schema: { type: "string" } }])).toEqual({ type: "object", properties: { b: { type: "string" } }, required: ["b"] });
  });

  it("does not read, and so does not rewrite, a schema whose properties or required are malformed", () => {
    const broken = { properties: ["a"], required: "a" };
    expect(rowsFromFields(broken)).toBeNull();
    expect(fieldsFromRows(broken, [blankRow()])).toBe(broken);
  });

  it("names an empty or repeated field name before the save is asked", () => {
    expect(rowProblems([blankRow()])).toEqual([expect.stringContaining("needs a name")]);
    expect(rowProblems([{ ...blankRow(), name: "a" }, { ...blankRow(), name: "a" }])).toEqual([expect.stringContaining('"a" is listed more than once')]);
    expect(rowProblems([{ ...blankRow(), name: "a" }])).toEqual([]);
  });
});

describe("the JSON view's text", () => {
  it("round-trips a schema", () => {
    const fields = { type: "object", properties: { notes: { type: "string" } } };
    expect(fieldsFromText(fieldsToText(fields))).toEqual({ ok: true, fields });
  });

  it("answers text that is not JSON with the parser's own message", () => {
    const read = fieldsFromText('{ "type": ');
    let parsers = "";
    try {
      JSON.parse('{ "type": ');
    } catch (error) {
      parsers = (error as Error).message;
    }
    expect(read).toEqual({ ok: false, problem: parsers });
  });

  it("refuses JSON that is not an object, and reads nothing as no fields", () => {
    expect(fieldsFromText("[1]").ok).toBe(false);
    expect(fieldsFromText("  ")).toEqual({ ok: true, fields: {} });
  });
});
