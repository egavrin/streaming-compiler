import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DealCompilerAdapter } from "../src/deal-compiler.js";
import { ReplayModelAdapter } from "../src/model-adapters.js";
import { runDirect, runSemantic } from "../src/runners.js";

const tasks = JSON.parse(await readFile(new URL("../tasks/tasks.json", import.meta.url), "utf8"));
const compiler = new DealCompilerAdapter();

test.before(async () => compiler.setup());

test("production DEAL parser flags an impossible streamed token", async () => {
  const inspection = await compiler.inspectPrefix("export function main(): null { @ }");
  assert.equal(inspection.impossible, true);
  assert.ok(inspection.lexErrors > 0);
});

test("an incomplete prefix cannot crash the streaming harness", async () => {
  const inspection = await compiler.inspectPrefix(
    "export function main(): null { let value: string = \"a\" +",
  );
  assert.equal(inspection.impossible, false);
  assert.equal(typeof inspection.parserCrashed, "boolean");
});

test("direct and semantic replay both compile and pass the same functional oracle", async () => {
  const task = tasks.find((candidate) => candidate.id === "stdlib-trim");
  const model = new ReplayModelAdapter({ chunkSize: 17 });
  const direct = await runDirect({ task, model, compiler, streaming: true, maxRepairs: 0 });
  const semantic = await runSemantic({ task, model, compiler, streaming: true, maxRepairs: 0 });
  assert.equal(direct.compileAt1, true);
  assert.equal(direct.functionalAt1, true);
  assert.equal(semantic.compileAt1, true);
  assert.equal(semantic.functionalAt1, true);
  assert.equal(semantic.neuralDecisions, 2);
});
