// Evolution (RSI) & strict-local Intention Pulse view (pure CSP/XSS-safe DOM).
import { UI_CLASSES as C } from "./contracts.js";
import { h, setChildren } from "./dom.js";

function cls(...names) {
  return names.filter(Boolean).join(" ");
}

function fmtPct(val) {
  if (typeof val !== "number" || !Number.isFinite(val)) return "—";
  const clamped = Math.max(0, Math.min(100, val));
  return Number.isInteger(clamped) ? `${clamped}%` : `${clamped.toFixed(1)}%`;
}

function fmtInt(n) {
  if (n === null || n === undefined || n === "" || !Number.isFinite(Number(n))) return "0";
  return String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtTokens(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return "0 tokens";
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M tokens`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k tokens`;
  return `${Math.round(num)} tokens`;
}

function fmtQuietDuration(hours) {
  const hNum = Number(hours);
  if (!Number.isFinite(hNum) || hNum < 0) return "Paused";
  if (hNum >= 48) return `Paused ${Math.round(hNum / 24)}d`;
  return `Paused ${Math.round(hNum)}h`;
}

function fmtDateTag(iso) {
  const s = String(iso || "").trim();
  if (!s) return "";
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function meterBar(pct, label) {
  const valid = typeof pct === "number" && Number.isFinite(pct);
  const clamped = valid ? Math.max(0, Math.min(100, pct)) : 0;
  const q = Math.round(clamped / 5) * 5;
  return h(
    "div",
    {
      className: C.meterTrack,
      role: "progressbar",
      "aria-label": label,
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": String(Math.round(clamped)),
    },
    h("div", { className: `${C.meterFill} is-q-${q}` }),
  );
}

function candidateTierMeta(tier) {
  if (tier === "self_sandbox") return { label: "Auto-tested sandbox", tone: "is-pass" };
  return { label: "Needs your OK", tone: "is-warn" };
}

function candidateStatusMeta(status) {
  switch (String(status || "").toLowerCase()) {
    case "evaluated":
      return { label: "Tested", tone: "is-accent" };
    case "evaluated_pending_audit":
      return { label: "Pending audit", tone: "is-warn" };
    case "audited":
      return { label: "Reviewed", tone: "is-accent" };
    case "promoted":
      return { label: "Applied", tone: "is-pass" };
    case "rejected":
      return { label: "Blocked", tone: "is-fail" };
    case "rolled_back":
      return { label: "Undone", tone: "is-warn" };
    default:
      return { label: "Proposed", tone: "" };
  }
}

function formatScoreDelta(cand) {
  const base = cand?.baselineScore;
  const next = cand?.candidateScore;
  const regs = Number.isInteger(cand?.regressions) ? cand.regressions : 0;
  if (typeof next === "number" && Number.isFinite(next) && typeof base === "number" && Number.isFinite(base)) {
    const raw = next - base;
    const delta = Number.isInteger(raw) ? raw : Number(raw.toFixed(1));
    const sign = delta >= 0 ? "+" : "";
    return `${base} → ${next} (${sign}${delta} pts · ${regs} regression${regs === 1 ? "" : "s"})`;
  }
  if (typeof base === "number" && Number.isFinite(base)) {
    return `Baseline ${base} · Not tested yet`;
  }
  return "Not tested yet";
}

function renderStatCard({ title, value, subtitle, pct, meterLabel, extra = null }) {
  return h(
    "article",
    { className: "od-rsi-stat" },
    h("div", { className: "od-rsi-stat-label" }, title),
    h("div", { className: `od-rsi-stat-val ${C.tabular}` }, value),
    meterBar(pct, meterLabel || title),
    h("div", { className: "od-rsi-stat-sub" }, subtitle),
    extra,
  );
}

function humanizeKind(raw) {
  return String(raw || "").replaceAll("_", " ").trim();
}

function renderFocusSection(digest) {
  const focus = Array.isArray(digest?.activeFocus) ? digest.activeFocus : [];
  const quiet = Array.isArray(digest?.wentQuietQuestions) ? digest.wentQuietQuestions : [];
  const friction = Array.isArray(digest?.frictionHotspots) ? digest.frictionHotspots : [];
  const drift = Array.isArray(digest?.driftAlerts) ? digest.driftAlerts : [];

  const focusList = focus.length
    ? h(
        "ul",
        { className: "od-rsi-list", "data-rsi-focus-list": "" },
        focus.map((item) => {
          const tok = item.totalTokens ?? item.outTokens;
          return h(
            "li",
            { className: "od-rsi-focus-item" },
            h(
              "div",
              { className: "od-rsi-item-head" },
              h("strong", null, String(item.project || "Unnamed project")),
              item.category ? h("span", { className: C.badge }, String(item.category)) : null,
            ),
            h(
              "div",
              { className: `od-rsi-item-meta ${C.tabular}` },
              h("span", null, `${fmtInt(item.sessions)} session${Number(item.sessions) === 1 ? "" : "s"}`),
              tok !== undefined ? h("span", null, fmtTokens(tok)) : null,
              item.lastActiveAt ? h("span", null, fmtDateTag(item.lastActiveAt)) : null,
            ),
          );
        }),
      )
    : h(
        "p",
        { className: C.muted },
        Number(digest?.totalSessions) > 0
          ? "No sessions recorded in the last 72h window across indexed local harnesses."
          : "Click Scan sessions to build a strict-local digest of recent projects.",
      );

  const quietBox = h(
    "div",
    { className: "od-rsi-callout", "data-rsi-quiet-callout": "" },
    h("h4", { className: "od-rsi-callout-title" }, "Questions on paused projects"),
    h(
      "p",
      { className: "od-rsi-callout-note" },
      "Overdrive asks first and never restarts paused work automatically.",
    ),
    quiet.length
      ? h(
          "ul",
          { className: "od-rsi-list", "data-rsi-quiet-list": "" },
          quiet.map((q) =>
            h(
              "li",
              { className: "od-rsi-quiet-item", "data-auto-dispatch": String(q.autoDispatch === true) },
              h(
                "div",
                { className: "od-rsi-item-head" },
                q.project ? h("strong", null, String(q.project)) : null,
                h("span", { className: `${C.badge} is-warn ${C.tabular}` }, fmtQuietDuration(q.quietHours)),
              ),
              h("p", { className: "od-rsi-question-text" }, String(q.question || "")),
            ),
          ),
        )
      : h("p", { className: C.muted }, "No paused projects need your input right now."),
  );

  const frictionBlock = friction.length
    ? h(
        "div",
        { className: "od-rsi-subblock" },
        h("h4", { className: "od-rsi-subhead" }, "Friction hotspots"),
        h(
          "ul",
          { className: "od-rsi-list", "data-rsi-friction-list": "" },
          friction.map((f) => {
            const rawKind = String(f.kind || f.source || "");
            const kindText = humanizeKind(rawKind);
            const labelText = f.label && String(f.label) !== rawKind ? String(f.label) : "";
            const summaryText = String(f.detail || f.summary || f.label || "");
            return h(
              "li",
              { className: "od-rsi-compact-row" },
              h(
                "div",
                { className: "od-rsi-item-head" },
                labelText ? h("strong", null, labelText) : null,
                kindText ? h("span", { className: C.badge }, kindText) : null,
                f.count !== undefined ? h("span", { className: `${C.badge} is-warn ${C.tabular}` }, `${fmtInt(f.count)}×`) : null,
              ),
              h("div", { className: "od-rsi-row-text" }, summaryText),
            );
          }),
        ),
      )
    : null;

  const driftBlock = drift.length
    ? h(
        "div",
        { className: "od-rsi-subblock" },
        h("h4", { className: "od-rsi-subhead" }, "App & setup drift"),
        h(
          "ul",
          { className: "od-rsi-list", "data-rsi-drift-list": "" },
          drift.map((d) => {
            const rawSev = String(d.severity || d.status || "").toLowerCase();
            const tone = ["ok", "synced", "clean", "pass"].includes(rawSev)
              ? "is-pass"
              : ["fail", "error", "drifted", "blocked"].includes(rawSev)
                ? "is-fail"
                : rawSev === "info"
                  ? ""
                  : "is-warn";
            const headLabel = String(d.source || d.harness || "");
            const msgText = String(d.message || d.summary || "");
            return h(
              "li",
              { className: "od-rsi-compact-row" },
              h(
                "div",
                { className: "od-rsi-item-head" },
                headLabel ? h("strong", null, headLabel) : null,
                rawSev ? h("span", { className: cls(C.badge, tone) }, rawSev) : null,
              ),
              h("div", { className: "od-rsi-row-text" }, msgText),
            );
          }),
        ),
      )
    : null;

  return h(
    "section",
    { className: "od-glass-inset od-rsi-col", "aria-label": "What you've been focused on" },
    h(
      "div",
      { className: "od-card-head" },
      h("h3", null, "What you've been focused on"),
      h("span", { className: `${C.badge} ${C.tabular}` }, `${focus.length} active`),
    ),
    focusList,
    quietBox,
    frictionBlock,
    driftBlock,
  );
}

function renderCandidateCard(c, { loading, onCycle, onArmPromote, onArmRollback }) {
  const tier = candidateTierMeta(c.tier);
  const st = candidateStatusMeta(c.status);
  const isPromoted = c.status === "promoted";
  const isRejected = c.status === "rejected";
  const blockedByPolicy = c.touchesHarness === true || (c.regressions ?? 0) > 0;
  const refs = Array.isArray(c.evidenceRefs) ? c.evidenceRefs : [];

  const isLocalOnlyAudit = Boolean(
    c.audit && (c.audit.modelExecuted === false || c.audit.auditKind === "deterministic_local_gate"),
  );
  const auditNote = c.audit
    ? h(
        "div",
        { className: "od-rsi-audit-line" },
        h(
          "span",
          {
            className: `${C.badge} ${
              isLocalOnlyAudit ? "is-warn" : c.audit.verdict === "approve" ? "is-pass" : "is-fail"
            }`,
          },
          isLocalOnlyAudit
            ? "Local checks only · No model audit"
            : c.audit.verdict === "approve"
              ? "Cross-family approved"
              : "Cross-family rejected",
        ),
        isLocalOnlyAudit && (c.audit.recommendedAuditorModel || c.audit.recommendedAuditorFamily)
          ? h("span", { className: C.muted }, `Awaiting: ${c.audit.recommendedAuditorModel || c.audit.recommendedAuditorFamily}`)
          : c.audit.auditorModel || c.audit.auditorFamily
            ? h("span", { className: C.muted }, `Reviewer: ${c.audit.auditorModel || c.audit.auditorFamily}`)
            : null,
        c.metadata?.mergeState
          ? h(
              "span",
              { className: `${C.badge} ${c.metadata.mergeState === "merged_ff_only" ? "is-pass" : ""}` },
              c.metadata.mergeState === "merged_ff_only" ? "Merged (ff-only)" : "Approved (no git merge)",
            )
          : null,
      )
    : null;

  const actionsRow = h(
    "div",
    { className: "od-btn-row od-rsi-card-actions" },
    h(
      "button",
      {
        type: "button",
        className: `${C.btn} ${C.btnGhost} od-btn-xs`,
        "data-action": "rsi-cycle",
        "data-candidate-id": String(c.id || ""),
        disabled: Boolean(loading || isPromoted),
        onclick: () => onCycle?.(c.id),
      },
      "Test upgrade",
    ),
    isPromoted
      ? h(
          "button",
          {
            type: "button",
            className: `${C.btn} ${C.btnDanger} od-btn-xs`,
            "data-action": "rsi-rollback",
            "data-candidate-id": String(c.id || ""),
            disabled: Boolean(loading),
            onclick: () => onArmRollback?.(c),
          },
          "Undo",
        )
      : !isRejected
        ? h(
            "button",
            {
              type: "button",
              className: `${C.btn} ${C.btnPrimary} od-btn-xs`,
              "data-action": "rsi-promote",
              "data-candidate-id": String(c.id || ""),
              disabled: Boolean(loading || blockedByPolicy || c.status !== "audited"),
              onclick: () => onArmPromote?.(c),
            },
            "Apply upgrade",
          )
        : null,
  );

  return h(
    "article",
    {
      className: cls(C.rsiCard, isPromoted && "is-promoted", isRejected && "is-rejected"),
      "data-candidate-id": String(c.id || ""),
      "data-tier": String(c.tier || ""),
      "data-status": String(c.status || ""),
    },
    h(
      "div",
      { className: "od-rsi-card-head" },
      h("strong", { className: "od-rsi-card-title" }, String(c.title || c.id || "Upgrade proposal")),
      h(
        "div",
        { className: "od-rsi-card-badges" },
        h("span", { className: `${C.badge} ${tier.tone}`, "data-tier-badge": "" }, tier.label),
        h("span", { className: `${C.badge} ${st.tone}`, "data-status-badge": "" }, st.label),
      ),
    ),
    h("p", { className: "od-rsi-card-rationale" }, String(c.rationale || "")),
    h(
      "div",
      { className: `od-rsi-score-line ${C.tabular}` },
      h("span", { className: "od-rsi-score-delta" }, formatScoreDelta(c)),
      c.category ? h("span", { className: C.badge }, String(c.category)) : null,
      c.targetRepo ? h("span", { className: `${C.badge} ${C.mono}` }, String(c.targetRepo)) : null,
    ),
    c.touchesHarness
      ? h("div", { className: `${C.badge} is-fail` }, "Blocked: touches evaluator harness")
      : null,
    auditNote,
    refs.length
      ? h(
          "div",
          { className: "od-rsi-refs" },
          refs.slice(0, 4).map((ref) => h("span", { className: `${C.badge} ${C.mono}` }, String(ref))),
        )
      : null,
    actionsRow,
  );
}

function renderCandidatesSection(candidates, opts) {
  const list = Array.isArray(candidates) ? candidates : [];
  return h(
    "section",
    { className: "od-glass-inset od-rsi-col", "aria-label": "Self-upgrade queue" },
    h(
      "div",
      { className: "od-card-head" },
      h("h3", null, "Self-upgrade queue"),
      h("span", { className: `${C.badge} ${C.tabular}` }, `${list.length} item${list.length === 1 ? "" : "s"}`),
    ),
    list.length
      ? h(
          "div",
          { className: "od-rsi-queue", "data-rsi-queue": "" },
          list.map((c) => renderCandidateCard(c, opts)),
        )
      : h("p", { className: C.muted }, "No self-upgrade candidates queued yet. Scan sessions or run a benchmark to discover safe improvements."),
  );
}

/** Render the Evolution & daily self-tuning view into `container`. */
export function renderRsiView({
  container,
  rsi = {},
  onScan = null,
  onRunBenchmark = null,
  onCycle = null,
  onArmPromote = null,
  onArmRollback = null,
} = {}) {
  if (!container) return;

  const loading = Boolean(rsi?.loading);
  const error = rsi?.error ? String(rsi.error) : null;
  const overview = rsi?.overview || null;
  const digest = overview?.digest || null;
  const benchmark = overview?.benchmark || null;
  const candidates = Array.isArray(overview?.candidates) ? overview.candidates : [];

  const benchScoreText =
    benchmark && typeof benchmark.score === "number" && typeof benchmark.maxScore === "number"
      ? `${benchmark.score} / ${benchmark.maxScore}`
      : "—";
  const benchPct =
    benchmark && typeof benchmark.score === "number" && typeof benchmark.maxScore === "number" && benchmark.maxScore > 0
      ? (benchmark.score / benchmark.maxScore) * 100
      : null;

  const dims = Array.isArray(benchmark?.dimensions) ? benchmark.dimensions : [];
  const dimsNode = dims.length
    ? h(
        "div",
        { className: "od-rsi-dims" },
        dims.map((d) =>
          h(
            "span",
            { className: `${C.badge} ${d.ok === false ? "is-fail" : d.ok === true ? "is-pass" : ""} ${C.tabular}` },
            `${d.title || d.id}: ${d.score}/${d.maxScore}`,
          ),
        ),
      )
    : null;

  const header = h(
    "header",
    { className: "od-rsi-head" },
    h(
      "div",
      { className: "od-rsi-head-copy" },
      h(
        "div",
        { className: "od-paper-meta" },
        h("span", null, digest ? `${fmtInt(digest.totalSessions)} local sessions analyzed` : "Local session intelligence"),
        h(
          "span",
          { className: `${C.badge} is-pass od-rsi-privacy`, "data-privacy-mode": digest?.privacyMode || "strict_local" },
          "Strict local · private",
        ),
      ),
      h("h2", { className: "od-doc-title od-rsi-title" }, "System evolution & daily self-tuning"),
      h(
        "p",
        { className: "od-lede" },
        "See where your time went, keep heavy jobs in the cloud or AI PC, and test safe upgrades in an isolated sandbox before anything touches your repo.",
      ),
    ),
    h(
      "div",
      { className: "od-btn-row od-rsi-head-actions" },
      h(
        "button",
        {
          type: "button",
          id: "btn-rsi-scan",
          className: `${C.btn} ${C.btnPrimary}`,
          "data-action": "rsi-scan",
          disabled: loading,
          onclick: () => onScan?.(),
        },
        loading ? "Working…" : "Scan sessions",
      ),
      h(
        "button",
        {
          type: "button",
          id: "btn-rsi-benchmark",
          className: `${C.btn} ${C.btnGhost}`,
          "data-action": "rsi-benchmark",
          disabled: loading,
          onclick: () => onRunBenchmark?.(),
        },
        "Run benchmark",
      ),
    ),
  );

  const errorBanner = error
    ? h("div", { className: `${C.banner} is-bad`, role: "alert", "data-rsi-error": "" }, error)
    : null;

  const statsGrid = h(
    "div",
    { className: "od-rsi-stats" },
    renderStatCard({
      title: "Cloud offload",
      value: fmtPct(digest?.cloudOffloadPct),
      subtitle: "Keep your PC & AI PC cool",
      pct: digest?.cloudOffloadPct,
      meterLabel: "Cloud offload percentage",
    }),
    renderStatCard({
      title: "Free tier used",
      value: fmtPct(digest?.freePoolPct),
      subtitle: "SWE-2 · Dots · Muse AI first",
      pct: digest?.freePoolPct,
      meterLabel: "Free tier usage percentage",
    }),
    renderStatCard({
      title: "Verified system score",
      value: benchScoreText,
      subtitle: "Golden quality checks",
      pct: benchPct,
      meterLabel: "Golden quality score",
      extra: dimsNode,
    }),
  );

  const columns = h(
    "div",
    { className: "od-rsi-cols" },
    renderFocusSection(digest),
    renderCandidatesSection(candidates, { loading, onCycle, onArmPromote, onArmRollback }),
  );

  setChildren(container, h("div", { className: C.rsiPanel }, header, errorBanner, statsGrid, columns));
}
