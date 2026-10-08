# 0001. Measure in Docker with open-model k6, Prometheus/cAdvisor/exporters and per-repetition target projects

- **Status:** Accepted · **Date:** 2026-10-08 · **Deciders:** kit owner (Brunau1)
- **Origin:** need for a reusable, reproducible baseline before pixer-nest cost work (umbrella idea, deliverable A) · **PR:** `main` of dexter-bench-lab · **Task:** `benchmark-kit-boilerplate`

> In the context of **benchmarking any containerized system on any machine with only Docker and git**, facing **coordinated omission in closed-model load, resource usage outside the app process, and observer interference**, we decided for **k6 arrival-rate load, Prometheus (1 s) + cAdvisor + per-type exporters, a TypeScript CLI in its own container, per-group core pinning and an internal network**, and against **closed-model tools, a self-made scraper, an OpenTelemetry collector and a host-installed CLI**, to achieve **honest latency percentiles and full, isolated resource measurements**, accepting **3+ observer containers and container ≠ cloud CPU semantics**.

## Context and trigger
- Claims like "SQS instead of BullMQ saved X %" need numbers that are reproducible and comparable across versions (methodology §1).
- Closed-model load hides queueing (coordinated omission); app-only metrics hide DB/cache cost.
- Hosts differ: the kit must run anywhere with Docker and refuse to pretend precision it lacks (BR-9..BR-11).

## Decision
- **Load:** `grafana/k6` 2.x, `warmup` + `measure` constant-arrival-rate scenarios (`core/k6/bench.js`); the window comes from the `bench_measure_start_ms` gauge; dropped iterations invalidate a repetition (BR-1, BR-2).
- **Collection:** Prometheus 1 s scrape, cAdvisor for every container, exporters by dependency type (MongoDB diagnosticdata at 2 s / 1.5 s timeout, Redis at 1 s); range queries start at window start + `range` (BR-2). Fallback: streaming `docker stats` when cAdvisor can't see the run.
- **Lifecycle:** observer project `<run>-obs` for the whole run; target project `<run>-sut-NNN` new per repetition and discarded with `down -v` — cAdvisor keeps exporting removed containers, so a shared project name mixed stale series into CPU (negative rates) and memory (inflated).
- **Isolation:** whole physical cores per group (SUT / external / observers) + 1 reserved; `cpuUnit: logical` (default, like cloud vCPUs) or `physical` decides how limits are counted.
- **No egress:** run network `--internal`, no published ports, `bench prepare` is the only networked step, `--pull never` during runs (BR-13).
- **Teardown:** SIGINT/SIGTERM abort the run (`--init`, `src/signals.ts`); teardown always runs with a non-interruptible runner and sweeps containers/volumes by project label.
- **Where:** `cli/src/run/execute.ts`, `cli/src/run/compose.ts`, `cli/src/metrics/*`, `core/observers/compose.yaml`, `core/metrics/catalog.yaml`, `core/versions.yaml`.
- **Config:** `target.yaml` (services, limits, dependency types), `profile.yaml` (scales, timings, repetitions, `cpuUnit`, variants), `catalog.ext.yaml`.

## Options considered
| Option | Verdict | Why |
|--------|---------|-----|
| k6 open model + Prometheus/cAdvisor/exporters, CLI in container | ✅ | Honest percentiles, deep dependency metrics, only Docker on the host |
| Locust / closed-model generators | ❌ | Coordinated omission; heavier for multi-step flows |
| CLI scrapes Docker stats and exporters itself | ❌ | Re-implements rates, counter resets and storage |
| OpenTelemetry collector | ⏸ | Fewer Mongo/Redis metrics today; catalogue is PromQL so it can swap later |
| One target project for the whole run | ❌ | Stale cAdvisor series of removed containers corrupt CPU and memory |
| LocalStack for AWS | ❌ | Auth token + non-commercial free plan since 2026-03; use moto/ElasticMQ/MinIO |

## Consequences
- **Good:** every container (target, dependencies, kit) measured; kit overhead reported separately; runs reproducible from the manifest.
- **Accepted costs:** observer overhead on its own cores; MongoDB internals at 2 s resolution; numbers are relative, not production predictions.
- **Risks / follow-ups:** cAdvisor on unusual cgroup layouts (fallback covers CPU/mem/net/disk only); latency injection and more exporter types are extension points; revisit if k6 changes its scenario API.
