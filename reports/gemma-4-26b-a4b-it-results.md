# Gemma 4 26B-A4B IT: live DEAL A/B

Дата: 3 сентября 2026. Модель: `google/gemma-4-26b-a4b-it` через OpenRouter.
Streaming включён, reasoning запрошен как отключённый и фактически составил 0 токенов.
Набор: 40 задач, восемь семейств по пять вариантов. Temperature 0, seed 42,
`maxRepairs=0`: таблица сравнивает ровно первый ответ без исправлений.

Каждая программа компилируется production DEAL parser/typechecker/lowering/codegen,
запускается на JS backend и считается успешной только при exit code 0 и точном совпадении
stdout с task oracle.

## Главная сводка

| Метрика | Direct source | Semantic compiler |
|---|---:|---:|
| Успех | 25/40 (62.5%) | **40/40 (100%)** |
| compile@1 | 28/40 (70%) | **40/40 (100%)** |
| functional@1 | 25/40 (62.5%) | **40/40 (100%)** |
| Ошибки syntax / semantic / functional | 3 / 9 / 3 | **0 / 0 / 0** |
| Rejected prefixes / choices | 0 / 0 | 0 / 0 |
| Repairs | 0 | 0 |
| API round-trips | 40 | 180 |
| Input tokens | 36,820 | 84,367 |
| Output tokens | 19,484 | **1,832** |
| Total tokens | **56,304** | 86,199 |
| Reasoning tokens | 0 | 0 |
| Фактическая стоимость | $0.009569 | **$0.006665** |
| Стоимость на задачу | $0.000239 | **$0.000167** |
| Стоимость на успешную программу | $0.000383 | **$0.000167** |
| Model decisions на успешную программу | 422.08 output tokens | **4.50 choices** |
| Wall-clock mean | **7.06 s** | 8.62 s |
| Wall-clock median | **5.15 s** | 6.90 s |
| Wall-clock p95 | **14.14 s** | 23.53 s |
| Wall-clock max | 31.50 s | **26.52 s** |
| TTFV mean, successful only | **6.36 s** | 8.62 s |
| TTFV median, successful only | **5.05 s** | 6.90 s |
| TTFV p95, successful only | **12.02 s** | 23.53 s |
| Успешных программ в минуту всего run | 5.31 | **6.96** |

Semantic mode увеличил число запросов в 4.5 раза и суммарные токены в 1.53 раза из-за
повтора контекста для каждого typed hole. Однако output стал в 10.64 раза меньше, поэтому
фактическая стоимость всего semantic run оказалась на 30.3% ниже direct. Стоимость одной
успешной программы снизилась в 2.30 раза. Среднее время одной задачи выросло на 22.1%,
но throughput успешных программ стал выше из-за 100% functional success.

Semantic mode использовал `single-choice-json-schema`: на каждом шаге compiler передавал
текущие допустимые IDs как strict JSON Schema enum. Модель возвращала один ID, который
применялся к partial typed HIR немедленно при поступлении streaming delta. Ни одного
невозможного ID или незавершённого semantic trajectory не было.

## Результаты по семействам

| Семейство | Direct functional@1 | Semantic functional@1 | Direct mean | Semantic mean | Direct cost | Semantic cost |
|---|---:|---:|---:|---:|---:|---:|
| Physics engine | 2/5 | **5/5** | 8.87 s | **7.58 s** | **$0.000840** | $0.001031 |
| AABB collision | 5/5 | 5/5 | **7.21 s** | 18.37 s | $0.001236 | **$0.000957** |
| Particle system | 2/5 | **5/5** | **5.49 s** | 9.39 s | **$0.000848** | $0.001141 |
| Tic-tac-toe | 1/5 | **5/5** | 7.90 s | **5.47 s** | $0.001469 | **$0.000744** |
| Cellular automaton | 5/5 | 5/5 | **3.52 s** | 7.99 s | $0.000752 | **$0.000608** |
| Grid pathfinding | 2/5 | **5/5** | 14.44 s | **3.84 s** | $0.002475 | **$0.000378** |
| Inventory economy | 4/5 | **5/5** | **4.65 s** | 11.08 s | $0.001036 | **$0.000901** |
| Job scheduler | 4/5 | **5/5** | **4.38 s** | 5.24 s | $0.000912 | **$0.000904** |

Наиболее крупный выигрыш semantic path виден на grid pathfinding: success 2/5 → 5/5,
mean latency 14.44 → 3.84 секунды, стоимость семейства снизилась примерно в 6.5 раза.
На collision и inventory semantic был медленнее из-за provider/network latency отдельных
последовательных запросов, хотя остался функционально идеальным.

## Сопоставление с предыдущим DeepSeek V4 Flash

| Модель и режим | Protocol / repairs | compile@1 | functional@1 | Итоговый success |
|---|---|---:|---:|---:|
| DeepSeek canonical direct | full source / до 2 repairs | 85% | 47.5% | 65% |
| DeepSeek semantic | batched trajectory / 0 repairs | 100% | 100% | 100% |
| Gemma direct | full source / 0 repairs | 70% | **62.5%** | 62.5% |
| Gemma semantic | strict stepwise enum / 0 repairs | 100% | 100% | 100% |

Gemma лучше DeepSeek по direct functional@1 в этих одиночных прогонах, но DeepSeek direct
report разрешал repairs и поэтому его aggregate latency/tokens/cost нельзя напрямую
сравнивать с чистым Gemma @1. Semantic у обеих моделей достиг 40/40. DeepSeek смог вернуть
всю trajectory одним batched вызовом на задачу; Gemma здесь намеренно запускалась через
более строгий, но более медленный stepwise enum protocol.

## Ограничения

- Это один live run с одним seed; OpenRouter routing и нагрузка провайдеров меняют latency.
- Semantic suite использует compiler-owned blueprints с 2–7 typed holes. Это constrained
  completion сложных программ, а не построение произвольного приложения с чистого листа.
- Direct и semantic получили одну и ту же задачу и ожидаемый stdout, но semantic дополнительно
  получает compiler-owned partial HIR и допустимые локальные операции — это и есть исследуемое
  вмешательство, а не равный prompt-only baseline.
- Цена взята из фактического usage каждого ответа. Она устойчивее предварительной оценки по
  публичному прайсу, поскольку OpenRouter мог маршрутизировать запросы между провайдерами.

Сырой отчёт: `gemma-4-26b-a4b-it-at1-40.json`. Отдельный one-task smoke report не включён
в приведённые числа.
