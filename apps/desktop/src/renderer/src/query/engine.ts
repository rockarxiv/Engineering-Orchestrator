/**
 * The engine's status (paused, runs still finishing), as the pause
 * control in either layout reads it — the classic top bar's and the chat
 * rail's — so pausing in one is what the other shows.
 */
export const engineStatusKey = ["engine"] as const;
