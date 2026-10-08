// Reads from a cache-backed store, with one write in every five iterations. The item sequence is
// deterministic (iteration number), so every repetition sends the same requests.
import http from 'k6/http';
import exec from 'k6/execution';
import { bench } from '/kit/bench.js';

export const options = bench.options();

export default function () {
  const n = exec.scenario.iterationInTest;
  bench.usecase('read-item', () => {
    const res = http.get(`http://api:3000/items/${(n % 1000) + 1}`);
    bench.check(res, { 'read 200': (r) => r.status === 200 });
  });
  if (n % 5 === 0) {
    bench.usecase('create-item', () => {
      const res = http.post('http://api:3000/items', JSON.stringify({ name: `n${n}`, price: n % 100 }), { headers: { 'Content-Type': 'application/json' } });
      bench.check(res, { 'create 201': (r) => r.status === 201 });
    });
  }
}

export const handleSummary = bench.handleSummary;
