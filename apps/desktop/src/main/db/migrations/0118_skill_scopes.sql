-- Skills scoped to a project or a workspace (EO-470, ARCHITECTURE.md
-- §13.3).
--
-- `scope` is `global`, `project` or `workspace`; `scope_id` is the
-- project's or the workspace's id, NULL for a global skill. Every skill
-- that exists is global after this runs — the column's default — which
-- is what every skill was before there was a choice, so no run is handed
-- a different set of skills because of this migration.
--
-- `scope_id` is not a foreign key: which table it points into is decided
-- by `scope`, and a skill whose project or workspace is deleted is not
-- deleted with it. It reaches no run, and stays listed, the way an
-- archived row does.
ALTER TABLE `skills` ADD `scope` text DEFAULT 'global' NOT NULL;
--> statement-breakpoint
ALTER TABLE `skills` ADD `scope_id` text;
