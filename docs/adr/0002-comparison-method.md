# 0002. Compare versions per repetition with a bootstrap CI, Mann-Whitney U and a calibrated noise floor

- **Status:** Accepted · **Date:** 2026-10-08 · **Deciders:** kit owner (Brunau1)
- **Origin:** user rule: benchmarks follow scientific method, every metric and choice justified · **PR:** `main` of dexter-bench-lab · **Task:** `benchmark-kit-boilerplate`

> In the context of **deciding whether a change made a system faster or cheaper**, facing **non-normal latency data, few repetitions, host drift and ~100 metrics per comparison**, we decided for **one value per repetition, the ratio of medians with a seeded 95 % percentile bootstrap, a two-sided Mann-Whitney U and a per-host-class A/A noise floor, all three required for a verdict**, and against **per-request statistics, t-tests and CI-only decisions**, to achieve **few false "we gained X %" claims**, accepting **that small effects need more repetitions to be detected**.

## Context and trigger
- Requests inside one repetition share caches and GC, so they are not independent (Kalibera & Jones); 5 repetitions are too few to test normality.
- A comparison tests every metric of every container: at α = 0.05 some pass by chance.

## Decision
- **Unit:** one aggregated value per valid repetition (≥ 3, default 5); ABBA interleaving of variants (BR-4, BR-16).
- **Stability:** CV ≤ 5 % stable, ≤ 10 % acceptable, > 10 % unstable → no verdict (BR-5).
- **Effect:** ratio of medians B/A, 95 % percentile bootstrap, 10 000 resamples, seeded xoshiro128** (reports byte-identical) (BR-6, BR-18).
- **Test:** two-sided Mann-Whitney U; exact when n ≤ 20 per side and no ties, else normal approximation with tie and continuity corrections (as scipy).
- **Verdict:** improved/regressed (changed ↑/↓ for neutral metrics) only if CI excludes 1, p < 0.05 and |ratio − 1| > noise floor; `inconclusive` for unstable/invalid sides; `withheld` (never "no change") on smoke-only hosts, across host classes or CPU units (BR-7, BR-10, BR-11).
- **Noise floor:** `bench calibrate` A/A run; floor = max distance of the A/A CI bounds from 1, stored per host class and CPU unit; an invalid A/A run is never written (BR-8).
- **Where:** `cli/src/stats/*`, `cli/src/compare/compare.ts`, `cli/src/commands/calibrate.ts`; rules in `docs/methodology.md` §5–§6.

## Options considered
| Option | Verdict | Why |
|--------|---------|-----|
| Per-repetition values + bootstrap + Mann-Whitney + noise floor | ✅ | Distribution-free, honest about small n, guards against chance |
| Per-request samples as the unit | ❌ | Dependence inflates significance |
| Welch t-test | ❌ | Assumes normality that latency data rarely has |
| CI only (Kalibera & Jones) | ❌ | Less conservative with ~100 metrics |
| Statistics library dependency | ❌ | ~150 lines in-house, seeded, validated against scipy |

## Consequences
- **Good:** verdicts reproducible byte for byte; the e2e suite detects an injected 20 ms delay (p50 ×14.6, p = 0.029) and keeps the A/A false-positive share ≤ 15 %.
- **Accepted costs:** with 4–5 repetitions only clearly separated effects reach p < 0.05; tail percentiles are often unstable on small hosts.
- **Risks / follow-ups:** no family-wise correction — decide primary metrics before a run (methodology §5.4); revisit if verdicts must cover many correlated metrics.
