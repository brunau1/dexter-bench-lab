# Benchmark methodology

This document is the **generic layer** of dexter-bench-lab. It describes how to measure the performance and resource consumption of a containerized system so that two versions of that system can be compared with known confidence. Nothing here depends on a particular system: a domain project only supplies what is measured (its services, data and scenarios), never how.

Every rule the kit enforces has an id (`BR-n`) and points back to a section of this document. The [rule index](#rule-index) lists them.

---

## 1. Purpose and headline caveat {#purpose}

The kit answers one question: **did a change make the system faster, slower, cheaper or more expensive, and how sure are we?**

It runs a system under test (SUT) in Docker under a controlled load, measures the application and every container and dependency around it, repeats each measurement, and compares versions with confidence intervals.

> **Results are relative.** A result says "version B uses 23% less CPU per 1 000 requests than version A on this host class (95% CI 18–28%)". It does **not** say "production will use 23% less CPU". Container CPU quotas are not cloud vCPUs, a local disk is not a network volume, and a bridge network has no real latency (see [Limitations](#limitations)). Every report repeats this caveat.

What the kit can claim:
- relative differences between versions, measured on the same host class;
- local capacity knees (the load at which the SUT stops meeting its service objectives on that host);
- resource cost proxies (CPU-seconds and memory per unit of work) that rank versions by cost.

---

## 2. Experimental design {#design}

A benchmark is an experiment. The variable under study is the **version** (or configuration) of the SUT. Everything else must be held constant or recorded.

### 2.1 Controlled variables {#controlled-variables}
| Variable | How it is controlled |
|----------|---------------------|
| Software | Every image is pinned by digest; the manifest records them ([§7](#reproducibility)). |
| Hardware | The host is fingerprinted and classified ([§6](#host)); only same-class runs are compared. |
| Resources | Each container has explicit CPU and memory limits; each group of containers gets its own physical cores. |
| Data | The dataset is regenerated before every repetition from a fixed seed, and its fingerprint is checked ([BR-3](#fresh-state)). |
| Load | Fixed arrival rates, fixed warm-up, measurement and cool-down durations. |
| Environment | No network egress, no image pulls during a run ([BR-13](#no-egress)); host settings checked before the run. |
| Order effects | Variants alternate within each repetition ([BR-16](#interleaving)). |

### 2.2 Open-model load and coordinated omission {#open-model}
In a **closed model** a fixed number of virtual users send a request, wait for the response, then send the next. When the SUT slows down, the load generator slows down with it, so fewer requests are sent exactly when latency is high. The slow period is under-sampled and the latency percentiles look better than they are. This is **coordinated omission** (Gil Tene).

In an **open model** requests arrive at a fixed rate whatever the response time, like real users who don't wait for each other. Latency percentiles then include the queueing a real user would see.

- **BR-1 (open model).** Load uses only arrival-rate executors. If the load generator can't keep up (it runs out of virtual users and drops iterations), the arrival rate wasn't actually applied, so the repetition is **invalid** and excluded from statistics.

### 2.3 Warm-up, measurement, cool-down {#window}
The first seconds of a run measure JIT compilation, connection-pool creation and cold caches, not steady-state behaviour. The last seconds overlap with in-flight work draining.

- **BR-2 (measurement window).** Each repetition is split into warm-up → measurement → cool-down. Every metric, from the load generator and from the resource collectors, is computed only over the measurement window.

The cool-down also gives asynchronous work (callbacks, queued jobs) time to complete, so it is counted against the scenario ([BR-19](#async)).

### 2.4 Fresh, deterministic state {#fresh-state}
Databases grow during a run; caches fill; queues accumulate. If repetition 5 starts with the data left by repetitions 1–4, the repetitions are not independent and later ones are systematically different.

- **BR-3 (fresh, deterministic state).** Before every repetition the SUT's volumes are destroyed and recreated, and the dataset is regenerated from the profile's fixed seed. The seed step reports a fingerprint (a SHA-256 of the dataset). If fingerprints differ between repetitions of one run, the data was not controlled and the run is **invalid**.

### 2.5 Repetitions are the unit of statistics {#repetitions}
Individual requests within one repetition are not independent: they share warm caches, garbage-collection cycles and background compactions. Treating 100 000 requests as 100 000 independent samples makes tiny, meaningless differences look significant. The independent unit is the **repetition**: one full lifecycle with fresh state (Kalibera & Jones).

Each metric is therefore reduced to **one value per repetition** (for example the p99 latency of that repetition), and statistics are computed across repetitions.

- **BR-4 (repetitions).** Default 5 repetitions per scenario × scale × variant. Fewer than 3 is rejected: no spread can be estimated from 2 values.

Raw per-request samples can be kept for auditing (`--raw-samples`), but they are never the statistical unit.

### 2.6 Interleaving variants {#interleaving}
Hosts drift: thermal throttling builds up, background services wake up, memory fragments. If all repetitions of A run first and all of B after, drift is confused with the effect of the change.

- **BR-16 (interleaving).** When a run contains several variants, their order alternates in each repetition: AB, BA, AB, BA… (ABBA counterbalancing). Linear drift then affects both variants equally. Comparing two separate runs is allowed but labelled **not interleaved**.

---

## 3. Scales and capacity {#scales}

### 3.1 Defining scales {#scale-definition}
A scale is an **arrival rate** (requests or iterations per second) for each scenario. Two ways to set them, in order of preference:
1. **From a production reference.** Measure the real average and peak rates, then define for example `small` = average, `medium` = peak, `large` = 2–3 × peak (headroom).
2. **Relative multiples** of a reference rate, when production numbers aren't available. For example 1×, 5×, 20× of a rate the SUT handles comfortably. Record the reference and why it was chosen.

Scales must fit the host: if the load generator drops iterations at a scale ([BR-1](#open-model)), that scale is too large for the host, not a property of the SUT.

### 3.2 Capacity search and the knee {#capacity}
Service objectives (SLOs) such as "p99 latency < 300 ms and error rate < 0.1%" define what acceptable service means. The **knee** is the highest load at which the SUT still meets them on a given host.

- **BR-17 (capacity search).** Capacity mode runs constant-arrival-rate steps at geometrically increasing rates (`start × factorⁿ` up to `max`), each with its own warm-up. The knee is the last step that meets every SLO; the search stops at the first step that breaks one. If the load generator drops iterations first, the search stops with "load generator limit reached": the true knee is at least the last valid step.

The resolution of the knee is one step. A smaller `factor` gives finer resolution at the cost of more steps.

---

## 4. Metric catalogue {#metrics}

Metrics are chosen by method, not by what a tool happens to expose:
- **RED** (Tom Wilkie) for request-driven services: **R**ate, **E**rrors, **D**uration.
- **USE** (Brendan Gregg) for resources: **U**tilization, **S**aturation, **E**rrors.
- **Dependency internals** to explain *why* a resource is used (for example: are queries slower, or more numerous?).
- **Efficiency** metrics that turn resource use into a cost proxy per unit of work.

- **BR-14 (catalogue-driven metrics).** A metric is collected and reported only if it is defined in the catalogue (`core/metrics/catalog.yaml`, plus an optional domain extension). Each entry states its source, query, unit, aggregation, direction, scope and rationale. An entry without a rationale is rejected.
- **BR-15 (full resource coverage).** Resource metrics are collected for **every** container in a run: SUT services, dependencies, simulators, the load generator, the callback sink and the observers. The kit's own containers (load generator + observers) are reported separately as **overhead**, so the observer effect is visible, not assumed.

**Direction** tells the comparison which way is better: `lower-is-better`, `higher-is-better`, or `neutral`. Neutral metrics describe the workload (for example operations per second) and are reported as `changed ↑/↓`, never as improved or regressed.

**Aggregation** reduces a time series inside the measurement window to one value per repetition: `avg`, `max`, `p95` (95th percentile of the samples), `rate` (per-second increase of a counter), or `delta` (last minus first value of a counter). A query that computes a rate over a look-back range (for example the last 5 s) is evaluated only from `window start + range`: earlier points would contain warm-up data ([BR-2](#window)).

### 4.1 Scenario metrics (load generator, RED) {#metrics-scenario}
| id | Unit | Direction | Why it matters |
|----|------|-----------|----------------|
| `req_rate` | req/s | neutral | The rate actually achieved. If it is below the target, the SUT or the load generator couldn't keep up, and the latency numbers describe a different load. |
| `error_rate` | ratio | lower | Failed requests (HTTP ≥ 400, transport errors, failed checks). A faster version that fails more isn't faster. |
| `latency_p50` | ms | lower | The typical user experience. |
| `latency_p90`, `latency_p95` | ms | lower | The experience of the slower part of the traffic; sensitive to queueing. |
| `latency_p99` | ms | lower | Tail latency: what users notice and what SLOs usually bind. Open-model load makes it honest ([§2.2](#open-model)). |
| `latency_max` | ms | lower | Worst case seen; reported for completeness but noisy, so it is rarely the basis of a verdict. |
| `dropped_iterations` | count | lower | Validity signal of [BR-1](#open-model): any value above 0 invalidates the repetition. |

### 4.2 Asynchronous end-to-end metrics (callback sink) {#async}
Many systems answer a request immediately and do the real work later, then notify the caller with a callback or webhook. The synchronous latency of such a system says little; what matters is the time until the work is done.

- **BR-19 (async end-to-end).** The load generator registers each expected callback with the sink just before sending the request. The sink matches incoming callbacks by an id extracted from the callback body and records the elapsed time. Callbacks that match nothing are counted as **unmatched**; expected callbacks still missing at the end of the cool-down are **timeouts**. Both count as errors against the SLOs.

| id | Unit | Direction | Why it matters |
|----|------|-----------|----------------|
| `e2e_p50`, `e2e_p95`, `e2e_p99` | ms | lower | Time from request to completed work, as the caller experiences it. |
| `callback_timeouts` | count | lower | Work that never completed within the window: lost or stuck jobs. |
| `callback_unmatched` | count | lower | Callbacks that don't correspond to a request: duplicates or misrouted notifications. |

### 4.3 Container resources (USE) {#metrics-container}
Collected for every container ([BR-15](#metrics)), from cgroup accounting.

| id | Unit | Aggregation | Direction | Why it matters |
|----|------|-------------|-----------|----------------|
| `cpu_cores_avg` | cores | avg | lower | Utilization: average CPU used. With the request rate it gives cost per unit of work. |
| `cpu_cores_p95` | cores | p95 | lower | Peak CPU need; sizes the CPU limit. |
| `cpu_throttled_ratio` | ratio | avg | lower | Saturation: share of scheduling periods in which the container hit its CPU quota. Above zero, latency is being added by the limit, not the code. |
| `mem_working_set_avg` | bytes | avg | lower | Utilization: memory the container actively uses (what the kernel can't reclaim easily). |
| `mem_working_set_max` | bytes | max | lower | Peak memory need; sizes the memory limit. |
| `mem_limit_ratio_max` | ratio | max | lower | Saturation: how close the container came to its memory limit. |
| `oom_events` | count | delta | lower | Errors: the container was killed or had allocations fail for lack of memory. |
| `net_rx_bps`, `net_tx_bps` | bytes/s | rate | neutral | Traffic volume; explains changes in serialization or chattiness between services. |
| `blkio_read_bps`, `blkio_write_bps` | bytes/s | rate | lower | Disk work; for databases, a proxy for cache misses and write amplification. |

### 4.4 Dependency internals {#metrics-dependencies}
Collected through exporters, enabled per dependency type declared by the target.

**MongoDB** {#metrics-mongodb}
| id | Unit | Direction | Why it matters |
|----|------|-----------|----------------|
| `mongo_ops_rate{type}` | ops/s | neutral | Workload shape: how many queries, inserts, updates, deletes, commands. A change that adds queries shows here first. |
| `mongo_op_latency_avg{type}` | ms | lower | Server-side time per operation for reads, writes and commands; separates "slower database" from "slower application". |
| `mongo_connections` | count | lower | Connections held open; each costs memory on the server. Connection-pool changes show here. |
| `mongo_wt_cache_used_bytes` | bytes | neutral | Working set held in the WiredTiger cache. |
| `mongo_wt_cache_dirty_bytes` | bytes | lower | Data waiting to be written; high values mean write pressure. |
| `mongo_docs_rate{op}` | docs/s | neutral | Documents returned, inserted, updated and deleted; with `mongo_ops_rate` it shows documents per operation (over-fetching). |
| `mongo_page_faults_rate` | faults/s | lower | Data read from disk because it wasn't in memory. |

**Redis** {#metrics-redis}
| id | Unit | Direction | Why it matters |
|----|------|-----------|----------------|
| `redis_cmd_rate` | cmd/s | neutral | Total command throughput: the load placed on Redis. |
| `redis_cmd_latency_avg{cmd}` | µs | lower | Server-side time per command, for each command the workload uses; finds expensive commands (for example O(n) scans). |
| `redis_used_memory` | bytes | lower | Memory held by data and overhead; drives instance size and cost. |
| `redis_clients_connected` | count | neutral | Open client connections. |
| `redis_clients_blocked` | count | lower | Clients waiting on blocking commands (queues); sustained values mean consumers can't keep up. |
| `redis_hit_ratio` | ratio | higher | Keyspace hits / (hits + misses): cache effectiveness. |
| `redis_evicted_keys` | count | lower | Keys removed because memory ran out: data loss for caches, a failure for queues. |
| `redis_expired_rate` | keys/s | neutral | Keys expiring by TTL: workload shape of caches and locks. |

### 4.5 Efficiency and cost proxies {#metrics-efficiency}
Infrastructure cost is driven by how much CPU and memory must be provisioned for a given amount of work. These derived metrics rank versions by cost without pretending to predict a bill.

| id | Unit | Direction | How it is computed | Why it matters |
|----|------|-----------|--------------------|----------------|
| `cpu_seconds_per_1k_req` | CPU-s | lower | Σ CPU-seconds of the SUT group in the window ÷ requests × 1 000 (also per service) | The core cost proxy: CPU needed per unit of work, independent of the load level. |
| `sut_memory_peak` | bytes | lower | max over the window of Σ working set of the SUT group | Memory to provision for the whole SUT. |
| `req_per_core` | req/s/core | higher | `req_rate` ÷ `cpu_cores_avg` of the SUT group | Throughput per provisioned core. |
| `inflight_littles_law` | requests | neutral | L = λ · W with λ = `req_rate` and W = mean latency | Average concurrency the SUT sustains (Little's Law). A sharp rise between scales signals queueing. |

---

## 5. Statistics {#statistics}

### 5.1 Descriptive statistics and stability {#stability}
For each metric, across the valid repetitions: median, mean, standard deviation and **coefficient of variation** CV = stdev / mean.

- **BR-5 (stability).** CV ≤ 5% is **stable**, ≤ 10% is **acceptable**, > 10% is **unstable**. Unstable metrics get no comparison verdict: the measurement is noisier than most effects worth detecting. The thresholds are configurable per profile.

An unstable metric is a finding in itself. Usual causes: too short a measurement window, a scale near the knee, a background job on the host, or a SUT behaviour with high variance (periodic compaction or GC).

### 5.2 Comparing two versions {#comparison}
Latencies and resource figures are not normally distributed, and 5 repetitions are too few to check normality. The kit therefore uses distribution-free methods (Kalibera & Jones, *Quantifying Performance Changes with Effect Size Confidence Intervals*).

- **BR-6 (comparison statistics).** The effect is the **ratio of medians** B / A. It is reported with:
  - a **95% percentile-bootstrap confidence interval**: resample each side with replacement 10 000 times, take the 2.5th and 97.5th percentiles of the resampled ratios. The random generator is seeded, so the same data always gives the same interval.
  - a two-sided **Mann-Whitney U** test, α = 0.05: exact distribution when both sides have ≤ 20 values and no ties; otherwise the normal approximation with tie and continuity corrections.

The ratio form makes effects comparable across metrics: 0.80 means B is 20% lower than A, whatever the unit.

### 5.3 Noise floor and calibration {#noise-floor}
Two runs of the **same** version never give identical numbers. The difference between them is the **noise floor** of the host and setup. An effect smaller than the noise floor can't be told apart from noise, even when a test calls it significant.

- **BR-8 (noise floor).** `bench calibrate` runs the same version twice, interleaved (an A/A test). For each metric, the noise floor is the larger distance from 1.0 of the A/A confidence interval bounds. Calibrations are stored per host class. Without one, verdicts are labelled **uncalibrated** and use a noise floor of 0.

Recalibrate after any change to the host or the kit version.

### 5.4 Verdicts {#verdicts}
- **BR-7 (verdict).** For each metric:
  - **improved** or **regressed**, according to the metric's direction, only if *all* hold: the confidence interval excludes 1.0; p < 0.05; and |ratio − 1| is larger than the metric's noise floor. For a neutral metric the same condition gives **changed ↑** or **changed ↓**.
  - **no significant change** otherwise.
  - **inconclusive** when either side is unstable ([BR-5](#stability)), has fewer than 3 valid repetitions, or comes from an invalid run.

Requiring the interval, the test and the noise floor together is deliberately conservative: a false "we gained 15%" is worse than a missed small gain.

**Many metrics, many tests.** A comparison tests every metric of every container and dependency (often a hundred or more). At α = 0.05 some of them will pass the test by chance even when nothing changed. The noise floor, measured by an A/A calibration on the same host class, is the main guard: chance differences rarely exceed it. Two habits keep conclusions honest: decide **before** the run which few metrics answer the question (for a cost change, typically `cpu_seconds_per_1k_req`, `sut_memory_peak` and the latency percentiles), and treat an isolated verdict on an unrelated metric as a lead to investigate, not a result.

### 5.5 What small samples can and can't show {#small-n}
With 5 repetitions per side:
- the smallest exact two-sided Mann-Whitney p-value is 2 / 252 ≈ 0.0079, so significance is reachable, but only when the two sides barely overlap;
- the bootstrap interval is coarse: it moves in steps because only a few distinct medians can be resampled.

More repetitions give tighter intervals and detect smaller effects. For decisions that hinge on effects below ~10%, use 10 or more repetitions.

### 5.6 Worked example {#example}
p99 latency of 5 repetitions: A = 212, 205, 219, 208, 214 ms; B = 171, 176, 168, 180, 173 ms.
- Medians: A = 212, B = 173 → ratio 0.816 (B is 18.4% lower).
- CVs: A 2.6%, B 2.7% → both stable.
- Bootstrap 95% CI of the ratio ≈ [0.78, 0.86]: excludes 1.0.
- Mann-Whitney U = 0, exact two-sided p = 0.0079 < 0.05.
- Calibrated noise floor for p99 on this host class: 0.04. |0.816 − 1| = 0.184 > 0.04.
- Direction: lower is better → **improved**, "p99 latency 18.4% lower (95% CI 14–22%)".

---

## 6. Host requirements and classification {#host}

### 6.1 Isolation and sizing {#isolation}
The SUT, the load generator and the observers run on the same host. If they share CPU cores, the load generator and the collectors steal time from the SUT and the measurement disturbs what it measures.

The kit splits the host into groups, each pinned to its own **physical** cores (both hyper-threads of a core go to the same group, because siblings share execution units):
- **SUT:** the target's services and their dependencies.
- **External:** the load generator, simulators of external systems and the callback sink.
- **Observers:** Prometheus, cAdvisor and the exporters.
- **Reserved:** one physical core for the operating system and the bench CLI.

Sizing: each group needs at least `ceil(Σ CPU limits of its containers)` cores, and the host needs RAM ≥ 1.2 × Σ memory limits of all bench containers.

### 6.2 Host settings {#host-settings}
| Setting | Recommended | Why |
|---------|-------------|-----|
| CPU frequency governor | `performance` | Power-saving governors change clock speed with load, which adds variance and penalizes bursty work. |
| Turbo / boost | off | Turbo speed depends on temperature and how many cores are busy, so the same work runs at different speeds. (Checked and reported; not required for classification.) |
| Swap | off or unused | Swapping makes memory access times unpredictable. |
| Other workloads | none | Anything else running competes for CPU, memory bandwidth and caches. |
| Cloud instances | dedicated or bare-metal, non-burstable | Burstable instances (CPU credits) and noisy neighbours make results depend on history and on other tenants. |

The kit **checks** these settings; it never changes them, because changing host settings is the operator's decision.

### 6.3 Classification {#classification}
- **BR-9 (host classification).** A host is **benchmark-grade** only if all of these hold; otherwise it is **smoke-only**, and every failing check is listed:
  - isolation fits: whole physical cores per group, one physical core reserved, no overlap, each group at least `ceil(Σ CPU limits)` cores;
  - RAM ≥ 1.2 × Σ memory limits;
  - the governor is `performance` on every core;
  - swap used < 64 MiB;
  - 1-minute load average < 0.5 × online CPUs before the run;
  - Docker ≥ 24 and Compose ≥ 2.24.
- **BR-10 (smoke-only results).** Runs on a smoke-only host are labelled **non-baseline**. Their numbers are shown, but no verdicts are drawn from them. Developer laptops are typically smoke-only: they are for checking that scenarios and the pipeline work, not for baselines.

### 6.4 Host classes {#host-class}
- **BR-11 (host class).** A host class is identified by CPU model, physical cores, logical CPUs, total RAM (GiB), kernel major.minor and cgroup version. Comparisons and calibration lookups only use runs of the same class. Overriding this shows the numbers labelled **not comparable**, without verdicts.

---

## 7. Reproducibility {#reproducibility}

- **BR-12 (manifest).** Every run writes a manifest before its first repetition and finalizes it at the end. It contains: host fingerprint, host class, classification and failed checks; kit version; target commit; every image with its digest; the resolved target and profile configuration; the CPU allocation plan; the seed; and per-repetition timestamps and validity. A run without a finalized manifest is **incomplete** and can't be reported or compared.
- **BR-13 (no egress).** All bench containers share one network that has no route outside the host, and no ports are published. Images are pulled in a separate `prepare` step; a run never pulls and fails at once if an image is missing. A benchmark that silently depends on the internet measures the internet.
- **BR-18 (immutable results).** A run's raw data is written once. Reports and comparisons are computed from it and can be regenerated at any time with identical output.

To reproduce a run: same host class, same kit version, same target commit, same images (by digest), same profile and seed. The manifest records all of them.

---

## 8. Limitations {#limitations}

What the kit can't guarantee, and what to do about it:
- **Container quota ≠ cloud vCPU.** A CPU limit of 1.0 is one core's worth of time on *this* host's CPU. A cloud vCPU may be a hyper-thread of a different, slower or shared CPU. Use relative results, not absolute ones.
- **No network latency by default.** Containers talk over a local bridge with near-zero latency. Systems that are chatty over the network look better locally than in production. Latency can be injected as an extension (for example a proxy simulator with a fixed delay), recorded in the manifest.
- **Managed services are approximated.** A database in a container is not a managed cloud database: storage, replication and network differ. Compare versions against the same local dependency, not local against cloud.
- **Shared hardware remains shared.** Pinning cores separates CPU time, but last-level cache and memory bandwidth are still shared between groups. The overhead section of each report shows how much the kit itself consumed.
- **macOS and Windows.** Docker runs inside a virtual machine. Limits, CPU accounting and host checks describe that VM, not the physical machine. Results are valid relative to the same VM configuration only.
- **Collector precision.** The container collector samples once per second; very short bursts are averaged. The MongoDB exporter can't answer within a 1 s scrape timeout, so MongoDB internals are sampled every 2 s. The fallback collector (when cAdvisor can't read the host's cgroup layout) covers CPU, memory, network and disk only.
- **Small samples.** See [§5.5](#small-n).
- **Multiple comparisons.** Verdicts are per metric, without a family-wide correction; see [§5.4](#verdicts).
- **Not measured:** client-side rendering, real network paths, third-party services (they are simulated), long-term effects beyond the measurement window (memory leaks over hours, data growth over months).

---

## 9. Applying the method to a new system {#applying}

A domain project provides only the **what**; this document and the kit provide the **how**. Start from `templates/target/`:

| File | What the domain provides |
|------|--------------------------|
| `target.yaml` | SUT services with CPU and memory limits; dependencies and their types (to enable exporters); simulators of external systems; the seed command; the callback id path, if callbacks are used. |
| `compose.yaml` | How to run the SUT, its dependencies and simulators: no published ports, default network only, no resource limits (the kit sets them from `target.yaml`), an explicit `image:` on built services. |
| `profile.yaml` | Scenarios (one k6 script each, tagged by use case), scales, SLOs, timings, repetitions, variants. |
| `scenarios/*.js` | k6 scripts using the kit's helper library, which enforces the open model and use-case tagging. |
| `seed/` | A deterministic data generator: same seed, same data, and it prints the dataset fingerprint. |
| `catalog.ext.yaml` | Optional extra metrics, each with a rationale, following [§4](#metrics). |

Checklist for a new system:
1. Identify the use cases that matter for cost or user experience; one scenario per use case.
2. Choose scales from production rates if available ([§3.1](#scale-definition)).
3. Mirror production resource limits in `target.yaml`.
4. Replace every external system with a simulator with fixed, recorded behaviour.
5. Run `bench doctor` on the benchmark host, then `bench calibrate`, then the baseline.

---

## 10. References {#references}
- T. Kalibera, R. Jones. *Rigorous Benchmarking in Reasonable Time*. ISMM 2013.
- T. Kalibera, R. Jones. *Quantifying Performance Changes with Effect Size Confidence Intervals*. University of Kent, Technical Report 4-12, 2012.
- B. Gregg. *The USE Method*. https://www.brendangregg.com/usemethod.html
- T. Wilkie. *The RED Method: key metrics for microservices architecture*. Grafana Labs, 2018.
- J. D. C. Little. *A Proof for the Queuing Formula L = λW*. Operations Research, 1961.
- G. Tene. *How NOT to Measure Latency*. Talk, 2015 (coordinated omission).
- Grafana k6 documentation: *Open and closed models*. https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/
- B. Efron, R. Tibshirani. *An Introduction to the Bootstrap*. Chapman & Hall, 1993.
- H. B. Mann, D. R. Whitney. *On a Test of Whether one of Two Random Variables is Stochastically Larger than the Other*. Annals of Mathematical Statistics, 1947.

---

## Rule index {#rule-index}
| Rule | Summary | Section |
|------|---------|---------|
| BR-1 | Open model; dropped iterations invalidate a repetition | [§2.2](#open-model) |
| BR-2 | Metrics only over the measurement window | [§2.3](#window) |
| BR-3 | Fresh, seeded state per repetition; fingerprint check | [§2.4](#fresh-state) |
| BR-4 | 5 repetitions by default, at least 3 | [§2.5](#repetitions) |
| BR-5 | CV stability classes | [§5.1](#stability) |
| BR-6 | Ratio of medians, bootstrap CI, Mann-Whitney U | [§5.2](#comparison) |
| BR-7 | Verdict rules | [§5.4](#verdicts) |
| BR-8 | Noise floor from A/A calibration | [§5.3](#noise-floor) |
| BR-9 | Host classification | [§6.3](#classification) |
| BR-10 | Smoke-only results are non-baseline | [§6.3](#classification) |
| BR-11 | Host classes; no cross-class verdicts | [§6.4](#host-class) |
| BR-12 | Run manifest | [§7](#reproducibility) |
| BR-13 | No egress, no pulls during a run | [§7](#reproducibility) |
| BR-14 | Catalogue-driven metrics with rationale | [§4](#metrics) |
| BR-15 | Every container measured; kit overhead separate | [§4](#metrics) |
| BR-16 | ABBA interleaving | [§2.6](#interleaving) |
| BR-17 | Capacity search and knee | [§3.2](#capacity) |
| BR-18 | Immutable raw results, reproducible reports | [§7](#reproducibility) |
| BR-19 | Asynchronous end-to-end via the callback sink | [§4.2](#async) |
