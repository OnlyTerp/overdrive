// Mission Composer: author title/goal/routing + parallel lanes with live glob-collision detection.
import { OFFLOAD_MODES, ROUTES, UI_CLASSES as C, toPublicRatchetSpec, validateDemoSeedResponse, validateRatchetSpec, validateTopology } from "./contracts.js";
import { clear, h } from "./dom.js";

export const ROUTING_MODES = Object.freeze(["playbook-auto", "single-harness", "mix-and-match"]);
export const HARNESS_IDS = Object.freeze(["antigravity", "claude", "codex", "devin", "grok", "muse", "qwen", "hermes", "cursor", "opencode"]);
export const COMPLEXITIES = Object.freeze(["hard", "standard", "fast"]);
export const OFFLOADS = Object.freeze(["auto", "local", "aipc", "aipc-gpu", "devin-vm", "cloud-agent"].filter((m) => OFFLOAD_MODES.includes(m)));

const ROUTING_LABELS = Object.freeze({
  "playbook-auto": "Automatic best mix",
  "single-harness": "Single AI app",
  "mix-and-match": "Custom per teammate",
});

const HARNESS_LABELS = Object.freeze({
  antigravity: "Antigravity (Gemini)",
  claude: "Claude Code",
  codex: "Codex (ChatGPT)",
  devin: "Devin",
  grok: "Grok",
  muse: "Muse",
  qwen: "Qwen",
  hermes: "Hermes",
  cursor: "Cursor",
  opencode: "OpenCode",
});

const COMPLEXITY_LABELS = Object.freeze({
  hard: "Deep focus",
  standard: "Balanced",
  fast: "Quick pass",
});

export const OFFLOAD_LABELS = Object.freeze({
  auto: "Auto place",
  local: "This PC",
  aipc: "AI PC",
  "aipc-gpu": "AI PC (GPU)",
  "devin-vm": "Devin Cloud VM",
  "cloud-agent": "Cloud Agent",
});

export const OFFLOAD_OPTIONS = Object.freeze(
  OFFLOADS.map((value) => ({ value, label: OFFLOAD_LABELS[value] || value })),
);

export const PRESETS = Object.freeze({
  "feature-ui-api": {
    label: "Full Feature (UI + Backend + Review)",
    title: "Feature: ",
    goal: "Build the feature end to end — core logic, API, and interface — with each teammate working in an isolated folder.",
    routingMode: "mix-and-match",
    sharedContracts: ["src/contracts.mjs"],
    lanes: [
      { id: "core", title: "Core logic", complexity: "hard", offload: "auto", ownedGlobs: ["src/core/**", "test/core/**"], verifyCmd: "node --test test/core" },
      { id: "api", title: "Backend API", complexity: "standard", offload: "auto", ownedGlobs: ["src/api/**", "test/api/**"], verifyCmd: "node --test test/api" },
      { id: "ui", title: "Interface", complexity: "standard", offload: "local", ownedGlobs: ["ui/**", "test/ui/**"], verifyCmd: "node --test test/ui" },
    ],
  },
  "research-harden": {
    label: "Explore & Harden",
    title: "Explore & harden: ",
    goal: "Investigate edge cases first, then strengthen the code and add tests so regressions can't slip back in.",
    routingMode: "playbook-auto",
    sharedContracts: ["docs/SPEC.md"],
    lanes: [
      { id: "research", title: "Research & notes", complexity: "fast", offload: "auto", ownedGlobs: ["docs/research/**"], verifyCmd: "node -e \"process.exit(0)\"" },
      { id: "harden", title: "Harden & test", complexity: "hard", offload: "aipc", ownedGlobs: ["src/**", "test/**"], verifyCmd: "npm test" },
    ],
  },
  "cloud-swarm": {
    label: "Cloud Swarm (Zero Local Load)",
    title: "Cloud Swarm: ",
    goal: "Run planning, parallel builds, and cross-family verification in cloud workers with zero local CPU or RAM load.",
    routingMode: "playbook-auto",
    sharedContracts: ["src/contracts.mjs"],
    lanes: [
      { id: "core", title: "Core logic", complexity: "hard", offload: "cloud-agent", ownedGlobs: ["src/core/**", "test/core/**"], verifyCmd: "node --test test/core" },
      { id: "api", title: "Backend & workers", complexity: "standard", offload: "cloud-agent", ownedGlobs: ["src/api/**", "test/api/**"], verifyCmd: "node --test test/api" },
      { id: "qa", title: "VM checks", complexity: "standard", offload: "devin-vm", ownedGlobs: ["checks/**", "test/e2e/**"], verifyCmd: "node --test test/e2e" },
    ],
  },
  blank: {
    label: "Blank",
    title: "",
    goal: "",
    routingMode: "single-harness",
    sharedContracts: [],
    lanes: [{ id: "core", title: "Core", complexity: "standard", offload: "auto", ownedGlobs: [], verifyCmd: "" }],
  },
});

function cls(...names) {
  return names.filter(Boolean).join(" ");
}

function splitList(text) {
  return String(text || "")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function cloneLane(l = {}) {
  const cleanRatchet = l.ratchet && typeof l.ratchet === "object" ? toPublicRatchetSpec(l.ratchet) : null;
  const ratchetText = typeof l.ratchetText === "string" ? l.ratchetText : cleanRatchet ? JSON.stringify(cleanRatchet) : "";
  return {
    id: String(l.id || ""),
    title: String(l.title || ""),
    brief: l.brief ? String(l.brief) : "",
    complexity: COMPLEXITIES.includes(l.complexity) ? l.complexity : "standard",
    offload: OFFLOADS.includes(l.offload) ? l.offload : "auto",
    ownedGlobs: Array.isArray(l.ownedGlobs) ? l.ownedGlobs.map(String) : splitList(l.ownedGlobs),
    verifyCmd: String(l.verifyCmd || ""),
    ratchet: cleanRatchet,
    ratchetText,
  };
}

function cloneGate(g = {}, idx = 0) {
  return {
    id: String(g.id || `g${idx + 1}`),
    title: String(g.title || ""),
    cmd: String(g.cmd || ""),
    offload: OFFLOADS.includes(g.offload) ? g.offload : "auto",
    required: g.required !== false,
  };
}

function defaultGatesForPreset(key) {
  if (key === "blank") return [];
  if (key === "cloud-swarm") return [{ id: "g1", title: "Cloud test suite", cmd: "npm test", offload: "cloud-agent", required: true }];
  return [{ id: "g1", title: "Test suite", cmd: "npm test", offload: "auto", required: true }];
}

function draftFrom(preset, base = {}) {
  const isTopologyEdit = Boolean(preset && typeof preset === "object" && preset.mission && typeof preset.mission === "object");
  const rawPresetKey = typeof preset === "string" ? preset : null;
  const p = isTopologyEdit
    ? preset.mission
    : rawPresetKey
      ? PRESETS[rawPresetKey] || PRESETS.blank
      : preset && typeof preset === "object" && (preset.title !== undefined || preset.lanes !== undefined || preset.goal !== undefined)
        ? preset
        : PRESETS.blank;
  const rawGates = Array.isArray(p.gates)
    ? p.gates
    : rawPresetKey
      ? defaultGatesForPreset(rawPresetKey)
      : isTopologyEdit
        ? []
        : p === PRESETS.blank
          ? []
          : defaultGatesForPreset("preset");
  return {
    editMissionId: isTopologyEdit && preset.mode === "topology" ? String(preset.mission.id || "") || null : null,
    title: String(p.title ?? ""),
    goal: String(p.goal ?? ""),
    repoRoot: String(p.repoRoot ?? base.repoRoot ?? ""),
    routingMode: ROUTING_MODES.includes(p.routingMode) ? p.routingMode : "single-harness",
    activeHarness: HARNESS_IDS.includes(p.activeHarness) ? p.activeHarness : base.activeHarness || "antigravity",
    sharedContracts: (Array.isArray(p.sharedContracts) ? p.sharedContracts : Array.isArray(p.contracts) ? p.contracts : [])
      .map((c) => (typeof c === "string" ? c : String(c?.path || "")))
      .filter(Boolean),
    lanes: (Array.isArray(p.lanes) && p.lanes.length ? p.lanes : PRESETS.blank.lanes).map(cloneLane),
    gates: rawGates.map(cloneGate),
  };
}

export function createComposer({ container, store = null, api = null, onCreated = null, onClose = null } = {}) {
  if (!container) throw new Error("createComposer requires a container element.");

  let draft = draftFrom("blank");
  let activePreset = "blank";
  let busy = false;
  let lastCheck = null;
  let refs = null;

  const dialog = h("div", { className: C.compRoot, role: "dialog", "aria-modal": "true", "aria-label": "Start a parallel build", tabindex: "-1" });
  const backdrop = h("div", { className: "od-comp-backdrop", hidden: true, "data-composer": "" }, dialog);
  backdrop.hidden = true;
  container.appendChild(backdrop);

  function onKey(ev) {
    if (ev.key === "Escape") {
      ev.preventDefault?.();
      ev.stopPropagation?.();
      close();
    } else if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault?.();
      submit();
    }
  }
  function onBackdropClick(ev) {
    if (ev?.target === backdrop) close();
  }
  dialog.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", onBackdropClick);

  function field(label, control, extra = null) {
    return h("label", { className: cls("od-comp-field", extra) }, h("span", null, label), control);
  }

  function input(value, attrs, onInput) {
    const el = h("input", { type: "text", spellcheck: "false", autocomplete: "off", ...attrs });
    el.value = String(value ?? "");
    el.addEventListener("input", () => onInput(el.value));
    return el;
  }

  function textarea(value, attrs, onInput) {
    const el = h("textarea", { spellcheck: "false", ...attrs });
    el.value = String(value ?? "");
    el.addEventListener("input", () => onInput(el.value));
    return el;
  }

  function select(options, value, attrs, onChange, labels = null) {
    const el = h(
      "select",
      attrs,
      options.map((o) => h("option", { value: o }, (labels && labels[o]) || o)),
    );
    el.value = value;
    el.addEventListener("change", () => onChange(el.value));
    return el;
  }

  function laneDisplayName(id) {
    const found = draft.lanes.find((l) => l.id.trim() === id);
    return found && found.title.trim() ? `${found.title.trim()} (${id})` : id;
  }

  function formatCollision(c) {
    if (c.kind === "contract_lane_overlap") {
      return `Overlap on shared file "${c.contract}": teammate ${laneDisplayName(c.laneId)} (${c.glob}) can't edit a file locked for everyone.`;
    }
    if (c.kind === "lane_lane_overlap") {
      return `Two teammates overlap on files: ${laneDisplayName(c.laneA)} (${c.globA}) and ${laneDisplayName(c.laneB)} (${c.globB}) both touch matching paths — give each teammate separate files.`;
    }
    return c.message;
  }

  function formatTopologyError(msg) {
    const s = String(msg || "");
    let m = s.match(/^Lane "([^"]+)" must define non-empty ownedGlobs\.$/);
    if (m) return `Teammate "${laneDisplayName(m[1])}" needs at least one file or folder pattern (like src/api/**).`;
    m = s.match(/^Lane "([^"]+)" must define a non-empty verifyCmd\.$/);
    if (m) return `Teammate "${laneDisplayName(m[1])}" needs a check command to verify its work (like node --test).`;
    m = s.match(/^Duplicate lane id "([^"]+)"\.$/);
    if (m) return `Two teammates share the short ID "${m[1]}" — please give each one a unique ID.`;
    m = s.match(/^Invalid lane id "([^"]*)":/);
    if (m) return `Short ID "${m[1]}" can only use lowercase letters, numbers, and hyphens (2–40 characters).`;
    return s;
  }

  function setStatus(text, tone = null) {
    if (!refs) return;
    refs.status.textContent = text || "";
    refs.status.className = cls("od-comp-status", C.muted, tone);
  }

  function showBanner(text, tone = "is-bad") {
    if (!refs) return;
    refs.banner.textContent = text ? String(text) : "";
    refs.banner.hidden = !text;
    refs.banner.className = cls(C.banner, tone);
  }

  function laneRow(lane, index) {
    const changed = (key) => (v) => {
      draft.lanes[index][key] = key === "ownedGlobs" ? splitList(v) : v;
      validate();
    };
    const idEl = input(lane.id, { className: C.mono, placeholder: "short-id", "aria-label": `Teammate ${index + 1} short ID`, "data-field": "id" }, changed("id"));
    const titleEl = input(lane.title, { placeholder: "Role or area", "aria-label": `Teammate ${index + 1} name`, "data-field": "title" }, changed("title"));
    const cx = select(COMPLEXITIES, lane.complexity, { "aria-label": `Teammate ${index + 1} effort`, "data-field": "complexity" }, changed("complexity"), COMPLEXITY_LABELS);
    const off = select(OFFLOADS, lane.offload, { "aria-label": `Teammate ${index + 1} machine`, "data-field": "offload" }, changed("offload"), OFFLOAD_LABELS);
    const rm = h(
      "button",
      {
        type: "button",
        className: cls(C.btn, C.btnGhost, C.btnDanger),
        "aria-label": `Remove teammate ${index + 1}`,
        "data-action": "remove-lane",
        disabled: draft.lanes.length <= 1,
        onClick: () => {
          if (draft.lanes.length <= 1) return;
          draft.lanes.splice(index, 1);
          render();
        },
      },
      "Remove",
    );
    const globs = textarea(
      lane.ownedGlobs.join("\n"),
      { className: C.mono, rows: "2", placeholder: "One folder or pattern per line, e.g. src/api/**", "aria-label": `Teammate ${index + 1} assigned files`, "data-field": "ownedGlobs" },
      changed("ownedGlobs"),
    );
    const verify = input(
      lane.verifyCmd,
      { className: C.mono, placeholder: "e.g. node --test test/api", "aria-label": `Teammate ${index + 1} verification command`, "data-field": "verifyCmd" },
      changed("verifyCmd"),
    );

    const metricNameIn = h("input", {
      type: "text",
      spellcheck: "false",
      placeholder: "Metric (e.g. parity)",
      "aria-label": `Teammate ${index + 1} ratchet metric name`,
      "data-field": "ratchetMetricName",
    });
    const metricDirSel = select(
      ["higher", "lower"],
      "higher",
      { "aria-label": `Teammate ${index + 1} ratchet direction`, "data-field": "ratchetMetricDir" },
      () => {},
      { higher: "Higher (>=)", lower: "Lower (<=)" },
    );
    const metricBaseIn = h("input", {
      type: "text",
      spellcheck: "false",
      placeholder: "Baseline (e.g. 94.2)",
      "aria-label": `Teammate ${index + 1} ratchet baseline`,
      "data-field": "ratchetMetricBaseline",
    });
    const ratchetEl = textarea(
      lane.ratchetText || "",
      {
        className: C.mono,
        rows: "2",
        placeholder: '{"metrics":[{"name":"parity","baseline":94.2,"op":">=","maxRegression":0}]}',
        "aria-label": `Teammate ${index + 1} metric ratchet JSON`,
        "data-field": "ratchetJson",
      },
      (v) => {
        draft.lanes[index].ratchetText = v;
        validate();
      },
    );
    const applyMetricBtn = h(
      "button",
      {
        type: "button",
        className: cls(C.btn, C.btnGhost),
        "data-action": "apply-ratchet-metric",
        onClick: () => {
          const name = metricNameIn.value.trim();
          const baseline = Number(metricBaseIn.value.trim());
          if (!name || !Number.isFinite(baseline)) {
            showBanner("Enter a metric name and numeric baseline first.");
            return;
          }
          const dir = metricDirSel.value === "lower" ? "lower" : "higher";
          let existing = null;
          if (ratchetEl.value.trim()) {
            try {
              const parsed = JSON.parse(ratchetEl.value);
              if (parsed && typeof parsed === "object" && Array.isArray(parsed.metrics)) existing = parsed;
            } catch {}
          }
          const entry = { name, direction: dir, op: dir === "lower" ? "<=" : ">=", baseline, maxRegression: 0 };
          const metrics = existing ? existing.metrics.filter((m) => m?.name !== name).concat(entry) : [entry];
          const nextSpec = { ...(existing || {}), metrics };
          const nextJson = JSON.stringify(nextSpec);
          ratchetEl.value = nextJson;
          draft.lanes[index].ratchetText = nextJson;
          showBanner("");
          validate();
        },
      },
      "+ Add metric",
    );
    const ratchetDetails = h(
      "details",
      { className: "od-comp-ratchet od-comp-wide", open: Boolean(lane.ratchetText) },
      h("summary", null, "Optional: Metric Ratchet & baseline"),
      h(
        "div",
        { className: "od-comp-ratchet-body" },
        h("div", { className: "od-comp-ratchet-helper" }, metricNameIn, metricDirSel, metricBaseIn, applyMetricBtn),
        field("Ratchet spec (JSON)", ratchetEl),
      ),
    );

    const row = h(
      "div",
      { className: C.compLaneRow, "data-lane-index": String(index) },
      idEl,
      titleEl,
      cx,
      off,
      rm,
      field("Files this teammate owns", globs, "od-comp-wide"),
      field("Verification check", verify, "od-comp-wide"),
      ratchetDetails,
    );
    return { row, idEl, globs, verify, ratchetEl };
  }

  function gateRow(gate, index) {
    const changed = (key) => (v) => {
      draft.gates[index][key] = key === "required" ? Boolean(v) : v;
      validate();
    };
    const idEl = input(gate.id, { className: C.mono, placeholder: "g1", "aria-label": `Check ${index + 1} ID`, "data-field": "gateId" }, changed("id"));
    const titleEl = input(gate.title, { placeholder: "Release check name", "aria-label": `Check ${index + 1} title`, "data-field": "gateTitle" }, changed("title"));
    const offEl = select(OFFLOADS, gate.offload, { "aria-label": `Check ${index + 1} machine`, "data-field": "gateOffload" }, changed("offload"), OFFLOAD_LABELS);
    const cmdEl = input(gate.cmd, { className: C.mono, placeholder: "npm test", "aria-label": `Check ${index + 1} command`, "data-field": "gateCmd" }, changed("cmd"));
    const rmBtn = h(
      "button",
      {
        type: "button",
        className: cls(C.btn, C.btnGhost, C.btnDanger),
        "aria-label": `Remove check ${index + 1}`,
        "data-action": "remove-gate",
        onClick: () => {
          draft.gates.splice(index, 1);
          render();
        },
      },
      "Remove",
    );
    return h(
      "div",
      { className: "od-comp-gate", "data-gate-index": String(index) },
      idEl,
      titleEl,
      offEl,
      rmBtn,
      field("Check command", cmdEl, "od-comp-wide"),
    );
  }

  function render() {
    clear(dialog);
    const isEditingTopology = Boolean(draft.editMissionId);
    const presetBtns = Object.entries(PRESETS).map(([key, p]) =>
      h(
        "button",
        {
          type: "button",
          className: cls(C.btn, C.btnGhost, activePreset === key && "is-active"),
          "data-preset": key,
          "aria-pressed": activePreset === key ? "true" : "false",
          onClick: () => load(key),
        },
        p.label,
      ),
    );
    const bar = h(
      "div",
      { className: C.compToolbar },
      h(
        "div",
        { className: "od-comp-head-copy" },
        h("div", { className: "od-comp-eyebrow" }, "Zero file conflicts by design"),
        h("h2", null, isEditingTopology ? "Update team & file plan" : "Start a parallel build"),
      ),
      h(
        "div",
        { className: "od-comp-bar-actions" },
        h(
          "button",
          { type: "button", className: cls(C.btn, C.btnGhost), "data-action": "seed-demo", title: "Load a ready-to-explore showcase build", onClick: () => seedDemo() },
          "Try Showcase Demo",
        ),
        h("button", { type: "button", className: cls(C.btn, C.btnGhost), "aria-label": "Close composer", "data-action": "close", onClick: () => close() }, "Close"),
      ),
    );

    const titleEl = input(draft.title, { placeholder: "e.g. Add theme switch and settings drawer", "data-field": "title", "aria-label": "Title" }, (v) => {
      draft.title = v;
      validate();
    });
    const goalEl = textarea(draft.goal, { rows: "3", placeholder: "Describe what should work when this build finishes…", "data-field": "goal", "aria-label": "What are you building?" }, (v) => {
      draft.goal = v;
      validate();
    });
    const repoEl = input(draft.repoRoot, { className: C.mono, placeholder: "e.g. ./my-project", "data-field": "repoRoot", "aria-label": "Project folder" }, (v) => {
      draft.repoRoot = v;
      validate();
    });
    if (isEditingTopology) {
      titleEl.disabled = true;
      goalEl.disabled = true;
      repoEl.disabled = true;
    }
    const modeEl = select(
      ROUTING_MODES,
      draft.routingMode,
      { "data-field": "routingMode", "aria-label": "How should models be chosen?" },
      (v) => {
        draft.routingMode = v;
        refs.harness.disabled = v !== "single-harness";
        validate();
      },
      ROUTING_LABELS,
    );
    const harnessEl = select(
      HARNESS_IDS,
      draft.activeHarness,
      { "data-field": "activeHarness", "aria-label": "Default AI app" },
      (v) => {
        draft.activeHarness = v;
      },
      HARNESS_LABELS,
    );
    harnessEl.disabled = draft.routingMode !== "single-harness";
    const contractsEl = textarea(
      draft.sharedContracts.join("\n"),
      { className: C.mono, rows: "2", placeholder: "Files kept locked so teammates never conflict, e.g. src/contracts.mjs", "data-field": "sharedContracts", "aria-label": "Shared files" },
      (v) => {
        draft.sharedContracts = splitList(v);
        validate();
      },
    );

    const lanes = draft.lanes.map((l, i) => laneRow(l, i));
    const addLane = h(
      "button",
      {
        type: "button",
        className: cls(C.btn, C.btnGhost),
        "data-action": "add-lane",
        onClick: () => {
          draft.lanes.push(cloneLane({ id: `lane-${draft.lanes.length + 1}` }));
          render();
        },
      },
      "+ Add teammate",
    );

    const gatesNodes = draft.gates.map((g, i) => gateRow(g, i));
    const addGate = h(
      "button",
      {
        type: "button",
        className: cls(C.btn, C.btnGhost),
        "data-action": "add-gate",
        onClick: () => {
          draft.gates.push(cloneGate({ id: `g${draft.gates.length + 1}`, title: "Release check", cmd: "npm test" }, draft.gates.length));
          render();
        },
      },
      "+ Add release check",
    );

    const issues = h("ul", { className: "od-comp-issues", "aria-live": "polite", "data-issues": "" });
    const banner = h("div", { className: C.banner, role: "alert", hidden: true, "data-banner": "" });
    banner.hidden = true;
    const routingNotice = h("div", { className: cls(C.banner, "is-warn"), role: "status", hidden: true, "data-routing-warning": "" });
    routingNotice.hidden = true;
    const status = h("span", { className: cls("od-comp-status", C.muted), "data-status": "" });
    const submitBtn = h("button", { type: "button", className: cls(C.btn, C.btnPrimary), "data-action": "submit", onClick: () => submit() }, isEditingTopology ? "Save Team Plan" : "Start Parallel Build");
    const cancelBtn = h("button", { type: "button", className: cls(C.btn, C.btnGhost), "data-action": "cancel", onClick: () => close() }, "Cancel");

    dialog.appendChild(bar);
    dialog.appendChild(
      h(
        "div",
        { className: "od-comp-presets", role: "group", "aria-label": "Templates" },
        h("span", { className: "od-comp-presets-label" }, "Start with:"),
        presetBtns,
      ),
    );
    dialog.appendChild(banner);
    dialog.appendChild(
      h(
        "div",
        { className: C.compSplit },
        h(
          "section",
          { className: "od-comp-section", "aria-label": "Build overview" },
          h(
            "div",
            { className: "od-comp-section-head" },
            h("h3", { className: "od-comp-section-title" }, "Overview"),
            h("p", { className: "od-comp-section-sub" }, "Set the goal, project folder, and how AI models are assigned."),
          ),
          field("Title", titleEl),
          field("What are you building?", goalEl),
          field("Project folder", repoEl),
          field("How should models be chosen?", modeEl),
          field("Default AI app", harnessEl),
          routingNotice,
          field("Shared locked files", contractsEl),
        ),
        h(
          "section",
          { className: "od-comp-section", "aria-label": "Teammates" },
          h(
            "div",
            { className: "od-comp-section-head" },
            h("h3", { className: "od-comp-section-title" }, "Teammates & file areas"),
            h("p", { className: "od-comp-section-sub" }, "Each teammate works in an isolated copy and only edits the files they own."),
          ),
          h("div", { className: C.compLaneList }, lanes.map((l) => l.row)),
          h("div", null, addLane),
          h(
            "div",
            { className: "od-comp-section-head" },
            h("h3", { className: "od-comp-section-title" }, "Final release checks"),
            h("p", { className: "od-comp-section-sub" }, "Checks that must pass once teammates finish before marking the build complete."),
          ),
          h("div", { className: C.compLaneList }, gatesNodes),
          h("div", null, addGate),
          issues,
        ),
      ),
    );
    dialog.appendChild(h("div", { className: "od-comp-foot" }, status, cancelBtn, submitBtn));

    refs = { title: titleEl, goal: goalEl, repo: repoEl, harness: harnessEl, routingNotice, contracts: contractsEl, lanes, issues, banner, status, submit: submitBtn };
    validate();
  }

  function topologyInput() {
    return {
      sharedContracts: draft.sharedContracts.map((path) => ({ path })),
      lanes: draft.lanes.map((l) => {
        const { ratchetText: _rt, ratchet, ...rest } = l;
        return {
          ...rest,
          ownedGlobs: [...l.ownedGlobs],
          ...(ratchet && typeof ratchet === "object" ? { ratchet: toPublicRatchetSpec(ratchet) } : {}),
        };
      }),
      gates: draft.gates.map((g, i) => ({
        id: String(g.id || `g${i + 1}`).trim() || `g${i + 1}`,
        title: String(g.title || g.id || `Check ${i + 1}`).trim(),
        cmd: String(g.cmd || "").trim(),
        offload: OFFLOADS.includes(g.offload) ? g.offload : "auto",
        required: g.required !== false,
      })),
    };
  }

  function validate() {
    const ratchetErrors = [];
    const badRatchetIdx = new Set();
    draft.lanes.forEach((lane, idx) => {
      const raw = String(lane.ratchetText || "").trim();
      if (!raw) {
        lane.ratchet = null;
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        const rCheck = validateRatchetSpec(parsed, { allowHoldout: false });
        if (!rCheck.ok) {
          lane.ratchet = null;
          badRatchetIdx.add(idx);
          ratchetErrors.push(`Teammate "${laneDisplayName(lane.id || `lane-${idx + 1}`)}" ratchet: ${rCheck.error}`);
        } else {
          lane.ratchet = toPublicRatchetSpec(parsed);
        }
      } catch (e) {
        lane.ratchet = null;
        badRatchetIdx.add(idx);
        ratchetErrors.push(`Teammate "${laneDisplayName(lane.id || `lane-${idx + 1}`)}" ratchet JSON invalid: ${e.message}`);
      }
    });

    const check = validateTopology(topologyInput());
    const fieldErrors = [];
    if (!draft.title.trim()) fieldErrors.push("Add a title for this build.");
    if (!draft.goal.trim()) fieldErrors.push("Describe what you are building.");
    if (!draft.repoRoot.trim()) fieldErrors.push("Enter the project folder path.");
    const ok = check.ok && fieldErrors.length === 0 && ratchetErrors.length === 0;
    lastCheck = {
      ok,
      topologyOk: check.ok,
      errors: [...check.errors, ...ratchetErrors],
      collisions: check.collisions,
      fieldErrors,
      normalized: check.normalized,
    };

    if (refs) {
      const hotLanes = new Set();
      let contractHot = false;
      for (const c of check.collisions) {
        if (c.kind === "lane_lane_overlap") {
          hotLanes.add(c.laneA);
          hotLanes.add(c.laneB);
        } else if (c.kind === "contract_lane_overlap") {
          hotLanes.add(c.laneId);
          contractHot = true;
        }
      }
      const seen = new Set();
      draft.lanes.forEach((lane, i) => {
        const r = refs.lanes[i];
        if (!r) return;
        const id = lane.id.trim();
        const hot = !seen.has(id) && hotLanes.has(id);
        seen.add(id);
        r.row.classList.toggle("is-collision", hot);
        r.globs.classList.toggle("is-collision", hot);
        r.ratchetEl?.classList?.toggle?.("is-collision", badRatchetIdx.has(i));
        const idBad = check.errors.some((e) => e.includes(`"${id}"`) && /lane id/i.test(e));
        r.idEl.classList.toggle("is-collision", idBad);
        r.row.setAttribute("aria-invalid", hot || idBad || badRatchetIdx.has(i) ? "true" : "false");
      });
      refs.contracts.classList.toggle("is-collision", contractHot);
      refs.title.classList.toggle("is-collision", !draft.title.trim());
      refs.goal.classList.toggle("is-collision", !draft.goal.trim());
      refs.repo.classList.toggle("is-collision", !draft.repoRoot.trim());
      if (refs.routingNotice) {
        const st = store?.getState?.();
        const warnings = Array.from(
          new Set(
            [
              ...(Array.isArray(st?.routingWarnings) ? st.routingWarnings : []),
              ...(Array.isArray(st?.fleet?.routingWarnings) ? st.fleet.routingWarnings : []),
            ].filter(Boolean),
          ),
        );
        const showRoutingWarn = draft.routingMode !== "single-harness" && warnings.length > 0;
        refs.routingNotice.hidden = !showRoutingWarn;
        clear(refs.routingNotice);
        if (showRoutingWarn) {
          refs.routingNotice.appendChild(h("span", null, warnings.join(" · ")));
        }
      }

      clear(refs.issues);
      for (const c of check.collisions) refs.issues.appendChild(h("li", { "data-kind": c.kind }, formatCollision(c)));
      for (const e of check.errors) refs.issues.appendChild(h("li", { "data-kind": "error" }, formatTopologyError(e)));
      for (const e of ratchetErrors) refs.issues.appendChild(h("li", { "data-kind": "ratchet" }, e));
      for (const e of fieldErrors) refs.issues.appendChild(h("li", { "data-kind": "field" }, e));

      refs.submit.disabled = busy || !ok;
      if (!busy) {
        if (check.collisions.length) setStatus(`${check.collisions.length} file overlap${check.collisions.length === 1 ? "" : "s"} — give each teammate separate files.`, "is-bad");
        else if (!ok) {
          const total = check.errors.length + ratchetErrors.length + fieldErrors.length;
          setStatus(`${total} detail${total === 1 ? "" : "s"} needed before starting.`, "is-warn");
        } else {
          setStatus(`${draft.lanes.length} teammate${draft.lanes.length === 1 ? "" : "s"} · No file overlaps`, "is-ok");
        }
      }
    }
    return lastCheck;
  }

  function payload() {
    const norm = lastCheck?.normalized;
    const briefById = new Map(draft.lanes.map((l) => [String(l.id || "").trim(), l.brief || ""]));
    const lanes = (norm ? norm.lanes : []).map((l) => ({
      ...l,
      brief: briefById.get(l.id) || l.brief || l.title,
    }));
    return {
      title: draft.title.trim(),
      goal: draft.goal.trim(),
      repoRoot: draft.repoRoot.trim(),
      routingMode: draft.routingMode,
      activeHarness: draft.activeHarness,
      sharedContracts: norm ? norm.sharedContracts : [],
      lanes,
      gates: norm ? norm.gates : [],
    };
  }

  async function postJson(url, body) {
    if (api && typeof api.post === "function") return api.post(url, body);
    const f = globalThis.fetch;
    if (typeof f !== "function") throw new Error("No API client available.");
    const res = await f(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }

  async function submit() {
    const check = validate();
    if (!check.ok) {
      showBanner(check.collisions.length ? "Two teammates overlap on files — each file can only belong to one teammate at a time." : "Fill in the highlighted fields before starting the build.");
      return { ok: false, check };
    }
    if (busy) return { ok: false, busy: true };
    busy = true;
    refs.submit.disabled = true;
    showBanner("");
    setStatus(draft.editMissionId ? "Saving team plan…" : "Starting build…");
    const body = payload();
    try {
      let res;
      if (draft.editMissionId) {
        const planBody = {
          routingMode: body.routingMode,
          activeHarness: body.activeHarness,
          sharedContracts: body.sharedContracts,
          lanes: body.lanes,
          gates: body.gates,
        };
        res =
          api && typeof api.planMission === "function"
            ? await api.planMission(draft.editMissionId, planBody)
            : await postJson(ROUTES.missionAction(draft.editMissionId, "plan"), planBody);
      } else {
        res = api && typeof api.createMission === "function" ? await api.createMission(body) : await postJson(ROUTES.missions(), body);
      }
      busy = false;
      if (res && res.ok === false) throw new Error(res.error || (res.errors || []).join("; ") || "Could not start build.");
      if (typeof onCreated === "function") onCreated(res, { payload: body, updated: Boolean(draft.editMissionId) });
      close();
      return { ok: true, result: res };
    } catch (e) {
      busy = false;
      showBanner(`Could not ${draft.editMissionId ? "save plan" : "start build"}: ${String(e?.message || e)}`);
      validate();
      return { ok: false, error: e };
    }
  }

  async function seedDemo() {
    if (busy) return { ok: false, busy: true };
    busy = true;
    showBanner("");
    setStatus("Loading showcase demo…");
    try {
      const res = api && typeof api.seedDemo === "function" ? await api.seedDemo() : await postJson(ROUTES.demoSeed(), {});
      busy = false;
      const v = validateDemoSeedResponse(res);
      if (!v.ok) throw new Error(v.error);
      if (typeof onCreated === "function") onCreated(res, { demo: true });
      close();
      return { ok: true, result: res };
    } catch (e) {
      busy = false;
      showBanner(`Could not load demo: ${String(e?.message || e)}`);
      validate();
      return { ok: false, error: e };
    }
  }

  function load(preset) {
    activePreset = typeof preset === "string" && preset in PRESETS ? preset : null;
    draft = draftFrom(preset, { repoRoot: draft.repoRoot, activeHarness: draft.activeHarness });
    render();
    return lastCheck;
  }

  function open(preset = "blank") {
    const st = store && typeof store.getState === "function" ? store.getState() || {} : {};
    const repoRoot = draft.repoRoot || st.repoRoot || "";
    activePreset = typeof preset === "string" && preset in PRESETS ? preset : null;
    draft = draftFrom(preset, { repoRoot, activeHarness: draft.activeHarness });
    busy = false;
    render();
    backdrop.hidden = false;
    if (refs?.title && typeof refs.title.focus === "function") refs.title.focus();
    return lastCheck;
  }

  function close() {
    const wasOpen = !backdrop.hidden;
    backdrop.hidden = true;
    if (wasOpen && typeof onClose === "function") onClose();
  }

  function destroy() {
    dialog.removeEventListener("keydown", onKey);
    backdrop.removeEventListener("click", onBackdropClick);
    clear(dialog);
    refs = null;
    if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
  }

  render();
  return {
    open,
    close,
    destroy,
    validate,
    submit,
    seedDemo,
    load,
    root: backdrop,
    get draft() {
      return draft;
    },
    get isOpen() {
      return !backdrop.hidden;
    },
  };
}
