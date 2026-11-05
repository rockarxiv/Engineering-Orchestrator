import { useSearchParams } from "react-router-dom";
import { machineAvailable } from "../../../ipc/bridge";
import { useMe } from "../../../query/hooks";
import { useViewParameters } from "../../../shared/view/ViewPublisher";
import { NavItem, ViewHeader } from "../../kit";
import { SETTINGS_SECTIONS, type SettingsSectionDef } from "./sections";
import { EffectivePolicy } from "./sections/EffectivePolicy";

/**
 * Settings, in the chat layout's terms: a list of sections on the left and
 * one section at a time beside it, each a stack of cards.
 *
 * The same sections as the classic screen, at the same `?section=` names,
 * so a link from anywhere — the first-run panel's "Settings → Workspaces",
 * the gear's "Colours" — opens on the section it names.
 */
export function SettingsView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("section");
  const me = useMe();
  const sections = SETTINGS_SECTIONS.filter(
    (candidate: SettingsSectionDef) => (machineAvailable() || !candidate.machine) && (!candidate.organisation || (me.organisation && me.admin)),
  );
  // The address says which section is open, and the list writes to it.
  // So a link that names a section opens it — the gear's "Colours" while
  // Settings is already open on another section — and coming back to
  // Settings' tab opens it where the person left it. A name nothing
  // matches (an old bookmark, a section this installation does not draw)
  // is the first section.
  const current = sections.find((candidate) => candidate.id === requested) ?? sections[0]!;
  const open = (id: string) => setSearchParams({ section: id }, { replace: true });
  // Which section is open (EO-192): the same words asked from two sections
  // are about two different screens.
  useViewParameters({ filter: { text: "", facets: { section: current.id } } });
  const Section = current.Component;

  return (
    <div className="flex min-w-0 flex-col @container">
      <ViewHeader title="Settings" />
      {/* The effective-policy card beside the section on a wide canvas,
          under it on a narrow one — always there, as the classic rail is. */}
      <div className="grid min-w-0 grid-cols-[12.5rem_minmax(0,1fr)] gap-x-5 gap-y-4 @[60rem]:grid-cols-[12.5rem_minmax(0,1fr)_15rem]">
        <nav aria-label="Settings sections" className="row-span-2 flex flex-col gap-0.5 @[60rem]:row-span-1">
          {sections.map((candidate) => (
            <NavItem key={candidate.id} selected={candidate.id === current.id} onClick={() => open(candidate.id)}>
              {candidate.label}
            </NavItem>
          ))}
        </nav>
        <div key={current.id} className="flex min-w-0 flex-col gap-4">
          <Section />
        </div>
        <aside aria-label="Effective policy" className="col-start-2 min-w-0 @[60rem]:col-start-3 @[60rem]:row-start-1">
          <EffectivePolicy />
        </aside>
      </div>
    </div>
  );
}
