import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The renderer has one layout, the chat layout (EO-529), and this keeps
 * the classic one from coming back.
 *
 * The classic layout was a folder per feature beside `chat/` — its top
 * bar and sidebar, its screens, its floating assistant — drawn with the
 * design system's controls (`Button`, `Panel`, `Tabs`…) from `@eo/ui`.
 * Both are refused here: a classic folder by its name, wherever under the
 * renderer's root it reappears, and a control by any renderer file
 * taking it from `@eo/ui`, or by `@eo/ui` exporting it again. What the
 * chat layout draws with is its own kit (`chat/kit/`); what it takes
 * from the design system is the content renderer, the theme's provider
 * and a type, and nothing else.
 *
 * Replaces EO-519's `chat/noClassicUi.test.ts`, which kept the chat
 * layout apart from a classic layout that no longer exists.
 */

const RENDERER = dirname(fileURLToPath(import.meta.url));
const UI_INDEX = resolve(RENDERER, "../../../../../packages/ui/src/index.ts");

/** The classic layout's folders, as they sat under the renderer's root. */
const CLASSIC = [
  "layout",
  "routes",
  "settings",
  "agents",
  "agentTools",
  "pipeline",
  "item",
  "items",
  "jobs",
  "discussions",
  "inbox",
  "gallery",
  "admin",
  "modules",
  "managed",
  "connectors",
  "itemTypes",
  "transcript",
  "attachments",
  "assist",
  "license",
  "firstRun",
  "invitations",
  "view",
];

/**
 * Everything the renderer may take from `@eo/ui`: the content renderer
 * and its helpers, the theme's provider, and the status-tone type the
 * views name their state colours by. Never a control.
 *
 * `COLLAPSED_HEIGHT_PX` is how a test knows where `CollapsibleMarkdown`
 * clips; `COLLAPSE_ABOVE_PX` is its other half.
 */
const FROM_EO_UI = new Set([
  "cn",
  "Markdown",
  "MarkdownItemReferenceProvider",
  "createItemReferenceMatcher",
  "splitItemReferenceText",
  "CollapsibleMarkdown",
  "COLLAPSE_ABOVE_PX",
  "COLLAPSED_HEIGHT_PX",
  "ThemeProvider",
  "StatusTone",
  // The props and part types of the components above.
  "MarkdownProps",
  "MarkdownItemReferenceProviderProps",
  "MarkdownItemReferenceRenderer",
  "ItemReferenceTextPart",
  "ItemReferenceMatcher",
  "CollapsibleMarkdownProps",
]);

/** Every TypeScript file under `dir`, tests included: a test drawing a classic control is a classic control drawn. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

interface Import {
  /** The names taken, values and types alike, by the name they are exported under; `*` for the whole module. */
  names: string[];
  from: string;
}

/**
 * Every module a file takes from, read by the TypeScript parser rather
 * than a pattern: static imports and re-exports in every form, type-only
 * ones included, dynamic `import()` and a type written as `import("…")`.
 */
export function importsOf(file: string, source: string): Import[] {
  const found: Import[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const names: string[] = [];
      const clause = node.importClause;
      if (clause?.name) names.push("default");
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.push("*");
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) names.push((element.propertyName ?? element.name).text);
      found.push({ names, from: node.moduleSpecifier.text });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const names: string[] = [];
      if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) names.push("*");
      else for (const element of node.exportClause.elements) names.push((element.propertyName ?? element.name).text);
      found.push({ names, from: node.moduleSpecifier.text });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments;
      if (specifier && ts.isStringLiteralLike(specifier)) found.push({ names: ["*"], from: specifier.text });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      found.push({ names: [node.qualifier ? (ts.isIdentifier(node.qualifier) ? node.qualifier.text : node.qualifier.right.text) : "*"], from: node.argument.literal.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file, source));
  return found;
}

/** The names a module exports, as `export … from` and `export type … from` declare them. */
function exportedNames(file: string, source: string): string[] {
  return parse(file, source)
    .statements.filter(ts.isExportDeclaration)
    .flatMap((declaration) => {
      if (!declaration.exportClause || ts.isNamespaceExport(declaration.exportClause)) return ["*"];
      return declaration.exportClause.elements.map((element) => element.name.text);
    });
}

/** The classic folder a relative specifier in `file` reaches at the renderer's root, or null. */
function classicFolderOf(file: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const target = relative(RENDERER, resolve(dirname(file), specifier));
  if (target.startsWith("..")) return null;
  const folder = target.split(/[\\/]/)[0]!;
  return CLASSIC.includes(folder) ? folder : null;
}

/** What `@eo/ui` gives `file` that is not on the list. */
function controlsTaken(file: string, source: string): string[] {
  return importsOf(file, source)
    .filter(({ from }) => from === "@eo/ui")
    .flatMap(({ names }) => names.filter((name) => !FROM_EO_UI.has(name)));
}

describe("the renderer has one layout", () => {
  it("has none of the classic layout's folders", () => {
    expect(CLASSIC.filter((folder) => existsSync(join(RENDERER, folder)))).toEqual([]);
  });

  it("reaches into no classic folder from anywhere", () => {
    const offences: string[] = [];
    for (const file of sources(RENDERER)) {
      for (const { from } of importsOf(file, readFileSync(file, "utf8"))) {
        if (classicFolderOf(file, from) !== null) offences.push(`${relative(RENDERER, file)}: ${from}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it("takes none of the design system's controls, in any file", () => {
    const offences: string[] = [];
    for (const file of sources(RENDERER)) {
      for (const name of controlsTaken(file, readFileSync(file, "utf8"))) offences.push(`${relative(RENDERER, file)}: ${name} from @eo/ui`);
    }
    expect(offences).toEqual([]);
  });

  it("is given none by the design system's package either", () => {
    const exported = exportedNames(UI_INDEX, readFileSync(UI_INDEX, "utf8"));
    expect(exported.length).toBeGreaterThan(0);
    expect(exported.filter((name) => !FROM_EO_UI.has(name))).toEqual([]);
  });
});

describe("the guard sees what it claims to", () => {
  it("sees every way a module can be taken, types included", () => {
    const source = [
      'import * as Classic from "../item/Composer";',
      'export * from "../settings/primitives";',
      'export * as Again from "../settings/primitives";',
      'import Default from "../layout/AppShell";',
      'const Lazy = lazy(() => import("../settings/Settings"));',
      'import type { Hidden } from "../layout/TopBar";',
      'import { type AlsoHidden, Shown } from "../layout/Sidebar";',
      'let row: import("../transcript/Transcript").Props;',
      'import { fine } from "./query/hooks";',
    ].join("\n");
    expect(importsOf("probe.tsx", source)).toEqual([
      { names: ["*"], from: "../item/Composer" },
      { names: ["*"], from: "../settings/primitives" },
      { names: ["*"], from: "../settings/primitives" },
      { names: ["default"], from: "../layout/AppShell" },
      { names: ["*"], from: "../settings/Settings" },
      { names: ["Hidden"], from: "../layout/TopBar" },
      { names: ["AlsoHidden", "Shown"], from: "../layout/Sidebar" },
      { names: ["Props"], from: "../transcript/Transcript" },
      { names: ["fine"], from: "./query/hooks" },
    ]);
  });

  it("finds a classic folder however deep the file reaching for it is", () => {
    const deep = join(RENDERER, "chat", "views", "board", "probe.tsx");
    expect(classicFolderOf(deep, "../../../layout/Sidebar")).toBe("layout");
    expect(classicFolderOf(deep, "../../../assist/AssistWidget")).toBe("assist");
    // The chat layout's own folders of the same name are not the classic ones.
    expect(classicFolderOf(deep, "../items/ItemReference")).toBeNull();
    expect(classicFolderOf(deep, "../../admin/ReadOnlyFence")).toBeNull();
    expect(classicFolderOf(deep, "../../../shared/view/ViewPublisher")).toBeNull();
    expect(classicFolderOf(join(RENDERER, "App.tsx"), "./settings/Settings")).toBe("settings");
  });

  it("refuses a control, a type-only one too, and lets the renderer through", () => {
    const source = [
      'import { Button, cn } from "@eo/ui";',
      'import type { StatusTone, TabDef } from "@eo/ui";',
      'export { Panel } from "@eo/ui";',
      'import { Markdown, ThemeProvider } from "@eo/ui";',
    ].join("\n");
    expect(controlsTaken("probe.tsx", source)).toEqual(["Button", "TabDef", "Panel"]);
  });
});
