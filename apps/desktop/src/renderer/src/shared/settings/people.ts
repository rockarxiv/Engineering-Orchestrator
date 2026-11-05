/** When a device last presented its token, in words rather than a timestamp. */
export function lastSeen(at: number | null, now: number = Date.now()): string {
  if (at === null) return "not seen since it signed in";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "last seen just now";
  if (minutes < 60) return `last seen ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `last seen ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `last seen ${days} day${days === 1 ? "" : "s"} ago`;
}
