#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { aggregateMetrics } from "./runners.js";

const args = process.argv.slice(2);
const outputFlag = args.indexOf("--output");
if (outputFlag === -1 || !args[outputFlag + 1]) {
  throw new Error("usage: merge-reports.js <report...> --output <combined.json>");
}
const inputPaths = args.slice(0, outputFlag).map((path) => resolve(path));
const outputPath = resolve(args[outputFlag + 1]);
const reports = await Promise.all(inputPaths.map(async (path) =>
  JSON.parse(await readFile(path, "utf8"))
));
const model = reports[0]?.model;
if (!model || reports.some((report) => report.model !== model)) {
  throw new Error("all reports must use the same model");
}
const results = reports.flatMap((report) => report.results);
const summary = Object.fromEntries(
  [...new Set(results.map((result) => result.mode))]
    .map((mode) => [mode, aggregateMetrics(results.filter((result) => result.mode === mode))]),
);
await writeFile(outputPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  adapter: "openrouter",
  model,
  streaming: true,
  sourceReports: inputPaths,
  summary,
  results,
}, null, 2) + "\n");
console.table(Object.entries(summary).map(([mode, metrics]) => ({ mode, ...metrics })));
console.log(`Combined report: ${outputPath}`);
