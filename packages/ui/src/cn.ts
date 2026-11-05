import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merges class names, letting a caller's utility win over a component's
 * default for the same property — `cn("px-2", "px-4")` is `px-4`, not
 * both. Without that, overriding any built-in spacing means fighting
 * specificity.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
