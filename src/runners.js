import { performance } from "node:perf_hooks";
import { GenerationCompiler } from "./generation-compiler.js";

function now() {
  return performance.now();
}

function stripMarkdownFence(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  return match ? match[1] : text;
}

function structurallyComplete(source) {
  let braces = 0;
  let parentheses = 0;
  let brackets = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (c === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === "*" && next === "/") { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && next === "/") { lineComment = true; i++; continue; }
    if (c === "/" && next === "*") { blockComment = true; i++; continue; }
    if (c === '"' || c === "`" || c === "'") { quote = c; continue; }
    if (c === "{") braces++;
    else if (c === "}") braces--;
    else if (c === "(") parentheses++;
    else if (c === ")") parentheses--;
    else if (c === "[") brackets++;
    else if (c === "]") brackets--;
    if (braces < 0 || parentheses < 0 || brackets < 0) return false;
  }
  return braces === 0 && parentheses === 0 && brackets === 0 && !quote && !blockComment
    && /export\s+function\s+main/.test(source) && source.trimEnd().endsWith("}");
}

function baseMetrics(task, mode, streaming) {
  return {
    taskId: task.id,
    family: task.family ?? "small",
    level: task.level ?? "small",
    mode,
    streaming,
    success: false,
    compileAt1: false,
    functionalAt1: false,
    syntaxFailures: 0,
    semanticFailures: 0,
    functionalFailures: 0,
    rejectedChoices: 0,
    rejectedPrefixes: 0,
    repairIterations: 0,
    apiRoundTrips: 0,
    outputTokens: 0,
    inputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    apiCostUsd: 0,
    neuralDecisions: 0,
    compilerDecisions: 0,
    wallClockMs: 0,
    timeToFirstValidProgramMs: null,
    source: null,
    diagnostics: [],
  };
}

function recordFailure(metrics, result) {
  if (result.failureKind === "syntax") metrics.syntaxFailures++;
  else if (result.failureKind === "semantic" || result.failureKind === "compiler") metrics.semanticFailures++;
  else if (result.failureKind === "functional") metrics.functionalFailures++;
  metrics.diagnostics = result.diagnostics;
}

export async function runDirect({ task, model, compiler, streaming = true, maxRepairs = 2 }) {
  const metrics = baseMetrics(task, "direct", streaming);
  const started = now();
  let repairDiagnostics = [];
  let previousSource = "";
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    metrics.apiRoundTrips++;
    let raw = "";
    let lastInspectedLength = 0;
    let earlyImpossible = false;
    for await (const event of model.streamDirect({ task, repairDiagnostics, previousSource })) {
      if (event.type === "usage") {
        metrics.inputTokens += event.inputTokens ?? 0;
        metrics.outputTokens += event.outputTokens ?? 0;
        metrics.totalTokens += event.totalTokens ?? event.outputTokens ?? 0;
        metrics.reasoningTokens += event.reasoningTokens ?? 0;
        metrics.apiCostUsd += event.costUsd ?? 0;
        continue;
      }
      if (event.type !== "text") continue;
      raw += event.delta;
      if (!streaming || raw.length - lastInspectedLength < 48) continue;
      lastInspectedLength = raw.length;
      const prefix = stripMarkdownFence(raw).replace(/^```(?:deal)?\s*\n?/i, "");
      const inspection = await compiler.inspectPrefix(prefix);
      if (inspection.impossible) {
        metrics.rejectedPrefixes++;
        repairDiagnostics = inspection.diagnostics.map((d) => `${d.code}: ${d.message}`);
        earlyImpossible = true;
        break;
      }
      if (structurallyComplete(prefix) && metrics.timeToFirstValidProgramMs == null) {
        const checkpoint = await compiler.compileAndRun(prefix, task.expectedStdout);
        if (checkpoint.compileSuccess && checkpoint.functionalSuccess) {
          metrics.timeToFirstValidProgramMs = now() - started;
        }
      }
    }
    previousSource = stripMarkdownFence(raw).trim();
    if (earlyImpossible) {
      metrics.syntaxFailures++;
      if (attempt < maxRepairs) metrics.repairIterations++;
      continue;
    }
    const source = previousSource + "\n";
    metrics.source = source;
    const result = await compiler.compileAndRun(source, task.expectedStdout);
    if (attempt === 0) {
      metrics.compileAt1 = result.compileSuccess;
      metrics.functionalAt1 = result.functionalSuccess;
    }
    if (result.compileSuccess && result.functionalSuccess) {
      metrics.success = true;
      if (metrics.timeToFirstValidProgramMs == null) metrics.timeToFirstValidProgramMs = now() - started;
      break;
    }
    recordFailure(metrics, result);
    repairDiagnostics = result.diagnostics;
    if (attempt < maxRepairs) metrics.repairIterations++;
  }
  metrics.wallClockMs = now() - started;
  metrics.neuralDecisions = metrics.outputTokens;
  return metrics;
}

export async function runSemantic({ task, model, compiler, streaming = true, maxRepairs = 2, maxRounds = 8 }) {
  const metrics = baseMetrics(task, "semantic", streaming);
  const started = now();
  let repairDiagnostics = [];
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const generation = new GenerationCompiler();
    generation.start(task);
    let rounds = 0;
    while (!generation.isComplete() && rounds < maxRounds) {
      rounds++;
      metrics.apiRoundTrips++;
      const snapshot = generation.snapshot();
      const pending = [];
      for await (const event of model.streamSemantic({ task, snapshot, repairDiagnostics })) {
        if (event.type === "usage") {
          metrics.inputTokens += event.inputTokens ?? 0;
          metrics.outputTokens += event.outputTokens ?? 0;
          metrics.totalTokens += event.totalTokens ?? event.outputTokens ?? 0;
          metrics.reasoningTokens += event.reasoningTokens ?? 0;
          metrics.apiCostUsd += event.costUsd ?? 0;
        } else if (event.type === "choice") {
          if (streaming) {
            const applied = generation.apply(event.id);
            void applied;
          } else {
            pending.push(event.id);
          }
        }
      }
      if (!streaming) {
        for (const id of pending) {
          const applied = generation.apply(id);
          void applied;
        }
      }
      if (generation.isComplete()) break;
    }
    metrics.compilerDecisions += generation.compilerDecisions;
    metrics.neuralDecisions += generation.appliedChoices.filter((choice) => choice.neural).length;
    metrics.rejectedChoices += generation.rejectedChoices;
    if (!generation.isComplete()) {
      metrics.semanticFailures++;
      repairDiagnostics = ["semantic trajectory did not fill every typed hole"];
      if (attempt < maxRepairs) metrics.repairIterations++;
      continue;
    }
    const source = generation.finish();
    metrics.source = source;
    const result = await compiler.compileAndRun(source, task.expectedStdout);
    if (attempt === 0) {
      metrics.compileAt1 = result.compileSuccess;
      metrics.functionalAt1 = result.functionalSuccess;
    }
    if (result.compileSuccess && result.functionalSuccess) {
      metrics.success = true;
      if (metrics.timeToFirstValidProgramMs == null) metrics.timeToFirstValidProgramMs = now() - started;
      break;
    }
    recordFailure(metrics, result);
    repairDiagnostics = result.diagnostics;
    if (attempt < maxRepairs) metrics.repairIterations++;
  }
  metrics.wallClockMs = now() - started;
  return metrics;
}

export function aggregateMetrics(results) {
  const count = results.length;
  const successful = results.filter((result) => result.success);
  const rate = (field) => count ? results.filter((result) => result[field]).length / count : 0;
  const sum = (field, rows = results) => rows.reduce((total, row) => total + (row[field] ?? 0), 0);
  const average = (field, rows = results) => rows.length ? sum(field, rows) / rows.length : null;
  return {
    samples: count,
    successes: successful.length,
    compileAt1: rate("compileAt1"),
    functionalAt1: rate("functionalAt1"),
    syntaxFailures: sum("syntaxFailures"),
    semanticFailures: sum("semanticFailures"),
    functionalFailures: sum("functionalFailures"),
    rejectedChoices: sum("rejectedChoices"),
    rejectedPrefixes: sum("rejectedPrefixes"),
    repairIterations: sum("repairIterations"),
    apiRoundTrips: sum("apiRoundTrips"),
    outputTokens: sum("outputTokens"),
    inputTokens: sum("inputTokens"),
    totalTokens: sum("totalTokens"),
    reasoningTokens: sum("reasoningTokens"),
    apiCostUsd: sum("apiCostUsd"),
    neuralDecisionsPerSuccessfulProgram: average("neuralDecisions", successful),
    averageWallClockMs: average("wallClockMs"),
    averageTimeToFirstValidProgramMs: average("timeToFirstValidProgramMs", successful),
  };
}

export const _test = { stripMarkdownFence, structurallyComplete };
