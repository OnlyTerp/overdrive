export const ANCHOR_ERRORS = Object.freeze({
  ANCHOR_MISSING: "ANCHOR_MISSING",
  ANCHOR_AMBIGUOUS: "ANCHOR_AMBIGUOUS",
  ANCHOR_ORDER: "ANCHOR_ORDER",
  ANCHOR_OVERLAP: "ANCHOR_OVERLAP",
  REGION_OUTSIDE_EDIT: "REGION_OUTSIDE_EDIT",
});

function makeAnchorError(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

/**
 * Split text into line objects while preserving exact per-line EOLs (\r\n, \n, \r, or "").
 * lines.map((l) => l.raw).join("") reproduces the exact original text losslessly.
 */
export function splitLinesPreservingEndings(text) {
  const raw = String(text ?? "");
  if (raw.length === 0) return [];
  const out = [];
  let i = 0;
  while (i < raw.length) {
    let end = i;
    while (end < raw.length && raw[end] !== "\n" && raw[end] !== "\r") {
      end++;
    }
    const content = raw.slice(i, end);
    let eol = "";
    if (end < raw.length) {
      if (raw[end] === "\r" && raw[end + 1] === "\n") {
        eol = "\r\n";
      } else {
        eol = raw[end];
      }
    }
    out.push({
      index: out.length,
      content,
      eol,
      raw: content + eol,
    });
    i = end + eol.length;
  }
  return out;
}

/**
 * Resolve one exclusive region inside baseText, enforcing exact anchor uniqueness (=== 1)
 * for both startAnchor and endAnchor and startLine < endLine.
 */
export function resolveRegionInBase(baseText, region) {
  if (!region || typeof region !== "object") {
    throw makeAnchorError(ANCHOR_ERRORS.ANCHOR_MISSING, "region specification must be an object");
  }
  const { startAnchor, endAnchor } = region;
  const pathLabel = region.path ? ` in "${region.path}"` : "";
  if (typeof startAnchor !== "string" || !startAnchor) {
    throw makeAnchorError(ANCHOR_ERRORS.ANCHOR_MISSING, `startAnchor missing${pathLabel}`);
  }
  if (typeof endAnchor !== "string" || !endAnchor) {
    throw makeAnchorError(ANCHOR_ERRORS.ANCHOR_MISSING, `endAnchor missing${pathLabel}`);
  }

  const lines = splitLinesPreservingEndings(baseText);
  const startMatches = [];
  const endMatches = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].content.includes(startAnchor)) startMatches.push(i);
    if (lines[i].content.includes(endAnchor)) endMatches.push(i);
  }

  if (startMatches.length === 0) {
    throw makeAnchorError(ANCHOR_ERRORS.ANCHOR_MISSING, `startAnchor "${startAnchor}" not found${pathLabel}`);
  }
  if (startMatches.length > 1) {
    throw makeAnchorError(
      ANCHOR_ERRORS.ANCHOR_AMBIGUOUS,
      `startAnchor "${startAnchor}" matched ${startMatches.length} lines${pathLabel}`,
    );
  }
  if (endMatches.length === 0) {
    throw makeAnchorError(ANCHOR_ERRORS.ANCHOR_MISSING, `endAnchor "${endAnchor}" not found${pathLabel}`);
  }
  if (endMatches.length > 1) {
    throw makeAnchorError(
      ANCHOR_ERRORS.ANCHOR_AMBIGUOUS,
      `endAnchor "${endAnchor}" matched ${endMatches.length} lines${pathLabel}`,
    );
  }

  const startLine = startMatches[0];
  const endLine = endMatches[0];
  if (startLine >= endLine) {
    throw makeAnchorError(
      ANCHOR_ERRORS.ANCHOR_ORDER,
      `startAnchor line (${startLine}) must precede endAnchor line (${endLine})${pathLabel}`,
    );
  }

  return {
    path: region.path || null,
    startAnchor,
    endAnchor,
    boundaryMode: region.boundaryMode || "exclusive",
    startLine,
    endLine,
    interiorStart: startLine + 1,
    interiorEnd: endLine,
    interiorLines: lines.slice(startLine + 1, endLine),
    lines,
  };
}

/**
 * Validate all lanes' ownedRegions against base file contents read via readBaseFileFn(path).
 * Groups by file path, sorts by startLine, and fails with ANCHOR_OVERLAP if any prev.endLine >= curr.startLine.
 */
export function validateBaseSeams(readBaseFileFn, lanes = []) {
  const byPath = new Map();
  const baseCache = new Map();

  for (const lane of lanes || []) {
    const regions = Array.isArray(lane?.ownedRegions) ? lane.ownedRegions : [];
    for (const region of regions) {
      const filePath = region.path;
      if (!baseCache.has(filePath)) {
        const text = readBaseFileFn(filePath);
        if (text === null || text === undefined) {
          return {
            ok: false,
            code: ANCHOR_ERRORS.ANCHOR_MISSING,
            error: `${ANCHOR_ERRORS.ANCHOR_MISSING}: base file "${filePath}" not found`,
          };
        }
        baseCache.set(filePath, String(text));
      }
      let resolved;
      try {
        resolved = resolveRegionInBase(baseCache.get(filePath), region);
      } catch (err) {
        return {
          ok: false,
          code: err.code || ANCHOR_ERRORS.ANCHOR_MISSING,
          error: err.message,
          laneId: lane.id,
          path: filePath,
        };
      }
      if (!byPath.has(filePath)) byPath.set(filePath, []);
      byPath.get(filePath).push({
        laneId: lane.id,
        region,
        startLine: resolved.startLine,
        endLine: resolved.endLine,
      });
    }
  }

  const normalizedByPath = {};
  for (const [filePath, list] of byPath.entries()) {
    list.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const curr = list[i];
      if (prev.endLine >= curr.startLine) {
        return {
          ok: false,
          code: ANCHOR_ERRORS.ANCHOR_OVERLAP,
          error: `${ANCHOR_ERRORS.ANCHOR_OVERLAP}: regions in "${filePath}" (${prev.laneId} [${prev.startLine}..${prev.endLine}] vs ${curr.laneId} [${curr.startLine}..${curr.endLine}]) overlap`,
          path: filePath,
          prev,
          curr,
        };
      }
    }
    normalizedByPath[filePath] = list;
  }

  return { ok: true, code: null, error: null, byPath: normalizedByPath };
}

/**
 * Verify that laneText preserves unique start/end anchors (count === 1) for every region in laneRegions
 * AND every line outside the exclusive (startLine, endLine) interiors is line-for-line identical to baseText.
 */
export function verifyLaneRegionContainment(baseText, laneText, laneRegions = []) {
  const regions = Array.isArray(laneRegions) ? laneRegions : [];
  const baseLines = splitLinesPreservingEndings(baseText);
  const laneLines = splitLinesPreservingEndings(laneText);

  if (regions.length === 0) {
    if (String(baseText) !== String(laneText)) {
      return {
        ok: false,
        code: ANCHOR_ERRORS.REGION_OUTSIDE_EDIT,
        error: `${ANCHOR_ERRORS.REGION_OUTSIDE_EDIT}: file modified without any declared ownedRegions`,
      };
    }
    return { ok: true, code: null, error: null, regions: [] };
  }

  const pairs = [];
  for (const region of regions) {
    let bRes;
    let lRes;
    try {
      bRes = resolveRegionInBase(baseText, region);
      lRes = resolveRegionInBase(laneText, region);
    } catch (err) {
      return {
        ok: false,
        code: err.code || ANCHOR_ERRORS.ANCHOR_MISSING,
        error: err.message,
      };
    }
    pairs.push({
      region,
      baseStartLine: bRes.startLine,
      baseEndLine: bRes.endLine,
      laneStartLine: lRes.startLine,
      laneEndLine: lRes.endLine,
      laneInteriorLines: lRes.interiorLines,
    });
  }

  pairs.sort((a, b) => a.baseStartLine - b.baseStartLine || a.baseEndLine - b.baseEndLine);

  for (let i = 1; i < pairs.length; i++) {
    const prev = pairs[i - 1];
    const curr = pairs[i];
    if (prev.baseEndLine >= curr.baseStartLine) {
      return {
        ok: false,
        code: ANCHOR_ERRORS.ANCHOR_OVERLAP,
        error: `${ANCHOR_ERRORS.ANCHOR_OVERLAP}: lane regions overlap in base (${prev.baseStartLine}..${prev.baseEndLine} vs ${curr.baseStartLine}..${curr.baseEndLine})`,
      };
    }
    if (prev.laneEndLine >= curr.laneStartLine) {
      return {
        ok: false,
        code: ANCHOR_ERRORS.REGION_OUTSIDE_EDIT,
        error: `${ANCHOR_ERRORS.REGION_OUTSIDE_EDIT}: region anchors reordered or overlapping in lane version`,
      };
    }
  }

  const compareSegment = (bFrom, bToInclusive, lFrom, lToInclusive) => {
    const bLen = bToInclusive - bFrom + 1;
    const lLen = lToInclusive - lFrom + 1;
    if (bLen !== lLen) {
      return {
        ok: false,
        code: ANCHOR_ERRORS.REGION_OUTSIDE_EDIT,
        error: `${ANCHOR_ERRORS.REGION_OUTSIDE_EDIT}: outside-region line count changed (base ${bLen} lines vs lane ${lLen} lines around base line ${bFrom + 1})`,
      };
    }
    for (let offset = 0; offset < bLen; offset++) {
      if (baseLines[bFrom + offset].raw !== laneLines[lFrom + offset].raw) {
        return {
          ok: false,
          code: ANCHOR_ERRORS.REGION_OUTSIDE_EDIT,
          error: `${ANCHOR_ERRORS.REGION_OUTSIDE_EDIT}: line ${bFrom + offset + 1} outside exclusive region interior was modified`,
        };
      }
    }
    return { ok: true };
  };

  let bCursor = 0;
  let lCursor = 0;
  for (const pair of pairs) {
    const segCheck = compareSegment(bCursor, pair.baseStartLine, lCursor, pair.laneStartLine);
    if (!segCheck.ok) return segCheck;
    bCursor = pair.baseEndLine;
    lCursor = pair.laneEndLine;
  }
  const tailCheck = compareSegment(bCursor, baseLines.length - 1, lCursor, laneLines.length - 1);
  if (!tailCheck.ok) return tailCheck;

  return { ok: true, code: null, error: null, regions: pairs };
}

/**
 * Deterministically splice multiple disjoint lane versions onto baseText in ascending startLine order.
 * Validates region containment for every lane version before merging.
 */
export function mergeRegions({ baseText, laneVersions = [], filePath = null } = {}) {
  const baseLines = splitLinesPreservingEndings(baseText);
  const allItems = [];

  for (const lv of laneVersions || []) {
    const laneId = lv?.laneId || "unknown";
    const rawRegions = Array.isArray(lv?.regions) ? lv.regions : [];
    const regions = filePath ? rawRegions.filter((r) => !r.path || r.path === filePath) : rawRegions;
    const check = verifyLaneRegionContainment(baseText, lv?.text ?? "", regions);
    if (!check.ok) {
      throw makeAnchorError(
        check.code || ANCHOR_ERRORS.REGION_OUTSIDE_EDIT,
        `lane "${laneId}" failed containment: ${check.error}`,
      );
    }
    for (const pair of check.regions) {
      allItems.push({ laneId, ...pair });
    }
  }

  allItems.sort((a, b) => a.baseStartLine - b.baseStartLine || a.baseEndLine - b.baseEndLine);
  for (let i = 1; i < allItems.length; i++) {
    const prev = allItems[i - 1];
    const curr = allItems[i];
    if (prev.baseEndLine >= curr.baseStartLine) {
      throw makeAnchorError(
        ANCHOR_ERRORS.ANCHOR_OVERLAP,
        `lanes "${prev.laneId}" (${prev.baseStartLine}..${prev.baseEndLine}) and "${curr.laneId}" (${curr.baseStartLine}..${curr.baseEndLine}) overlap`,
      );
    }
  }

  const outChunks = [];
  let cursor = 0;
  for (const item of allItems) {
    for (let i = cursor; i <= item.baseStartLine; i++) {
      outChunks.push(baseLines[i].raw);
    }
    for (const line of item.laneInteriorLines) {
      outChunks.push(line.raw);
    }
    cursor = item.baseEndLine;
  }
  for (let i = cursor; i < baseLines.length; i++) {
    outChunks.push(baseLines[i].raw);
  }

  return {
    ok: true,
    text: outChunks.join(""),
    applied: allItems.map((it) => ({
      laneId: it.laneId,
      startAnchor: it.region.startAnchor,
      endAnchor: it.region.endAnchor,
      baseStartLine: it.baseStartLine,
      baseEndLine: it.baseEndLine,
    })),
  };
}
