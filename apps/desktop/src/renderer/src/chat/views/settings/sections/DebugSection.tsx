import { DEBUG_MODE_DESCRIPTION, DEBUG_MODE_LABEL, DEBUG_MODE_NOTE, useDebugModeSetting } from "../../../../debug/DebugModeSetting";
import { CardSection, Loading, Switch } from "../../../kit";
import { Note } from "../core/fields";

/**
 * Settings → Debug, in the chat layout (EO-392): the same switch as the
 * classic screen's, under the same words, drawn in this layout's card.
 */
export function DebugSection() {
  const { enabled, saving, set } = useDebugModeSetting();

  return (
    <CardSection title="Debug" description={DEBUG_MODE_DESCRIPTION}>
      {enabled === undefined ? (
        <Loading />
      ) : (
        <>
          <Switch label={DEBUG_MODE_LABEL} checked={enabled} disabled={saving} onChange={set} />
          <Note>{DEBUG_MODE_NOTE}</Note>
        </>
      )}
    </CardSection>
  );
}
