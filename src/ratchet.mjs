import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultPrivateDir } from "./paths.mjs";
import { toPublicRatchetSpec, validateRatchetResult, validateRatchetSpec } from "./ui-contracts.mjs";

export { toPublicRatchetSpec };

const METRIC_LINE_RE = /^OVERDRIVE_METRICS_JSON:(?:\[nonce=([a-zA-Z0-9_-]+)\]:)?\s*(\{.*\})\s*$/;
const METRIC_PREFIX_RE = /^OVERDRIVE_METRICS_JSON:(?:\[nonce=([a-zA-Z0-9_-]+)\]:)?\s*(.*)$/;

const FORBIDDEN_PRIVATE_KEYS = Object.freeze([
  "holdoutCmd",
  "holdoutEnv",
  "holdoutCwd",
  "holdoutMetrics",
  "holdoutMetricsSpec",
  "holdoutStdout",
  "holdoutStderr",
  "holdoutRawOutput",
]);

/** Remove all coordinator-private holdout fields, including holdoutMetricsSpec aliases. */
export function stripPrivateRatchetFields(spec) {
  const pub = toPublicRatchetSpec(spec);
  if (pub && typeof pub === "object") {
    for (const k of FORBIDDEN_PRIVATE_KEYS) {
      delete pub[k];
    }
  }
  return pub;
}

/** Extract only coordinator-private holdout fields from a raw ratchet spec (or null if none). */
export function extractPrivateHoldoutFields(spec) {
  if (!isPlainObject(spec)) return null;
  const priv = {};
  for (const k of ["holdoutCmd", "holdoutEnv", "holdoutCwd", "holdoutMetrics", "holdoutMetricsSpec"]) {
    if (spec[k] !== undefined) priv[k] = spec[k];
  }
  return Object.keys(priv).length > 0 ? priv : null;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isFiniteNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function validateMetricsObject(obj, requiredKeys = []) {
  if (!isPlainObject(obj)) {
    return { ok: false, code: "METRICS_INVALID_JSON", error: "METRICS_INVALID_JSON: metrics payload must be a plain JSON object" };
  }
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!isFiniteNum(v)) {
      return {
        ok: false,
        code: "METRICS_NON_FINITE",
        error: `METRICS_NON_FINITE: metric "${k}" must be a finite number, got ${String(v)}`,
      };
    }
    clean[k] = v;
  }
  for (const reqKey of requiredKeys || []) {
    if (!Object.hasOwn(clean, reqKey)) {
      return {
        ok: false,
        code: "METRICS_MISSING_KEY",
        error: `METRICS_MISSING_KEY: missing required metric "${reqKey}"`,
      };
    }
  }
  return { ok: true, metrics: clean };
}

/**
 * Scan stdout line-by-line for exactly one OVERDRIVE_METRICS_JSON line.
 * Rejects missing lines, duplicate emits, non-object/null/array JSON, non-finite numbers,
 * nonce mismatches, and missing requiredKeys.
 */
export function extractOverdriveMetrics(stdout, { expectedNonce = null, requiredKeys = [] } = {}) {
  const lines = String(stdout ?? "").split(/\r?\n/);
  const strictMatches = [];
  const prefixMatches = [];

  for (const line of lines) {
    const strict = line.match(METRIC_LINE_RE);
    if (strict) {
      strictMatches.push({ line, nonce: strict[1] ?? null, jsonText: strict[2] });
      prefixMatches.push(line);
      continue;
    }
    if (METRIC_PREFIX_RE.test(line)) {
      prefixMatches.push(line);
    }
  }

  if (prefixMatches.length > 1 || strictMatches.length > 1) {
    return {
      ok: false,
      code: "METRICS_AMBIGUOUS_MULTI_EMIT",
      error: `METRICS_AMBIGUOUS_MULTI_EMIT: expected 1 OVERDRIVE_METRICS_JSON line, found ${Math.max(strictMatches.length, prefixMatches.length)}`,
      metrics: null,
      nonce: null,
    };
  }

  if (strictMatches.length === 0) {
    if (prefixMatches.length === 1) {
      const m = prefixMatches[0].match(METRIC_PREFIX_RE);
      const rawPayload = (m?.[2] ?? "").trim();
      return {
        ok: false,
        code: "METRICS_INVALID_JSON",
        error: `METRICS_INVALID_JSON: OVERDRIVE_METRICS_JSON payload must be a JSON object, got "${rawPayload.slice(0, 80)}"`,
        metrics: null,
        nonce: m?.[1] ?? null,
      };
    }
    return {
      ok: false,
      code: "METRICS_MISSING",
      error: "METRICS_MISSING: no OVERDRIVE_METRICS_JSON line found in stdout",
      metrics: null,
      nonce: null,
    };
  }

  const matched = strictMatches[0];
  if (expectedNonce !== null && expectedNonce !== undefined && expectedNonce !== "") {
    if (matched.nonce !== String(expectedNonce)) {
      return {
        ok: false,
        code: "METRICS_NONCE_MISMATCH",
        error: `METRICS_NONCE_MISMATCH: expected nonce "${expectedNonce}", got "${matched.nonce ?? "none"}"`,
        metrics: null,
        nonce: matched.nonce,
      };
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(matched.jsonText);
  } catch (err) {
    return {
      ok: false,
      code: "METRICS_INVALID_JSON",
      error: `METRICS_INVALID_JSON: failed to parse JSON (${err.message})`,
      metrics: null,
      nonce: matched.nonce,
    };
  }

  const check = validateMetricsObject(parsed, requiredKeys);
  if (!check.ok) {
    return {
      ok: false,
      code: check.code,
      error: check.error,
      metrics: null,
      nonce: matched.nonce,
    };
  }

  return {
    ok: true,
    code: null,
    error: null,
    metrics: check.metrics,
    nonce: matched.nonce,
  };
}

function compareMetricRule(rule, actual, scopeLabel = "") {
  const op = rule.op ?? (rule.direction === "lower" ? "<=" : ">=");
  const baseVal = rule.baseline !== undefined ? rule.baseline : rule.target;
  const threshold = rule.target !== undefined ? rule.target : rule.baseline;
  const slack = rule.maxRegression ?? rule.tolerance ?? 0;
  const delta = actual - baseVal;
  const prefix = scopeLabel ? `${scopeLabel} ` : "";

  let passed = false;
  switch (op) {
    case ">=":
      passed = actual >= threshold - slack;
      if (passed && rule.baseline !== undefined && rule.maxRegression !== undefined) {
        passed = actual >= rule.baseline - rule.maxRegression;
      }
      break;
    case "<=":
      passed = actual <= threshold + slack;
      if (passed && rule.baseline !== undefined && rule.maxRegression !== undefined) {
        passed = actual <= rule.baseline + rule.maxRegression;
      }
      break;
    case "==":
      passed = Math.abs(actual - threshold) <= (rule.tolerance ?? rule.maxRegression ?? 0);
      break;
    case "delta>=": {
      const reqDelta = rule.target !== undefined ? rule.target : 0;
      const dBase = rule.baseline !== undefined ? actual - rule.baseline : actual;
      passed = dBase >= reqDelta - slack;
      break;
    }
    case "delta<=": {
      const reqDelta = rule.target !== undefined ? rule.target : 0;
      const dBase = rule.baseline !== undefined ? actual - rule.baseline : actual;
      passed = dBase <= reqDelta + slack;
      break;
    }
    default:
      return {
        passed: false,
        baseVal,
        delta,
        violation: `METRIC_REGRESSION: ${prefix}unsupported op "${op}" on "${rule.name}"`,
      };
  }

  return {
    passed,
    baseVal,
    delta,
    violation: passed
      ? null
      : `METRIC_REGRESSION: ${prefix}${rule.name}=${actual} failed ${op} ${threshold} (baseline=${baseVal}, delta=${Number(delta.toFixed(6))}, tolerance=${slack})`,
  };
}

function evaluateHoldoutChecks(spec, holdoutExitCode, holdoutMetrics, violations) {
  let holdoutPassed = true;

  if (holdoutExitCode !== null && holdoutExitCode !== undefined) {
    if (!Number.isInteger(holdoutExitCode) || holdoutExitCode !== 0) {
      holdoutPassed = false;
      violations.push(`HOLDOUT_FAILED: holdout command exited with ${holdoutExitCode}`);
    }
  }

  const hasExplicitHoldoutSpec = Boolean(spec.holdoutMetrics || spec.holdoutMetricsSpec);
  if (holdoutMetrics === null || holdoutMetrics === undefined) {
    if (holdoutExitCode === 0 && hasExplicitHoldoutSpec) {
      holdoutPassed = false;
      violations.push("METRICS_MISSING: holdout exited 0 without emitting OVERDRIVE_METRICS_JSON for holdoutMetrics");
    }
    return holdoutPassed;
  }

  if (holdoutMetrics !== null && holdoutMetrics !== undefined) {
    const check = validateMetricsObject(holdoutMetrics, []);
    if (!check.ok) {
      holdoutPassed = false;
      violations.push(check.error);
      return holdoutPassed;
    }
    const hm = check.metrics;
    const customRules = Array.isArray(spec.holdoutMetrics)
      ? spec.holdoutMetrics
      : Array.isArray(spec.holdoutMetricsSpec)
        ? spec.holdoutMetricsSpec
        : null;

    if (customRules) {
      for (const rule of customRules) {
        if (!Object.hasOwn(hm, rule.name)) {
          holdoutPassed = false;
          violations.push(`METRICS_MISSING_KEY: holdout missing metric "${rule.name}"`);
          continue;
        }
        const cmp = compareMetricRule(rule, hm[rule.name], "holdout");
        if (!cmp.passed) {
          holdoutPassed = false;
          violations.push(cmp.violation);
        }
      }
    } else if (isPlainObject(spec.holdoutMetrics)) {
      for (const [k, minVal] of Object.entries(spec.holdoutMetrics)) {
        if (!Object.hasOwn(hm, k)) {
          holdoutPassed = false;
          violations.push(`METRICS_MISSING_KEY: holdout missing metric "${k}"`);
        } else if (isFiniteNum(minVal) && hm[k] < minVal) {
          holdoutPassed = false;
          violations.push(`METRIC_REGRESSION: holdout ${k}=${hm[k]} < ${minVal}`);
        }
      }
    } else if (Array.isArray(spec.metrics)) {
      for (const rule of spec.metrics) {
        if (!Object.hasOwn(hm, rule.name)) continue;
        const cmp = compareMetricRule(rule, hm[rule.name], "holdout");
        if (!cmp.passed) {
          holdoutPassed = false;
          violations.push(cmp.violation);
        }
      }
    }
  }

  return holdoutPassed;
}

/**
 * Evaluate a ratchet contract against stdout/metrics + exitCode + optional private holdout inputs.
 * Fails closed on non-zero exit, missing/spoofed metrics, coverageFloor violations,
 * metric regressions, or holdout failures. Strips all private keys before returning.
 */
export function evaluateRatchet(
  spec,
  {
    stdout = "",
    exitCode = 0,
    metrics = null,
    holdoutMetrics = null,
    holdoutExitCode = null,
    expectedNonce = null,
  } = {},
) {
  const publicSpec = stripPrivateRatchetFields(spec);
  const specCheck = validateRatchetSpec(spec, { allowHoldout: true });
  const holdoutConfigured = Boolean(
    spec?.holdoutCmd ||
      spec?.holdoutConfigured ||
      spec?.holdoutMetrics ||
      spec?.holdoutMetricsSpec ||
      holdoutExitCode !== null ||
      holdoutMetrics !== null,
  );
  const normalizedExitCode = Number.isInteger(exitCode) ? exitCode : -1;
  const violations = [];
  const baselineOut = {};
  const deltasOut = {};

  if (!specCheck.ok) {
    violations.push(`RATCHET_SPEC_INVALID: ${specCheck.errors.join("; ")}`);
    const out = {
      ok: false,
      exitCode: normalizedExitCode,
      metrics: {},
      baseline: baselineOut,
      deltas: deltasOut,
      violations,
      violation: violations[0],
      coveragePassed: false,
      holdoutConfigured,
      holdoutPassed: holdoutConfigured ? false : null,
      nonce: null,
      spec: publicSpec,
    };
    return out;
  }

  for (const rule of spec.metrics) {
    baselineOut[rule.name] = rule.baseline !== undefined ? rule.baseline : rule.target;
  }

  if (normalizedExitCode !== 0) {
    violations.push(`EXIT_NONZERO: command exited with status ${normalizedExitCode}`);
  }

  const requiredKeys = Array.from(
    new Set([
      ...spec.metrics.map((m) => m.name),
      ...(spec.coverageFloor?.countMetric ? [spec.coverageFloor.countMetric] : []),
    ]),
  );

  let resolvedMetrics = {};
  let nonce = null;

  if (normalizedExitCode === 0) {
    if (metrics !== null && metrics !== undefined) {
      const check = validateMetricsObject(metrics, requiredKeys);
      if (!check.ok) {
        violations.push(check.error);
      } else {
        resolvedMetrics = check.metrics;
      }
    } else {
      const extracted = extractOverdriveMetrics(stdout, { expectedNonce, requiredKeys });
      nonce = extracted.nonce;
      if (!extracted.ok) {
        violations.push(extracted.error);
      } else {
        resolvedMetrics = extracted.metrics;
      }
    }
  }

  let coveragePassed = true;
  if (spec.coverageFloor) {
    const { countMetric, minValue } = spec.coverageFloor;
    if (Object.hasOwn(resolvedMetrics, countMetric)) {
      if (resolvedMetrics[countMetric] < minValue) {
        coveragePassed = false;
        violations.push(
          `COVERAGE_FLOOR_VIOLATION: ${countMetric}=${resolvedMetrics[countMetric]} < minValue=${minValue}`,
        );
      }
    } else if (normalizedExitCode === 0 && Object.keys(resolvedMetrics).length > 0) {
      coveragePassed = false;
      violations.push(`METRICS_MISSING_KEY: coverage metric "${countMetric}" missing`);
    } else {
      coveragePassed = false;
    }
  }

  if (normalizedExitCode === 0 && Object.keys(resolvedMetrics).length > 0) {
    for (const rule of spec.metrics) {
      if (!Object.hasOwn(resolvedMetrics, rule.name)) continue;
      const actual = resolvedMetrics[rule.name];
      const cmp = compareMetricRule(rule, actual);
      deltasOut[rule.name] = cmp.delta;
      if (!cmp.passed) {
        violations.push(cmp.violation);
      }
    }
  }

  let holdoutPassed = null;
  if (holdoutConfigured) {
    if (holdoutExitCode !== null || holdoutMetrics !== null) {
      holdoutPassed = evaluateHoldoutChecks(spec, holdoutExitCode, holdoutMetrics, violations);
    } else {
      holdoutPassed = null;
    }
  }

  const ok = violations.length === 0 && normalizedExitCode === 0 && (!holdoutConfigured || holdoutPassed !== false);

  const result = {
    ok,
    exitCode: normalizedExitCode,
    metrics: resolvedMetrics,
    baseline: baselineOut,
    deltas: deltasOut,
    violations,
    violation: violations.length > 0 ? violations.join("; ") : null,
    coveragePassed,
    holdoutConfigured,
    holdoutPassed,
    nonce,
    spec: publicSpec,
  };

  for (const key of FORBIDDEN_PRIVATE_KEYS) {
    delete result[key];
  }

  const contractCheck = validateRatchetResult(result);
  if (!contractCheck.ok) {
    result.ok = false;
    result.violations.push(`CONTRACT_INVALID: ${contractCheck.errors.join("; ")}`);
    result.violation = result.violations.join("; ");
  }

  return result;
}

function privateRootDir(baseDir = null) {
  return path.resolve(baseDir || defaultPrivateDir());
}

function safeMissionFilename(missionId) {
  const safe = String(missionId || "").replace(/[^A-Za-z0-9_.-]/g, "_");
  if (!safe || safe === "." || safe === "..") {
    throw new Error(`Invalid missionId for private holdout storage: "${missionId}"`);
  }
  return `${safe}.holdouts.json`;
}

/** Return the coordinator-private holdout file path outside any git repository/worktree. */
export function privateHoldoutPath(missionId, baseDir = null) {
  return path.join(privateRootDir(baseDir), safeMissionFilename(missionId)).replaceAll("\\", "/");
}

/** Persist a coordinator-private holdout spec under OVERDRIVE_PRIVATE_DIR (never in repo/worktree). */
export function savePrivateHoldout(missionId, key, holdoutSpec, baseDir = null) {
  if (!key || typeof key !== "string") {
    throw new Error("savePrivateHoldout requires a non-empty string key.");
  }
  const filePath = privateHoldoutPath(missionId, baseDir);
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });

  let storeMap = {};
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      if (isPlainObject(parsed)) storeMap = parsed;
    } catch {
      storeMap = {};
    }
  }
  storeMap[key] = holdoutSpec;
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(storeMap, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmpPath, filePath);
  return filePath;
}

/** Load a coordinator-private holdout spec (or full map when key is null/undefined). */
export function loadPrivateHoldout(missionId, key = null, baseDir = null) {
  const filePath = privateHoldoutPath(missionId, baseDir);
  if (!existsSync(filePath)) return null;
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isPlainObject(parsed)) return null;
  if (key === null || key === undefined) return parsed;
  return Object.hasOwn(parsed, key) ? parsed[key] : null;
}
