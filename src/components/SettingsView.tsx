import { useEffect, useState, type FormEvent } from "react";
import { ENGINE_CONFIG } from "../engine/config";
import { ANALYSIS_MODES, type AnalysisMode, type EngineKind } from "../engine/config";
import { useI18n, type StrKey } from "../i18n";
import type { Settings } from "../settings";
import { Spinner } from "./Spinner";

interface Props {
  settings: Settings;
  busy: boolean;
  error: string | null;
  /** show "← Games" when a (cached) list exists or a username is saved */
  canGoToGames: boolean;
  onBack: () => void;
  onChange: (patch: Partial<Settings>) => void;
  onRetrieve: (username: string) => void;
  onDemo: () => void;
}

/** engine option copy: titles are proper nouns, descriptions are translated */
const ENGINE_OPTIONS: { kind: EngineKind; title: string; descKey: StrKey }[] = [
  { kind: "lite", title: "Lite", descKey: "engineLiteDesc" },
  { kind: "full", title: "Full", descKey: "engineFullDesc" },
];

export function SettingsView({
  settings,
  busy,
  error,
  canGoToGames,
  onBack,
  onChange,
  onRetrieve,
  onDemo,
}: Props) {
  const { t } = useI18n();
  const [username, setUsername] = useState(settings.username);

  // re-sync if settings change elsewhere (e.g. warm-up)
  useEffect(() => setUsername(settings.username), [settings.username]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const u = username.trim();
    onChange({ username: u });
    if (u && !busy) onRetrieve(u);
  };

  const labelCls = "mb-1 block text-xs font-medium uppercase tracking-wide text-ink-mute";
  const fieldCls =
    "w-full rounded-md border border-line-strong bg-card-solid px-3 py-2 text-sm text-ink placeholder-ink-faint outline-none focus:border-accent";
  const optionCls = (selected: boolean) =>
    `flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 transition ${
      selected ? "border-accent/60 bg-accent-soft" : "border-line-strong bg-card-solid hover:border-ink-faint"
    }`;

  return (
    <div className="mx-auto mt-16 max-w-xl">
      <div className="mb-3 flex items-center gap-3">
        {canGoToGames && (
          <button
            onClick={onBack}
            className="rounded-md px-2 py-1 text-sm text-ink-mute transition hover:bg-btn hover:text-ink-soft"
          >
            {t("backToGames")}
          </button>
        )}
      </div>
      <div className="rounded-lg bg-card p-8 ring-1 ring-line">
        <h2 className="mb-1 text-lg font-semibold text-ink">{t("settingsTitle")}</h2>
        <p className="mb-5 text-sm text-ink-faint">{t("settingsSubtitle")}</p>

        <form onSubmit={submit}>
          <label className="mb-5 block">
            <span className={labelCls}>{t("usernameLabel")}</span>
            <input
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                onChange({ username: e.target.value.trim() });
              }}
              placeholder={t("usernamePlaceholder")}
              autoComplete="off"
              spellCheck={false}
              className={fieldCls}
            />
          </label>

          <fieldset className="mb-6">
            <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-mute">
              {t("engineLabel")}
            </legend>
            <div className="space-y-2">
              {ENGINE_OPTIONS.map((opt) => (
                <label key={opt.kind} className={optionCls(settings.engine === opt.kind)}>
                  <input
                    type="radio"
                    name="engine"
                    value={opt.kind}
                    checked={settings.engine === opt.kind}
                    onChange={() => onChange({ engine: opt.kind })}
                    className="accent-emerald-500"
                  />
                  <span className="text-sm font-medium text-ink-soft">{opt.title}</span>
                  <span className="text-xs text-ink-faint">{t(opt.descKey)}</span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-ink-faint">{t("engineNote")}</p>
          </fieldset>

          <fieldset className="mb-6">
            <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-mute">
              {t("analysisLabel")}
            </legend>
            <div className="space-y-2">
              {(Object.keys(ANALYSIS_MODES) as AnalysisMode[]).map((mode) => {
                const m = ANALYSIS_MODES[mode];
                return (
                  <label
                    key={mode}
                    className={optionCls(settings.analysis === mode)}
                  >
                    <input
                      type="radio"
                      name="analysis"
                      value={mode}
                      checked={settings.analysis === mode}
                      onChange={() => onChange({ analysis: mode })}
                      className="accent-emerald-500"
                    />
                    <span className="text-sm font-medium text-ink-soft">
                      {t(mode === "fast" ? "analysisFastLabel" : "analysisDeepLabel")} (~
                      {m.estElo[settings.engine]} Elo)
                    </span>
                    <span className="text-xs text-ink-faint">
                      {t(mode === "fast" ? "analysisFastDesc" : "analysisDeepDesc")}
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-ink-faint">{t("analysisNote")}</p>
          </fieldset>

          <div className="mb-6">
            <label className="block">
              <span className={labelCls}>{t("threadsLabel")}</span>
              <select
                value={String(settings.threads)}
                onChange={(e) => onChange({ threads: Number(e.target.value) })}
                className={fieldCls}
              >
                <option value="0">{t("threadsAuto")}</option>
                {[1, 2, 4, ENGINE_CONFIG.maxThreads].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-2 text-xs text-ink-faint">
              {typeof crossOriginIsolated !== "undefined" && crossOriginIsolated
                ? t("threadsMulti")
                : t("threadsSingle")}
            </p>
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || !username.trim()}
              className="flex items-center gap-2 rounded-md bg-accent-strong px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-strong-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy && <Spinner className="h-3.5 w-3.5" />}
              {busy ? t("fetching") : t("retrieve")}
            </button>
            <button
              type="button"
              onClick={onDemo}
              className="rounded-md px-3 py-2 text-sm text-accent transition hover:bg-accent-soft"
              title={t("tryDemoTitle")}
            >
              {t("tryDemo")}
            </button>
          </div>

          {error && (
            <div className="mt-4 rounded-md border border-red-500/40 bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
