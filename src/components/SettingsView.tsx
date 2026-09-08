import { ENGINE_CONFIG } from "../engine/config";
import { ANALYSIS_MODES, type AnalysisMode, type EngineKind } from "../engine/config";
import { useI18n, type StrKey } from "../i18n";
import type { Settings } from "../settings";

interface Props {
  settings: Settings;
  /** back to the Players grid */
  onBack: () => void;
  onChange: (patch: Partial<Settings>) => void;
  onDemo: () => void;
}

/** engine option copy: titles are proper nouns, descriptions are translated */
const ENGINE_OPTIONS: { kind: EngineKind; title: string; descKey: StrKey }[] = [
  { kind: "lite", title: "Lite", descKey: "engineLiteDesc" },
  { kind: "full", title: "Full", descKey: "engineFullDesc" },
];

/**
 * Pure preferences: engine, analysis depth, threads. The tracked players
 * (and therefore the username) live on the Players grid now.
 */
export function SettingsView({ settings, onBack, onChange, onDemo }: Props) {
  const { t } = useI18n();

  const labelCls = "mb-1 block text-xs font-medium uppercase tracking-wide text-ink-mute";
  const fieldCls =
    "w-full rounded-md border border-line-strong bg-card-solid px-3 py-2 text-sm text-ink placeholder-ink-faint outline-none focus:border-accent";
  const optionCls = (selected: boolean) =>
    `flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 transition ${
      selected ? "border-accent/60 bg-accent-soft" : "border-line-strong bg-card-solid hover:border-ink-faint"
    }`;

  return (
    <div className="mx-auto mt-8 max-w-xl">
      <div className="mb-3">
        <button
          onClick={onBack}
          className="rounded-md px-2 py-1 text-sm text-ink-mute transition hover:bg-btn hover:text-ink-soft"
        >
          {t("backToPlayers")}
        </button>
      </div>
      <div className="rounded-lg bg-card p-8 ring-1 ring-line">
        <h2 className="mb-1 text-lg font-semibold text-ink">{t("settingsTitle")}</h2>
        <p className="mb-5 text-sm text-ink-faint">{t("settingsSubtitle")}</p>

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
                <label key={mode} className={optionCls(settings.analysis === mode)}>
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

        <button
          type="button"
          onClick={onDemo}
          className="rounded-md px-3 py-2 text-sm text-accent transition hover:bg-accent-soft"
          title={t("tryDemoTitle")}
        >
          {t("tryDemo")}
        </button>
      </div>
    </div>
  );
}
