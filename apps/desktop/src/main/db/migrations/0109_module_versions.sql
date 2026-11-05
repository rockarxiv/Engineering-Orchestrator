-- A module's history (EO-360).
--
-- Until now `modules` held only the live code and manifest, and a save
-- overwrote them. A version is filed on every save that changes either,
-- holding the name, description, code and manifest it had, the test
-- cases that went with that code, and when a person approved it.
--
-- `tests` is the module's cases as they stood when the version stopped
-- being current: refreshed from `module_tests` just before the next
-- version is filed. The current version is always the newest, and its
-- cases are the live rows.
CREATE TABLE `module_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`number` integer NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`code` text NOT NULL,
	`manifest` text NOT NULL,
	`tests` text NOT NULL,
	`approved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_module_versions_number` ON `module_versions` (`module_id`,`number`);--> statement-breakpoint
-- Every module that exists starts its history at v1: its present code,
-- manifest and cases, approved exactly when it is approved now. Archived
-- ones too, so a module brought back has a history like any other.
--
-- In SQL rather than on first read, unlike 0098's pipeline versions:
-- a module version is flat columns and an array of rows from one table,
-- not a document shaped by a schema three packages away. The id is
-- uuidv7-shaped the way 0024 and 0069 build one, from the moment the
-- module was last saved.
INSERT INTO `module_versions` (`id`, `module_id`, `number`, `name`, `description`, `code`, `manifest`, `tests`, `approved_at`, `created_at`)
SELECT
	substr(printf('%012x', `m`.`updated_at`), 1, 8) || '-' ||
		substr(printf('%012x', `m`.`updated_at`), 9, 4) || '-7' ||
		substr(lower(hex(randomblob(2))), 2) || '-a' ||
		substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
	`m`.`id`,
	1,
	`m`.`name`,
	`m`.`description`,
	`m`.`code`,
	`m`.`manifest`,
	(
		SELECT json_group_array(json_object('id', `t`.`id`, 'description', `t`.`description`, 'source', `t`.`source`, 'createdAt', `t`.`created_at`, 'updatedAt', `t`.`updated_at`))
		FROM (SELECT * FROM `module_tests` WHERE `module_tests`.`module_id` = `m`.`id` ORDER BY `created_at`, `id`) AS `t`
	),
	`m`.`approved_at`,
	`m`.`updated_at`
FROM `modules` AS `m`;
