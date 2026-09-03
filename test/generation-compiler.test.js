import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GenerationCompiler, renderPartialHir } from "../src/generation-compiler.js";

const tasks = JSON.parse(await readFile(new URL("../tasks/tasks.json", import.meta.url), "utf8"));

test("applies a streamed trajectory into typed HIR and emits DEAL", () => {
  const task = tasks.find((candidate) => candidate.id === "stdlib-substring");
  const compiler = new GenerationCompiler();
  compiler.start(task);
  for (const id of task.replay.semanticChoices) {
    assert.equal(compiler.apply(id).accepted, true);
  }
  assert.equal(compiler.isComplete(), true);
  assert.match(renderPartialHir(compiler.snapshot().hir), /std\/string\.substring/);
  assert.match(compiler.finish(), /strings\.substring\("streaming", 0, 6\)/);
});

test("rejects unknown and type-incompatible choices without corrupting the hole", () => {
  const task = structuredClone(tasks.find((candidate) => candidate.id === "stdlib-substring"));
  task.semantic.catalog.push({
    id: "boolean_only",
    label: "boolean literal",
    resultType: "boolean",
    node: { kind: "literal", value: true },
  });
  const compiler = new GenerationCompiler();
  compiler.start(task);
  assert.equal(compiler.apply("missing").accepted, false);
  assert.equal(compiler.apply("boolean_only").accepted, false);
  assert.equal(compiler.snapshot().currentHole.type, "string");
  assert.equal(compiler.rejectedChoices, 2);
});

test("compiler fills a genuinely deterministic hole without a neural decision", () => {
  const task = {
    id: "deterministic",
    prompt: "print fixed",
    semantic: {
      rootType: "string",
      catalog: [{
        id: "only",
        label: "only string",
        resultType: "string",
        node: { kind: "literal", value: "fixed" },
      }],
    },
  };
  const compiler = new GenerationCompiler();
  compiler.start(task);
  assert.equal(compiler.isComplete(), true);
  assert.equal(compiler.compilerDecisions, 1);
  assert.deepEqual(compiler.appliedChoices, [{ id: "only", neural: false }]);
});
