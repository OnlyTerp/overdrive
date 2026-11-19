// Pure git unified-diff parser + split-row builder (Browser + Node, zero DOM, zero deps).
import { DIFF_CAPS } from "./contracts.js";

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const GIT_HEAD_RE = /^diff --git (?:"?a\/)?(.+?)"? (?:"?b\/)?(.+?)"?$/;

function stripPathPrefix(raw) {
  let p = String(raw || "").replace(/\t.*$/, "").trim();
  if (p.startsWith('"') && p.endsWith('"') && p.length > 1) p = p.slice(1, -1);
  if (p === "/dev/null") return null;
  if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
  return p;
}

function newFile() {
  return {
    oldPath: null,
    newPath: null,
    path: "",
    status: "modified",
    isBinary: false,
    additions: 0,
    deletions: 0,
    hunks: [],
    truncated: false,
    _sawOld: false,
    _sawNew: false,
    _lines: 0,
  };
}

function finalizeFile(f) {
  if (f.status === "modified") {
    if (f._sawOld && f.oldPath === null && f.newPath !== null) f.status = "added";
    else if (f._sawNew && f.newPath === null && f.oldPath !== null) f.status = "deleted";
    else if (f.oldPath && f.newPath && f.oldPath !== f.newPath) f.status = "renamed";
  }
  f.path = f.newPath ?? f.oldPath ?? "";
  delete f._sawOld;
  delete f._sawNew;
  delete f._lines;
  return f;
}

/**
 * Parse a git unified diff into files/hunks/lines while enforcing DIFF_CAPS.
 * @returns {{ files: object[], truncated: boolean, totalLines: number, omittedFiles: number }}
 */
export function parseUnifiedDiff(patchText, caps = DIFF_CAPS) {
  const lim = { ...DIFF_CAPS, ...(caps || {}) };
  let text = typeof patchText === "string" ? patchText : "";
  let truncated = false;
  if (text.length > lim.maxTotalBytes) {
    text = text.slice(0, lim.maxTotalBytes);
    truncated = true;
  }

  const files = [];
  let omittedFiles = 0;
  let totalLines = 0;
  let rendered = 0;
  let file = null;
  let hunk = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;
  let dropping = false;

  const startFile = () => {
    if (file && !dropping) files.push(finalizeFile(file));
    hunk = null;
    oldLeft = 0;
    newLeft = 0;
    if (files.length >= lim.maxFiles) {
      dropping = true;
      truncated = true;
      omittedFiles++;
    } else {
      dropping = false;
    }
    file = newFile();
    return file;
  };

  const pushLine = (line) => {
    totalLines++;
    if (dropping) return;
    if (file._lines >= lim.maxLinesPerFile || rendered >= lim.maxRenderedHunkLines) {
      file.truncated = true;
      truncated = true;
      return;
    }
    file._lines++;
    rendered++;
    hunk.lines.push(line);
  };

  const rows = text.split("\n");
  if (rows.length && rows[rows.length - 1] === "") rows.pop();

  for (const rawRow of rows) {
    const row = rawRow.endsWith("\r") ? rawRow.slice(0, -1) : rawRow;
    const inHunkBody = hunk && (oldLeft > 0 || newLeft > 0);

    if (row.startsWith("diff --git ")) {
      startFile();
      const m = row.match(GIT_HEAD_RE);
      if (m) {
        file.oldPath = m[1];
        file.newPath = m[2];
      }
      continue;
    }

    if (inHunkBody) {
      const tag = row[0];
      if (tag === "+") {
        if (file) file.additions++;
        pushLine({ type: "add", oldLine: null, newLine: newNo++, content: row.slice(1) });
        newLeft--;
        continue;
      }
      if (tag === "-") {
        if (file) file.deletions++;
        pushLine({ type: "del", oldLine: oldNo++, newLine: null, content: row.slice(1) });
        oldLeft--;
        continue;
      }
      if (tag === " " || row === "") {
        pushLine({ type: "context", oldLine: oldNo++, newLine: newNo++, content: row.slice(1) });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (tag === "\\") {
        pushLine({ type: "note", oldLine: null, newLine: null, content: row.slice(1).trim() });
        continue;
      }
      // Malformed count: fall through to header handling.
      oldLeft = 0;
      newLeft = 0;
    }

    if (row.startsWith("--- ")) {
      if (!file || file.hunks.length > 0 || file._sawOld) startFile();
      file._sawOld = true;
      file.oldPath = stripPathPrefix(row.slice(4));
      continue;
    }
    if (row.startsWith("+++ ") && file) {
      file._sawNew = true;
      file.newPath = stripPathPrefix(row.slice(4));
      continue;
    }

    const hm = row.match(HUNK_RE);
    if (hm) {
      if (!file) startFile();
      const oldStart = Number(hm[1]);
      const oldCount = hm[2] === undefined ? 1 : Number(hm[2]);
      const newStart = Number(hm[3]);
      const newCount = hm[4] === undefined ? 1 : Number(hm[4]);
      hunk = { header: row, oldStart, oldCount, newStart, newCount, section: hm[5] || "", lines: [] };
      if (!dropping) file.hunks.push(hunk);
      oldLeft = oldCount;
      newLeft = newCount;
      oldNo = oldStart;
      newNo = newStart;
      pushLine({ type: "hunk", oldLine: null, newLine: null, content: row });
      continue;
    }

    if (hunk && row[0] === "\\") {
      pushLine({ type: "note", oldLine: null, newLine: null, content: row.slice(1).trim() });
      continue;
    }
    // Lenient trailing hunk lines when the @@ counts under-report (seen in hand-written patches).
    if (hunk && (row[0] === "+" || row[0] === "-" || row[0] === " ")) {
      const tag = row[0];
      if (tag === "+") {
        file.additions++;
        pushLine({ type: "add", oldLine: null, newLine: newNo++, content: row.slice(1) });
      } else if (tag === "-") {
        file.deletions++;
        pushLine({ type: "del", oldLine: oldNo++, newLine: null, content: row.slice(1) });
      } else {
        pushLine({ type: "context", oldLine: oldNo++, newLine: newNo++, content: row.slice(1) });
      }
      continue;
    }

    if (!file) continue;
    if (row.startsWith("new file mode")) file.status = "added";
    else if (row.startsWith("deleted file mode")) file.status = "deleted";
    else if (row.startsWith("rename from ")) {
      file.oldPath = row.slice(12);
      file.status = "renamed";
    } else if (row.startsWith("rename to ")) {
      file.newPath = row.slice(10);
      file.status = "renamed";
    } else if (row.startsWith("copy from ")) {
      file.oldPath = row.slice(10);
      file.status = "copied";
    } else if (row.startsWith("copy to ")) {
      file.newPath = row.slice(8);
      file.status = "copied";
    } else if (/^Binary files .* differ$/.test(row) || row.startsWith("GIT binary patch")) {
      file.isBinary = true;
      const bm = row.match(/^Binary files (.+) and (.+) differ$/);
      if (bm) {
        const a = stripPathPrefix(bm[1]);
        const b = stripPathPrefix(bm[2]);
        if (a === null) file.status = "added";
        if (b === null) file.status = "deleted";
        file.oldPath = a;
        file.newPath = b;
      }
    }
  }
  if (file && !dropping) files.push(finalizeFile(file));

  return { files, truncated, totalLines, omittedFiles };
}

/**
 * Pair a hunk's lines into side-by-side rows. Contiguous del/add blocks are zipped row-by-row,
 * with null spacers on the shorter side; context lines appear on both sides.
 * @returns {{ type: 'hunk'|'note'|'context'|'change', left: object|null, right: object|null }[]}
 */
export function buildSplitRows(hunk) {
  const out = [];
  const lines = Array.isArray(hunk?.lines) ? hunk.lines : [];
  let dels = [];
  let adds = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) out.push({ type: "change", left: dels[i] || null, right: adds[i] || null });
    dels = [];
    adds = [];
  };
  for (const line of lines) {
    if (line.type === "del") {
      if (adds.length) flush();
      dels.push(line);
    } else if (line.type === "add") {
      adds.push(line);
    } else {
      flush();
      out.push({ type: line.type === "context" ? "context" : line.type, left: line, right: line });
    }
  }
  flush();
  return out;
}
