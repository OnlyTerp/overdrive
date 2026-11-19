import { UI_CLASSES } from "./contracts.js";
import { renderDag } from "./dag.js";
import { h, setChildren, svg } from "./dom.js";
import { createPaletteController, renderShortcutsModal } from "./palette.js";
import { renderRsiView } from "./rsi-view.js";
import { createStudioStore, humanLaneStatus, humanMissionState, humanModelName } from "./store.js";
import { renderTimeline } from "./timeline.js";

function setVisible(el, show) {
  if (!el) return;
  el.hidden = !show;
  if (show) el.removeAttribute?.("hidden");
  else el.setAttribute?.("hidden", "");
}

function toneOfMissionState(s) {
  if (s === "completed") return "ok";
  if (["swarming", "verifying", "thinking", "frozen"].includes(s)) return "live";
  if (["escalated", "failed"].includes(s)) return "bad";
  if (s === "planned") return "warn";
  return "idle";
}

function isEditableElement(target) {
  if (!target || typeof target !== "object") return false;
  const tag = String(target.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

function makeAvatarSvg(index) {
  if (index % 3 === 0) {
    return svg(
      "svg",
      { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" },
      svg("path", { d: "M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3Z" }),
      svg("path", { d: "M9.5 19h5M10.5 21.5h3" }),
    );
  }
  if (index % 3 === 1) {
    return svg(
      "svg",
      { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" },
      svg("path", { d: "M6 3h9l4 4v14H6z" }),
      svg("path", { d: "M14 3v5h5M9.5 13h6M9.5 16.5h4" }),
    );
  }
  return svg(
    "svg",
    { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" },
    svg("circle", { cx: "12", cy: "12", r: "8" }),
    svg("path", { d: "m9.5 12 1.8 1.8 3.4-3.6" }),
  );
}

function buildProgressSvg(pct) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  return svg(
    "svg",
    { className: "od-progress-svg", viewBox: "0 0 100 6", preserveAspectRatio: "none", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(clamped)) },
    svg(
      "defs",
      null,
      svg(
        "linearGradient",
        { id: "od-prog-grad", x1: "0%", y1: "0%", x2: "100%", y2: "0%" },
        svg("stop", { offset: "0%", "stop-color": "var(--accent-2)" }),
        svg("stop", { offset: "100%", "stop-color": "var(--accent)" }),
      ),
    ),
    svg("rect", { className: "od-progress-track", x: "0", y: "0", width: "100", height: "6", rx: "3" }),
    svg("rect", { className: "od-progress-fill", x: "0", y: "0", width: String(clamped), height: "6", rx: "3" }),
  );
}

function createFallbackInspector({ container, store }) {
  let diffMode = "unified";
  let lastHunkIdx = 0;

  function render(state) {
    if (!container) return;
    const mission = state.activeMission;
    const lane = (mission?.lanes || []).find((l) => l.id === state.selectedLaneId) || null;

    if (!mission || !lane) {
      setChildren(
        container,
        h("p", { className: UI_CLASSES.muted }, "Choose any teammate to view their file changes, assigned scope, and verification checks."),
      );
      return;
    }

    const tabs = h(
      "div",
      { className: "od-insp-fallback-tabs", role: "tablist" },
      ["diff", "brief", "audit"].map((tab) =>
        h(
          "button",
          {
            type: "button",
            className: `od-tab ${state.inspectorTab === tab ? "is-active" : ""}`,
            onclick: () => store.setInspectorTab(tab),
          },
          tab === "diff" ? "Changes" : tab === "brief" ? "Assignment" : "Checks",
        ),
      ),
    );

    const actionRow = h(
      "div",
      { className: "od-btn-row" },
      h(
        "button",
        {
          type: "button",
          className: `${UI_CLASSES.btn} ${UI_CLASSES.btnPrimary} od-btn-xs`,
          onclick: async () => {
            try {
              await store.api.verifyLane(mission.id, lane.id, { runCmd: true });
              await store.refreshState(mission.id);
              store.toast(`Checks passed for "${lane.title || lane.id}"`, "ok");
            } catch (e) {
              store.toast(e.message, "bad");
            }
          },
        },
        "Check work",
      ),
      h(
        "button",
        {
          type: "button",
          className: `${UI_CLASSES.btn} ${UI_CLASSES.btnGhost} od-btn-xs`,
          onclick: async () => {
            try {
              await store.api.verifyLane(mission.id, lane.id, { runCmd: false });
              await store.refreshState(mission.id);
              store.toast(`File boundaries checked for "${lane.id}"`, "info");
            } catch (e) {
              store.toast(e.message, "bad");
            }
          },
        },
        "Check boundaries",
      ),
      h(
        "button",
        {
          type: "button",
          className: `${UI_CLASSES.btn} ${UI_CLASSES.btnGhost} od-btn-xs`,
          onclick: async () => {
            try {
              const res = await store.api.escalate(mission.id, { laneId: lane.id });
              store.dispatch({ adhdDetail: res.packet?.text || "", adhdDetailSessionId: res.packet?.requestId || lane.id });
              store.setView("adhd");
              await store.refreshState(mission.id);
            } catch (e) {
              store.toast(e.message, "bad");
            }
          },
        },
        "Send to research",
      ),
    );

    let bodyNode;
    if (state.inspectorTab === "brief") {
      bodyNode = h(
        "div",
        { className: "od-kv-list" },
        h("div", { className: "od-kv-row" }, h("span", { className: UI_CLASSES.muted }, "Teammate"), h("span", null, humanModelName(lane.worker))),
        h("div", { className: "od-kv-row" }, h("span", { className: UI_CLASSES.muted }, "Reviewer"), h("span", null, humanModelName(lane.verifier))),
        h("div", { className: "od-kv-row" }, h("span", { className: UI_CLASSES.muted }, "Assigned files"), h("span", { className: UI_CLASSES.mono }, (lane.ownedGlobs || []).join(", "))),
        h("div", { className: "od-kv-row" }, h("span", { className: UI_CLASSES.muted }, "Isolated copy"), h("span", { className: UI_CLASSES.mono }, lane.worktreePath || "Not created yet")),
        h("pre", { className: "od-code-box" }, lane.brief || lane.title || "No assignment notes."),
      );
    } else if (state.inspectorTab === "audit") {
      bodyNode = h(
        "div",
        { className: "od-kv-list" },
        h("div", { className: "od-kv-row" }, h("span", { className: UI_CLASSES.muted }, "Status"), h("span", null, humanLaneStatus(lane))),
        h("div", { className: "od-kv-row" }, h("span", { className: UI_CLASSES.muted }, "Stayed in bounds"), h("span", null, lane.scopeOk === true ? "Yes" : lane.scopeOk === false ? "No" : "Not checked")),
        h("pre", { className: "od-code-box" }, JSON.stringify(lane.lastVerify || { status: lane.status }, null, 2)),
      );
    } else {
      const files = state.diffData?.files || lane.lastVerify?.changedFiles || [];
      bodyNode = h(
        "div",
        { className: "od-kv-list" },
        h("div", { className: "od-kv-row" }, h("span", { className: UI_CLASSES.muted }, "Changed files"), h("span", { className: UI_CLASSES.tabular }, String(files.length))),
        files.length
          ? h("ul", { className: "od-list" }, files.map((f) => h("li", { className: `od-list-item ${UI_CLASSES.mono}` }, typeof f === "string" ? f : f.path)))
          : h("p", { className: UI_CLASSES.muted }, state.diffLoading ? "Loading file changes..." : "No file changes recorded yet."),
      );
    }

    setChildren(container, tabs, actionRow, bodyNode);
  }

  return {
    update: render,
    setDiffMode: (mode) => {
      diffMode = mode === "split" ? "split" : "unified";
      render(store.getState());
    },
    nextHunk: () => {
      lastHunkIdx += 1;
    },
    prevHunk: () => {
      lastHunkIdx = Math.max(0, lastHunkIdx - 1);
    },
    destroy: () => setChildren(container),
  };
}

function createFallbackComposer({ container, store, onCreated, onClose }) {
  let currentMode = "create";

  function render(preset = null) {
    if (!container) return;
    const mission = preset?.mission || store.getState().activeMission;
    currentMode = preset?.mode || (mission ? "topology" : "create");

    const titleIn = h("input", { className: "od-input", required: true, placeholder: "e.g. Core Engine Release" });
    const repoIn = h("input", { className: "od-input", required: true, placeholder: "e.g. ./my-project" });
    const goalIn = h("textarea", { className: "od-textarea", rows: "3", required: true, placeholder: "Describe what you want built and verified..." });
    const modeSel = h(
      "select",
      { className: "od-select" },
      h("option", { value: "single-harness" }, "Single app"),
      h("option", { value: "playbook-auto" }, "Smart auto-fleet"),
      h("option", { value: "mix-and-match" }, "Custom mix"),
    );
    const harnessSel = h(
      "select",
      { className: "od-select" },
      h("option", { value: "antigravity" }, "Antigravity"),
      h("option", { value: "claude" }, "Claude Code"),
      h("option", { value: "codex" }, "Codex"),
      h("option", { value: "devin" }, "Devin"),
    );
    const adhdIn = h("input", { className: "od-input", placeholder: "Optional research notebook ID" });

    const defaultTopo = mission
      ? {
          sharedContracts: (mission.contracts || []).map((c) => ({ path: c.path, description: c.description || "" })),
          lanes: (mission.lanes || []).map((l) => ({
            id: l.id,
            title: l.title,
            brief: l.brief,
            complexity: l.complexity,
            ownedGlobs: l.ownedGlobs,
            verifyCmd: l.verifyCmd,
            offload: l.offload,
          })),
          gates: (mission.gates || []).map((g) => ({ id: g.id, title: g.title, cmd: g.cmd, offload: g.offload, required: g.required })),
        }
      : {
          sharedContracts: [{ path: "src/contracts.mjs", description: "Shared interface" }],
          lanes: [
            { id: "core", title: "Core engine", complexity: "hard", ownedGlobs: ["src/core/**"], verifyCmd: "node --test", offload: "auto" },
            { id: "ui", title: "User interface", complexity: "fast", ownedGlobs: ["ui/**"], verifyCmd: "node --test", offload: "local" },
          ],
          gates: [{ id: "g1", title: "Full test suite", cmd: "npm test", offload: "auto", required: true }],
        };

    const topoArea = h("textarea", { className: "od-textarea", rows: "10", spellcheck: "false" });
    topoArea.value = JSON.stringify(defaultTopo, null, 2);
    const validationBox = h("div", { className: "od-kv-list" }, h("span", { className: UI_CLASSES.muted }, "Check that teammates have non-overlapping file areas before saving."));

    async function runValidate() {
      if (!mission) {
        setChildren(validationBox, h("span", { className: UI_CLASSES.muted }, "Create a build first to check file boundaries."));
        return { ok: false };
      }
      try {
        const payload = JSON.parse(topoArea.value);
        payload.routingMode = modeSel.value || mission.routingMode;
        const res = await store.api.validateTopology(mission.id, payload);
        if (!res.ok) {
          setChildren(
            validationBox,
            ...[...(res.errors || []), ...(res.collisions || []).map((c) => c.message)].map((msg) =>
              h("div", { className: "od-list-item" }, msg),
            ),
          );
        } else {
          setChildren(
            validationBox,
            ...(res.routing?.lanes || []).map((l) =>
              h("div", { className: "od-list-item" }, `${l.title || l.id}: ${humanModelName(l.worker)}`),
            ),
          );
        }
        return res;
      } catch (e) {
        setChildren(validationBox, h("div", { className: "od-list-item" }, e.message));
        return { ok: false, error: e.message };
      }
    }

    const createForm = h(
      "form",
      {
        className: "od-composer-card od-glass",
        onsubmit: async (ev) => {
          ev.preventDefault();
          try {
            const res = await store.api.createMission({
              title: titleIn.value.trim(),
              repoRoot: repoIn.value.trim(),
              goal: goalIn.value.trim(),
              routingMode: modeSel.value,
              activeHarness: harnessSel.value,
              adhdSessionId: adhdIn.value.trim() || null,
            });
            onCreated?.(res);
          } catch (e) {
            store.toast(e.message, "bad");
          }
        },
      },
      h(
        "div",
        { className: "od-modal-head" },
        h("div", null, h("div", { className: "od-eyebrow" }, "Build composer"), h("h2", null, currentMode === "topology" && mission ? `Plan team · ${mission.title}` : "Start a new build")),
        h(
          "div",
          { className: "od-btn-row" },
          mission
            ? h(
                "button",
                {
                  type: "button",
                  className: "od-ghost-btn od-btn-xs",
                  onclick: () => render({ mode: currentMode === "create" ? "topology" : "create", mission }),
                },
                currentMode === "create" ? "Plan active build" : "New build form",
              )
            : null,
          h("button", { type: "button", className: "od-ghost-btn od-btn-xs", onclick: () => onClose?.() }, "Close (Esc)"),
        ),
      ),
      currentMode === "create"
        ? h(
            "div",
            { className: "od-composer-create-fields" },
            h("div", { className: "od-form-grid" },
              h("label", { className: "od-field" }, "Build name", titleIn),
              h("label", { className: "od-field" }, "Project folder", repoIn),
              h("label", { className: "od-field" }, "Team routing", modeSel),
              h("label", { className: "od-field" }, "Primary app", harnessSel),
            ),
            h("label", { className: "od-field od-mt-sm" }, "What are we building?", goalIn),
            h("label", { className: "od-field od-mt-sm" }, "Linked research notebook (optional)", adhdIn),
            h("div", { className: "od-btn-row od-mt-md" }, h("button", { type: "submit", className: "od-primary" }, "Create build ↗")),
          )
        : h(
            "div",
            { className: "od-composer-topo-fields" },
            h("label", { className: "od-field" }, "Team & file plan (JSON)", topoArea),
            h(
              "div",
              { className: "od-btn-row od-mt-sm" },
              h("button", { type: "button", className: `${UI_CLASSES.btn} ${UI_CLASSES.btnGhost}`, onclick: () => void runValidate() }, "Check for overlaps"),
              h(
                "button",
                {
                  type: "button",
                  className: "od-primary",
                  onclick: async () => {
                    if (!mission) return;
                    try {
                      const payload = JSON.parse(topoArea.value);
                      payload.routingMode = modeSel.value || mission.routingMode;
                      const res = await store.api.planMission(mission.id, payload);
                      onCreated?.(res);
                    } catch (e) {
                      store.toast(e.message, "bad");
                    }
                  },
                },
                "Save team plan",
              ),
            ),
            h("div", { className: "od-mt-sm" }, validationBox),
          ),
    );

    setChildren(container, createForm);
  }

  return {
    open: (preset = null) => render(preset),
    close: () => {
      setChildren(container);
      onClose?.();
    },
    validate: () => ({ ok: true }),
    destroy: () => setChildren(container),
  };
}

/** Dispatch global and workspace keyboard shortcuts cleanly against `SHORTCUTS`. */
export function handleKeydown(ev, { store, palette, composerCtrl, actions }) {
  const s = store.getState();
  const key = ev.key;
  const lower = typeof key === "string" ? key.toLowerCase() : "";

  if ((ev.ctrlKey || ev.metaKey) && lower === "k") {
    ev.preventDefault();
    store.togglePalette();
    return true;
  }

  if (key === "Escape") {
    if (s.paletteOpen || palette.isOpen()) {
      ev.preventDefault();
      store.togglePalette(false);
      return true;
    }
    if (s.shortcutsOpen) {
      ev.preventDefault();
      store.toggleShortcuts(false);
      return true;
    }
    if (s.armedAction) {
      ev.preventDefault();
      store.cancelArmedAction();
      return true;
    }
    if (s.composerOpen) {
      ev.preventDefault();
      composerCtrl?.close?.();
      store.closeComposer();
      return true;
    }
    if (s.inspectorWide) {
      ev.preventDefault();
      store.toggleInspectorWide(false);
      return true;
    }
    return false;
  }

  if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
  if (isEditableElement(ev.target)) return false;

  if (key === "?") {
    ev.preventDefault();
    store.toggleShortcuts();
    return true;
  }

  if (palette.isOpen() || s.shortcutsOpen || (s.composerOpen && s.composerMode !== "view")) return false;

  if (key === "1") {
    ev.preventDefault();
    store.setView("map");
    return true;
  }
  if (key === "2") {
    ev.preventDefault();
    actions.openComposerView();
    return true;
  }
  if (key === "3") {
    ev.preventDefault();
    store.setView("contracts");
    return true;
  }
  if (key === "4") {
    ev.preventDefault();
    store.setView("adhd");
    return true;
  }
  if (key === "5") {
    ev.preventDefault();
    if (actions?.openRsiView) actions.openRsiView();
    else store.setView("rsi");
    return true;
  }
  if (key === "j" || key === "ArrowDown") {
    ev.preventDefault();
    store.stepLane(1);
    return true;
  }
  if (key === "k" || key === "ArrowUp") {
    ev.preventDefault();
    store.stepLane(-1);
    return true;
  }
  if (key === "Enter" || key === " ") {
    if (key === "Enter" && s.armedAction) {
      ev.preventDefault();
      void store.confirmArmedAction();
      return true;
    }
    const tag = String(ev.target?.tagName || "").toUpperCase();
    if (tag === "BUTTON" || tag === "A" || tag === "SELECT") return false;
    if (s.selectedLaneId) {
      ev.preventDefault();
      store.toggleInspector(true);
      return true;
    }
    return false;
  }
  if (lower === "d") {
    ev.preventDefault();
    store.setWorkspaceSubTab("files");
    return true;
  }
  if (lower === "b") {
    ev.preventDefault();
    store.toggleInspector(true);
    store.setInspectorTab("brief");
    return true;
  }
  if (lower === "a") {
    ev.preventDefault();
    store.toggleInspector(true);
    store.setInspectorTab("audit");
    return true;
  }
  if (lower === "w") {
    ev.preventDefault();
    store.toggleInspector(true);
    store.toggleInspectorWide();
    return true;
  }
  if (lower === "v") {
    ev.preventDefault();
    actions.armVerifyFocusedLane();
    return true;
  }
  if (lower === "f") {
    ev.preventDefault();
    store.toggleFocusFailure();
    return true;
  }
  if (lower === "e") {
    ev.preventDefault();
    void actions.escalate();
    return true;
  }
  if (lower === "g") {
    ev.preventDefault();
    store.setWorkspaceSubTab("graph");
    actions.armGateReview();
    return true;
  }
  if (key === ",") {
    ev.preventDefault();
    store.stepTimeline(-1);
    return true;
  }
  if (key === ".") {
    ev.preventDefault();
    store.stepTimeline(1);
    return true;
  }
  if (lower === "l") {
    ev.preventDefault();
    store.jumpTimelineLive();
    return true;
  }
  if (key === "[") {
    ev.preventDefault();
    store.toggleRail();
    return true;
  }
  if (key === "]") {
    ev.preventDefault();
    store.toggleInspector();
    return true;
  }
  if (lower === "t") {
    ev.preventDefault();
    store.toggleTimeline();
    return true;
  }

  return false;
}

/** Boot and mount Overdrive Build Studio against `doc`. */
export async function createStudioApp({ doc = globalThis.document, store: injectedStore, modules = null } = {}) {
  const $ = (id) => doc.getElementById(id);
  const store = injectedStore || createStudioStore({ doc });

  const shellEl = $("od-shell");
  const railEl = $("mission-rail");
  const inspectorDrawer = $("inspector-drawer");
  const inspectorRoot = $("inspector-root");
  const timelineDock = $("timeline-dock");
  const timelineRoot = $("timeline-root");
  const dagRoot = $("dag-root");
  const rsiRoot = $("rsi-root") || $("panel-rsi");
  const composerSlot = $("composer-slot");
  const paletteRoot = $("palette-root");
  const shortcutsRoot = $("shortcuts-root");
  const toastStack = $("toast-stack");

  const loadedModules = modules || (await Promise.all([
    import("./inspector.js").catch(() => null),
    import("./composer.js").catch(() => null),
  ]));
  const [inspectorMod, composerMod] = loadedModules;

  const inspectorCtrl =
    inspectorMod?.createInspector?.({
      container: inspectorRoot,
      store,
      api: store.api,
      onSelectLane: (laneId) => store.selectLane(laneId),
      onClose: () => store.toggleInspector(false),
      showClose: false,
    }) || createFallbackInspector({ container: inspectorRoot, store });

  const handleComposerCreated = async (res) => {
    const createdId = res?.mission?.id || res?.id || res?.missionId || store.getState().missionId;
    store.closeComposer();
    store.setView("map");
    if (createdId) await store.refreshState(createdId);
    store.toast("Build updated", "ok");
  };

  const handleComposerClose = () => {
    store.closeComposer();
  };

  const composerCtrl =
    composerMod?.createComposer?.({
      container: composerSlot,
      store,
      api: store.api,
      onCreated: handleComposerCreated,
      onClose: handleComposerClose,
    }) ||
    createFallbackComposer({
      container: composerSlot,
      store,
      onCreated: handleComposerCreated,
      onClose: handleComposerClose,
    });

  const palette = createPaletteController({
    container: paletteRoot,
    onClose: () => store.dispatch({ paletteOpen: false }),
  });

  async function verifyLaneNow(laneId, targetMissionId = null) {
    const mission =
      (targetMissionId && (store.getState().missions || []).find((m) => m.id === targetMissionId)) ||
      store.getState().activeMission;
    const mid = targetMissionId || mission?.id;
    if (!mid || !laneId) return;
    try {
      const out = await store.api.verifyLane(mid, laneId, { runCmd: true });
      await store.refreshState(mid);
      store.toast(out.result?.ok ? `Checks passed for "${laneId}"` : `Checks failed for "${laneId}"`, out.result?.ok ? "ok" : "bad");
    } catch (e) {
      store.toast(e.message, "bad");
    }
  }

  async function runGateNow(gateId, targetMissionId = null) {
    const mid = targetMissionId || store.getState().activeMission?.id;
    if (!mid || !gateId) return;
    try {
      const out = await store.api.runGate(mid, gateId, {});
      await store.refreshState(mid);
      store.toast(out.result?.ok ? `Release check "${gateId}" passed` : `Release check "${gateId}" failed`, out.result?.ok ? "ok" : "bad");
    } catch (e) {
      store.toast(e.message, "bad");
    }
  }

  async function runAllGatesNow(targetMissionId = null) {
    const s = store.getState();
    const mission =
      (targetMissionId && s.activeMission?.id === targetMissionId ? s.activeMission : null) ||
      s.activeMission;
    const mid = targetMissionId || mission?.id;
    const gates = mission?.gates || [];
    if (!mid || !gates.length) return;
    try {
      const failed = [];
      for (const g of gates) {
        const out = await store.api.runGate(mid, g.id, {});
        if (!out?.result?.ok) failed.push(g.title || g.id);
      }
      await store.refreshState(mid);
      if (failed.length) {
        store.toast(`Release check${failed.length > 1 ? "s" : ""} failed: ${failed.join(", ")}`, "bad");
      } else {
        store.toast("All release checks passed", "ok");
      }
    } catch (e) {
      store.toast(e.message, "bad");
    }
  }

  async function freezeNow() {
    const mission = store.getState().activeMission;
    if (!mission) return;
    try {
      await store.api.freezeMission(mission.id, { provisionWorktrees: true });
      await store.refreshState(mission.id);
      store.toast("Shared rules locked and isolated workspaces ready", "ok");
    } catch (e) {
      store.toast(e.message, "bad");
    }
  }

  async function escalateNow() {
    const s = store.getState();
    const mission = s.activeMission;
    if (!mission) return;
    try {
      const res = await store.api.escalate(mission.id, { laneId: s.selectedLaneId || null });
      store.dispatch({
        adhdDetail: res.packet?.text || "",
        adhdDetailSessionId: res.packet?.requestId || mission.slug,
      });
      store.setView("adhd");
      await store.refreshState(mission.id);
      store.toast("Failure note prepared for review", "warn");
    } catch (e) {
      store.toast(e.message, "bad");
    }
  }

  const actions = {
    seedShowcase: () => store.seedShowcase(),
    openNewMission: () => {
      store.openComposer({ mode: "create" }, "overlay");
      composerCtrl.open({ mode: "create" });
    },
    openComposerView: () => {
      const m = store.getState().activeMission;
      store.setView("composer");
      store.openComposer({ mode: m ? "topology" : "create", mission: m }, "view");
      composerCtrl.open({ mode: m ? "topology" : "create", mission: m });
    },
    toggleTheme: () => store.toggleTheme(),
    toggleShortcuts: () => store.toggleShortcuts(),
    setView: (v) => store.setView(v),
    openRsiView: () => {
      store.setView("rsi");
      const st = store.getState();
      if (st.token && !st.rsi?.overview && !st.rsi?.loading) {
        void store.loadRsiOverview({ quiet: true });
      }
    },
    scanRsi: () => void store.scanRsi(),
    runRsiBenchmark: () => void store.runRsiCycle(null),
    runRsiCycle: (candidateId) => void store.runRsiCycle(candidateId),
    armPromoteRsi: (cand) => {
      if (!cand?.id) return;
      store.armAction({
        id: `rsi.promote:${cand.id}`,
        candidateId: cand.id,
        label: `Apply upgrade "${cand.title || cand.id}" — press Enter to confirm, Esc to cancel`,
        execute: () => store.promoteRsi(cand.id),
      });
    },
    armRollbackRsi: (cand) => {
      if (!cand?.id) return;
      store.armAction({
        id: `rsi.rollback:${cand.id}`,
        candidateId: cand.id,
        label: `Undo upgrade "${cand.title || cand.id}" — press Enter to confirm, Esc to cancel`,
        execute: () => store.rollbackRsi(cand.id),
      });
    },
    integrateMission: (id) => void store.integrateMission(id),
    toggleRail: () => store.toggleRail(),
    toggleInspector: () => store.toggleInspector(),
    toggleTimeline: () => store.toggleTimeline(),
    toggleInspectorWide: () => store.toggleInspectorWide(),
    toggleFocusFailure: () => store.toggleFocusFailure(),
    jumpTimelineLive: () => store.jumpTimelineLive(),
    setInspectorTab: (tab) => {
      store.toggleInspector(true);
      store.setInspectorTab(tab);
    },
    selectMission: (id) => store.refreshState(id),
    selectLane: (id) => store.selectLane(id),
    freezeMission: freezeNow,
    runAllGates: runAllGatesNow,
    verifyLane: verifyLaneNow,
    escalate: escalateNow,
    armVerifyFocusedLane: () => {
      const s = store.getState();
      if (!s.activeMission || !s.selectedLaneId) return;
      const lockedMissionId = s.activeMission.id;
      const lockedLaneId = s.selectedLaneId;
      store.armAction({
        id: "lane.verify",
        missionId: lockedMissionId,
        laneId: lockedLaneId,
        label: `Run checks for teammate "${lockedLaneId}" — press Enter to confirm, Esc to cancel`,
        execute: () => verifyLaneNow(lockedLaneId, lockedMissionId),
      });
    },
    armGateReview: () => {
      const s = store.getState();
      if (!s.activeMission || !(s.activeMission.gates || []).length) return;
      const lockedMissionId = s.activeMission.id;
      store.armAction({
        id: "gates.review",
        missionId: lockedMissionId,
        label: `Run ${s.activeMission.gates.length} release check(s) — press Enter to confirm, Esc to cancel`,
        execute: () => runAllGatesNow(lockedMissionId),
      });
    },
  };

  function renderStepper(mission) {
    const order = ["thinking", "planned", "frozen", "swarming", "completed"];
    const cur =
      mission?.state === "verifying" ? "swarming" :
      mission?.state === "escalated" ? "thinking" :
      mission?.state || "draft";
    const curIdx = order.indexOf(cur);
    for (const stNode of doc.querySelectorAll?.(".od-step") || []) {
      const idx = order.indexOf(stNode.dataset?.stage);
      stNode.classList?.toggle?.("active", idx === curIdx);
      stNode.classList?.toggle?.("done", idx >= 0 && curIdx > idx);
    }
    const stThink = $("st-think");
    const stPlan = $("st-plan");
    const stFreeze = $("st-freeze");
    const stSwarm = $("st-swarm");
    const stGates = $("st-gates");
    if (!mission) {
      if (stThink) stThink.textContent = "Research";
      if (stPlan) stPlan.textContent = "File split";
      if (stFreeze) stFreeze.textContent = "Rule lock";
      if (stSwarm) stSwarm.textContent = "0/0 verified";
      if (stGates) stGates.textContent = "0/0 passed";
      return;
    }
    const lanes = mission.lanes || [];
    const contracts = mission.contracts || [];
    const gates = mission.gates || [];
    if (stThink) stThink.textContent = mission.adhdSessionId ? "Linked" : "Ready";
    if (stPlan) stPlan.textContent = `${lanes.length} teammate${lanes.length === 1 ? "" : "s"}`;
    if (stFreeze) stFreeze.textContent = mission.freezeCommit ? `${contracts.length} locked` : "Unlocked";
    const verCount = lanes.filter((l) => l.status === "verified").length;
    if (stSwarm) stSwarm.textContent = `${verCount}/${lanes.length} verified`;
    const passGates = gates.filter((g) => g.status === "passed").length;
    if (stGates) stGates.textContent = `${passGates}/${gates.length} passed`;
  }

  function renderRail(state) {
    const mList = $("rail-missions-list");
    const lList = $("rail-lanes-list");
    const mCount = $("rail-missions-count");
    const lCount = $("rail-lanes-count");
    const goalText = $("rail-goal-text");
    const railCta = $("btn-rail-cta");

    const missions = state.missions || [];
    const active = state.activeMission;
    if (mCount) mCount.textContent = String(missions.length);
    if (lCount) lCount.textContent = String((active?.lanes || []).length);
    if (goalText) {
      goalText.textContent = active ? active.goal : "Turn deep thinking into coordinated, conflict-free software builds.";
    }
    if (railCta) {
      if (!active) {
        railCta.textContent = "Explore sample build ↗";
      } else if (active.state === "planned") {
        railCta.textContent = "Lock rules & start team ↗";
      } else if (["frozen", "swarming", "verifying"].includes(active.state)) {
        railCta.textContent = "Run release checks ↗";
      } else if (active.state === "completed") {
        railCta.textContent = "Start a new build ↗";
      } else {
        railCta.textContent = "Plan team & files ↗";
      }
    }

    if (mList) {
      setChildren(
        mList,
        missions.length > 1
          ? missions.map((m) =>
              h(
                "li",
                null,
                h(
                  "button",
                  {
                    type: "button",
                    className: `od-rail-item ${active?.id === m.id ? "is-selected" : ""}`,
                    onclick: () => void store.refreshState(m.id),
                  },
                  h("span", { className: "od-rail-item-title" }, m.title),
                  h("span", { className: UI_CLASSES.badge }, humanMissionState(m.state)),
                ),
              ),
            )
          : [],
      );
    }

    if (lList) {
      const lanes = active?.lanes || [];
      if (!lanes.length) {
        setChildren(lList, h("p", { className: UI_CLASSES.muted }, "Teammates appear here once planned."));
      } else {
        const items = [];
        lanes.forEach((l, idx) => {
          const isActive = l.status === "active" || ((active?.state === "swarming" || active?.state === "verifying") && l.status !== "verified" && l.status !== "failed");
          const isDone = l.status === "verified";
          const isFail = l.status === "failed" || l.scopeOk === false;
          const isSel = state.selectedLaneId === l.id;
          const cls = [
            "od-agent",
            isActive ? "is-active" : "",
            isDone ? "is-done" : "",
            isFail ? "is-fail" : "",
            isSel ? "is-selected" : "",
          ]
            .filter(Boolean)
            .join(" ");

          if (idx > 0) {
            items.push(h("div", { className: "od-handoff", "aria-hidden": "true" }, h("span", null, "separate files")));
          }
          items.push(
            h(
              "button",
              {
                type: "button",
                className: cls,
                onclick: () => store.selectLane(l.id),
              },
              h("span", { className: "od-avatar" }, makeAvatarSvg(idx)),
              h(
                "div",
                { className: "od-agent-body" },
                h(
                  "div",
                  { className: "od-agent-name" },
                  h("span", null, l.title || l.id),
                  h("span", { className: "od-agent-role" }, l.complexity === "hard" ? "deep build" : "builds"),
                ),
                h("div", { className: "od-agent-model" }, humanModelName(l.worker)),
                h(
                  "div",
                  { className: "od-agent-status" },
                  h("i", { "aria-hidden": "true" }),
                  h("span", null, humanLaneStatus(l)),
                ),
              ),
            ),
          );
        });
        setChildren(lList, items);
      }
    }
  }

  function renderSummaryCard(state) {
    const m = state.activeMission;
    const lanes = m?.lanes || [];
    const contracts = m?.contracts || [];
    const gates = m?.gates || [];
    const verified = lanes.filter((l) => l.status === "verified").length;
    const passedGates = gates.filter((g) => g.status === "passed").length;

    const clockEl = $("summary-clock");
    const capEl = $("summary-caption");
    const progHost = $("summary-progress-host");
    const factTeam = $("fact-team");
    const factConf = $("fact-conflicts");
    const factRules = $("fact-rules");
    const factChecks = $("fact-checks");

    if (clockEl) clockEl.textContent = m ? `${verified} / ${lanes.length}` : "—";
    if (capEl) capEl.textContent = m ? "Teammates verified" : "No active build";
    if (progHost) {
      const pct = lanes.length ? (verified / lanes.length) * 100 : 0;
      setChildren(progHost, buildProgressSvg(pct));
    }
    if (factTeam) factTeam.textContent = m ? `${lanes.length} isolated` : "0";
    if (factConf) {
      const hasScopeFail = lanes.some((l) => l.scopeOk === false);
      factConf.textContent = hasScopeFail ? "Boundary alert" : "None";
    }
    if (factRules) {
      factRules.textContent = m?.freezeCommit ? `${contracts.length} locked` : `${contracts.length} planned`;
    }
    if (factChecks) factChecks.textContent = `${passedGates} of ${gates.length} passed`;
  }

  function renderContractsAndFleet(state) {
    const m = state.activeMission;
    const freezeTag = $("freeze-commit-tag");
    const gatesTag = $("gates-summary-tag");
    const cList = $("contracts-list");
    const gList = $("gates-list");

    if (freezeTag) freezeTag.textContent = m?.freezeCommit ? `Locked · ${m.freezeCommit.slice(0, 7)}` : "Not locked";
    if (gatesTag) {
      const passed = (m?.gates || []).filter((g) => g.status === "passed").length;
      gatesTag.textContent = `${passed} / ${(m?.gates || []).length}`;
    }

    if (cList) {
      setChildren(
        cList,
        (m?.contracts || []).length
          ? m.contracts.map((c) =>
              h(
                "li",
                { className: "od-list-item" },
                h("span", { className: UI_CLASSES.mono }, c.path),
                h("span", { className: `${UI_CLASSES.badge} is-${c.sha256 ? "pass" : "idle"}` }, c.sha256 ? "Locked" : "Pending"),
              ),
            )
          : [h("li", { className: UI_CLASSES.muted }, "No shared rule files in this build.")],
      );
    }

    if (gList) {
      setChildren(
        gList,
        (m?.gates || []).length
          ? m.gates.map((g) =>
              h(
                "li",
                { className: "od-list-item" },
                h("div", null, h("strong", null, g.title || g.id), h("div", { className: `${UI_CLASSES.mono} ${UI_CLASSES.muted}` }, g.cmd)),
                h(
                  "div",
                  { className: "od-btn-row" },
                  h("span", { className: `${UI_CLASSES.badge} is-${g.status === "passed" ? "pass" : g.status === "failed" ? "fail" : "idle"}` }, g.status === "passed" ? "Passed" : g.status === "failed" ? "Failed" : "Waiting"),
                  h("button", { type: "button", className: "od-ghost-btn od-btn-xs", onclick: () => void runGateNow(g.id) }, "Run check"),
                ),
              ),
            )
          : [h("li", { className: UI_CLASSES.muted }, "No release checks defined.")],
      );
    }

    const f = state.fleet || {};
    const mcpPre = $("manual-mcp-pre");
    if (mcpPre) mcpPre.textContent = JSON.stringify(state.manualConfig || {}, null, 2);

    const degradedNote = $("fleet-degraded-note");
    if (degradedNote) {
      const degraded = Array.isArray(state.degradedAccounts)
        ? state.degradedAccounts
        : Array.isArray(f.degradedAccounts)
          ? f.degradedAccounts
          : [];
      const warnings = Array.from(
        new Set(
          [
            ...(Array.isArray(state.routingWarnings) ? state.routingWarnings : []),
            ...(Array.isArray(m?.routingWarnings) ? m.routingWarnings : []),
            ...(Array.isArray(f.routingWarnings) ? f.routingWarnings : []),
          ].filter(Boolean),
        ),
      );
      const hasNotice = degraded.length > 0 || warnings.length > 0;
      setVisible(degradedNote, hasNotice);
      if (hasNotice) {
        const degList = degraded
          .slice(0, 6)
          .map((d) => `${d.accountId} (${d.reason})`)
          .join(", ");
        const summary = [
          ...warnings,
          degList ? `Excluded: ${degList}${degraded.length > 6 ? `, +${degraded.length - 6} more` : ""}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        setChildren(degradedNote, h("strong", null, "Pool health notice"), h("span", null, summary));
      } else {
        setChildren(degradedNote);
      }
    }

    const fleetGrid = $("fleet-grid");
    if (fleetGrid) {
      setChildren(
        fleetGrid,
        Object.entries(f.harnesses || {}).map(([id, info]) =>
          h(
            "div",
            { className: "od-fleet-card" },
            h(
              "div",
              { className: "od-card-head" },
              h("strong", null, info.name || id),
              h("span", { className: `${UI_CLASSES.badge} is-${info.installed ? "pass" : "idle"}` }, info.installed ? "Connected" : "Not found"),
            ),
            h("div", { className: UI_CLASSES.muted }, `Models: ${(info.models || []).map((model) => humanModelName({ model })).join(", ")}`),
          ),
        ),
      );
    }
  }

  function renderAdhdPanel(state) {
    const adhd = state.adhd || { available: false, sessions: [] };
    const dirTag = $("adhd-dir-tag");
    if (dirTag) dirTag.textContent = adhd.available ? "Connected" : "Not found";

    const listEl = $("adhd-sessions-list");
    if (listEl) {
      setChildren(
        listEl,
        (adhd.sessions || []).length
          ? adhd.sessions.map((s) =>
              h(
                "li",
                { className: "od-list-item" },
                h(
                  "div",
                  null,
                  h("strong", null, String(s.goal || "").slice(0, 100)),
                  h("div", { className: `${UI_CLASSES.muted} ${UI_CLASSES.tabular}` }, `${s.sourceCount} rounds · ${s.state}`),
                ),
                h(
                  "div",
                  { className: "od-btn-row" },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "od-ghost-btn od-btn-xs",
                      onclick: async () => {
                        try {
                          const det = await store.api.getAdhdSession(s.id);
                          store.dispatch({
                            adhdDetailSessionId: `${s.sourceCount} rounds`,
                            adhdDetail: det.markdownExcerpt || det.latestRevision?.markdown || "(empty)",
                          });
                        } catch (e) {
                          store.toast(e.message, "bad");
                        }
                      },
                    },
                    "Read",
                  ),
                  state.activeMission
                    ? h(
                        "button",
                        {
                          type: "button",
                          className: `${UI_CLASSES.btn} ${UI_CLASSES.btnPrimary} od-btn-xs`,
                          onclick: async () => {
                            try {
                              await store.api.updateSettings(state.activeMission.id, { adhdSessionId: s.id });
                              await store.refreshState(state.activeMission.id);
                              store.toast("Linked research notebook", "ok");
                            } catch (e) {
                              store.toast(e.message, "bad");
                            }
                          },
                        },
                        "Link",
                      )
                    : null,
                ),
              ),
            )
          : [h("li", { className: UI_CLASSES.muted }, "No saved research notebooks found.")],
      );
    }

    const detTag = $("adhd-detail-tag");
    const detPre = $("adhd-detail-pre");
    if (detTag) detTag.textContent = state.adhdDetailSessionId || "Choose a notebook";
    if (detPre) detPre.textContent = state.adhdDetail || "";
  }

  function renderToasts(toasts) {
    if (!toastStack) return;
    setChildren(
      toastStack,
      (toasts || []).map((t) =>
        h(
          "div",
          { className: `${UI_CLASSES.toast} is-${t.tone || "info"}` },
          h("span", null, t.message),
          h(
            "button",
            {
              type: "button",
              className: "od-ghost-btn od-btn-xs",
              "aria-label": "Dismiss notification",
              onclick: () => store.dismissToast(t.id),
            },
            "×",
          ),
        ),
      ),
    );
  }

  function render(state) {
    const m = state.activeMission;
    if (shellEl) {
      shellEl.classList?.toggle?.("is-rail-collapsed", !state.railOpen);
      shellEl.classList?.toggle?.("is-inspector-collapsed", !state.inspectorOpen);
      shellEl.classList?.toggle?.("is-inspector-wide", Boolean(state.inspectorOpen && state.inspectorWide));
    }
    setVisible(railEl, state.railOpen);
    setVisible(inspectorDrawer, state.inspectorOpen);
    setVisible(timelineDock, state.timelineOpen);
    setVisible($("token-box"), state.tokenRequired);
    setVisible($("armed-banner"), Boolean(state.armedAction));
    setVisible($("build-controls"), Boolean(m));
    if (state.armedAction && $("armed-text")) {
      $("armed-text").textContent = state.armedAction.label || "Confirm action";
    }

    const showComposerView = state.activeView === "composer";
    const showComposerOverlay = state.composerOpen && state.composerMode !== "view";
    setVisible($("panel-map"), state.activeView === "map" || state.activeView === "composer");
    setVisible($("panel-contracts"), state.activeView === "contracts");
    setVisible($("panel-adhd"), state.activeView === "adhd");
    setVisible($("panel-rsi"), state.activeView === "rsi");
    setVisible(composerSlot, showComposerView || showComposerOverlay);
    if (composerSlot) {
      composerSlot.classList?.toggle?.("is-overlay", showComposerOverlay);
      composerSlot.classList?.toggle?.("is-view", showComposerView && !showComposerOverlay);
    }

    for (const btn of doc.querySelectorAll?.("[data-nav-view]") || []) {
      const targetView = btn.dataset?.navView;
      const active = targetView === state.activeView;
      btn.classList?.toggle?.("is-active", active);
      btn.setAttribute?.("aria-selected", active ? "true" : "false");
    }
    for (const btn of doc.querySelectorAll?.("[data-view-tab]") || []) {
      const sub = btn.dataset?.viewTab;
      const active = state.activeView === "map" && sub === state.workspaceSubTab;
      btn.classList?.toggle?.("is-active", active);
      btn.setAttribute?.("aria-selected", active ? "true" : "false");
    }

    const crumb = $("mission-crumb");
    const stPill = $("state-pill");
    const stText = $("state-text");
    const mapTitle = $("map-title");
    const mapGoal = $("map-goal");
    const quickMode = $("quick-mode");
    const eventsCount = $("events-count");
    const inspTitle = $("inspector-header-title");
    const wideBtn = $("btn-inspector-wide");
    const metaStatus = $("paper-meta-status");
    const streamState = $("stream-state");
    const streamLight = $("stream-light");
    const footerSummary = $("build-footer-summary");

    if (crumb) crumb.textContent = m ? m.title : "Build studio";
    if (stPill && stPill.dataset) stPill.dataset.tone = m ? toneOfMissionState(m.state) : "idle";
    if (stText) {
      const baseText = m ? humanMissionState(m.state) : "Ready";
      stText.textContent = m && state.cursorSeq !== null ? `${baseText} · Step ${state.cursorSeq}` : baseText;
    }
    if (metaStatus) {
      metaStatus.textContent = m ? (m.freezeCommit ? `Rules locked · ${m.freezeCommit.slice(0, 7)}` : humanMissionState(m.state)) : "Ready";
    }
    if (mapTitle) mapTitle.textContent = m ? m.title : "Turn deep thinking into finished software.";
    if (mapGoal) {
      mapGoal.textContent = m ? m.goal : "Your build plan, isolated teammates, verified edits, and release checks appear here as a calm, reviewable workspace.";
    }
    if (quickMode && m?.routingMode) quickMode.value = m.routingMode;
    const freezeBtn = $("btn-freeze");
    if (freezeBtn) {
      const isFrozen = Boolean(m?.freezeCommit);
      freezeBtn.disabled = isFrozen;
      freezeBtn.textContent = isFrozen ? "Rules locked ✓" : "Lock rules & start team";
    }
    const integrateBtn = $("btn-integrate");
    if (integrateBtn) {
      integrateBtn.disabled = !m;
    }
    if (eventsCount) eventsCount.textContent = String((state.events || []).length);

    const selLane = (m?.lanes || []).find((l) => l.id === state.selectedLaneId);
    if (inspTitle) {
      inspTitle.textContent = selLane
        ? `Teammate · ${selLane.id} · ${selLane.status === "verified" ? "Verified" : selLane.status === "failed" ? "Needs attention" : humanLaneStatus(selLane)}`
        : "Teammate details";
    }
    if (wideBtn) wideBtn.textContent = state.inspectorWide ? "Narrow" : "Expand";

    if (streamState) {
      if (state.cursorSeq !== null) streamState.textContent = `Viewing snapshot at step #${state.cursorSeq}`;
      else if (state.sseStatus === "live") streamState.textContent = "Live updates connected";
      else if (state.sseStatus === "reconnecting") streamState.textContent = "Reconnecting to live updates...";
      else if (state.sseStatus === "connecting") streamState.textContent = "Connecting to studio...";
      else streamState.textContent = "Ready";
    }
    if (streamLight) {
      streamLight.className = state.sseStatus === "live" ? "is-live" : "";
    }
    if (footerSummary) {
      const lc = (m?.lanes || []).length;
      const gp = (m?.gates || []).filter((g) => g.status === "passed").length;
      const gt = (m?.gates || []).length;
      footerSummary.textContent = m ? `${lc} teammate${lc === 1 ? "" : "s"} · ${gp} of ${gt} checks passed` : "0 teammates · 0 checks";
    }

    const mSelect = $("mission-select");
    if (mSelect) {
      setChildren(
        mSelect,
        (state.missions || []).length
          ? state.missions.map((item) => {
              const opt = h("option", { value: item.id }, `${item.title} (${humanMissionState(item.state)})`);
              if (m?.id === item.id) {
                opt.selected = true;
                opt.setAttribute?.("selected", "");
              }
              return opt;
            })
          : [h("option", { value: "" }, "No builds yet")],
      );
      if (m?.id) mSelect.value = m.id;
    }

    renderStepper(m);
    const routingBanner = $("routing-warnings-banner");
    if (routingBanner) {
      const warnings = Array.from(
        new Set(
          [
            ...(Array.isArray(state.routingWarnings) ? state.routingWarnings : []),
            ...(Array.isArray(m?.routingWarnings) ? m.routingWarnings : []),
            ...(Array.isArray(state.fleet?.routingWarnings) ? state.fleet.routingWarnings : []),
          ].filter(Boolean),
        ),
      );
      const degCount = (Array.isArray(state.degradedAccounts) ? state.degradedAccounts : state.fleet?.degradedAccounts || []).length;
      setVisible(routingBanner, warnings.length > 0);
      if (warnings.length > 0) {
        setChildren(
          routingBanner,
          h("strong", null, degCount > 0 ? `Routing notice (${degCount} account${degCount === 1 ? "" : "s"} degraded)` : "Routing notice"),
          h("span", null, warnings.join(" · ")),
        );
      } else {
        setChildren(routingBanner);
      }
    }
    renderRail(state);
    renderSummaryCard(state);
    renderContractsAndFleet(state);
    renderAdhdPanel(state);

    renderDag({
      container: dagRoot,
      mission: m,
      state,
      onSelectLane: (laneId) => store.selectLane(laneId),
      onSelectGate: (gateId) => store.toast(`Release check: ${gateId}`, "info"),
      onSelectStage: (stage) => {
        if (stage === "thinking") store.setView("adhd");
        else if (stage === "frozen") store.setView("contracts");
      },
      onVerifyLane: (laneId) => void verifyLaneNow(laneId),
      onRunGate: (gateId) => void runGateNow(gateId),
      onToggleFocusFailure: () => store.toggleFocusFailure(),
      onJumpLive: () => store.jumpTimelineLive(),
      onSeedShowcase: () => void actions.seedShowcase(),
      onOpenNewMission: () => actions.openNewMission(),
    });

    renderTimeline({
      container: timelineRoot,
      mission: m,
      events: state.events || [],
      state,
      onScrub: (seq) => store.setCursorSeq(seq),
      onStep: (delta) => store.stepTimeline(delta),
      onJumpLive: () => store.jumpTimelineLive(),
      onToggleFollowTail: () => store.dispatch((s) => ({ followTail: !s.followTail })),
      onFilterChange: (patch) =>
        store.dispatch({
          ...(patch.lane !== undefined ? { timelineFilterLane: patch.lane } : {}),
          ...(patch.kind !== undefined ? { timelineFilterKind: patch.kind } : {}),
          ...(patch.search !== undefined ? { timelineSearch: patch.search } : {}),
        }),
      onInspectLane: (laneId) => store.selectLane(laneId),
    });

    inspectorCtrl?.update?.({ ...state, mission: m });

    if (rsiRoot) {
      renderRsiView({
        container: rsiRoot,
        rsi: state.rsi,
        onScan: actions.scanRsi,
        onRunBenchmark: actions.runRsiBenchmark,
        onCycle: actions.runRsiCycle,
        onArmPromote: actions.armPromoteRsi,
        onArmRollback: actions.armRollbackRsi,
      });
    }

    if (state.paletteOpen && !palette.isOpen()) {
      palette.open(state, actions);
    } else if (!state.paletteOpen && palette.isOpen()) {
      palette.close();
    } else if (palette.isOpen()) {
      palette.update(state, actions);
    }

    renderShortcutsModal({
      container: shortcutsRoot,
      open: state.shortcutsOpen,
      onClose: () => store.toggleShortcuts(false),
    });

    renderToasts(state.toasts);
  }

  const bind = (el, ev, fn) => el?.addEventListener?.(ev, fn);

  bind($("btn-save-token"), "click", () => {
    const val = $("token-input")?.value?.trim() || "";
    if (val) void store.setToken(val);
  });
  bind($("btn-theme"), "click", () => store.toggleTheme());
  bind($("btn-showcase"), "click", () => void actions.seedShowcase());
  bind($("btn-new-mission"), "click", () => actions.openNewMission());
  bind($("btn-rail-cta"), "click", () => {
    const m = store.getState().activeMission;
    if (!m) void actions.seedShowcase();
    else if (m.state === "planned") void freezeNow();
    else if (["frozen", "swarming", "verifying"].includes(m.state)) void runAllGatesNow();
    else if (m.state === "completed") actions.openNewMission();
    else actions.openComposerView();
  });
  bind($("btn-open-palette"), "click", () => store.togglePalette(true));
  bind($("btn-shortcuts"), "click", () => store.toggleShortcuts());
  bind($("btn-rail-toggle"), "click", () => store.toggleRail());
  bind($("btn-timeline-toggle"), "click", () => store.toggleTimeline());
  bind($("btn-timeline-close"), "click", () => store.toggleTimeline(false));
  bind($("btn-inspector-toggle"), "click", () => store.toggleInspector());
  bind($("btn-inspector-close"), "click", () => store.toggleInspector(false));
  bind($("btn-inspector-wide"), "click", () => store.toggleInspectorWide());
  bind($("btn-armed-confirm"), "click", () => void store.confirmArmedAction());
  bind($("btn-armed-cancel"), "click", () => store.cancelArmedAction());

  bind($("mission-select"), "change", (ev) => {
    const id = ev.target.value;
    if (id) void store.refreshState(id);
  });
  bind($("quick-mode"), "change", async (ev) => {
    const m = store.getState().activeMission;
    if (!m) return;
    try {
      await store.api.updateSettings(m.id, { routingMode: ev.target.value });
      await store.refreshState(m.id);
    } catch (e) {
      store.toast(e.message, "bad");
    }
  });
  bind($("btn-freeze"), "click", () => void freezeNow());
  bind($("btn-run-all-gates"), "click", () => void runAllGatesNow());
  bind($("btn-integrate"), "click", () => actions.integrateMission());
  bind($("btn-cleanup"), "click", async () => {
    const m = store.getState().activeMission;
    if (!m) return;
    try {
      await store.api.cleanupMission(m.id);
      await store.refreshState(m.id);
      store.toast("Temporary workspace copies cleaned up", "ok");
    } catch (e) {
      store.toast(e.message, "bad");
    }
  });
  bind($("btn-refresh-adhd"), "click", () => void store.refreshState());
  bind($("btn-build-escalation"), "click", () => void escalateNow());
  bind($("btn-preview-install"), "click", async () => {
    try {
      const res = await store.api.previewInstall({});
      const ul = $("install-preview-list");
      if (ul) {
        setChildren(
          ul,
          (res.results || []).map((r) =>
            h("li", { className: "od-list-item" }, `${r.harness}: ${r.ok ? "Ready" : "Skipped"} — ${r.message}`),
          ),
        );
      }
    } catch (e) {
      store.toast(e.message, "bad");
    }
  });

  for (const btn of doc.querySelectorAll?.("[data-nav-view]") || []) {
    bind(btn, "click", () => {
      const target = btn.dataset?.navView;
      if (target === "composer") actions.openComposerView();
      else if (target === "rsi") actions.openRsiView();
      else store.setView(target);
    });
  }
  for (const btn of doc.querySelectorAll?.("[data-view-tab]") || []) {
    bind(btn, "click", () => {
      store.setWorkspaceSubTab(btn.dataset?.viewTab);
    });
  }

  const onKeydown = (ev) => {
    handleKeydown(ev, { store, palette, composerCtrl, actions });
  };
  doc.addEventListener?.("keydown", onKeydown);

  const unsubscribe = store.subscribe(render);
  render(store.getState());
  if (shellEl?.dataset) shellEl.dataset.ready = "true";

  if (store.getState().token) {
    store.connectSse();
    await store.refreshState();
    if (store.getState().activeView === "rsi") {
      await store.loadRsiOverview({ quiet: true });
    }
  }

  return {
    store,
    palette,
    inspectorCtrl,
    composerCtrl,
    actions,
    onKeydown,
    destroy: () => {
      doc.removeEventListener?.("keydown", onKeydown);
      unsubscribe();
      inspectorCtrl?.destroy?.();
      composerCtrl?.destroy?.();
      store.destroy();
    },
  };
}

if (typeof globalThis.document !== "undefined" && globalThis.document.getElementById?.("od-shell")) {
  void createStudioApp();
}
