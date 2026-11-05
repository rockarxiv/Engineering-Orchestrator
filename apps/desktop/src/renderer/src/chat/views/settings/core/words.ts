import { useChromeVocabulary } from "../../../../query/hooks";

/**
 * What this project calls one piece of its work, in the middle of a
 * sentence: the developer pack's own word on a developer project, "item" where nothing has a
 * single word for it.
 *
 * The classic sections wrote the developer pack's word into their copy;
 * the chat layout's never assume which pack is installed, so every
 * sentence that counts work takes its word from here.
 */
export function useItemWords(): { one: string; many: string; count: (count: number) => string } {
  const vocabulary = useChromeVocabulary();
  const one = vocabulary.item.toLowerCase();
  const many = vocabulary.items.toLowerCase();
  return { one, many, count: (count: number) => `${count} ${count === 1 ? one : many}` };
}

/** `3 seats`, `1 seat`. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Bytes as something a person can act on. Not exact — the decision is "is this a lot", not "how many bytes". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
