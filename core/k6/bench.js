// dexter-bench-lab k6 helper. Scenario scripts import it as '/kit/bench.js'.
//
// - options(): open-model load only (BR-1): a `warmup` scenario followed by a `measure` scenario at
//   the same arrival rate. Every catalogue number comes from the `measure` scenario (BR-2).
// - usecase(name, fn): tags every request made inside fn with its use case.
// - check(res, checks): k6 check + records the `bench_errors` rate (failed check, HTTP >= 400 or
//   transport error). Call it for every response that matters.
// - expect(id): registers an asynchronous callback with the sink before sending the request (BR-19).
// - handleSummary: writes the full summary JSON where the kit reads it.
import http from 'k6/http';
import exec from 'k6/execution';
import { check as k6check } from 'k6';
import { Gauge, Rate } from 'k6/metrics';

const env = __ENV;
const benchErrors = new Rate('bench_errors');
// Unix ms at which the measurement scenario started: the kit derives the measurement window from it (BR-2).
const measureStart = new Gauge('bench_measure_start_ms');
const SINK_URL = env.BENCH_SINK_URL || 'http://sink:9000';
const INTERNAL = { tags: { usecase: '__bench_internal__' } };

function required(name) {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`missing ${name}: run scenarios through the bench CLI`);
  return value;
}

function ms(name) {
  return `${Number(required(name))}ms`;
}

function options() {
  const rate = Number(required('BENCH_RATE'));
  const usecases = required('BENCH_USECASES').split(',');
  const load = {
    executor: 'constant-arrival-rate',
    rate,
    timeUnit: '1s',
    preAllocatedVUs: Number(required('BENCH_PRE_VUS')),
    maxVUs: Number(required('BENCH_MAX_VUS')),
    gracefulStop: ms('BENCH_COOLDOWN_MS'),
  };
  // Always-true thresholds make k6 report these submetrics in the summary.
  const thresholds = { 'dropped_iterations{scenario:measure}': ['count>=0'] };
  for (const usecase of usecases) {
    const tags = `{scenario:measure,usecase:${usecase}}`;
    thresholds[`http_req_duration${tags}`] = ['max>=0'];
    thresholds[`http_reqs${tags}`] = ['count>=0'];
    thresholds[`bench_errors${tags}`] = ['rate>=0'];
  }
  return {
    discardResponseBodies: false,
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'count'],
    scenarios: {
      warmup: { ...load, duration: ms('BENCH_WARMUP_MS') },
      measure: { ...load, duration: ms('BENCH_DURATION_MS'), startTime: ms('BENCH_WARMUP_MS') },
    },
    thresholds,
  };
}

function usecase(name, fn) {
  if (exec.scenario.name === 'measure') measureStart.add(exec.scenario.startTime);
  const tags = exec.vu.metrics.tags;
  tags.usecase = name;
  try {
    return fn();
  } finally {
    delete tags.usecase;
  }
}

function check(res, checks) {
  const passed = k6check(res, checks);
  benchErrors.add(!passed || res.error_code !== 0 || res.status >= 400);
  return passed;
}

function expect(id) {
  const res = http.post(
    `${SINK_URL}/expect`,
    JSON.stringify({ id: String(id), measure: exec.scenario.name === 'measure' }),
    { headers: { 'Content-Type': 'application/json' }, ...INTERNAL },
  );
  if (res.status !== 204) throw new Error(`sink rejected expect(${id}): HTTP ${res.status}`);
}

function handleSummary(data) {
  return {
    [required('BENCH_SUMMARY_PATH')]: JSON.stringify(data),
    stdout: `k6 finished: ${data.metrics.iterations ? data.metrics.iterations.values.count : 0} iterations\n`,
  };
}

export const bench = { options, usecase, check, expect, handleSummary };
