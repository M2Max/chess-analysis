import { symbol, type Category } from "../engine/classify";

/**
 * Renders a move-category symbol.
 *
 * "excellent" (👍) and "opening" (📖) are drawn as inline SVGs, not the emoji
 * characters: the Unicode thumbs-up and book have no reliable monochrome text
 * presentation in browsers (they render as color emoji and ignore CSS color).
 * The SVGs use currentColor, so they are tinted by the same `text-*` class as
 * the other mono glyph symbols (★, ✓, ✕, !, ?, …) and scale with font-size
 * (1em × 1em).
 *
 * Material "thumb_up" path (Apache-2.0) · Feather "book-open" path (MIT).
 */
export function CategorySymbol({
  category,
  className = "",
}: {
  category: Category | null;
  className?: string;
}) {
  if (category === "excellent") {
    return (
      <svg
        viewBox="0 0 24 24"
        className={`inline-block h-[1em] w-[1em] align-[-0.12em] ${className}`}
        fill="currentColor"
        aria-hidden
      >
        <path d="M1 21h4V9H1v12zM23 10c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.58 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z" />
      </svg>
    );
  }
  if (category === "opening") {
    // open book (Feather "book-open", MIT) - monochrome, tinted brown by the
    // surrounding text-amber-* class
    return (
      <svg
        viewBox="0 0 24 24"
        className={`inline-block h-[1em] w-[1em] align-[-0.12em] ${className}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
        <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
      </svg>
    );
  }
  const s = symbol(category);
  return s ? s : null;
}
