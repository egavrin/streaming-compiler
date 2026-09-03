# DeepSeek V4 Flash: live DEAL A/B

Дата: 3 сентября 2026. Модель: `deepseek/deepseek-v4-flash` через OpenRouter. Streaming включён,
reasoning был запрошен как отключённый. Набор: 40 заранее зафиксированных программ, восемь семейств по пять задач.
Каждая итоговая программа проходит production DEAL parser/typechecker/lowering/codegen, затем
запускается на JS backend; success требует exit code 0 и точного stdout-oracle.

## Главная сводка

| Метрика | Naive direct | Informed direct | Canonical direct | Semantic compiler |
|---|---:|---:|---:|---:|
| Успех после разрешённых repairs | 0/40 (0%) | 18/40 (45%) | 26/40 (65%) | 40/40 (100%) |
| compile@1 | 0/40 (0%) | 3/40 (7,5%) | 34/40 (85%) | 40/40 (100%) |
| functional@1 | 0/40 (0%) | 2/40 (5%) | 19/40 (47,5%) | 40/40 (100%) |
| Ошибки попыток: syntax / semantic / functional | 119 / 1 / 0 | 27 / 48 / 13 | 0 / 12 / 40 | 0 / 0 / 0 |
| Repair iterations | 80 | 66 | 38 | 0 |
| API round-trips | 120 | 106 | 78 | 40 |
| Input tokens | 27 144 | 59 232 | 81 233 | 38 802 |
| Output tokens | 27 006 | 31 209 | 24 758 | 2 855 |
| Total tokens | 54 150 | 90 441 | 105 991 | 41 657 |
| Reasoning tokens reported | 0 | 0 | 748 | 0 |
| Фактическая стоимость OpenRouter | $0,010345 | $0,013496 | $0,012331 | $0,003520 |
| Стоимость на входную задачу | $0,000259 | $0,000337 | $0,000308 | $0,000088 |
| Стоимость на успешную программу | — | $0,000750 | $0,000474 | $0,000088 |
| Neural decisions на успешную программу | — | 594,94 | 426,42 | 4,50 |
| Wall-clock mean | 22,12 с | 28,87 с | 8,84 с | 2,20 с |
| Wall-clock median | 16,30 с | 17,85 с | 8,47 с | 2,09 с |
| Wall-clock p95 | 64,22 с | 107,35 с | 16,12 с | 3,62 с |
| Wall-clock max | 94,51 с | 146,90 с | 18,25 с | 4,08 с |
| Time-to-first-valid median (только successes) | — | 16,17 с | 4,78 с | 2,09 с |
| Time-to-first-valid p95 (только successes) | — | 44,11 с | 13,10 с | 3,62 с |

Основной baseline для сравнения — **canonical direct**. Он использует полный DEAL v1.2 guide из
grammar-benchmark, адаптированный для `main`, включая arrays, nullable values, loops, classes,
tables и точные stdlib API. Версия: `deal-v1.2-canonical-program-v1`; SHA-256:
`c74a892f5d6d30b13c5b1617af2b49e49be09891b9dcc0d6778b1432feb9bb16`.

Naive и informed direct сохранены как история калибровки prompt. В частности, informed prompt
ошибочно запрещал поддерживаемые DEAL arrays и `while`, поэтому занижал direct baseline.

Относительно canonical direct semantic mode:

- повысил итоговый success с 65% до 100%, а functional@1 — с 47,5% до 100%;
- сократил средний wall-clock в 4,01 раза, median в 4,05 раза, p95 в 4,45 раза;
- потребовал в 1,95 раза меньше API round-trips и в 8,67 раза меньше output tokens;
- стоил в 3,50 раза меньше на задачу и в 5,39 раза меньше на успешную программу;
- сократил model decisions на успешную программу примерно в 94,8 раза.

Canonical prompt полностью устранил syntax failures. Оставшийся разрыв связан с типами и
поведением, а не с незнанием surface syntax.

Для исторического informed direct semantic mode показывал более крупный разрыв:

- повысил итоговый success с 45% до 100%, а functional@1 — с 5% до 100%;
- сократил средний wall-clock в 13,1 раза, median в 8,5 раза, p95 в 29,7 раза;
- потребовал в 2,65 раза меньше API round-trips и в 10,9 раза меньше output tokens;
- стоил в 3,83 раза меньше на задачу и в 8,52 раза меньше на успешную программу;
- сократил model decisions на успешную программу примерно в 132 раза.

## По семействам: основной canonical baseline

| Семейство | Canonical direct success | Semantic success | Direct functional@1 | Semantic functional@1 | Direct mean | Semantic mean |
|---|---:|---:|---:|---:|---:|---:|
| Physics engine | 3/5 | 5/5 | 1/5 | 5/5 | 13,93 с | 2,61 с |
| AABB collision | 3/5 | 5/5 | 3/5 | 5/5 | 8,04 с | 2,74 с |
| Particle system | 5/5 | 5/5 | 4/5 | 5/5 | 5,62 с | 2,15 с |
| Tic-tac-toe | 1/5 | 5/5 | 0/5 | 5/5 | 13,66 с | 1,45 с |
| Cellular automaton | 5/5 | 5/5 | 5/5 | 5/5 | 4,49 с | 2,10 с |
| Grid pathfinding | 1/5 | 5/5 | 1/5 | 5/5 | 12,41 с | 2,05 с |
| Inventory/economy | 4/5 | 5/5 | 2/5 | 5/5 | 6,90 с | 1,97 с |
| Job scheduler | 4/5 | 5/5 | 3/5 | 5/5 | 5,68 с | 2,58 с |

## По семействам: исторический informed baseline

| Семейство | Informed direct success | Semantic success | Direct mean | Semantic mean | Direct cost | Semantic cost |
|---|---:|---:|---:|---:|---:|---:|
| Physics engine | 3/5 | 5/5 | 15,59 с | 2,61 с | $0,001332 | $0,000369 |
| AABB collision | 4/5 | 5/5 | 16,21 с | 2,74 с | $0,001370 | $0,000478 |
| Particle system | 4/5 | 5/5 | 20,57 с | 2,15 с | $0,001196 | $0,000609 |
| Tic-tac-toe | 1/5 | 5/5 | 61,93 с | 1,45 с | $0,002763 | $0,000439 |
| Cellular automaton | 2/5 | 5/5 | 41,84 с | 2,10 с | $0,001505 | $0,000394 |
| Grid pathfinding | 2/5 | 5/5 | 19,57 с | 2,05 с | $0,002245 | $0,000408 |
| Inventory/economy | 1/5 | 5/5 | 40,15 с | 1,97 с | $0,001392 | $0,000403 |
| Job scheduler | 1/5 | 5/5 | 15,06 с | 2,58 с | $0,001693 | $0,000422 |

## Как читать ошибки

`syntaxFailures`, `semanticFailures` и `functionalFailures` — число неудачных **попыток**, а не
уникальных задач, поэтому их сумма может быть больше 40. Canonical direct имел ноль syntax
failures, но 14 задач остались неуспешными после лимита в два repair. Основные причины: неверное
вычисленное состояние или пропущенный success marker; три задачи завершились type errors в
nullable assignment, сложении массивов и сравнении boolean с int. Semantic compiler не позволял
модели породить несовместимые по типам продолжения.

## Ограничения

- Это один live run без confidence intervals; routing/нагрузка OpenRouter способны менять latency.
- Несмотря на `DEAL_REASONING_EFFORT=none`, provider сообщил 748 reasoning tokens для canonical
  direct. В отчёте сохранён фактический usage; это показывает, что параметр не был строго соблюдён
  на каждом routed request.
- Semantic задачи используют compiler-owned program blueprints с 2–7 holes. Результат доказывает
  эффективность constrained completion внутри данного пространства решений, но не полную
  генерацию произвольного приложения с нуля.
- Functional oracle — end-to-end запуск и точный ожидаемый маркер stdout. Программы сами проверяют
  вычисленное состояние перед печатью маркера; это сценарные тесты, не исчерпывающий property-based
  test suite полноценного физического движка или игры.
- `compile@1` и `functional@1` относятся только к первой попытке; общий success включает до двух repairs.

Сырые отчёты:

- `deepseek-v4-flash-live-40.json`: naive direct и semantic, 40 задач каждого режима;
- `deepseek-v4-flash-informed-direct-live-40.json`: informed direct, 40 задач;
- `deepseek-v4-flash-canonical-direct-live-40.json`: основной canonical direct, 40 задач;
- smoke-файлы сохранены отдельно и не включены в приведённые агрегаты.
