import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Item, Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { saveGroup } from "../db/repos/groupsRepo.js";
import { setStepOwner } from "../db/repos/pipelineStepsRepo.js";
import { setItemAssignee } from "../db/repos/itemsRepo.js";
import { authorityFor, judgeClaimOutright, judgeOnGroupStep } from "./stepAuthority.js";

/**
 * The rule on a group-owned human step, on its own (EO-368). The record
 * paths that apply it are `sync.test.ts`'s subject; this is the table.
 */
let handle: DbHandle;
let anna: string;
let dana: string;
let pat: string;
let item: Item;

beforeEach(() => {
  handle = openMigratedTestDb();
  anna = createPerson(handle.db, { name: "Anna" }).id;
  dana = createPerson(handle.db, { name: "Dana" }).id;
  pat = createPerson(handle.db, { name: "Pat" }).id;
  const design = saveGroup(handle.db, { name: "Design", memberIds: [anna, dana] });
  setStepOwner(handle.db, "ready_to_merge", { personId: null, groupId: design.id });
  item = createTestItem(handle.db, { type: "story", title: "Launch post", stepId: "ready_to_merge" });
});

afterEach(() => handle.close());

const held = (by: string | null): Item => {
  setItemAssignee(handle.db, item.id, by as Uuid | null);
  return { ...item, assigneeId: by as Uuid | null };
};

describe("who may act on a step that waits on a group", () => {
  it("keeps everybody outside the group out of every act, naming the group", () => {
    for (const act of ["claim", "takeover", "change"] as const) {
      expect(judgeOnGroupStep(handle.db, held(anna), pat, act, anna)).toMatchObject({ why: "notInGroup", groupName: "Design" });
    }
    // The operator's key is nobody, and nobody is in a group.
    expect(judgeOnGroupStep(handle.db, held(null), null, "claim")).toMatchObject({ why: "notInGroup" });
  });

  it("lets only the holder change it, and asks for a claim where nobody holds it", () => {
    expect(judgeOnGroupStep(handle.db, held(anna), anna, "change")).toBeNull();
    expect(judgeOnGroupStep(handle.db, held(anna), dana, "change")).toMatchObject({ why: "heldBy", holder: { id: anna, name: "Anna" } });
    expect(judgeOnGroupStep(handle.db, held(null), dana, "change")).toMatchObject({ why: "unclaimed", holder: null });
  });

  it("lets a member take it over only from the holder they were warned about", () => {
    expect(judgeOnGroupStep(handle.db, held(anna), dana, "takeover", anna)).toBeNull();
    expect(judgeOnGroupStep(handle.db, held(anna), dana, "takeover", pat)).toMatchObject({ why: "stale", holder: { name: "Anna" } });
    expect(judgeOnGroupStep(handle.db, held(null), dana, "takeover", anna)).toMatchObject({ why: "stale", holder: null });
    // …and not from themselves: an item that reached the sender some
    // other way since the warning has changed hands all the same.
    expect(judgeOnGroupStep(handle.db, held(dana), dana, "takeover", anna)).toMatchObject({ why: "stale", holder: { id: dana } });
  });

  it("leaves who already holds it to the record's arbitration for a queued claim, and judges it outright for a direct one", () => {
    expect(judgeOnGroupStep(handle.db, held(anna), dana, "claim")).toBeNull();
    expect(judgeClaimOutright(handle.db, held(anna), dana)).toMatchObject({ why: "heldBy", holder: { name: "Anna" } });
    expect(judgeClaimOutright(handle.db, held(null), dana)).toBeNull();
  });

  it("says which of the three somebody is, for the screen", () => {
    expect(authorityFor(handle.db, held(anna), anna)?.you).toBe("holder");
    expect(authorityFor(handle.db, held(anna), dana)?.you).toBe("member");
    expect(authorityFor(handle.db, held(anna), pat)?.you).toBe("outsider");
    expect(authorityFor(handle.db, held(pat), pat)?.you).toBe("outsider");
  });

  it("lets an administrator outside the group take it over and then decide, but not claim it or decide first", () => {
    const admin = createPerson(handle.db, { name: "Sam", isAdmin: true }).id;

    expect(judgeOnGroupStep(handle.db, held(null), admin, "claim")).toMatchObject({ why: "notInGroup" });
    expect(judgeClaimOutright(handle.db, held(null), admin)).toMatchObject({ why: "notInGroup" });
    expect(judgeOnGroupStep(handle.db, held(anna), admin, "change")).toMatchObject({ why: "notInGroup" });
    expect(judgeOnGroupStep(handle.db, held(null), admin, "change")).toMatchObject({ why: "notInGroup" });

    // From the holder they were warned about, and from nobody else.
    expect(judgeOnGroupStep(handle.db, held(anna), admin, "takeover", anna)).toBeNull();
    expect(judgeOnGroupStep(handle.db, held(anna), admin, "takeover", dana)).toMatchObject({ why: "stale" });
    expect(judgeOnGroupStep(handle.db, held(null), admin, "takeover", anna)).toMatchObject({ why: "stale" });

    // Once they hold it, the decision is theirs.
    expect(judgeOnGroupStep(handle.db, held(admin), admin, "change")).toBeNull();

    expect(authorityFor(handle.db, held(anna), admin)?.you).toBe("member");
    expect(authorityFor(handle.db, held(admin), admin)?.you).toBe("holder");
    expect(authorityFor(handle.db, held(null), admin)?.you).toBe("outsider");
  });

  it("answers nothing on a step with no owner, or one naming a single person", () => {
    setStepOwner(handle.db, "ready_to_merge", { personId: null, groupId: null });
    expect(judgeOnGroupStep(handle.db, held(anna), pat, "change")).toBeNull();
    // …except a takeover, which is only ever of a step that waits on a group.
    expect(judgeOnGroupStep(handle.db, held(anna), dana, "takeover", anna)).toMatchObject({ why: "notGroupStep", holder: { id: anna } });
    expect(authorityFor(handle.db, held(anna), pat)).toBeNull();
    setStepOwner(handle.db, "ready_to_merge", { personId: dana as Uuid, groupId: null });
    expect(judgeOnGroupStep(handle.db, held(anna), pat, "change")).toBeNull();
    expect(judgeClaimOutright(handle.db, held(anna), pat)).toBeNull();
  });
});
