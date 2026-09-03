# Local small-model A/B results

Дата прогона: 3 сентября 2026. Это первичный single-seed замер, а не статистически
устойчивый leaderboard.

## Условия

| Параметр | Значение |
|---|---|
| Компьютер | Apple M4 Pro, arm64, 24 GiB unified memory |
| Runtime | Ollama 0.21.1, локально |
| Модели | `qwen2.5-coder:0.5b` (397 MB), `qwen2.5-coder:1.5b` (986 MB) |
| Sampling | temperature 0, seed 42 |
| DEAL | production compiler commit `917c298764728f5021e7dfbb40f8a08958f2333f` |
| Suite | 40 задач, 8 семейств по 5 вариантов |
| Попытки | ровно одна, без repair (`maxRepairs=0`) |
| Streaming | включён в обоих режимах |
| Semantic protocol | один choice на запрос, constrained JSON Schema enum |
| Functional oracle | production JS artifact, exit code 0 и точное совпадение stdout |
| Денежная стоимость | $0 API cost; электричество и стоимость железа не учитывались |

## Главное сравнение

| Модель | Режим | compile@1 | functional@1 | Успехов | Ошибки syntax / semantic / functional | API-вызовов | Input / output / всего токенов | Среднее / p50 / p95 время задачи | Среднее TTFV успешных | Успешных программ/мин | Токенов на успех |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Qwen 0.5B | direct | 12.5% | 0% | 0/40 | 26 / 9 / 5 | 40 | 34,073 / 7,033 / 41,106 | 0.99 / 0.91 / 1.70 s | — | 0 | — |
| Qwen 0.5B | semantic | **100%** | **25.0%** | **10/40** | 0 / 0 / 30 | 180 | 75,774 / 1,608 / 77,382 | 2.45 / 1.01 / 2.72 s | 0.88 s | 6.13 | 7,738 |
| Qwen 1.5B | direct | 0% | 0% | 0/40 | 34 / 6 / 0 | 40 | 34,073 / 11,803 / 45,876 | 2.33 / 2.11 / 3.74 s | — | 0 | — |
| Qwen 1.5B | semantic | **100%** | **32.5%** | **13/40** | 0 / 0 / 27 | 180 | 75,952 / 1,610 / 77,562 | 2.85 / 1.45 / 3.59 s | 1.24 s | 6.83 | 5,966 |

В semantic режиме обе модели сделали в среднем 4.5 model calls на программу. Среди
успешных программ среднее число собственно model choices было 4.10 у 0.5B и 3.92 у
1.5B; deterministic compiler choices в это число не входят. Rejected choices — 0:
Ollama применял JSON Schema enum прямо при декодировании, поэтому невозможные ID не
доходили до `GenerationCompiler`.

Semantic режим потребовал примерно в 1.7–1.9 раза больше суммарных токенов, потому что
каждый typed hole создаёт отдельный запрос с повтором контекста. При этом output упал в
4.4 раза для 0.5B и в 7.3 раза для 1.5B: модель возвращала короткие choice IDs, а не
исходный код. Главный текущий overhead — input context и round-trips, а не генерация.

Среднее время выше медианы из-за двух программ `particle-system`, которые выбрали
не завершающийся цикл и дошли до 30-секундного runtime timeout. Поэтому p50 и p95 лучше
описывают обычную интерактивную задержку этого локального прогона, а среднее честно
включает цену таких функциональных зависаний.

## Functional@1 по семействам

Во всех direct ячейках — 0/5. Semantic результаты:

| Семейство | Qwen 0.5B | Qwen 1.5B |
|---|---:|---:|
| Physics engine 1D | 0/5 | 0/5 |
| AABB collision | 3/5 | 4/5 |
| Particle system | 0/5 | 0/5 |
| Tic-tac-toe | 0/5 | 1/5 |
| Cellular automaton | 3/5 | 3/5 |
| Grid pathfinding | 2/5 | 3/5 |
| Inventory economy | 2/5 | 2/5 |
| Job scheduler | 0/5 | 0/5 |

Это показывает границу прототипа: typed choices полностью снимают grammar/type errors,
но не гарантируют правильный алгоритмический выбор. Следующая оптимизация должна быть не
ещё одним repair loop, а batching нескольких constrained choices за запрос и более
информативное состояние/локальные проверки инвариантов.

## Что показали отброшенные варианты протокола

| Модель | Semantic protocol | Repairs | Functional success | API-вызовов | Среднее время |
|---|---|---:|---:|---:|---:|
| Qwen 0.5B | batched tool trajectory | до 2 | 2/40 | 875 | 6.11 s |
| Qwen 1.5B | batched tool trajectory | до 2 | 9/40 | 353 | 10.33 s |
| Qwen 1.5B | stepwise tool enum | до 2 | 5/40 | 808 | 11.49 s |
| Qwen 0.5B | constrained native enum | 0 | 10/40 | 180 | 2.45 s |
| Qwen 1.5B | constrained native enum | 0 | 13/40 | 180 | 2.85 s |

Обычный tool schema у этих маленьких моделей не оказался жёстким ограничителем: модель
возвращала лишние ID, compiler их отвергал, а полный repair перезапускал trajectory. Нативный
structured-output enum устранил runaway. Незавершённый 0.5B repair-run на 14/40 сохранён
как диагностический артефакт, но не включён в основную таблицу.

## Воспроизведение

```bash
ollama pull qwen2.5-coder:0.5b
ollama pull qwen2.5-coder:1.5b
export DEAL_REPO=/path/to/deal
npm test
npm run benchmark:local-small
```

Команда поддерживает checkpoints и `--resume`; уже завершённые `(task, mode)` повторно
не запускаются. Сырые per-task источники, diagnostics, usage и timings находятся в четырёх
`*-at1-40.json` reports рядом с этим файлом.
