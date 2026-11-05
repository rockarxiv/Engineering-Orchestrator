import { ManagedSection } from "../../../managed/ManagedSection";
import { ModulesCatalog } from "../org/ModulesCatalog";

/**
 * Settings → Modules.
 *
 * A module is what a `module` step runs, so it is the pipelines section's
 * code half (EO-329, review): `modules:save`, `modules:approve` and
 * `modules:archive` are refused while that section is published, and a
 * screen left live over a refusal is a screen whose buttons lie.
 */
export function ModulesSection() {
  return (
    <ManagedSection section="pipelines">
      <ModulesCatalog />
    </ManagedSection>
  );
}
