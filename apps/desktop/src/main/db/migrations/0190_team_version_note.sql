-- EO-899: a version of a declared team can say why EO made it, in a sentence
-- the Teams tab shows beside it — e.g. that EO moved a team which belonged to
-- no project into the project whose pipeline runs as it. Null on every other
-- version, and on every version made before this.
ALTER TABLE `team_versions` ADD `note` text;
