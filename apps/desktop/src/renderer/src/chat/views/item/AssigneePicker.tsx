import { useItemAuthority } from "../../../shared/admin/authority";
import { useAssignItem, usePeople } from "../../../query/hooks";
import { Select } from "../../kit";
import { Initial } from "./parts";

/**
 * Who holds this item, and handing it to somebody else (EO-305, EO-326).
 *
 * Drawn only where there is somebody to choose: on a machine with one
 * person a picker would offer to hand the work to whoever already has it.
 * Choosing the blank again is a no-op rather than an unassignment —
 * taking an item off somebody is a different act, and not this one.
 */
export function AssigneePicker({ itemId, assignee }: { itemId: string; assignee: { id: string; name: string } | null }) {
  const { people } = usePeople();
  const assign = useAssignItem();
  const { readOnly } = useItemAuthority(itemId);

  if (people.length <= 1) return null;

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {assignee ? <Initial name={assignee.name} /> : null}
      <Select
        aria-label="Assign this to"
        value={assignee?.id ?? ""}
        disabled={readOnly || assign.isPending}
        className="w-[10rem]"
        onChange={(event) => {
          const personId = event.target.value;
          if (personId === "" || personId === assignee?.id) return;
          assign.mutate({ itemId, personId });
        }}
      >
        <option value="">Unassigned</option>
        {people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
      </Select>
    </span>
  );
}
