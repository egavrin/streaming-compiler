import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleModelAdapter, _test } from "../src/model-adapters.js";
import { _test as runnerTest } from "../src/runners.js";

test("direct normalization removes one outer fence regardless of language tag", () => {
  assert.equal(
    runnerTest.stripMarkdownFence("```typescript\nexport function main(): null { return null; }\n```"),
    "export function main(): null { return null; }",
  );
});

test("streaming choice parser emits complete choice strings once", () => {
  const parser = new _test.StreamingChoiceParser();
  assert.deepEqual(parser.push('{"choices":["sub'), []);
  assert.deepEqual(parser.push('string","s_streaming",'), ["substring", "s_streaming"]);
  assert.deepEqual(parser.push('"i_zero"]}'), ["i_zero"]);
});

test("single-choice parser emits one streamed enum value", () => {
  const parser = new _test.StreamingSingleChoiceParser();
  assert.deepEqual(parser.push('{"choice":"position_'), []);
  assert.deepEqual(parser.push('update"}'), ["position_update"]);
  assert.deepEqual(parser.push('{"choice":"ignored"}'), []);
});

test("SSE parser handles multiple events and retains an incomplete tail", () => {
  const parsed = _test.extractSseEvents('data: {"a":1}\n\ndata: {"b":2}\n\ndata: tail');
  assert.deepEqual(parsed.events, ['{"a":1}', '{"b":2}']);
  assert.equal(parsed.buffer, "data: tail");
});

test("OpenAI-compatible adapter exposes choices before the tool JSON is complete", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\\"choices\\\":[\\\"trim\\\","}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"\\\"s_padded\\\"]}"}}]}}],"usage":{"completion_tokens":2}}\n\n',
    "data: [DONE]\n\n",
  ];
  const adapter = new OpenAICompatibleModelAdapter({
    apiKey: "test",
    model: "test-model",
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }), { status: 200 }),
  });
  const events = [];
  for await (const event of adapter.streamSemantic({
    task: {
      prompt: "trim",
      expectedStdout: "typed",
      semantic: { catalog: [
        { id: "trim", label: "trim", resultType: "string", argumentTypes: ["string"] },
        { id: "s_padded", label: "padded", resultType: "string" },
      ] },
    },
    snapshot: {
      hir: { kind: "hole", type: "string" },
      choices: [{ id: "trim", label: "trim", resultType: "string", argumentTypes: ["string"] }],
    },
  })) events.push(event);
  assert.deepEqual(events, [
    { type: "choice", id: "trim" },
    {
      type: "usage",
      inputTokens: 0,
      outputTokens: 2,
      totalTokens: 2,
      reasoningTokens: 0,
      costUsd: 0,
    },
    { type: "choice", id: "s_padded" },
  ]);
});

test("direct adapter uses the canonical DEAL prompt and includes failed source on repair", async () => {
  let requestBody;
  const adapter = new OpenAICompatibleModelAdapter({
    apiKey: "test",
    model: "test-model",
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  for await (const _event of adapter.streamDirect({
    task: { prompt: "Add array values.", expectedStdout: "array:ok" },
    previousSource: "export function main(): null { return null; }",
    repairDiagnostics: ["E3007: bad index"],
  })) {
    // The mock stream contains no model events.
  }
  const content = requestBody.messages[0].content;
  assert.match(content, /Nested arrays are supported/);
  assert.match(content, /while \(\.\.\.\)/);
  assert.match(content, /Add array values\./);
  assert.match(content, /"array:ok"/);
  assert.match(content, /<previous_source>[\s\S]*export function main/);
  assert.match(content, /E3007: bad index/);
});
