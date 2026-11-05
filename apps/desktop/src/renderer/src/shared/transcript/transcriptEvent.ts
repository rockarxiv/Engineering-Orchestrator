/** Narrow an unknown payload without pretending we know more than we do. */
export function field(payload: unknown, key: string): unknown {
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)[key] : undefined;
}

export function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value, null, 2);
}
