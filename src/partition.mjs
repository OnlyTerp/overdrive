// Deterministic topology & glob-collision engine for zero-collision parallel swarm lanes.
// Must remain 100% pure browser-safe ESM (ZERO node:* imports) because ui/contracts.js re-exports it.

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const GLOB_META_RE = /[*?[\]{}]/;
const NEWLINE_RE = /[\r\n]/;

export const OFFLOAD_MODES = Object.freeze([
  "local",
  "auto",
  "aipc",
  "aipc-gpu",
  "devin-vm",
  "cloud-agent",
]);
const OFFLOAD_MODE_SET = new Set(OFFLOAD_MODES);

/**
 * Normalize a repo-relative file path or glob pattern.
 * Strips leading "./", converts "\" -> "/", collapses repeated "/",
 * and rejects absolute paths or parent-directory traversal.
 */
export function normalizeRelPattern(raw) {
  if (typeof raw !== "string") {
    throw new Error("Path/glob must be a non-empty string.");
  }
  let p = raw.trim().replaceAll("\\", "/").replace(/\/+/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  if (p.endsWith("/") && p.length > 1) p = p.slice(0, -1);
  if (!p || p === ".") {
    throw new Error("Empty or root-level pattern is not allowed; specify explicit files or subdirectories.");
  }
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) {
    throw new Error(`Pattern must be repo-relative, got "${raw}".`);
  }
  const parts = p.split("/");
  if (parts.some((seg) => seg === ".." || seg === ".")) {
    throw new Error(`Pattern cannot contain traversal segments ("." or ".."), got "${raw}".`);
  }
  if (p === "*" || p === "**" || p === "**/*") {
    throw new Error(`Catch-all pattern "${raw}" is forbidden because it claims the entire repository.`);
  }
  return p;
}

function escapeRegex(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function segRegex(seg) {
  let out = "^";
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += escapeRegex(ch);
  }
  return new RegExp(out + "$");
}

function segmentsOverlap(segA, segB) {
  if (segA === "*" || segB === "*") return true;
  if (!segA.includes("*") && !segA.includes("?") && !segB.includes("*") && !segB.includes("?")) {
    return segA === segB;
  }
  const ra = segRegex(segA);
  const rb = segRegex(segB);
  if (!segB.includes("*") && !segB.includes("?")) return ra.test(segB);
  if (!segA.includes("*") && !segA.includes("?")) return rb.test(segA);

  // Bounded NFA product check for two single-segment globs.
  const memo = new Map();
  function match(i, j) {
    const key = `${i}:${j}`;
    if (memo.has(key)) return memo.get(key);
    let res = false;
    if (i === segA.length && j === segB.length) res = true;
    else if (i < segA.length && segA[i] === "*") {
      res = match(i + 1, j) || (j < segB.length && match(i, j + 1)) || (j < segB.length && segB[j] === "*" && match(i, j + 1));
    } else if (j < segB.length && segB[j] === "*") {
      res = match(i, j + 1) || (i < segA.length && match(i + 1, j));
    } else if (i < segA.length && j < segB.length) {
      if (segA[i] === "?" || segB[j] === "?" || segA[i] === segB[j]) {
        res = match(i + 1, j + 1);
      }
    }
    memo.set(key, res);
    return res;
  }
  return match(0, 0);
}

/**
 * Convert a normalized path or glob pattern into a segment list.
 * Treat bare directory-like patterns carefully: we don't assume a bare name is a dir unless
 * it ends with /** or /*; however if someone writes "src" and another writes "src/a.js",
 * check exact path vs directory prefix safely via segment matching.
 */
function splitSegments(norm) {
  return norm.split("/");
}

/**
 * Determine if two normalized repo-relative globs/paths can match at least one common path
 * (including directory/file containment, ** recursion, and wildcard segment overlap).
 */
export function globOverlaps(rawA, rawB) {
  const a = normalizeRelPattern(rawA);
  const b = normalizeRelPattern(rawB);
  if (a === b) return true;

  // Handle "dir" vs "dir/sub..." prefix (no one should own a file AND its parent path).
  if (b.startsWith(a + "/") || a.startsWith(b + "/")) return true;

  const segsA = splitSegments(a);
  const segsB = splitSegments(b);
  const memo = new Map();

  function overlapAt(i, j) {
    const key = `${i}:${j}`;
    if (memo.has(key)) return memo.get(key);
    let res = false;

    if (i === segsA.length && j === segsB.length) {
      res = true;
    } else if (i < segsA.length && segsA[i] === "**") {
      // "**" matches 0 or more path segments.
      res = overlapAt(i + 1, j) || (j < segsB.length && overlapAt(i, j + 1));
    } else if (j < segsB.length && segsB[j] === "**") {
      res = overlapAt(i, j + 1) || (i < segsA.length && overlapAt(i + 1, j));
    } else if (i < segsA.length && j < segsB.length) {
      if (segmentsOverlap(segsA[i], segsB[j])) {
        res = overlapAt(i + 1, j + 1);
      }
    }

    memo.set(key, res);
    return res;
  }

  return overlapAt(0, 0);
}

/** Match a concrete repo-relative file path against a single pattern. */
export function fileMatchesGlob(relFile, rawPattern) {
  const f = normalizeRelPattern(relFile);
  const p = normalizeRelPattern(rawPattern);
  if (f === p) return true;
  if (f.startsWith(p + "/")) return true;

  const fSegs = splitSegments(f);
  const pSegs = splitSegments(p);
  const memo = new Map();

  function match(fi, pi) {
    const key = `${fi}:${pi}`;
    if (memo.has(key)) return memo.get(key);
    let res = false;
    if (fi === fSegs.length && pi === pSegs.length) res = true;
    else if (pi < pSegs.length && pSegs[pi] === "**") {
      res = match(fi, pi + 1) || (fi < fSegs.length && match(fi + 1, pi));
    } else if (fi < fSegs.length && pi < pSegs.length && segmentsOverlap(fSegs[fi], pSegs[pi])) {
      res = match(fi + 1, pi + 1);
    }
    memo.set(key, res);
    return res;
  }

  return match(0, 0);
}

export function fileMatchesAnyGlob(relFile, globs) {
  return (globs || []).some((g) => fileMatchesGlob(relFile, g));
}

function validateRegionEntry(reg, laneId, idx, errors) {
  const prefix = `Lane "${laneId}" ownedRegions[${idx}]`;
  if (!reg || typeof reg !== "object" || Array.isArray(reg)) {
    errors.push(`${prefix} must be an object.`);
    return null;
  }
  let p;
  try {
    p = normalizeRelPattern(reg.path);
  } catch (e) {
    errors.push(`${prefix}: ${e.message}`);
    return null;
  }
  if (GLOB_META_RE.test(p)) {
    errors.push(`${prefix}.path must be a concrete file path, not a wildcard ("${p}").`);
    return null;
  }
  const startAnchor = typeof reg.startAnchor === "string" ? reg.startAnchor : "";
  const endAnchor = typeof reg.endAnchor === "string" ? reg.endAnchor : "";
  if (startAnchor.trim().length < 3 || NEWLINE_RE.test(startAnchor)) {
    errors.push(`${prefix}.startAnchor must be a single-line string of length >= 3.`);
    return null;
  }
  if (endAnchor.trim().length < 3 || NEWLINE_RE.test(endAnchor)) {
    errors.push(`${prefix}.endAnchor must be a single-line string of length >= 3.`);
    return null;
  }
  if (startAnchor === endAnchor) {
    errors.push(`${prefix}: startAnchor and endAnchor must be distinct.`);
    return null;
  }
  const boundaryMode = reg.boundaryMode ?? "exclusive";
  if (boundaryMode !== "exclusive") {
    errors.push(`${prefix}.boundaryMode must be "exclusive".`);
    return null;
  }
  return {
    path: p,
    startAnchor,
    endAnchor,
    boundaryMode,
  };
}

/**
 * Validate shared contracts + parallel lane ownership topology.
 * Rejects empty lanes, invalid IDs, missing verifyCmd, contract/lane overlaps,
 * invalid ownedRegions/offload modes, and pairwise lane/lane glob collisions.
 */
export function validateTopology({ sharedContracts = [], lanes = [], gates = [] } = {}) {
  const errors = [];
  const collisions = [];

  if (!Array.isArray(sharedContracts)) {
    return { ok: false, errors: ["sharedContracts must be an array."], collisions, normalized: null };
  }
  if (!Array.isArray(lanes) || lanes.length === 0) {
    return { ok: false, errors: ["At least one lane is required in topology."], collisions, normalized: null };
  }

  const normContracts = [];
  const seenContracts = new Set();
  for (const item of sharedContracts) {
    const rawPath = typeof item === "string" ? item : item?.path;
    const desc = typeof item === "object" && item?.description ? String(item.description) : "";
    const allowCreateAtFreeze = Boolean(typeof item === "object" && item?.allowCreateAtFreeze);
    try {
      const p = normalizeRelPattern(rawPath);
      if (p.includes("*") || p.includes("?")) {
        errors.push(`Shared contract "${rawPath}" must name a concrete file path, not a wildcard.`);
        continue;
      }
      if (!seenContracts.has(p)) {
        seenContracts.add(p);
        normContracts.push({ path: p, description: desc, allowCreateAtFreeze });
      }
    } catch (e) {
      errors.push(e.message);
    }
  }

  const normLanes = [];
  const seenLaneIds = new Set();
  const seenRegionKeys = new Map();
  for (const lane of lanes) {
    const id = String(lane?.id || "").trim();
    if (!ID_RE.test(id)) {
      errors.push(`Invalid lane id "${id}": must match ${ID_RE}`);
      continue;
    }
    if (seenLaneIds.has(id)) {
      errors.push(`Duplicate lane id "${id}".`);
      continue;
    }
    seenLaneIds.add(id);

    const hasGlobs = Array.isArray(lane.ownedGlobs) && lane.ownedGlobs.length > 0;
    const hasRegions = Array.isArray(lane.ownedRegions) && lane.ownedRegions.length > 0;
    if (!hasGlobs && !hasRegions) {
      errors.push(`Lane "${id}" must define non-empty ownedGlobs.`);
      continue;
    }
    const verifyCmd = String(lane.verifyCmd || "").trim();
    if (!verifyCmd) {
      errors.push(`Lane "${id}" must define a non-empty verifyCmd.`);
      continue;
    }

    const normGlobs = [];
    for (const g of hasGlobs ? lane.ownedGlobs : []) {
      try {
        normGlobs.push(normalizeRelPattern(g));
      } catch (e) {
        errors.push(`Lane "${id}": ${e.message}`);
      }
    }

    const normRegions = [];
    if (lane.ownedRegions !== undefined) {
      if (!Array.isArray(lane.ownedRegions)) {
        errors.push(`Lane "${id}" ownedRegions must be an array.`);
      } else {
        lane.ownedRegions.forEach((reg, idx) => {
          const nr = validateRegionEntry(reg, id, idx, errors);
          if (!nr) return;
          if (fileMatchesAnyGlob(nr.path, normGlobs)) {
            collisions.push({
              kind: "region_glob_overlap",
              laneId: id,
              path: nr.path,
              message: `Lane "${id}" ownedRegions path "${nr.path}" is already covered by its ownedGlobs.`,
            });
            return;
          }
          const key = `${nr.path}\0${nr.startAnchor}\0${nr.endAnchor}`;
          if (seenRegionKeys.has(key)) {
            collisions.push({
              kind: "region_duplicate_anchor",
              laneId: id,
              otherLaneId: seenRegionKeys.get(key),
              path: nr.path,
              message: `Duplicate region anchor pair on "${nr.path}" between "${id}" and "${seenRegionKeys.get(key)}".`,
            });
            return;
          }
          seenRegionKeys.set(key, id);
          normRegions.push(nr);
        });
      }
    }

    const ignoreUntrackedGlobs = [];
    if (Array.isArray(lane.ignoreUntrackedGlobs)) {
      for (const ig of lane.ignoreUntrackedGlobs) {
        try {
          ignoreUntrackedGlobs.push(normalizeRelPattern(ig));
        } catch (e) {
          errors.push(`Lane "${id}" ignoreUntrackedGlobs: ${e.message}`);
        }
      }
    }

    const readOnlyMounts = [];
    if (Array.isArray(lane.readOnlyMounts)) {
      for (const m of lane.readOnlyMounts) {
        if (!m || typeof m !== "object" || typeof m.source !== "string" || typeof m.target !== "string") {
          errors.push(`Lane "${id}" readOnlyMounts entries must contain { source, target }.`);
          continue;
        }
        try {
          const target = normalizeRelPattern(m.target);
          readOnlyMounts.push({ source: m.source.trim(), target });
        } catch (e) {
          errors.push(`Lane "${id}" readOnlyMounts: ${e.message}`);
        }
      }
    }

    if (lane.offload !== undefined && !OFFLOAD_MODE_SET.has(lane.offload)) {
      errors.push(`Lane "${id}" offload must be one of: ${OFFLOAD_MODES.join(", ")}.`);
    }
    const complexity = ["hard", "standard", "fast"].includes(lane.complexity) ? lane.complexity : "standard";
    const offload = OFFLOAD_MODE_SET.has(lane.offload) ? lane.offload : "auto";
    normLanes.push({
      id,
      title: String(lane.title || id).trim(),
      brief: String(lane.brief || "").trim(),
      complexity,
      offload,
      ownedGlobs: normGlobs,
      ...(normRegions.length ? { ownedRegions: normRegions } : {}),
      ...(ignoreUntrackedGlobs.length ? { ignoreUntrackedGlobs } : {}),
      ...(readOnlyMounts.length ? { readOnlyMounts } : {}),
      ...(lane.ratchet && typeof lane.ratchet === "object" ? { ratchet: lane.ratchet } : {}),
      verifyCmd,
      worker: lane.worker || null,
      verifier: lane.verifier || null,
    });
  }

  // Check frozen contracts vs lane ownedGlobs & ownedRegions.
  for (const c of normContracts) {
    for (const lane of normLanes) {
      for (const g of lane.ownedGlobs) {
        if (globOverlaps(c.path, g)) {
          collisions.push({
            kind: "contract_lane_overlap",
            contract: c.path,
            laneId: lane.id,
            glob: g,
            message: `Frozen contract "${c.path}" overlaps lane "${lane.id}" glob "${g}".`,
          });
        }
      }
      for (const r of lane.ownedRegions || []) {
        if (r.path === c.path) {
          collisions.push({
            kind: "contract_region_overlap",
            contract: c.path,
            laneId: lane.id,
            message: `Frozen contract "${c.path}" overlaps lane "${lane.id}" ownedRegion.`,
          });
        }
      }
    }
  }

  // Pairwise lane vs lane checks (glob-vs-glob and region-vs-glob).
  for (let i = 0; i < normLanes.length; i++) {
    for (let j = i + 1; j < normLanes.length; j++) {
      const a = normLanes[i];
      const b = normLanes[j];
      for (const ga of a.ownedGlobs) {
        for (const gb of b.ownedGlobs) {
          if (globOverlaps(ga, gb)) {
            collisions.push({
              kind: "lane_lane_overlap",
              laneA: a.id,
              globA: ga,
              laneB: b.id,
              globB: gb,
              message: `Lane "${a.id}" glob "${ga}" collides with lane "${b.id}" glob "${gb}".`,
            });
          }
        }
      }
      for (const ra of a.ownedRegions || []) {
        if (fileMatchesAnyGlob(ra.path, b.ownedGlobs)) {
          collisions.push({
            kind: "region_lane_glob_overlap",
            laneA: a.id,
            path: ra.path,
            laneB: b.id,
            message: `Lane "${a.id}" ownedRegion "${ra.path}" overlaps lane "${b.id}" ownedGlobs.`,
          });
        }
      }
      for (const rb of b.ownedRegions || []) {
        if (fileMatchesAnyGlob(rb.path, a.ownedGlobs)) {
          collisions.push({
            kind: "region_lane_glob_overlap",
            laneA: b.id,
            path: rb.path,
            laneB: a.id,
            message: `Lane "${b.id}" ownedRegion "${rb.path}" overlaps lane "${a.id}" ownedGlobs.`,
          });
        }
      }
    }
  }

  const normGates = [];
  const seenGateIds = new Set();
  for (const g of Array.isArray(gates) ? gates : []) {
    const id = String(g?.id || "").trim();
    if (!ID_RE.test(id)) {
      errors.push(`Invalid gate id "${id}".`);
      continue;
    }
    if (seenGateIds.has(id)) {
      errors.push(`Duplicate gate id "${id}".`);
      continue;
    }
    seenGateIds.add(id);
    const cmd = String(g?.cmd || "").trim();
    if (!cmd) {
      errors.push(`Gate "${id}" must define a non-empty cmd.`);
      continue;
    }
    if (g.offload !== undefined && !OFFLOAD_MODE_SET.has(g.offload)) {
      errors.push(`Gate "${id}" offload must be one of: ${OFFLOAD_MODES.join(", ")}.`);
      continue;
    }
    normGates.push({
      id,
      title: String(g.title || id).trim(),
      cmd,
      offload: OFFLOAD_MODE_SET.has(g.offload) ? g.offload : "auto",
      required: g.required !== false,
      ...(g.ratchet && typeof g.ratchet === "object" ? { ratchet: g.ratchet } : {}),
    });
  }

  const ok = errors.length === 0 && collisions.length === 0;
  return {
    ok,
    errors,
    collisions,
    normalized: ok ? { sharedContracts: normContracts, lanes: normLanes, gates: normGates } : null,
  };
}
