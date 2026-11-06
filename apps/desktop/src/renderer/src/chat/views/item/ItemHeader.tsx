import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { FileText, SquareTerminal } from "lucide-react";
import { Tabs, ViewHeader } from "../../kit";

/**
 * The head of an item's tab: its title, a line about it, its actions, and
 * the switch between the item and its runs.
 *
 * The two are one tab in the canvas (`tabKeyOf`), so the switch is how a
 * person moves between them — to the same addresses the classic screens
 * have, `/items/:id` and `/items/:id/runs`, which is what the assistant
 * reads to know which is open.
 */
export function ItemHeader({
  itemId,
  title,
  meta,
  actions,
  current,
  runCount,
  children,
}: {
  itemId: string;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  current: "item" | "runs";
  runCount: number;
  children?: ReactNode;
}) {
  const navigate = useNavigate();
  // `stackActions`, as the board's head has: in a canvas a few hundred
  // pixels across, the actions took the whole row and left the title a
  // column no wide at all (EO-646, found where a hosted runner's screen
  // made the window 1024 wide).
  return (
    <ViewHeader icon={current === "item" ? <FileText size={15} /> : <SquareTerminal size={15} />} title={title} meta={meta} actions={actions} stackActions>
      <Tabs
        label="Item or runs"
        value={current}
        tabs={[
          { value: "item", label: "Item" },
          { value: "runs", label: "Runs", count: runCount },
        ]}
        onChange={(next) => {
          if (next !== current) void navigate(next === "item" ? `/items/${itemId}` : `/items/${itemId}/runs`);
        }}
      />
      {children}
    </ViewHeader>
  );
}
