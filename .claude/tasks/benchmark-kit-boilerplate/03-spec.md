# Spec — benchmark-kit-boilerplate (deliverable A: dexter-bench-lab)

**Status:** APPROVED (2026-10-08), amended and re-approved (2026-10-08): two compose projects per run; MongoDB exporter at 2 s; review fixes: switchable CPU unit (`cpuUnit`, default logical), `withheld` verdict, sink `/stats` API

Inputs: umbrella idea `pixer-nest/.claude/tasks/baseline-performance-benchmark/01-idea.md` (section A), `02-research.md` (this folder).

## Solution overview
dexter-bench-lab is a **generic, Docker-only benchmark kit** made of three things:

1. **A methodology document** (`docs/methodology.md`): the system-independent rules. It covers experimental design, the metric catalogue with a rationale for every metric, statistics, host requirements, and limitations. Every behaviour of the code traces back to a section of it.
2. **A harness**: a TypeScript CLI (`bench`) that runs in its own container and drives everything through the Docker socket.
   - `doctor`: host fingerprint, pre-flight checks, capacity plan, host classification.
   - `prepare`: pull and pin every image, so no network is needed during a run.
   - `run`: the scenario × scale × repetition × variant matrix with fresh state per repetition. It collects k6 summaries plus Prometheus range queries for every container and dependency.
   - `report`: Markdown and JSON with stability flags.
   - `compare`: ratio of medians with a bootstrap CI, Mann-Whitney U, noise-floor-aware verdicts, host-class and smoke-only guards.
   - `calibrate`: an A/A run that measures the noise floor.
3. **Extension points** for a domain (what skill B will generate):
   - `target.yaml` (services, dependencies, simulators, seed, limits);
   - `profile.yaml` (scenarios, scales, SLOs, timings, repetitions, variants);
   - the target's compose file;
   - k6 scenario scripts using the kit's k6 helper library;
   - an optional catalogue extension for custom metrics.

The observer stack is Prometheus (1 s scrape), cAdvisor (with a Docker-stats fallback) and per-type exporters (MongoDB, Redis in the MVP). The kit generates a compose override that pins each service group to its own physical cores and puts every bench container on an `internal` network.

Claims the kit makes are **relative**: version B vs version A on the same host class, plus local capacity knees. They are never production predictions. That caveat leads the methodology and every report.

A reusable **callback sink** simulator measures asynchronous end-to-end time (request → webhook/callback). Asynchronous flows are common (pixer-nest relies on them), and without the sink the kit could only measure synchronous latency.

### Alternatives considered
| Option | Pros | Cons | Recommendation |
|--------|------|------|----------------|
| **A. Prometheus + cAdvisor + dedicated exporters, TS CLI in a container** (chosen) | Standard, well-documented metrics. Exporters are deep (Mongo WiredTiger cache, Redis command stats). PromQL handles rates and counters correctly. Only Docker needed on the host | 3+ observer containers (overhead, measured and isolated on their own cores). cAdvisor can fail on some cgroup layouts (fallback planned) | ✅ Best balance of depth, correctness and portability |
| B. No Prometheus: the CLI polls the Docker stats API and the exporters' `/metrics` itself | Fewer containers, lower observer overhead | Re-implements scraping, counter-reset handling, rate maths and storage. More code, more bugs, harder to extend | ❌ Saves little, costs correctness |
| C. OpenTelemetry Collector (dockerstats + redis + mongodb receivers) → Prometheus | One observer process for containers and dependencies, vendor-neutral | The Mongo/Redis receivers expose fewer metrics than the dedicated exporters, and the config is heavier. Not needed today | ⏸ Possible later swap: catalogue entries are PromQL, so the source can change without touching the statistics |
| D. CLI on the host (Node installed) instead of in a container | Simpler path handling (no same-path mount) | Breaks "only Docker + git on the host"; Node version drift between machines | ❌ The container uses a same-path bind mount instead |
| E. Off-the-shelf stack (k6 + InfluxDB + Grafana) | Dashboards for free | No repetitions, statistics, verdicts, fingerprinting or host guards (the core value of this kit). Grafana was deferred by the user | ❌ |
| F. Raw per-request k6 samples as the statistical unit | Finest granularity | Requests within one repetition aren't independent (shared warm caches, GC), which inflates significance. Repetitions are the i.i.d. unit (Kalibera & Jones) | ❌ Statistics use per-repetition values. Raw samples are an opt-in audit artifact (`--raw-samples`) |

## Business rules
- **BR-1 (open model):** load uses only k6 arrival-rate executors (`constant-arrival-rate`, `ramping-arrival-rate`). A repetition with `dropped_iterations > 0` is marked **invalid (load generator saturated)** and excluded from statistics.
- **BR-2 (measurement window):** each repetition has warm-up → measurement → cool-down. Every metric (k6 and Prometheus) is computed **only** over the measurement window `[t0 + warmup, t0 + warmup + duration]`.
- **BR-3 (fresh, deterministic state):** before each repetition the target's volumes are recreated (`down -v` + `up`) and the dataset is reseeded with the profile's fixed seed. The seed step reports a dataset fingerprint (`BENCH_DATASET_SHA256=<hex>` on stdout). If the fingerprints differ within one run, that run is **invalid**.
- **BR-4 (repetitions):** default 5 per scenario × scale × variant. The minimum accepted is 3; config validation rejects fewer.
- **BR-5 (stability):** per metric, CV = stdev / mean across valid repetitions. ≤ 5% is `stable`, ≤ 10% is `acceptable`, > 10% is `unstable`. Unstable metrics get no comparison verdict. The thresholds are configurable in `profile.yaml`; the defaults are the ones above.
- **BR-6 (comparison statistics):** for each metric, the effect is the ratio of medians B/A, reported with:
  - a 95% percentile-bootstrap CI (10 000 resamples, fixed PRNG seed, so reports are reproducible byte for byte);
  - a two-sided Mann-Whitney U p-value (exact distribution when n_A, n_B ≤ 20 and there are no ties, normal approximation with tie and continuity corrections otherwise, as scipy does), α = 0.05.
- **BR-7 (verdict):**
  - `improved` or `regressed` (direction from the catalogue entry) only if all of these hold: the CI excludes 1.0, p < α, and |ratio − 1| > that metric's noise floor;
  - for `neutral` metrics (workload descriptors), the same condition gives `changed ↑` / `changed ↓` instead of improved/regressed (clarified during MD-2);
  - `withheld` when the comparison as a whole may not draw verdicts (BR-10, BR-11), so a withheld result is never mistaken for "no change" *(amended at review)*;
  - `no significant change` otherwise;
  - `inconclusive` when either side is unstable, has fewer than 3 valid repetitions, or is invalid.
- **BR-8 (noise floor):** `bench calibrate` runs the same variant twice, interleaved (an A/A test). For each metric, the noise floor is the larger of |CI lower − 1| and |CI upper − 1| of the A/A ratio. It is stored per host class. Without a calibration for the host class, verdicts are labelled `uncalibrated` (still computed with a noise floor of 0).
- **BR-9 (host classification):** the host is `benchmark-grade` only if **all** of these hold. Otherwise it is `smoke-only`, and every failing check is listed:
  - Isolation: each group gets whole physical cores (both SMT siblings), one physical core is reserved for the OS and the CLI, and nothing overlaps. The groups are: SUT = target services + dependencies; external = k6 + simulators + sink; observers.
  - Each group gets at least `ceil(sum of its declared CPU limits)` CPUs, counted in the profile's `cpuUnit`: `logical` (default; hyper-threads, like cloud vCPUs) or `physical` (whole cores). Either way a group always receives whole physical cores, so groups never share execution units. *(Amended at review, approved by the user.)*
  - RAM ≥ (sum of memory limits of all bench containers) × 1.2.
  - The CPU governor is `performance` on all cores.
  - Swap used < 64 MiB.
  - 1-minute load average < 0.5 × online CPUs at pre-flight.
  - Docker ≥ 24 and Compose ≥ 2.24.
- **BR-10 (smoke-only results):** a run on a `smoke-only` host is labelled `non-baseline` in its manifest and report. `compare` shows its numbers but gives no verdicts.
- **BR-11 (host class):** runs that used different `cpuUnit` values are compared like different host classes: numbers without verdicts. *(Amended at review.)* Also: the host class is a hash of the CPU model, physical cores, logical CPUs, total RAM rounded to GiB, kernel major.minor, and cgroup version. `compare` and calibration lookup refuse runs from different host classes. `--allow-cross-host` shows the numbers labelled "not comparable" and still gives no verdicts.
- **BR-12 (manifest):** every run writes `manifest.json` before its first repetition and finalizes it at the end. It contains:
  - the fingerprint and host class;
  - the classification and failed checks;
  - the kit version (git describe) and the target commit (if the target is in git);
  - every image reference with its digest;
  - the resolved `target.yaml` + `profile.yaml`;
  - the cpuset plan and seed;
  - per-repetition timestamps and validity.

  A run without a finalized manifest is `incomplete` and can't be reported or compared.
- **BR-13 (no egress):** all bench containers share one Docker network with `internal: true`, and no ports are published. `bench prepare` pulls the images. `bench run` never pulls: it fails fast if any image is missing locally.
- **BR-14 (catalogue-driven metrics):** a metric is collected and reported only if it is defined in the catalogue (kit catalogue + optional target extension). Each entry has:
  - `id`, `source`, `query`, `unit`;
  - `aggregation` (avg | max | p95 | rate | last-minus-first);
  - `direction` (lower-is-better | higher-is-better | neutral);
  - `scope` (per-container | per-dependency | per-scenario);
  - `rationale` (a short reason + a methodology section anchor).

  Config validation rejects entries without a rationale.
- **BR-15 (full resource coverage):** resource metrics are collected for **every** container in the bench project: target services, dependencies, simulators, k6, sink and observers. The kit's own overhead (k6 + observers) appears as a separate report section.
- **BR-16 (interleaving):** with several variants, the order within each repetition alternates: AB, BA, AB… (ABBA counterbalancing). This cancels linear host drift. A comparison between two separate runs (not interleaved) is allowed and labelled `not interleaved`.
- **BR-17 (capacity search):** capacity mode runs constant-arrival-rate steps at geometrically increasing rates (`start`, `factor`, `max`). Each step has its own warm-up and runs once.
  - The **knee** is the highest step that meets every profile SLO (e.g. p99 latency, error rate).
  - It stops at the first step that breaks an SLO.
  - If a step has `dropped_iterations > 0`, the search stops with "load generator limit reached, knee ≥ last valid step" (BR-1).
- **BR-18 (immutable results):** `results/<run-id>/raw/` is written once. `report` and `compare` only read raw data and can be re-run at any time to produce identical output (BR-6 seed).
- **BR-19 (async end-to-end):** the callback sink measures the time from k6's `expect(id)` registration to the sink receiving a callback whose body yields the same id (configured JSON path).
  - Unmatched callbacks are counted.
  - Expected ids with no callback by the end of the cool-down count as `callback_timeouts`.
  - Timeouts and unmatched callbacks are reported and count as errors for the SLO.

## Implementation steps
### High level
```
dexter-bench-lab/
  README.md                     # what it is, quick start, link to methodology
  LICENSE                       # MIT
  bench                         # POSIX sh wrapper: docker run the CLI image with socket + same-path mount
  docs/methodology.md           # generic layer (F1)
  docs/adr/README.md            # ADR index (ADRs written at Review close)
  cli/                          # TypeScript CLI (package.json, tsconfig, src/, test/)
    Dockerfile                  # stages: build, test, runtime (node:22-alpine + docker CLI/compose from docker:29-cli)
  core/
    versions.yaml               # pinned images (tag@digest): k6, prometheus, cadvisor, exporters, sink
    observers/compose.yaml      # prometheus + cadvisor (+ exporters injected per dependency type)
    observers/prometheus.yaml   # scrape config template
    metrics/catalog.yaml        # kit metric catalogue (BR-14)
    k6/bench.js                 # k6 helper library: scenario builder, usecase tagging, sink expect()
    sink/                       # callback sink simulator (tiny Node HTTP service + Dockerfile)
  templates/target/             # skeleton for skill B: target.yaml, profile.yaml, compose.yaml, scenarios/, seed/, catalog.ext.yaml
  examples/hello-target/        # self-test target: service + worker + mongo + redis + seed + scenarios + profile
  .claude/tasks/                # handoffs (committed, user decision)
```
Each command, in order:
- **`bench doctor`:** probe the host → fingerprint + host class → capacity plan from `target.yaml` → checks → classification (BR-9, BR-11).
- **`bench prepare`:** resolve every image (kit `versions.yaml` + the target's compose files) → pull → record digests.
- **`bench run`:**
  1. doctor;
  2. assert images are present (BR-13);
  3. write the manifest (BR-12);
  4. generate the compose override (cpusets, internal network, observer services, exporters for each dependency);
  5. for each scenario × scale, then each repetition (and each variant, ABBA, BR-16): `down -v` → `up` (wait for healthy) → seed (BR-3) → k6 run (warm-up + measure + cool-down) → collect the k6 summary + Prometheus range queries over the window (BR-2) → write `raw/`;
  6. finalize the manifest → write `summary.json` + `report.md`.
- **`bench report <run>`:** rebuild `summary.json` + `report.md` from `raw/` (BR-18).
- **`bench compare <runA[:variant]> <runB[:variant]>`:** guards (BR-10, BR-11) → per-metric stats (BR-6) → verdicts (BR-7, BR-8) → `comparisons/<a>__<b>.{json,md}`.
- **`bench calibrate`:** a run with variants `[base, base]` → store `calibration/<host-class>.json` (BR-8).

Each run uses **two compose projects** on one run-scoped `internal` network: `<run-id>-obs` (Prometheus, cAdvisor, exporters) lives for the whole run; `<run-id>-sut-NNN` (target, seed, sink, k6) is a new project for every repetition, discarded with `down -v` when it ends. *(Refined at review: with one shared target project, cAdvisor's lingering series of removed containers matched the selectors, making CPU rates negative and inflating memory; caught by the e2e rerun.)* cAdvisor's project and service labels identify every container. *(Amended 2026-10-08, approved by the user: a single project would wipe Prometheus on every per-repetition reset.)*

### Code level
| File / module | Change | Notes (libs, interactions) |
|---------------|--------|----------------------------|
| `cli/package.json`, `tsconfig.json` | New | Runtime deps: `yaml`, `zod`. Dev: `typescript`, `vitest`, `@types/node`. CLI parsing with `node:util` `parseArgs`. HTTP via global `fetch`. Docker via spawning the `docker` CLI (compose features are needed; dockerode has no compose) |
| `cli/Dockerfile` | New | `build` (tsc), `test` (vitest), `runtime` (node:22-alpine + `COPY --from=docker:29-cli` docker binary + compose plugin). All bases pinned by digest |
| `bench` (wrapper) | New | `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD:$PWD" -w "$PWD" <cli-image> "$@"`. It talks to the daemon only through the socket. Same-path mount so compose bind paths resolve on the host daemon. Rebuilds the CLI image (`dexter-bench-cli:local`) on every call; the layer cache makes it near-instant and the image always matches the checkout, and the kit's `git describe` goes into the manifest *(amended at review)*. Runs with `--init` so signals reach the CLI (review M1) |
| `cli/src/config/schema.ts` | New | zod schemas for `target.yaml`, `profile.yaml`, catalogue entries, `versions.yaml`. `schemaVersion: 1`. Validation errors say the file, path and expected value (BR-4, BR-14) |
| `cli/src/config/load.ts` | New | Read and merge YAML; resolve paths relative to the file; merge the kit catalogue with the target extension (ids must be unique) |
| `cli/src/host/probe.ts` | New | Reads `/proc/cpuinfo`, `/sys/devices/system/cpu/*/topology/thread_siblings_list`, `cpufreq/scaling_governor`, `intel_pstate/no_turbo` or `cpufreq/boost`, `/proc/meminfo`, `/proc/loadavg`, `uname`, `/sys/fs/cgroup` type; `docker version --format json`, `docker compose version`. The probe is an interface (injected in tests) |
| `cli/src/host/classify.ts` | New | Host class hash (BR-11); capacity plan + SMT-aware core allocation (BR-9); check list with pass/fail/warn and reasons |
| `cli/src/stats/*.ts` | New | `describe` (median, mean, stdev, CV), `stability` (BR-5), `bootstrapRatioCI` (seeded xoshiro128** PRNG, BR-6), `mannWhitneyU` (exact for n ≤ 20 via DP over rank sums, tie-corrected normal approximation above), `verdict` (BR-7/BR-8) |
| `cli/src/metrics/catalog.ts` | New | Catalogue model; builds PromQL per container/dependency with project/service label filters |
| `cli/src/metrics/prometheus.ts` | New | `query_range` over the window with a 1 s step → series → aggregation per catalogue entry. Counter resets handled by PromQL `rate`/`increase` in the entries |
| `cli/src/metrics/docker-stats.ts` | New | Fallback collector: samples `docker stats --no-stream --format json` every 1 s during the window when `doctor` finds cAdvisor unusable. It covers only the container metrics that have catalogue equivalents (cpu, mem, net, blkio), and the manifest records which collector was used |
| `cli/src/k6/*.ts` | New | Builds the k6 env/options from profile scale + timings (open model only, BR-1). Parses the `handleSummary` JSON (per-usecase submetrics) |
| `core/k6/bench.js` | New | k6 helper: `scenario(fn, {usecase})` tags requests; `options()` builds arrival-rate scenarios from `__ENV`; registers always-pass thresholds per usecase so the summary contains submetrics; `expect(id)` → POST to the sink; `handleSummary` writes JSON to `/results` |
| `core/sink/` | New | ~150-line Node HTTP service: `POST /expect {id, measure}` (records t0), `POST /callback/*` (extracts the id from the body via the `SINK_ID_PATH` JSON path, records the latency), `GET /stats` (exact percentiles, timeouts, unmatched). No reset endpoint: the sink is recreated with the target every repetition. *(Amended at review: exact percentiles instead of a histogram.)* (BR-19) |
| `core/observers/*` | New | Compose for Prometheus (`--storage.tsdb.path` on a per-run volume, 1 s scrape) and cAdvisor (`--docker_only`, housekeeping 1 s). Exporter services are generated from `dependencies[].type`: `mongodb` → `percona/mongodb_exporter` (`--collector.diagnosticdata`, global connection pool, scraped every 2 s with a 1.5 s timeout because the exporter returns no data at a 1 s timeout; amended 2026-10-08, approved by the user), `redis` → `oliver006/redis_exporter` |
| `core/metrics/catalog.yaml` | New | The kit's catalogue (list below) |
| `cli/src/run/plan.ts` | New | Expands the matrix; ABBA order (BR-16); capacity steps (BR-17); computes timings and windows (BR-2) |
| `cli/src/run/compose.ts` | New | Generates the override YAML: cpusets per group, `mem_limit`/`cpus` from target.yaml, `networks: bench: internal: true` (BR-13), observers + exporters + sink + k6 services |
| `cli/src/run/execute.ts` | New | The lifecycle above, through a `DockerRunner` interface (spawn wrapper; faked in unit tests). After the observers are up, the CLI attaches its own container to the internal bench network (`docker network connect <net> $HOSTNAME`) to query Prometheus without publishing ports (BR-13), and detaches at teardown, including on error. Writes `raw/<scenario>/<scale>/<variant>/rep-NN/{k6.json,samples.json,prometheus.json.gz,meta.json}` *(names amended at review)* |
| `cli/src/run/manifest.ts` | New | Write and finalize the manifest (BR-12); validity markers (BR-1, BR-3) |
| `cli/src/report/*.ts` | New | `summary.json` + `report.md`: headline caveat, host classification, per scenario/scale tables (median, CI, CV flag), resource table per container, kit overhead section (BR-15), invalid repetitions with reasons |
| `cli/src/compare/*.ts` | New | Guards (BR-10, BR-11), calibration lookup (BR-8), per-metric verdicts, `not interleaved` label (BR-16) |
| `cli/src/main.ts` | New | Subcommands: `doctor`, `prepare`, `run`, `report`, `compare`, `calibrate`, `--help` |
| `templates/target/*` | New | A commented skeleton of each extension point, with placeholders, used by skill B |
| `examples/hello-target/*` | New | Node service: `POST /items` (Mongo insert + Redis cache invalidation), `GET /items/:id` (Redis cache → Mongo); `POST /jobs` → Redis list → worker → callback to the sink. `EXTRA_DELAY_MS` env enables the sensitivity variant. Seed (fixed-seed generator, prints the fingerprint). Two scenarios (`crud`, `async-jobs`), scales `tiny`/`small` sized for a laptop |
| `docs/methodology.md` | New | Sections listed below |
| `README.md`, `LICENSE`, `.gitignore`, `docs/adr/README.md` | New | `.gitignore`: `results/`, `comparisons/`, `calibration/`, `node_modules/`, `cli/dist/` |

**Kit metric catalogue (MVP)**, each entry with a rationale in `docs/methodology.md`:
- **Per scenario / use case (k6, RED):**
  - achieved request rate;
  - error rate (HTTP ≥ 400 + failed checks);
  - latency p50/p90/p95/p99/max;
  - `dropped_iterations` (validity);
  - async e2e p50/p95/p99, callback timeouts, unmatched callbacks (sink).
- **Per container (cAdvisor, USE):**
  - CPU used (cores, avg/p95);
  - CPU throttled ratio (saturation);
  - memory working set (avg/max) and % of limit;
  - OOM events (errors);
  - network rx/tx bytes/s;
  - block I/O read/write bytes/s.
- **Per dependency:**
  - **MongoDB:** ops/s by type (opcounters); average op latency by type (reads/writes/commands); current connections; WiredTiger cache used and dirty bytes; documents returned/inserted/updated per second; page faults.
  - **Redis:** commands/s; average latency per command (from `commandstats`, top 10); used memory; connected and blocked clients; keyspace hit ratio; evicted keys; expired keys/s.
- **Derived efficiency (cost proxies):**
  - CPU-seconds per 1 000 requests (SUT group total, and per service);
  - peak memory of the SUT group;
  - requests/s per allocated core;
  - Little's Law in-flight estimate L = λ·W (checked against the observed concurrency).

**`docs/methodology.md` sections:**
1. Purpose and headline caveat: claims are relative, not production predictions.
2. Experimental design: controlled variables; open model and coordinated omission; warm-up, measurement and cool-down; fresh state; repetitions as the i.i.d. unit; interleaving.
3. Scales and capacity: how to define scales (from production reference rates or relative multiples); the knee.
4. Metric catalogue: RED for services, USE for resources, dependency internals, efficiency and cost proxies. One entry per metric: what it measures, why, source, aggregation, direction.
5. Statistics: descriptive stats, CV stability, bootstrap CI of the ratio, Mann-Whitney U, noise floor and calibration, verdict rules, worked example.
6. Host requirements and classification: sizing formula; host settings (performance governor, turbo off, swap off, idle host; on cloud, dedicated non-burstable instances); host classes.
7. Reproducibility: the manifest, image pinning, seeds, no egress.
8. Limitations: container quota ≠ cloud vCPU; no network latency by default; shared caches and memory bandwidth; macOS/Windows VMs; cAdvisor fallback precision; small-n bootstrap granularity; what the kit does **not** measure.
9. Applying it to a new system: the extension points, using `templates/target/`.
10. References: Kalibera & Jones; Gregg (USE); Wilkie (RED); Little; Tene (coordinated omission); the k6 docs.

## Expected code flow
```mermaid
sequenceDiagram
  participant U as User
  participant B as bench CLI (container)
  participant D as Docker daemon
  participant T as Target + deps (cpuset SUT)
  participant K as k6 + sink (cpuset external)
  participant P as Prometheus/cAdvisor/exporters (cpuset observers)
  U->>B: bench run --profile profile.yaml
  B->>B: doctor: probe, host class, capacity plan, classify
  B->>D: assert images present (no pull)
  B->>B: write manifest (initial)
  B->>D: compose up observers (internal network)
  loop scenario × scale × rep (ABBA variants)
    B->>D: compose down -v / up target (healthy)
    B->>T: seed (fixed seed) → dataset fingerprint
    B->>K: sink reset; k6 run (warm-up → measure → cool-down)
    K->>T: open-model load (arrival rate)
    T-->>K: callbacks to sink (async flows)
    P->>T: scrape every 1 s
    B->>P: query_range over the measurement window
    B->>B: write raw/ (k6 summary, series, meta, validity)
  end
  B->>B: finalize manifest, summary.json, report.md
  U->>B: bench compare runA runB
  B->>B: guards → bootstrap CI + Mann-Whitney → noise floor → verdicts
```

## Roadmap (micro-deliveries)
One local commit per MD (code + its tests). Commits as `Brunau1 <46985145+brunau1@users.noreply.github.com>` (already set in the local config). No push without an explicit request.

- [x] **MD-1: repo scaffold and CLI skeleton.** Includes README stub, MIT LICENSE, `.gitignore`, `cli/` TS project, multi-stage Dockerfile, `bench` wrapper, `bench --help`. Done when `./bench --help` runs from the container on the laptop and `docker build --target test` succeeds.
- [x] **MD-2: methodology document.** `docs/methodology.md`, all 10 sections, with the metric catalogue rationale and the statistical rules exactly as BR-1…BR-19. Done when every BR and every catalogue metric has a section anchor, and the generic layer contains no domain names.
- [x] **MD-3: config schemas and templates.** zod schemas + loader + catalogue merge; `templates/target/` skeleton; `core/metrics/catalog.yaml`; `core/versions.yaml` (digests resolved). Done when the schema tests pass and the templates validate against the schemas.
- [x] **MD-4: statistics module.** Done when the tests reproduce the reference values (computed independently, e.g. with scipy, and stored as test constants).
- [x] **MD-5: host doctor.** Probe, class, capacity plan, SMT-aware allocation, checks, classification, `bench doctor` output. Done when the injected-probe tests pass and `./bench doctor` on the laptop reports `smoke-only` with the expected failing checks (the governor, at least).
- [x] **MD-6: observer stack and collection.** Observer compose, exporter generation, Prometheus range-query collector, Docker-stats fallback. Done when the unit tests pass and a manual `docker compose up` of the observers scrapes a Redis + Mongo pair with no errors.
- [x] **MD-7: k6 helper and callback sink.** Done when the unit tests pass and the sink image builds.
- [x] **MD-8: run orchestrator.** Plan (matrix, ABBA, capacity steps, windows), override generation, execute lifecycle, manifest, `raw/` layout, `summary.json`, `bench prepare` / `run`. Done when the unit tests (with a fake DockerRunner) pass.
- [x] **MD-9: report, compare, calibrate.** Done when the unit tests pass on fixture runs.
- [x] **MD-10: example target and end-to-end validation.** `examples/hello-target` plus the e2e suite (smoke run, determinism, A/A noise, sensitivity, no egress). Done when the full e2e suite passes on the laptop at `tiny`/`small` scales, and the README quick start is verified by following it.

## Test plan
| Test | Type | Validates (BR-n / particularity) |
|------|------|----------------------------------|
| Config rejects `repetitions < 3`, catalogue entries without a rationale, unknown dependency types, and duplicate metric ids, each with a precise error path | unit | BR-4, BR-14 |
| Template files in `templates/target/` validate against the schemas | unit | Extension points stay in sync with the schemas (skill B input) |
| `describe`/`stability`: parameterized datasets at the CV boundaries (4.99%, 5%, 10%, 10.01%) classify correctly | unit | BR-5 |
| `bootstrapRatioCI`: same input + seed → identical CI; identical samples → CI contains 1.0; shifted samples (B = A×1.2) → CI excludes 1.0 and matches the scipy reference within tolerance | unit | BR-6, BR-18 |
| `mannWhitneyU`: exact p-values for n = 3…8 match reference tables; ties handled; the normal approximation is used above 20 | unit | BR-6 |
| `verdict`: a parameterized table over CI/p/noise floor/stability/validity/calibration combinations gives improved/regressed/no change/inconclusive/uncalibrated, with direction from the catalogue | unit | BR-7, BR-8 |
| Host probe fixtures (8-thread SMT laptop, 32-core server, missing cpufreq, macOS VM) → expected fingerprint, host class and SMT sibling groups | unit | BR-11 |
| Capacity plan: too few physical cores, RAM below 1.2× limits, governor ≠ performance, swap use, high loadavg, old Compose → `smoke-only` with exactly those failed checks; a sized fixture → `benchmark-grade` with disjoint whole-core cpusets and one reserved core | unit | BR-9 |
| Plan: 2 variants × 4 repetitions produce AB, BA, AB, BA; measurement windows exclude warm-up/cool-down; capacity steps follow start × factorⁿ up to the maximum | unit | BR-16, BR-2, BR-17 |
| Capacity evaluation: the knee is the last step meeting all SLOs; a dropped-iterations step stops the search with a lower-bound label | unit | BR-17, BR-1 |
| Override generator: every bench service gets its group's cpuset; the network is `internal: true`; no `ports`; exporters appear only for the declared dependency types | unit | BR-9, BR-13, BR-15 |
| Execute with a fake DockerRunner: missing image → fails before any `up`; per repetition the order is down -v → up → seed → k6 → collect; a seed fingerprint mismatch marks the run invalid; `dropped_iterations > 0` marks the repetition invalid | unit | BR-13, BR-3, BR-1 |
| Manifest: contains every required field; a run interrupted before finalizing is `incomplete`, and report/compare refuse it | unit | BR-12 |
| Collector: fixture Prometheus responses → aggregations (avg, max, p95, rate, last-minus-first) computed only within the window; containers across all groups appear, kit overhead is separated | unit | BR-2, BR-14, BR-15 |
| Sink: expect → callback matched by JSON path yields a latency; an unmatched callback is counted; an expected id with no callback by the end of the cool-down is a timeout; reset clears state | unit | BR-19 |
| Compare guards: different host classes refuse (or label with `--allow-cross-host`, no verdicts); smoke-only runs give numbers without verdicts; separate runs are labelled `not interleaved` | unit | BR-10, BR-11, BR-16 |
| Report regeneration: `bench report` on the same `raw/` produces byte-identical `summary.json`/`report.md` | unit | BR-18 |
| **e2e smoke:** `prepare` → `run` on hello-target (2 scenarios × 2 scales × 3 reps, short timings) → the manifest is final; `raw/` has k6 + resource series for every container (target, mongo, redis, sink, k6, observers) + Mongo/Redis exporter metrics; the report renders with the `smoke-only` label | e2e (Docker) | BR-2, BR-3, BR-12, BR-15, BR-10 |
| **e2e determinism:** two runs → identical dataset fingerprints | e2e | BR-3 |
| **e2e A/A:** `calibrate` on hello-target → a calibration file exists; comparing its variants gives `no significant change` for every stable metric | e2e | BR-8, BR-7 |
| **e2e sensitivity:** variants base vs `EXTRA_DELAY_MS=20` → latency p50 `regressed`, p95 never `improved` (implementation note: on the laptop p95/p99 have CV > 10% and are correctly `inconclusive` under BR-5; observed p50 ratio 14.4×, CI [13.9, 14.8], p = 0.029) with a CI excluding 1.0 (verdict computed despite smoke-only via a test-only flag `--force-verdicts`, which is labelled in the report) | e2e | BR-6, BR-7 |
| **e2e no egress:** during a run, a probe container on the bench network can't reach an external address; `run` with one image removed fails before starting | e2e | BR-13 |
| **e2e async:** hello-target `async-jobs` produces sink e2e latency metrics and zero timeouts at `tiny` scale | e2e | BR-19 |

Note on `--force-verdicts`: on the laptop (smoke-only), the sensitivity test can't otherwise reach a verdict (BR-10). The flag exists only so the kit can test its own statistics pipeline. It is printed in red in the report and recorded in the manifest. It is a declared, tested feature, not a workaround.

## Risks, rollback, boundaries
- **Scope:** 10 MDs, the largest part of the umbrella. If the user wants to cut, the first candidates are the Docker-stats fallback (MD-6), the sink (MD-7, BR-19) and the capacity search (BR-17). Each can move to a follow-up without affecting the rest.
- **k6 v2 API drift:** pin k6 by digest; the helper library is tested through the e2e suite.
- **cAdvisor on cgroup v2:** works on the laptop (cgroup v2, standard data root) per the research. The fallback covers other hosts.
- **Exact host checks need sysfs:** inside a container, `/sys` and `/proc` reflect the host on Linux. In macOS/Windows Docker they reflect the VM, so the class and checks describe the VM (documented in Limitations).
- **Small-n statistics:** with 5 repetitions the bootstrap CI is coarse, and the exact Mann-Whitney p-value has a floor of 0.0079 (5 vs 5). The methodology explains this and how raising `repetitions` sharpens it.
- **Handoffs committed:** `.claude/tasks/` is committed in this repo (user decision 2026-10-08). That overrides the global commit guideline for this repo only.
- **Rollback:** a new repo with no consumers yet. Any MD can be reverted on its own (atomic commits).
- **Out of scope:** Grafana / live view; multi-host or distributed load; CI integration; built-in PostgreSQL exporter and other dependency types (the `custom` type covers them); network latency injection (documented extension point only); skill B; the pixer-nest application (C).
