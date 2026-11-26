-- Whether a message is a replica's copy of one the organisation's record
-- holds (EO-918): written by the pull and by a send or press answered
-- there, and read to send a press on it to the record and to clear the
-- copies the record no longer keeps. Asked of the row rather than
-- inferred from its project, since a message about a record-held job
-- has no project, and one sent here about a project before it moved is
-- this desktop's own.
--
-- A message already here about a moved project is a copy if it was
-- written after the move: from then on EO sends one to the record
-- rather than here. One about no project cannot be told from this
-- desktop's own, and is left as its own until a pull writes it again.
ALTER TABLE `messages` ADD `from_record` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE `messages` SET `from_record` = 1 WHERE EXISTS (
  SELECT 1 FROM `projects`
  WHERE `projects`.`id` = `messages`.`project_id` AND `projects`.`managed_at` IS NOT NULL AND `projects`.`managed_at` <= `messages`.`created_at`
);
