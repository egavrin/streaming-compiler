#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function slot(id, type, correct, wrong, description = id) {
  return { id, type, correct: String(correct), wrong: wrong.map(String), description };
}

function fill(template, values) {
  let source = template;
  for (const [id, value] of Object.entries(values)) source = source.replaceAll(`{{${id}}}`, value);
  return source.endsWith("\n") ? source : `${source}\n`;
}

function task({ id, family, level = "large", prompt, expectedStdout, blueprint, slots, seed }) {
  const catalog = [];
  const correctValues = {};
  const semanticChoices = [];
  slots.forEach((entry, slotIndex) => {
    const candidates = [...new Set([entry.correct, ...entry.wrong])];
    const shift = (seed + slotIndex) % candidates.length;
    const rotated = [...candidates.slice(shift), ...candidates.slice(0, shift)];
    for (let choiceIndex = 0; choiceIndex < rotated.length; choiceIndex++) {
      const source = rotated[choiceIndex];
      const choiceId = `${entry.id}_${choiceIndex}`;
      catalog.push({
        id: choiceId,
        slotId: entry.id,
        label: `${entry.description}: ${source}`,
        resultType: entry.type,
        source,
      });
      if (source === entry.correct) semanticChoices.push(choiceId);
    }
    correctValues[entry.id] = entry.correct;
  });
  return {
    id,
    family,
    level,
    prompt,
    expectedStdout,
    semantic: {
      blueprint,
      slots: slots.map(({ id: slotId, type }) => ({ id: slotId, type })),
      catalog,
    },
    replay: {
      semanticChoices,
      directSource: fill(blueprint, correctValues),
    },
  };
}

const header = 'import * as console from "std/console";\n\n';

function physicsTasks() {
  const scenarios = [
    { p: 0, v: 3, a: 1, steps: 5 },
    { p: 10, v: -2, a: 2, steps: 4 },
    { p: -5, v: 6, a: -1, steps: 6 },
    { p: 100, v: 0, a: -3, steps: 3 },
    { p: 7, v: 5, a: 0, steps: 8 },
  ];
  return scenarios.map((s, index) => {
    let p = s.p;
    let v = s.v;
    for (let i = 0; i < s.steps; i++) { p += v; v += s.a; }
    const id = `physics-engine-1d-${index + 1}`;
    const blueprint = `${header}function simulate(position: int, velocity: int, acceleration: int, steps: int): table {
  let p: int = position;
  let v: int = velocity;
  for (let tick: int = 0; tick < steps; tick = tick + 1) {
    p = {{position_update}};
    v = {{velocity_update}};
  }
  return { position: p, velocity: v };
}

export function main(): null {
  let state: table = simulate({{initial_position}}, {{initial_velocity}}, {{acceleration}}, {{steps}});
  let finalPosition: int = state.position;
  let finalVelocity: int = state.velocity;
  if (finalPosition !== ${p} || finalVelocity !== ${v}) {
    throw { code: "PHYSICS_FAIL", message: "integration mismatch" };
  }
  console.log("${id}:ok");
  return null;
}`;
    return task({
      id, family: "physics-engine", seed: index,
      prompt: `Implement a deterministic 1D physics integrator. Start at position ${s.p}, velocity ${s.v}, acceleration ${s.a}; advance ${s.steps} unit ticks and validate position ${p}, velocity ${v}.`,
      expectedStdout: `${id}:ok`, blueprint,
      slots: [
        slot("position_update", "int", "p + v", ["p - v", "p + acceleration"], "position integration"),
        slot("velocity_update", "int", "v + acceleration", ["v - acceleration", "v + p"], "velocity integration"),
        slot("initial_position", "int", s.p, [s.p + 1, 0], "initial position"),
        slot("initial_velocity", "int", s.v, [s.v + 1, 0], "initial velocity"),
        slot("acceleration", "int", s.a, [s.a + 1, 0], "acceleration"),
        slot("steps", "int", s.steps, [s.steps + 1, Math.max(1, s.steps - 1)], "simulation steps"),
      ],
    });
  });
}

function aabbTasks() {
  const scenarios = [
    { a: [0, 0, 4, 4], b: [2, 2, 3, 3], hit: true },
    { a: [0, 0, 2, 2], b: [3, 0, 2, 2], hit: false },
    { a: [-3, -3, 2, 2], b: [-2, -2, 5, 1], hit: true },
    { a: [5, 5, 1, 1], b: [6, 5, 2, 2], hit: false },
    { a: [10, 1, 8, 2], b: [12, 0, 1, 8], hit: true },
  ];
  return scenarios.map((s, index) => {
    const id = `collision-aabb-${index + 1}`;
    const rect = (v) => `{ x: ${v[0]}, y: ${v[1]}, width: ${v[2]}, height: ${v[3]} }`;
    const blueprint = `${header}class Rect {
  x: int = 0;
  y: int = 0;
  width: int = 0;
  height: int = 0;
}

function overlaps(a: Rect, b: Rect): boolean {
  let horizontal: boolean = {{horizontal_test}};
  let vertical: boolean = {{vertical_test}};
  return {{combine_axes}};
}

export function main(): null {
  let first: Rect = {{rect_a}};
  let second: Rect = {{rect_b}};
  let collided: boolean = overlaps(first, second);
  if (collided !== ${s.hit}) {
    throw { code: "COLLISION_FAIL", message: "AABB result mismatch" };
  }
  console.log("${id}:ok");
  return null;
}`;
    return task({
      id, family: "collision", seed: index + 10,
      prompt: `Implement 2D AABB collision detection for rectangles A=${JSON.stringify(s.a)} and B=${JSON.stringify(s.b)}; touching edges are not overlap.`,
      expectedStdout: `${id}:ok`, blueprint,
      slots: [
        slot("horizontal_test", "boolean", "a.x < b.x + b.width && b.x < a.x + a.width", ["a.x <= b.x + b.width", "a.x > b.x"], "horizontal separation test"),
        slot("vertical_test", "boolean", "a.y < b.y + b.height && b.y < a.y + a.height", ["a.y <= b.y + b.height", "a.y > b.y"], "vertical separation test"),
        slot("combine_axes", "boolean", "horizontal && vertical", ["horizontal || vertical", "horizontal"], "axis combination"),
        slot("rect_a", "Rect", rect(s.a), [rect(s.b), "{ x: 0, y: 0, width: 0, height: 0 }"], "first rectangle"),
        slot("rect_b", "Rect", rect(s.b), [rect(s.a), "{ x: 100, y: 100, width: 1, height: 1 }"], "second rectangle"),
      ],
    });
  });
}

function particleTasks() {
  const scenarios = [
    { xs: [0, 10, -4], vs: [2, -1, 3], steps: 3 },
    { xs: [5, 5, 5, 5], vs: [1, 2, 3, 4], steps: 2 },
    { xs: [-10, 0], vs: [4, -2], steps: 5 },
    { xs: [100, -100, 50], vs: [-10, 20, 0], steps: 4 },
    { xs: [1, 2, 3, 4, 5], vs: [5, 4, 3, 2, 1], steps: 1 },
  ];
  return scenarios.map((s, index) => {
    const expected = s.xs.reduce((sum, x, i) => sum + x + s.vs[i] * s.steps, 0);
    const id = `particle-system-${index + 1}`;
    const arr = (xs) => `[${xs.join(", ")}]`;
    const blueprint = `${header}function advance(positions: int[], velocities: int[], steps: int): int[] {
  let tick: int = 0;
  while (tick < steps) {
    for (let i: int = 0; i < positions.length; i = i + 1) {
      positions[i] = {{particle_update}};
    }
    tick = {{tick_update}};
  }
  return positions;
}

function sum(values: int[]): int {
  let result: int = 0;
  for (let value: int of values) { result = {{sum_update}}; }
  return result;
}

export function main(): null {
  let positions: int[] = {{positions}};
  let velocities: int[] = {{velocities}};
  let finalPositions: int[] = advance(positions, velocities, {{steps}});
  if (sum(finalPositions) !== ${expected}) {
    throw { code: "PARTICLE_FAIL", message: "particle checksum mismatch" };
  }
  console.log("${id}:ok");
  return null;
}`;
    return task({
      id, family: "particle-system", seed: index + 20,
      prompt: `Advance particles ${JSON.stringify(s.xs)} with velocities ${JSON.stringify(s.vs)} for ${s.steps} ticks and validate the final position checksum ${expected}.`,
      expectedStdout: `${id}:ok`, blueprint,
      slots: [
        slot("particle_update", "int", "positions[i] + velocities[i]", ["positions[i] - velocities[i]", "velocities[i]"], "particle integration"),
        slot("tick_update", "int", "tick + 1", ["tick - 1", "tick + 2"], "tick update"),
        slot("sum_update", "int", "result + value", ["result - value", "value"], "checksum accumulation"),
        slot("positions", "int[]", arr(s.xs), [arr([...s.xs].reverse()), "[]"], "initial positions"),
        slot("velocities", "int[]", arr(s.vs), [arr(s.vs.map((v) => -v)), "[]"], "velocities"),
        slot("steps", "int", s.steps, [s.steps + 1, Math.max(1, s.steps - 1)], "ticks"),
      ],
    });
  });
}

function ticTacToeTasks() {
  const boards = [
    { cells: ["X", "X", "X", "O", "O", "", "", "", ""], winner: "X" },
    { cells: ["X", "O", "X", "", "O", "", "X", "O", ""], winner: "O" },
    { cells: ["X", "O", "O", "", "X", "", "", "", "X"], winner: "X" },
    { cells: ["X", "O", "X", "X", "O", "O", "O", "X", "X"], winner: "" },
    { cells: ["O", "X", "X", "O", "X", "", "O", "", ""], winner: "O" },
  ];
  return boards.map((scenario, index) => {
    const id = `tic-tac-toe-${index + 1}`;
    const boardSource = `[${scenario.cells.map((cell) => JSON.stringify(cell)).join(", ")}]`;
    const blueprint = `${header}function sameLine(a: string, b: string, c: string): boolean {
  return {{non_empty}} && {{equal_line}};
}

function winner(board: string[]): string {
  if (sameLine(board[0], board[1], board[2])) { return board[0]; }
  if (sameLine(board[3], board[4], board[5])) { return board[3]; }
  if (sameLine(board[6], board[7], board[8])) { return board[6]; }
  if (sameLine(board[0], board[3], board[6])) { return board[0]; }
  if (sameLine(board[1], board[4], board[7])) { return board[1]; }
  if (sameLine(board[2], board[5], board[8])) { return board[2]; }
  if (sameLine(board[0], board[4], board[8])) { return board[0]; }
  if (sameLine(board[2], board[4], board[6])) { return board[2]; }
  return "";
}

export function main(): null {
  let board: string[] = {{board}};
  let result: string = winner(board);
  if (result !== ${JSON.stringify(scenario.winner)}) {
    throw { code: "GAME_FAIL", message: "winner mismatch" };
  }
  console.log("${id}:ok");
  return null;
}`;
    return task({
      id, family: "tic-tac-toe", seed: index + 30,
      prompt: `Implement a complete tic-tac-toe winner detector over rows, columns and diagonals for board ${JSON.stringify(scenario.cells)}. Empty string means no winner.`,
      expectedStdout: `${id}:ok`, blueprint,
      slots: [
        slot("non_empty", "boolean", 'a !== ""', ['a === ""', 'b !== ""'], "line is occupied"),
        slot("equal_line", "boolean", "a === b && b === c", ["a === b || b === c", "a !== b && b !== c"], "three equal marks"),
        slot("board", "string[]", boardSource, ["[\"\", \"\", \"\", \"\", \"\", \"\", \"\", \"\", \"\"]", `[${[...scenario.cells].reverse().map((cell) => JSON.stringify(cell)).join(", ")}]`], "board cells"),
      ],
    });
  });
}

function lifeTasks() {
  const scenarios = [
    { alive: true, neighbors: 1 },
    { alive: true, neighbors: 2 },
    { alive: true, neighbors: 4 },
    { alive: false, neighbors: 3 },
    { alive: false, neighbors: 2 },
  ];
  return scenarios.map((s, index) => {
    const expected = s.alive ? (s.neighbors === 2 || s.neighbors === 3) : s.neighbors === 3;
    const id = `cellular-automaton-${index + 1}`;
    const blueprint = `${header}function nextCell(alive: boolean, neighbors: int): boolean {
  if (alive) {
    return {{survival_rule}};
  }
  return {{birth_rule}};
}

function run(initial: boolean, neighbors: int, generations: int): boolean {
  let state: boolean = initial;
  for (let generation: int = 0; generation < generations; generation = generation + 1) {
    state = nextCell(state, neighbors);
  }
  return state;
}

export function main(): null {
  let result: boolean = run({{initial_state}}, {{neighbors}}, 1);
  if (result !== ${expected}) {
    throw { code: "LIFE_FAIL", message: "cell transition mismatch" };
  }
  console.log("${id}:ok");
  return null;
}`;
    return task({
      id, family: "cellular-automaton", seed: index + 40,
      prompt: `Implement one Conway's Game of Life cell transition: initially alive=${s.alive}, neighbor count=${s.neighbors}.`,
      expectedStdout: `${id}:ok`, blueprint,
      slots: [
        slot("survival_rule", "boolean", "neighbors === 2 || neighbors === 3", ["neighbors === 3", "neighbors >= 2"], "survival rule"),
        slot("birth_rule", "boolean", "neighbors === 3", ["neighbors === 2", "neighbors >= 3"], "birth rule"),
        slot("initial_state", "boolean", s.alive, [!s.alive], "initial state"),
        slot("neighbors", "int", s.neighbors, [(s.neighbors + 1) % 5, Math.max(0, s.neighbors - 1)], "neighbor count"),
      ],
    });
  });
}

function pathTasks() {
  const blockedCells = [1, 3, 4, 5, 7];
  return blockedCells.map((blocked, index) => {
    const ways = Array(9).fill(0);
    for (let i = 0; i < 9; i++) {
      if (i === blocked) continue;
      if (i === 0) ways[i] = 1;
      else ways[i] = (i % 3 > 0 ? ways[i - 1] : 0) + (i >= 3 ? ways[i - 3] : 0);
    }
    const expected = ways[8];
    const id = `grid-pathfinding-${index + 1}`;
    const blueprint = `${header}function countPaths(blocked: int): int {
  let ways: int[] = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let cell: int = 0; cell < 9; cell = cell + 1) {
    if (cell === blocked) {
      ways[cell] = 0;
    } else if (cell === 0) {
      ways[cell] = 1;
    } else {
      let left: int = 0;
      let up: int = 0;
      if (cell % 3 > 0) { left = ways[cell - 1]; }
      if (cell >= 3) { up = ways[cell - 3]; }
      ways[cell] = {{path_combine}};
    }
  }
  return ways[8];
}

export function main(): null {
  let paths: int = countPaths({{blocked_cell}});
  if (paths !== ${expected}) {
    throw { code: "PATH_FAIL", message: "path count mismatch" };
  }
  console.log("${id}:ok");
  return null;
}`;
    return task({
      id, family: "grid-pathfinding", seed: index + 50,
      prompt: `Count monotonic paths across a 3x3 grid using dynamic programming, moving right/down, with cell ${blocked} blocked. Expected path count is ${expected}.`,
      expectedStdout: `${id}:ok`, blueprint,
      slots: [
        slot("path_combine", "int", "left + up", ["left - up", "left"], "dynamic-programming recurrence"),
        slot("blocked_cell", "int", blocked, [(blocked + 1) % 9, 8], "blocked cell"),
      ],
    });
  });
}

function inventoryTasks() {
  const scenarios = [
    { quantities: [2, 1, 4], prices: [5, 20, 3], threshold: 40, discount: 5 },
    { quantities: [1, 1], prices: [10, 15], threshold: 30, discount: 7 },
    { quantities: [5, 2, 1], prices: [8, 6, 50], threshold: 80, discount: 10 },
    { quantities: [3, 3, 3, 3], prices: [2, 4, 6, 8], threshold: 50, discount: 4 },
    { quantities: [10], prices: [9], threshold: 90, discount: 9 },
  ];
  return scenarios.map((s, index) => {
    const subtotal = s.quantities.reduce((sum, q, i) => sum + q * s.prices[i], 0);
    const expected = subtotal >= s.threshold ? subtotal - s.discount : subtotal;
    const id = `inventory-economy-${index + 1}`;
    const arr = (values) => `[${values.join(", ")}]`;
    const blueprint = `${header}function subtotal(quantities: int[], prices: int[]): int {
  let total: int = 0;
  for (let index: int = 0; index < quantities.length; index = index + 1) {
    let line: int = {{line_total}};
    total = {{total_update}};
  }
  return total;
}

function checkout(value: int, threshold: int, discount: int): int {
  if ({{discount_condition}}) { return value - discount; }
  return value;
}

export function main(): null {
  let quantities: int[] = {{quantities}};
  let prices: int[] = {{prices}};
  let charged: int = checkout(subtotal(quantities, prices), ${s.threshold}, ${s.discount});
  if (charged !== ${expected}) {
    throw { code: "INVENTORY_FAIL", message: "checkout mismatch" };
  }
  console.log("${id}:ok");
  return null;
}`;
    return task({
      id, family: "inventory-economy", seed: index + 60,
      prompt: `Build an inventory checkout: quantities ${JSON.stringify(s.quantities)}, prices ${JSON.stringify(s.prices)}, discount ${s.discount} when subtotal >= ${s.threshold}.`,
      expectedStdout: `${id}:ok`, blueprint,
      slots: [
        slot("line_total", "int", "quantities[index] * prices[index]", ["quantities[index] + prices[index]", "prices[index]"], "line total"),
        slot("total_update", "int", "total + line", ["total - line", "line"], "subtotal accumulation"),
        slot("discount_condition", "boolean", "value >= threshold", ["value > threshold", "value < threshold"], "discount condition"),
        slot("quantities", "int[]", arr(s.quantities), [arr([...s.quantities].reverse()), "[]"], "quantities"),
        slot("prices", "int[]", arr(s.prices), [arr([...s.prices].reverse()), "[]"], "prices"),
      ],
    });
  });
}

function schedulerTasks() {
  const scenarios = [
    { jobs: [3, 4, 2, 8], budget: 10 },
    { jobs: [5, 5, 5], budget: 9 },
    { jobs: [1, 2, 3, 4, 5], budget: 15 },
    { jobs: [7, 1, 1, 1], budget: 8 },
    { jobs: [2, 6, 2, 6], budget: 12 },
  ];
  return scenarios.map((s, index) => {
    let elapsed = 0;
    let count = 0;
    while (count < s.jobs.length && elapsed + s.jobs[count] <= s.budget) {
      elapsed += s.jobs[count++];
    }
    const id = `job-scheduler-${index + 1}`;
    const blueprint = `${header}function schedule(durations: int[], budget: int): table {
  let elapsed: int = 0;
  let count: int = 0;
  while ({{loop_condition}}) {
    elapsed = {{elapsed_update}};
    count = {{count_update}};
  }
  return { count: count, elapsed: elapsed };
}

export function main(): null {
  let durations: int[] = {{durations}};
  let result: table = schedule(durations, {{budget}});
  let count: int = result.count;
  let elapsed: int = result.elapsed;
  if (count !== ${count} || elapsed !== ${elapsed}) {
    throw { code: "SCHEDULER_FAIL", message: "schedule mismatch" };
  }
  console.log("${id}:ok");
  return null;
}`;
    return task({
      id, family: "job-scheduler", seed: index + 70,
      prompt: `Schedule the longest FIFO prefix of job durations ${JSON.stringify(s.jobs)} within budget ${s.budget}; validate count ${count} and elapsed ${elapsed}.`,
      expectedStdout: `${id}:ok`, blueprint,
      slots: [
        slot("loop_condition", "boolean", "count < durations.length && elapsed + durations[count] <= budget", ["count < durations.length", "elapsed < budget"], "admission condition"),
        slot("elapsed_update", "int", "elapsed + durations[count]", ["elapsed + 1", "durations[count]"], "elapsed time update"),
        slot("count_update", "int", "count + 1", ["count - 1", "count + 2"], "job count update"),
        slot("durations", "int[]", `[${s.jobs.join(", ")}]`, [`[${[...s.jobs].reverse().join(", ")}]`, "[]"], "job durations"),
        slot("budget", "int", s.budget, [s.budget + 1, Math.max(0, s.budget - 1)], "time budget"),
      ],
    });
  });
}

const tasks = [
  ...physicsTasks(),
  ...aabbTasks(),
  ...particleTasks(),
  ...ticTacToeTasks(),
  ...lifeTasks(),
  ...pathTasks(),
  ...inventoryTasks(),
  ...schedulerTasks(),
];

if (tasks.length !== 40) throw new Error(`expected 40 tasks, got ${tasks.length}`);
await writeFile(resolve(HERE, "large-tasks.json"), JSON.stringify(tasks, null, 2) + "\n");
console.log(`Generated ${tasks.length} tasks across ${new Set(tasks.map((item) => item.family)).size} families.`);
