import { REPLAYABLE, UI_CLASSES } from "./contracts.js";
import { h, highlightMatches, setChildren, svg } from "./dom.js";
import { humanEventSummary } from "./store.js";

export function findSubstringIndices(text, query) {
  const hay = String(text ?? "");
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return [];
  const lower = hay.toLowerCase();
  const out = [];
  let pos = 0;
  while (pos < lower.length) {
    const idx = lower.indexOf(needle, pos);
    if (idx === -1) break;
    for (let k = idx; k < idx + needle.length; k++) out.push(k);
    pos = idx + needle.length;
  }
  return out;
}

function eventCategory(ev) {
  const type = String(ev?.type || "");
  const meta = REPLAYABLE[type];
  if (ev?.payload?.violation || ev?.payload?.status === "failed" || ev?.payload?.exitCode > 0 || type === "state_escalated") {
    return "errors";
  }
  if (meta?.entity === "contract" || type === "contracts_frozen") return "contract";
  if (meta?.entity === "lane" || type.startsWith("lane_") || type === "worktrees_cleaned") return "lane";
  if (meta?.entity === "gate" || type.startsWith("gate_")) return "gate";
  return "mission";
}

function eventTone(ev) {
  const type = String(ev?.type || "");
  const p = ev?.payload || {};
  if (p.violation || p.status === "failed" || (typeof p.exitCode === "number" && p.exitCode !== 0) || type === "state_escalated") {
    return "fail";
  }
  if (p.status === "verified" || p.status === "passed" || type === "state_completed" || type === "contracts_frozen") {
    return "pass";
  }
  if (type.startsWith("state_") || type === "lane_provisioned" || type === "topology_planned") {
    return "active";
  }
  return "idle";
}

function eventTargetText(ev) {
  const p = ev?.payload || {};
  if (p.laneId) return String(p.laneId);
  if (p.gateId) return String(p.gateId);
  if (p.freezeCommit) return `Lock ${String(p.freezeCommit).slice(0, 7)}`;
  if (p.title) return String(p.title);
  if (p.routingMode) return String(p.routingMode);
  return ev?.role || "coordinator";
}

function formatTime(ts) {
  if (!ts) return "--:--:--";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts).slice(11, 19) || "--:--:--";
  return d.toISOString().slice(11, 19);
}

export function filterTimelineEvents(events = [], { lane = "all", kind = "all", search = "" } = {}) {
  const q = String(search || "").trim().toLowerCase();
  return events.filter((ev) => {
    if (!ev) return false;
    const p = ev.payload || {};
    if (lane && lane !== "all") {
      if (p.laneId !== lane && !JSON.stringify(p).toLowerCase().includes(String(lane).toLowerCase())) {
        return false;
      }
    }
    if (kind && kind !== "all") {
      if (kind === "errors") {
        if (eventTone(ev) !== "fail") return false;
      } else if (eventCategory(ev) !== kind) {
        return false;
      }
    }
    if (q) {
      const summary = humanEventSummary(ev);
      const hay = `${ev.seq} ${summary} ${ev.type} ${ev.role} ${eventTargetText(ev)} ${ev.receiptId || ""} ${JSON.stringify(p)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function buildTimelineSvg({ allEvents, cursorSeq, onScrub }) {
  const width = 1000;
  const height = 44;
  if (!allEvents.length) {
    return svg(
      "svg",
      { className: UI_CLASSES.timelineSvg, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Empty activity timeline" },
      svg("line", { className: "od-tl-axis", x1: "16", y1: "24", x2: String(width - 16), y2: "24" }),
    );
  }

  const count = allEvents.length;
  const xAt = (idx) => (count === 1 ? 500 : Math.round(24 + (idx / (count - 1)) * (width - 48)));
  const indexBySeq = new Map(allEvents.map((ev, i) => [ev.seq, i]));

  const arcs = [];
  const ticks = [];

  for (let i = 0; i < count; i++) {
    const ev = allEvents[i];
    const x2 = xAt(i);
    const causes = ev.replay?.causes || [];
    for (const cSeq of causes) {
      const ci = indexBySeq.get(cSeq);
      if (ci === undefined || ci >= i) continue;
      const x1 = xAt(ci);
      const midX = Math.round((x1 + x2) / 2);
      const lift = Math.max(6, Math.min(18, Math.round((x2 - x1) * 0.12)));
      const cls = `od-tl-arc ${cursorSeq !== null && ev.seq > cursorSeq ? "is-future" : ""}`;
      arcs.push(svg("path", { className: cls, d: `M ${x1} 24 Q ${midX} ${24 - lift} ${x2} 24` }));
    }
  }

  let playheadX = xAt(count - 1);
  for (let i = 0; i < count; i++) {
    const ev = allEvents[i];
    const x = xAt(i);
    const tone = eventTone(ev);
    const isCurrent = cursorSeq !== null && ev.seq === cursorSeq;
    const isFuture = cursorSeq !== null && ev.seq > cursorSeq;
    if (isCurrent) playheadX = x;
    const cls = [
      "od-tl-tick",
      `is-${tone}`,
      isCurrent ? "is-current" : "",
      isFuture ? "is-future" : "",
    ]
      .filter(Boolean)
      .join(" ");

    ticks.push(
      svg("circle", {
        className: cls,
        cx: String(x),
        cy: "24",
        r: isCurrent ? "6" : "4",
        "data-seq": String(ev.seq),
        tabindex: "0",
        role: "button",
        "aria-label": `Jump to step #${ev.seq}: ${humanEventSummary(ev)}`,
        onclick: () => onScrub?.(ev.seq),
      }),
    );
  }

  return svg(
    "svg",
    { className: UI_CLASSES.timelineSvg, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Build activity scrubber" },
    svg("line", { className: "od-tl-axis", x1: "24", y1: "24", x2: String(width - 24), y2: "24" }),
    svg("g", { className: "od-tl-arcs" }, arcs),
    svg("line", {
      className: `od-tl-playhead ${cursorSeq === null ? "is-live" : "is-scrub"}`,
      x1: String(playheadX),
      y1: "6",
      x2: String(playheadX),
      y2: "38",
    }),
    svg("g", { className: "od-tl-ticks" }, ticks),
  );
}

function humanDetailStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s === "verified") return "Finished · checks passed";
  if (s === "passed") return "Passed";
  if (s === "failed") return "Needs attention";
  if (s === "scope_ok") return "Boundary checked";
  if (s === "active" || s === "running" || s === "swarming") return "Working";
  if (s === "planned") return "Planned";
  if (s === "frozen") return "Rules locked";
  return status ? String(status).replace(/[_-]+/g, " ") : "";
}

function humanDetailRouting(mode) {
  if (mode === "playbook-auto") return "Smart auto-fleet";
  if (mode === "single-harness") return "Single app";
  if (mode === "mix-and-match") return "Custom mix";
  return String(mode || "");
}

function buildHumanPayloadRows(ev) {
  const p = ev?.payload || {};
  const rows = [];
  const add = (label, val) => {
    if (val === undefined || val === null || val === "") return;
    rows.push([label, String(val)]);
  };

  add("Teammate", p.laneId);
  add("Release check", p.gateId);
  if (p.status) add("Status", humanDetailStatus(p.status));
  if (typeof p.scopeOk === "boolean") {
    add("File boundary", p.scopeOk ? "Clean · only touched assigned files" : "Touched file outside assigned folder");
  }
  if (p.violation) {
    add("Boundary note", String(p.violation).replace(/^SCOPE_VIOLATION:\s*/i, "Touched a file outside its assigned folder: "));
  }
  if (p.freezeCommit) add("Rule lock", String(p.freezeCommit).slice(0, 7));
  if (p.routingMode) add("Team routing", humanDetailRouting(p.routingMode));
  if (typeof p.exitCode === "number") {
    add("Check result", p.exitCode === 0 ? "Passed (exit 0)" : `Failed (exit ${p.exitCode})`);
  }
  add("Summary", p.message || p.summary || p.reason || p.title);
  if (!rows.length) add("Recorded by", ev?.role || "coordinator");

  return h(
    "dl",
    { className: "od-tl-kv" },
    ...rows.map(([k, v]) => h("div", { className: "od-tl-kv-row" }, h("dt", null, k), h("dd", null, v))),
  );
}

function buildDetailPane(ev, onInspectLane) {
  if (!ev) {
    return h("div", { className: "od-tl-detail-empty" }, h("span", { className: UI_CLASSES.muted }, "Select any update to see what changed at that step."));
  }
  const causes = ev.replay?.causes || [];
  const laneId = ev.payload?.laneId || null;

  return h(
    "div",
    { className: "od-tl-detail-inner" },
    h(
      "div",
      { className: "od-tl-detail-head" },
      h("span", { className: `${UI_CLASSES.badge} ${UI_CLASSES.tabular}` }, `Step ${ev.seq}`),
      h("strong", null, humanEventSummary(ev)),
      ev.receiptId ? h("span", { className: UI_CLASSES.badge }, "Receipt saved") : null,
      laneId && onInspectLane
        ? h(
            "button",
            {
              type: "button",
              className: "od-ghost-btn od-btn-xs",
              onclick: () => onInspectLane(laneId),
            },
            `View ${laneId} changes`,
          )
        : null,
    ),
    h(
      "div",
      { className: "od-tl-detail-meta" },
      h("span", { className: `${UI_CLASSES.muted} ${UI_CLASSES.tabular}` }, formatTime(ev.createdAt)),
      causes.length ? h("span", { className: `${UI_CLASSES.muted} ${UI_CLASSES.tabular}` }, `Triggered by step ${causes.join(", ")}`) : null,
    ),
    buildHumanPayloadRows(ev),
    h(
      "details",
      { className: "od-tl-raw" },
      h("summary", { className: UI_CLASSES.muted }, "Technical details"),
      h("pre", { className: "od-code-box od-tl-json" }, JSON.stringify(ev.payload || {}, null, 2)),
    ),
  );
}

/** Render causal activity timeline & replay scrubber into `container` without losing search focus. */
export function renderTimeline({
  container,
  mission,
  events = [],
  state = {},
  onScrub,
  onStep,
  onJumpLive,
  onToggleFollowTail,
  onFilterChange,
  onInspectLane,
}) {
  if (!container) return;

  const cursorSeq = state.cursorSeq ?? null;
  const followTail = state.followTail !== false;
  const filterLane = state.timelineFilterLane || "all";
  const filterKind = state.timelineFilterKind || "all";
  const searchQuery = state.timelineSearch || "";

  let dom = container._tlDom;
  const attached = dom && dom.root && dom.root.parentNode === container;

  if (!attached) {
    const controlsLeft = h("div", { className: "od-tl-controls-left" });
    const controlsRight = h("div", { className: "od-tl-controls-right" });
    const searchInput = h("input", {
      type: "search",
      className: "od-tl-search",
      placeholder: "Filter activity...",
      "aria-label": "Filter activity",
      oninput: (ev) => onFilterChange?.({ search: ev.target.value }),
    });
    const scrubberInput = h("input", {
      type: "range",
      className: UI_CLASSES.timelineScrubber,
      min: "0",
      max: "0",
      value: "0",
      "aria-label": "Replay build history",
      oninput: (ev) => {
        const list = dom._allEvents || [];
        const idx = Number(ev.target.value);
        if (!list.length) return;
        const clamped = Math.max(0, Math.min(list.length - 1, idx));
        const target = list[clamped];
        if (clamped === list.length - 1 && !dom._pinLast) {
          onJumpLive?.();
        } else if (target) {
          onScrub?.(target.seq);
        }
      },
    });
    const svgHost = h("div", { className: "od-tl-svg-host" });
    const pillsRow = h("div", { className: "od-tl-filters" });
    const listEl = h("ul", { className: "od-tl-list", role: "listbox", "aria-label": "Build activity log" });
    const detailEl = h("div", { className: "od-tl-detail" });

    const bodyGrid = h("div", { className: "od-tl-body" }, listEl, detailEl);
    const controlsBar = h(
      "div",
      { className: "od-tl-bar" },
      controlsLeft,
      h("div", { className: "od-tl-bar-mid" }, pillsRow),
      controlsRight,
    );
    controlsRight.appendChild(searchInput);

    const root = h(
      "div",
      { className: "od-tl-root" },
      controlsBar,
      h("div", { className: "od-tl-scrubber-wrap" }, svgHost, scrubberInput),
      bodyGrid,
    );

    dom = {
      root,
      controlsLeft,
      controlsRight,
      searchInput,
      scrubberInput,
      svgHost,
      pillsRow,
      listEl,
      detailEl,
      _allEvents: [],
      _pinLast: false,
    };
    container._tlDom = dom;
    setChildren(container, root);
  }

  dom._allEvents = events;

  const isLive = cursorSeq === null || cursorSeq === undefined;
  setChildren(
    dom.controlsLeft,
    h(
      "span",
      { className: `${UI_CLASSES.badge} ${isLive ? "is-pass" : "is-warn"} ${UI_CLASSES.tabular}` },
      isLive ? `Live (${events.length})` : `Replay · Step ${cursorSeq}`,
    ),
    h(
      "button",
      {
        type: "button",
        className: "od-ghost-btn od-btn-xs",
        "aria-label": "Previous step",
        onclick: () => onStep?.(-1),
      },
      "‹ Prev",
    ),
    h(
      "button",
      {
        type: "button",
        className: "od-ghost-btn od-btn-xs",
        "aria-label": "Next step",
        onclick: () => onStep?.(1),
      },
      "Next ›",
    ),
    h(
      "button",
      {
        type: "button",
        className: `${UI_CLASSES.btn} ${isLive ? UI_CLASSES.btnPrimary : UI_CLASSES.btnGhost} od-btn-xs`,
        onclick: () => onJumpLive?.(),
      },
      "Live",
    ),
    h(
      "button",
      {
        type: "button",
        className: `od-ghost-btn od-btn-xs ${followTail ? "is-active" : ""}`,
        "aria-pressed": followTail ? "true" : "false",
        onclick: () => onToggleFollowTail?.(),
      },
      followTail ? "Auto-follow" : "Paused",
    ),
  );

  const docActive = globalThis.document?.activeElement;
  if (docActive !== dom.searchInput && dom.searchInput.value !== searchQuery) {
    dom.searchInput.value = searchQuery;
  }

  const maxIdx = Math.max(0, events.length - 1);
  const curIdx = isLive ? maxIdx : Math.max(0, events.findIndex((e) => e.seq === cursorSeq));
  dom.scrubberInput.setAttribute("max", String(maxIdx));
  dom.scrubberInput.setAttribute("value", String(curIdx));
  dom.scrubberInput.value = String(curIdx);
  dom.scrubberInput.disabled = events.length === 0;

  setChildren(
    dom.svgHost,
    buildTimelineSvg({
      allEvents: events,
      cursorSeq: isLive ? null : Number(cursorSeq),
      onScrub,
    }),
  );

  const laneIds = new Set((mission?.lanes || []).map((l) => l.id));
  for (const ev of events) {
    if (ev.payload?.laneId) laneIds.add(ev.payload.laneId);
  }
  const lanePills = ["all", ...laneIds].map((id) =>
    h(
      "button",
      {
        type: "button",
        className: `od-pill-btn ${filterLane === id ? "is-active" : ""}`,
        onclick: () => onFilterChange?.({ lane: id }),
      },
      id === "all" ? "All teammates" : id,
    ),
  );
  const kindDefs = [
    ["all", "Everything"],
    ["mission", "Milestones"],
    ["contract", "Rules"],
    ["lane", "Teammates"],
    ["gate", "Checks"],
    ["errors", "Issues"],
  ];
  const kindPills = kindDefs.map(([k, label]) =>
    h(
      "button",
      {
        type: "button",
        className: `od-pill-btn ${filterKind === k ? "is-active" : ""}`,
        onclick: () => onFilterChange?.({ kind: k }),
      },
      label,
    ),
  );
  setChildren(dom.pillsRow, lanePills, h("span", { className: "od-pill-sep", "aria-hidden": "true" }, "|"), kindPills);

  const filtered = filterTimelineEvents(events, {
    lane: filterLane,
    kind: filterKind,
    search: searchQuery,
  });

  const ordered = [...filtered].reverse();
  const rows = ordered.map((ev) => {
    const tone = eventTone(ev);
    const isCurrent = !isLive && ev.seq === Number(cursorSeq);
    const isFuture = !isLive && ev.seq > Number(cursorSeq);
    const target = eventTargetText(ev);
    const summaryText = humanEventSummary(ev);
    const summaryMatches = findSubstringIndices(summaryText, searchQuery);
    const targetMatches = findSubstringIndices(target, searchQuery);

    const rowCls = [
      "od-tl-row",
      `is-${tone}`,
      isCurrent ? "is-current" : "",
      isFuture ? "is-future" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return h(
      "li",
      { className: "od-tl-item" },
      h(
        "button",
        {
          type: "button",
          className: rowCls,
          "data-seq": String(ev.seq),
          "aria-selected": isCurrent ? "true" : "false",
          onclick: () => onScrub?.(ev.seq),
        },
        h("span", { className: `${UI_CLASSES.mono} ${UI_CLASSES.tabular} od-tl-seq` }, `#${ev.seq}`),
        h("span", { className: `${UI_CLASSES.mono} ${UI_CLASSES.tabular} ${UI_CLASSES.muted} od-tl-ts` }, formatTime(ev.createdAt)),
        h("span", { className: "od-tl-type" }, ...highlightMatches(summaryText, summaryMatches)),
        h("span", { className: `${UI_CLASSES.muted} od-tl-target` }, ...highlightMatches(target, targetMatches)),
        ev.receiptId
          ? h(
              "span",
              { className: `${UI_CLASSES.badge} ${ev.payload?.status === "failed" || ev.payload?.scopeOk === false ? "is-fail" : ev.payload?.status === "verified" ? "is-pass" : ""}` },
              ev.payload?.status === "failed" || ev.payload?.scopeOk === false
                ? "failed"
                : ev.payload?.status === "scope_ok"
                  ? "files checked"
                  : "verified",
            )
          : null,
      ),
    );
  });

  setChildren(
    dom.listEl,
    rows.length
      ? rows
      : [h("li", { className: "od-tl-empty" }, h("span", { className: UI_CLASSES.muted }, events.length ? "No matching updates." : "The useful signals, without the noise."))],
  );

  const activeEv = !isLive
    ? events.find((e) => e.seq === Number(cursorSeq)) || filtered[filtered.length - 1]
    : filtered[filtered.length - 1] || events[events.length - 1];
  setChildren(dom.detailEl, buildDetailPane(activeEv || null, onInspectLane));
}
