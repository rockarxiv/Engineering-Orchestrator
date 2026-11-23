-- A declared team is its own entity, and a step names it (EO-881,
-- ARCHITECTURE.md §4.2a).
--
-- A team was a setting carried inline on one agent step
-- (`pipeline_steps.team`, 0182), its leader and members staffed by role.
-- It is now a row of `teams`, its leader and members named as agents,
-- every change a row of `team_versions`, and a step names it by id.
--
-- Every inline team becomes a declared team named after its pipeline and
-- step ("Delivery · Review"), on the pipeline's project, and the step is
-- pointed at it. Each role is bound to the agent EO-874 (0181) bound a
-- step's role to: of the role's agents, enabled, neither archived nor
-- deleted, not a preview's own, and global or of the pipeline's project,
-- the project's own where it has any, the first in staffing order
-- (rowid). Where no such agent exists, the first agent that ever held the
-- role there is named instead, so the team stays the team it was — and,
-- as it runs as role-staffed until EO-882, runs as it did. Its tool pool
-- is every tool its members have, and its model range their runtimes,
-- models and reasoning, so no member is beyond what the team declares.
--
-- A saved version keeps the team it froze (its `team`), so an item
-- finishing on an older version runs what it always would; its steps are
-- only told which declared team they are now (`teamId`).
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`definition` text NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`version` integer NOT NULL,
	`trial_pipeline_id` text,
	`trial_source` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_teams_project` ON `teams` (`project_id`,`name`);
--> statement-breakpoint
CREATE INDEX `idx_teams_trial` ON `teams` (`trial_pipeline_id`,`trial_source`);
--> statement-breakpoint
CREATE TABLE `team_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`number` integer NOT NULL,
	`definition` text NOT NULL,
	`author_kind` text NOT NULL,
	`author_id` text,
	`author_item_id` text,
	`restored_from` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_team_versions_number` ON `team_versions` (`team_id`,`number`);
--> statement-breakpoint
ALTER TABLE `pipeline_steps` ADD `team_id` text REFERENCES teams(id);
--> statement-breakpoint
-- The steps with a team, the project each is on ('' for none) and the
-- name its team is based on. The name is kept within a team name's 120
-- code units (`generatedTeamName` in packages/core, the same rule): a
-- base of at most 110 UTF-8 bytes is kept whole, a longer one cut to 54
-- characters and '…' — at most 109 code units whatever the characters —
-- leaving room for ' (n)'. `base_ordinal` counts the steps sharing a
-- base on a project, compared as `teamByName` compares them: trimmed and
-- folded (`eo_fold_case`, registered on every connection, textFold.ts).
CREATE TEMP TABLE `team_bases` AS
SELECT
	`b`.*,
	row_number() OVER (PARTITION BY `b`.`project_key`, eo_fold_case(`b`.`base_name`) ORDER BY `b`.`step_id`) AS `base_ordinal`
FROM (
	SELECT
		`n`.`step_id`, `n`.`project_id`, `n`.`project_key`, `n`.`team`,
		CASE WHEN length(CAST(`n`.`full_name` AS BLOB)) <= 110 THEN `n`.`full_name` ELSE substr(`n`.`full_name`, 1, 54) || '…' END AS `base_name`
	FROM (
		SELECT
			`s`.`id` AS `step_id`,
			`p`.`project_id`,
			coalesce(`p`.`project_id`, '') AS `project_key`,
			json(`s`.`team`) AS `team`,
			trim(`p`.`name` || ' · ' || `s`.`name`) AS `full_name`
		FROM `pipeline_steps` `s` JOIN `pipelines` `p` ON `p`.`id` = `s`.`pipeline_id`
		WHERE `s`.`type` = 'agent' AND `s`.`team` IS NOT NULL AND json_valid(`s`.`team`) AND json_type(`s`.`team`) = 'object'
	) `n`
) `b`;
--> statement-breakpoint
-- The numbers a name may be given: one more than there are teams, so
-- every team finds one no other team on its project has.
CREATE TEMP TABLE `team_numbers` AS
WITH RECURSIVE `k`(`n`) AS (SELECT 1 UNION ALL SELECT `n` + 1 FROM `k` WHERE `n` <= (SELECT count(*) FROM `team_bases`))
SELECT `n` FROM `k`;
--> statement-breakpoint
-- Each team's name, unique on its project as `teamByName` reads names
-- (trimmed, folded), so a draft naming a team names exactly one. Every
-- step whose base no other shares keeps it as it is; the rest, one by one,
-- take the lowest ' (n)' no team of the project has taken yet — so a
-- second "Delivery · X" beside a step literally called "X (2)" is not
-- given that step's name.
CREATE TEMP TABLE `team_sources` AS
WITH RECURSIVE
	`ordered` AS (
		SELECT `b`.*, row_number() OVER (ORDER BY `b`.`base_ordinal` > 1, `b`.`project_key`, `b`.`step_id`) AS `i` FROM `team_bases` `b`
	),
	`named`(`i`, `step_id`, `name`, `taken`) AS (
		SELECT 0, NULL, NULL, json_array()
		UNION ALL
		SELECT
			`o`.`i`, `o`.`step_id`,
			CASE WHEN `k`.`n` = 1 THEN `o`.`base_name` ELSE `o`.`base_name` || ' (' || `k`.`n` || ')' END,
			json_insert(`a`.`taken`, '$[#]', `o`.`project_key` || char(10) || eo_fold_case(CASE WHEN `k`.`n` = 1 THEN `o`.`base_name` ELSE `o`.`base_name` || ' (' || `k`.`n` || ')' END))
		FROM `named` `a`
		JOIN `ordered` `o` ON `o`.`i` = `a`.`i` + 1
		JOIN `team_numbers` `k` ON `k`.`n` = (
			SELECT min(`m`.`n`) FROM `team_numbers` `m`
			WHERE NOT EXISTS (
				SELECT 1 FROM json_each(`a`.`taken`) `u`
				WHERE `u`.`value` = `o`.`project_key` || char(10) || eo_fold_case(CASE WHEN `m`.`n` = 1 THEN `o`.`base_name` ELSE `o`.`base_name` || ' (' || `m`.`n` || ')' END)
			)
		)
	)
SELECT `b`.`step_id`, `b`.`project_id`, `b`.`project_key`, `b`.`team`, `x`.`name`
FROM `team_bases` `b` JOIN `named` `x` ON `x`.`step_id` = `b`.`step_id`;
--> statement-breakpoint
-- Every role those teams dispatch, by the project it is staffed on.
CREATE TEMP TABLE `team_roles` AS
SELECT DISTINCT `t`.`project_key`, json_extract(`t`.`team`, '$.leader.role') AS `role` FROM `team_sources` `t` WHERE json_extract(`t`.`team`, '$.coordination') = 'leader'
UNION
SELECT DISTINCT `t`.`project_key`, `r`.`value` FROM `team_sources` `t`, json_each(`t`.`team`, '$.roles') `r` WHERE json_extract(`t`.`team`, '$.coordination') = 'leader'
UNION
SELECT DISTINCT `t`.`project_key`, json_extract(`p`.`value`, '$.role') FROM `team_sources` `t`, json_each(`t`.`team`, '$.participants') `p` WHERE json_extract(`t`.`team`, '$.coordination') = 'independent';
--> statement-breakpoint
-- The agent each role is bound to: 0181's rule first (enabled, live, not
-- a preview's, the project's own before a global one, staffing order),
-- then any agent that held the role there.
CREATE TEMP TABLE `team_role_binding` AS
SELECT `k`.`project_key`, `k`.`role`, (
	SELECT `a`.`id` FROM `agents` `a`
	WHERE `a`.`role` = `k`.`role` AND (`a`.`project_id` IS NULL OR `a`.`project_id` = `k`.`project_key`)
	ORDER BY
		(`a`.`enabled` = 1 AND `a`.`archived_at` IS NULL AND `a`.`deleted_at` IS NULL
			AND coalesce(json_extract(CASE WHEN json_valid(`a`.`config`) THEN `a`.`config` ELSE '{}' END, '$.eoPreviewAgent'), 0) <> 1) DESC,
		`a`.`project_id` IS NULL,
		`a`.`deleted_at` IS NOT NULL,
		`a`.`rowid`
	LIMIT 1
) AS `agent_id`
FROM `team_roles` `k`;
--> statement-breakpoint
-- Each team's member agents, for its pool and range.
CREATE TEMP TABLE `team_member_agents` AS
SELECT DISTINCT `t`.`step_id`, `b`.`agent_id`
FROM `team_sources` `t`, json_each(`t`.`team`, CASE WHEN json_extract(`t`.`team`, '$.coordination') = 'leader' THEN '$.roles' ELSE '$.participants' END) `m`
JOIN `team_role_binding` `b` ON `b`.`project_key` = `t`.`project_key`
	AND `b`.`role` = CASE WHEN json_extract(`t`.`team`, '$.coordination') = 'leader' THEN `m`.`value` ELSE json_extract(`m`.`value`, '$.role') END
WHERE `b`.`agent_id` IS NOT NULL;
--> statement-breakpoint
-- The declared teams: an id, a name and the whole definition.
CREATE TEMP TABLE `team_new` AS
SELECT
	`x`.`step_id`,
	substr(`x`.`ts`, 1, 8) || '-' || substr(`x`.`ts`, 9, 4) || '-7' || substr(`x`.`r`, 1, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1) || substr(`x`.`r`, 4, 3) || '-' || substr(`x`.`r`, 7, 12) AS `team_id`,
	`x`.`project_id`,
	`x`.`name`,
	CASE WHEN json_extract(`x`.`team`, '$.coordination') = 'leader' THEN json_object(
		'coordination', 'leader',
		'name', `x`.`name`,
		'memberMode', coalesce(json_extract(`x`.`team`, '$.members'), 'report_only'),
		'leader', json_object(
			'agentId', (SELECT `b`.`agent_id` FROM `team_role_binding` `b` WHERE `b`.`project_key` = `x`.`project_key` AND `b`.`role` = json_extract(`x`.`team`, '$.leader.role')),
			'instructions', json_extract(`x`.`team`, '$.leader.instructions')
		),
		'members', json((
			SELECT json_group_array(json_object('agentId', `b`.`agent_id`) ORDER BY `r`.`key`)
			FROM json_each(`x`.`team`, '$.roles') `r`
			LEFT JOIN `team_role_binding` `b` ON `b`.`project_key` = `x`.`project_key` AND `b`.`role` = `r`.`value`
		)),
		'outcomes', json(coalesce(json_extract(`x`.`team`, '$.outcomes'), '[]')),
		'limits', json(coalesce(json_extract(`x`.`team`, '$.limits'), '{}')),
		'toolPool', json(`x`.`pool`),
		'modelRange', json(`x`.`range`),
		'memberCap', 8
	) ELSE json_object(
		'coordination', 'independent',
		'name', `x`.`name`,
		'memberMode', coalesce(json_extract(`x`.`team`, '$.members'), 'report_only'),
		'members', json((
			SELECT json_group_array(json(json_remove(json_set(`p`.`value`, '$.agentId', `b`.`agent_id`), '$.role')) ORDER BY `p`.`key`)
			FROM json_each(`x`.`team`, '$.participants') `p`
			LEFT JOIN `team_role_binding` `b` ON `b`.`project_key` = `x`.`project_key` AND `b`.`role` = json_extract(`p`.`value`, '$.role')
		)),
		'outcomes', json(coalesce(json_extract(`x`.`team`, '$.outcomes'), '[]')),
		'completion', json(coalesce(json_extract(`x`.`team`, '$.completion'), '{}')),
		'limits', json(coalesce(json_extract(`x`.`team`, '$.limits'), '{}')),
		'toolPool', json(`x`.`pool`),
		'modelRange', json(`x`.`range`),
		'memberCap', 8
	) END AS `definition`
FROM (
	SELECT
		`t`.*,
		lower(printf('%012x', CAST(unixepoch('subsec') * 1000 AS INTEGER))) AS `ts`,
		lower(hex(randomblob(9))) AS `r`,
		json_object(
			'cliTools', json((SELECT json_group_array(`c`.`command`) FROM (SELECT DISTINCT `ct`.`command` FROM `team_member_agents` `m` JOIN `agent_cli_tools` `ac` ON `ac`.`agent_id` = `m`.`agent_id` JOIN `cli_tools` `ct` ON `ct`.`id` = `ac`.`cli_tool_id` WHERE `m`.`step_id` = `t`.`step_id` ORDER BY `ct`.`command`) `c`)),
			'mcpServers', json((SELECT json_group_array(`c`.`name`) FROM (SELECT DISTINCT `ms`.`name` FROM `team_member_agents` `m` JOIN `agent_mcp_servers` `am` ON `am`.`agent_id` = `m`.`agent_id` JOIN `mcp_servers` `ms` ON `ms`.`id` = `am`.`server_id` WHERE `m`.`step_id` = `t`.`step_id` ORDER BY `ms`.`name`) `c`)),
			'skills', json((SELECT json_group_array(`c`.`slug`) FROM (SELECT DISTINCT `sk`.`slug` FROM `team_member_agents` `m` JOIN `agent_skills` `ags` ON `ags`.`agent_id` = `m`.`agent_id` JOIN `skills` `sk` ON `sk`.`id` = `ags`.`skill_id` WHERE `m`.`step_id` = `t`.`step_id` ORDER BY `sk`.`slug`) `c`))
		) AS `pool`,
		json_object(
			'runtimes', json((SELECT json_group_array(`c`.`provider`) FROM (SELECT DISTINCT `a`.`provider` FROM `team_member_agents` `m` JOIN `agents` `a` ON `a`.`id` = `m`.`agent_id` ORDER BY `a`.`provider`) `c`)),
			'models', json((SELECT json_group_array(`c`.`model`) FROM (SELECT DISTINCT `a`.`model` FROM `team_member_agents` `m` JOIN `agents` `a` ON `a`.`id` = `m`.`agent_id` WHERE `a`.`model` IS NOT NULL AND trim(`a`.`model`) <> '' ORDER BY `a`.`model`) `c`)),
			'reasoning', json((SELECT json_group_array(`c`.`effort`) FROM (
				SELECT DISTINCT trim(json_extract(`a`.`config`, CASE `a`.`provider` WHEN 'claude' THEN '$.effort' ELSE '$.reasoningEffort' END)) AS `effort`
				FROM `team_member_agents` `m` JOIN `agents` `a` ON `a`.`id` = `m`.`agent_id`
				WHERE `a`.`provider` IN ('claude', 'codex') AND json_valid(`a`.`config`)
				  AND json_type(`a`.`config`, CASE `a`.`provider` WHEN 'claude' THEN '$.effort' ELSE '$.reasoningEffort' END) = 'text'
				  AND trim(json_extract(`a`.`config`, CASE `a`.`provider` WHEN 'claude' THEN '$.effort' ELSE '$.reasoningEffort' END)) <> ''
				ORDER BY 1) `c`))
		) AS `range`
	FROM `team_sources` `t`
) AS `x`;
--> statement-breakpoint
INSERT INTO `teams` (`id`, `project_id`, `name`, `definition`, `locked`, `version`, `created_at`, `updated_at`)
SELECT `team_id`, `project_id`, `name`, `definition`, 0, 1, CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM `team_new`;
--> statement-breakpoint
-- Its first version, made by EO: a team that already ran, declared.
INSERT INTO `team_versions` (`id`, `team_id`, `number`, `definition`, `author_kind`, `author_id`, `author_item_id`, `restored_from`, `created_at`)
SELECT
	substr(`v`.`ts`, 1, 8) || '-' || substr(`v`.`ts`, 9, 4) || '-7' || substr(`v`.`r`, 1, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1) || substr(`v`.`r`, 4, 3) || '-' || substr(`v`.`r`, 7, 12),
	`v`.`team_id`, 1, `v`.`definition`, 'eo', NULL, NULL, NULL, CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM (SELECT `n`.*, lower(printf('%012x', CAST(unixepoch('subsec') * 1000 AS INTEGER))) AS `ts`, lower(hex(randomblob(9))) AS `r` FROM `team_new` `n`) AS `v`;
--> statement-breakpoint
UPDATE `pipeline_steps`
SET `team_id` = (SELECT `n`.`team_id` FROM `team_new` `n` WHERE `n`.`step_id` = `pipeline_steps`.`id`)
WHERE `id` IN (SELECT `step_id` FROM `team_new`);
--> statement-breakpoint
-- Every saved version's steps that ran as a team: told which declared
-- team that step is now. The team each froze stays as it was.
UPDATE `pipeline_versions`
SET `steps` = (
	SELECT json_group_array(
		CASE WHEN json_type(`e`.`value`, '$.team') = 'object' AND `n`.`team_id` IS NOT NULL
			THEN json_set(`e`.`value`, '$.teamId', `n`.`team_id`)
			ELSE json(`e`.`value`) END
		ORDER BY `e`.`key`)
	FROM json_each(`pipeline_versions`.`steps`) `e`
	LEFT JOIN `team_new` `n` ON `n`.`step_id` = json_extract(`e`.`value`, '$.id')
)
WHERE json_valid(`steps`) AND json_type(`steps`) = 'array' AND json_array_length(`steps`) > 0
  AND EXISTS (SELECT 1 FROM json_each(`pipeline_versions`.`steps`) `e` JOIN `team_new` `n` ON `n`.`step_id` = json_extract(`e`.`value`, '$.id') WHERE json_type(`e`.`value`, '$.team') = 'object');
--> statement-breakpoint
-- A trial's approved graph, for 0181's reason: each step that runs as a
-- team names what the trial's own step names now, so its publish card
-- does not report the migration as a change.
UPDATE `pipelines`
SET `trial_design` = json_set(`trial_design`, '$.approvedGraph.steps', (
	SELECT json_group_array(
		CASE WHEN json_type(`e`.`value`, '$.team') = 'object' AND `n`.`team_id` IS NOT NULL
			THEN json_set(`e`.`value`, '$.teamId', `n`.`team_id`)
			ELSE json(`e`.`value`) END
		ORDER BY `e`.`key`)
	FROM json_each(`pipelines`.`trial_design`, '$.approvedGraph.steps') `e`
	LEFT JOIN `team_new` `n` ON `n`.`step_id` = json_extract(`e`.`value`, '$.id')
))
WHERE json_valid(`trial_design`) AND json_type(`trial_design`, '$.approvedGraph.steps') = 'array' AND json_array_length(`trial_design`, '$.approvedGraph.steps') > 0
  AND EXISTS (SELECT 1 FROM json_each(`pipelines`.`trial_design`, '$.approvedGraph.steps') `e` JOIN `team_new` `n` ON `n`.`step_id` = json_extract(`e`.`value`, '$.id'));
--> statement-breakpoint
ALTER TABLE `pipeline_steps` DROP COLUMN `team`;
--> statement-breakpoint
DROP TABLE `team_new`;
--> statement-breakpoint
DROP TABLE `team_member_agents`;
--> statement-breakpoint
DROP TABLE `team_role_binding`;
--> statement-breakpoint
DROP TABLE `team_roles`;
--> statement-breakpoint
DROP TABLE `team_sources`;
--> statement-breakpoint
DROP TABLE `team_numbers`;
--> statement-breakpoint
DROP TABLE `team_bases`;
