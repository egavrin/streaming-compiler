const MAX_AGENT_ROUNDS = 10;

/** LLM-facing iterative modernization over stateless compiler transactions. */
export class CanonicalRefinementEngine {
  constructor({ compiler, model, maxAgentRounds = MAX_AGENT_ROUNDS, maxSemanticRepairs = 2, transportRetries = 1 }) {
    this.compiler = compiler;
    this.model = model;
    this.maxAgentRounds = maxAgentRounds;
    this.maxSemanticRepairs = maxSemanticRepairs;
    this.transportRetries = transportRetries;
  }

  async refine({ instruction, deal, dealUi, pack, packSpecifier }) {
    const started = performance.now();
    const previous = { deal, dealUi };
    let staged = { deal, dealUi };
    let inspection = await this.compiler.inspectCanonicalApp({ deal, dealUi, pack, packSpecifier });
    if (!inspection.valid) throw new Error(`cannot refine an invalid canonical app: ${compactDiagnostics(inspection.diagnostics)}`);
    const transcript = [];
    const metrics = {
      agentRounds: 0,
      semanticRepairs: 0,
      transportRetries: 0,
      compilerTransactions: 0,
      inputTokens: 0,
      outputTokens: 0,
      changedUnits: [],
      timeToFirstAcceptedChangeMs: null,
      totalLatencyMs: 0,
    };
    let repairScopes = null;
    let forcedArtifact = null;
    let changed = false;

    for (let round = 0; round < this.maxAgentRounds; round++) {
      metrics.agentRounds++;
      const tools = buildTools(inspection, repairScopes, forcedArtifact);
      const context = compactInspection(inspection);
      const messages = [{
        role: "system",
        content: SYSTEM_PROMPT,
      }, {
        role: "user",
        content: [
          `Requested modernization:\n${instruction}`,
          `Current compiler inspection:\n${JSON.stringify(context)}`,
          transcript.length ? `Previous tool results:\n${transcript.join("\n")}` : "",
          repairScopes ? `The previous semantic transaction was rejected. Only the compiler-scoped repair tools are writable.` : "",
        ].filter(Boolean).join("\n\n"),
      }];
      let call;
      for (let attempt = 0; ; attempt++) {
        try {
          call = await this.model.completeTool({ messages, tools });
          break;
        } catch (error) {
          if (error.kind !== "transport" || attempt >= this.transportRetries) throw error;
          metrics.transportRetries++;
        }
      }
      addUsage(metrics, call.usage);

      if (call.name === "query_deal_symbol") {
        transcript.push(toolResult(call.name, queryDealSymbol(staged.deal, inspection.deal, call.args.targetId)));
        continue;
      }
      if (call.name === "query_deal_node") {
        transcript.push(toolResult(call.name, queryNode(staged.deal, inspection.deal.nodes, call.args.targetId)));
        continue;
      }
      if (call.name === "query_deal_ui_node") {
        transcript.push(toolResult(call.name, queryNode(staged.dealUi, inspection.dealUi?.nodes ?? [], call.args.targetId)));
        continue;
      }
      if (call.name === "unchanged") {
        if (forcedArtifact) {
          throw new Error(`model reported unchanged while ${forcedArtifact} bindings require modernization`);
        }
        return finish({ accepted: true, changed, previous, staged, inspection, metrics, started });
      }
      if (call.name === "apply_deal_changes") {
        metrics.compilerTransactions++;
        const result = await this.compiler.applyDealChange({
          source: staged.deal,
          baseDigest: inspection.deal.sourceDigest,
          operations: call.args.operations,
        });
        if (!result.accepted) {
          metrics.semanticRepairs++;
          if (metrics.semanticRepairs > this.maxSemanticRepairs) {
            return finish({ accepted: false, changed: false, previous, staged: previous, inspection,
              diagnostics: result.diagnostics, metrics, started });
          }
          repairScopes = result.diagnostics.flatMap((diagnostic) => diagnostic.repairScopes ?? []);
          forcedArtifact = "deal";
          transcript.push(toolResult(call.name, { accepted: false, diagnostics: result.diagnostics }));
          continue;
        }
        staged.deal = result.source;
        changed = true;
        recordAccepted(metrics, result.impact, started);
        repairScopes = null;
        forcedArtifact = result.impact.interfaceChanged ? "dealui" : null;
        inspection = await this.compiler.inspectCanonicalApp({ ...staged, pack, packSpecifier });
        if (inspection.valid && call.args.final !== false) {
          return finish({ accepted: true, changed, previous, staged, inspection, metrics, started });
        }
        transcript.push(toolResult(call.name, {
          accepted: true,
          impact: result.impact,
          crossArtifactDiagnostics: inspection.diagnostics,
        }));
        continue;
      }
      if (call.name === "apply_deal_ui_changes") {
        metrics.compilerTransactions++;
        const result = await this.compiler.applyDealUiChange({
          deal: staged.deal,
          source: staged.dealUi,
          pack,
          packSpecifier,
          baseDigest: inspection.dealUi.sourceDigest,
          operations: call.args.operations,
        });
        if (!result.accepted) {
          metrics.semanticRepairs++;
          if (metrics.semanticRepairs > this.maxSemanticRepairs) {
            return finish({ accepted: false, changed: false, previous, staged: previous, inspection,
              diagnostics: result.diagnostics, metrics, started });
          }
          repairScopes = result.diagnostics.flatMap((diagnostic) => diagnostic.repairScopes ?? []);
          forcedArtifact = "dealui";
          transcript.push(toolResult(call.name, { accepted: false, diagnostics: result.diagnostics }));
          continue;
        }
        staged.dealUi = result.source;
        changed = true;
        recordAccepted(metrics, result.impact, started);
        repairScopes = null;
        forcedArtifact = null;
        inspection = await this.compiler.compileCanonicalApp({ ...staged, pack, packSpecifier });
        if (inspection.valid && call.args.final !== false) {
          return finish({ accepted: true, changed, previous, staged, inspection, metrics, started });
        }
        transcript.push(toolResult(call.name, { accepted: true, impact: result.impact,
          crossArtifactDiagnostics: inspection.diagnostics }));
        continue;
      }
      throw new Error(`unsupported canonical compiler tool ${call.name}`);
    }
    return finish({ accepted: false, changed: false, previous, staged: previous, inspection,
      diagnostics: [{ code: "SC1001", message: "agent round budget exhausted" }], metrics, started });
  }
}

const SYSTEM_PROMPT = `You modernize an existing canonical DEAL application through compiler tools.
DEAL owns state and behavior. Deal UI owns declarative presentation. Query only the symbols or nodes
needed for the requested change, then submit one small atomic transaction. Never regenerate an
unrelated unit. Compiler diagnostics and writable target IDs are authoritative. Use no scenario
templates. Mark final=false only when another behavior or visual transaction is still required.`;

function buildTools(inspection, repairScopes, forcedArtifact) {
  const dealSymbols = inspection.deal.symbols ?? [];
  const dealNodes = inspection.deal.nodes ?? [];
  const uiNodes = inspection.dealUi?.nodes ?? [];
  const scoped = repairScopes?.length ? new Set(repairScopes.map((scope) => `${scope.operation}:${scope.ownerId.value}`)) : null;
  const allow = (operation, targetId) => !scoped || scoped.has(`${operation}:${targetId}`);
  const tools = [];
  if (forcedArtifact !== "dealui" && !scoped) {
    tools.push(tool("query_deal_symbol", "Read one DEAL declaration and dependency summary.", objectSchema({
      targetId: enumString(dealSymbols.map((value) => value.id.value)),
    })));
    tools.push(tool("query_deal_node", "Read one DEAL function or block body.", objectSchema({
      targetId: enumString(dealNodes.map((value) => value.id.value)),
    })));
  }
  if (forcedArtifact !== "deal" && !scoped && uiNodes.length) {
    tools.push(tool("query_deal_ui_node", "Read one Deal UI subtree and its bindings.", objectSchema({
      targetId: enumString(uiNodes.map((value) => value.id.value)),
    })));
  }

  const dealOperations = [];
  if (forcedArtifact !== "dealui") {
    if (allow("addDeclaration", inspection.deal.moduleId.value)) {
      dealOperations.push(operationSchema("addDeclaration", inspection.deal.moduleId.value, { declaration: { type: "string" } }));
    }
    for (const symbol of dealSymbols) if (allow("removeDeclaration", symbol.id.value)) {
      dealOperations.push(operationSchema("removeDeclaration", symbol.id.value));
    }
    for (const node of dealNodes) {
      const operation = node.kind === "function-body" ? "replaceFunctionBody" : "replaceBlockBody";
      if (allow(operation, node.id.value)) dealOperations.push(operationSchema(operation, node.id.value, { body: { type: "string" } }));
    }
  }
  if (dealOperations.length) tools.push(transactionTool("apply_deal_changes", "Apply one atomic DEAL ChangeSet.", dealOperations));

  const uiOperations = [];
  if (forcedArtifact !== "deal") {
    for (const node of uiNodes) {
      if (allow("replaceSubtree", node.id.value)) uiOperations.push(operationSchema("replaceSubtree", node.id.value, { source: { type: "string" } }));
      if (allow("removeNode", node.id.value)) uiOperations.push(operationSchema("removeNode", node.id.value));
      if (node.properties) for (const property of Object.keys(node.properties)) {
        if (allow("setProperty", node.id.value)) uiOperations.push(operationSchema("setProperty", node.id.value,
          { property: { const: property }, expression: { type: "string" } }));
      }
      if (node.children && allow("insertChild", node.id.value)) uiOperations.push(operationSchema("insertChild", node.id.value,
        { index: { type: "integer", minimum: 0, maximum: node.children.length }, source: { type: "string" } }));
    }
    for (const view of inspection.dealUi?.views ?? []) {
      if (allow("replaceViewBody", view.id.value)) uiOperations.push(operationSchema("replaceViewBody", view.id.value, { body: { type: "string" } }));
    }
  }
  if (uiOperations.length) tools.push(transactionTool("apply_deal_ui_changes", "Apply one atomic Deal UI ChangeSet.", uiOperations));
  if (!forcedArtifact && !scoped) tools.push(tool("unchanged", "The requested behavior is already present or needs no source change.",
    objectSchema({ reason: { type: "string" } })));
  return tools;
}

function compactInspection(inspection) {
  return {
    valid: inspection.valid,
    deal: {
      sourceDigest: inspection.deal.sourceDigest,
      moduleId: inspection.deal.moduleId,
      appInterface: inspection.deal.appInterface,
      symbols: inspection.deal.symbols.map(({ id, kind, name, signature, fingerprint, callers, callees }) =>
        ({ id, kind, name, signature, fingerprint, callers, callees })),
      nodes: inspection.deal.nodes.map(({ id, ownerId, kind, fingerprint }) =>
        ({ id, ownerId, kind, fingerprint })),
    },
    dealUi: inspection.dealUi && {
      sourceDigest: inspection.dealUi.sourceDigest,
      appInterfaceFingerprint: inspection.dealUi.appInterfaceFingerprint,
      views: inspection.dealUi.views.map(({ id, name, root, fingerprint, rootNodes }) => ({ id, name, root, fingerprint, rootNodes })),
      nodes: inspection.dealUi.nodes.map(({ id, ownerViewId, parentId, kind, component, fingerprint, children, statePaths, actionBindings, properties }) =>
        ({ id, ownerViewId, parentId, kind, component, fingerprint, children, statePaths, actionBindings, properties: Object.keys(properties ?? {}) })),
    },
    packVersion: inspection.packVersion,
    packDigest: inspection.packDigest,
  };
}

function queryDealSymbol(source, inspection, targetId) {
  const symbol = inspection.symbols.find((value) => value.id.value === targetId);
  if (!symbol) throw new Error(`unknown DEAL symbol ${targetId}`);
  return { ...symbol, source: sourceRange(source, symbol.range) };
}

function queryNode(source, nodes, targetId) {
  const node = nodes.find((value) => value.id.value === targetId);
  if (!node) throw new Error(`unknown compiler node ${targetId}`);
  return { ...node, source: sourceRange(source, node.range) };
}

function sourceRange(source, range) {
  if (!range) return "";
  const lines = source.split("\n");
  const selected = lines.slice(range.startLine - 1, range.endLine);
  if (!selected.length) return "";
  selected[0] = [...selected[0]].slice(range.startColumn - 1).join("");
  if (selected.length === 1) return [...selected[0]].slice(0, range.endColumn - range.startColumn + 1).join("");
  selected[selected.length - 1] = [...selected[selected.length - 1]].slice(0, range.endColumn).join("");
  return selected.join("\n");
}

function tool(name, description, parameters) {
  return { type: "function", function: { name, description, parameters } };
}

function transactionTool(name, description, variants) {
  return tool(name, description, objectSchema({
    operations: { type: "array", minItems: 1, items: { oneOf: variants } },
    final: { type: "boolean" },
  }, ["operations", "final"]));
}

function operationSchema(operation, targetId, extra = {}) {
  return objectSchema({ operation: { const: operation }, targetId: { const: targetId }, ...extra });
}

function objectSchema(properties, required = Object.keys(properties)) {
  return { type: "object", properties, required, additionalProperties: false };
}

function enumString(values) {
  return { type: "string", enum: values };
}

function toolResult(name, value) {
  return `${name}: ${JSON.stringify(value)}`;
}

function compactDiagnostics(diagnostics) {
  return diagnostics.map((value) => `${value.code}: ${value.message}`).join("; ");
}

function addUsage(metrics, usage) {
  if (!usage) return;
  metrics.inputTokens += usage.inputTokens ?? 0;
  metrics.outputTokens += usage.outputTokens ?? 0;
}

function recordAccepted(metrics, impact, started) {
  if (metrics.timeToFirstAcceptedChangeMs == null) metrics.timeToFirstAcceptedChangeMs = performance.now() - started;
  for (const value of impact.changedSymbols ?? impact.changedViews ?? []) metrics.changedUnits.push(value.value ?? value);
  for (const value of impact.changedNodes ?? []) metrics.changedUnits.push(value.value ?? value);
}

function finish({ accepted, changed, previous, staged, inspection, diagnostics = [], metrics, started }) {
  metrics.totalLatencyMs = performance.now() - started;
  return { accepted, changed, previous, app: accepted ? staged : previous, inspection, diagnostics, metrics };
}

export const _test = { buildTools, sourceRange };
