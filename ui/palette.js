import { SHORTCUTS, UI_CLASSES } from "./contracts.js";
import { h, highlightMatches, setChildren } from "./dom.js";
import { humanLaneStatus, humanMissionState, humanModelName } from "./store.js";

/**
 * Raycast-grade case-insensitive subsequence fuzzy matcher returning
 * `{ score, indices }` or `null` if `query` does not match `text`.
 */
export function fuzzyScore(query, text) {
  const q = String(query || "").trim().toLowerCase();
  const s = String(text || "");
  if (!q) return { score: 0, indices: [] };
  const lower = s.toLowerCase();

  const indices = [];
  let qi = 0;
  let score = 0;
  let prevHit = -2;

  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) {
      indices.push(i);
      score += 10;
      if (i === prevHit + 1) score += 16;
      if (i === 0 || /[\s/_.:-]/.test(lower[i - 1])) score += 12;
      prevHit = i;
      qi++;
    }
  }
  if (qi < q.length) return null;
  score -= Math.floor(s.length * 0.1);
  return { score, indices };
}

export function buildPaletteCommands(state, actions) {
  const cmds = [];
  const mission = state?.activeMission || null;

  cmds.push(
    { id: "action.showcase", category: "Build", label: "Load Showcase Sample Build", hint: "Sample", run: () => actions.seedShowcase?.() },
    { id: "action.new-mission", category: "Build", label: "Start New Build", hint: "New", run: () => actions.openNewMission?.() },
    { id: "action.theme", category: "Look", label: `Switch to ${state?.theme === "light" ? "Dark" : "Light"} Theme`, hint: "Theme", run: () => actions.toggleTheme?.() },
    { id: "help.shortcuts", category: "Help", label: "Keyboard Shortcuts", hint: "?", run: () => actions.toggleShortcuts?.() },
  );

  cmds.push(
    { id: "view.map", category: "View", label: "Overview & Visual Build Map", hint: "1", run: () => actions.setView?.("map") },
    { id: "view.composer", category: "View", label: "Plan Team & File Boundaries", hint: "2", run: () => actions.openComposerView?.() },
    { id: "view.contracts", category: "View", label: "Setup, Shared Rules & Connected Apps", hint: "3", run: () => actions.setView?.("contracts") },
    { id: "view.adhd", category: "View", label: "Research Notes (ADHD Bridge)", hint: "4", run: () => actions.setView?.("adhd") },
    { id: "view.rsi", category: "View", label: "Open Evolution & Self-Improvement (5)", hint: "5", run: () => (actions.openRsiView ? actions.openRsiView() : actions.setView?.("rsi")) },
    { id: "rsi.scan", category: "Evolution", label: "Scan Sessions for Improvements", hint: "Scan", run: () => actions.scanRsi?.() },
  );

  cmds.push(
    { id: "pane.rail", category: "Layout", label: "Show or Hide Goal & Team Panel", hint: "[", run: () => actions.toggleRail?.() },
    { id: "pane.inspector", category: "Layout", label: "Show or Hide Details Panel", hint: "]", run: () => actions.toggleInspector?.() },
    { id: "pane.timeline", category: "Layout", label: "Show or Hide Activity & Replay", hint: "t", run: () => actions.toggleTimeline?.() },
    { id: "inspector.wide", category: "Layout", label: "Expand or Narrow Changes Drawer", hint: "w", run: () => actions.toggleInspectorWide?.() },
    { id: "dag.focus", category: "View", label: "Focus on Issues Only", hint: "f", run: () => actions.toggleFocusFailure?.() },
    { id: "timeline.live", category: "Activity", label: "Jump Back to Live Progress", hint: "l", run: () => actions.jumpTimelineLive?.() },
  );

  cmds.push(
    { id: "inspector.diff", category: "Details", label: "View File Changes", hint: "d", run: () => actions.setInspectorTab?.("diff") },
    { id: "inspector.brief", category: "Details", label: "View Teammate Assignment", hint: "b", run: () => actions.setInspectorTab?.("brief") },
    { id: "inspector.audit", category: "Details", label: "View Verification Checks", hint: "a", run: () => actions.setInspectorTab?.("audit") },
  );

  for (const m of state?.missions || []) {
    cmds.push({
      id: `mission:${m.id}`,
      category: "Build",
      label: `Open Build: ${m.title} (${humanMissionState(m.state)})`,
      hint: m.slug,
      run: () => actions.selectMission?.(m.id),
    });
  }

  if (mission) {
    for (const lane of mission.lanes || []) {
      cmds.push({
        id: `lane:${lane.id}`,
        category: "Teammate",
        label: `Inspect Teammate: ${lane.title || lane.id} (${humanLaneStatus(lane)})`,
        hint: humanModelName(lane.worker).split(" · ")[0],
        run: () => actions.selectLane?.(lane.id),
      });
    }
    if (["planned", "frozen"].includes(mission.state)) {
      cmds.push({
        id: "mission.freeze",
        category: "Action",
        label: "Lock Shared Rules & Prepare Team",
        hint: "Lock",
        run: () => actions.freezeMission?.(),
      });
    }
    if ((mission.gates || []).length > 0) {
      cmds.push({
        id: "mission.run-gates",
        category: "Action",
        label: "Run All Release Checks",
        hint: "Checks",
        run: () => actions.runAllGates?.(),
      });
    }
    if (state?.selectedLaneId) {
      cmds.push({
        id: "lane.verify",
        category: "Action",
        label: `Check Teammate Work (${state.selectedLaneId})`,
        hint: "v + Enter",
        run: () => actions.verifyLane?.(state.selectedLaneId),
      });
    }
    cmds.push({
      id: "mission.integrate",
      category: "Action",
      label: "Trial-Merge Verified Team Work",
      hint: "Merge",
      run: () => actions.integrateMission?.(),
    });
    cmds.push({
      id: "mission.escalate",
      category: "Action",
      label: "Send Failure Note to Research",
      hint: "e",
      run: () => actions.escalate?.(),
    });
  }

  return cmds;
}

/** Create controller managing calm fuzzy Command Search dialog inside `container`. */
export function createPaletteController({ container, onClose }) {
  let isOpen = false;
  let query = "";
  let selectedIdx = 0;
  let allCommands = [];
  let filtered = [];
  let previousFocus = null;

  const inputEl = h("input", {
    type: "search",
    className: UI_CLASSES.paletteInput,
    placeholder: "Search builds, teammates, views, or actions...",
    "aria-label": "Search commands and builds",
    oninput: (ev) => {
      query = ev.target.value;
      selectedIdx = 0;
      renderList();
    },
    onkeydown: (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        close();
        return;
      }
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        if (filtered.length) selectedIdx = (selectedIdx + 1) % filtered.length;
        renderList();
        return;
      }
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        if (filtered.length) selectedIdx = (selectedIdx - 1 + filtered.length) % filtered.length;
        renderList();
        return;
      }
      if (ev.key === "Enter") {
        ev.preventDefault();
        executeSelected();
      }
    },
  });

  const listEl = h("ul", {
    className: UI_CLASSES.paletteList,
    role: "listbox",
    "aria-label": "Matching commands",
  });

  const boxEl = h(
    "div",
    {
      className: `${UI_CLASSES.paletteBox} od-glass`,
      onclick: (ev) => ev.stopPropagation?.(),
    },
    h(
      "div",
      { className: "od-palette-head" },
      inputEl,
      h("kbd", { className: UI_CLASSES.kbd }, "Esc"),
    ),
    listEl,
    h(
      "div",
      { className: "od-palette-foot" },
      h("span", { className: UI_CLASSES.muted }, "Arrow keys to browse · Enter to run · Esc to close"),
    ),
  );

  function executeIndex(idx) {
    const entry = filtered[idx];
    if (!entry) return;
    const cmd = entry.cmd;
    close();
    cmd.run?.();
  }

  function executeSelected() {
    executeIndex(selectedIdx);
  }

  function renderList() {
    const scored = [];
    for (const cmd of allCommands) {
      const m = fuzzyScore(query, cmd.label);
      if (m) {
        scored.push({ cmd, match: m });
      } else if (query.trim()) {
        const catMatch = fuzzyScore(query, `${cmd.category} ${cmd.hint || ""}`);
        if (catMatch) scored.push({ cmd, match: { score: catMatch.score - 5, indices: [] } });
      }
    }
    scored.sort((a, b) => b.match.score - a.match.score);
    filtered = scored.slice(0, 30);
    if (selectedIdx >= filtered.length) selectedIdx = 0;

    const nodes = filtered.map((entry, idx) => {
      const { cmd, match } = entry;
      const active = idx === selectedIdx;
      return h(
        "li",
        { className: "od-palette-li" },
        h(
          "button",
          {
            type: "button",
            className: `${UI_CLASSES.paletteItem} ${active ? "is-selected" : ""}`,
            role: "option",
            "aria-selected": active ? "true" : "false",
            onclick: () => executeIndex(idx),
          },
          h("span", { className: "od-palette-cat" }, cmd.category),
          h("span", { className: "od-palette-label" }, ...highlightMatches(cmd.label, match.indices)),
          cmd.hint ? h("kbd", { className: `${UI_CLASSES.kbd} od-palette-hint` }, cmd.hint) : null,
        ),
      );
    });

    setChildren(
      listEl,
      nodes.length
        ? nodes
        : [h("li", { className: "od-palette-empty" }, h("span", { className: UI_CLASSES.muted }, "Nothing matched your search"))],
    );
  }

  function syncVisibility() {
    if (!container) return;
    container.hidden = !isOpen;
    container.classList?.toggle?.("is-open", isOpen);
    if (isOpen) container.removeAttribute?.("hidden");
    else container.setAttribute?.("hidden", "");
  }

  function open(state, actions) {
    previousFocus = globalThis.document?.activeElement || null;
    allCommands = buildPaletteCommands(state, actions);
    query = "";
    selectedIdx = 0;
    inputEl.value = "";
    isOpen = true;
    if (container) {
      container.onclick = () => close();
      setChildren(container, boxEl);
    }
    syncVisibility();
    renderList();
    inputEl.focus?.();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    syncVisibility();
    onClose?.();
    if (previousFocus && typeof previousFocus.focus === "function") {
      try {
        previousFocus.focus();
      } catch {}
    }
    previousFocus = null;
  }

  function update(state, actions) {
    allCommands = buildPaletteCommands(state, actions);
    if (isOpen) renderList();
  }

  return {
    open,
    close,
    update,
    isOpen: () => isOpen,
    getFilteredCount: () => filtered.length,
    getQuery: () => query,
    setQuery: (q) => {
      query = String(q || "");
      inputEl.value = query;
      selectedIdx = 0;
      renderList();
    },
    getInput: () => inputEl,
    getList: () => listEl,
  };
}

/** Render `?` Keyboard Shortcuts Help modal from frozen `SHORTCUTS`. */
export function renderShortcutsModal({ container, open, onClose }) {
  if (!container) return;
  container.hidden = !open;
  container.classList?.toggle?.("is-open", Boolean(open));
  if (!open) {
    container.setAttribute?.("hidden", "");
    setChildren(container);
    return;
  }
  container.removeAttribute?.("hidden");
  container.onclick = () => onClose?.();

  const scopeNames = {
    global: "Anywhere",
    workspace: "Workspace",
    inspector: "Teammate details",
    timeline: "Activity & replay",
  };
  const scopes = ["global", "workspace", "inspector", "timeline"];
  const sections = scopes.map((scope) => {
    const items = SHORTCUTS.filter((s) => s.scope === scope);
    return h(
      "section",
      { className: "od-shortcut-group" },
      h("h3", { className: "od-shortcut-scope" }, scopeNames[scope] || scope),
      h(
        "ul",
        { className: "od-shortcut-list" },
        items.map((s) =>
          h(
            "li",
            { className: "od-shortcut-row" },
            h(
              "span",
              { className: "od-shortcut-label" },
              s.label,
              s.armed ? h("span", { className: `${UI_CLASSES.badge} is-warn` }, "Confirm") : null,
            ),
            h(
              "span",
              { className: "od-shortcut-keys" },
              s.keys.map((k) => h("kbd", { className: UI_CLASSES.kbd }, k)),
            ),
          ),
        ),
      ),
    );
  });

  const dialogBox = h(
    "div",
    {
      className: "od-modal-card od-glass",
      onclick: (ev) => ev.stopPropagation?.(),
    },
    h(
      "div",
      { className: "od-modal-head" },
      h("div", null, h("div", { className: "od-eyebrow" }, "Quick navigation"), h("h2", null, "Keyboard shortcuts")),
      h(
        "button",
        {
          type: "button",
          className: "od-ghost-btn od-btn-xs",
          onclick: () => onClose?.(),
        },
        "Close (Esc)",
      ),
    ),
    h("div", { className: "od-shortcuts-grid" }, sections),
  );

  setChildren(container, dialogBox);
}
