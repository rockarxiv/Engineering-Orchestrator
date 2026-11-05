-- The branch and the pull request leave the item row (KAN-169,
-- ARCHITECTURE.md, "One work entity").
--
-- `items` carried `branch` and `pr_url`. Neither is a fact about an
-- item: they are facts about a *git* workspace — which branch was cut
-- for this work, and which pull request it opened — and they sat on the
-- table every item shares because `git-worktree` was the only kind
-- there was. Phase 4 adds `folder`, `scratch` and `none`; an item on
-- any of the three would have carried both columns null forever, and
-- the kind that wanted a fact of its own would have asked for a third
-- column.
--
-- They become one `git` row in `item_extensions`, the mechanism 0071
-- built for the four Jira columns, on the same terms: one row per item
-- that has something to say, and none for the rest, because the
-- accessor's defaults are what an absent row means.
--
-- `pr_url` is `pullRequest` in the payload. The column abbreviated the
-- half that carries the meaning and spelled out the half that does not;
-- both views that showed it to a person had already renamed it on the
-- way out.
--
-- `ALTER TABLE ... DROP COLUMN` rather than a rebuild, for 0071's
-- reason: neither column is indexed and neither is referenced, so a
-- rebuild of `items` would be a chance to lose an index or a foreign
-- key in exchange for nothing.

-- One row per item that has been near a git workspace, and none for the
-- rest. An item with no branch and no pull request has had nothing
-- git-shaped happen to it, which is exactly what no row says.
--
-- `updated_at` is the item's own, 0071's choice and for its reason: the
-- columns moved with the row, nothing here is an edit anybody made, and
-- a migration timestamp would date every branch in the installation to
-- the launch that upgraded it.
INSERT INTO `item_extensions` (`item_id`, `extension`, `data`, `updated_at`)
SELECT
	`id`,
	'git',
	json_object('branch', `branch`, 'pullRequest', `pr_url`),
	`updated_at`
FROM `items`
WHERE `branch` IS NOT NULL OR `pr_url` IS NOT NULL;
--> statement-breakpoint

ALTER TABLE `items` DROP COLUMN `branch`;
--> statement-breakpoint
ALTER TABLE `items` DROP COLUMN `pr_url`;
