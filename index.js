import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(root, "config.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const intervalMs = Number(config.intervalSeconds) * 1000;
const remote = config.remote || "origin";
const publishBranch = config.publishBranch || "live";
const projectFiles = ["index.js", "config.json", "package.json", "package-lock.json", ".gitignore", "README.md"];
let timer;
let stopping = false;

if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
  throw new Error("config.intervalSeconds must be a positive number");
}
if (!Array.isArray(config.targets) || config.targets.length === 0) {
  throw new Error("config.targets must contain at least one target");
}

function timestamp() {
  return new Date().toISOString();
}

function log(message) {
  console.log(`[${timestamp()}] ${message}`);
}

async function runGit(args, cwd = root) {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 1024 * 1024,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function fetchTarget(target) {
  const response = await fetch(target.url, {
    signal: AbortSignal.timeout(20_000),
    headers: { Accept: "text/html" },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const content = await response.text();
  if (!content.trim() || !/<table\b/i.test(content)) {
    throw new Error("response does not look like a result-list HTML page");
  }

  return content;
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

const pageStyles = `:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #293b3a;
  background: #f4f7f3;
}

* { box-sizing: border-box; }

body {
  max-width: 1100px;
  margin: 0 auto;
  padding: 2rem 1rem 3rem;
  background: #f4f7f3;
  color: #293b3a;
}

a { color: #2d6a62; font-weight: 600; }
a:hover { color: #b05b45; }

table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  overflow: hidden;
  background: #fffdf9;
  border: 1px solid #dce7df;
  border-radius: 14px;
  box-shadow: 0 8px 24px rgba(44, 75, 68, 0.08);
}

td, th { padding: 0.65rem 0.75rem; border-bottom: 1px solid #e8eee9; }
tr:last-child td { border-bottom: 0; }
.columnhead, tr:first-child.columnhead { background: #dfeee7; color: #244b45; }
.columnhead td { font-weight: 700; }
.record:nth-child(even) { background: #f8fbf8; }
.record:hover { background: #fff2e8; }
.group2, .group5 { color: #b05b45; }
.headline1, .headline2 { color: #244b45; }
.listHeaderFooter { color: #687a75; }

@media (max-width: 700px) {
  body { padding: 1rem 0.5rem 2rem; overflow-x: auto; }
  table { min-width: 680px; font-size: 0.9rem; }
}
`;

function addStylesheet(content) {
  const stylesheet = '  <link rel="stylesheet" href="styles.css">\n';
  if (!/<\/head>/i.test(content)) {
    throw new Error("result page does not contain a closing head tag");
  }
  return content.replace(/<\/head>/i, `${stylesheet}</head>`);
}

function makeIndexHtml(updatedAt) {
  const links = config.targets.map((target) => `        <li><a href="${escapeHtml(target.file)}">${escapeHtml(target.label || target.file)}</a></li>`).join("\n");
  return `<!doctype html>
<html lang="lv">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ilūkstes velomaratons 2026 — rezultāti</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <h1>Ilūkstes velomaratons 2026</h1>
  <h2>Rezultāti</h2>
  <ul>
${links}
  </ul>
  <p>Atjaunots: <time datetime="${escapeHtml(updatedAt)}">${escapeHtml(updatedAt)}</time></p>
</body>
</html>
`;
}

async function branchExists() {
  try {
    await runGit(["ls-remote", "--exit-code", "--heads", remote, publishBranch]);
    return true;
  } catch {
    return false;
  }
}

async function createPublishWorktree() {
  const worktree = await mkdtemp(resolve(tmpdir(), "sacensibu-live-"));
  const exists = await branchExists();

  try {
    if (exists) {
      await runGit(["fetch", remote, `${publishBranch}:${publishBranch}`]);
      await runGit(["worktree", "add", "--detach", worktree, publishBranch]);
    } else {
      await runGit(["worktree", "add", "--detach", worktree]);
      await runGit(["switch", "--orphan", publishBranch], worktree);
      await runGit(["clean", "-fdx"], worktree);
    }
    return { worktree, temporaryBranch: !exists };
  } catch (error) {
    try {
      await runGit(["worktree", "remove", "--force", worktree]);
    } catch {
      // The worktree may not have been registered yet.
    }
    await rm(worktree, { recursive: true, force: true });
    if (!exists) {
      try {
        await runGit(["branch", "-D", publishBranch]);
      } catch {
        // The temporary branch may not have been created yet.
      }
    }
    throw error;
  }
}

async function removePublishWorktree(worktree, temporaryBranch) {
  try {
    await runGit(["worktree", "remove", "--force", worktree]);
  } finally {
    await rm(worktree, { recursive: true, force: true });
    if (temporaryBranch) {
      try {
        await runGit(["branch", "-D", publishBranch]);
      } catch {
        // The branch may already be removed if worktree setup failed.
      }
    }
  }
}

async function publishResults(results) {
  const { worktree, temporaryBranch } = await createPublishWorktree();
  const updatedAt = timestamp();

  try {
    const changedFiles = [];
    for (const { target, content } of results) {
      const outputPath = resolve(worktree, target.file);
      const outputRelativePath = relative(worktree, outputPath);
      if (outputRelativePath.startsWith("..") || outputRelativePath.includes("..\\")) {
        throw new Error(`target file must be inside the published site: ${target.file}`);
      }

      let previous = null;
      try {
        previous = await readFile(outputPath, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }

      const styledContent = addStylesheet(content);
      if (previous === styledContent) continue;
      await writeFile(outputPath, styledContent, "utf8");
      changedFiles.push(target.file);
    }

    const stylesPath = resolve(worktree, "styles.css");
    let previousStyles = null;
    try {
      previousStyles = await readFile(stylesPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (previousStyles !== pageStyles) {
      await writeFile(stylesPath, pageStyles, "utf8");
      changedFiles.push("styles.css");
    }

    if (changedFiles.length === 0) {
      log(`live/${publishBranch}: unchanged; nothing to commit`);
      return;
    }

    if (changedFiles.some((file) => file !== "styles.css")) {
      const indexPath = resolve(worktree, "index.html");
      await writeFile(indexPath, makeIndexHtml(updatedAt), "utf8");
      changedFiles.push("index.html");
    }

    await runGit(["add", "--", ...changedFiles], worktree);
    const { stdout: status } = await runGit(["status", "--porcelain", "--", ...changedFiles], worktree);
    if (!status) {
      log(`live/${publishBranch}: git reports no changes`);
      return;
    }

    const commitMessage = `Publish results ${updatedAt}`;
    await runGit(["commit", "-m", commitMessage], worktree);
    log(`live/${publishBranch}: committed ${changedFiles.join(", ")}`);

    try {
      await runGit(["push", remote, `HEAD:${publishBranch}`], worktree);
      log(`live/${publishBranch}: pushed`);
    } catch (error) {
      log(`live/${publishBranch}: push failed: ${error.message}`);
    }
  } finally {
    await removePublishWorktree(worktree, temporaryBranch);
  }
}

async function updateResults() {
  log("fetching results");

  let fetched;
  try {
    fetched = await Promise.all(config.targets.map(async (target) => ({
      target,
      content: await fetchTarget(target),
    })));
  } catch (error) {
    log(`cycle skipped; published files preserved: ${error.message}`);
    return;
  }

  await publishResults(fetched);
}

async function cycle() {
  if (stopping) return;
  try {
    await updateResults();
  } catch (error) {
    log(`cycle failed: ${error.stack || error.message}`);
  }
  if (!stopping) timer = setTimeout(cycle, intervalMs);
}

function stop(signal) {
  stopping = true;
  if (timer) clearTimeout(timer);
  log(`received ${signal}; stopping`);
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

log(`starting; publishing to ${publishBranch}; polling every ${config.intervalSeconds} seconds`);
await cycle();
