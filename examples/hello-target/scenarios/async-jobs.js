// Submits a job that a worker completes later and reports through a callback (BR-19).
import http from 'k6/http';
import exec from 'k6/execution';
import { bench } from '/kit/bench.js';

export const options = bench.options();

export default function () {
  bench.usecase('submit-job', () => {
    const id = `${exec.scenario.name}-${exec.scenario.iterationInTest}`;
    bench.expect(id);
    const res = http.post('http://api:3000/jobs', JSON.stringify({ id }), { headers: { 'Content-Type': 'application/json' } });
    bench.check(res, { 'queued 202': (r) => r.status === 202 });
  });
}

export const handleSummary = bench.handleSummary;
