/**
 * Move thinking time (seconds spent by the player, from the PGN's
 * [%clk] comments) formatted for the move list / slider card.
 */
export function formatThinkingTime(sec: number | null | undefined): string {
  if (sec == null || sec < 0) return "";
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m${String(s).padStart(2, "0")}s`;
}
