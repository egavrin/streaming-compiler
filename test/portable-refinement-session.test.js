import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { CanonicalCompilerClient } from "../src/canonical-compiler.js";

test("portable streaming-compiler session owns scoped iterative repair", async () => {
  const compiler = new CanonicalCompilerClient();
  await compiler.setup();
  const result = await runJava(compiler.classes, "streaming.compiler.CanonicalRefinementSessionTest");
  assert.match(result, /all tests passed/);
});

function runJava(classpath, main) {
  return new Promise((resolve, reject) => {
    const child = spawn("java", ["-ea", "-cp", classpath, main], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `java exited ${code}`)));
  });
}
