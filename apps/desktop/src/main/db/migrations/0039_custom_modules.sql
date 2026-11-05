-- Custom modules: deterministic work a step runs, that EO did not ship.
--
-- `builtin` is a closed set of two, and its docstring says why: each one
-- is code EO ships, so "adding one is a feature". That is the right rule
-- for EO's own functions and the wrong answer for someone who wants
-- their deploy to be a step. Before agents existed a deploy was a script
-- running some commands; handing it to a model buys a token bill, a
-- nondeterministic transcript and a fresh way to fail in exchange for
-- nothing a script did not already do. EO already made this call for
-- itself — `create_worktree` is a builtin because "there is no judgement
-- in `git worktree add`" — and this is that same choice, made available
-- to the user rather than only to us.
--
-- A module is code rather than a stored command line, and that is the
-- load-bearing decision. A command line cannot declare what it depends
-- on: it reaches the ambient PATH, an ambient cwd and the whole
-- environment, and a `needs` written beside it is a comment nothing
-- enforces. A module is handed a `ctx` and has nothing else in scope, so
-- what it touches has to be declared and the host can refuse the rest —
-- which is what lets an import check a pipeline against the machine
-- before anything runs.
--
-- `code` lives in the row rather than on disk, so exporting a pipeline
-- is a query rather than a file walk, and an archived module keeps the
-- source a historical run's transcript refers to.
CREATE TABLE `modules` (
	`id` text PRIMARY KEY NOT NULL,
	-- Stable across machines: this is what an exported pipeline names,
	-- and what a collision on import is reported against.
	`slug` text NOT NULL,
	`name` text NOT NULL,
	-- NOT NULL deliberately. A module with no description looks usable in
	-- the catalog and cannot be found again — and the architect reads
	-- exactly this field to decide whether the module it is about to
	-- write already exists, so an empty one costs a duplicate every time.
	`description` text NOT NULL,
	`code` text NOT NULL,
	-- inputs, needs and the results this module can return. Stored parsed
	-- as well as living inside `code` because validation and import
	-- preflight both read it, and neither should have to execute a module
	-- to find out what it needs.
	`manifest` text NOT NULL,
	-- The script a module was translated from, kept as provenance rather
	-- than as a backup: nothing can establish that a translation is
	-- faithful, so keeping the original is what leaves it diffable.
	`original_script` text,
	`source` text DEFAULT 'user' NOT NULL,
	-- When a person last approved this exact code. Cleared whenever the
	-- code or the manifest changes, because approval is about a body of
	-- code and not about a name. An unapproved module cannot be published
	-- onto a step, which is what makes accepting an imported one safe.
	`approved_at` integer,
	-- When it was last dry-run: the one check available for a claim the
	-- engine cannot verify (invariant #5).
	`dry_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	-- Archived rather than deleted, for the reason `pipelines.archived_at`
	-- gives: a run that used this module still points at it, and asking
	-- for a module to be gone is not asking for what it did to be
	-- rewritten (invariant #3).
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `modules_slug_unique` ON `modules` (`slug`);
