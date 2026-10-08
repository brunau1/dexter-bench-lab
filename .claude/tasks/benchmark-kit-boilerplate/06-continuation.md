# Continuation — benchmark-kit-boilerplate (deliverable A)

> Resume for the next session. Rewritten in place at every update; git history keeps earlier states.

- **Updated:** 2026-10-08 · **Phase reached:** closed (review APPROVED, ADRs written) · **Verdict:** APPROVED
- **Repo / branch:** `~/workspace/dexter-bench-lab` → `git@github-personal:brunau1/dexter-bench-lab.git` · `main` @ `b20b4d8` (+ this file) · **Pushed:** yes · **Merged:** n/a (work is on `main`; personal repo, no PR flow)
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
- [ ] Which machine is the dedicated benchmark host (CPU, RAM, on-prem or non-burstable cloud)? — user — blocks deliverable C's baseline, not B.
- [ ] Tag a kit release (e.g. `v0.1.0`) so skill B can pin it? — user — blocks B's pinning design.
- [ ] Where B's handoffs live (`~/.claude/.claude/tasks/<slug>/` in the config repo, or elsewhere)? — user — first step of B.

## Next steps
1. **Deliverable B: specialization skill.** `/research benchmark-specialization-skill`, using the umbrella `01-idea.md` section B and the open questions above. Research must define the boilerplate ↔ skill contract: how the skill fetches a pinned kit version, what it generates from `templates/target/`, how a generated project upgrades. Gate after research.
2. `/spec` → approval → `/implement` → `/review` for B, following `~/.claude/docs/development-workflow.md`. Close with B's own `06-continuation.md` and update the umbrella's.
3. **Deliverable C: pixer-nest application** (after B). Use the skill to generate the pixer-nest test project. Answer C's open questions first: the bank provider to mock, where the project lives, scales from estrelabet volumes, how the jobs process runs. Then calibrate and run the baseline on the benchmark host.

## After merge
- [x] Pushed to `origin/main`.
- [ ] Optional: tag `v0.1.0` on `b20b4d8` or later and push the tag (only on the user's request).
- [ ] Follow-ups from the review: pin the CLI to the reserved core (n3); list metrics present only in B (n4).
- [ ] Local clean-up when no longer needed: `examples/hello-target/results-e2e/` (ignored by git).

## How to resume
Paste into a new session, from `~/workspace/dexter-bench-lab`:
```
Read .claude/tasks/benchmark-kit-boilerplate/06-continuation.md, then the umbrella roadmap at
~/workspace/pixer-nest/.claude/tasks/baseline-performance-benchmark/01-idea.md (section B) and its
06-continuation.md. Deliverable A (this kit) is closed. Start deliverable B, the specialization skill:
first ask me the open questions listed in the continuation (kit release tag, where B's handoffs live),
then run /research benchmark-specialization-skill and stop at its gate. Follow my development workflow.
```
