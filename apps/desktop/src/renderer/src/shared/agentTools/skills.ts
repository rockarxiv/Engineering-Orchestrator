import { GLOBAL_SKILL_SCOPE, type IpcRequest, type Skill, type SkillFile, type SkillScope } from "@eo/core";

/**
 * The skill form's draft, and how it becomes a save, for both layouts'
 * catalogues (EO-519). The classic one draws it in
 * `agentTools/Skills.tsx`, the chat one in
 * `chat/views/agentTools/SkillsPanel.tsx`.
 */

export interface SkillDraft {
  id?: string;
  slug: string;
  name: string;
  description: string;
  body: string;
  files: SkillFile[];
  disableModelInvocation: boolean;
  /** Which runs it reaches once attached (EO-470). */
  scope: SkillScope;
}

const STARTER_BODY = `## When to use this

Describe the situation this skill is for.

## How to do it

1. The first step.
2. The second.
`;

export const BLANK: SkillDraft = { slug: "", name: "", description: "", body: STARTER_BODY, files: [], disableModelInvocation: false, scope: GLOBAL_SKILL_SCOPE };

export function draftOf(skill: Skill): SkillDraft {
  return {
    id: skill.id,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    files: skill.files,
    disableModelInvocation: skill.disableModelInvocation,
    scope: skill.scope,
  };
}

export function toSave(draft: SkillDraft): IpcRequest<"skills:save"> {
  return {
    ...(draft.id === undefined ? {} : { id: draft.id }),
    // Empty means "decide one" on a create and "keep the one it has" on
    // an edit — the field is optional on purpose, so an empty box must
    // not be sent as an empty slug.
    slug: draft.slug.trim() === "" ? null : draft.slug.trim(),
    name: draft.name,
    description: draft.description,
    body: draft.body,
    files: draft.files,
    disableModelInvocation: draft.disableModelInvocation,
    // Always sent: the form shows the scope the skill has, so what is in
    // the picker is what the person means (EO-470).
    scope: draft.scope,
    // `enabled` is deliberately absent, for the reason the schema gives:
    // fixing a typo in a body says nothing about a switch somebody
    // deliberately turned off.
  };
}
