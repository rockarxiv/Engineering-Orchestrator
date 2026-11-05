-- A spec shape becomes a JSON Schema for the item's `spec` (KAN-147).
--
-- 0069 wrote the shape as `[{"name":...,"required":...}]`, which was
-- enough to say *that* a field was demanded and nothing about what it
-- was. Nothing read it then. What reads it now is item creation — which
-- validates an item's spec against it through the validator KAN-125 put
-- in core — and the composed intake schema, which needs a field's kind to
-- ask an agent for it. Both want a document, and JSON Schema is the
-- document `spec` was always describable in.
--
-- Two steps, in this order. First every row still holding the old array
-- is converted generically, because a shape is data a pack wrote and EO
-- cannot know what any given field was meant to be — every one becomes a
-- string, which is the kind that accepts what a person would have typed.
-- Then the three the developer pack ships are set to the documents it
-- ships, kinds and all, because those EO does know.
--
-- The generic step is a defence rather than a case today: no second pack
-- ships an item type, so the only array-form rows are the developer's
-- three and the empty `[]` 0069 invented for a word an item had used.
-- It is here because the alternative is a row whose shape no longer
-- parses, which `specShapeOf` reads as "demands nothing" — safe, silent,
-- and wrong about a field somebody declared.
UPDATE `item_types`
SET `spec_shape` = json_object(
	'type', 'object',
	'properties', COALESCE(
		(SELECT json_group_object(json_extract(`field`.`value`, '$.name'), json_object('type', 'string'))
		 FROM json_each(`item_types`.`spec_shape`) AS `field`
		 WHERE json_extract(`field`.`value`, '$.name') IS NOT NULL),
		json_object()
	),
	'required', COALESCE(
		(SELECT json_group_array(json_extract(`field`.`value`, '$.name'))
		 FROM json_each(`item_types`.`spec_shape`) AS `field`
		 WHERE json_extract(`field`.`value`, '$.required') = 1),
		json_array()
	)
)
WHERE json_valid(`spec_shape`) AND json_type(`spec_shape`) = 'array';
--> statement-breakpoint

-- A container is decomposed rather than implemented: no fields to arrive
-- with, and no definition of done of its own. One imported from Jira may
-- still hold criteria (EO-205), which the spec keeps — a shape says what
-- a type demands and what an editor offers, not what a `spec` may
-- contain.
UPDATE `item_types`
SET `spec_shape` = '{"type":"object","properties":{},"required":[]}'
WHERE `pack_slug` = 'developer' AND `slug` = 'feature';
--> statement-breakpoint

-- A story's one field, with the phrase and the reason a refusal names it
-- by. Both were written into the hand-over handler by hand until now, so
-- the sentence a person reads when a story arrives without criteria is
-- the type's words and is unchanged.
UPDATE `item_types`
SET `spec_shape` = '{"type":"object","properties":{"acceptance_criteria":{"minItems":1,"type":"array","items":{"type":"string","minLength":1},"title":"at least one acceptance criterion","description":"it is what EO checks the implementer''s claim against","x-eo-criteria":true}},"required":["acceptance_criteria"]}'
WHERE `pack_slug` = 'developer' AND `slug` = 'story';
--> statement-breakpoint

-- A bug's four reproduction fields, which are its bar, and its criteria,
-- which are accepted and not demanded (EO-205). `expected` is marked as
-- the one field EO may *offer* as a criterion without adopting it
-- (EO-200, EO-213): the review refusal quotes it for a person to accept
-- in one line, and which field that is belongs to the type rather than to
-- the code that writes the sentence.
UPDATE `item_types`
SET `spec_shape` = '{"type":"object","properties":{"steps_to_reproduce":{"type":"string","minLength":1},"expected":{"type":"string","minLength":1,"x-eo-criteria-offer":true},"actual":{"type":"string","minLength":1},"environment":{"type":"string","minLength":1},"acceptance_criteria":{"default":[],"type":"array","items":{"type":"string","minLength":1},"x-eo-criteria":true}},"required":["steps_to_reproduce","expected","actual","environment"]}'
WHERE `pack_slug` = 'developer' AND `slug` = 'bug';
