import type { ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import { cn } from "@eo/ui";
import { machineAvailable } from "../../../../ipc/bridge";
import { ipcQuery } from "../../../../query/client";
import { Button, Field, Select, TextInput } from "../../../kit";

/**
 * The few pieces the settings sections share that the kit does not have.
 *
 * A note under a field sits *outside* the kit's `Field`, which is a
 * `<label>`: inside it, the note would join the control's accessible
 * name, and the control would stop being findable by what it is called.
 */
export function Note({ children, tone = "subtle", className }: { children: ReactNode; tone?: "subtle" | "paused" | "danger"; className?: string }) {
  return (
    <p
      className={cn(
        "text-[12px] leading-relaxed",
        tone === "paused" ? "text-paused" : tone === "danger" ? "text-danger" : "text-ink-subtle",
        className,
      )}
    >
      {children}
    </p>
  );
}

/** A field and the note that explains it, kept together. */
export function NotedField({ children, note }: { children: ReactNode; note: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {children}
      <Note>{note}</Note>
    </div>
  );
}

/** Two columns where the card is wide enough for them, one where it is not. */
export function FieldGrid({ children }: { children: ReactNode }) {
  return (
    <div className="@container">
      <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2">{children}</div>
    </div>
  );
}

/**
 * Which repository a per-repository section is looking at (KAN-20).
 *
 * Drawn only when the project spans more than one: on a one-repository
 * project it would be a choice of one. When it is drawn, it names the
 * repository outright, because looking at the wrong one silently is the
 * failure it exists to prevent.
 */
export function RepositoryPicker({
  members,
  chosen,
  onChoose,
}: {
  members: { id: string; name: string }[];
  chosen: { id: string; name: string } | null;
  onChoose: (id: string) => void;
}) {
  if (members.length < 2 || !chosen) return null;
  return (
    <Field label="Repository" className="max-w-[20rem]">
      <Select value={chosen.id} onChange={(event) => onChoose(event.target.value)}>
        {members.map((repository) => (
          <option key={repository.id} value={repository.id}>
            {repository.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/**
 * A path, with the native folder picker beside it (U-09).
 *
 * Still typeable — a path pasted from a terminal is often quicker. The
 * button is beside the label rather than inside it, so the field has one
 * control by its name; and it is drawn only where there is a machine to
 * open a dialog on (EO-319).
 */
export function PathField({
  label,
  value,
  placeholder,
  title,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  /** What the native dialog is called. */
  title?: string;
  onChange: (path: string) => void;
}) {
  const pick = useMutation({
    mutationFn: () => ipcQuery("dialog:pickDirectory", { title: title ?? "Choose a folder" }),
    onSuccess: (result) => {
      if (result.path) onChange(result.path);
    },
  });
  return (
    <div className="flex min-w-0 items-end gap-1.5">
      <Field label={label} className="flex-1">
        <TextInput value={value} {...(placeholder ? { placeholder } : {})} onChange={(event) => onChange(event.target.value)} />
      </Field>
      {machineAvailable() ? (
        <Button icon={<FolderOpen size={13} />} disabled={pick.isPending} onClick={() => pick.mutate()}>
          Choose
        </Button>
      ) : null}
    </div>
  );
}

/** One line of a check: what was looked at, and what was found. */
export function CheckLine({ ok, name, detail }: { ok: boolean; name: string; detail: string }) {
  return (
    <li className="flex items-baseline gap-2 text-[12.5px]">
      <span aria-hidden className={cn("h-[7px] w-[7px] shrink-0 translate-y-[-1px] rounded-full", ok ? "bg-idle" : "bg-danger")} />
      <span className="text-ink-muted">{name}</span>
      <span className={cn("min-w-0 break-words", ok ? "text-ink-subtle" : "text-danger")}>{detail}</span>
      {ok ? null : <span className="shrink-0 text-[11px] text-danger">fix this</span>}
    </li>
  );
}
