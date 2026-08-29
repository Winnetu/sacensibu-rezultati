import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(root, "config.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const intervalMs = Number(config.intervalSeconds) * 1000;
const remote = config.remote || "origin";
const branch = config.branch || "main";
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

async function runGit(args) {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd: root,
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

async function updateResults() {
  log("fetching results");

  let fetched;
  try {
    fetched = await Promise.all(config.targets.map(async (target) => ({
      target,
      content: await fetchTarget(target),
    })));
  } catch (error) {
    log(`cycle skipped: ${error.message}`);
    return;
  }

  const changedFiles = [];
  for (const { target, content } of fetched) {
    const outputPath = resolve(root, target.file);
    const outputRelativePath = relative(root, outputPath);
    if (outputRelativePath.startsWith("..") || outputRelativePath.includes("..\\")) {
      throw new Error(`target file must be inside the repository: ${target.file}`);
    }

    let previous = null;
    try {
      previous = await readFile(outputPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    if (previous === content) {
      log(`${target.file}: unchanged`);
      continue;
    }

    await writeFile(outputPath, content, "utf8");
    changedFiles.push(target.file);
    log(`${target.file}: updated (${Buffer.byteLength(content, "utf8")} bytes)`);
  }

  if (changedFiles.length === 0) {
    log("no change; nothing to commit");
    return;
  }

  const filesToStage = [...new Set([...projectFiles, ...changedFiles])];
  await runGit(["add", "--", ...filesToStage]);
  const { stdout: status } = await runGit(["status", "--porcelain", "--", ...filesToStage]);
  if (!status) {
    log("git reports no staged changes; nothing to commit");
    return;
  }

  const commitMessage = `Results update ${timestamp()}`;
  try {
    await runGit(["commit", "-m", commitMessage]);
    log(`committed: ${commitMessage}`);
  } catch (error) {
    log(`commit failed: ${error.message}`);
    return;
  }

  try {
    await runGit(["push", remote, `HEAD:${branch}`]);
    log(`pushed to ${remote}/${branch}`);
  } catch (error) {
    log(`push failed; local commit retained: ${error.message}`);
  }
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

log(`starting; polling every ${config.intervalSeconds} seconds`);
await cycle();
