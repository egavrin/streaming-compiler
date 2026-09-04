import test from "node:test";
import assert from "node:assert/strict";
import { CanonicalCompilerClient } from "../src/canonical-compiler.js";

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

test("real canonical compiler supports atomic DEAL and Deal UI modernization", async () => {
  const compiler = new CanonicalCompilerClient();
  await compiler.setup();
  const inspected = await compiler.inspectCanonicalApp({ deal: DEAL, dealUi: UI, pack: PACK, packSpecifier: "./ui.pack" });
  assert.equal(inspected.valid, true, JSON.stringify(inspected.diagnostics));

  const update = inspected.deal.symbols.find((symbol) => symbol.name === "update");
  const body = inspected.deal.nodes.find((node) => node.ownerId.value === update.id.value && node.kind === "function-body");
  const changed = await compiler.applyDealChange({
    source: DEAL,
    baseDigest: inspected.deal.sourceDigest,
    operations: [{ operation: "replaceFunctionBody", targetId: body.id.value,
      body: "return {title: state.title, count: state.count + 2};" }],
  });
  assert.equal(changed.accepted, true, JSON.stringify(changed.diagnostics));
  assert.match(changed.source, /count \+ 2/);

  const structural = await compiler.applyDealChange({
    source: changed.source,
    baseDigest: changed.sourceDigest,
    operations: [{ operation: "addDeclaration", targetId: changed.inspection.moduleId.value,
      declaration: "function scoreBonus(value: int): int { return value + 10; }" }],
  });
  assert.equal(structural.accepted, true, JSON.stringify(structural.diagnostics));
  assert.match(structural.source, /scoreBonus/);

  const text = inspected.dealUi.nodes.find((node) => node.component === "ui.Text");
  const visual = await compiler.applyDealUiChange({
    deal: structural.source,
    source: UI,
    pack: PACK,
    packSpecifier: "./ui.pack",
    baseDigest: inspected.dealUi.sourceDigest,
    operations: [{ operation: "setProperty", targetId: text.id.value, property: "value", expression: '"Updated"' }],
  });
  assert.equal(visual.accepted, true, JSON.stringify(visual.diagnostics));
  assert.match(visual.source, /value: "Updated"/);

  const stale = await compiler.applyDealUiChange({
    deal: structural.source,
    source: visual.source,
    pack: PACK,
    packSpecifier: "./ui.pack",
    baseDigest: visual.sourceDigest,
    operations: [{ operation: "setProperty", targetId: text.id.value, property: "value", expression: '"Stale"' }],
  });
  assert.equal(stale.accepted, false);
  assert.equal(stale.diagnostics[0].code, "CP1003");
});
