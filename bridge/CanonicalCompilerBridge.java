package prototype;

import deal.compiler.CompilerProtocol.SemanticId;
import deal.compiler.CompilerProtocolJson;
import deal.compiler.DealCompilerWorkspace;
import deal.semantic.ir.CanonicalJson;
import deal.ui.CanonicalCompiler;
import deal.ui.UiCompilerWorkspace;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/** Process adapter for the platform-neutral transpiler API. */
public final class CanonicalCompilerBridge {
    private CanonicalCompilerBridge() {}

    public static void main(String[] args) throws Exception {
        if (args.length == 0) throw new IllegalArgumentException("Missing compiler command");
        Object response = switch (args[0]) {
            case "inspect-deal" -> inspectDeal(args);
            case "apply-deal" -> applyDeal(args);
            case "inspect-app", "compile-app" -> inspectApp(args);
            case "apply-ui" -> applyUi(args);
            default -> throw new IllegalArgumentException("Unknown compiler command: " + args[0]);
        };
        System.out.print(CompilerProtocolJson.encode(response));
    }

    private static Object inspectDeal(String[] args) throws Exception {
        requireArgs(args, 2);
        return CanonicalCompiler.inspectCanonicalApp(
                read(args[1]), minimalUi(), minimalPack(), "./platform-ui.dealui-pack").deal();
    }

    private static Object applyDeal(String[] args) throws Exception {
        requireArgs(args, 4);
        return CanonicalCompiler.applyDealChange(
                read(args[1]), args[2], dealOperations(read(args[3])));
    }

    private static Object inspectApp(String[] args) throws Exception {
        requireArgs(args, 5);
        return CanonicalCompiler.compileCanonicalApp(
                read(args[1]), read(args[2]), read(args[3]), args[4]);
    }

    private static Object applyUi(String[] args) throws Exception {
        requireArgs(args, 7);
        return CanonicalCompiler.applyDealUiChange(
                read(args[1]), read(args[2]), read(args[3]), args[4], args[5], uiOperations(read(args[6])));
    }

    private static List<DealCompilerWorkspace.Operation> dealOperations(String source) {
        CanonicalJson.Arr values = CompilerProtocolJson.requireArray(
                CompilerProtocolJson.decode(source), "DEAL operations");
        List<DealCompilerWorkspace.Operation> result = new ArrayList<>();
        for (CanonicalJson.Value value : values.items()) {
            CanonicalJson.Obj operation = CompilerProtocolJson.requireObject(value, "DEAL operation");
            String name = CompilerProtocolJson.stringField(operation, "operation");
            SemanticId target = new SemanticId(CompilerProtocolJson.stringField(operation, "targetId"));
            result.add(switch (name) {
                case DealCompilerWorkspace.ADD_DECLARATION ->
                        new DealCompilerWorkspace.AddDeclaration(
                                target, CompilerProtocolJson.stringField(operation, "declaration"));
                case DealCompilerWorkspace.REMOVE_DECLARATION ->
                        new DealCompilerWorkspace.RemoveDeclaration(target);
                case DealCompilerWorkspace.REPLACE_FUNCTION_BODY ->
                        new DealCompilerWorkspace.ReplaceFunctionBody(
                                target, CompilerProtocolJson.stringField(operation, "body"));
                case DealCompilerWorkspace.REPLACE_BLOCK_BODY ->
                        new DealCompilerWorkspace.ReplaceBlockBody(
                                target, CompilerProtocolJson.stringField(operation, "body"));
                default -> throw new IllegalArgumentException("Unsupported DEAL operation: " + name);
            });
        }
        return List.copyOf(result);
    }

    private static List<UiCompilerWorkspace.Operation> uiOperations(String source) {
        CanonicalJson.Arr values = CompilerProtocolJson.requireArray(
                CompilerProtocolJson.decode(source), "Deal UI operations");
        List<UiCompilerWorkspace.Operation> result = new ArrayList<>();
        for (CanonicalJson.Value value : values.items()) {
            CanonicalJson.Obj operation = CompilerProtocolJson.requireObject(value, "Deal UI operation");
            String name = CompilerProtocolJson.stringField(operation, "operation");
            SemanticId target = new SemanticId(CompilerProtocolJson.stringField(operation, "targetId"));
            result.add(switch (name) {
                case UiCompilerWorkspace.REPLACE_VIEW_BODY -> new UiCompilerWorkspace.ReplaceViewBody(
                        target, CompilerProtocolJson.stringField(operation, "body"));
                case UiCompilerWorkspace.REPLACE_SUBTREE -> new UiCompilerWorkspace.ReplaceSubtree(
                        target, CompilerProtocolJson.stringField(operation, "source"));
                case UiCompilerWorkspace.INSERT_CHILD -> new UiCompilerWorkspace.InsertChild(
                        target, CompilerProtocolJson.intField(operation, "index"),
                        CompilerProtocolJson.stringField(operation, "source"));
                case UiCompilerWorkspace.REMOVE_NODE -> new UiCompilerWorkspace.RemoveNode(target);
                case UiCompilerWorkspace.MOVE_NODE -> new UiCompilerWorkspace.MoveNode(
                        target,
                        new SemanticId(CompilerProtocolJson.stringField(operation, "newParentId")),
                        CompilerProtocolJson.intField(operation, "index"));
                case UiCompilerWorkspace.SET_PROPERTY -> new UiCompilerWorkspace.SetProperty(
                        target,
                        CompilerProtocolJson.stringField(operation, "property"),
                        CompilerProtocolJson.stringField(operation, "expression"));
                default -> throw new IllegalArgumentException("Unsupported Deal UI operation: " + name);
            });
        }
        return List.copyOf(result);
    }

    private static String read(String path) throws Exception {
        return Files.readString(Path.of(path));
    }

    private static void requireArgs(String[] args, int count) {
        if (args.length != count) {
            throw new IllegalArgumentException("Expected " + (count - 1) + " arguments for " + args[0]);
        }
    }

    private static String minimalUi() {
        return "import * as app from \"./app.deal\";\n"
                + "import * as ui from \"./platform-ui.dealui-pack\";\n"
                + "// @ui-root\nexport view App(state: app.AppState): View { ui.Text(value: \"\") }\n";
    }

    private static String minimalPack() {
        return "pack version \"inspect-only\";\n"
                + "export class TextProps { value: string = \"\"; }\n"
                + "export component Text(props: TextProps): View;\n";
    }
}
