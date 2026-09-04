import test from "node:test";
import assert from "node:assert/strict";
import { CanonicalCompilerClient } from "../src/canonical-compiler.js";
import { CanonicalRefinementEngine } from "../src/canonical-refinement.js";

const DEAL = `export class AppState { title: string = "Ready"; count: int = 0; }
export class IncrementAction {}
export function initialState(): AppState { return {title: "Ready", count: 0}; }
// @ui-update
export function update(state: AppState, action: IncrementAction): AppState {
  return {title: state.title, count: state.count + 1};
}
`;
const PACK = `pack version "test-v1";
export class ColumnProps {}
export class TextProps { value: string; }
export class ButtonProps { text: string; onClick?: Action; }
export component Column(props: ColumnProps): View { children optional; }
export component Text(props: TextProps): View;
export component Button(props: ButtonProps): View { event onClick; }
`;
const UI = `import * as app from "./app.deal";
import * as ui from "./ui.pack";
// @ui-root
export view App(state: app.AppState): View {
  ui.Column() {
    ui.Text(value: state.title)
    ui.Button(text: "Add", onClick: action app.IncrementAction {})
  }
}
`;

class ScriptedModel {
  constructor(calls) { this.calls = [...calls]; }
  async completeTool({ tools }) {
    const next = this.calls.shift();
    assert.ok(next, "unexpected model round");
    assert.ok(tools.some((value) => value.function.name === next.name),
      `tool ${next.name} is not compiler-writable in this round`);
    return { ...next, usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

test("iterative refinement repairs one rejected body and skips DEAL for UI-only changes", async () => {
  const compiler = new CanonicalCompilerClient();
  await compiler.setup();
  const inspected = await compiler.inspectCanonicalApp({ deal: DEAL, dealUi: UI, pack: PACK, packSpecifier: "./ui.pack" });
  const update = inspected.deal.symbols.find((value) => value.name === "update");
  const body = inspected.deal.nodes.find((value) => value.ownerId.value === update.id.value && value.kind === "function-body");

  const repairModel = new ScriptedModel([
    { name: "query_deal_node", args: { targetId: body.id.value } },
    { name: "apply_deal_changes", args: { final: true, operations: [
      { operation: "replaceFunctionBody", targetId: body.id.value, body: "return missing;" },
    ] } },
    { name: "apply_deal_changes", args: { final: true, operations: [
      { operation: "replaceFunctionBody", targetId: body.id.value,
        body: "return {title: state.title, count: state.count + 2};" },
    ] } },
  ]);
  const repaired = await new CanonicalRefinementEngine({ compiler, model: repairModel }).refine({
    instruction: "Increment by two.", deal: DEAL, dealUi: UI, pack: PACK, packSpecifier: "./ui.pack",
  });
  assert.equal(repaired.accepted, true);
  assert.equal(repaired.metrics.semanticRepairs, 1);
  assert.equal(repaired.metrics.compilerTransactions, 2);
  assert.match(repaired.app.deal, /count \+ 2/);
  assert.equal(repaired.app.dealUi, UI);

  const updatedInspection = await compiler.inspectCanonicalApp({
    deal: repaired.app.deal, dealUi: UI, pack: PACK, packSpecifier: "./ui.pack",
  });
  const text = updatedInspection.dealUi.nodes.find((value) => value.component === "ui.Text");
  let dealTransactions = 0;
  const countedCompiler = {
    inspectCanonicalApp: (...args) => compiler.inspectCanonicalApp(...args),
    compileCanonicalApp: (...args) => compiler.compileCanonicalApp(...args),
    applyDealUiChange: (...args) => compiler.applyDealUiChange(...args),
    applyDealChange: (...args) => { dealTransactions++; return compiler.applyDealChange(...args); },
  };
  const uiModel = new ScriptedModel([
    { name: "query_deal_ui_node", args: { targetId: text.id.value } },
    { name: "apply_deal_ui_changes", args: { final: true, operations: [
      { operation: "setProperty", targetId: text.id.value, property: "value", expression: '"Polished"' },
    ] } },
  ]);
  const visual = await new CanonicalRefinementEngine({ compiler: countedCompiler, model: uiModel }).refine({
    instruction: "Use a clearer static headline.", deal: repaired.app.deal, dealUi: UI,
    pack: PACK, packSpecifier: "./ui.pack",
  });
  assert.equal(visual.accepted, true);
  assert.equal(dealTransactions, 0, "UI-only refinement must not generate or edit DEAL");
  assert.equal(visual.app.deal, repaired.app.deal);
  assert.match(visual.app.dealUi, /value: "Polished"/);
});
