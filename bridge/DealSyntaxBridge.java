package prototype;

import deal.diagnostics.CompilerDiagnostic;
import deal.lexer.LexResult;
import deal.lexer.Lexer;
import deal.parser.ParseResult;
import deal.parser.Parser;
import deal.semantic.ir.SemanticProfile;

import java.nio.charset.StandardCharsets;
import java.util.List;

/** Tiny process boundary over the production DEAL lexer/parser APIs. */
public final class DealSyntaxBridge {
    private DealSyntaxBridge() {}

    public static void main(String[] args) throws Exception {
        String source = new String(System.in.readAllBytes(), StandardCharsets.UTF_8);
        String file = "<stream>.deal";
        LexResult lexed = new Lexer(source, file).tokenize();
        System.out.println("lexErrors=" + errorCount(lexed.diagnostics()));
        for (CompilerDiagnostic diagnostic : lexed.diagnostics()) print("lex", diagnostic);
        try {
            ParseResult parsed = new Parser(lexed.tokens(), file,
                SemanticProfile.DEAL_V1_2_INT32, lexed.directiveEvents()).parse();
            System.out.println("parseErrors=" + errorCount(parsed.diagnostics()));
            System.out.println("parserCrashed=0");
            for (CompilerDiagnostic diagnostic : parsed.diagnostics()) print("parse", diagnostic);
        } catch (RuntimeException exception) {
            // The production parser is designed for complete files and a few
            // incomplete assignment prefixes currently hit an internal null
            // node. Prefix inspection must remain conservative: the final
            // production compile is still authoritative.
            System.out.println("parseErrors=0");
            System.out.println("parserCrashed=1");
        }
    }

    private static long errorCount(List<CompilerDiagnostic> diagnostics) {
        return diagnostics.stream().filter(d -> d.severity().equals("error")).count();
    }

    private static void print(String phase, CompilerDiagnostic diagnostic) {
        String message = diagnostic.message().replace("\\", "\\\\")
            .replace("\t", "\\t").replace("\r", "\\r").replace("\n", "\\n");
        System.out.println("diagnostic=" + phase + "\t" + diagnostic.code() + "\t"
            + diagnostic.range().startScalarOffset() + "\t"
            + diagnostic.range().endScalarOffset() + "\t" + message);
    }
}
