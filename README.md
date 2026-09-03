# Streaming Compiler

Streaming Compiler — model-agnostic prototype семантической генерации DEAL v1.2. Он сравнивает
прямую генерацию source с потоковой сборкой partial typed HIR через compiler-provided choices,
немедленно применяет допустимые choices и запускает один production compiler/runtime oracle.

Запускаемый прототип сравнивает две стратегии на одних задачах и через один production compiler/runtime oracle:

- **A — direct:** модель стримит полный DEAL v1.2 source. Поток периодически проходит через настоящий `deal.lexer.Lexer` и `deal.parser.Parser`; лексически невозможный префикс отвергается до конца ответа. Структурно завершённый префикс сразу пробуется полным штатным compiler pipeline.
- **B — semantic:** модель не пишет код, а стримит стабильные ID операций. `GenerationCompiler` по мере поступления заменяет текущий typed hole на допустимый HIR-node, немедленно отвергает неизвестный или несовместимый по типу choice и самостоятельно применяет единственный deterministic choice. После заполнения holes HIR pretty-printится в DEAL.
- В обоих случаях финальный source компилируется `deal.Main compile` в JS штатным DEAL compiler, запускается production JS artifact, а stdout сравнивается с task oracle.

Никакого игрушечного DEAL parser/typechecker в проекте нет. Небольшой Java bridge импортирует production `Lexer`/`Parser`; полная синтаксическая, name-resolution, typechecking, lowering и codegen-проверка выполняется production CLI.

## Архитектура

```text
                          ┌─ direct source deltas ─ production Lexer/Parser
Task → ModelAdapter ──────┤                         └─ early reject / compile checkpoint
                          │
                          └─ semantic choice deltas → GenerationCompiler
                                                     ├─ Partial typed HIR + holes
                                                     ├─ reject invalid choice
                                                     ├─ deterministic completion
                                                     └─ lower / pretty-print DEAL

Both paths → deal.Main compile --backend js → generated main.js → stdout oracle → metrics
```

Direct prompt загружается из `prompts/deal-v1.2-program.txt`: это canonical DEAL v1.2 language
guide, адаптированный из [`deal-llm-grammar-benchmark`](https://github.com/egavrin/deal-llm-grammar-benchmark/tree/7358eed1e66f0d8cb7b6d717b6da3076b5144d92)
для исполняемой программы с `main`. Он
описывает arrays, nullable types, loops, classes, tables и точные stdlib API. При repair модель
получает предыдущий исходник вместе с production compiler diagnostics. Версия и SHA-256 prompt
записываются в JSON report.

Основные контракты:

- `src/generation-compiler.js`: `start(task)`, `getChoices()`, `apply(choiceId)`, `isComplete()`, `finish()`.
- `src/model-adapters.js`: абстрактный `ModelAdapter`, offline `ReplayModelAdapter`, общий `OpenAICompatibleModelAdapter`, OpenRouter и локальный Ollama adapters.
- `src/deal-compiler.js`: production syntax bridge, compiler invocation и functional oracle.
- `src/runners.js`: direct/semantic streaming loops, repair и единые метрики.
- `tasks/tasks.json`: четыре репрезентативных задачи — literal, expression composition и вызовы `std/string` с несколькими типами аргументов.
- `tasks/large-tasks.json`: 40 scenario-sized программ с typed program blueprints.

Partial HIR — companion-представление, потому что production raw AST DEAL immutable и не допускает holes. Оно поддерживает expression nodes (`LiteralExpr`, `BinaryExpr`, `CallExpr`) и typed program blueprints с holes в операторах, условиях, константах, collections и statement expressions. Финальный результат обязательно принимается production parser/typechecker. Следующим шагом HIR можно перенести в сам DEAL repo и lowering делать напрямую в raw AST/semantic IR, не меняя model adapter или benchmark protocol.

## Наборы задач

Малый `tasks/tasks.json` содержит четыре быстрых вертикальных теста. Расширенный `tasks/large-tasks.json` содержит 40 программ по пять вариантов в восьми семействах:

- `physics-engine` — дискретный 1D integrator состояния;
- `collision` — 2D AABB collision detection;
- `particle-system` — обновление массива частиц и checksum;
- `tic-tac-toe` — полный поиск победителя по строкам, столбцам и диагоналям;
- `cellular-automaton` — правила рождения/выживания Game of Life;
- `grid-pathfinding` — dynamic-programming path count с препятствием;
- `inventory-economy` — line totals, subtotal и threshold discount;
- `job-scheduler` — FIFO admission в ограниченный time budget.

Программы имеют 23–30 строк и 2–7 typed semantic holes. Набор воспроизводимо генерируется командой `npm run tasks:generate`; `npm run benchmark:large` прогоняет все 80 direct/semantic результатов через production DEAL compiler и runtime oracle.

## Требования

- Node.js 20+
- JDK 25
- локальный DEAL compiler checkout. По умолчанию используется найденный в этой среде `/Users/egavrin/Documents/Codex/2026-09-02/new-chat/work/deal-reference`; для другой машины задайте `DEAL_REPO`.

Если compiler classes ещё не собраны, setup использует его `build/prod-sources.txt`. Java bridge компилируется автоматически в локальную `.cache/`.

## Быстрый offline A/B запуск

Replay adapter не оценивает качество модели — он детерминированно проверяет весь harness, streaming, production compile и functional oracle без API key.

```bash
cd streaming-compiler
DEAL_REPO=/path/to/deal npm test
DEAL_REPO=/path/to/deal npm run benchmark:replay
```

Эквивалентная явная команда:

```bash
node src/cli.js benchmark \
  --adapter replay \
  --modes direct,semantic \
  --stream \
  --deal-repo /path/to/deal \
  --output reports/replay.json
```

Для короткого live smoke можно выбрать одну или несколько задач:

```bash
node src/cli.js benchmark --adapter openrouter --task hello-literal --modes direct,semantic --stream
```

Большой suite можно запускать семействами, чтобы не упираться в rate limits бесплатного provider:

```bash
node src/cli.js benchmark \
  --adapter openrouter \
  --tasks tasks/large-tasks.json \
  --family physics-engine,tic-tac-toe \
  --modes direct,semantic \
  --stream
```

Каждый model request по умолчанию ограничен 120 секундами. Лимит настраивается через `DEAL_MODEL_TIMEOUT_MS`.
Report checkpoint перезаписывается после каждого завершённого `(task, mode)`. Если длинный live run
оборвался, повторите ту же команду с `--resume`: уже сохранённые пары будут пропущены.
OpenRouter adapter также задаёт `reasoning.effort=low`, исключает reasoning deltas из ответа и ограничивает completion 2048 токенами. Для экспериментов доступны `DEAL_REASONING_EFFORT` и `DEAL_MAX_OUTPUT_TOKENS`.
Transient ответы 429/502/503/504 повторяются до трёх раз с exponential backoff или серверным `Retry-After`; число повторов задаёт `DEAL_MODEL_RETRIES`. Эти транспортные повторы не считаются model repair iterations. Generated artifact ограничен 30 секундами выполнения; лимит настраивается через `DEAL_RUNTIME_TIMEOUT_MS`, а timeout классифицируется как functional failure.

## OpenRouter

```bash
export OPENROUTER_API_KEY='...'
export DEAL_REPO=/path/to/deal
node src/cli.js benchmark --adapter openrouter --modes direct,semantic --stream
```

Модель по умолчанию — `cohere/north-mini-code:free`. Любая OpenRouter-модель конфигурируется без изменения кода:

```bash
export DEAL_MODEL='cohere/north-mini-code:free'
export OPENROUTER_BASE_URL='https://openrouter.ai/api/v1'
export OPENROUTER_HTTP_REFERER='https://your-project.example'
```

Например, для DeepSeek V4 Flash без reasoning-токенов:

```bash
export DEAL_MODEL='deepseek/deepseek-v4-flash'
export DEAL_REASONING_EFFORT='none'
node src/cli.js benchmark \
  --adapter openrouter \
  --tasks tasks/large-tasks.json \
  --modes direct,semantic \
  --stream \
  --output reports/deepseek-v4-flash-live-40.json
```

Результаты фактического прогона от 3 сентября 2026 находятся в
`reports/deepseek-v4-flash-results.md`. Там отдельно сохранён naive direct без syntax primer,
чтобы изменение baseline было прозрачным.

Semantic mode использует streaming tool call `select_choices({choices: string[]})`. Parser аргументов извлекает каждый законченный choice ID ещё до закрытия всего JSON. Stable IDs позволяют модели предложить несколько следующих depth-first решений за один round-trip; compiler применяет longest valid prefix.

Чтобы подключить локальный Qwen/Cortex или другой endpoint, достаточно создать adapter от `OpenAICompatibleModelAdapter` с собственными `baseUrl`, `model` и key либо реализовать два async-stream метода `streamDirect()`/`streamSemantic()`. Compiler core и benchmark не зависят от провайдера.

## Локальный Ollama + Qwen

```bash
ollama pull qwen2.5-coder:0.5b
export DEAL_MODEL='qwen2.5-coder:0.5b'
export DEAL_TEMPERATURE=0
export DEAL_SEED=42
node src/cli.js benchmark \
  --adapter ollama \
  --tasks tasks/large-tasks.json \
  --modes direct,semantic \
  --stream \
  --resume \
  --output reports/qwen2.5-coder-0.5b-live-40.json
```

`OLLAMA_BASE_URL` по умолчанию равен `http://127.0.0.1:11434/v1`. Direct mode использует
OpenAI-compatible streaming endpoint. Semantic mode использует нативный `/api/chat` и передаёт
текущий список choice IDs как JSON Schema enum в `format`, чтобы decoder не мог вывести
несуществующую операцию. Local usage имеет API cost 0; wall-clock и токены измеряются так же,
как для OpenRouter.

Для чистого first-attempt benchmark без повторной генерации всей HIR trajectory:

```bash
node src/cli.js benchmark \
  --adapter ollama \
  --tasks tasks/large-tasks.json \
  --modes semantic \
  --max-repairs 0 \
  --max-rounds 8 \
  --stream
```

Полный локальный A/B для обеих загруженных малых моделей воспроизводится одной командой:

```bash
npm run benchmark:local-small
```

### Первичные локальные результаты

На 40 задачах, при temperature 0 / seed 42 и без repair, direct generation не решила ни
одной задачи у обеих моделей. Semantic generation дала 10/40 для Qwen 0.5B и 13/40 для
Qwen 1.5B; все 80 semantic programs прошли production compile. Локальный API cost равен
нулю. Semantic использует больше input tokens и round-trips, но в 4–7 раз меньше output
tokens. Полные latency percentiles, token accounting, family breakdown и protocol ablations
находятся в [`reports/local-small-model-results.md`](reports/local-small-model-results.md).

## Метрики

JSON report содержит сырые результаты по каждому `(task, mode)` и агрегацию:

- `compileAt1`, `functionalAt1` — доля первых попыток, прошедших production compile / runtime oracle;
- `syntaxFailures`, `semanticFailures`, `functionalFailures`;
- `rejectedChoices` и `rejectedPrefixes`;
- `repairIterations`, `apiRoundTrips`, `outputTokens`;
- `inputTokens`, `totalTokens`, `reasoningTokens`, `apiCostUsd` из provider usage;
- `neuralDecisionsPerSuccessfulProgram` — в semantic mode число принятых model choices; в direct baseline используется число output tokens, поскольку source tokens и есть последовательность neural decisions;
- `averageWallClockMs` — полное time-to-success;
- `averageTimeToFirstValidProgramMs` — первое время, когда полный compiler + functional oracle увидели корректную программу. В streaming direct это может быть checkpoint до закрытия HTTP stream; в semantic — момент первого успешного lowering/compile.

`compilerDecisions` отдельно показывает автоматически заполненные однозначные holes и не включается в neural decisions.

## Интерпретация

Replay report нужен как smoke baseline, не как научный результат. Для сравнения модели запускайте несколько повторов live adapter, фиксируйте model ID/provider routing и сохраняйте каждый JSON report. Free OpenRouter routing и network latency могут меняться, поэтому для уверенного сравнения нужны повторы, confidence intervals и одинаковый порядок/температура задач. Текущий prototype намеренно измеряет `@1`, а repair — отдельно, не подмешивая исправленный результат в first-attempt success.

## Ограничения прототипа

- Semantic catalog остаётся task-scoped. Большие задачи используют compiler-owned program blueprints, поэтому они проверяют constrained semantic completion сложной программы, а не генерацию всей архитектуры приложения с чистого листа.
- Prefix bridge безопасно отвергает только лексически невозможное продолжение; большинство parser EOF diagnostics считаются потенциально исправимыми дальнейшими deltas. Полный typechecker запускается на структурно завершённых checkpoints и финале.
- Production parser рассчитан на полные файлы и на некоторых незавершённых assignment-префиксах может бросить внутреннее исключение вместо diagnostics. Bridge изолирует этот случай как «пока не классифицируемый префикс»; lexer продолжает работать, а финальный production compile остаётся обязательным oracle.
- Functional oracle сейчас — точный stdout и exit code 0 на JS backend. Для более широкого suite стоит добавить generated test modules/property oracles.
- OpenRouter tool-stream shapes могут различаться по provider. Adapter поддерживает стандартные OpenAI `delta.tool_calls[].function.arguments` и fallback JSON в text content.
