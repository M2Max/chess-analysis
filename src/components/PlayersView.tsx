/**
 * Players grid - the app's home screen: every tracked chess.com account as
 * a card (monogram avatar, nickname + title, per-time-class ratings, time
 * since the last played game, stored-games count). Cards open the game list;
 * players are added/removed here (settings no longer owns the username).
 *
 * Data flow: cards render instantly from our SQLite (GET players), then the
 * server tops up ratings (TTL 10 min) and - per player, sequentially - the
 * games archive, so "last played" is checked every time the page opens.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PlayerNotFoundError,
  addPlayer,
  fetchPlayers,
  removePlayer,
  type PlayerCard,
} from "../api/reviewDb";
import { useI18n } from "../i18n";
import { Spinner } from "./Spinner";

// ---- pure helpers (unit-tested) --------------------------------------------

/**
 * Up to two letters for the monogram avatar: word initials when the name
 * has words ("Mr. Bean" → MB), first two letters for a single word.
 */
export function monogram(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Deterministic hue (0-359) from a username, so each card has its own colour. */
export function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

/** Coarse relative time for "last played", locale-aware, e.g. "3 hours ago". */
export function relativeSince(utcSeconds: number, now: number, locale: string): string {
  const diffSec = Math.round((utcSeconds * 1000 - now) / 1000); // negative = past
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (abs < 60) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(diffSec / 3600), "hour");
  if (abs < 604_800) return rtf.format(Math.round(diffSec / 86_400), "day");
  if (abs < 2_592_000) return rtf.format(Math.round(diffSec / 604_800), "week");
  return rtf.format(Math.round(diffSec / 2_592_000), "month");
}

/** Most recent activity first; never-played (null) last, then alphabetical. */
export function sortPlayers(cards: PlayerCard[]): PlayerCard[] {
  return [...cards].sort((a, b) => {
    if (a.lastGameUtc !== b.lastGameUtc) {
      if (a.lastGameUtc == null) return 1;
      if (b.lastGameUtc == null) return -1;
      return b.lastGameUtc - a.lastGameUtc;
    }
    return a.username.localeCompare(b.username);
  });
}

// ---- component -------------------------------------------------------------

interface Props {
  /** open this player's game list */
  onOpen: (username: string) => void;
  /** legacy single-username install: seed it as a tracked player once */
  legacyUsername?: string;
  /** called after a successful legacy seed (clears it from storage) */
  onLegacySeeded?: () => void;
}

export function PlayersView({ onOpen, legacyUsername, onLegacySeeded }: Props) {
  const { t, locale } = useI18n();
  const [players, setPlayers] = useState<PlayerCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<PlayerCard | null>(null);
  const loadedLegacy = useRef(false);

  const load = useCallback(async (refresh: boolean) => {
    setError(null);
    if (refresh) setRefreshing(true);
    try {
      const list = await fetchPlayers(false);
      setPlayers(list);
      if (refresh) {
        // ratings top-up server-side, then per-player game archives so
        // "last played" is truly current (sequential: polite to the API)
        for (const p of list) {
          try {
            await fetch(`/api/db/players/${encodeURIComponent(p.username)}/games?refresh=1`);
          } catch {
            /* one failure must not stop the rest */
          }
        }
        const fresh = await fetchPlayers(true);
        setPlayers(fresh);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  // one-shot migration: a username configured the old way becomes the first
  // tracked player (silently - if the account vanished, ignore)
  useEffect(() => {
    const legacy = legacyUsername?.trim();
    if (!legacy || loadedLegacy.current || players == null || players.length > 0) return;
    loadedLegacy.current = true;
    void addPlayer(legacy)
      .then(() => {
        onLegacySeeded?.();
        return load(false);
      })
      .catch(() => {});
  }, [players, legacyUsername, load]);

  const sorted = useMemo(() => (players ? sortPlayers(players) : null), [players]);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">{t("playersTitle")}</h2>
          <p className="text-xs text-ink-faint">{t("playersSubtitle")}</p>
        </div>
        <button
          onClick={() => void load(true)}
          disabled={refreshing}
          className="ml-auto flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-ink-mute transition hover:bg-btn hover:text-ink disabled:opacity-50"
          title={t("playersRefresh")}
        >
          {refreshing ? <Spinner className="h-4 w-4" /> : null}
          {t("playersRefresh")}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-500/10 p-3 text-sm text-red-500 ring-1 ring-red-500/30">
          {error}
        </div>
      )}

      {sorted == null ? (
        <div className="flex items-center gap-3 rounded-lg bg-card p-8 text-ink-mute ring-1 ring-line">
          <Spinner className="h-5 w-5" /> {t("playersLoading")}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="players-grid">
          {sorted.map((p) => (
            <PlayerCardTile
              key={p.username}
              player={p}
              now={Date.now()}
              locale={locale}
              onOpen={() => onOpen(p.username)}
              onRemove={() => setRemoveTarget(p)}
            />
          ))}
          <button
            onClick={() => setAddOpen(true)}
            className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line text-ink-mute transition hover:border-accent hover:text-accent"
            aria-label={t("addPlayer")}
          >
            <span className="text-3xl leading-none">+</span>
            <span className="text-sm font-medium">{t("addPlayer")}</span>
          </button>
        </div>
      )}

      {sorted != null && sorted.length === 0 && (
        <p className="mt-4 text-center text-sm text-ink-mute">{t("playersEmpty")}</p>
      )}

      {addOpen && (
        <AddPlayerModal
          onClose={() => setAddOpen(false)}
          onAdded={() => {
            setAddOpen(false);
            void load(false);
          }}
        />
      )}

      {removeTarget && (
        <RemovePlayerModal
          player={removeTarget}
          onClose={() => setRemoveTarget(null)}
          onRemoved={() => {
            setRemoveTarget(null);
            setPlayers((prev) => (prev ? prev.filter((p) => p.username !== removeTarget.username) : prev));
          }}
        />
      )}
    </div>
  );
}

// ---- card ------------------------------------------------------------------

function PlayerCardTile({
  player: p,
  now,
  locale,
  onOpen,
  onRemove,
}: {
  player: PlayerCard;
  now: number;
  locale: string;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const hue = hueOf(p.username);
  const lastPlayed =
    p.lastGameUtc != null ? relativeSince(p.lastGameUtc, now, locale) : t("lastPlayedNever");
  const rating = (v: number | undefined) => (v != null ? String(v) : "–");

  return (
    <div className="group relative">
      <button
        onClick={onOpen}
        className="flex h-full w-full flex-col gap-3 rounded-xl bg-card p-4 text-left ring-1 ring-line transition hover:ring-accent/60"
      >
        <div className="flex items-center gap-3">
          <span
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-lg font-bold text-white"
            style={{ backgroundColor: `hsl(${hue} 55% 45%)` }}
            aria-hidden
          >
            {monogram(p.username)}
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              {p.title && (
                <span className="rounded bg-amber-500/20 px-1 text-[10px] font-bold text-amber-500">
                  {p.title}
                </span>
              )}
              <span className="truncate text-sm font-semibold text-ink">{p.username}</span>
            </span>
            <span className="mt-0.5 block truncate text-xs text-ink-faint" title={t("lastPlayed")}>
              {lastPlayed}
            </span>
          </span>
        </div>

        <div className="grid grid-cols-4 gap-1 text-center text-xs">
          {(
            [
              ["Blitz", rating(p.ratings.blitz)],
              ["Rapid", rating(p.ratings.rapid)],
              ["Classical", rating(p.ratings.classical)],
              ["Puzzles", rating(p.ratings.puzzles)],
            ] as const
          ).map(([label, value]) => (
            <span key={label} className="rounded-md bg-app px-1 py-1.5">
              <span className="block text-[9px] uppercase tracking-wide text-ink-faint">{label}</span>
              <span className="block font-semibold tabular-nums text-ink-soft">{value}</span>
            </span>
          ))}
        </div>

        <div className="mt-auto flex items-center justify-between text-[11px] text-ink-faint">
          <span>
            {t("playerGamesCount", { n: p.games })}
            {p.analyzed > 0 && ` · ${t("playerAnalyzedCount", { n: p.analyzed })}`}
          </span>
          <span className="text-accent opacity-0 transition group-hover:opacity-100">
            {t("playerOpen")} →
          </span>
        </div>
      </button>

      <button
        onClick={onRemove}
        aria-label={t("removePlayer")}
        title={t("removePlayer")}
        className="absolute right-2 top-2 rounded-md p-1 text-ink-faint opacity-0 transition hover:bg-btn hover:text-red-500 focus:opacity-100 group-hover:opacity-100"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M3 6h18" />
          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
          <line x1="10" y1="11" x2="10" y2="17" />
          <line x1="14" y1="11" x2="14" y2="17" />
        </svg>
      </button>
    </div>
  );
}

// ---- modals ----------------------------------------------------------------

function ModalShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl bg-card-solid p-5 shadow-2xl ring-1 ring-line-strong">
        {children}
      </div>
    </div>
  );
}

function AddPlayerModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const submit = async () => {
    const u = value.trim().replace(/^@/, "");
    if (!u || busy) return;
    setBusy(true);
    setError(null);
    try {
      await addPlayer(u);
      onAdded();
    } catch (e) {
      setError(
        e instanceof PlayerNotFoundError
          ? t("errorPlayerNotFound")
          : e instanceof Error && e.message === "invalid-username"
            ? t("errorInvalidUsername")
            : e instanceof Error
              ? e.message
              : String(e),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <h3 className="mb-1 text-base font-semibold text-ink">{t("addPlayerTitle")}</h3>
      <p className="mb-4 text-xs text-ink-faint">{t("addPlayerHint")}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("usernamePlaceholder")}
          autoComplete="off"
          spellCheck={false}
          maxLength={25}
          className="w-full rounded-md bg-app px-3 py-2 text-sm text-ink ring-1 ring-line outline-none transition focus:ring-accent"
        />
        {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-ink-mute transition hover:bg-btn"
          >
            {t("cancel")}
          </button>
          <button
            type="submit"
            disabled={busy || value.trim().length === 0}
            className="rounded-md bg-accent-strong px-4 py-1.5 text-sm font-medium text-white transition hover:bg-accent-strong-hover disabled:opacity-50"
          >
            {t("addPlayerBtn")}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function RemovePlayerModal({
  player,
  onClose,
  onRemoved,
}: {
  player: PlayerCard;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await removePlayer(player.username);
      onRemoved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <h3 className="mb-1 text-base font-semibold text-red-500">{t("removePlayerTitle")}</h3>
      <p className="text-sm text-ink-soft">
        {t("removeConfirmBody", {
          username: player.username,
          games: player.games,
          analyses: player.analyzed,
        })}
      </p>
      <p className="mt-2 text-xs text-ink-faint">{t("removeConfirmHint")}</p>
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={onClose}
          disabled={busy}
          className="rounded-md px-3 py-1.5 text-sm text-ink-mute transition hover:bg-btn"
        >
          {t("cancel")}
        </button>
        <button
          onClick={() => void confirm()}
          disabled={busy}
          className="flex items-center gap-2 rounded-md bg-red-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
        >
          {busy && <Spinner className="h-4 w-4" />}
          {t("removePlayerBtn")}
        </button>
      </div>
    </ModalShell>
  );
}
