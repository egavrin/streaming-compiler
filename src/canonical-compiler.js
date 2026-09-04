import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./process.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Stateless process client for the real DEAL + Deal UI transpiler entity. */
export class CanonicalCompilerClient {
  constructor({
    dealRepo = process.env.DEAL_REPO,
    dealUiRepo = process.env.DEAL_UI_REPO,
  } = {}) {
    this.dealRepo = resolve(dealRepo ?? join(ROOT, "..", "deal-reference"));
    this.dealUiRepo = resolve(dealUiRepo ?? join(ROOT, "..", "deal-ui-reference"));
    this.classes = join(ROOT, ".cache", "canonical-compiler");
  }

  async setup() {
    const bridge = join(ROOT, "bridge", "CanonicalCompilerBridge.java");
    if (!existsSync(join(this.dealRepo, "deal", "Main.java"))) {
      throw new Error(`DEAL transpiler not found at ${this.dealRepo}`);
    }
    if (!existsSync(join(this.dealUiRepo, "src", "main", "java", "deal", "ui", "UiChecker.java"))) {
      throw new Error(`Deal UI transpiler not found at ${this.dealUiRepo}`);
    }
    await rm(this.classes, { recursive: true, force: true });
    await mkdir(this.classes, { recursive: true });
    const sources = [
      ...(await sourceFiles(join(this.dealRepo, "deal"), [join(this.dealRepo, "deal", "test")])),
      ...(await sourceFiles(join(this.dealUiRepo, "src", "main", "java"))),
      join(ROOT, "java", "streaming", "compiler", "CanonicalRefinementSession.java"),
      join(ROOT, "bridge", "CanonicalRefinementSessionTest.java"),
      bridge,
    ];
    const list = join(this.classes, "sources.txt");
    await writeFile(list, sources.join("\n"));
    const compiled = await run("javac", ["--release", "25", "-proc:none", "-d", this.classes, `@${list}`], { cwd: ROOT });
    if (compiled.code !== 0) throw new Error(`failed to build canonical compiler adapter:\n${compiled.stderr}`);
  }

  async inspectDeal(source) {
    return this.#invoke("inspect-deal", { deal: source }, ["deal"]);
  }

  async applyDealChange({ source, baseDigest, operations }) {
    return this.#invoke("apply-deal", { deal: source, operations: JSON.stringify(operations) },
      ["deal", baseDigest, "operations"]);
  }

  async inspectCanonicalApp({ deal, dealUi, pack, packSpecifier }) {
    return this.#invoke("inspect-app", { deal, dealUi, pack }, ["deal", "dealUi", "pack", packSpecifier]);
  }

  async compileCanonicalApp(request) {
    return this.inspectCanonicalApp(request);
  }

  async applyDealUiChange({ deal, source, pack, packSpecifier, baseDigest, operations }) {
    return this.#invoke("apply-ui", {
      deal,
      dealUi: source,
      pack,
      operations: JSON.stringify(operations),
    }, ["deal", "dealUi", "pack", packSpecifier, baseDigest, "operations"]);
  }

  async #invoke(command, files, arguments_) {
    const directory = await mkdtemp(join(tmpdir(), "canonical-compiler-"));
    try {
      const paths = {};
      for (const [name, content] of Object.entries(files)) {
        paths[name] = join(directory, `${name}.txt`);
        await writeFile(paths[name], content);
      }
      const args = arguments_.map((value) => paths[value] ?? value);
      const result = await run("java", ["-cp", this.classes, "prototype.CanonicalCompilerBridge", command, ...args], {
        cwd: ROOT,
        timeoutMs: 30_000,
      });
      if (result.code !== 0) throw new Error(`canonical compiler ${command} failed:\n${result.stderr}`);
      return JSON.parse(result.stdout);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function sourceFiles(root, excluded = []) {
  const { readdir } = await import("node:fs/promises");
  const result = [];
  async function visit(directory) {
    if (excluded.some((value) => directory === value || directory.startsWith(`${value}/`))) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && path.endsWith(".java")) result.push(path);
    }
  }
  await visit(root);
  return result.sort();
}
