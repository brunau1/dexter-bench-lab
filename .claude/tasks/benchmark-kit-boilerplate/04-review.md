# Review — benchmark-kit-boilerplate

**Verdict:** APPROVED (2026-10-08, after one round of fixes and a re-review)
**Reviewed:** `main` 0c27ade..d425611 (whole repository, 12 commits), first round: CHANGES REQUESTED. Fixes d425611..066330e (12 commits), re-reviewed by the same fresh-context reviewer: APPROVED pending e2e, and the final e2e passed. Every finding was verified against the code by the implementing agent before fixing.

## Resolution
| Finding | Resolution | Commit |
|---------|-----------|--------|
| M1 interruption leaks the stack | `--init`, SIGINT/SIGTERM abort the run, interruptible runner, teardown on the raw runner; a live Ctrl-C test then found that one-off `compose run` containers survive `down`, so the teardown also sweeps containers and volumes by project label. Live: exit 130, 0 containers/networks/volumes left | `fix(run): tear down on interruption…`, `fix(run): sweep run containers…` |
| M2 range look-back into warm-up | Catalogue `range` (schema derives the longest selector, subqueries included); evaluation from window start + range; too-short runs refused upfront | `fix(metrics): keep range look-back…`, `fix(config): derive the required range…` |
| M3 withheld shown as no change | `withheld` verdict, excluded from counts | `fix(compare): report withheld verdicts…` |
| m1–m5, n1, n2 | Fixed as suggested | see the fix commits |
| m6, m7 | Recorded in the spec | `docs(tasks): record review amendments…` |
| m8 CPU unit (user decision) | `cpuUnit: logical` (default, like cloud vCPUs) or `physical`; compare and calibration lookup withhold across units | `feat(host): make the CPU unit…`, `fix(compare): match calibrations on the CPU unit…` |
| m4 circular A/A test | Floor sanity + uncalibrated A/A false-positive share ≤ 15 % | `test(e2e): check the A/A false-positive rate…` |
| Re-review N2, N3, n5 | Parse errors surfaced as repetition warnings; interruption handled centrally (exit 130); range derived from the query | `fix(run): surface fallback parse errors…`, `fix(config): …` |
| **Found by the e2e rerun** | cAdvisor exports removed containers for a while; with one target project per run their stale series made CPU rates negative and inflated memory. Each repetition now has its own project `<run>-sut-NNN`; e2e asserts CPU ≥ 0 and memory ≤ limit | `fix(run): use a fresh target compose project for every repetition` |
| n3, n4 | Deferred (follow-ups) | — |

## Traceability
| Item (MD-n / BR-n) | Code | Test | Status |
|--------------------|------|------|--------|
| MD-1 scaffold | `bench`, `cli/Dockerfile`, `cli/src/cli.ts` | `docker build --target test` | Done; small deviations (m7) |
| MD-2 methodology | `docs/methodology.md` | config.test (catalogue anchors) | Done |
| MD-3 config | `cli/src/config/*`, `templates/target/*`, `core/metrics/catalog.yaml`, `core/versions.yaml` | config.test | Done |
| MD-4 statistics | `cli/src/stats/*` | stats.test (scipy/numpy references) | Done |
| MD-5 doctor | `cli/src/host/*`, `commands/doctor.ts` | host.test | Done; open decision m8 |
| MD-6 observers | `cli/src/metrics/*`, `core/observers/compose.yaml` | metrics.test | Done; **M2** |
| MD-7 k6 + sink | `core/k6/bench.js`, `core/sink/server.js`, `cli/src/k6/*` | k6.test (real k6 fixture, live sink) | Done; sink API deviation m6 |
| MD-8 orchestrator | `cli/src/run/*`, `commands/run.ts`, `commands/prepare.ts` | run.test (fake Docker) | Done; **M1**, m1, m3 |
| MD-9 report/compare/calibrate | `cli/src/report/*`, `cli/src/compare/*`, `commands/*` | compare.test | Done; **M3**, m2 |
| MD-10 example + e2e | `examples/hello-target`, `cli/test/e2e`, `scripts/e2e.sh` | e2e 6/6 | Done; m4 |
| BR-1 open model | bench.js arrival-rate scenarios; execute.ts dropped check | run.test, k6.test | OK |
| BR-2 measurement window | bench.js gauge; plan.ts; aggregate.ts; k6/summary.ts | metrics.test, k6.test, run.test | **Partial: M2** |
| BR-3 fresh state | execute.ts reset/seed; manifest.ts fingerprints | run.test; e2e determinism | OK |
| BR-4 repetitions ≥ 3 | schema.ts | config.test | OK |
| BR-5 stability | stats/describe.ts | stats.test | OK |
| BR-6 ratio, CI, Mann-Whitney | stats/bootstrap.ts, mann-whitney.ts, random.ts | stats.test | OK |
| BR-7 verdict | stats/verdict.ts | stats.test | OK |
| BR-8 noise floor | compare.ts noiseFloors; commands/calibrate.ts | compare.test; e2e | OK; m2, m4 |
| BR-9 host classification | host/classify.ts | host.test | OK; m8 |
| BR-10 smoke-only | manifest baseline; compare.ts; render.ts | compare.test; e2e | **Partial: M3** |
| BR-11 host class | host/classify.ts; compare.ts | host.test; compare.test | OK (rendering via M3) |
| BR-12 manifest | run/manifest.ts; execute.ts | run.test | OK |
| BR-13 no egress | internal network; `--pull never`; resolveImages; validateTargetCompose | run.test; e2e egress probe | OK |
| BR-14 catalogue | schema.ts; loadCatalog | config.test | OK |
| BR-15 coverage | catalog planning over both projects; summary isOverhead; report overhead section | metrics.test; compare.test; e2e | OK |
| BR-16 ABBA | plan.ts; compare.ts interleaved flag | run.test; compare.test; e2e | OK |
| BR-17 capacity | plan.ts capacityRates; execute.ts runCapacity | run.test | OK |
| BR-18 reproducible reports | summary.ts; render.ts; seeded bootstrap | compare.test byte-identical; e2e | OK (n1) |
| BR-19 async e2e | core/sink/server.js; execute.ts; meetsSlo | k6.test; e2e | OK (m6) |

## Findings
| Severity | File:line | Issue & failure scenario | Suggested fix |
|----------|-----------|--------------------------|---------------|
| **Major (M1)** | `bench:27`, `cli/src/main.ts`, `cli/src/run/execute.ts:486-514` | Node runs as PID 1 in the CLI container with no SIGINT/SIGTERM handler, and the wrapper has no `--init`. Ctrl-C or `docker stop` kills it without running `finally`. An aborted run leaves the privileged cAdvisor, Prometheus, the target containers and the run network running. | Add `--init` to `bench` and `scripts/e2e.sh`. In `main`, handle SIGINT/SIGTERM by aborting the run and letting `executeRun`'s cleanup finish, then exit 130. |
| **Major (M2)** | `core/metrics/catalog.yaml:149,158,251,318,355`; `cli/src/metrics/prometheus.ts:66` | **BR-2.** Queries with `rate(...[5s])` evaluated from `window.start` look back 5 s into the warm-up. With a 15 s window, 5 of 16 points of `cpu_cores_p95`, `cpu_throttled_ratio`, `mongo_op_latency_avg`, `redis_cmd_latency_avg` and `redis_hit_ratio` include warm-up data. | Give catalogue entries a `range` (default 0). Evaluate range queries from `window.start + range` so no point looks back before the window. Add a metrics.test case. |
| **Major (M3)** | `cli/src/compare/compare.ts:101-104`, `:150`; `cli/test/compare.test.ts:127,136` | **BR-10/BR-11.** Withheld verdicts are written as `no-significant-change`. On a smoke-only host, a 14× regression reads "no significant change" in every row, in the summary counts and in the JSON. Consumers (skill B, pixer-nest pipelines) would read it as "no regression". | Add a `withheld` verdict, render it as "– (withheld)", exclude it from the counts, and update the tests. |
| Minor (m1) | `cli/src/run/execute.ts:205-276`; `cli/src/metrics/docker-stats.ts:132` | The fallback sampler is not stopped when collection throws, and a parse error inside the stream listener is an uncaught exception that skips cleanup. | try/finally around `sampler.stop()`; catch and count parse errors in the listener. |
| Minor (m2) | `cli/src/commands/calibrate.ts:34-37` | An invalid A/A run still writes the calibration with empty floors, overwriting a good one. | Don't write when `!manifest.valid`; report it. |
| Minor (m3) | `cli/src/run/execute.ts:372` | Teardown runs `compose down` without the variant env. A target using `${APP_IMAGE:?}` fails cleanup and leaks the SUT. | Pass the variant env to cleanup (the last one used). |
| Minor (m4) | `cli/test/e2e/hello-target.e2e.test.ts:112-114` | The A/A assertion uses floors derived from the same comparison, so it can't fail. | Assert against the calibration of a different A/A run, or drop the circular assertion and test calibration only for the floors' presence and sanity. |
| Minor (m5) | `cli/src/run/execute.ts:248`; `cli/src/metrics/prometheus.ts:184-204` | Responses are parsed without checking `response.ok`, which gives context-free errors. `waitReady` uses the real clock instead of the injected one. | Check status and include the URL; inject the clock. |
| Minor (m6) | `core/sink/server.js` vs spec | The sink exposes `GET /stats` with exact percentiles and no `/reset` (recreated every repetition) instead of the spec's `/metrics` histogram and `/reset`. A better design, but not recorded. | Record it as a spec amendment. |
| Minor (m7) | `docs/adr/`, raw file names, wrapper image tag | `docs/adr/README.md` is missing. Raw files are named `samples.json`/`prometheus.json.gz`. The CLI image tag is `:local`, rebuilt on every call. Each differs from the spec text. | Record in the spec; add the ADR index at Review close. |
| Minor (m8, **user decision**) | `cli/src/host/classify.ts:42-44` | BR-9 sizing counts logical CPUs: a SUT with `cpus: 2` gets one SMT core (2 siblings). The methodology stresses that siblings share execution units. | Require physical cores ≥ ceil(Σ limits), or state in BR-9/§6.1 that the unit is the logical CPU. |
| Nit (n1) | `cli/src/run/summary.ts:84-89`, `execute.ts:300` | `localeCompare` depends on ICU and locale: a risk to byte-identical reports across environments. | Plain code-point comparison. |
| Nit (n2) | `cli/src/run/execute.ts:85-87,397` | Run ids have 1 s resolution and the directory is created recursively, so two runs in the same second share it. | Non-recursive mkdir of the run directory (fail if it exists). |
| Nit (n3) | `bench:27` | The CLI container is not pinned to the reserved core. | Optional `--cpuset-cpus` from the plan; low value. |
| Nit (n4) | `cli/src/compare/compare.ts:90-93` | Metrics present only in B are dropped silently. | List them as "only in B". |

## Best-implementation check
- **Statistics in-house** (bootstrap, exact Mann-Whitney DP, seeded xoshiro128\*\*) vs a stats library. In-house is better: no dependencies, seeded for BR-18, validated against scipy.
- **Triple verdict gate** (CI + p + noise floor) vs CI-only (Kalibera & Jones). Deliberately more conservative, which fits the methodology's stated goal.
- **Measurement window from the k6 gauge** vs CLI-side timestamps. The gauge is better (no container start latency, same clock). M2 is a PromQL lookback issue, not a window-source issue.
- **First/last counter rate over the window** vs averaging `rate(x[Ns])`. First/last is exact with no lookback, so where possible M2's entries should move to this pattern.
- **Two compose projects + external internal network** (approved amendment) vs one project with selective teardown. Correct: Prometheus history survives each repetition's reset.
- **Docker CLI behind `DockerRunner`** vs dockerode. Compose needs the CLI, and the interface keeps the orchestrator unit-testable.
- **Streaming `docker stats` fallback** vs polling `--no-stream`. Streaming is cheaper (needs m1).
- **Sink with exact percentiles** vs a Prometheus histogram. Exact is better for per-repetition values (record m6).
- **Compose validation on the resolved model** (`config --format json --profile '*'`) vs raw YAML. Correct choice.

## Checks run
- Final (066330e): unit suite 151 passed, tsc strict clean. `scripts/e2e.sh` 6/6 passed (20 min). Delay test: p50 ×14.60 regressed; p95 inconclusive (unstable on the laptop). Sanity: crud/tiny api CPU 0.053 cores (CV 0.8 %), api memory max 42 MiB (earlier runs showed ~75 MiB, inflated by the stale-series bug). No leftovers.
- First round: `docker build --target test -f cli/Dockerfile . --no-cache`: 7 files, 138 tests passed. `scripts/e2e.sh` (real Docker, examples/hello-target, ~21 min): 6/6 passed. Injected 20 ms delay: p50 ratio 14.43, CI [13.86, 14.77], p = 0.029, regressed. No leftover containers or networks; no egress from the run network.
- Lint / types: `tsc` strict (with `noUncheckedIndexedAccess`) passes. No linter is configured in the repo. `sh -n` passes on `bench` and `scripts/e2e.sh`.

## Follow-ups
- n3: pin the CLI container to the reserved core. n4: list metrics present only in B.
- Benchmark host: choose and size the dedicated machine (needed by deliverable C).
- Deliverable B (specialization skill) and C (pixer-nest application).
- ADRs written at close: `docs/adr/0001-containerized-measurement-stack.md`, `docs/adr/0002-comparison-method.md`.
