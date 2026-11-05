-- The organisation's list: people with credentials, groups, and the
-- devices they signed in from (EO-323, ARCHITECTURE.md, "Identity").
--
-- Migration 0077 put people in the schema with four columns and said
-- what would arrive here in so many words: "7b brings the server's
-- people list, groups, and the second row." This is that.
--
-- Everything below is on the same schema the desktop carries, because
-- there is one schema and two places it is opened (EO-319: the server
-- is the desktop's own main process without a renderer). A solo
-- installation grows four columns nothing writes and two tables it may
-- use for its own groups; a server fills all of them. That is cheaper
-- and far more honest than a second migration set that would have to be
-- kept in step with this one by hand.

-- `is_admin` — "one admin flag. Everyone with it may edit on the
-- server. Per-project owner roles arrive with the first customer who
-- asks, not before" (the original design). Default 0: the local person that 0077
-- created is nobody's administrator, because in solo mode there is no
-- server to administer.
ALTER TABLE `people` ADD COLUMN `is_admin` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- When the admin invited them, and when they accepted. Both null on a
-- row that was never an invitation — the implicit local person, and
-- anybody a future import creates.
ALTER TABLE `people` ADD COLUMN `invited_at` integer;--> statement-breakpoint
ALTER TABLE `people` ADD COLUMN `accepted_at` integer;--> statement-breakpoint
-- "Accepting sets a password or ... else a password. Record the choice."
-- This is the record of it, and it records what was actually stored:
-- `password`, null until they have accepted. A passkey is not a value
-- this column may hold yet, because nothing registers or verifies one —
-- a row saying `passkey` beside a password hash would answer the single
-- question this column exists for incorrectly. Both a passkey and single
-- sign-on ("changes only the front door") become values here when the
-- front door that can honour them exists; see `CredentialKindSchema`.
ALTER TABLE `people` ADD COLUMN `credential_kind` text;--> statement-breakpoint
-- The password, as scrypt over a per-row salt (`identity/passwords.ts`).
-- Never the password itself, and never reversible: a stolen database is
-- a list of who, not a way in as any of them.
ALTER TABLE `people` ADD COLUMN `password_hash` text;--> statement-breakpoint
-- The invitation, hashed exactly as the password is and for the same
-- reason: a code that is in the email is a code that is in somebody's
-- mailbox, and the copy the server keeps must not be usable by whoever
-- reads the file. Cleared on acceptance, which is what makes it
-- one-time.
ALTER TABLE `people` ADD COLUMN `invite_code_hash` text;--> statement-breakpoint
-- An invitation nobody accepted stops being one. A link that works for
-- ever is a credential sitting in an inbox for ever.
ALTER TABLE `people` ADD COLUMN `invite_expires_at` integer;--> statement-breakpoint
-- Email UNIQUE, which is the story's own first word about the schema.
-- Sign-in is by email, so two rows carrying one address is a question
-- with two answers — and the one the server would pick is whichever
-- SQLite happened to return.
--
-- Nulls stay legal and stay many: SQLite treats NULLs in a unique index
-- as distinct, so the local person that 0077 wrote with no email does
-- not collide with itself on an installation that later imports more
-- people who have none either.
--
-- Lower-cased, because `Anna@example.com` and `anna@example.com` are one
-- mailbox everywhere that matters and two rows here otherwise. The
-- writers lower-case on the way in (`peopleRepo.ts`); this is what makes
-- that a rule rather than a habit.
CREATE UNIQUE INDEX `idx_people_email` ON `people` (lower(`email`));--> statement-breakpoint

-- A group, so a human step can say "Support team · anyone claims"
-- (ARCHITECTURE.md, "Identity"). Two columns: a group is *who work is offered to*, not what
-- anybody is allowed to do. Nothing about permission lives here, and
-- per-project roles are named out of scope by this story.
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
-- One group per name, for the reason email is unique: "Support team" is
-- what a person types into a picker and what a column head shows, and
-- two of them is a choice nobody can make correctly.
CREATE UNIQUE INDEX `idx_groups_name` ON `groups` (lower(`name`));--> statement-breakpoint

-- Who is in it. A composite key rather than an id, because the row *is*
-- the pair and a second row saying the same thing is not a second fact.
--
-- Both sides cascade: a deleted group has no membership, and a person
-- deleted from the list is not still in a team. Neither delete exists
-- in this story — nothing removes a person yet (0077 said why) — and
-- the cascades are here so that when one does, it does not leave rows
-- pointing at nothing.
CREATE TABLE `group_members` (
	`group_id` text NOT NULL,
	`person_id` text NOT NULL,
	PRIMARY KEY(`group_id`, `person_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint

-- A machine somebody signed in from, and the token it presents (the original design:
-- "each device holds its own token, revocable by the admin").
--
-- `token_hash` and never the token: the server issues it once, at
-- sign-in, and keeps a SHA-256 of it. A database somebody copies is
-- then a list of which machines may talk rather than a set of keys to
-- talk with.
--
-- `revoked_at` rather than a delete, because the admin's list is a
-- record of what has held a key and revocation is an event with a time.
-- A revoked row still answers "which machine was that, and when did we
-- stop trusting it" — a deleted one answers nothing, which is the wrong
-- half of the question to be able to ask after an incident.
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
-- Every authenticated request is a lookup by this, so it is the one
-- index that is on the hot path rather than on a screen. Unique because
-- two devices sharing a token is either a collision in 256 bits of
-- randomness or a bug, and both should fail loudly at the insert.
CREATE UNIQUE INDEX `idx_devices_token_hash` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_devices_person` ON `devices` (`person_id`);
