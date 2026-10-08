# dexter-bench-lab

A generic kit for **controlled, reproducible performance and resource benchmarks** of containerized systems.

It runs a system under test in Docker under a fixed, open-model load. It measures the application *and* every dependency and container around it, repeats each measurement from a fresh, seeded state, and compares versions with confidence intervals instead of raw numbers.

> **Results are relative**: version B against version A on the same host class. They are not predictions of production behaviour. Read [docs/methodology.md](docs/methodology.md): every rule the kit enforces is explained and justified there.

## Requirements
- Docker ≥ 24 with the Compose plugin ≥ 2.24 (your user in the `docker` group).
- git.

Nothing else is installed on the host. The `bench` CLI runs in its own container, built on first use.

## Quick start (self-test on any machine)
```sh
git clone git@github-personal:brunau1/dexter-bench-lab.git
cd dexter-bench-lab/examples/hello-target

../../bench doctor --target target.yaml --profile profile.yaml   # host fingerprint, capacity plan, classification
../../bench prepare --target target.yaml --profile profile.yaml  # pulls and builds everything (the only networked step)
../../bench run --target target.yaml --profile profile.yaml      # ~10 min: 2 scenarios x 2 scales x 3 repetitions
```
The run prints its directory, `results/<run-id>/`, which contains:

| File | Content |
|------|---------|
| `report.md` | Human report: service levels, async end-to-end, resources per container, dependency internals, cost proxies, kit overhead |
| `summary.json` | One entry per metric × subject: the value of every valid repetition, median, CV and stability |
| `manifest.json` | Everything needed to reproduce the run: host fingerprint and class, images by digest, configuration, seed, windows |
| `raw/` | Per repetition: k6 summary, aggregated samples, raw Prometheus series |

Compare two versions in one interleaved run, after calibrating the host's noise floor:
```sh
../../bench calibrate --target target.yaml --profile profile.ab.yaml   # A/A run → calibration/<host-class>.json
../../bench run       --target target.yaml --profile profile.ab.yaml   # variants base and delayed, interleaved
../../bench compare results/<run-id>:base results/<run-id>:delayed     # → comparisons/<a>__<b>.md
```
On a laptop the host is classified **smoke-only**, so comparisons show numbers without verdicts (methodology §6.3). Official baselines run on a dedicated host sized for the target (`bench doctor` says when it is).

## Commands
| Command | What it does |
|---------|--------------|
| `bench doctor [--target t --profile p]` | Probes the host. With a target, plans the CPU isolation and classifies the host as `benchmark-grade` or `smoke-only` |
| `bench prepare --target t --profile p` | Pulls the kit's pinned images and the target's images, builds built services and the callback sink |
| `bench run --target t --profile p [--capacity] [--raw-samples] [--out dir]` | Runs the scenario × scale × repetition × variant matrix, or a capacity search |
| `bench report <run>` | Rebuilds `summary.json` and `report.md` from raw data |
| `bench compare <runA>[:variant] <runB>[:variant]` | Ratio of medians with a 95% bootstrap CI, Mann-Whitney U, noise floor, verdict per metric |
| `bench calibrate --target t --profile p` | A/A run of the profile's first variant that stores the noise floor of this host class |

Run `bench` from the directory that holds the target. Only the current directory is mounted into the CLI container.

## Benchmarking your own system
Copy `templates/target/` next to your system and fill in the extension points (methodology §9):

| File | You provide |
|------|-------------|
| `target.yaml` | Services, dependencies (`mongodb`, `redis` or `custom` with its exporter), simulators of external systems, resource limits, the seed job, the callback id path |
| `compose.yaml` | How to run them: no ports, default network only, no resource limits (the kit sets them) |
| `profile.yaml` | Scenarios, scales (arrival rates), SLOs, timings, repetitions, variants |
| `scenarios/*.js` | k6 scripts using the kit helper `/kit/bench.js` (open model, use-case tagging, callbacks) |
| `seed/` | A deterministic data generator that prints `BENCH_DATASET_SHA256=<hex>` |
| `catalog.ext.yaml` | Optional domain metrics, each with a rationale |

Simulate cloud services with open emulators (for example moto server, ElasticMQ or MinIO). Since March 2026, LocalStack requires an account token, and its free plan is for non-commercial use only.

## Repository layout
```
docs/methodology.md   the generic method (what is measured, why, and how results are judged)
cli/                  the bench CLI (TypeScript) and its tests
core/                 pinned versions, metric catalogue, observer stack, k6 helper, callback sink
templates/target/     skeleton of a target, used to benchmark a new system
examples/hello-target self-test target: API + Redis cache + MongoDB + async worker
scripts/e2e.sh        end-to-end suite against hello-target (real Docker, ~25 min)
```

## Development
```sh
docker build --target test -f cli/Dockerfile .   # type check + unit tests
./scripts/e2e.sh                                   # end-to-end suite
```

## License
MIT
