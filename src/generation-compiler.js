const PRIMITIVE_TYPES = new Set(["string", "int", "number", "boolean", "null"]);

function assertTask(task) {
  if (!task || typeof task !== "object" || !task.id || !task.prompt) {
    throw new Error("task must have id and prompt");
  }
  const isBlueprint = typeof task.semantic?.blueprint === "string";
  if (!isBlueprint && !PRIMITIVE_TYPES.has(task.semantic?.rootType)) {
    throw new Error(`task ${task.id}: unsupported semantic.rootType`);
  }
  if (!Array.isArray(task.semantic.catalog) || task.semantic.catalog.length === 0) {
    throw new Error(`task ${task.id}: semantic.catalog must not be empty`);
  }
  if (isBlueprint && (!Array.isArray(task.semantic.slots) || task.semantic.slots.length === 0)) {
    throw new Error(`task ${task.id}: semantic.slots must not be empty`);
  }
}

function clone(value) {
  return structuredClone(value);
}

function nodeAtPath(root, path) {
  let node = root;
  for (const index of path) node = node.args[index];
  return node;
}

function replaceAtPath(root, path, replacement) {
  if (path.length === 0) return replacement;
  const copy = clone(root);
  let node = copy;
  for (let i = 0; i < path.length - 1; i++) node = node.args[path[i]];
  node.args[path.at(-1)] = replacement;
  return copy;
}

function escapeDealString(value) {
  return JSON.stringify(value).replaceAll("\\u2028", "\\u2028").replaceAll("\\u2029", "\\u2029");
}

function renderExpression(node) {
  switch (node.kind) {
    case "literal":
      return node.type === "string" ? escapeDealString(node.value) : String(node.value);
    case "binary":
      return `(${renderExpression(node.args[0])} ${node.operator} ${renderExpression(node.args[1])})`;
    case "call":
      return `${node.alias}.${node.function}(${node.args.map(renderExpression).join(", ")})`;
    default:
      throw new Error(`cannot render incomplete node ${node.kind}`);
  }
}

function collectImports(node, imports = new Map()) {
  if (node.kind === "call") imports.set(node.module, node.alias);
  for (const arg of node.args ?? []) collectImports(arg, imports);
  return imports;
}

/**
 * Minimal typed partial-HIR generation API.
 *
 * The HIR is deliberately compiler-owned: model output can only replace the
 * current typed Hole with a catalog operation whose result type matches it.
 */
export class GenerationCompiler {
  constructor() {
    this.task = null;
    this.root = null;
    this.holes = [];
    this.rejectedChoices = 0;
    this.compilerDecisions = 0;
    this.appliedChoices = [];
  }

  start(task) {
    assertTask(task);
    this.task = clone(task);
    if (typeof task.semantic.blueprint === "string") {
      this.root = { kind: "blueprint", template: task.semantic.blueprint, values: {} };
      this.holes = task.semantic.slots.map((slot) => ({
        slotId: slot.id,
        path: [slot.id],
        type: slot.type,
      }));
    } else {
      this.root = { kind: "hole", type: task.semantic.rootType };
      this.holes = [{ path: [], type: task.semantic.rootType }];
    }
    this.rejectedChoices = 0;
    this.compilerDecisions = 0;
    this.appliedChoices = [];
    this.#completeDeterministicChoices();
    return this.snapshot();
  }

  getChoices() {
    if (!this.task) throw new Error("start(task) must be called first");
    if (this.holes.length === 0) return [];
    const expectedType = this.holes[0].type;
    return this.task.semantic.catalog
      .filter((choice) => choice.resultType === expectedType
        && (!this.holes[0].slotId || choice.slotId === this.holes[0].slotId))
      .map((choice) => ({
        id: choice.id,
        label: choice.label,
        resultType: choice.resultType,
        argumentTypes: choice.argumentTypes ?? [],
      }));
  }

  apply(choiceId, { neural = true } = {}) {
    if (this.isComplete()) {
      this.rejectedChoices++;
      return { accepted: false, reason: "program is already complete" };
    }
    const choice = this.task.semantic.catalog.find((candidate) => candidate.id === choiceId);
    const hole = this.holes[0];
    if (!choice) {
      this.rejectedChoices++;
      return { accepted: false, reason: `unknown choice ${choiceId}` };
    }
    if (choice.resultType !== hole.type) {
      this.rejectedChoices++;
      return {
        accepted: false,
        reason: `choice ${choiceId} produces ${choice.resultType}, hole requires ${hole.type}`,
      };
    }

    if (hole.slotId) {
      if (choice.slotId !== hole.slotId || typeof choice.source !== "string") {
        this.rejectedChoices++;
        return { accepted: false, reason: `choice ${choiceId} does not fill slot ${hole.slotId}` };
      }
      this.root.values[hole.slotId] = choice.source;
      this.holes.shift();
      this.appliedChoices.push({ id: choiceId, neural });
      this.#completeDeterministicChoices();
      return { accepted: true, snapshot: this.snapshot() };
    }

    const argumentTypes = choice.argumentTypes ?? [];
    const args = argumentTypes.map((type) => ({ kind: "hole", type }));
    const node = { ...clone(choice.node), type: choice.resultType, args };
    this.root = replaceAtPath(this.root, hole.path, node);
    const childHoles = argumentTypes.map((type, index) => ({
      path: [...hole.path, index],
      type,
    }));
    this.holes.splice(0, 1, ...childHoles);
    this.appliedChoices.push({ id: choiceId, neural });
    this.#completeDeterministicChoices();
    return { accepted: true, snapshot: this.snapshot() };
  }

  isComplete() {
    return Boolean(this.task) && this.holes.length === 0;
  }

  finish() {
    if (!this.isComplete()) throw new Error("cannot finish while typed holes remain");
    if (this.root.kind === "blueprint") {
      let source = this.root.template;
      for (const [slotId, value] of Object.entries(this.root.values)) {
        source = source.replaceAll(`{{${slotId}}}`, value);
      }
      if (/\{\{[a-zA-Z0-9_-]+\}\}/.test(source)) {
        throw new Error("cannot finish blueprint with unresolved placeholders");
      }
      return source.endsWith("\n") ? source : `${source}\n`;
    }
    const imports = collectImports(this.root);
    imports.set("std/console", "console");
    const importLines = [...imports.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([module, alias]) => `import * as ${alias} from ${escapeDealString(module)};`);
    return `${importLines.join("\n")}\n\nexport function main(): null {\n  console.log(${renderExpression(this.root)});\n  return null;\n}\n`;
  }

  snapshot() {
    return {
      hir: clone(this.root),
      currentHole: this.holes[0] ? clone(this.holes[0]) : null,
      remainingHoles: this.holes.length,
      choices: this.getChoices(),
      rejectedChoices: this.rejectedChoices,
      compilerDecisions: this.compilerDecisions,
      appliedChoices: clone(this.appliedChoices),
    };
  }

  #completeDeterministicChoices() {
    while (this.holes.length > 0) {
      const choices = this.getChoices();
      if (choices.length !== 1) return;
      this.compilerDecisions++;
      const result = this.apply(choices[0].id, { neural: false });
      if (!result.accepted) return;
    }
  }
}

export function renderPartialHir(node) {
  if (!node) return "<not-started>";
  if (node.kind === "hole") return `?${node.type}`;
  if (node.kind === "blueprint") {
    return `ProgramBlueprint(${Object.entries(node.values)
      .map(([id, value]) => `${id}=${JSON.stringify(value)}`).join(", ")})`;
  }
  if (node.kind === "literal") return `${node.type}(${JSON.stringify(node.value)})`;
  const args = (node.args ?? []).map(renderPartialHir).join(", ");
  if (node.kind === "binary") return `${node.type}[${node.operator}](${args})`;
  if (node.kind === "call") return `${node.type}[${node.module}.${node.function}](${args})`;
  return `${node.kind}(${args})`;
}

export function _nodeAtPathForTest(root, path) {
  return nodeAtPath(root, path);
}
