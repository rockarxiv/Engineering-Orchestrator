-- The record's sync: what a device did and has not had confirmed, and
-- which machine wrote a line of the durability substrate (EO-324,
-- ARCHITECTURE.md, "The record").
--
-- `record_commands` is the queue behind "offline since 09:12". A device
-- applies a move to its own replica at once and writes the command
-- here; the drain replays it to the record in the order it was made,
-- and the row goes when the record has answered. A row here is exactly
-- what is provisional, which is what the dashed card reads from.
--
-- `id` is a UUIDv7 so the primary key *is* the replay order. Replaying
-- out of order would be replaying a different history — a correction
-- written before a move has to arrive before it.
--
-- `on delete cascade` for the reason `dispatch_leases` has it: a
-- command about an item somebody deleted is not a command any more.
-- This is not invariant #3's subject; what happened is the transition,
-- the comment and the run, and none of those are this row.
CREATE TABLE `record_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`item_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_record_commands_item` ON `record_commands` (`item_id`);
--> statement-breakpoint
-- The device as author (the original design: "run_events sync append-only by run
-- and sequence with the device as author"). Nullable, and null means
-- "not recorded" rather than "this machine" — every row written before
-- managed mode existed is one, and `local` is written out for the
-- desktop that is also the record so the two cannot be confused.
--
-- A column added to an append-only table, which is a schema change and
-- not a rewrite: no existing row is touched, and invariant #3 forbids
-- UPDATE and DELETE, not ALTER.
ALTER TABLE `run_events` ADD COLUMN `device_id` text;
--> statement-breakpoint
-- How far a run's log and its outcome have reached the record (ARCHITECTURE.md, "The record").
--
-- The device's own bookmark, not part of the record: `run_events` is
-- append-only and may not be updated (invariant #3), so where a device
-- got to in handing it over cannot live there. `-1` and NULL are what
-- every run on a solo desktop keeps forever — there is nobody to send
-- it to — and what lets a desktop that went offline mid-run come back
-- and deliver the whole transcript, in order, plus the outcome.
ALTER TABLE `runs` ADD COLUMN `synced_seq` integer DEFAULT -1 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `synced_status` text;
--> statement-breakpoint
-- Which machine a move was applied from (ARCHITECTURE.md, "The record").
--
-- `actor` says what kind of thing moved it; with two desktops on one
-- record that stops being enough, because "your move of SUP-31 was
-- superseded by Dana's" needs a name and `human` is not one. The record
-- knows which device sent the command and a device belongs to a person.
--
-- Null on every move made before managed mode and on every move made on
-- a solo desktop. `transitions` is append-only (invariant #3): this adds
-- a column and rewrites no row.
ALTER TABLE `transitions` ADD COLUMN `device_id` text;
