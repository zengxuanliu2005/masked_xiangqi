/**
 * Stop-hook backstop for the maintenance contract in CLAUDE.md / AGENTS.md.
 *
 * Both docs are intentionally untracked, so git cannot tell us whether they
 * kept up with the code. Compare modification times instead: if any source
 * file under a watched directory is newer than a doc, that doc probably owes
 * an update.
 *
 * Exit 2 asks Claude Code to keep working and feeds stderr back to the model.
 * `stop_hook_active` on stdin means we already did that once this turn, so we
 * step aside rather than looping.
 */
import { Buffer } from "node:buffer";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve against the repo, not the caller's cwd: a hook may run from anywhere.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WATCHED = ["engine", "server", "src", "shared"].map((name) =>
  path.join(ROOT, name),
);
const DOCS = ["CLAUDE.md", "AGENTS.md"].map((name) => path.join(ROOT, name));
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".css"]);
/** Report a handful of paths, not the whole diff. */
const MAX_REPORTED = 5;

const readStdin = async () => {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const modifiedAt = (target) => {
  try {
    return statSync(target).mtimeMs;
  } catch {
    return null;
  }
};

function* sourceFiles(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(full);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

const hookInput = await readStdin();
if (hookInput) {
  try {
    if (JSON.parse(hookInput).stop_hook_active) process.exit(0);
  } catch {
    // A malformed payload is not a reason to block the session.
  }
}

// Each doc sets its own bar: a source file newer than it is unreviewed there.
const docTimes = DOCS.map((doc) => [doc, modifiedAt(doc)]).filter(
  ([, time]) => time !== null,
);
if (docTimes.length === 0) process.exit(0);

const stale = new Map();
for (const directory of WATCHED) {
  for (const file of sourceFiles(directory)) {
    const time = modifiedAt(file);
    if (time === null) continue;
    for (const [doc, docTime] of docTimes) {
      if (time <= docTime) continue;
      const list = stale.get(doc) ?? [];
      if (list.length < MAX_REPORTED) list.push(file);
      stale.set(doc, list);
    }
  }
}

if (stale.size === 0) process.exit(0);

const lines = [
  "Maintenance contract: source changed more recently than the agent docs.",
];
for (const [doc, files] of stale) {
  const relative = files.map((file) => path.relative(ROOT, file));
  lines.push(
    `  ${path.relative(ROOT, doc)} is older than: ${relative.join(", ")}`,
  );
}
lines.push(
  "Walk the sync table in CLAUDE.md / AGENTS.md and update the matching",
  "sections, or state explicitly that no doc change is warranted.",
);
process.stderr.write(`${lines.join("\n")}\n`);
process.exit(2);
