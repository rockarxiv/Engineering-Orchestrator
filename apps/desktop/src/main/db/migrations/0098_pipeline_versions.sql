-- Immutable pipeline versions, and what an item mid-flight routes by
-- (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
--
-- Until now `pipelines` had no version at all: a save rewrote the steps
-- and the routes under whatever was standing on them, and an item
-- halfway down the pipeline finished by rules nobody had agreed to when
-- it started. A version is the graph frozen as a document; an item binds
-- to the one it entered on and finishes there.
--
-- The live `pipeline_steps` and `step_routes` rows stay exactly what they
-- were — *the current version* — so every existing reader of them is
-- still right. Only an older version is read out of the snapshot.
CREATE TABLE `pipeline_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`pipeline_id` text NOT NULL,
	`number` integer NOT NULL,
	`steps` text NOT NULL,
	`routes` text NOT NULL,
	`entry_step_id` text,
	`created_at` integer NOT NULL,
	`created_by` text,
	FOREIGN KEY (`pipeline_id`) REFERENCES `pipelines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pipeline_versions_number` ON `pipeline_versions` (`pipeline_id`,`number`);--> statement-breakpoint
-- Which version each pipeline is on now. No foreign key: the two tables
-- point at each other, and a circular constraint makes the order the
-- rebuild that adds either of them has to run in unresolvable.
ALTER TABLE `pipelines` ADD `current_version_id` text;--> statement-breakpoint
-- The version an item entered on, and finishes on.
ALTER TABLE `items` ADD `pipeline_version_id` text;--> statement-breakpoint
-- The last version a removed step was part of. A step with items on it
-- still cannot be removed (EO-230); a step removed while empty is
-- retired rather than dropped, because an item finishing on an older
-- version can still be routed onto it, and `items.step_id` references
-- this row.
ALTER TABLE `pipeline_steps` ADD `retired_version` integer;
--
-- No backfill here, deliberately. A v1 for a pipeline that predates
-- versions has to hold the whole graph as a document — every step with
-- its prompt, its inputs and its declared results — and building that
-- in SQL means hand-assembling JSON whose shape is defined by a Zod
-- schema three packages away. `ensureCurrentVersion` builds it instead,
-- from the same reader everything else uses, the first time anybody asks
-- this pipeline what version it is on: a save, or an item binding to it.
-- Items already mid-flight are bound to that v1 in the same statement,
-- because the graph they are standing in *is* v1.
