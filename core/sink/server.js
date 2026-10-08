// Callback sink (BR-19): measures asynchronous end-to-end time.
// POST /expect {id, measure}  registers an expected callback (sent by k6 just before the request)
// POST /callback[/...]        a callback from the SUT; the id is read from the body at SINK_ID_PATH
// GET  /stats                 latency percentiles (ms), timeouts and unmatched callbacks
// GET  /health
// Only expectations registered during the measurement scenario count in the statistics; warm-up
// callbacks are matched (so they are not "unmatched") but not measured.
import { createServer } from 'node:http';

const ID_PATH = (process.env.SINK_ID_PATH || 'id').split('.');
const PORT = Number(process.env.SINK_PORT || 9000);
const MAX_BODY = 1024 * 1024;

const expected = new Map(); // id -> { t0, measure }
const latencies = [];
let unmatched = 0;
let completed = 0;

function readId(body) {
  let value = body;
  for (const key of ID_PATH) {
    if (value === null || typeof value !== 'object') return undefined;
    value = value[key];
  }
  return value === undefined || value === null ? undefined : String(value);
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function stats() {
  const sorted = [...latencies].sort((a, b) => a - b);
  let timeouts = 0;
  for (const entry of expected.values()) if (entry.measure) timeouts++;
  return {
    completed,
    measured: sorted.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    timeouts,
    unmatched,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

export const server = createServer(async (req, res) => {
  const now = performance.now();
  try {
    if (req.method === 'POST' && req.url === '/expect') {
      const { id, measure } = JSON.parse(await readBody(req));
      if (id === undefined) return send(res, 400, { error: 'id is required' });
      expected.set(String(id), { t0: now, measure: measure === true });
      return send(res, 204);
    }
    if (req.method === 'POST' && (req.url === '/callback' || req.url.startsWith('/callback/'))) {
      const raw = await readBody(req);
      let id;
      try {
        id = readId(JSON.parse(raw));
      } catch {
        id = undefined;
      }
      const entry = id === undefined ? undefined : expected.get(id);
      if (!entry) {
        unmatched++;
      } else {
        expected.delete(id);
        completed++;
        if (entry.measure) latencies.push(now - entry.t0);
      }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && req.url === '/stats') return send(res, 200, stats());
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    return send(res, 404, { error: 'not found' });
  } catch (error) {
    return send(res, 400, { error: error.message });
  }
});

if (process.env.SINK_NO_LISTEN !== '1') server.listen(PORT);
