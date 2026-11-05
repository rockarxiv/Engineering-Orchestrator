import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  actionShapeFromSchema,
  JsonSchemaDocumentSchema,
  readActionDefinitionDraft,
  type ActionDefinitionDraft,
  type ExportedAction,
  type JsonSchemaDocument,
} from "@eo/core";
import type { Db } from "./db/client.js";
import { getActionDefinition, saveActionDefinition } from "./db/repos/actionDefinitionsRepo.js";
import { listAgents, updateAgent } from "./db/repos/agentsRepo.js";
import { installedRoleShips } from "./registry.js";

/**
 * Carried output schemas, turned into action definitions (EO-421).
 *
 * A role that arrived as data kept its output schemas in its agent's
 * `config.schemasByAction` (EO-314), and `registryForProject` read them
 * back from there on every dispatch. They are definitions now, and this
 * is the one place the old shape is still understood: for a database
 * that has the config key (`migrateCarriedSchemas`) and for a pipeline
 * file that still carries the member (`adoptCarriedSchemas`, from the
 * import). Both go through the same mapping and the same save, so a
 * schema that was migrated and the same schema imported afresh are the
 * same definition.
 */

/** The config key a role's schemas used to live under. Read here and nowhere else. */
const CARRIED_KEY = "schemasByAction";

const CarriedSchemasSchema = z.record(z.string(), JsonSchemaDocumentSchema);

/** What became of one carried schema. */
export interface CarriedSchemaOutcome {
  role: string;
  action: string;
}

export interface CarriedAdoption {
  /** Written as a definition. */
  defined: CarriedSchemaOutcome[];
  /**
   * Left alone because the role is an installed pack's own and the
   * action is one that role ships — the `reviewer`'s `review`.
   *
   * What such a role carries there is the pack's own shape written down,
   * which is what the shipped pipeline's export does, and the pack
   * already holds the role to it. By the pair and never by the action
   * name alone: a *custom* role carrying a schema for `review` has its
   * own version of that action, role plus action is the key, and it is
   * written like any other.
   */
  packs: CarriedSchemaOutcome[];
  /** Left alone because the role already defines the action; the installation's own is kept. */
  kept: CarriedSchemaOutcome[];
  /** Refused by the save, with why. */
  refused: (CarriedSchemaOutcome & { problems: string[] })[];
}

/** One carried schema as the draft the save is handed. */
function draftFor(role: string, action: string, document: JsonSchemaDocument): ActionDefinitionDraft {
  return { role, action, description: "", ...actionShapeFromSchema(document) };
}

/**
 * The first carried schema the save would refuse, as a sentence, or null.
 *
 * For the import's refusal, which has to be decided before anything is
 * written: a pack whose role answers in keys a route cannot name is
 * refused whole rather than landing with that role silently held to
 * nothing.
 */
export function carriedSchemaRefusal(role: string, carried: Readonly<Record<string, JsonSchemaDocument>>): string | null {
  for (const [action, document] of Object.entries(carried)) {
    if (installedRoleShips(role, action)) continue;
    const read = readActionDefinitionDraft(draftFor(role, action, document), { shipsAction: installedRoleShips });
    if (!read.ok) return `The ${role} role's "${action}" action cannot be defined from its schema: ${read.problems.join(" ")}`;
  }
  return null;
}

/**
 * Writes one role's carried schemas as its definitions.
 *
 * A definition the role already has is kept rather than replaced: a
 * document does not edit the installation that adopted it.
 */
export function adoptCarriedSchemas(db: Db, role: string, carried: Readonly<Record<string, JsonSchemaDocument>>, now: number = Date.now()): CarriedAdoption {
  const adoption: CarriedAdoption = { defined: [], packs: [], kept: [], refused: [] };

  for (const [action, document] of Object.entries(carried)) {
    if (installedRoleShips(role, action)) {
      adoption.packs.push({ role, action });
      continue;
    }
    // By the role as the save will write it, trimmed (EO-424): asked by
    // the file's own spelling, a padded slug finds nothing here and the
    // save then replaces the definition it lands on.
    if (getActionDefinition(db, role.trim(), action) !== undefined) {
      adoption.kept.push({ role, action });
      continue;
    }
    const saved = saveActionDefinition(db, draftFor(role, action, document), now);
    if (saved.ok) adoption.defined.push({ role, action });
    else adoption.refused.push({ role, action, problems: saved.problems });
  }

  return adoption;
}

/** What became of the definitions a document carried for one role (EO-424). */
export interface ExportedActionAdoption {
  /** Written, because the role had no definition of that action. */
  defined: CarriedSchemaOutcome[];
  /**
   * Left alone because the installation already defines that action for
   * that role **differently**. Its own is kept — a file does not edit the
   * installation that adopted it — and these are what the import's
   * summary names, since the pipeline that just arrived will run on a
   * definition other than the one it was written against.
   *
   * A definition that is already here word for word is in neither list:
   * nothing was written and nothing differs, so there is nothing to say.
   */
  kept: CarriedSchemaOutcome[];
}

/**
 * The first definition in a role's `actions` the save would refuse, as a
 * sentence naming the role and the action, or null (EO-424).
 *
 * Asked before anything is written, of every entry — one the
 * installation would keep its own over included, because a file that
 * carries a definition no installation could save is a damaged file
 * whichever machine reads it.
 *
 * An action listed twice is refused too. The second would otherwise be
 * compared against the first, found to differ and reported as the
 * installation's own being kept, which is a true sentence about the
 * wrong thing. `seen` is what makes that true across the whole file:
 * the caller hands the same set to every role, so one role entered
 * twice — or once as `qa` and once as ` qa ` — is caught as well.
 */
export function exportedActionRefusal(role: string, actions: readonly ExportedAction[], seen: Set<string> = new Set()): string | null {
  for (const carried of actions) {
    // By the role as the save spells it, so that `qa` and ` qa ` in one
    // file are the one role they would be written as.
    const pair = `${role.trim()}\u0000${carried.action}`;
    if (seen.has(pair)) return `The ${role.trim()} role's "${carried.action}" action is defined twice in this file.`;
    seen.add(pair);

    const read = readActionDefinitionDraft({ role, ...carried }, { shipsAction: installedRoleShips });
    if (!read.ok) return `The ${role} role's "${carried.action}" action cannot be defined: ${read.problems.join(" ")}`;
  }
  return null;
}

/**
 * The refusal for a definition the document's own schema would not
 * read, naming the role and the action, or null (EO-424).
 *
 * `exportedActionRefusal` is asked of a document that parsed. One whose
 * definition is the wrong *shape* — `fields` as a list, a result with no
 * key, results that are not a list — never gets that far: the schema
 * refuses the whole file, and all a person was told was that it is
 * damaged. The save refuses those too, so they are owed the same
 * sentence as a duplicate key gets.
 *
 * `raw` is the JSON as it was read and `paths` are where the schema's
 * issues are. Only an issue inside `roles[i].actions[j]` is answered,
 * and only where the file still says which role and which action —
 * without both there is nothing to name and the file is, in fact, just
 * damaged. The reason is the save's own where it has one, since those
 * are the rules being broken; a shape the save would take and the
 * document will not is told as where in the definition it is.
 */
export function malformedActionRefusal(raw: unknown, paths: readonly (readonly PropertyKey[])[]): string | null {
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

  for (const path of paths) {
    const [roles, roleIndex, actions, actionIndex, ...within] = path;
    if (roles !== "roles" || actions !== "actions" || typeof roleIndex !== "number" || typeof actionIndex !== "number") continue;
    if (!isRecord(raw) || !Array.isArray(raw["roles"])) continue;

    const role: unknown = raw["roles"][roleIndex];
    if (!isRecord(role) || typeof role["slug"] !== "string" || role["slug"] === "" || !Array.isArray(role["actions"])) continue;
    const slug = role["slug"];

    const carried: unknown = role["actions"][actionIndex];
    if (!isRecord(carried) || typeof carried["action"] !== "string" || carried["action"] === "") {
      return `The ${slug} role carries an action definition with no action name, so it cannot be defined.`;
    }

    const read = readActionDefinitionDraft({ ...carried, role: slug }, { shipsAction: installedRoleShips });
    const why = read.ok ? `its ${within.map(String).join(".")} is not what a definition holds.` : read.problems.join(" ");
    return `The ${slug} role's "${carried["action"]}" action cannot be defined: ${why}`;
  }
  return null;
}

/**
 * Writes the definitions a document carries for one role (EO-424).
 *
 * Whether or not the role is already staffed here, which is where this
 * parts from `adoptCarriedSchemas`' caller: a definition is the role's,
 * not an agent's, and a pipeline arriving for a role somebody already
 * has an agent in still dispatches these actions. Without them every
 * such step would answer unvalidated and route as `done`.
 *
 * Never over one that exists. Compared as the save would normalise it —
 * description, results in order with labels and meanings, fields — so a
 * file re-imported onto the installation that wrote it says nothing.
 */
export function adoptExportedActions(db: Db, role: string, actions: readonly ExportedAction[], now: number = Date.now()): ExportedActionAdoption {
  const adoption: ExportedActionAdoption = { defined: [], kept: [] };

  for (const carried of actions) {
    const draft = { role, ...carried };
    // Read first, and everything after asks by what the read answered.
    // The save writes under the role as it normalises it — trimmed —
    // so a lookup by the file's own spelling would miss the definition
    // a slug of " qa " is about to land on, find nothing to keep, and
    // let the save replace it: a file editing the installation, with
    // nothing said. One spelling, the save's, for the question and the
    // write and the name reported.
    const read = readActionDefinitionDraft(draft, { shipsAction: installedRoleShips });
    // Thrown, because this runs inside the import's transaction and a
    // throw is what rolls it back. `exportedActionRefusal` has already
    // asked the same rules of the same draft, so reaching this is a
    // caller that skipped it.
    if (!read.ok) throw new Error(`The ${role} role's "${carried.action}" action cannot be defined: ${read.problems.join(" ")}`);

    const pair = { role: read.role, action: read.action };
    const existing = getActionDefinition(db, read.role, read.action);

    if (existing !== undefined) {
      const same = read.description === existing.description && isDeepStrictEqual(read.results, existing.results) && isDeepStrictEqual(read.fields, existing.fields);
      if (!same) adoption.kept.push(pair);
      continue;
    }

    const saved = saveActionDefinition(db, draft, now);
    if (!saved.ok) throw new Error(`The ${role} role's "${carried.action}" action cannot be defined: ${saved.problems.join(" ")}`);
    adoption.defined.push(pair);
  }

  return adoption;
}

/**
 * Moves every agent's `config.schemasByAction` into definitions (EO-421).
 *
 * Run once at startup, after the packs are folded — which entries are
 * a pack's own role restating its own shipped action depends on what is
 * installed — and safe to run on every start: an agent with no such key is not
 * touched.
 *
 * **Live agents only, the first of a role first**, which is what the
 * registry read: an archived agent's schemas went with it, and where two
 * agents staffed one role the first one's were the role's. An archived
 * row is left exactly as it is; nothing reads the key any more.
 *
 * The key is then removed from the agent's config, so the row says what
 * is true of it. **Except for an entry the save refused**, which stays
 * where it was: it cannot be a definition as written — a result key with
 * a capital in it, fields ajv will not compile — and deleting somebody's
 * schema because EO could not convert it would be the silent loss
 * invariant 8 is about. It is reported, and nothing reads it until
 * somebody fixes it.
 */
export function migrateCarriedSchemas(db: Db, now: number = Date.now()): CarriedAdoption {
  const total: CarriedAdoption = { defined: [], packs: [], kept: [], refused: [] };

  for (const agent of listAgents(db)) {
    if (agent.archivedAt !== null || !Object.hasOwn(agent.config, CARRIED_KEY)) continue;

    const carried = CarriedSchemasSchema.safeParse(agent.config[CARRIED_KEY]);
    // Not a map of schemas at all: the registry ignored it, and there is
    // nothing in it to convert or to keep.
    const adoption = carried.success ? adoptCarriedSchemas(db, agent.role, carried.data, now) : { defined: [], packs: [], kept: [], refused: [] };

    const config: Record<string, unknown> = Object.fromEntries(Object.entries(agent.config).filter(([key]) => key !== CARRIED_KEY));
    if (carried.success && adoption.refused.length > 0) {
      config[CARRIED_KEY] = Object.fromEntries(adoption.refused.map(({ action }) => [action, carried.data[action]]));
    }
    updateAgent(db, agent.id, { config });

    total.defined.push(...adoption.defined);
    total.packs.push(...adoption.packs);
    total.kept.push(...adoption.kept);
    total.refused.push(...adoption.refused);
  }

  return total;
}
