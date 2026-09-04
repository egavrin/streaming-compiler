package streaming.compiler;

import deal.compiler.CompilerProtocolJson;
import deal.semantic.ir.CanonicalJson;
import deal.ui.CanonicalCompiler;

import java.util.List;
import java.util.Map;

/** Executable regression test for the portable LLM-facing refinement state machine. */
public final class CanonicalRefinementSessionTest {
    private static final String DEAL = """
            export class AppState { title: string = "Ready"; count: int = 0; }
            export class IncrementAction {}
            export function initialState(): AppState { return {title: "Ready", count: 0}; }
            // @ui-update
            export function update(state: AppState, action: IncrementAction): AppState {
              return {title: state.title, count: state.count + 1};
            }
            """;
    private static final String PACK = """
            pack version "test-v1";
            export class ColumnProps {}
            export class TextProps { value: string; }
            export class ButtonProps { text: string; onClick?: Action; }
            export component Column(props: ColumnProps): View { children optional; }
            export component Text(props: TextProps): View;
            export component Button(props: ButtonProps): View { event onClick; }
            """;
    private static final String UI = """
            import * as app from "./app.deal";
            import * as ui from "./ui.pack";
            // @ui-root
            export view App(state: app.AppState): View {
              ui.Column() {
                ui.Text(value: state.title)
                ui.Button(text: "Add", onClick: action app.IncrementAction {})
              }
            }
            """;

    private CanonicalRefinementSessionTest() {}

    public static void main(String[] args) {
        rejectedDealBodyNarrowsRepairAndRollsForward();
        uiOnlyChangeNeverTouchesDeal();
        System.out.println("CanonicalRefinementSessionTest: all tests passed");
    }

    private static void rejectedDealBodyNarrowsRepairAndRollsForward() {
        var inspected = CanonicalCompiler.inspectCanonicalApp(DEAL, UI, PACK, "./ui.pack");
        var update = inspected.deal().symbols().stream()
                .filter(value -> value.name().equals("update")).findFirst().orElseThrow();
        var body = inspected.deal().nodes().stream()
                .filter(value -> value.ownerId().equals(update.id()) && value.kind().equals("function-body"))
                .findFirst().orElseThrow();
        var session = new CanonicalRefinementSession(
                DEAL, UI, PACK, "./ui.pack", "Increment by two", 6, 2);
        requireTypedConstants(CompilerProtocolJson.decode(session.nextRequestJson()));
        session.acceptToolCallJson("query_deal_node", CompilerProtocolJson.encode(Map.of(
                "targetId", body.id().value())));
        String repairRequest = session.acceptToolCallJson("apply_deal_changes", operationArguments(Map.of(
                "operation", "replaceFunctionBody",
                "targetId", body.id().value(),
                "body", "return missing;"), true));
        check(repairRequest.contains("apply_deal_changes"), "repair must retain the rejected transaction tool");
        check(!repairRequest.contains("query_deal_symbol"), "repair must hide unrelated query tools");
        String result = session.acceptToolCallJson("apply_deal_changes", operationArguments(Map.of(
                "operation", "replaceFunctionBody",
                "targetId", body.id().value(),
                "body", "return {title: state.title, count: state.count + 2};"), true));
        CanonicalJson.Obj object = object(result);
        check(booleanField(object, "accepted"), "repaired canonical revision must be accepted");
        check(stringField(object, "deal").contains("count + 2"), "accepted source must contain local repair");
        check(stringField(object, "dealUi").equals(UI), "unrelated Deal UI must remain byte-identical");
    }

    private static void uiOnlyChangeNeverTouchesDeal() {
        var inspected = CanonicalCompiler.inspectCanonicalApp(DEAL, UI, PACK, "./ui.pack");
        var text = inspected.dealUi().nodes().stream()
                .filter(value -> value.component().equals("ui.Text")).findFirst().orElseThrow();
        var session = new CanonicalRefinementSession(
                DEAL, UI, PACK, "./ui.pack", "Use a static polished headline", 4, 1);
        session.acceptToolCallJson("query_deal_ui_node", CompilerProtocolJson.encode(Map.of(
                "targetId", text.id().value())));
        String result = session.acceptToolCallJson("apply_deal_ui_changes", operationArguments(Map.of(
                "operation", "setProperty",
                "targetId", text.id().value(),
                "property", "value",
                "expression", "\"Polished\""), true));
        CanonicalJson.Obj object = object(result);
        check(booleanField(object, "accepted"), "UI-only revision must be accepted");
        check(stringField(object, "deal").equals(DEAL), "UI-only revision must not touch DEAL");
        check(stringField(object, "dealUi").contains("value: \"Polished\""), "UI property must be changed");
    }

    private static String operationArguments(Map<String, Object> operation, boolean finalChange) {
        return CompilerProtocolJson.encode(Map.of("operations", List.of(operation), "final", finalChange));
    }

    private static CanonicalJson.Obj object(String source) {
        return CompilerProtocolJson.requireObject(CompilerProtocolJson.decode(source), "result");
    }

    private static String stringField(CanonicalJson.Obj object, String name) {
        return CompilerProtocolJson.stringField(object, name);
    }

    private static boolean booleanField(CanonicalJson.Obj object, String name) {
        CanonicalJson.Value value = CompilerProtocolJson.field(object, name);
        return value instanceof CanonicalJson.Bool flag && flag.value();
    }

    private static void requireTypedConstants(CanonicalJson.Value value) {
        if (value instanceof CanonicalJson.Obj object) {
            check(object.entries().stream().noneMatch(entry -> entry.key().equals("oneOf")),
                    "DeepSeek tool schemas require anyOf rather than oneOf");
            boolean hasConst = object.entries().stream().anyMatch(entry -> entry.key().equals("const"));
            boolean hasType = object.entries().stream().anyMatch(entry -> entry.key().equals("type"));
            check(!hasConst || hasType, "provider tool-schema constants require an explicit type");
            object.entries().forEach(entry -> requireTypedConstants(entry.value()));
        } else if (value instanceof CanonicalJson.Arr array) {
            array.items().forEach(CanonicalRefinementSessionTest::requireTypedConstants);
        }
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
