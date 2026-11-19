// Gate g2: static CSP / XSS scan of every .js/.mjs/.html/.css asset under ui/ (node --test).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CSP_HEADER } from "../ui/contracts.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_DIR = path.join(ROOT, "ui");
const SCANNED_EXT = new Set([".js", ".mjs", ".html", ".css"]);

// v0.1 shell files owned by the instrument lane; tolerated (reported as skipped) only while
// byte-identical to the v0.2.0 freeze commit. Any edit re-arms strict enforcement.
const FREEZE_COMMIT = "b25aedadaaa95f80f5492595010a0ca8b33b64a1";
const PRE_MERGE_LEGACY = new Set(["ui/app.js", "ui/index.html"]);
const REVIEW_OWNED = ["ui/inspector.js", "ui/composer.js", "ui/parse-patch.js", "ui/review.css"];

export const RULES = Object.freeze([
  { id: "innerHTML", re: /\binnerHTML\b/ },
  { id: "outerHTML", re: /\bouterHTML\b/ },
  { id: "insertAdjacentHTML", re: /\binsertAdjacentHTML\b/ },
  { id: "document.write", re: /\bdocument\s*\.\s*write(?:ln)?\s*\(/ },
  { id: "eval", re: /(?<![\w$.])eval\s*\(/ },
  { id: "new Function", re: /\bnew\s+Function\s*\(/ },
  { id: "javascript: url", re: /javascript\s*:/i },
  { id: "inline on* handler", re: /<[a-zA-Z][^>\n]*\son[a-z]+\s*=/ },
  { id: "inline style attribute", re: /<[a-zA-Z][^>\n]*\sstyle\s*=/i },
  { id: "inline style attribute (html)", re: /^\s*style\s*=/i, ext: [".html"] },
  { id: "setAttribute style", re: /setAttribute\(\s*["'`]style["'`]/ },
  { id: "element.style write", re: /\.style\s*(?:\.\s*[\w$]+\s*=(?!=)|\[[^\]]+\]\s*=(?!=)|=(?!=)|\.\s*(?:setProperty|cssText)\b)/ },
  { id: "transition: all", re: /transition(?:-property)?\s*:[^;}\n]*\ball\b/i },
  { id: "blocking dialog", re: /(?<![\w$.])(?:window\.|globalThis\.)?(?:alert|confirm|prompt)\(/ },
  { id: "external script/link", re: /<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i },
  { id: "external @import", re: /@import\s+(?:url\()?\s*["']?\s*(?:https?:)?\/\//i },
  { id: "external css url()", re: /url\(\s*["']?\s*(?:https?:)?\/\//i },
  { id: "external ES import", re: /\bimport\s*(?:\(\s*|[^"'`;]*?\bfrom\s*)["'`](?:https?:)?\/\//i },
  { id: "external fetch", re: /\bfetch\s*\(\s*["'`]https?:\/\//i },
]);

/** Return [{ rule, line, text }] for every banned pattern in a source string. */
export function scanSource(source, ext = ".html") {
  const hits = [];
  const lines = String(source).replace(/\r\n/g, "\n").split("\n");
  lines.forEach((text, i) => {
    for (const rule of RULES) {
      if (rule.ext && !rule.ext.includes(ext)) continue;
      if (rule.re.test(text)) hits.push({ rule: rule.id, line: i + 1, text: text.trim().slice(0, 160) });
    }
  });
  return hits;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (SCANNED_EXT.has(path.extname(name).toLowerCase())) out.push(abs);
  }
  return out;
}

function frozenContent(rel) {
  try {
    return execFileSync("git", ["show", `${FREEZE_COMMIT}:${rel}`], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function isUntouchedLegacy(rel, content) {
  if (!PRE_MERGE_LEGACY.has(rel)) return false;
  const frozen = frozenContent(rel);
  return frozen !== null && frozen.replace(/\r\n/g, "\n") === content.replace(/\r\n/g, "\n");
}

const files = walk(UI_DIR).map((abs) => ({ abs, rel: path.relative(ROOT, abs).split(path.sep).join("/") }));

describe("g2 ui-security: CSP header", () => {
  it("ui/contracts.js CSP_HEADER is strict self-only with no unsafe sources", () => {
    const d = Object.fromEntries(
      CSP_HEADER.split(";").map((s) => s.trim()).filter(Boolean).map((s) => {
        const [k, ...v] = s.split(/\s+/);
        return [k, v.join(" ")];
      }),
    );
    assert.equal(d["default-src"], "'self'");
    assert.equal(d["script-src"], "'self'");
    assert.equal(d["style-src"], "'self'");
    assert.equal(d["object-src"], "'none'");
    assert.equal(d["frame-ancestors"], "'none'");
    assert.doesNotMatch(CSP_HEADER, /unsafe-inline|unsafe-eval|unsafe-hashes|https?:|\*/);
  });
});

describe("g2 ui-security: rule calibration", () => {
  const bad = [
    "el.inner" + "HTML = x;",
    "el.outer" + "HTML = x;",
    "el.insertAdjacent" + "HTML('beforeend', x);",
    "document." + "write('x');",
    "ev" + "al('1+1');",
    "new Func" + "tion('return 1')",
    "a.href = 'java" + "script:void(0)';",
    "<img src=x on" + "error=boom()>",
    '<div sty' + 'le="color:red">',
    "node.setAttribute('sty" + "le', 'x');",
    "node.sty" + "le.color = 'red';",
    "node.sty" + "le.setProperty('color', 'red');",
    ".x { transi" + "tion: all 0.2s; }",
    "aler" + "t(1);",
    "window.conf" + "irm('sure?');",
    "promp" + "t('name');",
    '<script src="htt' + 'ps://cdn.example/x.js"></script>',
    '<link rel="stylesheet" href="//fonts.example/x.css">',
    "@import url('htt" + "ps://fonts.example/a.css');",
    "src: url(htt" + "ps://fonts.example/a.woff2);",
    'import x from "htt' + 'ps://esm.example/x.js";',
  ];
  const safe = [
    "const SVG_NS = 'http://www.w3.org/2000/svg';",
    "node.textContent = '<img src=x>';",
    "h('label', null, 'Mission prompt (optional)');",
    "dialog.confirm(x); model.prompt(y); retrieval(z);",
    "if (a.style === b) {}",
    'const style = "compact";',
    "transition: background-color 120ms ease, border-color 120ms ease;",
    "import { h } from './dom.js';",
    'contentType: "text/javascript; charset=utf-8"',
    "h('button', { onClick: () => go() }, 'Go');",
  ];
  it("flags every banned sample", () => {
    for (const s of bad) assert.ok(scanSource(s).length > 0, `expected violation for: ${s}`);
  });
  it("does not false-positive on safe idioms", () => {
    for (const s of safe) assert.deepEqual(scanSource(s), [], `unexpected violation for: ${s}`);
  });
});

describe("g2 ui-security: ui/ asset scan", () => {
  it("discovers ui assets including all review-owned files", () => {
    assert.ok(files.length > 0, "no ui assets found");
    for (const rel of REVIEW_OWNED) assert.ok(existsSync(path.join(ROOT, rel)), `missing ${rel}`);
  });

  for (const f of files) {
    it(`${f.rel} has zero banned CSP/XSS patterns`, (t) => {
      const content = readFileSync(f.abs, "utf8");
      const hits = scanSource(content, path.extname(f.abs).toLowerCase());
      if (hits.length && isUntouchedLegacy(f.rel, content)) {
        t.skip(`pre-merge v0.1 file unchanged since freeze ${FREEZE_COMMIT.slice(0, 7)} (${hits.length} legacy hits; enforced once rewritten)`);
        return;
      }
      assert.deepEqual(hits, [], `${f.rel}:\n${hits.map((x) => `  L${x.line} [${x.rule}] ${x.text}`).join("\n")}`);
    });
  }
});
