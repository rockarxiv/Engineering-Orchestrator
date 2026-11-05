-- The template update EO last applied to a pipeline (EO-536).
--
-- A pipeline's head says "Updated to v1.1" for a few days after EO
-- applied an update, with that version's release notes. Read from the
-- version the update filed, that would vanish with the version: a graph
-- save prunes old versions, and with the retention set to one the next
-- ordinary edit removes the update's version minutes after it landed.
-- So the update is kept beside the origin, written in the transaction
-- that applies it: the template version it took, the pipeline version
-- it was filed as, and when.
--
-- JSON, `{ "version": "1.1", "pipelineVersion": 4, "at": <ms> }`, or null
-- for a pipeline no update has been applied to. Not a graph: no step or
-- route is touched here (ARCHITECTURE.md, "Template versions and
-- origins").
ALTER TABLE `pipelines` ADD `template_applied` text;
--> statement-breakpoint
-- An update applied before this column, whose version is still kept.
UPDATE `pipelines` SET `template_applied` = (
	SELECT json_object('version', `pipelines`.`template_version`, 'pipelineVersion', `v`.`number`, 'at', `v`.`created_at`)
	FROM `pipeline_versions` `v`
	WHERE `v`.`pipeline_id` = `pipelines`.`id`
		AND `v`.`created_by` = 'template:' || `pipelines`.`template_slug` || '@' || `pipelines`.`template_version`
	ORDER BY `v`.`number` DESC
	LIMIT 1
) WHERE `template_slug` IS NOT NULL;
