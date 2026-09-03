#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DealCompilerAdapter } from "./deal-compiler.js";
import {
  DIRECT_PROMPT_SHA256,
  DIRECT_PROMPT_VERSION,
  OllamaAdapter,
  OpenRouterNorthAdapter,
  ReplayModelAdapter,
} from "./model-adapters.js";
import { aggregateMetrics, runDirect, runSemantic } from "./runners.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const parsed = { command: argv[0] ?? "benchmark", stream: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--stream") parsed.stream = true;
    else if (arg === "--no-stream") parsed.stream = false;
    else if (arg === "--resume") parsed.resume = true;
    else if (arg.startsWith("--")) parsed[arg.slice(2)] = argv[++i];
    else throw new Error(`unexpected argument ${arg}`);
  }
  return parsed;
}

function adapterFrom(args) {
  if ((args.adapter ?? "replay") === "replay") return new ReplayModelAdapter();
  if (args.adapter === "openrouter") return new OpenRouterNorthAdapter();
  if (args.adapter === "ollama") return new OllamaAdapter();
  throw new Error(`unknown adapter ${args.adapter}`);
}

function printTable(summary) {
  const rows = Object.entries(summary).map(([mode, metrics]) => ({ mode, ...metrics }));
  console.table(rows);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== "benchmark") {
    throw new Error("usage: cli.js benchmark [--adapter replay|openrouter|ollama] [--stream]");
  }
  const taskPath = resolve(args.tasks ?? joinRoot("tasks/tasks.json"));
  const allTasks = JSON.parse(await readFile(taskPath, "utf8"));
  const requestedTasks = args.task ? new Set(args.task.split(",")) : null;
  const requestedFamilies = args.family ? new Set(args.family.split(",")) : null;
  const tasks = allTasks.filter((task) =>
    (!requestedTasks || requestedTasks.has(task.id))
    && (!requestedFamilies || requestedFamilies.has(task.family))
  );
  if (tasks.length === 0) {
    throw new Error(`no tasks selected by --task ${args.task ?? "*"} --family ${args.family ?? "*"}`);
  }
  const selectedModes = new Set((args.modes ?? "direct,semantic").split(","));
  const maxRepairs = Number(args["max-repairs"] ?? 2);
  const maxRounds = Number(args["max-rounds"] ?? 8);
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0) throw new Error("--max-repairs must be a non-negative integer");
  if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new Error("--max-rounds must be a positive integer");
  const model = adapterFrom(args);
  const compiler = new DealCompilerAdapter({ dealRepo: args["deal-repo"] });
  await compiler.setup();
  const reportPath = resolve(args.output ?? joinRoot("reports/latest.json"));
  const results = args.resume ? await readExistingResults(reportPath) : [];
  const completed = new Set(results.map((result) => `${result.taskId}:${result.mode}`));
  const writeReport = async () => {
    const summary = {};
    for (const mode of selectedModes) {
      summary[mode] = aggregateMetrics(results.filter((result) => result.mode === mode));
    }
    const byFamily = {};
    for (const family of new Set(results.map((result) => result.family))) {
      byFamily[family] = {};
      for (const mode of selectedModes) {
        byFamily[family][mode] = aggregateMetrics(results.filter((result) =>
          result.family === family && result.mode === mode
        ));
      }
    }
    const report = {
      generatedAt: new Date().toISOString(),
      adapter: args.adapter ?? "replay",
      model: model.model ?? "replay",
      temperature: model.temperature ?? 0,
      seed: model.seed ?? 42,
      semanticProtocol: model.semanticProtocol ?? "replay",
      maxRepairs,
      maxRounds,
      directPromptVersion: DIRECT_PROMPT_VERSION,
      directPromptSha256: DIRECT_PROMPT_SHA256,
      streaming: args.stream,
      taskPath,
      summary,
      byFamily,
      results,
    };
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    return summary;
  };
  for (const task of tasks) {
    if (selectedModes.has("direct") && !completed.has(`${task.id}:direct`)) {
      console.log(`Running ${task.id} [direct]...`);
      results.push(await runDirect({ task, model, compiler, streaming: args.stream, maxRepairs }));
      await writeReport();
    }
    if (selectedModes.has("semantic") && !completed.has(`${task.id}:semantic`)) {
      console.log(`Running ${task.id} [semantic]...`);
      results.push(await runSemantic({
        task,
        model,
        compiler,
        streaming: args.stream,
        maxRepairs,
        maxRounds,
      }));
      await writeReport();
    }
  }
  const summary = await writeReport();
  printTable(summary);
  console.log(`Report: ${reportPath}`);
  if (results.some((result) => !result.success)) process.exitCode = 1;
}

async function readExistingResults(reportPath) {
  try {
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    return Array.isArray(report.results) ? report.results : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function joinRoot(path) {
  return resolve(ROOT, path);
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
