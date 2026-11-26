-- How many times a route may be taken since a person last commented on
-- the item (EO-921, ARCHITECTURE.md, "Guardrails"). NULL, on every row
-- this finds, is no limit: a route without one behaves as it always did.
--
-- Not on `pipeline_versions`: a version freezes its routes whole in its
-- `routes` document, which carries the limit as it carries the label.
ALTER TABLE `step_routes` ADD `traversal_limit` integer;
--> statement-breakpoint
-- The declared result a move was made on, where the mover knew it: the
-- route's key, or the result a person pressed. Announced to listeners
-- since EO-586 and never written, which left a route's traversals
-- uncountable: two results of one step may send an item to the same
-- place. NULL on every move made before this, and on moves that took no
-- route, so those count towards no limit.
ALTER TABLE `transitions` ADD `result_key` text;
