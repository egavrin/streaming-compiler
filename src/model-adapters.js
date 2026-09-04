import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const DIRECT_PROMPT_TEMPLATE = readFileSync(
  new URL("../prompts/deal-v1.2-program.txt", import.meta.url),
  "utf8",
);

export const DIRECT_PROMPT_VERSION = "deal-v1.2-canonical-program-v1";
export const DIRECT_PROMPT_SHA256 = createHash("sha256")
  .update(DIRECT_PROMPT_TEMPLATE)
  .digest("hex");

function estimateTokens(text) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function extractSseEvents(buffer) {
  const events = [];
  let boundary;
  while ((boundary = buffer.indexOf("\n\n")) !== -1) {
    const block = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    const data = block.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) events.push(data);
  }
  return { events, buffer };
}

class StreamingChoiceParser {
  constructor() {
    this.buffer = "";
    this.emitted = 0;
  }

  push(delta) {
    this.buffer += delta;
    const marker = this.buffer.indexOf('"choices"');
    if (marker === -1) return [];
    const start = this.buffer.indexOf("[", marker);
    if (start === -1) return [];
    const fragment = this.buffer.slice(start + 1);
    const values = [];
    const pattern = /"((?:\\.|[^"\\])*)"/g;
    let match;
    while ((match = pattern.exec(fragment))) {
      try {
        values.push(JSON.parse(`"${match[1]}"`));
      } catch {
        // A split escape sequence is incomplete and will be retried next delta.
      }
    }
    const unseen = values.slice(this.emitted);
    this.emitted = values.length;
    return unseen;
  }
}

class StreamingSingleChoiceParser {
  constructor() {
    this.buffer = "";
    this.emitted = false;
  }

  push(delta) {
    if (this.emitted) return [];
    this.buffer += delta;
    const match = this.buffer.match(/"choice"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (!match) return [];
    try {
      this.emitted = true;
      return [JSON.parse(`"${match[1]}"`)];
    } catch {
      return [];
    }
  }
}

export class ModelAdapter {
  async *streamDirect(_request) {
    throw new Error("streamDirect is not implemented");
  }

  async *streamSemantic(_request) {
    throw new Error("streamSemantic is not implemented");
  }
}

export class ReplayModelAdapter extends ModelAdapter {
  constructor({ chunkSize = 13 } = {}) {
    super();
    this.chunkSize = chunkSize;
  }

  async *streamDirect({ task }) {
    const text = task.replay.directSource;
    for (let offset = 0; offset < text.length; offset += this.chunkSize) {
      yield { type: "text", delta: text.slice(offset, offset + this.chunkSize) };
    }
    yield { type: "usage", outputTokens: estimateTokens(text) };
  }

  async *streamSemantic({ task }) {
    const choices = task.replay.semanticChoices;
    for (const choice of choices) yield { type: "choice", id: choice };
    yield { type: "usage", outputTokens: choices.length };
  }
}

/** OpenAI chat-completions compatible streaming adapter. */
export class OpenAICompatibleModelAdapter extends ModelAdapter {
  constructor({
    apiKey,
    baseUrl = "https://openrouter.ai/api/v1",
    model,
    headers = {},
    fetchImpl = fetch,
    requestTimeoutMs = Number(process.env.DEAL_MODEL_TIMEOUT_MS ?? 120_000),
    maxOutputTokens = Number(process.env.DEAL_MAX_OUTPUT_TOKENS ?? 2048),
    reasoningEffort = process.env.DEAL_REASONING_EFFORT,
    temperature = Number(process.env.DEAL_TEMPERATURE ?? 0),
    seed = Number(process.env.DEAL_SEED ?? 42),
    transientRetries = Number(process.env.DEAL_MODEL_RETRIES ?? 3),
    semanticProtocol = process.env.DEAL_SEMANTIC_PROTOCOL ?? "batched-trajectory",
  }) {
    super();
    if (!apiKey) throw new Error("an API key is required");
    if (!model) throw new Error("a model is required");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    this.headers = headers;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxOutputTokens = maxOutputTokens;
    this.reasoningEffort = reasoningEffort;
    this.temperature = temperature;
    this.seed = seed;
    this.transientRetries = transientRetries;
    this.semanticProtocol = semanticProtocol;
  }

  async *streamDirect({ task, repairDiagnostics = [], previousSource = "" }) {
    const repair = repairDiagnostics.length
      ? `\nThe previous source was:\n<previous_source>\n${previousSource}\n</previous_source>\nCompiler diagnostics:\n${repairDiagnostics.join("\n")}\nReturn a corrected complete program.`
      : "";
    const prompt = DIRECT_PROMPT_TEMPLATE
      .replace("{task}", task.prompt)
      .replace("{expectedStdout}", JSON.stringify(task.expectedStdout));
    const messages = [{
      role: "user",
      content: `${prompt}${repair}`,
    }];
    yield* this._stream({ messages });
  }

  async *streamSemantic({ task, snapshot, repairDiagnostics = [] }) {
    if (this.semanticProtocol === "single-choice-json-schema") {
      const choices = snapshot.choices.map((choice) =>
        `${JSON.stringify(choice.id)}: ${choice.label}; returns ${choice.resultType}`
      ).join("\n");
      const repair = repairDiagnostics.length
        ? `\nPrevious attempt failed: ${repairDiagnostics.join("; ")}`
        : "";
      const messages = [{
        role: "user",
        content: `Select exactly one compiler operation for the current typed hole. Do not write code.\nTask: ${task.prompt}\nCurrent partial HIR: ${JSON.stringify(snapshot.hir)}\nAllowed choices:\n${choices}\nReturn one allowed ID.${repair}`,
      }];
      const schema = {
        type: "object",
        properties: {
          choice: { type: "string", enum: snapshot.choices.map((choice) => choice.id) },
        },
        required: ["choice"],
        additionalProperties: false,
      };
      const parser = new StreamingSingleChoiceParser();
      for await (const event of this._stream({
        messages,
        response_format: {
          type: "json_schema",
          json_schema: { name: "select_choice", strict: true, schema },
        },
      })) {
        if (event.type === "text") {
          for (const id of parser.push(event.delta)) yield { type: "choice", id };
        } else {
          yield event;
        }
      }
      return;
    }
    const choices = snapshot.choices.map((choice) =>
      `${JSON.stringify(choice.id)}: ${choice.label}; ${choice.resultType} <- (${choice.argumentTypes.join(", ")})`
    ).join("\n");
    const catalog = task.semantic.catalog.map((choice) =>
      `${JSON.stringify(choice.id)}: ${choice.label}; ${choice.resultType} <- (${(choice.argumentTypes ?? []).join(", ")})`
    ).join("\n");
    const repair = repairDiagnostics.length ? `\nPrevious finished program failed: ${repairDiagnostics.join("; ")}` : "";
    const messages = [{
      role: "user",
      content: `You are selecting typed semantic operations, not writing code.\nTask: ${task.prompt}\nExpected stdout: ${JSON.stringify(task.expectedStdout)}.\nCurrent partial HIR: ${JSON.stringify(snapshot.hir)}\nCurrent valid choices:\n${choices}\nFull stable-ID catalog for anticipated child holes:\n${catalog}\nCall select_choices with a depth-first trajectory. The compiler accepts its longest valid prefix.${repair}`,
    }];
    const tools = [{
      type: "function",
      function: {
        name: "select_choices",
        description: "Select a depth-first trajectory of compiler-provided semantic choice IDs.",
        parameters: {
          type: "object",
          properties: { choices: { type: "array", items: { type: "string" } } },
          required: ["choices"],
          additionalProperties: false,
        },
      },
    }];
    const parser = new StreamingChoiceParser();
    for await (const event of this._stream({ messages, tools, tool_choice: { type: "function", function: { name: "select_choices" } } })) {
      if (event.type === "tool_arguments") {
        for (const id of parser.push(event.delta)) yield { type: "choice", id };
      } else if (event.type === "text") {
        for (const id of parser.push(event.delta)) yield { type: "choice", id };
      } else {
        yield event;
      }
    }
  }

  async completeTool({ messages, tools, toolChoice = "required" }) {
    let name = "";
    let argumentsText = "";
    let usage = null;
    for await (const event of this._stream({ messages, tools, tool_choice: toolChoice })) {
      if (event.type === "tool_name") name = event.name;
      else if (event.type === "tool_arguments") argumentsText += event.delta;
      else if (event.type === "usage") usage = event;
    }
    if (!name) throw new Error("model response contained no tool name");
    let args;
    try {
      args = JSON.parse(argumentsText);
    } catch (error) {
      const failure = new Error(`model returned malformed tool arguments for ${name}: ${error.message}`);
      failure.kind = "transport";
      failure.toolName = name;
      failure.argumentsText = argumentsText;
      throw failure;
    }
    return { name, args, usage };
  }

  async *_stream(body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(
      `model request exceeded ${this.requestTimeoutMs}ms`,
    )), this.requestTimeoutMs);
    try {
      const requestBody = JSON.stringify({
        model: this.model,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: this.maxOutputTokens,
        temperature: this.temperature,
        seed: this.seed,
        ...(this.reasoningEffort
          ? { reasoning: { effort: this.reasoningEffort, exclude: true } }
          : {}),
        ...body,
      });
      let response;
      for (let attempt = 0; ; attempt++) {
        response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
            ...this.headers,
          },
          body: requestBody,
          signal: controller.signal,
        });
        const transient = [429, 502, 503, 504].includes(response.status);
        if (!transient || attempt >= this.transientRetries) break;
        await response.body?.cancel();
        const retryAfter = Number(response.headers.get("retry-after"));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(8_000, 1_000 * (2 ** attempt));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (!response.ok) throw new Error(`model API ${response.status}: ${await response.text()}`);
      if (!response.body) throw new Error("model API returned no response body");
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
        const parsed = extractSseEvents(buffer);
        buffer = parsed.buffer;
        for (const data of parsed.events) {
          if (data === "[DONE]") return;
          const payload = JSON.parse(data);
          if (payload.usage?.completion_tokens != null) {
            yield {
              type: "usage",
              inputTokens: payload.usage.prompt_tokens ?? 0,
              outputTokens: payload.usage.completion_tokens,
              totalTokens: payload.usage.total_tokens
                ?? ((payload.usage.prompt_tokens ?? 0) + payload.usage.completion_tokens),
              reasoningTokens: payload.usage.completion_tokens_details?.reasoning_tokens ?? 0,
              costUsd: Number(payload.usage.cost ?? 0),
            };
          }
          for (const choice of payload.choices ?? []) {
            const delta = choice.delta ?? {};
            if (delta.content) yield { type: "text", delta: delta.content };
            for (const toolCall of delta.tool_calls ?? []) {
              if (toolCall.function?.name) {
                yield { type: "tool_name", name: toolCall.function.name };
              }
              if (toolCall.function?.arguments) {
                yield { type: "tool_arguments", delta: toolCall.function.arguments };
              }
            }
          }
        }
      }
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
}

export class OpenRouterNorthAdapter extends OpenAICompatibleModelAdapter {
  constructor({
    apiKey = process.env.OPENROUTER_API_KEY,
    model = process.env.DEAL_MODEL ?? "cohere/north-mini-code:free",
    baseUrl = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    fetchImpl,
  } = {}) {
    super({
      apiKey,
      model,
      baseUrl,
      fetchImpl,
      reasoningEffort: process.env.DEAL_REASONING_EFFORT ?? "low",
      headers: {
        ...(process.env.OPENROUTER_HTTP_REFERER ? { "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER } : {}),
        "X-Title": "DEAL semantic generation benchmark",
      },
    });
  }
}

export class OllamaAdapter extends OpenAICompatibleModelAdapter {
  constructor({
    model = process.env.DEAL_MODEL ?? "qwen2.5-coder:0.5b",
    baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1",
    nativeBaseUrl = process.env.OLLAMA_NATIVE_BASE_URL ?? "http://127.0.0.1:11434",
    fetchImpl,
  } = {}) {
    super({
      apiKey: "ollama",
      model,
      baseUrl,
      fetchImpl,
      reasoningEffort: undefined,
      transientRetries: 0,
    });
    this.nativeBaseUrl = nativeBaseUrl.replace(/\/$/, "");
    this.semanticProtocol = "single-choice-json-schema";
  }

  async *streamSemantic({ task, snapshot, repairDiagnostics = [] }) {
    const choices = snapshot.choices.map((choice) =>
      `${JSON.stringify(choice.id)}: ${choice.label}; returns ${choice.resultType}`
    ).join("\n");
    const repair = repairDiagnostics.length
      ? `\nPrevious attempt failed: ${repairDiagnostics.join("; ")}`
      : "";
    const messages = [{
      role: "user",
      content: `Select exactly one compiler operation for the current typed hole. Do not write code.\nTask: ${task.prompt}\nCurrent partial HIR: ${JSON.stringify(snapshot.hir)}\nAllowed choices:\n${choices}\nCall select_choice with one allowed ID.${repair}`,
    }];
    const ids = snapshot.choices.map((choice) => choice.id);
    const schema = {
      type: "object",
      properties: { choice: { type: "string", enum: ids } },
      required: ["choice"],
      additionalProperties: false,
    };
    const parser = new StreamingSingleChoiceParser();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(
      `model request exceeded ${this.requestTimeoutMs}ms`,
    )), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.nativeBaseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          format: schema,
          options: {
            temperature: this.temperature,
            seed: this.seed,
            num_predict: 64,
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Ollama API ${response.status}: ${await response.text()}`);
      if (!response.body) throw new Error("Ollama API returned no response body");
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 1);
          if (!line) continue;
          const payload = JSON.parse(line);
          const delta = payload.message?.content;
          if (delta) {
            for (const id of parser.push(delta)) yield { type: "choice", id };
          }
          if (payload.done) {
            const inputTokens = payload.prompt_eval_count ?? 0;
            const outputTokens = payload.eval_count ?? 0;
            yield {
              type: "usage",
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
              reasoningTokens: 0,
              costUsd: 0,
            };
          }
        }
      }
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
}

export const _test = { extractSseEvents, StreamingChoiceParser, StreamingSingleChoiceParser };
