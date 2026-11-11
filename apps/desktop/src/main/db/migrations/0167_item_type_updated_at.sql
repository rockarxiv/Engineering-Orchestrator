-- When an item type last changed after it was made (EO-735), or null
-- for one nobody has edited. The record pages types to its replicas by
-- this, falling back to `created_at`, so a type an admin renames or
-- gives a field of the project's own reaches every desktop that already
-- holds it, rather than only the ones that had not pulled it yet.
ALTER TABLE `item_types` ADD `updated_at` integer;
