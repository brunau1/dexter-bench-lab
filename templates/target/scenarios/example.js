// One use case per scenario file. The kit helper builds the open-model options from the profile
// (BR-1), tags every request with its use case and records failed checks as errors.
import http from 'k6/http';
import { check } from 'k6';
import { bench } from '/kit/bench.js';

export const options = bench.options();

export default function () {
  bench.usecase('read-item', () => {
    const id = Math.floor(Math.random() * 1000);
    const res = http.get(`http://api:3000/items/${id}`);
    bench.check(res, { 'status is 200': (r) => r.status === 200 });
  });
}

export const handleSummary = bench.handleSummary;
