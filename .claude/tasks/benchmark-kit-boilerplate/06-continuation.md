# Continuation — benchmark-kit-boilerplate (deliverable A)

> Resume for the next session. Rewritten in place at every update; git history keeps earlier states.

- **Updated:** 2026-10-09 · **Phase reached:** closed (review APPROVED, ADRs written) · **Verdict:** APPROVED
- **Repo / branch:** `~/workspace/dexter-bench-lab` → `git@github-personal:brunau1/dexter-bench-lab.git` · `main` @ `242acb1` · **Release:** `v0.1.0` (annotated tag on `242acb1`, pushed) · **Pushed:** yes · **Merged:** n/a (work is on `main`; personal repo, no PR flow)
- **Umbrella:** `~/workspace/pixer-nest/.claude/tasks/baseline-performance-benchmark/` (`01-idea.md` = the roadmap A → B → C; `06-continuation.md` = roadmap state, local only)

## Where things are
| What | Path |
|------|------|
| Handoffs of A | `.claude/tasks/benchmark-kit-boilerplate/02-research.md`, `03-spec.md` (APPROVED + amendments in its Status line), `04-review.md` |
| Generic method | `docs/methodology.md` (rule index BR-1…BR-19 at the end) |
| Decisions | `docs/adr/0001-containerized-measurement-stack.md`, `docs/adr/0002-comparison-method.md` |
| CLI | `cli/src/` (`run/execute.ts` lifecycle, `stats/`, `compare/`, `host/`, `metrics/`), wrapper `./bench` |
| Kit assets | `core/` (pinned `versions.yaml`, `metrics/catalog.yaml`, `observers/`, `k6/bench.js`, `sink/`) |
| Extension points for skill B | `templates/target/` (target.yaml, profile.yaml, compose.yaml, scenarios/, seed/, catalog.ext.yaml) |
| Self-test target | `examples/hello-target/` (profile.yaml, profile.ab.yaml) |

## Done
- MD-1…MD-10 delivered and reviewed (26 commits on `main` up to `b20b4d8`). Unit suite 151 passed; `scripts/e2e.sh` 6/6 on the final code (full matrix, A/A calibration, determinism, 20 ms delay detected at p50 ×14.6, no egress, missing-image refusal).
- Review fixes: interruption teardown (`--init`, signal handling, label sweep), warm-up-free range queries, `withheld` verdict, `cpuUnit` switch, fresh target compose project per repetition (cAdvisor stale-series bug).

## Decisions that bind what comes next
- Results are relative, never production predictions (methodology §1; ADR 0001).
- Official baselines only on a dedicated, sized host; laptops are smoke-only (BR-9, BR-10; user, 2026-10-08).
- `cpuUnit: logical` by default, like cloud vCPUs (user, 2026-10-08; BR-9, BR-11).
- Statistics policy: 5 reps, CV 5 % / 10 %, ABBA, bootstrap CI + Mann-Whitney + noise floor (ADR 0002).
- Skill B lives in global `~/.claude/skills/`, loads a pinned kit version, never forks the core (umbrella idea, section B).
- No LocalStack for company targets (auth token + non-commercial free plan since 2026-03): moto server / ElasticMQ / MinIO.
- Handoffs in this repo are committed (user decision); license MIT.

## Environment and prerequisites
- Host needs Docker ≥ 24 + Compose ≥ 2.24 (user in the `docker` group) and git; nothing else.
- This laptop (i7-1165G7, 4c/8t, 15 GiB): Docker 29.4.3, Compose 5.1.3; classified smoke-only (governor `powersave`, ~1.3 GiB swap in use).
- Run `bench` from the directory holding the target: only the current directory is mounted into the CLI container. Results go to `results/` there.
- Personal repo: commit as `Brunau1 <46985145+brunau1@users.noreply.github.com>` (already in the local git config); push over the `github-personal` SSH alias. `gh` is not installed.
- Foreground `sleep` is blocked in agent sessions: long waits go through background tasks.

## Open questions
- [x] Benchmark host (user, 2026-10-08): probably a local 8c/16t 3.2 GHz, 35 GB RAM machine under WSL + Docker; cloud hosts should stay easy to set up. **v0.1.0 classifies WSL as smoke-only** (no cpufreq → the required governor check fails), so a kit change is needed before C's baseline; options in B's research.
- [x] B's handoffs: `~/.claude/.claude/tasks/benchmark-specialization-skill/` (local only, not synced).

## Next steps
1. **Deliverable B is at its research gate.** Its state, the four open decisions (kit access, kit `v0.2.0` scope, naming the kit in the skill, skill name) and the next command live in `~/.claude/.claude/tasks/benchmark-specialization-skill/06-continuation.md` (local to this laptop).
2. Likely kit work coming from B (to be decided at B's gate): governor `unverifiable` + operator attestation on VM/WSL/cloud hosts (ADR 0003, methodology §6), `docs/host-setup.md`, per-version CLI image tag, `CHANGELOG.md`, project entry point under `templates/project/`.
3. **Deliverable C: pixer-nest application** (after B). Answer C's open questions first (bank provider to mock, where the project lives, scales from estrelabet volumes, how the jobs process runs), then calibrate and run the baseline on the benchmark host.

## After merge
- [x] Pushed to `origin/main`.
- [x] Tagged `v0.1.0` on `242acb1` and pushed the tag (2026-10-08).
- [ ] Follow-ups from the review: pin the CLI to the reserved core (n3); list metrics present only in B (n4).
- [ ] Local clean-up when no longer needed: `examples/hello-target/results-e2e/` (ignored by git).

## How to resume
Paste into a new session, from `~/workspace/dexter-bench-lab`:
```
Read ~/.claude/.claude/tasks/benchmark-specialization-skill/06-continuation.md, then its 02-research.md,
and the umbrella ~/workspace/pixer-nest/.claude/tasks/baseline-performance-benchmark/06-continuation.md.
Deliverable B (the benchmark specialization skill) is at the research gate. First ask me the four open
questions listed in the continuation, record my answers, then run /spec benchmark-specialization-skill
and stop at its approval gate. Follow my development workflow.
```
