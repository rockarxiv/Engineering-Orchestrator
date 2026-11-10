-- What EO reports about a write is kept on the version it filed (EO-728),
-- rather than posted on a project thread.
--
-- `skill_versions.report`: for a version a memory consolidation wrote,
-- the evidence it drew on (the entries and their items) and, for an
-- improvement, the diff; for an archive EO made, how many runs the skill
-- was given without a load. JSON, `SkillVersionReport`; null for every
-- other write. Written once with the row, like the rest of it.
--
-- `pipeline_versions.release_notes`: the release notes of the template
-- update that filed the version; null for every other version.
ALTER TABLE `skill_versions` ADD `report` text;
--> statement-breakpoint
ALTER TABLE `pipeline_versions` ADD `release_notes` text;
