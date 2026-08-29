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

function makeIndexHtml(updatedAt) {
  const links = config.targets.map((target) => `        <li><a href="${escapeHtml(target.file)}">${escapeHtml(target.label || target.file)}</a></li>`).join("\n");
  return `<!doctype html>
<html lang="lv">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ilūkstes velomaratons 2026 — rezultāti</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.5; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; color: #222; }
    a { color: #0645ad; }
  </style>
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

      if (previous === content) continue;
      await writeFile(outputPath, content, "utf8");
      changedFiles.push(target.file);
    }

    if (changedFiles.length === 0) {
      log(`live/${publishBranch}: unchanged; nothing to commit`);
      return;
    }

    const indexPath = resolve(worktree, "index.html");
    await writeFile(indexPath, makeIndexHtml(updatedAt), "utf8");
    changedFiles.push("index.html");

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
