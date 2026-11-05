// Zero Electron imports, deliberately (U-01): this package must stay
// renderable in a plain browser so the web-later option stays open.
//
// What the chat layout takes from the design system: the content
// renderer, the theme's provider and its tokens (`styles.css`). Its
// controls are its own (`apps/desktop/src/renderer/src/chat/kit/`), and a
// renderer test refuses any other name from here (EO-529).
export { cn } from "./cn.js";
export { COLLAPSE_ABOVE_PX, COLLAPSED_HEIGHT_PX, CollapsibleMarkdown, type CollapsibleMarkdownProps } from "./components/CollapsibleMarkdown.js";
export {
  Markdown,
  MarkdownItemReferenceProvider,
  createItemReferenceMatcher,
  splitItemReferenceText,
  type MarkdownProps,
  type MarkdownItemReferenceProviderProps,
  type MarkdownItemReferenceRenderer,
  type ItemReferenceTextPart,
  type ItemReferenceMatcher,
} from "./components/Markdown.js";
export { ThemeProvider } from "./components/ThemeProvider.js";
export type { StatusTone } from "./tone.js";
