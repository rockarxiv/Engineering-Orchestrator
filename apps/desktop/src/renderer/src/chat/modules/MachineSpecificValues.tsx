import { describeMachineSpecificPlace, type MachineSpecificWarning } from "@eo/core";

/**
 * Values in a module that look like they only hold on one machine
 * (EO-449), in the chat layout's terms. The same statement as
 * `modules/MachineSpecificValues` — where, what matched, what to use
 * instead — and the same standing: advice that refuses nothing. Also
 * a pipeline's steps, an agent's instructions and a skill's body
 * (EO-450), with `subject` naming which.
 */
export function MachineSpecificValues({ warnings, subject = "the module" }: { warnings: readonly MachineSpecificWarning[]; subject?: string }) {
  if (warnings.length === 0) return null;
  return (
    <div role="note" aria-label="Machine-specific values" className="flex min-w-0 flex-col gap-1 rounded-[12px] bg-paused/12 px-3.5 py-2.5">
      <p className="text-[12.5px] leading-relaxed text-ink">
        This looks like it holds values that only exist on this machine, so it may break wherever {subject} is exported or shared. This is a
        read of the text, and advice: nothing is refused because of it.
      </p>
      {warnings.map((warning, index) => (
        <p key={`${index}-${warning.text}`} className="min-w-0 break-words text-[12px] text-ink-subtle">
          {describeMachineSpecificPlace(warning.where)}: <code className="font-mono">{warning.text}</code> — {warning.instead}
        </p>
      ))}
    </div>
  );
}
