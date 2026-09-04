# Streaming Compiler Repository Guidance

## Product Boundary

This repository owns the LLM-facing compiler orchestration layer. DEAL and Deal UI remain separate
platform-neutral transpilers and semantic checkers. Streaming-compiler calls their versioned,
stateless inspect/edit/compile APIs; it does not reimplement their parsers, type systems,
AppInterface extraction, source projection or diagnostics.

Streaming-compiler owns:

- provider-neutral model requests and streaming response parsing;
- compact model tool schemas derived from compiler-issued operations and diagnostics;
- semantic greenfield generation, repair and iterative modernization state machines;
- context and dependency-slice selection;
- transport retries, semantic repair budgets and progress detection;
- generation/refinement metrics and reproducible traces.

It must not contain Android, Compose, Studio UI or scenario-specific application components.

## Canonical And Stateless Boundary

`app.deal` and `app.dealui` are the only canonical generated sources. Every compiler call carries
complete source bytes, `baseDigest`, pack/interface snapshots as required and compiler-defined
operations. Semantic graphs are ephemeral. An internal cache may accelerate repeated inspection but
must never affect correctness or become persisted application state.

Model tools target compiler-issued `SymbolId` and revision-scoped `NodeId`; they never use source
comments, text search or offsets as identity. Stale digests and handles are rejected before a
candidate changes. A semantic transaction is copy, validate, commit. Transport retry cannot mutate
the graph or consume semantic repair budget.

## Generation And Modernization

Greenfield generation and iterative modernization use the same compiler API. The ordinary path is
sequential: DEAL first, exact AppInterface second, Deal UI third. UI-only refinements do not generate
DEAL; private DEAL changes do not regenerate Deal UI; public interface changes update only affected
UI nodes. The final source pair is fully checked and published atomically.

Repair remains scoped to the compiler-rejected symbol, block or UI node. Accepted unrelated units
are absent from the writable schema and preserve their digests. Repeating an unchanged rejected
candidate is no progress. Full-program regeneration is a deliberate fallback, not normal repair.

## Generalization

Do not add medication, exam, health, todo, weather, game or benchmark-specific generation branches,
blueprints, repair rules or semantic macros. Acceptance scenarios belong in tests and evaluation
data. Provider-specific code ends at authentication, model configuration and streaming transport;
all providers use the same compiler operations and correctness gates.
