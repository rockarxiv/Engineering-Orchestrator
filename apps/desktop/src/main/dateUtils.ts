/** Start of `ms`'s local calendar day, as epoch millis. */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `ms`'s local calendar day as "YYYY-MM-DD". */
export function formatDateKey(ms: number): string {
  const d = new Date(ms);
  const year = String(d.getFullYear()).padStart(4, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The epoch millis at the start of the local calendar day named by `dateKey` ("YYYY-MM-DD"). */
export function startOfDayForKey(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year!, (month ?? 1) - 1, day ?? 1, 0, 0, 0, 0).getTime();
}
