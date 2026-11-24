-- EO-884: each version of a declared team records every member's runtime,
-- model and reasoning effort as they were when it was made, so restoring the
-- version puts them back on the members. Null on versions made before this.
ALTER TABLE `team_versions` ADD `member_settings` text;
