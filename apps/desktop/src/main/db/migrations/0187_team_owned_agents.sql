-- A team's members are the team's own agents (EO-897, ARCHITECTURE.md
-- §4.2a).
--
-- 0185 declared each inline team with the ordinary agents its roles were
-- bound to, so changing a member's runtime, model or reasoning in the
-- Teams tab (EO-884) changed every ordinary step that agent runs. An agent
-- now says which team owns it (`agents.team_id`), and a team names only
-- its own.
--
-- Every agent a declared team names — its leader and its members — that
-- is not already the team's own is copied: the same name, kind, runtime,
-- model, instructions, config (reasoning included), state and tool
-- surface (CLI tools, MCP servers, skills), on the team's project, owned
-- by the team. An agent two teams name is copied once for each. The copy
-- carries no prompt hash, so a newer shipped role prompt never rewrites a
-- member's instructions outside its team's versions. The ordinary agents
-- are left exactly as they are and keep running the steps that name them.
--
-- Each team that changed then names its copies, as a new version made by
-- EO recording every member's runtime, model and reasoning; its older
-- versions stay as they were. A locked team is changed too: this is EO
-- separating what was always the team's, not a change to what it is.
ALTER TABLE `agents` ADD `team_id` text;
--> statement-breakpoint
-- Each team and each agent it names, by the id its copy will have.
CREATE TEMP TABLE `team_member_copies` AS
SELECT
	`x`.`team_id`,
	`x`.`project_id`,
	`x`.`agent_id`,
	substr(`x`.`ts`, 1, 8) || '-' || substr(`x`.`ts`, 9, 4) || '-7' || substr(`x`.`r`, 1, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1) || substr(`x`.`r`, 4, 3) || '-' || substr(`x`.`r`, 7, 12) AS `copy_id`
FROM (
	SELECT
		`n`.*,
		lower(printf('%012x', CAST(unixepoch('subsec') * 1000 AS INTEGER))) AS `ts`,
		lower(hex(randomblob(9))) AS `r`
	FROM (
		SELECT DISTINCT `t`.`id` AS `team_id`, `t`.`project_id`, `m`.`agent_id`
		FROM `teams` `t`
		JOIN (
			SELECT `t2`.`id` AS `team_id`, json_extract(`t2`.`definition`, '$.leader.agentId') AS `agent_id`
			FROM `teams` `t2`
			WHERE json_valid(`t2`.`definition`) AND json_extract(`t2`.`definition`, '$.coordination') = 'leader'
			UNION
			SELECT `t3`.`id`, json_extract(`e`.`value`, '$.agentId')
			FROM `teams` `t3`, json_each(`t3`.`definition`, '$.members') `e`
			WHERE json_valid(`t3`.`definition`) AND json_type(`t3`.`definition`, '$.members') = 'array'
		) `m` ON `m`.`team_id` = `t`.`id`
		JOIN `agents` `a` ON `a`.`id` = `m`.`agent_id`
		WHERE `a`.`team_id` IS NULL OR `a`.`team_id` <> `t`.`id`
	) `n`
) `x`;
--> statement-breakpoint
INSERT INTO `agents` (`id`, `name`, `role`, `provider`, `model`, `instructions`, `prompt_hash`, `config`, `enabled`, `archived_at`, `deleted_at`, `project_id`, `updated_at`, `revision`, `record_stamp`, `team_id`)
SELECT
	`c`.`copy_id`, `a`.`name`, `a`.`role`, `a`.`provider`, `a`.`model`, `a`.`instructions`, NULL, `a`.`config`, `a`.`enabled`, `a`.`archived_at`, `a`.`deleted_at`,
	`c`.`project_id`, CAST(unixepoch('subsec') * 1000 AS INTEGER), 0, NULL, `c`.`team_id`
FROM `team_member_copies` `c` JOIN `agents` `a` ON `a`.`id` = `c`.`agent_id`;
--> statement-breakpoint
INSERT INTO `agent_cli_tools` (`agent_id`, `cli_tool_id`, `created_at`)
SELECT `c`.`copy_id`, `x`.`cli_tool_id`, `x`.`created_at` FROM `team_member_copies` `c` JOIN `agent_cli_tools` `x` ON `x`.`agent_id` = `c`.`agent_id`;
--> statement-breakpoint
INSERT INTO `agent_mcp_servers` (`agent_id`, `server_id`, `created_at`)
SELECT `c`.`copy_id`, `x`.`server_id`, `x`.`created_at` FROM `team_member_copies` `c` JOIN `agent_mcp_servers` `x` ON `x`.`agent_id` = `c`.`agent_id`;
--> statement-breakpoint
INSERT INTO `agent_skills` (`agent_id`, `skill_id`, `created_at`)
SELECT `c`.`copy_id`, `x`.`skill_id`, `x`.`created_at` FROM `team_member_copies` `c` JOIN `agent_skills` `x` ON `x`.`agent_id` = `c`.`agent_id`;
--> statement-breakpoint
-- Each team naming its copies: the leader's, and every member's in order.
UPDATE `teams`
SET
	`definition` = json_set(
		CASE WHEN json_extract(`definition`, '$.coordination') = 'leader'
			THEN json_set(`definition`, '$.leader.agentId', coalesce(
				(SELECT `c`.`copy_id` FROM `team_member_copies` `c` WHERE `c`.`team_id` = `teams`.`id` AND `c`.`agent_id` = json_extract(`teams`.`definition`, '$.leader.agentId')),
				json_extract(`definition`, '$.leader.agentId')))
			ELSE json(`definition`) END,
		'$.members',
		json((
			SELECT json_group_array(json(json_set(`e`.`value`, '$.agentId', coalesce(`c`.`copy_id`, json_extract(`e`.`value`, '$.agentId')))) ORDER BY `e`.`key`)
			FROM json_each(`teams`.`definition`, '$.members') `e`
			LEFT JOIN `team_member_copies` `c` ON `c`.`team_id` = `teams`.`id` AND `c`.`agent_id` = json_extract(`e`.`value`, '$.agentId')
		))
	),
	`version` = `version` + 1,
	`updated_at` = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE `id` IN (SELECT `team_id` FROM `team_member_copies`);
--> statement-breakpoint
-- Its new version, made by EO, recording every member's runtime, model
-- and reasoning as EO-884's versions do.
INSERT INTO `team_versions` (`id`, `team_id`, `number`, `definition`, `author_kind`, `author_id`, `author_item_id`, `restored_from`, `created_at`, `member_settings`)
SELECT
	substr(`v`.`ts`, 1, 8) || '-' || substr(`v`.`ts`, 9, 4) || '-7' || substr(`v`.`r`, 1, 3) || '-' || substr('89ab', 1 + abs(random() % 4), 1) || substr(`v`.`r`, 4, 3) || '-' || substr(`v`.`r`, 7, 12),
	`v`.`id`, `v`.`version`, `v`.`definition`, 'eo', NULL, NULL, NULL, CAST(unixepoch('subsec') * 1000 AS INTEGER),
	(
		SELECT json_group_object(`a`.`id`, json_object(
			'provider', `a`.`provider`,
			'model', `a`.`model`,
			'reasoning', CASE
				WHEN json_valid(`a`.`config`) AND `a`.`provider` IN ('claude', 'codex')
					AND json_type(`a`.`config`, CASE `a`.`provider` WHEN 'claude' THEN '$.effort' ELSE '$.reasoningEffort' END) = 'text'
					AND trim(json_extract(`a`.`config`, CASE `a`.`provider` WHEN 'claude' THEN '$.effort' ELSE '$.reasoningEffort' END)) <> ''
				THEN trim(json_extract(`a`.`config`, CASE `a`.`provider` WHEN 'claude' THEN '$.effort' ELSE '$.reasoningEffort' END))
				ELSE NULL END
		))
		FROM `agents` `a`
		WHERE `a`.`id` IN (SELECT `c`.`copy_id` FROM `team_member_copies` `c` WHERE `c`.`team_id` = `v`.`id`)
	)
FROM (
	SELECT `t`.*, lower(printf('%012x', CAST(unixepoch('subsec') * 1000 AS INTEGER))) AS `ts`, lower(hex(randomblob(9))) AS `r`
	FROM `teams` `t` WHERE `t`.`id` IN (SELECT `team_id` FROM `team_member_copies`)
) AS `v`;
--> statement-breakpoint
-- The pipelines naming a changed team, moved forward, so a replica that
-- already read them reads them again (`touchPipelinesNaming`).
UPDATE `pipelines`
SET `updated_at` = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE `id` IN (SELECT `s`.`pipeline_id` FROM `pipeline_steps` `s` WHERE `s`.`team_id` IN (SELECT `team_id` FROM `team_member_copies`));
--> statement-breakpoint
DROP TABLE `team_member_copies`;
