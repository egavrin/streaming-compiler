import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, { cwd, input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, signal, stdout, stderr, timedOut });
    });
    child.stdin.end(input ?? "");
  });
}

function diagnosticsFrom(text) {
  return [...text.matchAll(/\b(E\d{4})\b[^\n]*/g)].map((match) => match[0]);
}

function classifyFailure(diagnostics) {
  if (diagnostics.some((line) => /\bE1\d{3}\b/.test(line))) return "syntax";
  if (diagnostics.some((line) => /\bE[2345]\d{3}\b/.test(line))) return "semantic";
  return "compiler";
}

export class DealCompilerAdapter {
  constructor({ dealRepo = process.env.DEAL_REPO } = {}) {
    this.dealRepo = resolve(dealRepo ?? "/Users/egavrin/Documents/Codex/2026-09-02/new-chat/work/deal-reference");
    this.buildDir = join(this.dealRepo, "build");
    this.bridgeDir = join(PROJECT_ROOT, ".cache", "bridge");
    this.runtimeTimeoutMs = Number(process.env.DEAL_RUNTIME_TIMEOUT_MS ?? 30_000);
  }

  async setup() {
    if (!existsSync(join(this.dealRepo, "deal", "Main.java"))) {
      throw new Error(`DEAL compiler not found at ${this.dealRepo}; set DEAL_REPO`);
    }
    if (!existsSync(join(this.buildDir, "deal", "Main.class"))) {
      const built = await run("javac", ["--release", "25", "-proc:none", "-d", this.buildDir, `@${join(this.buildDir, "prod-sources.txt")}`], { cwd: this.dealRepo });
      if (built.code !== 0) throw new Error(`failed to build DEAL compiler:\n${built.stderr}`);
    }
    const bridgeClass = join(this.bridgeDir, "prototype", "DealSyntaxBridge.class");
    const bridgeSource = join(PROJECT_ROOT, "bridge", "DealSyntaxBridge.java");
    if (!existsSync(bridgeClass) || (await readFile(bridgeSource)).length === 0) {
      await mkdir(this.bridgeDir, { recursive: true });
    }
    await mkdir(this.bridgeDir, { recursive: true });
    const compiled = await run("javac", ["--release", "25", "-cp", this.buildDir, "-d", this.bridgeDir, bridgeSource], { cwd: PROJECT_ROOT });
    if (compiled.code !== 0) throw new Error(`failed to build syntax bridge:\n${compiled.stderr}`);
  }

  async inspectPrefix(source) {
    const result = await run("java", ["-cp", `${this.buildDir}:${this.bridgeDir}`, "prototype.DealSyntaxBridge"], {
      cwd: this.dealRepo,
      input: source,
      timeoutMs: 20_000,
    });
    if (result.code !== 0) throw new Error(`DEAL syntax bridge failed: ${result.stderr}`);
    const lines = result.stdout.trim().split("\n");
    const diagnostics = lines.filter((line) => line.startsWith("diagnostic=")).map((line) => {
      const [phase, code, start, end, message] = line.slice("diagnostic=".length).split("\t");
      return { phase, code, start: Number(start), end: Number(end), message };
    });
    const scalarLength = [...source].length;
    const impossible = diagnostics.some((diagnostic) => {
      if (diagnostic.phase === "lex") {
        const eofIncomplete = ["E1003", "E1004", "E1042"].includes(diagnostic.code)
          && diagnostic.end >= scalarLength;
        return !eofIncomplete;
      }
      return false;
    });
    return {
      lexErrors: Number(lines.find((line) => line.startsWith("lexErrors="))?.split("=")[1] ?? 0),
      parseErrors: Number(lines.find((line) => line.startsWith("parseErrors="))?.split("=")[1] ?? 0),
      parserCrashed: lines.includes("parserCrashed=1"),
      diagnostics,
      impossible,
    };
  }

  async compileAndRun(source, expectedStdout, { keep = false } = {}) {
    const projectDir = await realpath(await mkdtemp(join(tmpdir(), "deal-generation-")));
    const sourceDir = join(projectDir, "src");
    const outputDir = join(projectDir, "build", "js");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(projectDir, "deal.json"), JSON.stringify({
      languageVersion: "1.2",
      backend: "js",
      moduleRoots: ["src"],
    }));
    await writeFile(join(sourceDir, "main.deal"), source);
    const compiled = await run("java", ["-cp", this.buildDir, "deal.Main", "compile", join(sourceDir, "main.deal"), "--backend", "js", "--output", outputDir], {
      cwd: this.dealRepo,
    });
    const diagnostics = diagnosticsFrom(`${compiled.stdout}\n${compiled.stderr}`);
    if (compiled.code !== 0) {
      if (!keep) await rm(projectDir, { recursive: true, force: true });
      return { compileSuccess: false, functionalSuccess: false, failureKind: classifyFailure(diagnostics), diagnostics };
    }
    const executed = await run("node", [join(outputDir, "main.js")], {
      cwd: outputDir,
      timeoutMs: this.runtimeTimeoutMs,
    });
    const functionalSuccess = executed.code === 0 && executed.stdout.trimEnd() === expectedStdout;
    const result = {
      compileSuccess: true,
      functionalSuccess,
      failureKind: functionalSuccess ? null : "functional",
      diagnostics: functionalSuccess ? [] : [executed.timedOut
        ? `runtime exceeded ${this.runtimeTimeoutMs}ms`
        : `expected stdout ${JSON.stringify(expectedStdout)}, got ${JSON.stringify(executed.stdout.trimEnd())}; stderr=${JSON.stringify(executed.stderr.trimEnd())}`],
      stdout: executed.stdout.trimEnd(),
      projectDir: keep ? projectDir : undefined,
    };
    if (!keep) await rm(projectDir, { recursive: true, force: true });
    return result;
  }
}
