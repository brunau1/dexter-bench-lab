// Minimal system under test. ROLE=api serves HTTP; ROLE=worker processes async jobs; ROLE=seed
// generates the dataset. EXTRA_DELAY_MS slows GET /items down: the "regressed" variant of the
// sensitivity test.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { MongoClient } from 'mongodb';
import { createClient } from 'redis';

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://mongo:27017';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';
const CALLBACK_URL = process.env.CALLBACK_URL ?? 'http://sink:9000/callback/jobs';
const EXTRA_DELAY_MS = Number(process.env.EXTRA_DELAY_MS ?? 0);
const ITEMS = 1000;

const mongo = new MongoClient(MONGO_URL, { maxPoolSize: 20 });
const db = mongo.db('hello');
const items = db.collection('items');

/** Deterministic PRNG (mulberry32): same seed, same dataset (BR-3). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seed() {
  const random = mulberry32(Number(process.env.BENCH_SEED ?? 1));
  const docs = Array.from({ length: ITEMS }, (_, i) => ({
    _id: i + 1,
    name: `item-${Math.floor(random() * 1e9).toString(36)}`,
    price: Math.round(random() * 100_000) / 100,
  }));
  await mongo.connect();
  await items.deleteMany({});
  await db.collection('jobs').deleteMany({});
  await items.insertMany(docs, { ordered: true });
  const stored = await items.find({}).sort({ _id: 1 }).toArray();
  const digest = createHash('sha256').update(JSON.stringify(stored)).digest('hex');
  console.log(`seeded ${stored.length} items`);
  console.log(`BENCH_DATASET_SHA256=${digest}`);
  await mongo.close();
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function api() {
  const redis = createClient({ url: REDIS_URL });
  await Promise.all([mongo.connect(), redis.connect()]);
  let nextId = ITEMS + 1;

  createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
      const item = /^\/items\/(\d+)$/.exec(req.url ?? '');
      if (req.method === 'GET' && item) {
        if (EXTRA_DELAY_MS > 0) await sleep(EXTRA_DELAY_MS);
        const key = `item:${item[1]}`;
        const cached = await redis.get(key);
        if (cached) return send(res, 200, JSON.parse(cached));
        const doc = await items.findOne({ _id: Number(item[1]) });
        if (!doc) return send(res, 404, { error: 'not found' });
        await redis.set(key, JSON.stringify(doc), { EX: 60 });
        return send(res, 200, doc);
      }
      if (req.method === 'POST' && req.url === '/items') {
        const body = await readJson(req);
        const doc = { _id: nextId++, name: String(body.name ?? 'new'), price: Number(body.price ?? 0) };
        await items.insertOne(doc);
        await redis.del(`item:${doc._id}`);
        return send(res, 201, { id: doc._id });
      }
      if (req.method === 'POST' && req.url === '/jobs') {
        const body = await readJson(req);
        if (!body.id) return send(res, 400, { error: 'id is required' });
        await redis.lPush('jobs', JSON.stringify({ id: String(body.id) }));
        return send(res, 202, { queued: true });
      }
      return send(res, 404, { error: 'not found' });
    } catch (error) {
      return send(res, 500, { error: error.message });
    }
  }).listen(3000);
}

async function worker() {
  const redis = createClient({ url: REDIS_URL });
  await Promise.all([mongo.connect(), redis.connect()]);
  const jobs = db.collection('jobs');
  for (;;) {
    const next = await redis.brPop('jobs', 0);
    const job = JSON.parse(next.element);
    await jobs.insertOne({ jobId: job.id, doneAt: new Date() });
    await fetch(CALLBACK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { id: job.id } }) }).catch(
      (error) => console.error(`callback for ${job.id} failed: ${error.message}`),
    );
  }
}

const roles = { api, worker, seed };
const role = roles[process.env.ROLE ?? 'api'];
if (!role) throw new Error(`unknown ROLE ${process.env.ROLE}`);
role().catch((error) => {
  console.error(error);
  process.exit(1);
});
