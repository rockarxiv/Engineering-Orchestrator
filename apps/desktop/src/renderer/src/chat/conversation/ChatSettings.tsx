import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Brain, Check, ChevronDown } from "lucide-react";
import type { DiscussionSettings, IpcPayload } from "@eo/core";
import { cn } from "@eo/ui";
import { ipcQuery } from "../../query/client";
import { Switch } from "../kit";

/**
 * What the next turns in this chat run with — Claude Desktop's model
 * picker, in the box's own row: the model, how hard it reasons, and
 * whether its reasoning is shown.
 *
 * Only what the agent's backend offers (ARCHITECTURE.md, "The parity
 * rule": no control that would do nothing). The models are the backend's
 * own list (`providers:capabilities`), read once a minute at most because
 * reading it spawns the CLI; "Default" is the agent's own model, and
 * choosing it clears the chat's choice rather than writing the agent's
 * name down. Efforts are the chosen model's own levels where it says, and
 * the backend's otherwise.
 *
 * Changing any of it changes the next turn, not the running one.
 */
export function ChatSettings({ settings, onChange, disabled = false }: { settings: DiscussionSettings; onChange: (patch: Omit<IpcPayload<"assist:settings">, "conversationId">) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // Whether there is anything to choose is the main process's to say
  // (`configurable`), so this file names no backend (invariant 12).
  const live = settings.configurable === true;
  const capabilities = useQuery({
    queryKey: ["providers", "capabilities", settings.provider],
    queryFn: () => ipcQuery("providers:capabilities", { provider: settings.provider, refreshModels: true }),
    enabled: open && live,
    staleTime: 60_000,
  });

  // Opened, the keyboard is in the panel; closed by Escape, it is back on
  // the button that opened it. Without scrolling: the panel floats over
  // the transcript, and focusing a row far down the model list must not
  // move the chat behind it.
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>('[aria-checked="true"], button')?.focus({ preventScroll: true });
  }, [open]);

  // The models arrive after the panel opens, so the chosen one is not
  // there yet when focus runs. Once they are, its row is brought into the
  // list's visible part by the list's own scroll — `scrollIntoView` would
  // scroll every scrolling ancestor, the transcript included. The list is
  // positioned, so a row's `offsetTop` is measured from its top.
  const loaded = capabilities.data;
  useEffect(() => {
    const scroller = list.current;
    const row = scroller?.querySelector<HTMLElement>('[aria-checked="true"]');
    if (!open || !scroller || !row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
  }, [open, loaded]);

  useEffect(() => {
    if (!open) return undefined;
    const away = (event: MouseEvent) => {
      if (box.current && event.target instanceof Node && !box.current.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  if (!live) return null;

  const models = capabilities.data?.models ?? [];
  const modelValue = settings.model ?? settings.defaultModel;
  const chosen = models.find((model) => model.value === modelValue);
  const modelLabel = chosen?.label ?? modelValue ?? "Default model";
  // The chosen model's own levels where it names some, and only those the
  // backend offers — the list `assist:settings` checks against — so the
  // picker never offers a level the save would refuse.
  const offered = settings.reasoningEfforts ?? [];
  const efforts = chosen?.supportsEffort && chosen.effortLevels.length > 0 ? chosen.effortLevels.filter((level) => offered.includes(level)) : offered;
  const effort = settings.reasoningEffort ?? settings.defaultReasoningEffort;
  const showReasoning = settings.showReasoning !== false;

  return (
    <span ref={box} className="relative inline-flex min-w-0">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Model and reasoning: ${modelLabel}${effort ? `, ${effort}` : ""}`}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-[26px] min-w-0 items-center gap-1 rounded-[8px] px-1.5 text-[11.5px] text-ink-subtle hover:bg-canvas-raised hover:text-ink disabled:opacity-50"
      >
        <span className="truncate">{modelLabel}</span>
        {effort ? <span className="shrink-0 text-ink-subtle">· {effort}</span> : null}
        {showReasoning ? <Brain aria-hidden size={11} className="shrink-0" /> : null}
        <ChevronDown aria-hidden size={11} className="shrink-0" />
      </button>
      {open ? (
        <div
          ref={panel}
          role="dialog"
          aria-label="Model and reasoning for this chat"
          className="absolute bottom-full left-0 z-[var(--z-dropdown)] mb-2 flex w-72 flex-col gap-3 rounded-[14px] bg-canvas-raised p-2 shadow-panel"
        >
          <div className="flex flex-col">
            <span aria-hidden className="px-2 pb-1 pt-0.5 font-mono text-[10.5px] uppercase tracking-wide text-ink-subtle">Model</span>
            {/* About four rows (a row with its detail line is ~48px, so 13rem
                holds four and lets a fifth peek), then it scrolls in itself:
                a backend with fifteen models must not make the panel as tall
                as the window, and Effort and Show thinking below stay in
                view. "Default" scrolls with the rest rather than pinned. */}
            <div ref={list} role="radiogroup" aria-label="Model" className="flex max-h-52 flex-col gap-px overflow-y-auto relative *:shrink-0">
              <Option selected={settings.model === null} onSelect={() => onChange({ model: null })} label="Default" detail={settings.defaultModel ?? "the agent's own"} />
              {capabilities.isLoading ? <p className="px-2 py-1 text-[12px] text-ink-subtle">Reading the models…</p> : null}
              {models.map((model) => (
                <Option key={model.value} selected={settings.model === model.value} onSelect={() => onChange({ model: model.value })} label={model.label} detail={model.description} />
              ))}
            </div>
          </div>
          {efforts.length > 0 ? (
            <section aria-label="Reasoning effort" className="flex flex-col gap-1">
              <span className="px-2 font-mono text-[10.5px] uppercase tracking-wide text-ink-subtle">Effort</span>
              <div role="radiogroup" aria-label="Reasoning effort" className="flex flex-wrap gap-1 px-1.5">
                {efforts.map((level) => (
                  <button
                    key={level}
                    type="button"
                    role="radio"
                    aria-checked={effort === level}
                    onClick={() => onChange({ reasoningEffort: level })}
                    // The chosen one by lightness and weight, not by the
                    // accent: the accent is for what you can do, never for
                    // what is (ARCHITECTURE.md, "Colour").
                    className={cn(
                      "h-[26px] rounded-[8px] px-2 text-[12px]",
                      effort === level ? "bg-canvas-active font-semibold text-ink shadow-[inset_0_0_0_1px_var(--color-line-strong)]" : "bg-canvas-subtle text-ink-muted hover:bg-canvas-hover hover:text-ink",
                    )}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          <div className="px-2 py-1">
            <Switch checked={showReasoning} onChange={(checked) => onChange({ showReasoning: checked })} label="Show thinking" description="Its reasoning, folded under each turn" />
          </div>
          <p className="px-2 pb-0.5 text-[11px] text-ink-subtle">Applies from the next message.</p>
        </div>
      ) : null}
    </span>
  );
}

function Option({ selected, onSelect, label, detail }: { selected: boolean; onSelect: () => void; label: string; detail?: string | undefined }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn("flex w-full items-start gap-2 rounded-[10px] px-2 py-1.5 text-left", selected ? "bg-canvas-hover" : "hover:bg-canvas-hover")}
    >
      <Check aria-hidden size={13} className={cn("mt-0.5 shrink-0", selected ? "text-ink" : "invisible")} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[12.5px] text-ink">{label}</span>
        {detail ? <span className="truncate text-[11.5px] text-ink-subtle">{detail}</span> : null}
      </span>
    </button>
  );
}
