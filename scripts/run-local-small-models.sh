#!/usr/bin/env bash
set -euo pipefail

run_benchmark() {
  set +e
  node src/cli.js benchmark "$@"
  status=$?
  set -e
  # Exit 1 means the benchmark completed but at least one generated program failed.
  if [[ $status -gt 1 ]]; then
    return "$status"
  fi
}

export DEAL_TEMPERATURE="${DEAL_TEMPERATURE:-0}"
export DEAL_SEED="${DEAL_SEED:-42}"
export DEAL_MODEL_TIMEOUT_MS="${DEAL_MODEL_TIMEOUT_MS:-120000}"

for model in qwen2.5-coder:0.5b qwen2.5-coder:1.5b; do
  ollama show "$model" >/dev/null
  slug=${model/:/-}
  DEAL_MODEL="$model" run_benchmark \
    --adapter ollama \
    --tasks tasks/large-tasks.json \
    --modes direct \
    --max-repairs 0 \
    --max-rounds 8 \
    --stream \
    --resume \
    --output "reports/${slug}-direct-at1-40.json"
  DEAL_MODEL="$model" run_benchmark \
    --adapter ollama \
    --tasks tasks/large-tasks.json \
    --modes semantic \
    --max-repairs 0 \
    --max-rounds 8 \
    --stream \
    --resume \
    --output "reports/${slug}-structured-at1-40.json"
done
