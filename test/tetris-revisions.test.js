import test from "node:test";
import assert from "node:assert/strict";
import { CanonicalCompilerClient } from "../src/canonical-compiler.js";

const PACK = `pack version "tetris-test-v1";
export class ColumnProps {}
export class RowProps {}
export class TextProps { value: string; tone?: string; }
export class ButtonProps { text: string; onClick?: Action; }
export class GridProps { columns: int; }
export class CellProps { filled: boolean; tone?: string; }
export component Column(props: ColumnProps): View { children optional; }
export component Row(props: RowProps): View { children optional; }
export component Text(props: TextProps): View;
export component Button(props: ButtonProps): View { event onClick; }
export component Grid(props: GridProps): View { children required Cell; }
export component Cell(props: CellProps): View;
`;

const BASE_DEAL = `export class Cell { id: int = 0; filled: boolean = false; }
export class AppState {
  cells: Cell[] = [];
  playerX: int = 4;
  paused: boolean = false;
  tick: int = 0;
}
export class MoveAction { dx: int = 0; }
export function initialState(): AppState {
  return {cells: [], playerX: 4, paused: false, tick: 0};
}
// @ui-update
export function move(state: AppState, action: MoveAction): AppState {
  return {cells: state.cells, playerX: state.playerX + action.dx, paused: state.paused, tick: state.tick};
}
`;

const BASE_UI = `import * as app from "./app.deal";
import * as ui from "./ui.pack";
// @ui-root
export view App(state: app.AppState): View {
  ui.Column() {
    ui.Text(value: "Tetris")
    ui.Grid(columns: 10) {
      ForEach(state.cells, cell: app.Cell, key: cell.id) {
        ui.Cell(filled: cell.filled)
      }
    }
    ui.Row() {
      ui.Button(text: "Left", onClick: action app.MoveAction {dx: -1})
      ui.Button(text: "Right", onClick: action app.MoveAction {dx: 1})
    }
  }
}
`;

test("Tetris evolves through six compiler-owned revisions with rollback and state reset", async () => {
  const compiler = new CanonicalCompilerClient();
  await compiler.setup();
  let deal = BASE_DEAL;
  let dealUi = BASE_UI;
  let inspection = await inspect(compiler, deal, dealUi);
  const revisions = [{ phase: "base board", deal, dealUi }];

  // Revision 2: movement helper and a local body replacement in one transaction.
  let move = symbol(inspection, "move");
  let moveBody = functionBody(inspection, move);
  let result = await compiler.applyDealChange({
    source: deal,
    baseDigest: inspection.deal.sourceDigest,
    operations: [
      { operation: "addDeclaration", targetId: inspection.deal.moduleId.value,
        declaration: "function clampX(value: int): int { if (value < 0) { return 0; } if (value > 9) { return 9; } return value; }" },
      { operation: "replaceFunctionBody", targetId: moveBody.id.value,
        body: "return {cells: state.cells, playerX: clampX(state.playerX + action.dx), paused: state.paused, tick: state.tick};" },
    ],
  });
  assert.equal(result.accepted, true, JSON.stringify(result.diagnostics));
  deal = result.source;
  inspection = await inspect(compiler, deal, dealUi);
  revisions.push({ phase: "movement", deal, dealUi });

  // An intentionally bad revision must not disturb the runnable source.
  move = symbol(inspection, "move");
  moveBody = functionBody(inspection, move);
  const rejected = await compiler.applyDealChange({
    source: deal,
    baseDigest: inspection.deal.sourceDigest,
    operations: [{ operation: "replaceFunctionBody", targetId: moveBody.id.value, body: "return missing;" }],
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.source, deal, "failed modernization must roll back byte-for-byte");

  // Revision 3: timer/pause behavior changes the public interface, then UI binds it locally.
  result = await compiler.applyDealChange({
    source: deal,
    baseDigest: inspection.deal.sourceDigest,
    operations: [
      { operation: "addDeclaration", targetId: inspection.deal.moduleId.value,
        declaration: "export class PauseAction {}" },
      { operation: "addDeclaration", targetId: inspection.deal.moduleId.value,
        declaration: `// @ui-update
export function togglePause(state: AppState, action: PauseAction): AppState {
  return {cells: state.cells, playerX: state.playerX, paused: !state.paused, tick: state.tick};
}` },
    ],
  });
  assert.equal(result.accepted, true, JSON.stringify(result.diagnostics));
  deal = result.source;
  let incompatible = await compiler.inspectCanonicalApp({ deal, dealUi, pack: PACK, packSpecifier: "./ui.pack" });
  assert.equal(incompatible.valid, false, "new public action must invalidate old UI until bound");
  const row = incompatible.dealUi.nodes.find((value) => value.component === "ui.Row");
  const uiResult = await compiler.applyDealUiChange({
    deal,
    source: dealUi,
    pack: PACK,
    packSpecifier: "./ui.pack",
    baseDigest: incompatible.dealUi.sourceDigest,
    operations: [{ operation: "insertChild", targetId: row.id.value, index: row.children.length,
      source: 'ui.Button(text: "Pause", onClick: action app.PauseAction {})' }],
  });
  assert.equal(uiResult.accepted, true, JSON.stringify(uiResult.diagnostics));
  dealUi = uiResult.source;
  inspection = await inspect(compiler, deal, dealUi);
  revisions.push({ phase: "timer and pause", deal, dealUi });

  // Revision 4: collision logic adds one private unit and changes only movement.
  move = symbol(inspection, "move");
  moveBody = functionBody(inspection, move);
  result = await compiler.applyDealChange({
    source: deal,
    baseDigest: inspection.deal.sourceDigest,
    operations: [
      { operation: "addDeclaration", targetId: inspection.deal.moduleId.value,
        declaration: "function canMove(state: AppState, x: int): boolean { return x >= 0 && x <= 9; }" },
      { operation: "replaceFunctionBody", targetId: moveBody.id.value,
        body: `let next: int = state.playerX + action.dx;
if (!canMove(state, next)) { return state; }
return {cells: state.cells, playerX: next, paused: state.paused, tick: state.tick};` },
    ],
  });
  assert.equal(result.accepted, true, JSON.stringify(result.diagnostics));
  deal = result.source;
  inspection = await inspect(compiler, deal, dealUi);
  revisions.push({ phase: "collision", deal, dealUi });

  // Revision 5: scoring changes the root schema and therefore requires a fresh runtime state.
  const appState = symbol(inspection, "AppState");
  const initial = symbol(inspection, "initialState");
  move = symbol(inspection, "move");
  const pause = symbol(inspection, "togglePause");
  result = await compiler.applyDealChange({
    source: deal,
    baseDigest: inspection.deal.sourceDigest,
    operations: [
      { operation: "removeDeclaration", targetId: appState.id.value },
      { operation: "addDeclaration", targetId: inspection.deal.moduleId.value,
        declaration: `export class AppState {
  cells: Cell[] = [];
  playerX: int = 4;
  paused: boolean = false;
  tick: int = 0;
  score: int = 0;
}` },
      { operation: "replaceFunctionBody", targetId: functionBody(inspection, initial).id.value,
        body: "return {cells: [], playerX: 4, paused: false, tick: 0, score: 0};" },
      { operation: "replaceFunctionBody", targetId: functionBody(inspection, move).id.value,
        body: `let next: int = state.playerX + action.dx;
if (!canMove(state, next)) { return state; }
return {cells: state.cells, playerX: next, paused: state.paused, tick: state.tick, score: state.score};` },
      { operation: "replaceFunctionBody", targetId: functionBody(inspection, pause).id.value,
        body: "return {cells: state.cells, playerX: state.playerX, paused: !state.paused, tick: state.tick, score: state.score};" },
    ],
  });
  assert.equal(result.accepted, true, JSON.stringify(result.diagnostics));
  assert.equal(result.impact.stateResetRequired, true);
  deal = result.source;
  inspection = await inspect(compiler, deal, dealUi);
  revisions.push({ phase: "row clearing and scoring schema", deal, dealUi });

  // Revision 6: presentation-only refinement leaves DEAL byte-identical.
  const title = inspection.dealUi.nodes.find((value) => value.component === "ui.Text");
  const styled = await compiler.applyDealUiChange({
    deal,
    source: dealUi,
    pack: PACK,
    packSpecifier: "./ui.pack",
    baseDigest: inspection.dealUi.sourceDigest,
    operations: [{ operation: "setProperty", targetId: title.id.value,
      property: "tone", expression: '"accent"' }],
  });
  // tone was absent, so compiler correctly requires subtree replacement instead of an ad-hoc insertion.
  assert.equal(styled.accepted, false);
  const refined = await compiler.applyDealUiChange({
    deal,
    source: dealUi,
    pack: PACK,
    packSpecifier: "./ui.pack",
    baseDigest: inspection.dealUi.sourceDigest,
    operations: [{ operation: "replaceSubtree", targetId: title.id.value,
      source: 'ui.Text(value: "Tetris", tone: "accent")' }],
  });
  assert.equal(refined.accepted, true, JSON.stringify(refined.diagnostics));
  dealUi = refined.source;
  inspection = await inspect(compiler, deal, dealUi);
  revisions.push({ phase: "visual refinement", deal, dealUi });

  assert.equal(revisions.length, 6);
  const restored = await inspect(compiler, revisions.at(-1).deal, revisions.at(-1).dealUi);
  assert.equal(restored.deal.sourceDigest, inspection.deal.sourceDigest);
  assert.equal(restored.dealUi.sourceDigest, inspection.dealUi.sourceDigest);
});

async function inspect(compiler, deal, dealUi) {
  const result = await compiler.inspectCanonicalApp({ deal, dealUi, pack: PACK, packSpecifier: "./ui.pack" });
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  return result;
}

function symbol(inspection, name) {
  return inspection.deal.symbols.find((value) => value.name === name)
    ?? assert.fail(`missing symbol ${name}`);
}

function functionBody(inspection, owner) {
  return inspection.deal.nodes.find((value) => value.ownerId.value === owner.id.value && value.kind === "function-body")
    ?? assert.fail(`missing function body for ${owner.name}`);
}
