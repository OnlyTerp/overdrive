import { UI_CLASSES } from "./contracts.js";
import { h, setChildren, svg } from "./dom.js";
import { humanLaneStatus, humanModelName } from "./store.js";

function shortSha(sha, len = 7) {
  if (!sha) return "not locked";
  return String(sha).slice(0, len);
}

function fitSvgLabel(text, maxChars = 20) {
  const clean = String(text ?? "").trim().replace(/\s+/g, " ");
  if (clean.length <= maxChars) return clean;
  const minCut = Math.max(4, maxChars - 7);
  const slice = clean.slice(0, maxChars - 1);
  let cut = -1;
  for (const sep of [" ", "·", "/", "&", "-", ","]) {
    const idx = slice.lastIndexOf(sep);
    if (idx >= minCut && idx > cut) cut = idx;
  }
  const stem = (cut > 0 ? slice.slice(0, cut) : slice).replace(/[\s·\/&,-]+$/g, "");
  return `${stem || slice.trim()}…`;
}

function laneStatusTone(lane) {
  if (!lane) return "idle";
  if (lane.status === "failed" || lane.scopeOk === false || lane.lastVerify?.ok === false) return "fail";
  if (lane.status === "verified") return "pass";
  if (lane.status === "scope_ok" || lane.status === "active") return "active";
  return "idle";
}

function gateStatusTone(gate) {
  if (!gate) return "idle";
  if (gate.status === "failed") return "fail";
  if (gate.status === "passed") return "pass";
  return "idle";
}

function humanGateStatus(gate) {
  if (!gate) return "Waiting";
  if (gate.status === "passed") return "Passed";
  if (gate.status === "failed") return "Needs attention";
  return "Waiting";
}

function hasFailure(mission) {
  if (!mission) return false;
  if (mission.state === "escalated") return true;
  if ((mission.lanes || []).some((l) => laneStatusTone(l) === "fail")) return true;
  if ((mission.gates || []).some((g) => gateStatusTone(g) === "fail")) return true;
  return false;
}

/** Deterministic SVG layout coordinates for the 5-stage Think -> Freeze -> Swarm -> Verify -> Gates pipeline. */
export function computeDagLayout(mission) {
  const lanes = mission?.lanes || [];
  const gates = mission?.gates || [];
  const rows = Math.max(1, lanes.length, gates.length);
  const rowHeight = 46;
  const padY = 24;
  const height = Math.max(150, padY * 2 + rows * rowHeight);
  const midY = Math.round(height / 2);

  const stageX = {
    think: 84,
    freeze: 266,
    swarm: 498,
    verify: 738,
    gates: 964,
  };

  const laneY = (idx, count) => {
    if (count <= 1) return midY;
    const span = (count - 1) * rowHeight;
    return Math.round(midY - span / 2 + idx * rowHeight);
  };

  const laneNodes = lanes.map((lane, idx) => ({
    id: lane.id,
    x: stageX.swarm,
    y: laneY(idx, lanes.length),
    tone: laneStatusTone(lane),
    lane,
  }));

  const verifierNodes = lanes.map((lane, idx) => ({
    id: `verify-${lane.id}`,
    laneId: lane.id,
    x: stageX.verify,
    y: laneY(idx, lanes.length),
    tone: laneStatusTone(lane),
    verifier: lane.verifier || {},
  }));

  const gateNodes = gates.map((gate, idx) => ({
    id: gate.id,
    index: idx + 1,
    x: stageX.gates,
    y: laneY(idx, gates.length),
    tone: gateStatusTone(gate),
    gate,
  }));

  return {
    width: 1060,
    height,
    midY,
    stageX,
    laneNodes,
    verifierNodes,
    gateNodes,
  };
}

function bezierPath(x1, y1, x2, y2) {
  const dx = Math.round((x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function buildSvgPipeline({ mission, layout, selectedLaneId, focusFailureOnly, onSelectLane, onSelectGate, onSelectStage }) {
  const failureExists = hasFailure(mission);
  const isolate = Boolean(focusFailureOnly && failureExists);

  const stageIdx = (() => {
    const order = ["thinking", "planned", "frozen", "swarming", "completed"];
    const cur = mission.state === "verifying" ? "swarming" : mission.state === "escalated" ? "thinking" : mission.state;
    return order.indexOf(cur);
  })();

  const edgeNodes = [];

  const thinkToFreezeCls = [
    UI_CLASSES.dagEdge,
    "od-edge",
    stageIdx >= 2 ? "is-pass" : stageIdx >= 0 ? "is-active" : "",
    isolate && mission.state !== "escalated" ? "is-dimmed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  edgeNodes.push(svg("path", { className: thinkToFreezeCls, d: bezierPath(layout.stageX.think + 66, layout.midY, layout.stageX.freeze - 68, layout.midY) }));

  for (const ln of layout.laneNodes) {
    const isSel = ln.id === selectedLaneId;
    const isFail = ln.tone === "fail";
    const cls = [
      UI_CLASSES.dagEdge,
      "od-edge",
      ln.tone === "pass" ? "is-pass" : isFail ? "is-fail" : ln.tone === "active" ? "is-active" : "",
      isSel ? "is-selected" : "",
      isolate && !isFail ? "is-dimmed" : "",
    ]
      .filter(Boolean)
      .join(" ");
    edgeNodes.push(svg("path", { className: cls, d: bezierPath(layout.stageX.freeze + 68, layout.midY, ln.x - 92, ln.y) }));
  }

  for (let i = 0; i < layout.laneNodes.length; i++) {
    const ln = layout.laneNodes[i];
    const vn = layout.verifierNodes[i];
    const isFail = ln.tone === "fail";
    const cls = [
      UI_CLASSES.dagEdge,
      "od-edge",
      ln.tone === "pass" ? "is-pass" : isFail ? "is-fail" : ln.tone === "active" ? "is-active" : "",
      ln.id === selectedLaneId ? "is-selected" : "",
      isolate && !isFail ? "is-dimmed" : "",
    ]
      .filter(Boolean)
      .join(" ");
    edgeNodes.push(svg("path", { className: cls, d: bezierPath(ln.x + 92, ln.y, vn.x - 76, vn.y) }));
  }

  for (const vn of layout.verifierNodes) {
    for (const gn of layout.gateNodes) {
      const isFail = vn.tone === "fail" || gn.tone === "fail";
      const bothPass = vn.tone === "pass" && gn.tone === "pass";
      const cls = [
        UI_CLASSES.dagEdge,
        "od-edge",
        bothPass ? "is-pass" : isFail ? "is-fail" : vn.tone === "active" ? "is-active" : "",
        isolate && !isFail ? "is-dimmed" : "",
      ]
        .filter(Boolean)
        .join(" ");
      edgeNodes.push(svg("path", { className: cls, d: bezierPath(vn.x + 76, vn.y, gn.x - 76, gn.y) }));
    }
  }

  const nodeEls = [];

  nodeEls.push(
    svg(
      "g",
      {
        className: `od-node od-svg-stage ${mission.adhdSessionId ? "is-pass" : ""} ${isolate && mission.state !== "escalated" ? "is-dimmed" : ""}`,
        tabindex: "0",
        role: "button",
        "aria-label": "Research stage",
        onclick: () => onSelectStage?.("thinking"),
      },
      svg("rect", { className: "od-svg-box", x: String(layout.stageX.think - 66), y: String(layout.midY - 17), width: "132", height: "34", rx: "10" }),
      svg("text", { className: "od-svg-label", x: String(layout.stageX.think), y: String(layout.midY + 4), "text-anchor": "middle" }, mission.adhdSessionId ? "Research · Linked" : "Research"),
    ),
  );

  const frozen = Boolean(mission.freezeCommit);
  nodeEls.push(
    svg(
      "g",
      {
        className: `od-node od-svg-stage ${frozen ? "is-pass" : "is-active"} ${isolate ? "is-dimmed" : ""}`,
        tabindex: "0",
        role: "button",
        "aria-label": "Shared rules lock",
        onclick: () => onSelectStage?.("frozen"),
      },
      svg("rect", { className: "od-svg-box", x: String(layout.stageX.freeze - 68), y: String(layout.midY - 17), width: "136", height: "34", rx: "10" }),
      svg("text", { className: "od-svg-label", x: String(layout.stageX.freeze), y: String(layout.midY + 4), "text-anchor": "middle" }, frozen ? "Rules Locked" : "Draft Rules"),
    ),
  );

  for (const ln of layout.laneNodes) {
    const isSel = ln.id === selectedLaneId;
    const isFail = ln.tone === "fail";
    const cls = [
      "od-node",
      "od-svg-lane",
      `is-${ln.tone}`,
      isSel ? "is-selected" : "",
      isolate && !isFail ? "is-dimmed" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const label = fitSvgLabel(ln.lane.title || ln.id, 22);
    nodeEls.push(
      svg(
        "g",
        {
          className: cls,
          "data-svg-lane-id": ln.id,
          tabindex: "0",
          role: "button",
          "aria-label": `Select teammate ${ln.id}`,
          onclick: () => onSelectLane?.(ln.id),
        },
        svg("rect", { className: "od-svg-box", x: String(ln.x - 92), y: String(ln.y - 16), width: "184", height: "32", rx: "10" }),
        svg("circle", { className: `od-svg-dot is-${ln.tone}`, cx: String(ln.x - 76), cy: String(ln.y), r: "4" }),
        svg("text", { className: "od-svg-label", x: String(ln.x - 64), y: String(ln.y + 4) }, label),
      ),
    );
  }

  for (const vn of layout.verifierNodes) {
    const isFail = vn.tone === "fail";
    const cls = [
      "od-node",
      "od-svg-verify",
      `is-${vn.tone}`,
      isolate && !isFail ? "is-dimmed" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const reviewer = humanModelName(vn.verifier).split(" · ")[0];
    nodeEls.push(
      svg(
        "g",
        {
          className: cls,
          onclick: () => onSelectLane?.(vn.laneId),
        },
        svg("rect", { className: "od-svg-box", x: String(vn.x - 76), y: String(vn.y - 14), width: "152", height: "28", rx: "10" }),
        svg("text", { className: "od-svg-label-sm", x: String(vn.x), y: String(vn.y + 4), "text-anchor": "middle" }, fitSvgLabel(reviewer, 20)),
      ),
    );
  }

  for (const gn of layout.gateNodes) {
    const isFail = gn.tone === "fail";
    const cls = [
      "od-node",
      "od-svg-gate",
      `is-${gn.tone}`,
      isolate && !isFail ? "is-dimmed" : "",
    ]
      .filter(Boolean)
      .join(" ");
    nodeEls.push(
      svg(
        "g",
        {
          className: cls,
          tabindex: "0",
          role: "button",
          "aria-label": `Release check ${gn.gate.title || gn.gate.id}`,
          onclick: () => onSelectGate?.(gn.gate.id),
        },
        svg("rect", { className: "od-svg-box", x: String(gn.x - 76), y: String(gn.y - 15), width: "152", height: "30", rx: "10" }),
        svg("text", { className: "od-svg-label", x: String(gn.x), y: String(gn.y + 4), "text-anchor": "middle" }, fitSvgLabel(String(gn.gate.title || `Check ${gn.index}`), 19)),
      ),
    );
  }

  return svg(
    "svg",
    {
      className: UI_CLASSES.dagSvg,
      viewBox: `0 0 ${layout.width} ${layout.height}`,
      preserveAspectRatio: "xMidYMid meet",
      role: "img",
      "aria-label": "Visual build map showing shared rules, parallel teammates, reviewers, and release checks",
    },
    svg("g", { className: "od-dag-edges" }, edgeNodes),
    svg("g", { className: "od-dag-nodes" }, nodeEls),
  );
}

function buildEmptyWelcome({ onSeedShowcase, onOpenNewMission }) {
  return h(
    "div",
    { className: "od-empty-state" },
    h("div", { className: "od-orb", "aria-hidden": "true" }),
    h(
      "h2",
      { className: "od-empty-title" },
      "Turn deep thinking into ",
      h("em", null, "finished software."),
    ),
    h(
      "p",
      { className: "od-empty-sub" },
      "Shared rules · isolated teammates · verified changes · release checks",
    ),
    h(
      "div",
      { className: "od-empty-actions" },
      h(
        "button",
        {
          id: "btn-showcase-cta",
          className: "od-primary",
          type: "button",
          onclick: () => onSeedShowcase?.(),
        },
        "Explore sample build ",
        h("span", { "aria-hidden": "true" }, "↗"),
      ),
      h(
        "button",
        {
          id: "btn-welcome-new",
          className: `${UI_CLASSES.btn} ${UI_CLASSES.btnGhost}`,
          type: "button",
          onclick: () => onOpenNewMission?.(),
        },
        "+ New build",
      ),
    ),
  );
}

/** Render the visual build map & interactive teammate cards into `container`. */
export function renderDag({
  container,
  mission,
  state = {},
  onSelectLane,
  onSelectGate,
  onSelectStage,
  onRunGate,
  onVerifyLane,
  onToggleFocusFailure,
  onJumpLive,
  onSeedShowcase,
  onOpenNewMission,
}) {
  if (!container) return;
  if (!mission) {
    setChildren(container, buildEmptyWelcome({ onSeedShowcase, onOpenNewMission }));
    return;
  }

  const selectedLaneId = state.selectedLaneId || null;
  const focusFailureOnly = Boolean(state.focusFailureOnly);
  const failureExists = hasFailure(mission);
  const isolate = Boolean(focusFailureOnly && failureExists);
  const layout = computeDagLayout(mission);

  // Calm map toolbar
  const headerBar = h(
    "div",
    { className: "od-dag-toolbar" },
    h(
      "div",
      { className: "od-dag-toolbar-left" },
      h("span", { className: "od-map-label" }, "Visual build map"),
      state.cursorSeq !== null && state.cursorSeq !== undefined
        ? h(
            "button",
            {
              type: "button",
              className: `${UI_CLASSES.btn} ${UI_CLASSES.btnGhost} od-replay-pill ${UI_CLASSES.tabular}`,
              onclick: () => onJumpLive?.(),
            },
            `Viewing step #${state.cursorSeq} · Back to live`,
          )
        : null,
    ),
    h(
      "div",
      { className: "od-dag-toolbar-right" },
      h(
        "button",
        {
          type: "button",
          className: `od-ghost-btn od-btn-xs ${focusFailureOnly ? "is-active" : ""}`,
          "aria-pressed": focusFailureOnly ? "true" : "false",
          onclick: () => onToggleFocusFailure?.(),
        },
        focusFailureOnly ? (failureExists ? "Showing issues only" : "All steps healthy") : "Focus on issues",
      ),
    ),
  );

  // Pure SVG visual build map
  const svgCanvas = h(
    "div",
    { className: "od-dag-canvas" },
    buildSvgPipeline({
      mission,
      layout,
      selectedLaneId,
      focusFailureOnly,
      onSelectLane,
      onSelectGate,
      onSelectStage,
    }),
  );

  // Column 1: Shared rules
  const contractsList = (mission.contracts || []).length
    ? mission.contracts.map((c) => {
        const tampered = (mission.lanes || []).some((l) =>
          (l.lastVerify?.tamperedContracts || []).some((t) => t.path === c.path),
        );
        return h(
          "li",
          { className: `od-contract-item ${tampered ? "is-fail" : ""}` },
          h("span", { className: "od-contract-name" }, c.path),
          h(
            "span",
            { className: `${UI_CLASSES.badge} is-${tampered ? "fail" : c.sha256 ? "pass" : "idle"}` },
            tampered ? "Changed unexpectedly" : c.sha256 ? "Locked" : "Pending",
          ),
        );
      })
    : [h("li", { className: UI_CLASSES.muted }, "No shared rule files yet")];

  const rulesColumn = h(
    "section",
    { className: `od-stage-col ${isolate ? "is-dimmed" : ""}` },
    h(
      "div",
      { className: "od-stage-col-head" },
      h("span", { className: "od-stage-kicker" }, "Shared rules"),
      h("span", { className: `${UI_CLASSES.badge} ${UI_CLASSES.tabular}` }, mission.freezeCommit ? shortSha(mission.freezeCommit) : "Unlocked"),
    ),
    h("ul", { className: "od-contract-list" }, contractsList),
  );

  // Column 2: Parallel Teammate Cards ([data-lane-id])
  const laneCards = (mission.lanes || []).map((lane) => {
    const tone = laneStatusTone(lane);
    const isSelected = lane.id === selectedLaneId;
    const isDimmed = isolate && tone !== "fail";
    const changedCount = lane.lastVerify?.changedFiles?.length ?? null;
    const fileLabel = changedCount !== null ? `${changedCount} file${changedCount === 1 ? "" : "s"} changed` : `${(lane.ownedGlobs || []).length} assigned area${(lane.ownedGlobs || []).length === 1 ? "" : "s"}`;

    const cardClasses = [
      UI_CLASSES.dagNode,
      "od-lane-node",
      `is-${tone}`,
      isSelected ? "is-selected" : "",
      isDimmed ? "is-dimmed" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const workerLabel = humanModelName(lane.worker);
    const reviewerName = humanModelName(lane.verifier).split(" · ")[0];

    return h(
      "div",
      { className: "od-lane-row" },
      h(
        "button",
        {
          type: "button",
          className: cardClasses,
          "data-lane-id": lane.id,
          "data-status": lane.status,
          "data-complexity": lane.complexity || "standard",
          "aria-pressed": isSelected ? "true" : "false",
          "aria-label": `Teammate ${lane.title || lane.id}: ${humanLaneStatus(lane)}`,
          onclick: () => onSelectLane?.(lane.id),
          onkeydown: (ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              onSelectLane?.(lane.id);
            }
          },
        },
        h(
          "div",
          { className: "od-lane-head" },
          h(
            "span",
            { className: "od-lane-title-wrap" },
            h("span", { className: `od-status-dot is-${tone}`, "aria-hidden": "true" }),
            h("strong", { className: "od-lane-name" }, lane.title || lane.id),
          ),
          h("span", { className: `${UI_CLASSES.badge} is-${tone}` }, humanLaneStatus(lane)),
        ),
        h(
          "div",
          { className: "od-lane-meta" },
          h("span", { className: UI_CLASSES.badge }, workerLabel),
          h("span", { className: `${UI_CLASSES.badge} ${UI_CLASSES.tabular}` }, fileLabel),
          lane.verifier?.crossFamily
            ? h(
                "span",
                { className: `${UI_CLASSES.badge} ${lane.status === "verified" ? "is-pass" : ""}` },
                lane.status === "verified" ? `Verified · ${reviewerName}` : `Assigned reviewer: ${reviewerName}`,
              )
            : null,
        ),
        h(
          "div",
          { className: "od-lane-foot" },
          h("span", { className: "od-lane-scope-note" }, lane.scopeOk === false ? "Edited outside assigned files" : lane.scopeOk === true ? "Stayed in assigned files" : "Isolated workspace"),
          h("span", { className: "od-lane-link" }, "View changes →"),
        ),
      ),
      onVerifyLane
        ? h(
            "div",
            { className: `od-lane-side-actions ${isDimmed ? "is-dimmed" : ""}` },
            h(
              "button",
              {
                type: "button",
                className: "od-ghost-btn od-btn-xs",
                onclick: (ev) => {
                  ev.stopPropagation();
                  onVerifyLane(lane.id);
                },
              },
              "Check work",
            ),
          )
        : null,
    );
  });

  const lanesColumn = h(
    "section",
    { className: "od-stage-col od-stage-col-lanes" },
    h(
      "div",
      { className: "od-stage-col-head" },
      h("span", { className: "od-stage-kicker" }, "Teammates working in parallel"),
      h("span", { className: `${UI_CLASSES.badge} ${UI_CLASSES.tabular}` }, `${(mission.lanes || []).filter((l) => l.status === "verified").length} of ${(mission.lanes || []).length} ready`),
    ),
    h("div", { className: "od-lanes-stack" }, laneCards.length ? laneCards : [h("div", { className: UI_CLASSES.muted }, "No teammates planned yet")]),
  );

  // Column 3: Release Checks
  const gateCards = (mission.gates || []).map((g) => {
    const tone = gateStatusTone(g);
    const isDimmed = isolate && tone !== "fail";
    return h(
      "div",
      {
        className: `od-gate-node is-${tone} ${isDimmed ? "is-dimmed" : ""}`,
        "data-gate-id": g.id,
        "data-status": g.status,
      },
      h(
        "div",
        { className: "od-gate-head" },
        h("strong", null, g.title || g.id),
        h("span", { className: `${UI_CLASSES.badge} is-${tone}` }, humanGateStatus(g)),
      ),
      h(
        "div",
        { className: "od-gate-foot" },
        h("span", { className: UI_CLASSES.muted }, g.required ? "Required check" : "Optional check"),
        onRunGate
          ? h(
              "button",
              {
                type: "button",
                className: "od-ghost-btn od-btn-xs",
                onclick: () => onRunGate(g.id),
              },
              "Run check",
            )
          : null,
      ),
    );
  });

  const gatesColumn = h(
    "section",
    { className: "od-stage-col" },
    h(
      "div",
      { className: "od-stage-col-head" },
      h("span", { className: "od-stage-kicker" }, "Release checks"),
      h("span", { className: `${UI_CLASSES.badge} ${UI_CLASSES.tabular}` }, `${(mission.gates || []).filter((g) => g.status === "passed").length} of ${(mission.gates || []).length}`),
    ),
    h("div", { className: "od-gates-stack" }, gateCards.length ? gateCards : [h("div", { className: UI_CLASSES.muted }, "No release checks yet")]),
  );

  const stageGrid = h("div", { className: "od-dag-grid" }, rulesColumn, lanesColumn, gatesColumn);

  setChildren(container, h("div", { className: UI_CLASSES.dagRoot }, headerBar, svgCanvas, stageGrid));
}
