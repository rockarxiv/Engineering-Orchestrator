-- Every webhook delivery, and what it did (EO-332,
-- ARCHITECTURE.md, "What a job records",
-- "Webhooks").
--
-- A webhook always arrives at the server, since only the server has a
-- public address. It verifies the signature, records the event with its
-- key, refuses a replay, applies the job's cap and creates the item; the
-- job's machine picks that item up when it is online. The server is the
-- mailbox, not the runtime -- so this table is a mailbox's log, and it
-- lives beside job_occurrences for the same reason that one does: what
-- happened at a moment that has passed is not state, it is a record.
--
-- One row per request, without exception. The review found the first
-- draft had no answer to where a deduplicated, malformed or over-cap
-- event is recorded, and "nowhere" is precisely the case a person goes
-- looking for -- an event they know the other end sent, and no item to
-- show for it.
--
-- Append-only, held to it by db/architecturalInvariants.test.ts. A held
-- event that the tick later releases writes a *second* row saying so,
-- rather than having its first one promoted in place.
--
-- `payload` is the raw body, because the signature is over those exact
-- bytes and a payload EO had reformatted could not be checked again. It
-- is empty on a row whose signature or timestamp was refused: an
-- unverified body is not this job's event, and storing it would let a
-- stranger holding no secret write into the record as fast as the
-- throttle admits them.
CREATE TABLE `job_events` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`received_at` integer NOT NULL,
	`event_key` text NOT NULL,
	`payload` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`item_id` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_job_events_job` ON `job_events` (`job_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_job_events_outcome` ON `job_events` (`job_id`,`outcome`,`received_at`);--> statement-breakpoint
-- The original design's own sentence, as an index: "an event key that is unique per job
-- so the same event never creates two items".
--
-- Partial, and that `where` is load-bearing. A unique index over every
-- row would contradict "one row per request" within a single delivery:
-- the second arrival of an event carries the same key by construction,
-- and the `deduplicated` row recording it could not be written at all.
-- What the design asks to be unique is not the receipt, it is the
-- *creation* -- so that is what is constrained, and the constraint is
-- SQLite's rather than a read-then-write that two deliveries can
-- interleave inside.
CREATE UNIQUE INDEX `idx_job_events_created` ON `job_events` (`job_id`,`event_key`) WHERE `outcome` = 'created';
