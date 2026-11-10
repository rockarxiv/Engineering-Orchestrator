-- What the item's own files were when a run's thread was told about them
-- (EO-703). A dispatch lists them beside the description and a resumed
-- thread is not told again, so `findReusableThread` refuses a thread born
-- with a different list. Null on every existing row, read as none.
ALTER TABLE `runs` ADD `item_files_hash` text;
