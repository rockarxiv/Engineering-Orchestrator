/**
 * The state colours a status is drawn in, by name.
 *
 * `warning` is not a run state and does not belong to the run scale — it
 * is for a thing that is present and will not work, such as a runtime
 * nobody has signed into. `paused` deliberately stays what it is: an
 * item waiting on a person is not a problem (see styles.css).
 */
export type StatusTone = "running" | "reviewing" | "paused" | "success" | "danger" | "warning" | "idle";
