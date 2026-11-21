-- A step names its agent (EO-875, ARCHITECTURE.md §12.1).
--
-- An `agent` step named a role (`owner_role`) and dispatch ran whichever
-- dispatchable agent held it: the pipeline's project's own if it had
-- any, else a global one (`staffingAgents`). A step now names one agent,
-- and the role is that agent's kind. So every agent step is given the
-- agent today's staffing would have dispatched for a real item on its
-- pipeline's project, and nothing changes in what runs:
--
--   enabled, not archived (a deleted agent is archived too), of the
--   step's role, not a preview's own, and global or of the pipeline's
--   project; where the project has one of its own among those, only
--   its own; the first in staffing order (`listAgents`, by rowid).
--
-- A pipeline on no project is bound to global agents only. A step with
-- no candidate names no agent, and an item that reaches it is told so.
-- Where there were several, the person is sent a message naming the
-- pipeline, the step and the agent chosen (invariant 8), since EO no
-- longer spreads one step's work across them.
--
-- The candidates, by the project and role they were counted for.
-- `project_key` is '' for a pipeline on no project.
CREATE TEMP TABLE `step_agent_candidates` AS
WITH `keys` AS (
	SELECT DISTINCT coalesce(`p`.`project_id`, '') AS `project_key`, `s`.`owner_role` AS `role`
	FROM `pipeline_steps` `s` JOIN `pipelines` `p` ON `p`.`id` = `s`.`pipeline_id`
	WHERE `s`.`type` = 'agent' AND `s`.`owner_role` IS NOT NULL
	UNION
	SELECT DISTINCT coalesce(`p`.`project_id`, ''), json_extract(`e`.`value`, '$.ownerRole')
	FROM `pipeline_versions` `v` JOIN `pipelines` `p` ON `p`.`id` = `v`.`pipeline_id`, json_each(`v`.`steps`) `e`
	WHERE json_valid(`v`.`steps`) AND json_extract(`e`.`value`, '$.type') = 'agent' AND json_extract(`e`.`value`, '$.ownerRole') IS NOT NULL
),
`eligible` AS (
	SELECT `k`.`project_key`, `k`.`role`, `a`.`id` AS `agent_id`, `a`.`name`, `a`.`rowid` AS `staffing_order`, `a`.`project_id` IS NOT NULL AS `own`
	FROM `keys` `k` JOIN `agents` `a` ON `a`.`role` = `k`.`role`
	WHERE `a`.`enabled` = 1
	  AND `a`.`archived_at` IS NULL
	  AND `a`.`deleted_at` IS NULL
	  AND (`a`.`project_id` IS NULL OR `a`.`project_id` = `k`.`project_key`)
	  AND coalesce(json_extract(CASE WHEN json_valid(`a`.`config`) THEN `a`.`config` ELSE '{}' END, '$.eoPreviewAgent'), 0) <> 1
)
SELECT `e`.`project_key`, `e`.`role`, `e`.`agent_id`, `e`.`name`, `e`.`staffing_order`
FROM `eligible` `e`
WHERE `e`.`own` = 1
   OR NOT EXISTS (SELECT 1 FROM `eligible` `o` WHERE `o`.`project_key` = `e`.`project_key` AND `o`.`role` = `e`.`role` AND `o`.`own` = 1);
--> statement-breakpoint
-- One row per project and role: the agent chosen, and how many there were.
CREATE TEMP TABLE `step_agent_binding` AS
SELECT `c`.`project_key`, `c`.`role`,
	(SELECT `f`.`agent_id` FROM `step_agent_candidates` `f` WHERE `f`.`project_key` = `c`.`project_key` AND `f`.`role` = `c`.`role` ORDER BY `f`.`staffing_order` LIMIT 1) AS `agent_id`,
	(SELECT `f`.`name` FROM `step_agent_candidates` `f` WHERE `f`.`project_key` = `c`.`project_key` AND `f`.`role` = `c`.`role` ORDER BY `f`.`staffing_order` LIMIT 1) AS `agent_name`,
	count(*) AS `candidates`
FROM `step_agent_candidates` `c`
GROUP BY `c`.`project_key`, `c`.`role`;
--> statement-breakpoint
ALTER TABLE `pipeline_steps` ADD `agent_id` text;
--> statement-breakpoint
UPDATE `pipeline_steps`
SET `agent_id` = (
	SELECT `b`.`agent_id` FROM `step_agent_binding` `b`, `pipelines` `p`
	WHERE `p`.`id` = `pipeline_steps`.`pipeline_id` AND `b`.`project_key` = coalesce(`p`.`project_id`, '') AND `b`.`role` = `pipeline_steps`.`owner_role`
)
WHERE `type` = 'agent' AND `owner_role` IS NOT NULL;
--> statement-breakpoint
-- The message for every step that had a choice. Its id is a UUIDv7 made
-- from the moment and random bits; `subject` is the step, so a later
-- story can resolve it once the step names somebody else.
INSERT INTO `messages` (`id`, `recipient_id`, `project_id`, `job_id`, `source`, `body`, `options`, `created_at`, `handled_at`, `handled_how`, `answer`, `subject`)
SELECT
	substr(`m`.`ts`, 1, 8) || '-' || substr(`m`.`ts`, 9, 4) || '-7' || substr(`m`.`r`, 1, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1) || substr(`m`.`r`, 4, 3) || '-' || substr(`m`.`r`, 7, 12),
	'01a0a0af-6d78-73d8-9954-953391d30f68',
	`m`.`project_id`,
	NULL,
	'step_agent_chosen',
	'"' || `m`.`step_name` || '" on the "' || `m`.`pipeline_name` || '" pipeline now runs **' || `m`.`agent_name` || '**. ' ||
	'A step names the agent it runs now, rather than a role, and ' || `m`.`candidates` || ' enabled "' || `m`.`role` || '" agents could have run its work: ' ||
	`m`.`agent_name` || ' was the first of them, so it is the one the step names. EO no longer shares one step''s work between agents of a kind. ' ||
	'To have another of them run it, choose that agent on the step.',
	NULL,
	CAST(unixepoch('subsec') * 1000 AS INTEGER),
	NULL, NULL, NULL,
	`m`.`step_id`
FROM (
	SELECT
		lower(printf('%012x', CAST(unixepoch('subsec') * 1000 AS INTEGER))) AS `ts`,
		lower(hex(randomblob(9))) AS `r`,
		`p`.`project_id`, `p`.`name` AS `pipeline_name`, `s`.`id` AS `step_id`, `s`.`name` AS `step_name`,
		`b`.`role`, `b`.`agent_name`, `b`.`candidates`
	FROM `pipeline_steps` `s`
	JOIN `pipelines` `p` ON `p`.`id` = `s`.`pipeline_id`
	JOIN `step_agent_binding` `b` ON `b`.`project_key` = coalesce(`p`.`project_id`, '') AND `b`.`role` = `s`.`owner_role`
	WHERE `s`.`type` = 'agent' AND `b`.`candidates` > 1
) AS `m`;
--> statement-breakpoint
-- Every saved version's agent steps the same way, so an item finishing
-- on an older version is dispatched to the agent its step would have
-- had. The role is left in the document as it was written; nothing reads
-- it any more.
UPDATE `pipeline_versions`
SET `steps` = (
	SELECT json_group_array(
		CASE WHEN json_extract(`e`.`value`, '$.type') = 'agent'
			THEN json_set(`e`.`value`, '$.agentId', (
				SELECT `b`.`agent_id` FROM `step_agent_binding` `b`, `pipelines` `p`
				WHERE `p`.`id` = `pipeline_versions`.`pipeline_id` AND `b`.`project_key` = coalesce(`p`.`project_id`, '') AND `b`.`role` = json_extract(`e`.`value`, '$.ownerRole')
			))
			ELSE json(`e`.`value`) END
		ORDER BY `e`.`key`)
	FROM json_each(`pipeline_versions`.`steps`) `e`
)
WHERE json_valid(`steps`) AND json_type(`steps`) = 'array' AND json_array_length(`steps`) > 0;
--> statement-breakpoint
-- A trial's approved graph, which its publish card compares the trial
-- with: each of its agent steps names what the trial's own step does
-- now, so the card does not report the migration as a change.
UPDATE `pipelines`
SET `trial_design` = json_set(`trial_design`, '$.approvedGraph.steps', (
	SELECT json_group_array(
		CASE WHEN json_extract(`e`.`value`, '$.type') = 'agent'
			THEN json_set(`e`.`value`, '$.agentId', (SELECT `s`.`agent_id` FROM `pipeline_steps` `s` WHERE `s`.`id` = json_extract(`e`.`value`, '$.id')))
			ELSE json(`e`.`value`) END
		ORDER BY `e`.`key`)
	FROM json_each(`pipelines`.`trial_design`, '$.approvedGraph.steps') `e`
))
WHERE json_valid(`trial_design`) AND json_type(`trial_design`, '$.approvedGraph.steps') = 'array' AND json_array_length(`trial_design`, '$.approvedGraph.steps') > 0;
--> statement-breakpoint
ALTER TABLE `pipeline_steps` DROP COLUMN `owner_role`;
--> statement-breakpoint
DROP TABLE `step_agent_binding`;
--> statement-breakpoint
DROP TABLE `step_agent_candidates`;
