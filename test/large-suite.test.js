import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GenerationCompiler } from "../src/generation-compiler.js";

const tasks = JSON.parse(await readFile(new URL("../tasks/large-tasks.json", import.meta.url), "utf8"));

test("large suite contains 40 non-trivial tasks across eight families", () => {
  assert.equal(tasks.length, 40);
  assert.equal(new Set(tasks.map((task) => task.id)).size, 40);
  assert.equal(new Set(tasks.map((task) => task.family)).size, 8);
  for (const task of tasks) {
    assert.ok(task.replay.directSource.split("\n").length >= 20, `${task.id} is too small`);
    assert.ok(task.replay.semanticChoices.length >= 2, `${task.id} has too few decisions`);
    assert.equal(task.replay.semanticChoices.length, task.semantic.slots.length);
    assert.doesNotMatch(task.replay.directSource, /\{\{/);
  }
});

test("every large replay trajectory fills its typed program blueprint", () => {
  for (const task of tasks) {
    const compiler = new GenerationCompiler();
    compiler.start(task);
    for (const id of task.replay.semanticChoices) {
      assert.equal(compiler.apply(id).accepted, true, `${task.id}: ${id}`);
    }
    assert.equal(compiler.isComplete(), true, task.id);
    assert.equal(compiler.finish(), task.replay.directSource, task.id);
  }
});

test("a valid choice for a future blueprint slot is rejected early", () => {
  const task = tasks[0];
  const compiler = new GenerationCompiler();
  compiler.start(task);
  const futureChoice = task.semantic.catalog.find((choice) =>
    choice.slotId === task.semantic.slots[1].id
  );
  const result = compiler.apply(futureChoice.id);
  assert.equal(result.accepted, false);
  assert.match(result.reason, /does not fill slot|produces|unknown/);
  assert.equal(compiler.snapshot().currentHole.slotId, task.semantic.slots[0].id);
});
