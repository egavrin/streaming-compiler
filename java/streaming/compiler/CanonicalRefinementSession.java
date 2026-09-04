package streaming.compiler;

import deal.compiler.CompilerProtocol.RepairScope;
import deal.compiler.CompilerProtocol.SemanticId;
import deal.compiler.CompilerProtocol.StructuredDiagnostic;
import deal.compiler.CompilerProtocolJson;
import deal.compiler.DealCompilerWorkspace;
import deal.semantic.ir.CanonicalJson;
import deal.ui.CanonicalCompiler;
import deal.ui.UiCompilerWorkspace;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Provider-neutral LLM-facing refinement session owned by streaming-compiler. */
public final class CanonicalRefinementSession {
    private static final String SYSTEM_PROMPT = """
            You modernize one existing canonical DEAL application through compiler-issued tools.
            DEAL owns state and behavior. Deal UI owns declarative presentation. Query only the
            symbol or node needed for the requested change, then submit one small atomic transaction.
            Never regenerate an unrelated unit. Compiler diagnostics, semantic IDs and writable
            repair scopes are authoritative. Use no scenario templates. Set final to false only when
            another behavior or visual transaction is required. Emit exactly one tool call.
            """.strip();

    private final String previousDeal;
    private final String previousDealUi;
    private final String pack;
    private final String packSpecifier;
    private final String instruction;
    private final List<Map<String, Object>> transcript = new ArrayList<>();
    private String deal;
    private String dealUi;
    private CanonicalCompiler.Inspection inspection;
    private List<RepairScope> repairScopes = List.of();
    private String forcedArtifact = "";
    private Status status = Status.REQUEST;
    private int rounds;
    private int semanticRepairs;
    private final int maxRounds;
    private final int maxSemanticRepairs;

    public CanonicalRefinementSession(
            String deal,
            String dealUi,
            String pack,
            String packSpecifier,
            String instruction,
            int maxRounds,
            int maxSemanticRepairs) {
        if (instruction == null || instruction.isBlank()) {
            throw new IllegalArgumentException("Refinement instruction is empty");
        }
        this.previousDeal = deal;
        this.previousDealUi = dealUi;
        this.deal = deal;
        this.dealUi = dealUi;
        this.pack = pack;
        this.packSpecifier = packSpecifier;
        this.instruction = instruction;
        this.maxRounds = maxRounds;
        this.maxSemanticRepairs = maxSemanticRepairs;
        this.inspection = CanonicalCompiler.inspectCanonicalApp(deal, dealUi, pack, packSpecifier);
        if (!inspection.valid()) {
            throw new IllegalArgumentException("Cannot refine an invalid canonical application");
        }
    }

    public String nextRequestJson() {
        if (status != Status.REQUEST) return resultJson();
        if (rounds >= maxRounds) {
            fail("SC1001", "Refinement round budget exhausted");
            return resultJson();
        }
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("status", "request");
        request.put("instructions", SYSTEM_PROMPT);
        request.put("input", input());
        request.put("tools", tools());
        request.put("round", rounds + 1);
        request.put("semanticRepairs", semanticRepairs);
        return CompilerProtocolJson.encode(request);
    }

    public String acceptToolCallJson(String name, String argumentsJson) {
        if (status != Status.REQUEST) throw new IllegalStateException("Refinement session is not requesting a tool");
        rounds++;
        CanonicalJson.Obj arguments = CompilerProtocolJson.requireObject(
                CompilerProtocolJson.decode(argumentsJson), "tool arguments");
        switch (name) {
            case "query_deal_symbol" -> queryDealSymbol(string(arguments, "targetId"));
            case "query_deal_node" -> queryDealNode(string(arguments, "targetId"));
            case "query_deal_ui_node" -> queryDealUiNode(string(arguments, "targetId"));
            case "apply_deal_changes" -> applyDeal(arguments);
            case "apply_deal_ui_changes" -> applyDealUi(arguments);
            case "unchanged" -> unchanged();
            default -> throw new IllegalArgumentException("Unsupported streaming-compiler tool: " + name);
        }
        return status == Status.REQUEST ? nextRequestJson() : resultJson();
    }

    public String resultJson() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("status", status.name().toLowerCase());
        result.put("accepted", status == Status.COMPLETE);
        result.put("changed", !deal.equals(previousDeal) || !dealUi.equals(previousDealUi));
        result.put("deal", status == Status.COMPLETE ? deal : previousDeal);
        result.put("dealUi", status == Status.COMPLETE ? dealUi : previousDealUi);
        result.put("rounds", rounds);
        result.put("semanticRepairs", semanticRepairs);
        result.put("inspection", inspection);
        result.put("transcript", transcript);
        return CompilerProtocolJson.encode(result);
    }

    private String input() {
        Map<String, Object> context = new LinkedHashMap<>();
        context.put("request", instruction);
        context.put("deal", Map.of(
                "sourceDigest", inspection.deal().sourceDigest(),
                "moduleId", inspection.deal().moduleId(),
                "appInterface", inspection.deal().appInterface(),
                "symbols", inspection.deal().symbols(),
                "nodes", inspection.deal().nodes()));
        if (inspection.dealUi() != null) {
            context.put("dealUi", Map.of(
                    "sourceDigest", inspection.dealUi().sourceDigest(),
                    "appInterfaceFingerprint", inspection.dealUi().appInterfaceFingerprint(),
                    "views", inspection.dealUi().views(),
                    "nodes", inspection.dealUi().nodes()));
        }
        context.put("packVersion", inspection.packVersion());
        context.put("packDigest", inspection.packDigest());
        context.put("previousToolResults", transcript);
        if (!repairScopes.isEmpty()) context.put("repairScopes", repairScopes);
        if (!forcedArtifact.isEmpty()) context.put("requiredArtifact", forcedArtifact);
        return CompilerProtocolJson.encode(context);
    }

    private List<Map<String, Object>> tools() {
        List<Map<String, Object>> result = new ArrayList<>();
        boolean repairing = !repairScopes.isEmpty();
        if (!repairing && !forcedArtifact.equals("dealui")) {
            result.add(tool("query_deal_symbol", "Read one DEAL declaration and dependency summary.",
                    objectSchema(Map.of("targetId", enumSchema(inspection.deal().symbols().stream()
                            .map(value -> value.id().value()).toList())))));
            result.add(tool("query_deal_node", "Read one DEAL function or block body.",
                    objectSchema(Map.of("targetId", enumSchema(inspection.deal().nodes().stream()
                            .map(value -> value.id().value()).toList())))));
        }
        if (!repairing && !forcedArtifact.equals("deal") && inspection.dealUi() != null) {
            result.add(tool("query_deal_ui_node", "Read one Deal UI subtree and its bindings.",
                    objectSchema(Map.of("targetId", enumSchema(inspection.dealUi().nodes().stream()
                            .map(value -> value.id().value()).toList())))));
        }
        List<Map<String, Object>> dealOperations = dealOperationSchemas();
        if (!dealOperations.isEmpty()) {
            result.add(transactionTool("apply_deal_changes", "Apply one atomic DEAL ChangeSet.", dealOperations));
        }
        List<Map<String, Object>> uiOperations = dealUiOperationSchemas();
        if (!uiOperations.isEmpty()) {
            result.add(transactionTool("apply_deal_ui_changes", "Apply one atomic Deal UI ChangeSet.", uiOperations));
        }
        if (!repairing && forcedArtifact.isEmpty()) {
            result.add(tool("unchanged", "The requested change is already present or needs no source edit.",
                    objectSchema(Map.of("reason", Map.of("type", "string")))));
        }
        return List.copyOf(result);
    }

    private List<Map<String, Object>> dealOperationSchemas() {
        if (forcedArtifact.equals("dealui")) return List.of();
        List<Map<String, Object>> operations = new ArrayList<>();
        addIfAllowed(operations, DealCompilerWorkspace.ADD_DECLARATION, inspection.deal().moduleId(),
                Map.of("declaration", Map.of("type", "string")));
        inspection.deal().symbols().forEach(symbol -> addIfAllowed(
                operations, DealCompilerWorkspace.REMOVE_DECLARATION, symbol.id(), Map.of()));
        inspection.deal().nodes().forEach(node -> addIfAllowed(
                operations,
                node.kind().equals("function-body")
                        ? DealCompilerWorkspace.REPLACE_FUNCTION_BODY
                        : DealCompilerWorkspace.REPLACE_BLOCK_BODY,
                node.id(),
                Map.of("body", Map.of("type", "string"))));
        return operations;
    }

    private List<Map<String, Object>> dealUiOperationSchemas() {
        if (forcedArtifact.equals("deal") || inspection.dealUi() == null) return List.of();
        List<Map<String, Object>> operations = new ArrayList<>();
        inspection.dealUi().views().forEach(view -> addIfAllowed(
                operations, UiCompilerWorkspace.REPLACE_VIEW_BODY, view.id(),
                Map.of("body", Map.of("type", "string"))));
        inspection.dealUi().nodes().forEach(node -> {
            addIfAllowed(operations, UiCompilerWorkspace.REPLACE_SUBTREE, node.id(),
                    Map.of("source", Map.of("type", "string")));
            addIfAllowed(operations, UiCompilerWorkspace.REMOVE_NODE, node.id(), Map.of());
            addIfAllowed(operations, UiCompilerWorkspace.INSERT_CHILD, node.id(), Map.of(
                    "index", Map.of("type", "integer", "minimum", 0, "maximum", node.children().size()),
                    "source", Map.of("type", "string")));
            node.properties().keySet().forEach(property -> addIfAllowed(
                    operations, UiCompilerWorkspace.SET_PROPERTY, node.id(), Map.of(
                            "property", constantString(property),
                            "expression", Map.of("type", "string"))));
        });
        return operations;
    }

    private void addIfAllowed(
            List<Map<String, Object>> target,
            String operation,
            SemanticId id,
            Map<String, Object> extra) {
        if (!repairScopes.isEmpty() && repairScopes.stream().noneMatch(scope ->
                scope.operation().equals(operation) && scope.ownerId().equals(id))) return;
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("operation", constantString(operation));
        properties.put("targetId", constantString(id.value()));
        properties.putAll(extra);
        target.add(objectSchema(properties));
    }

    private void queryDealSymbol(String id) {
        var symbol = inspection.deal().symbols().stream()
                .filter(value -> value.id().value().equals(id)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Unknown DEAL symbol " + id));
        addTranscript("query_deal_symbol", Map.of(
                "symbol", symbol,
                "source", sourceRange(deal, symbol.range())));
    }

    private void queryDealNode(String id) {
        var node = inspection.deal().nodes().stream()
                .filter(value -> value.id().value().equals(id)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Unknown DEAL node " + id));
        addTranscript("query_deal_node", Map.of(
                "node", node,
                "source", sourceRange(deal, node.range())));
    }

    private void queryDealUiNode(String id) {
        if (inspection.dealUi() == null) throw new IllegalStateException("Deal UI inspection is unavailable");
        var node = inspection.dealUi().nodes().stream()
                .filter(value -> value.id().value().equals(id)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Unknown Deal UI node " + id));
        addTranscript("query_deal_ui_node", Map.of(
                "node", node,
                "source", sourceRange(dealUi, node.range())));
    }

    private void applyDeal(CanonicalJson.Obj arguments) {
        List<DealCompilerWorkspace.Operation> operations = dealOperations(field(arguments, "operations"));
        boolean finalChange = booleanField(arguments, "final");
        var result = CanonicalCompiler.applyDealChange(deal, inspection.deal().sourceDigest(), operations);
        if (!result.accepted()) {
            reject("apply_deal_changes", result.diagnostics(), "deal");
            return;
        }
        deal = result.source();
        repairScopes = List.of();
        forcedArtifact = result.impact().interfaceChanged() ? "dealui" : "";
        inspection = CanonicalCompiler.inspectCanonicalApp(deal, dealUi, pack, packSpecifier);
        addTranscript("apply_deal_changes", Map.of("accepted", true, "impact", result.impact()));
        if (inspection.valid() && finalChange && forcedArtifact.isEmpty()) status = Status.COMPLETE;
    }

    private void applyDealUi(CanonicalJson.Obj arguments) {
        if (inspection.dealUi() == null) throw new IllegalStateException("Deal UI inspection is unavailable");
        List<UiCompilerWorkspace.Operation> operations = dealUiOperations(field(arguments, "operations"));
        boolean finalChange = booleanField(arguments, "final");
        var result = CanonicalCompiler.applyDealUiChange(
                deal, dealUi, pack, packSpecifier, inspection.dealUi().sourceDigest(), operations);
        if (!result.accepted()) {
            reject("apply_deal_ui_changes", result.diagnostics(), "dealui");
            return;
        }
        dealUi = result.source();
        repairScopes = List.of();
        forcedArtifact = "";
        inspection = CanonicalCompiler.compileCanonicalApp(deal, dealUi, pack, packSpecifier);
        addTranscript("apply_deal_ui_changes", Map.of("accepted", true, "impact", result.impact()));
        if (inspection.valid() && finalChange) status = Status.COMPLETE;
    }

    private void reject(String tool, List<StructuredDiagnostic> diagnostics, String artifact) {
        semanticRepairs++;
        addTranscript(tool, Map.of("accepted", false, "diagnostics", diagnostics));
        if (semanticRepairs > maxSemanticRepairs) {
            status = Status.FAILED;
            deal = previousDeal;
            dealUi = previousDealUi;
            return;
        }
        repairScopes = diagnostics.stream().flatMap(value -> value.repairScopes().stream()).toList();
        forcedArtifact = artifact;
    }

    private void unchanged() {
        if (!forcedArtifact.isEmpty() || !repairScopes.isEmpty()) {
            throw new IllegalArgumentException("unchanged is unavailable while a compiler repair is required");
        }
        status = Status.COMPLETE;
    }

    private void fail(String code, String message) {
        addTranscript("streaming_compiler", Map.of("code", code, "message", message));
        status = Status.FAILED;
        deal = previousDeal;
        dealUi = previousDealUi;
    }

    private void addTranscript(String tool, Map<String, Object> value) {
        transcript.add(Map.of("tool", tool, "result", value));
    }

    private static List<DealCompilerWorkspace.Operation> dealOperations(CanonicalJson.Value value) {
        List<DealCompilerWorkspace.Operation> result = new ArrayList<>();
        for (CanonicalJson.Value item : CompilerProtocolJson.requireArray(value, "DEAL operations").items()) {
            CanonicalJson.Obj operation = CompilerProtocolJson.requireObject(item, "DEAL operation");
            String name = string(operation, "operation");
            SemanticId target = new SemanticId(string(operation, "targetId"));
            result.add(switch (name) {
                case DealCompilerWorkspace.ADD_DECLARATION -> new DealCompilerWorkspace.AddDeclaration(
                        target, string(operation, "declaration"));
                case DealCompilerWorkspace.REMOVE_DECLARATION -> new DealCompilerWorkspace.RemoveDeclaration(target);
                case DealCompilerWorkspace.REPLACE_FUNCTION_BODY -> new DealCompilerWorkspace.ReplaceFunctionBody(
                        target, string(operation, "body"));
                case DealCompilerWorkspace.REPLACE_BLOCK_BODY -> new DealCompilerWorkspace.ReplaceBlockBody(
                        target, string(operation, "body"));
                default -> throw new IllegalArgumentException("Unsupported DEAL operation " + name);
            });
        }
        return result;
    }

    private static List<UiCompilerWorkspace.Operation> dealUiOperations(CanonicalJson.Value value) {
        List<UiCompilerWorkspace.Operation> result = new ArrayList<>();
        for (CanonicalJson.Value item : CompilerProtocolJson.requireArray(value, "Deal UI operations").items()) {
            CanonicalJson.Obj operation = CompilerProtocolJson.requireObject(item, "Deal UI operation");
            String name = string(operation, "operation");
            SemanticId target = new SemanticId(string(operation, "targetId"));
            result.add(switch (name) {
                case UiCompilerWorkspace.REPLACE_VIEW_BODY -> new UiCompilerWorkspace.ReplaceViewBody(
                        target, string(operation, "body"));
                case UiCompilerWorkspace.REPLACE_SUBTREE -> new UiCompilerWorkspace.ReplaceSubtree(
                        target, string(operation, "source"));
                case UiCompilerWorkspace.INSERT_CHILD -> new UiCompilerWorkspace.InsertChild(
                        target, integer(operation, "index"), string(operation, "source"));
                case UiCompilerWorkspace.REMOVE_NODE -> new UiCompilerWorkspace.RemoveNode(target);
                case UiCompilerWorkspace.MOVE_NODE -> new UiCompilerWorkspace.MoveNode(
                        target, new SemanticId(string(operation, "newParentId")), integer(operation, "index"));
                case UiCompilerWorkspace.SET_PROPERTY -> new UiCompilerWorkspace.SetProperty(
                        target, string(operation, "property"), string(operation, "expression"));
                default -> throw new IllegalArgumentException("Unsupported Deal UI operation " + name);
            });
        }
        return result;
    }

    private static Map<String, Object> transactionTool(
            String name, String description, List<Map<String, Object>> variants) {
        return tool(name, description, objectSchema(Map.of(
                "operations", Map.of("type", "array", "minItems", 1, "items", Map.of("anyOf", variants)),
                "final", Map.of("type", "boolean"))));
    }

    private static Map<String, Object> tool(String name, String description, Map<String, Object> parameters) {
        return Map.of("name", name, "description", description, "parameters", parameters, "strict", true);
    }

    private static Map<String, Object> objectSchema(Map<String, Object> properties) {
        return Map.of(
                "type", "object",
                "properties", properties,
                "required", List.copyOf(properties.keySet()),
                "additionalProperties", false);
    }

    private static Map<String, Object> enumSchema(List<String> values) {
        return Map.of("type", "string", "enum", values);
    }

    private static Map<String, Object> constantString(String value) {
        return Map.of("type", "string", "const", value);
    }

    private static CanonicalJson.Value field(CanonicalJson.Obj object, String name) {
        return CompilerProtocolJson.field(object, name);
    }

    private static String string(CanonicalJson.Obj object, String name) {
        return CompilerProtocolJson.stringField(object, name);
    }

    private static int integer(CanonicalJson.Obj object, String name) {
        return CompilerProtocolJson.intField(object, name);
    }

    private static boolean booleanField(CanonicalJson.Obj object, String name) {
        CanonicalJson.Value value = field(object, name);
        if (value instanceof CanonicalJson.Bool flag) return flag.value();
        throw new IllegalArgumentException("Protocol field '" + name + "' must be a boolean");
    }

    private static String sourceRange(
            String source, deal.compiler.CompilerProtocol.SourceRange range) {
        if (range == null) return "";
        String[] lines = source.split("\\n", -1);
        int first = Math.max(0, range.startLine() - 1);
        int last = Math.min(lines.length - 1, range.endLine() - 1);
        if (first > last) return "";
        List<String> selected = new ArrayList<>();
        for (int line = first; line <= last; line++) selected.add(lines[line]);
        selected.set(0, scalarSlice(selected.get(0), range.startColumn() - 1, Integer.MAX_VALUE));
        int end = first == last
                ? range.endColumn() - range.startColumn() + 1
                : range.endColumn();
        int finalIndex = selected.size() - 1;
        selected.set(finalIndex, scalarSlice(selected.get(finalIndex), 0, end));
        return String.join("\n", selected);
    }

    private static String scalarSlice(String value, int start, int end) {
        int count = value.codePointCount(0, value.length());
        int boundedStart = Math.max(0, Math.min(start, count));
        int boundedEnd = Math.max(boundedStart, Math.min(end, count));
        int startOffset = value.offsetByCodePoints(0, boundedStart);
        int endOffset = value.offsetByCodePoints(0, boundedEnd);
        return value.substring(startOffset, endOffset);
    }

    private enum Status { REQUEST, COMPLETE, FAILED }
}
