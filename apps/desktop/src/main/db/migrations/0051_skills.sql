-- The catalogue of skills a person wrote (EO-105).
--
-- EO has no concept of a skill at all: somebody who wants their product
-- owner to follow a house playbook has nowhere to put it. This is where
-- that goes, and it is the catalogue only -- attaching a skill to an
-- agent is EO-106 and writing it into a plugin directory a provider
-- reads is EO-107.
--
-- A skill has two names, and only one of them is an identifier. `slug`
-- is the directory this is written to and the `name` in its generated
-- frontmatter, which is the only thing a model can invoke; `name` is
-- what a person calls it. Multica shipped those the other way round and
-- tracked it as MUL-5529 -- a skill called "PR review" was listed to the
-- model verbatim, and the name resolved to nothing it could call.
--
-- `body` is the markdown below the frontmatter. The frontmatter itself
-- is not stored: it is generated from these columns at delivery, by
-- `skillFrontmatter` in packages/core, so a display name with a quote or
-- a newline in it is escaped by the one thing that writes it rather than
-- by whoever remembered to.
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	-- The identifier. Lowercase alphanumerics in hyphen-separated words,
	-- because it is a directory name on three filesystems and a name the
	-- model has to type back exactly. Held to that shape by
	-- `readSkillDraft` in packages/core, and unique here.
	`slug` text NOT NULL,
	-- The display name. Carried to disk under `metadata`, never offered
	-- to the model as something to call.
	`name` text NOT NULL,
	-- NOT NULL on purpose, for the reason `modules.description` gives and
	-- one more: this is what the model reads to decide whether the skill
	-- is the one, so an empty one is a skill that is listed and never
	-- chosen -- which reads exactly like a skill that is broken.
	`description` text NOT NULL,
	-- The markdown below the frontmatter.
	`body` text NOT NULL,
	-- `Array<{ path, content }>` -- the files that sit beside SKILL.md in
	-- the skill's own directory. A JSON column rather than a second
	-- table, the way `modules.manifest` and `mcp_servers.headers` are:
	-- they are only ever read and written as a whole set, because that is
	-- how a directory is materialised.
	`files` text DEFAULT '[]' NOT NULL,
	-- Present on disk, absent from what the model is choosing between.
	-- For a skill somebody invokes deliberately, or one that is half
	-- written. Distinct from `enabled`, which is whether it is delivered
	-- at all.
	`disable_model_invocation` integer DEFAULT false NOT NULL,
	-- Whether the skill is offered at all. Distinct from archived:
	-- disabled is a switch somebody flips while working out whether a
	-- skill is helping, archived is being done with it.
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	-- Archived rather than deleted, for the reason `modules.archived_at`
	-- gives: something that used it still points at it, and asking for a
	-- skill to be gone is not asking for what it did to be rewritten
	-- (invariant #3).
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_slug_unique` ON `skills` (`slug`);
