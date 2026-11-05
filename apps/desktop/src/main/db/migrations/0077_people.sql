-- People, and the one implicit local person (EO-302,
-- ARCHITECTURE.md, "Identity").
--
-- Identity arrives with jobs rather than with the server. A job needs
-- an owner and "have Anna approve it" needs an assignee before any
-- server exists, so the concept lands here and the *list* of people
-- lands in 7b with the server that knows them.
--
-- Four columns and nothing else. No "is this me" flag: which row is the
-- local person is answered by its id, the reserved UUIDv7 below, which
-- is also what makes the first-sign-in rewrite in the original design — "mentions that
-- targeted the local person become the signing-in person's" — a
-- statement that can find what it is about.
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
-- "In solo mode one row is created on first run, 'you', and every place
-- that meant 'the human' means this row." Created here rather than by
-- the app at boot, because the mention rewrite below needs it to exist
-- in the same transaction as the rewrite — and because a migration is
-- the only thing that runs exactly once per installation.
--
-- The id is a reserved UUIDv7, minted once and frozen in `core`'s
-- `LOCAL_PERSON_ID`, the way the seeded agents in 0001 and the system
-- agent named by 0036, 0062 and 0065 carry fixed v7 literals. Not
-- minted here from `randomblob` the way 0069 mints a type's id: that
-- gives a different id on every machine, and this one is also a
-- constant the TypeScript holds — the rewrite below and `postComment`
-- have to write the same value this INSERT does.
--
-- `strftime` rather than a literal: the row is created when this
-- installation applies the migration, which for a new database is the
-- moment it is born and for an existing one is the launch that upgrades
-- it. Milliseconds, like every other `created_at` in this schema.
INSERT INTO `people` (`id`, `name`, `email`, `created_at`)
VALUES ('01a0a0af-6d78-73d8-9954-953391d30f68', 'you', NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
--> statement-breakpoint
-- Who filed it, and who it is waiting on (ARCHITECTURE.md, "Identity"). Both nullable: an item
-- written before this column has no answer for the first, and only a
-- human step ever has one for the second. Nothing reads `assignee_id`
-- yet — claiming is the seventh story of this phase — and the card's
-- assignee is still derived from the latest run's agent until it does.
--
-- Not backfilled with the local person. An item created before EO had a
-- concept of people was created by *somebody*, and asserting it was
-- this row would be inventing a fact rather than recording one; NULL is
-- the honest "EO does not know", which is what it will also mean for an
-- issue imported from a tracker where somebody else filed it.
ALTER TABLE `items` ADD COLUMN `created_by` text REFERENCES `people`(`id`);
--> statement-breakpoint
ALTER TABLE `items` ADD COLUMN `assignee_id` text REFERENCES `people`(`id`);
--> statement-breakpoint
-- "Human steps may name a person or a group" (the original design). A step that names
-- neither is what every step is today: it waits for whoever is there,
-- which in solo mode is the one person.
--
-- `owner_group_id` is reserved for 7b and is read by nothing here — no
-- `groups` table exists for it to reference yet, which is exactly why
-- it carries no foreign key and why it is written down now rather than
-- later: the column the group picker will fill is the column the
-- person picker sits beside, and adding it in the same migration keeps
-- "a person or a group" one decision in the schema instead of two.
ALTER TABLE `pipeline_steps` ADD COLUMN `owner_person_id` text REFERENCES `people`(`id`);
--> statement-breakpoint
ALTER TABLE `pipeline_steps` ADD COLUMN `owner_group_id` text;
--> statement-breakpoint
-- A mention targets a person now, not "the human" (ARCHITECTURE.md, "Identity").
--
-- `target_id` was NULL for every human mention, which made the inbox
-- and the `!` marker queries for an absence. Absence has no name, so
-- nothing could ever say *which* person was being waited on. Every one
-- of those rows becomes the local person, because in solo mode that is
-- precisely who each of them already meant.
--
-- Two updates and a delete rather than one update, because the old
-- primary key `(comment_id, target_type, target_id)` could not enforce
-- one human mention per comment: SQLite treats NULLs in a unique index
-- as distinct, so two NULL-targeted rows on one comment were possible
-- even though `postComment` dedupes and never wrote them. Filling both
-- in would trip the key and refuse the whole batch — a database that
-- will not open. So: the open one first, so that if a comment somehow
-- carries two the one still waiting for an answer is the one that
-- survives; then any remaining; then the leftovers, which by then are
-- duplicates of a row that already says the same thing.
UPDATE OR IGNORE `comment_mentions` SET `target_id` = '01a0a0af-6d78-73d8-9954-953391d30f68'
WHERE `target_type` = 'human' AND `target_id` IS NULL AND `status` = 'open';
--> statement-breakpoint
UPDATE OR IGNORE `comment_mentions` SET `target_id` = '01a0a0af-6d78-73d8-9954-953391d30f68'
WHERE `target_type` = 'human' AND `target_id` IS NULL;
--> statement-breakpoint
DELETE FROM `comment_mentions` WHERE `target_type` = 'human' AND `target_id` IS NULL;
