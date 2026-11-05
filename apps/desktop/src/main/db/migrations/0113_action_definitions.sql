-- The actions a role defines for itself (EO-421).
--
-- An agent step's entry action was a free string, and the shape its answer
-- had to take was looked up by that string alone across every role. A
-- custom action had no declared results at all; a custom schema lived in
-- one agent's `config.schemasByAction`, where no screen showed it.
--
-- A row here is the declared thing: for one role and one action, what the
-- action is for, the result keys it can return (`Array<{ key, label,
-- meaning }>`) and a JSON Schema object for any extra answer properties.
-- EO generates the output schema from it, so the keys a provider is held
-- to and the keys a step routes on are one list.
--
-- Unique on the pair, which is the whole key: a definition never applies
-- to a role other than its own, and a role has one meaning for a name.
--
-- The table only. Turning the `schemasByAction` an agent's config already
-- carries into rows is done at startup (`adoptCarriedSchemas`), in code,
-- for two reasons SQL cannot serve: every write is held to the one save
-- function, which compiles the schema, and which entries are a pack's own
-- role restating its own shipped action depends on the installed packs.
CREATE TABLE `action_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`action` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`results` text DEFAULT '[]' NOT NULL,
	`fields` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_action_definitions_role_action` ON `action_definitions` (`role`,`action`);
