/**
 * Text compared without regard to case, in every script rather than in
 * ASCII alone (EO-539).
 *
 * SQLite's own `lower()` and `like` fold only the 26 ASCII letters, so a
 * title "Échec de l'import" did not match a search for "échec" — the
 * filter quietly answered nothing for anyone not writing English. This is
 * the one definition of "the same letters", read by JavaScript and
 * registered on the connection as a SQL function (client.ts), so a filter
 * applied in the query and one applied anywhere else cannot disagree.
 *
 * Normalised first (NFKC), so a letter typed precomposed and one typed as
 * a base letter and an accent are one letter. Then upper-cased and
 * lower-cased again, which is the nearest JavaScript has to Unicode case
 * folding: "ß" and "SS" both come out "ss", and a final sigma "ς" is the
 * same letter as "σ".
 */
export function foldCase(value: string): string {
  return value.normalize("NFKC").toUpperCase().toLowerCase();
}

/** The name `foldCase` is registered under on every connection `openDb` opens. */
export const FOLD_CASE_SQL_FUNCTION = "eo_fold_case";
