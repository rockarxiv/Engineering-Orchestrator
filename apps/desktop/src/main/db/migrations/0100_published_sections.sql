-- What an organisation published, and what that locks (EO-329,
-- ARCHITECTURE.md, "Publish, lock and versions").
--
-- An admin edits pipelines, agents, packs, connectors and policy on the
-- server and publishes a version of one of them to every signed-in
-- desktop. A row here is that act: the section, what version it points
-- at, when, and who. Devices receive these rows through the ordinary
-- sync and store them read-only — a replica never authors one, because
-- a desktop that could write its own would be a desktop locking itself.
--
-- One table on both ends rather than two, for the reason the record's
-- other tables are one table: a replica holds a copy of what the record
-- holds. Which of the two a row *binds* on is not written down here and
-- must not be — it is a fact about the installation (`isReplica`), and
-- a column claiming it would be a copy of that fact able to disagree
-- with it.
CREATE TABLE `published_sections` (
	`section` text NOT NULL,
	-- The pipeline a version belongs to, and `''` for the four sections
	-- that have no versions of their own.
	--
	-- Not a second axis of the lock. The lock is per section and never
	-- per field (ARCHITECTURE.md, "Publish, lock and versions"), and nothing reads this to decide
	-- whether an
	-- editor is open: it exists so that "roll back to v6" can name
	-- *which* pipeline, since publishing the pipelines section covers
	-- every pipeline the record holds.
	--
	-- No foreign key, deliberately. A pipeline deleted on the record
	-- would take the statement that its section was published with it,
	-- and the section is published whether or not any one pipeline
	-- survives — the row that outlives its subject is swept when the
	-- section is published again, which is the same pass that would have
	-- rewritten it anyway.
	`subject_id` text DEFAULT '' NOT NULL,
	-- A `pipeline_versions.id`. Null for a section with no versions.
	`version_id` text,
	-- What a person reads — the `6` of "v6" — carried beside the id
	-- because a device holds the row long before it holds that
	-- pipeline's version history, and "published v6" with nothing to
	-- resolve it against is a row that cannot draw itself.
	`version_number` integer,
	`published_at` integer NOT NULL,
	-- The person, and what to call them. Both, for `version_number`'s
	-- reason: a device may hold the row before it holds the person, and
	-- "published by 019a…c3" on the one screen that most needs to name
	-- somebody is worse than a name frozen at publish time.
	`published_by` text,
	`published_by_name` text,
	-- What was published, for the four sections whose contents are not a
	-- pipeline version (ARCHITECTURE.md, "Publish, lock and versions").
	--
	-- A publish is an act with a moment attached to it, and this is what
	-- the section looked like at that moment: the agents with their
	-- prompts and tool surfaces, the skills and modules a pack brings,
	-- which MCP servers exist, the guardrails. A device applies it and
	-- then may not edit it, which is what makes managed mode managed
	-- rather than merely locked.
	--
	-- A document rather than five more synced tables, for the reason
	-- `pipeline_versions.steps` is JSON: an ordered document belonging to
	-- one row, written once, read whole. Paging the tables themselves
	-- would push every half-finished edit an admin makes between
	-- publishes — the opposite of what a publish is for.
	--
	-- Never a secret. The design keeps an organisation's secrets on the server
	-- and a person's on their machine; what travels here is the shape of
	-- a server, never what authenticates it.
	`document` text,
	PRIMARY KEY (`section`, `subject_id`)
);
--> statement-breakpoint
-- The sync's page order. Devices read this list by (published_at,
-- rowid-ish key) exactly as they read every other one, and a rollback
-- re-publishes — a new `published_at` on a row that already existed —
-- so the index is what makes "tell me what changed" a keyset scan
-- rather than a table read on every tick.
CREATE INDEX `idx_published_sections_at` ON `published_sections` (`published_at`);
