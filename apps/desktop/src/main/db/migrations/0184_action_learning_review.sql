-- Whether a run of a role's own action is followed by a learning review
-- (EO-911). On for every definition that exists, so nothing changes until
-- a person turns it off.
ALTER TABLE `action_definitions` ADD `learning_review` integer DEFAULT true NOT NULL;
