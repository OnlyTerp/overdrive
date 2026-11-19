import path from "node:path";
import {
  ASSISTANT_IDS,
  CLOUD_PROVIDERS,
  COMPATIBLE_TARGET_VERSIONS,
  CSP_HEADER,
  DIFF_CAPS,
  DISPATCH_MODES,
  EVENT_CAPS,
  EVENT_TYPES,
  MODEL_FAMILIES,
  OFFLOAD_MODES,
  PRIVACY_MODES,
  REPLAY_VERSION,
  REPLAYABLE,
  ROUTES,
  RSI_TIERS,
  SCHEMA_VERSION,
  SHORTCUTS,
  SHOWCASE_FIXTURE_VERSION,
  SHOWCASE_SLUG,
  STATIC_ASSET_MANIFEST,
  STORE_METHODS,
  TARGET_VERSION,
  UI_ASSETS,
  toPublicRatchetSpec,
  validateDemoSeedResponse,
  validateDiffResponse,
  validateEventsResponse,
  validateInspectionResponse,
  validateIntentionDigest,
  validateRatchetResult,
  validateRatchetSpec,
  validateReplayEnvelope,
  validateRsiCandidate,
} from "../ui/contracts.js";

export {
  ASSISTANT_IDS,
  CLOUD_PROVIDERS,
  COMPATIBLE_TARGET_VERSIONS,
  CSP_HEADER,
  DIFF_CAPS,
  DISPATCH_MODES,
  EVENT_CAPS,
  EVENT_TYPES,
  MODEL_FAMILIES,
  OFFLOAD_MODES,
  PRIVACY_MODES,
  REPLAY_VERSION,
  REPLAYABLE,
  ROUTES,
  RSI_TIERS,
  SCHEMA_VERSION,
  SHORTCUTS,
  SHOWCASE_FIXTURE_VERSION,
  SHOWCASE_SLUG,
  STATIC_ASSET_MANIFEST,
  STORE_METHODS,
  TARGET_VERSION,
  UI_ASSETS,
  toPublicRatchetSpec,
  validateDemoSeedResponse,
  validateDiffResponse,
  validateEventsResponse,
  validateInspectionResponse,
  validateIntentionDigest,
  validateRatchetResult,
  validateRatchetSpec,
  validateReplayEnvelope,
  validateRsiCandidate,
};

export const STATIC_MANIFEST_BY_URL = new Map(STATIC_ASSET_MANIFEST.map((item) => [item.urlPath, item]));

export function resolveAllowedStaticAsset(repoRoot, urlPathname) {
  const entry = STATIC_MANIFEST_BY_URL.get(urlPathname);
  if (!entry) return null;
  const rootAbs = path.resolve(repoRoot);
  const targetAbs = path.resolve(rootAbs, entry.repoRelPath);
  if (!targetAbs.startsWith(rootAbs + path.sep)) return null;
  return { ...entry, absPath: targetAbs };
}
