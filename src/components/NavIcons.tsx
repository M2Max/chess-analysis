/**
 * Mono SVG icons for the review nav row (history navigation + flip).
 * All use `fill: currentColor` so they inherit the button's text color,
 * including the dimmed `disabled:` state.
 *
 * Paths are Material icons (Apache-2.0): skip_previous, chevron_left,
 * chevron_right, skip_next, undo, swap_vert.
 */

const base = {
  viewBox: "0 0 24 24",
  className: "h-[18px] w-[18px]",
  fill: "currentColor",
  "aria-hidden": true,
} as const;

export function FirstIcon() {
  return (
    <svg {...base}>
      <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
    </svg>
  );
}

export function PrevIcon() {
  return (
    <svg {...base}>
      <path d="M14.12 2.99L13 2 4 11l9 9 1.12-1.01L6.24 11z" />
    </svg>
  );
}

export function NextIcon() {
  return (
    <svg {...base}>
      <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
    </svg>
  );
}

export function LastIcon() {
  return (
    <svg {...base}>
      <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
    </svg>
  );
}

export function BackIcon() {
  return (
    <svg {...base}>
      <path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z" />
    </svg>
  );
}

export function FlipIcon() {
  return (
    <svg {...base}>
      <path d="M16 17.01V10h-2v7.01h-3L15 21l4-3.99h-3zM9 3L5 6.99h3V14h2V6.99h3L9 3z" />
    </svg>
  );
}
