import { useEffect, type ReactNode } from "react";

/**
 * EO is dark. Not "dark by default" — dark.
 *
 * The system is a cool slate extracted from a reference that only exists
 * dark, and a light palette nobody has drawn is worse than no light palette:
 * it means the design most people see is the one nobody designed.
 *
 * Kept as a provider rather than deleted outright so `color-scheme` is
 * written from one place — native scrollbars and form controls follow it,
 * and something has to set it.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", "dark");
    document.documentElement.style.colorScheme = "dark";
  }, []);

  return <>{children}</>;
}
