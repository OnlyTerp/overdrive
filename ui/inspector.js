// Lane Inspector drawer: lane summary, telemetry strip, verify output and unified/split diff viewer.
import { DIFF_CAPS, UI_CLASSES as C } from "./contracts.js";
import { clear, h } from "./dom.js";
import { buildSplitRows, parseUnifiedDiff } from "./parse-patch.js";

const DIFF_MODES = ["unified", "split"];
const MAX_VERIFY_OUTPUT = 4000;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

const MODEL_NAMES = new Map([
  ["gemini-4-carbon", "Gemini 4 Carbon"],
  ["gemini-4-hydrogen", "Gemini 4 Hydrogen"],
  ["gemini-4-argon", "Gemini 4 Argon"],
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["fable-2", "Claude Fable 2"],
  ["swe-2", "Devin SWE-2"],
  ["swe-2-flash", "Devin SWE-2 Flash"],
  ["swe-2-lightning", "Devin SWE-2 Lightning"],
  ["gpt-6-astra", "GPT-6 Astra"],
  ["gpt-6.1-sol", "GPT-6.1 Sol"],
  ["gpt-6.1-terra", "GPT-6.1 Terra"],
  ["qwen-4-max", "Qwen 4 Max"],
  ["glm-5-3", "GLM 5.3"],
  ["glm-5.3", "GLM 5.3"],
  ["mimo-v2-6-pro", "MiMo v2.6 Pro"],
  ["muse", "Muse"],
  ["muse-ai", "Muse AI"],
  ["grok", "Grok"],
]);

const HARNESS_NAMES = new Map([
  ["antigravity", "Antigravity"],
  ["agy", "Antigravity"],
  ["claude", "Claude"],
  ["claude-desktop", "Claude Desktop"],
  ["codex", "Codex"],
  ["devin", "Devin"],
  ["cursor", "Cursor"],
  ["opencode", "OpenCode"],
  ["hermes", "Hermes"],
  ["grok", "Grok"],
  ["muse", "Muse"],
  ["qwen", "Qwen"],
]);

const STATUS_LABELS = new Map([
  ["verified", "Verified"],
  ["passed", "Passed"],
  ["completed", "Completed"],
  ["merged", "Merged"],
  ["ok", "Ready"],
  ["failed", "Needs attention"],
  ["escalated", "Escalated"],
  ["scope_violation", "Outside assigned files"],
  ["rejected", "Rejected"],
  ["error", "Error"],
  ["running", "In progress"],
  ["swarming", "Working"],
  ["verifying", "Checking"],
  ["provisioned", "Ready to start"],
  ["frozen", "Rules locked"],
  ["thinking", "Planning"],
  ["planned", "Planned"],
  ["pending", "Waiting"],
  ["queued", "Queued"],
  ["stale", "Needs refresh"],
]);

const COMPLEXITY_LABELS = new Map([
  ["hard", "Deep focus"],
  ["standard", "Balanced"],
  ["fast", "Quick pass"],
]);

const OFFLOAD_LABELS = new Map([
  ["local", "Runs on this PC"],
  ["auto", "Auto-placed"],
  ["aipc", "Runs on AI PC"],
  ["aipc auto", "Runs on AI PC"],
  ["aipc-gpu", "Runs on AI PC (GPU)"],
  ["aipc --gpu", "Runs on AI PC (GPU)"],
  ["devin-vm", "Devin Cloud VM"],
  ["cloud-agent", "Cloud Agent"],
]);

const COMPUTE_TARGET_LABELS = new Map([
  ["claude-cloud", { label: "Claude Cloud", isCloud: true }],
  ["codex-cloud", { label: "Codex Cloud", isCloud: true }],
  ["devin-cloud", { label: "Devin Cloud", isCloud: true }],
  ["copilot-cloud", { label: "Copilot Cloud", isCloud: true }],
  ["devin-vm", { label: "Devin Cloud VM", isCloud: true }],
  ["cloud-agent", { label: "Cloud Agent", isCloud: true }],
  ["assistant-relay", { label: "Assistant Relay", isCloud: true }],
  ["aipc-gpu", { label: "AI PC GPU", isCloud: true }],
  ["aipc --gpu", { label: "AI PC GPU", isCloud: true }],
  ["aipc", { label: "AI PC", isCloud: true }],
  ["aipc auto", { label: "AI PC", isCloud: true }],
  ["local", { label: "This PC", isCloud: false }],
  ["auto", { label: "Auto-placed", isCloud: false }],
]);

const CLOUD_DISPATCH_KEYS = new Set([
  "claude-cloud",
  "codex-cloud",
  "devin-cloud",
  "copilot-cloud",
  "devin-vm",
  "assistant-relay",
]);

const FILE_STATUS_LABELS = new Map([
  ["added", "New file"],
  ["deleted", "Removed"],
  ["renamed", "Renamed"],
  ["copied", "Copied"],
  ["modified", "Edited"],
]);

function cls(...names) {
  return names.filter(Boolean).join(" ");
}

function titleToken(tok) {
  const low = tok.toLowerCase();
  if (low === "gpt") return "GPT";
  if (low === "swe") return "SWE";
  if (low === "ai") return "AI";
  if (low === "glm") return "GLM";
  if (low === "mimo") return "MiMo";
  if (/^\d+(?:\.\d+)?$/.test(tok)) return tok;
  return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
}

/** Convert provider/model IDs like "antigravity/gemini-4-carbon" into readable names. */
export function humanizeModel(harnessOrSpec, maybeModel) {
  let harness = "";
  let model = "";
  if (harnessOrSpec && typeof harnessOrSpec === "object") {
    harness = String(harnessOrSpec.harness || "").trim();
    model = String(harnessOrSpec.model || "").trim();
  } else if (maybeModel !== undefined) {
    harness = String(harnessOrSpec || "").trim();
    model = String(maybeModel || "").trim();
  } else {
    const raw = String(harnessOrSpec || "").trim();
    const slash = raw.indexOf("/");
    if (slash >= 0) {
      harness = raw.slice(0, slash).trim();
      model = raw.slice(slash + 1).trim();
    } else {
      model = raw;
    }
  }
  if (!harness && !model) return "";

  const hKey = harness.toLowerCase();
  const mKey = model.toLowerCase();
  if (MODEL_NAMES.has(mKey)) return MODEL_NAMES.get(mKey);

  const hLabel = HARNESS_NAMES.get(hKey) || (harness ? titleToken(harness) : "");
  if (!model || mKey === "default") return hLabel || "Default model";

  // Collapse trailing numeric version dashes like "5-5" -> "5.5", keeping "SWE-2" / "GPT-6".
  const cleaned = model
    .replace(/\b(gpt|swe)-(\d+(?:\.\d+)?)/gi, (_, p, n) => `${p.toUpperCase()}-${n}`)
    .replace(/([a-zA-Z])-(\d+)-(\d+)$/g, "$1 $2.$3")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => (part.includes("-") ? part : titleToken(part)))
    .join(" ");

  if (!hLabel) return cleaned;
  if (cleaned.toLowerCase().startsWith(hLabel.toLowerCase())) return cleaned;
  if (hKey === "claude" || hKey === "devin" || hKey === "qwen" || hKey === "grok" || hKey === "muse") {
    return `${hLabel} ${cleaned}`;
  }
  if (hKey === "antigravity" || hKey === "agy" || hKey === "codex") return cleaned;
  return `${hLabel} · ${cleaned}`;
}

function toneOf(status) {
  const s = String(status || "").toLowerCase();
  if (["verified", "passed", "completed", "merged", "ok"].includes(s)) return "is-ok";
  if (["failed", "escalated", "scope_violation", "rejected", "error"].includes(s)) return "is-bad";
  if (["running", "swarming", "verifying", "provisioned", "frozen", "thinking"].includes(s)) return "is-accent";
  if (["planned", "pending", "queued", "stale"].includes(s)) return "is-warn";
  return "";
}

function fmtStatus(status) {
  const s = String(status || "").trim();
  if (!s) return "";
  return STATUS_LABELS.get(s.toLowerCase()) || titleToken(s.replace(/[_-]+/g, " "));
}

function fmtComplexity(c) {
  const s = String(c || "").trim();
  if (!s) return "";
  return COMPLEXITY_LABELS.get(s.toLowerCase()) || titleToken(s);
}

function fmtOffload(offload) {
  const s = String(offload || "").trim();
  if (!s) return "";
  return OFFLOAD_LABELS.get(s.toLowerCase()) || `Runs on: ${s}`;
}

function resolveComputeTarget(lane, worker, ins, lastVerify) {
  const candidates = [
    worker?.cloudProvider,
    worker?.provider,
    lane?.cloudProvider,
    ins?.cloudProvider,
    CLOUD_DISPATCH_KEYS.has(String(worker?.dispatch || "").toLowerCase()) ? worker.dispatch : null,
    worker?.effectiveOffload,
    ins?.effectiveOffload,
    lastVerify?.machine,
    lane?.offload,
  ];
  for (const raw of candidates) {
    const val = String(raw || "").trim();
    if (!val) continue;
    const mapped = COMPUTE_TARGET_LABELS.get(val.toLowerCase());
    if (mapped) return { raw: val, label: mapped.label, isCloud: mapped.isCloud };
    if (val.toLowerCase().includes("cloud")) return { raw: val, label: titleToken(val.replace(/[-_]+/g, " ")), isCloud: true };
    if (val.toLowerCase().includes("gpu")) return { raw: val, label: "AI PC GPU", isCloud: true };
    if (val.toLowerCase().includes("aipc")) return { raw: val, label: "AI PC", isCloud: true };
    return { raw: val, label: fmtOffload(val), isCloud: false };
  }
  return null;
}

function fmtMetricVal(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, "");
}

function renderRatchetCard(lane, ins) {
  const rawLaneRatchet = lane?.ratchet || null;
  const spec = rawLaneRatchet && Array.isArray(rawLaneRatchet.metrics) ? rawLaneRatchet : ins?.ratchet && Array.isArray(ins.ratchet.metrics) ? ins.ratchet : null;
  const res =
    ins?.lastVerify?.ratchet ||
    lane?.lastVerify?.ratchet ||
    ins?.ratchetResult ||
    (rawLaneRatchet && rawLaneRatchet.metrics && !Array.isArray(rawLaneRatchet.metrics) ? rawLaneRatchet : null);
  if (!spec && !res) return null;

  const names = [];
  const addName = (n) => {
    if (typeof n === "string" && n && !names.includes(n)) names.push(n);
  };
  for (const m of spec?.metrics || []) addName(m?.name);
  if (res?.metrics && typeof res.metrics === "object") Object.keys(res.metrics).forEach(addName);
  if (res?.baseline && typeof res.baseline === "object") Object.keys(res.baseline).forEach(addName);

  const hasResult = Boolean(res && typeof res.ok === "boolean");
  const statusLabel = hasResult ? (res.ok ? "Passed" : "Regressed") : "Configured";
  const statusTone = hasResult ? (res.ok ? "is-ok" : "is-bad") : "is-accent";

  const rows = names.map((name) => {
    const specEntry = Array.isArray(spec?.metrics) ? spec.metrics.find((m) => m?.name === name) : null;
    const baseVal = pick(res?.baseline?.[name], specEntry?.baseline, specEntry?.target);
    const curVal = res?.metrics?.[name];
    const deltaVal =
      typeof res?.deltas?.[name] === "number" && Number.isFinite(res.deltas[name])
        ? res.deltas[name]
        : typeof curVal === "number" && typeof baseVal === "number"
          ? curVal - baseVal
          : null;
    const deltaStr =
      deltaVal === null ? null : `${deltaVal >= 0 ? "+" : ""}${fmtMetricVal(deltaVal)}`;
    const rowViolated = Array.isArray(res?.violations) && res.violations.some((v) => String(v?.metric || v || "").includes(name));
    return h(
      "div",
      { className: "od-insp-ratchet-row", "data-ratchet-metric": name },
      h("span", { className: C.mono }, name),
      h(
        "span",
        { className: cls("od-insp-ratchet-vals", C.tabular) },
        h("span", { className: C.muted }, fmtMetricVal(baseVal)),
        " → ",
        h("strong", null, fmtMetricVal(curVal)),
        deltaStr ? h("span", { className: cls(C.badge, rowViolated ? "is-bad" : hasResult && res.ok ? "is-ok" : "") }, deltaStr) : null,
      ),
    );
  });

  const holdoutActive = Boolean(spec?.holdoutConfigured || res?.holdoutConfigured);
  const holdoutNote = holdoutActive
    ? h(
        "div",
        { className: "od-insp-ratchet-holdout", "data-ratchet-holdout": "active" },
        h(
          "span",
          {
            className: cls(
              C.badge,
              res?.holdoutPassed === true ? "is-ok" : res?.holdoutPassed === false ? "is-bad" : "is-accent",
            ),
          },
          res?.holdoutPassed === true
            ? "Coordinator holdout active · Passed"
            : res?.holdoutPassed === false
              ? "Coordinator holdout active · Failed"
              : "Coordinator holdout active",
        ),
      )
    : null;

  const viols = Array.isArray(res?.violations) ? res.violations : [];
  const violList = viols.length
    ? h(
        "div",
        { className: "od-insp-ratchet-rows" },
        viols.map((viol) => {
          const text = typeof viol === "string" ? viol : viol?.message || viol?.reason || viol?.metric || "Metric regression detected";
          return h("div", { className: cls(C.auditRow, "is-bad") }, String(text));
        }),
      )
    : null;

  return h(
    "section",
    { className: "od-insp-ratchet", "data-ratchet-card": "", "aria-label": "Metric Ratchet" },
    h(
      "div",
      { className: "od-insp-ratchet-head" },
      h("h3", null, "Metric Ratchet"),
      h("span", { className: cls(C.badge, C.ratchetBadge, statusTone), "data-ratchet-status": "" }, statusLabel),
    ),
    rows.length ? h("div", { className: "od-insp-ratchet-rows" }, rows) : h("div", { className: C.muted }, "No individual metrics recorded yet."),
    violList,
    holdoutNote,
  );
}

function fmtHunkHeader(raw) {
  const text = String(raw ?? "");
  const m = text.match(HUNK_HEADER_RE);
  if (!m) return text;
  const oldStart = Number(m[1]);
  const newStart = Number(m[3]);
  const newCount = m[4] === undefined ? 1 : Number(m[4]);
  const section = (m[5] || "").trim();
  const range =
    newCount === 0
      ? `Removed near line ${oldStart}`
      : newCount === 1
        ? `Line ${newStart}`
        : `Lines ${newStart}–${newStart + newCount - 1}`;
  return section ? `${range} · ${section}` : range;
}

function fmtInt(n) {
  if (n === null || n === undefined || n === "" || !Number.isFinite(Number(n))) return "—";
  return String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return "—";
  const v = Number(ms);
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60000) return `${(v / 1000).toFixed(1)}s`;
  const m = Math.floor(v / 60000);
  const s = Math.round((v % 60000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function fmtCost(usd) {
  if (usd === null || usd === undefined || !Number.isFinite(Number(usd))) return "—";
  const v = Number(usd);
  return `$${v < 1 ? v.toFixed(4) : v.toFixed(2)}`;
}

function pick(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return null;
}

/** Normalize diffData ({ patch } | { files: [{ patch } | { hunks }] }) into capped renderable files. */
export function normalizeDiffFiles(diffData, caps = DIFF_CAPS) {
  const lim = { ...DIFF_CAPS, ...(caps || {}) };
  if (!diffData || typeof diffData !== "object") return { files: [], truncated: false, omittedFiles: 0 };
  let truncated = Boolean(diffData.truncated);
  let omittedFiles = Number(diffData.omittedFiles) || 0;
  let files = [];

  if (typeof diffData.patch === "string" && !Array.isArray(diffData.files)) {
    const parsed = parseUnifiedDiff(diffData.patch, lim);
    files = parsed.files;
    truncated = truncated || parsed.truncated;
    omittedFiles += parsed.omittedFiles || 0;
  } else if (Array.isArray(diffData.files)) {
    for (const raw of diffData.files) {
      if (!raw || typeof raw !== "object") continue;
      let hunks = Array.isArray(raw.hunks) ? raw.hunks : null;
      let parsedFile = null;
      if (!hunks && typeof raw.patch === "string" && raw.patch) {
        const parsed = parseUnifiedDiff(raw.patch, { ...lim, maxFiles: 1 });
        parsedFile = parsed.files[0] || null;
        hunks = parsedFile ? parsedFile.hunks : [];
        if (parsed.truncated) truncated = true;
      }
      const path = String(pick(raw.path, raw.newPath, parsedFile?.path, raw.oldPath) || "(unknown)");
      files.push({
        path,
        oldPath: pick(raw.oldPath, parsedFile?.oldPath),
        newPath: pick(raw.newPath, parsedFile?.newPath, path),
        status: String(pick(raw.status, parsedFile?.status) || "modified"),
        isBinary: Boolean(raw.binary || raw.isBinary || parsedFile?.isBinary),
        additions: Number(pick(raw.additions, parsedFile?.additions)) || 0,
        deletions: Number(pick(raw.deletions, parsedFile?.deletions)) || 0,
        ownership: raw.ownership || null,
        matchedGlob: raw.matchedGlob || null,
        hunks: hunks || [],
        truncated: Boolean(raw.truncated || parsedFile?.truncated),
      });
    }
  }

  if (files.length > lim.maxFiles) {
    omittedFiles += files.length - lim.maxFiles;
    files = files.slice(0, lim.maxFiles);
    truncated = true;
  }
  if (files.some((f) => f.truncated)) truncated = true;
  return { files, truncated: truncated || omittedFiles > 0, omittedFiles };
}

export function createInspector({ container, store = null, api = null, onSelectLane = null, onClose = null, showClose = true } = {}) {
  if (!container) throw new Error("createInspector requires a container element.");

  let diffMode = "unified";
  let localTab = "diff";
  let filterPath = null;
  let activeHunk = -1;
  let hunkRows = [];
  let laneKey = null;
  let last = {};
  const collapsed = new Set();

  const root = h("section", { className: C.inspRoot, tabindex: "0", "aria-label": "Lane Inspector", "data-diff-mode": diffMode });
  container.appendChild(root);

  function onKey(ev) {
    const tag = String(ev?.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (ev.key === "]") {
      nextHunk();
    } else if (ev.key === "[") {
      prevHunk();
    } else {
      return;
    }
    ev.preventDefault?.();
    ev.stopPropagation?.();
  }
  root.addEventListener("keydown", onKey);

  function resolve(state) {
    const base = store && typeof store.getState === "function" ? store.getState() || {} : {};
    const s = { ...base, ...(state || {}) };
    const mission = s.mission || s.activeMission || null;
    const laneId = s.selectedLaneId || s.lane?.id || null;
    const lane = s.lane || (mission && Array.isArray(mission.lanes) ? mission.lanes.find((l) => l.id === laneId) : null) || null;
    const rawTab = s.inspectorTab;
    const tab = rawTab && ["diff", "brief", "audit"].includes(rawTab) ? rawTab : localTab;
    return {
      mission,
      lane,
      laneId: lane?.id || laneId,
      diffData: s.diffData || null,
      inspectionData: s.inspectionData || null,
      loading: Boolean(s.diffLoading || s.loading),
      error: s.diffError || s.error || null,
      wide: Boolean(s.inspectorWide),
      selectedFilePath: s.selectedFilePath ?? null,
      tab,
    };
  }

  function copyButton(key, value) {
    const btn = h("button", { type: "button", className: cls(C.btn, C.btnGhost), title: `Copy ${key}`, "data-copy": key }, "Copy");
    btn.addEventListener("click", () => {
      const clip = globalThis.navigator?.clipboard;
      const done = (ok) => {
        btn.textContent = ok ? "Copied" : "Copy failed";
      };
      if (clip && typeof clip.writeText === "function") {
        Promise.resolve(clip.writeText(String(value))).then(() => done(true), () => done(false));
      } else {
        done(false);
      }
    });
    return btn;
  }

  function renderHeader(v) {
    const { lane, mission, inspectionData: ins } = v;
    const worker = lane?.worker || ins?.worker || {};
    const lastVerify = ins?.lastVerify || ins?.verification || ins?.verify || lane?.lastVerify || {};
    const model = humanizeModel(worker.harness, worker.model);
    const compute = resolveComputeTarget(lane, worker, ins, lastVerify);
    const branch = pick(lane?.branch, ins?.branch);
    const worktree = pick(lane?.worktreePath, ins?.worktreePath);
    const title = h("div", { className: "od-insp-title" }, h("h2", { title: lane?.id || "" }, String(lane?.title || lane?.id || "Lane Inspector")));

    if (mission && Array.isArray(mission.lanes) && mission.lanes.length > 1 && typeof onSelectLane === "function") {
      const sel = h("select", { "aria-label": "Switch teammate", "data-lane-select": "" });
      for (const l of mission.lanes) {
        const label = l.title && l.title !== l.id ? `${l.title} (${l.id})` : String(l.id);
        const opt = h("option", { value: String(l.id) }, label);
        if (l.id === lane?.id) opt.setAttribute("selected", "");
        sel.appendChild(opt);
      }
      sel.value = String(lane?.id || "");
      sel.addEventListener("change", (ev) => onSelectLane(String(ev?.target?.value ?? sel.value)));
      title.appendChild(sel);
    }
    if (showClose && typeof onClose === "function") {
      title.appendChild(
        h("button", { type: "button", className: cls(C.btn, C.btnGhost), "aria-label": "Close inspector", "data-action": "close", onClick: () => onClose() }, "Close"),
      );
    }

    const rawModel = [worker.harness, worker.model].filter(Boolean).join(" / ");
    const pills = h(
      "div",
      { className: "od-insp-pills" },
      model ? h("span", { className: cls(C.badge, "is-accent"), "data-pill": "model", title: rawModel }, model) : null,
      lane?.complexity ? h("span", { className: C.badge, "data-pill": "complexity" }, fmtComplexity(lane.complexity)) : null,
      compute ? h("span", { className: cls(C.badge, C.cloudBadge, compute.isCloud && "is-cloud"), "data-pill": "compute", "data-compute-target": compute.raw }, compute.label) : null,
      lane?.status ? h("span", { className: cls(C.badge, toneOf(lane.status)), "data-pill": "status" }, fmtStatus(lane.status)) : null,
    );

    const copyRow = (key, displayLabel, value) =>
      value ? h("div", { className: "od-insp-copy" }, h("span", { className: C.muted }, displayLabel), h("code", { title: String(value) }, String(value)), copyButton(key, value)) : null;

    return h("header", { className: C.inspHeader }, title, pills, copyRow("branch", "Branch", branch), copyRow("worktree", "Folder", worktree));
  }

  function renderTelemetry(v, norm) {
    const { lane, inspectionData: ins, diffData } = v;
    const t = ins?.telemetry || lane?.telemetry || {};
    const lastVerify = ins?.lastVerify || ins?.verification || ins?.verify || lane?.lastVerify || {};
    const scopeOk = pick(ins?.scopeOk, lastVerify.scopeOk, lane?.scopeOk);
    const outOfScope = norm.files.filter((f) => f.ownership === "out_of_scope").length;
    const scopeKnown = scopeOk !== null || outOfScope > 0;
    const scopeGood = scopeKnown && scopeOk !== false && outOfScope === 0;
    const contracts = (Array.isArray(ins?.contracts) && ins.contracts) || (Array.isArray(diffData?.contracts) && diffData.contracts) || [];
    const broken = contracts.filter((c) => c && c.intact === false).length;

    let lockLabel = "Not checked";
    if (contracts.length) {
      lockLabel = broken ? `Rules changed (${broken})` : "Shared rules intact";
    } else if (ins?.contractLock) {
      const rawLock = String(ins.contractLock).toLowerCase();
      lockLabel = rawLock === "locked" ? "Shared rules intact" : rawLock === "drifted" ? "Rules changed" : String(ins.contractLock);
    }

    const scopeLabel = scopeKnown
      ? scopeGood
        ? "Stayed in assigned files"
        : outOfScope
          ? `Outside assigned files (${outOfScope})`
          : "Outside assigned files"
      : "Not checked yet";

    const cell = (metricKey, label, value, extra = null) =>
      h("div", { "data-metric": metricKey }, h("dt", null, label), h("dd", { className: cls(C.tabular, extra) }, value));

    const tele = h(
      "dl",
      { className: "od-insp-tele" },
      cell("duration", "Duration", fmtDuration(pick(t.durationMs, ins?.durationMs, lastVerify.durationMs))),
      cell("tokens in", "Tokens read", fmtInt(pick(t.tokensIn, t.inputTokens, ins?.tokensIn))),
      cell("tokens out", "Tokens written", fmtInt(pick(t.tokensOut, t.outputTokens, ins?.tokensOut))),
      cell("cost", "Est. cost", fmtCost(pick(t.costUsd, t.cost, ins?.costUsd))),
      cell(
        "scope",
        "File boundaries",
        h("span", { className: cls(C.badge, scopeKnown ? (scopeGood ? "is-ok" : "is-bad") : ""), "data-scope-ok": scopeKnown ? String(scopeGood) : "unknown" }, scopeLabel),
      ),
      cell(
        "contracts",
        "Shared rules",
        h(
          "span",
          {
            className: cls(C.badge, contracts.length ? (broken ? "is-bad" : "is-ok") : ""),
            "data-contract-lock": broken ? "drifted" : contracts.length ? "locked" : "unknown",
            title: contracts.length ? `${contracts.length} shared file(s) tracked` : undefined,
          },
          lockLabel,
        ),
      ),
    );

    const cmd = pick(lastVerify.cmd, lastVerify.command, ins?.verifyCmd, lane?.verifyCmd);
    const tailParts = [];
    for (const part of [lastVerify.stdout, lastVerify.stdoutTail, lastVerify.stderr, lastVerify.stderrTail]) {
      if (part !== undefined && part !== null && part !== "" && !tailParts.includes(String(part))) {
        tailParts.push(String(part));
      }
    }
    const streams = tailParts.join("\n");
    let output = pick(lastVerify.output, streams, lastVerify.tail, ins?.verifyOutput);
    let verify = null;
    if (cmd || output) {
      output = output === null ? null : String(output);
      const clipped = output && output.length > MAX_VERIFY_OUTPUT ? `${output.slice(0, MAX_VERIFY_OUTPUT)}\n… (${output.length - MAX_VERIFY_OUTPUT} more chars)` : output;
      const ok = lastVerify.ok;
      verify = h(
        "div",
        { className: "od-insp-verify" },
        h(
          "div",
          { className: "od-insp-copy" },
          h("span", { className: cls(C.badge, ok === true ? "is-ok" : ok === false ? "is-bad" : "") }, ok === true ? "Checks passed" : ok === false ? "Checks failed" : "Check"),
          h("code", { title: String(cmd || "") }, String(cmd || "No check command configured")),
          cmd ? copyButton("verify command", cmd) : null,
        ),
        clipped
          ? h(
              "details",
              { className: "od-insp-check-details" },
              h("summary", null, "Check output"),
              h("pre", { className: C.mono, "data-verify-output": "" }, clipped),
            )
          : null,
      );
    }
    return [tele, verify];
  }

  function renderToolbar(totalHunks) {
    const modeBtn = (mode, label) =>
      h(
        "button",
        {
          type: "button",
          className: cls(C.btn, C.inspTabBtn, diffMode === mode && "is-active"),
          "data-diff-mode": mode,
          "aria-pressed": diffMode === mode ? "true" : "false",
          onClick: () => setDiffMode(mode),
        },
        label,
      );
    const pos = h("span", { className: cls(C.badge, C.tabular, "od-insp-hunkpos"), "data-hunk-badge": "" }, hunkLabel(totalHunks));
    return h(
      "div",
      { className: C.inspTabs, role: "toolbar", "aria-label": "Diff controls" },
      h("div", { className: "od-insp-mode-group" }, modeBtn("unified", "Unified"), modeBtn("split", "Side-by-side")),
      h("span", { className: "od-spacer" }),
      h("button", { type: "button", className: cls(C.btn, C.btnGhost), "data-action": "prev-hunk", title: "Previous change ([)", onClick: () => prevHunk() }, "Prev"),
      pos,
      h("button", { type: "button", className: cls(C.btn, C.btnGhost), "data-action": "next-hunk", title: "Next change (])", onClick: () => nextHunk() }, "Next"),
    );
  }

  function hunkLabel(total) {
    if (!total) return "No changes";
    return activeHunk < 0 ? `${total} change${total === 1 ? "" : "s"}` : `Change ${activeHunk + 1} of ${total}`;
  }

  function renderFilter(files) {
    if (files.length < 2) return null;
    const btn = (path, label, extra) =>
      h(
        "button",
        {
          type: "button",
          className: cls(C.btn, (filterPath || null) === path && "is-active", extra),
          "data-filter-path": path === null ? "*" : path,
          title: path || "All files",
          onClick: () => {
            filterPath = path;
            if (store && typeof store.dispatch === "function") store.dispatch({ selectedFilePath: path });
            activeHunk = -1;
            render();
          },
        },
        label,
      );
    return h(
      "div",
      { className: "od-insp-filter", role: "toolbar", "aria-label": "Filter files" },
      btn(null, `All files (${files.length})`),
      files.map((f) => btn(f.path, f.path, f.ownership === "out_of_scope" && "is-out-of-scope")),
    );
  }

  function lineCells(line) {
    const kind = line.type === "add" ? "is-add" : line.type === "del" ? "is-del" : "is-ctx";
    const sign = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
    return h(
      "tr",
      { className: cls(C.diffLine, kind), "data-line-type": line.type },
      h("td", { className: cls(C.diffLineNum, "od-diff-gutter") }, line.oldLine === null || line.oldLine === undefined ? "" : String(line.oldLine)),
      h("td", { className: cls(C.diffLineNum, "od-diff-gutter") }, line.newLine === null || line.newLine === undefined ? "" : String(line.newLine)),
      h("td", { className: "od-diff-sign" }, sign),
      h("td", { className: C.diffLineCode }, String(line.content ?? "")),
    );
  }

  function hunkRow(text, span) {
    const raw = String(text ?? "");
    const tr = h("tr", { className: C.diffHunkHeader, "data-hunk-index": String(hunkRows.length), title: raw }, h("td", { colspan: String(span) }, fmtHunkHeader(raw)));
    hunkRows.push(tr);
    return tr;
  }

  function noteRow(text, span) {
    return h("tr", { className: "od-diff-note" }, h("td", { colspan: String(span) }, String(text ?? "")));
  }

  function splitHalf(line, side) {
    if (!line) {
      return [h("td", { className: cls(C.diffLineNum, "od-diff-gutter", "is-empty") }, ""), h("td", { className: cls(C.diffLineCode, "od-diff-cell", "is-empty") }, "")];
    }
    const kind = line.type === "add" ? "is-add" : line.type === "del" ? "is-del" : "is-ctx";
    const num = side === "left" ? line.oldLine : line.newLine;
    return [
      h("td", { className: cls(C.diffLineNum, "od-diff-gutter", kind) }, num === null || num === undefined ? "" : String(num)),
      h("td", { className: cls(C.diffLineCode, "od-diff-cell", kind), "data-side": side }, String(line.content ?? "")),
    ];
  }

  function renderTable(file, budget) {
    const split = diffMode === "split";
    const span = 4;
    const cols = split
      ? [h("col", { className: "od-col-ln" }), h("col", { className: "od-col-code" }), h("col", { className: "od-col-ln" }), h("col", { className: "od-col-code" })]
      : [h("col", { className: "od-col-ln" }), h("col", { className: "od-col-ln" }), h("col", { className: "od-col-sign" }), h("col", { className: "od-col-code" })];
    const tbody = h("tbody");
    for (const hunk of file.hunks) {
      if (budget.left <= 0) {
        budget.hit = true;
        break;
      }
      const lines = Array.isArray(hunk.lines) ? hunk.lines : [];
      const hasHeaderLine = lines[0]?.type === "hunk";
      if (!hasHeaderLine) tbody.appendChild(hunkRow(hunk.header || "@@", span));
      if (split) {
        for (const row of buildSplitRows(hunk)) {
          if (budget.left <= 0) {
            budget.hit = true;
            break;
          }
          budget.left--;
          if (row.type === "hunk") tbody.appendChild(hunkRow(row.left?.content, span));
          else if (row.type === "note") tbody.appendChild(noteRow(row.left?.content, span));
          else {
            const kind = row.type === "context" ? "is-ctx" : "is-change";
            tbody.appendChild(h("tr", { className: cls(C.diffLine, kind), "data-row-type": row.type }, splitHalf(row.left, "left"), splitHalf(row.right, "right")));
          }
        }
      } else {
        for (const line of lines) {
          if (budget.left <= 0) {
            budget.hit = true;
            break;
          }
          budget.left--;
          if (line.type === "hunk") tbody.appendChild(hunkRow(line.content, span));
          else if (line.type === "note") tbody.appendChild(noteRow(line.content, span));
          else tbody.appendChild(lineCells(line));
        }
      }
    }
    return h("table", { className: cls(C.diffTable, split && "is-split"), "data-mode": diffMode }, h("colgroup", null, cols), tbody);
  }

  function renderFile(file, budget) {
    const isCollapsed = collapsed.has(file.path);
    const out = file.ownership === "out_of_scope";
    const label = file.status === "renamed" && file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path;
    const statusLabel = FILE_STATUS_LABELS.get(file.status) || titleToken(file.status);
    const head = h(
      "button",
      {
        type: "button",
        className: C.diffFileHead,
        "aria-expanded": isCollapsed ? "false" : "true",
        title: file.path,
        onClick: () => {
          if (collapsed.has(file.path)) collapsed.delete(file.path);
          else collapsed.add(file.path);
          render();
        },
      },
      h("span", { className: "od-caret", "aria-hidden": "true" }, "▾"),
      h("span", { className: cls(C.badge, file.status === "added" ? "is-ok" : file.status === "deleted" ? "is-bad" : "") }, statusLabel),
      h("span", { className: "od-path" }, label),
      out ? h("span", { className: cls(C.badge, "is-bad"), title: "This file is outside this teammate's assigned files" }, "Outside assigned files") : null,
      file.truncated ? h("span", { className: cls(C.badge, "is-warn") }, "Trimmed") : null,
      h("span", { className: cls("od-diff-stat-add", C.tabular) }, `+${file.additions}`),
      h("span", { className: cls("od-diff-stat-del", C.tabular) }, `-${file.deletions}`),
    );
    let body = null;
    if (!isCollapsed) {
      body = h(
        "div",
        { className: "od-diff-file-body" },
        file.isBinary
          ? h("div", { className: "od-diff-binary" }, "Binary file — preview not shown.")
          : file.hunks.length
            ? renderTable(file, budget)
            : h("div", { className: "od-diff-binary" }, "No text changes in this file."),
      );
    }
    return h(
      "article",
      { className: cls(C.diffFileCard, isCollapsed && "is-collapsed", out && "is-out-of-scope"), "data-file-path": file.path, "data-status": file.status },
      head,
      body,
    );
  }

  function renderInspTabs(v) {
    const btn = (tab, label) =>
      h(
        "button",
        {
          type: "button",
          className: cls(C.btn, C.inspTabBtn, v.tab === tab && "is-active"),
          "data-insp-tab": tab,
          "aria-pressed": v.tab === tab ? "true" : "false",
          onClick: () => {
            localTab = tab;
            if (store && typeof store.setInspectorTab === "function") store.setInspectorTab(tab);
            else render();
          },
        },
        label,
      );
    return h(
      "div",
      { className: "od-insp-subtabs", role: "tablist", "aria-label": "Inspector sections" },
      btn("diff", "Changes"),
      btn("brief", "Assignment"),
      btn("audit", "Rule check"),
    );
  }

  function renderBriefTab(v) {
    const { lane, inspectionData: ins } = v;
    const brief = pick(lane?.brief, ins?.brief) || "No teammate assignment notes recorded.";
    const globs = (lane?.ownedGlobs || ins?.ownedGlobs || []).join(", ") || "None listed";
    const verifyCmd = pick(lane?.verifyCmd, ins?.verifyCmd) || "Not configured";
    const worker = lane?.worker || ins?.worker || {};
    const verifier = lane?.verifier || ins?.verifier || {};
    return h(
      "div",
      { className: cls(C.inspBody, "od-insp-panel"), "data-state": "ready", "data-panel": "brief" },
      h(
        "dl",
        { className: "od-insp-tele" },
        h("div", null, h("dt", null, "Author model"), h("dd", null, humanizeModel(worker.harness, worker.model) || "Unassigned")),
        h("div", null, h("dt", null, "Assigned reviewer"), h("dd", null, humanizeModel(verifier.harness, verifier.model) || "Auto cross-family")),
        h("div", null, h("dt", null, "Owned files"), h("dd", { className: C.mono }, globs)),
        h("div", null, h("dt", null, "Verify command"), h("dd", { className: C.mono }, verifyCmd)),
      ),
      h("pre", { className: cls(C.mono, "od-insp-brief-pre"), "data-lane-brief": "" }, String(brief)),
    );
  }

  function renderAuditTab(v, norm) {
    const { lane, mission, inspectionData: ins, diffData } = v;
    const contracts = (Array.isArray(ins?.contracts) && ins.contracts) || (Array.isArray(diffData?.contracts) && diffData.contracts) || [];
    const dirty = Array.isArray(ins?.dirtyFiles) ? ins.dirtyFiles : [];
    const lastVerify = ins?.lastVerify || lane?.lastVerify || null;
    const ratchetCard = renderRatchetCard(lane, ins);
    return h(
      "div",
      { className: cls(C.inspBody, "od-insp-panel"), "data-state": "ready", "data-panel": "audit" },
      h(
        "dl",
        { className: "od-insp-tele" },
        h("div", null, h("dt", null, "Locked commit"), h("dd", { className: cls(C.mono, C.tabular) }, String(pick(ins?.freezeCommit, diffData?.freezeCommit, mission?.freezeCommit) || "Unlocked"))),
        h("div", null, h("dt", null, "Files inspected"), h("dd", { className: C.tabular }, String(norm.files.length))),
        h("div", null, h("dt", null, "Uncommitted items"), h("dd", { className: C.tabular }, String(dirty.length))),
        h("div", null, h("dt", null, "Violation"), h("dd", null, String(lastVerify?.violation || "None"))),
      ),
      ratchetCard,
      contracts.length
        ? h(
            "div",
            { className: C.diffFileList },
            contracts.map((c) =>
              h(
                "div",
                { className: cls(C.auditRow, c.intact === false ? "is-bad" : "is-ok") },
                h("span", { className: C.mono }, String(c.path || "")),
                h("span", { className: cls(C.badge, c.intact === false ? "is-bad" : "is-ok") }, c.intact === false ? "Changed" : "Intact"),
              ),
            ),
          )
        : h("div", { className: "od-insp-empty" }, "No shared contract hashes recorded yet."),
    );
  }

  function render() {
    const v = resolve(last);
    hunkRows = [];
    clear(root);
    root.setAttribute("data-diff-mode", diffMode);
    root.setAttribute("data-inspector-tab", v.tab);
    root.classList.toggle("is-wide", v.wide);

    if (!v.lane) {
      root.appendChild(h("div", { className: "od-insp-empty", "data-state": "empty" }, "Pick a teammate to review their file changes, timing, and boundary checks."));
      return;
    }

    const norm = normalizeDiffFiles(v.diffData);
    if (filterPath && !norm.files.some((f) => f.path === filterPath)) filterPath = null;
    const visible = filterPath ? norm.files.filter((f) => f.path === filterPath) : norm.files;

    root.appendChild(renderHeader(v));
    root.appendChild(renderInspTabs(v));
    for (const node of renderTelemetry(v, norm)) if (node) root.appendChild(node);

    if (v.tab === "brief") {
      root.appendChild(renderBriefTab(v));
      return;
    }
    if (v.tab === "audit") {
      root.appendChild(renderAuditTab(v, norm));
      return;
    }

    const body = h("div", { className: C.inspBody, "data-state": "ready" });
    const budget = { left: DIFF_CAPS.maxRenderedHunkLines, hit: false };

    if (v.error) {
      body.setAttribute("data-state", "error");
      body.appendChild(h("div", { className: cls(C.banner, "is-bad"), role: "alert" }, `Could not load changes: ${String(v.error?.message || v.error)}`));
    } else if (v.loading && !v.diffData) {
      body.setAttribute("data-state", "loading");
      body.appendChild(h("div", { className: "od-insp-empty", "aria-busy": "true" }, "Loading file changes…"));
    } else if (!norm.files.length) {
      body.setAttribute("data-state", "empty");
      const emptyMsg =
        v.diffData?.source === "historical-empty"
          ? "No file evidence was captured yet at this step."
          : v.diffData
            ? "No file changes in this lane yet."
            : "No file changes loaded yet.";
      body.appendChild(h("div", { className: "od-insp-empty" }, emptyMsg));
    } else {
      const list = h("div", { className: C.diffFileList });
      for (const f of visible) list.appendChild(renderFile(f, budget));
      if (norm.truncated || budget.hit) {
        const parts = [];
        if (norm.omittedFiles) parts.push(`${norm.omittedFiles} file(s) omitted (showing up to ${DIFF_CAPS.maxFiles})`);
        if (norm.files.some((f) => f.truncated)) parts.push(`long files trimmed at ${DIFF_CAPS.maxLinesPerFile} lines`);
        if (budget.hit) parts.push(`preview capped at ${DIFF_CAPS.maxRenderedHunkLines} lines`);
        body.appendChild(
          h("div", { className: C.banner, role: "status", "data-truncated": "true" }, `Showing a trimmed preview for speed${parts.length ? `: ${parts.join("; ")}` : ""}. Open the folder to view the full change.`),
        );
      }
      body.appendChild(list);
    }

    root.appendChild(renderToolbar(hunkRows.length));
    const filter = renderFilter(norm.files);
    if (filter) root.appendChild(filter);
    root.appendChild(body);

    if (activeHunk >= hunkRows.length) activeHunk = hunkRows.length - 1;
    markActive(false);
  }

  function markActive(scroll) {
    hunkRows.forEach((tr, i) => tr.classList.toggle("is-active", i === activeHunk));
    const badge = root.querySelector("[data-hunk-badge]");
    if (badge) badge.textContent = hunkLabel(hunkRows.length);
    const tr = hunkRows[activeHunk];
    if (scroll && tr && typeof tr.scrollIntoView === "function") tr.scrollIntoView({ block: "center" });
  }

  function update(state = {}) {
    last = state || {};
    const v = resolve(last);
    const key = `${v.mission?.id || ""}::${v.laneId || ""}`;
    if (key !== laneKey) {
      laneKey = key;
      activeHunk = -1;
      collapsed.clear();
      filterPath = v.selectedFilePath || null;
    } else if (v.selectedFilePath && v.selectedFilePath !== filterPath) {
      filterPath = v.selectedFilePath;
    }
    render();
  }

  function setDiffMode(mode) {
    if (!DIFF_MODES.includes(mode)) return diffMode;
    if (mode !== diffMode) {
      diffMode = mode;
      render();
    }
    return diffMode;
  }

  function step(delta) {
    if (!hunkRows.length) return -1;
    if (activeHunk < 0) activeHunk = delta > 0 ? 0 : hunkRows.length - 1;
    else activeHunk = Math.min(hunkRows.length - 1, Math.max(0, activeHunk + delta));
    markActive(true);
    return activeHunk;
  }

  function nextHunk() {
    return step(1);
  }

  function prevHunk() {
    return step(-1);
  }

  function destroy() {
    root.removeEventListener("keydown", onKey);
    clear(root);
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  render();
  return {
    update,
    setDiffMode,
    nextHunk,
    prevHunk,
    destroy,
    root,
    get diffMode() {
      return diffMode;
    },
  };
}
