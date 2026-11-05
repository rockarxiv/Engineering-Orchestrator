-- What the record has told this device about and it cannot place yet
-- (EO-324, ARCHITECTURE.md, "The record").
--
-- The pull reads six lists, each paged on a cursor of its own, and a
-- page of one is not a page of the others. A device joining an
-- organisation can be handed a run's transcript on the same pass whose
-- run row falls on the *next* runs page, or a comment whose item is on
-- the next items page. Dropping those and advancing the cursor anyway
-- loses them for ever: a cursor only moves forwards, and a comment is
-- immutable and never paged twice.
--
-- So what cannot be placed is kept here and tried again next pass. The
-- cursors go on moving, because head-of-line blocking is the other
-- failure — one item this installation cannot resolve would otherwise
-- freeze the whole board — and this table is what makes that safe.
--
-- It is also where a file this device has been told about and not yet
-- downloaded is remembered. That was an in-memory map until the same
-- reasoning caught up with it: the metadata arrives, its cursor
-- advances, the bytes fail or the app closes, and on restart nothing
-- knows the file was ever mentioned. The record will not say again.
--
-- `id` is a natural key per kind — `transition:<id>`, `attachment:<id>`,
-- `runEvents:<runId>:<seq>` — so a row arriving twice, which a cursor
-- boundary guarantees, is one row here rather than two.
--
-- Not invariant #3's subject. Nothing here is a record of what
-- happened; it is a note about what this device has heard and not yet
-- written down, deleted the moment it has.
CREATE TABLE `record_pending` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`waiting_for` text NOT NULL,
	`created_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_record_pending_kind` ON `record_pending` (`kind`,`id`);
