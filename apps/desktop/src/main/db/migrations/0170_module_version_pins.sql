-- A module step and a module entry rule pin a module version (EO-770,
-- ARCHITECTURE.md §4.6, §17.5).
--
-- Until now a module step stored only its module's id, and a module entry
-- rule only `module: <id>`, so every pipeline -- and every item bound to an
-- older pipeline version -- ran whatever code the module row held at that
-- moment. The pin is a `module_versions.number`, and the runner loads that
-- version's code and manifest and gates on that version's approval.
--
-- Every existing step and rule is pinned here, in the live graph and in
-- every stored version snapshot, to the newest approved version of its
-- module, or to its newest version where none is approved -- in which case
-- the step stays blocked, as it was. A module with no version at all
-- (none can be made today) is left unpinned, which runs the module as it
-- stands. A rule is only ever given a number, never null: a null would not
-- parse as an entry rule, and the whole list would be read as empty.
--
-- `pipeline_versions` is history and is otherwise never updated. Pinning
-- its snapshots rewrites no fact about what ran: each pins the version the
-- live row would have run, which is what every item bound to it runs from
-- here on.
ALTER TABLE `pipeline_steps` ADD `module_version` integer;
--> statement-breakpoint
UPDATE `pipeline_steps`
SET `module_version` = (
	SELECT mv.`number` FROM `module_versions` mv
	WHERE mv.`module_id` = `pipeline_steps`.`entry_action`
	ORDER BY (mv.`approved_at` IS NOT NULL) DESC, mv.`number` DESC
	LIMIT 1
)
WHERE `type` = 'module' AND `entry_action` IS NOT NULL;
--> statement-breakpoint
UPDATE `pipelines`
SET `entry_rules` = (
	SELECT json_group_array(
		CASE
			WHEN json_extract(r.value, '$.kind') = 'module'
				AND json_type(r.value, '$.module') = 'text'
				AND (SELECT mv.`number` FROM `module_versions` mv WHERE mv.`module_id` = json_extract(r.value, '$.module') LIMIT 1) IS NOT NULL
			THEN json_set(r.value, '$.moduleVersion', (
				SELECT mv.`number` FROM `module_versions` mv
				WHERE mv.`module_id` = json_extract(r.value, '$.module')
				ORDER BY (mv.`approved_at` IS NOT NULL) DESC, mv.`number` DESC
				LIMIT 1
			))
			ELSE json(r.value)
		END
		ORDER BY r.key
	)
	FROM json_each(`pipelines`.`entry_rules`) r
)
WHERE json_valid(`entry_rules`) AND json_type(`entry_rules`) = 'array'
	AND EXISTS (SELECT 1 FROM json_each(`pipelines`.`entry_rules`) r WHERE json_extract(r.value, '$.kind') = 'module');
--> statement-breakpoint
UPDATE `pipeline_versions`
SET `entry_rules` = (
	SELECT json_group_array(
		CASE
			WHEN json_extract(r.value, '$.kind') = 'module'
				AND json_type(r.value, '$.module') = 'text'
				AND (SELECT mv.`number` FROM `module_versions` mv WHERE mv.`module_id` = json_extract(r.value, '$.module') LIMIT 1) IS NOT NULL
			THEN json_set(r.value, '$.moduleVersion', (
				SELECT mv.`number` FROM `module_versions` mv
				WHERE mv.`module_id` = json_extract(r.value, '$.module')
				ORDER BY (mv.`approved_at` IS NOT NULL) DESC, mv.`number` DESC
				LIMIT 1
			))
			ELSE json(r.value)
		END
		ORDER BY r.key
	)
	FROM json_each(`pipeline_versions`.`entry_rules`) r
)
WHERE json_valid(`entry_rules`) AND json_type(`entry_rules`) = 'array'
	AND EXISTS (SELECT 1 FROM json_each(`pipeline_versions`.`entry_rules`) r WHERE json_extract(r.value, '$.kind') = 'module');
--> statement-breakpoint
UPDATE `pipeline_versions`
SET `steps` = (
	SELECT json_group_array(
		CASE
			WHEN json_extract(s.value, '$.type') = 'module'
				AND json_type(s.value, '$.entryAction') = 'text'
				AND (SELECT mv.`number` FROM `module_versions` mv WHERE mv.`module_id` = json_extract(s.value, '$.entryAction') LIMIT 1) IS NOT NULL
			THEN json_set(s.value, '$.moduleVersion', (
				SELECT mv.`number` FROM `module_versions` mv
				WHERE mv.`module_id` = json_extract(s.value, '$.entryAction')
				ORDER BY (mv.`approved_at` IS NOT NULL) DESC, mv.`number` DESC
				LIMIT 1
			))
			ELSE json(s.value)
		END
		ORDER BY s.key
	)
	FROM json_each(`pipeline_versions`.`steps`) s
)
WHERE json_valid(`steps`) AND json_type(`steps`) = 'array'
	AND EXISTS (SELECT 1 FROM json_each(`pipeline_versions`.`steps`) s WHERE json_extract(s.value, '$.type') = 'module');
