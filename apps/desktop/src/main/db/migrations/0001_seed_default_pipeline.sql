INSERT INTO `workflow_states` (`id`, `position`, `owner_role`, `entry_action`, `is_terminal`) VALUES
	('intake', 0, 'product_owner', 'intake', 0),
	('backlog', 1, 'product_owner', 'refine', 0),
	('todo', 2, 'implementer', 'implement', 0),
	('review', 3, 'reviewer', 'review', 0),
	('ready_to_merge', 4, NULL, NULL, 1);
--> statement-breakpoint
INSERT INTO `agents` (`id`, `name`, `role`, `provider`, `model`, `instructions`, `config`, `enabled`) VALUES
	('019fb8c6-de8d-7131-a72b-323288ec44ad', 'Product Owner', 'product_owner', 'fake', NULL, 'TODO: placeholder instructions for the product_owner role.', '{}', 1),
	('019fb8c6-de91-7cdd-b0c6-3250561e04fb', 'Implementer', 'implementer', 'fake', NULL, 'TODO: placeholder instructions for the implementer role.', '{}', 1),
	('019fb8c6-de91-7f78-9211-9e193bba2ad9', 'Reviewer', 'reviewer', 'fake', NULL, 'TODO: placeholder instructions for the reviewer role.', '{}', 1);
