import { spawn, type ChildProcess } from 'node:child_process';
import { aggregate, type Samples } from './aggregate.js';
import type { MetricSample } from './sample.js';

/**
 * Fallback container collector (§8): used when cAdvisor cannot read the host's cgroup layout.
 * It streams `docker stats` and maps it to the catalogue ids it can honestly cover:
 * CPU, memory, network and block I/O. Throttling and OOM events are not available here.
 */
export const FALLBACK_METRICS = [
  'cpu_cores_avg',
  'cpu_cores_p95',
  'mem_working_set_avg',
  'mem_working_set_max',
  'mem_limit_ratio_max',
  'net_rx_bps',
  'net_tx_bps',
  'blkio_read_bps',
  'blkio_write_bps',
] as const;

interface StatsLine {
  ID: string;
  CPUPerc: string;
  MemUsage: string;
  MemPerc: string;
  NetIO: string;
  BlockIO: string;
}

export interface StatsPoint {
  t: number;
  cpuCores: number;
  memBytes: number;
  memLimitRatio: number;
  netRx: number;
  netTx: number;
  blkRead: number;
  blkWrite: number;
}

const UNITS: Record<string, number> = {
  B: 1,
  kB: 1e3,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
};

/** Parses docker's human sizes: `1.5MiB` (binary) or `3.4kB` (decimal). */
export function parseSize(value: string): number {
  const match = /^([\d.]+)\s*([A-Za-z]+)$/.exec(value.trim());
  if (!match || !(match[2]! in UNITS)) throw new Error(`unrecognized size "${value}"`);
  return Number(match[1]) * UNITS[match[2]!]!;
}

function pair(value: string): [number, number] {
  const [left, right] = value.split('/').map((part) => parseSize(part));
  return [left!, right!];
}

/** Parses one `docker stats --format '{{json .}}'` line (stream mode prefixes ANSI clear codes). */
export function parseStatsLine(line: string, t: number): { id: string; point: StatsPoint } | null {
  const json = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
  if (!json.startsWith('{')) return null;
  const stats = JSON.parse(json) as StatsLine;
  if (stats.CPUPerc === '--') return null; // container starting or stopping
  const [memBytes] = pair(stats.MemUsage);
  const [netRx, netTx] = pair(stats.NetIO);
  const [blkRead, blkWrite] = pair(stats.BlockIO);
  return {
    id: stats.ID,
    point: {
      t,
      cpuCores: Number.parseFloat(stats.CPUPerc) / 100,
      memBytes,
      memLimitRatio: Number.parseFloat(stats.MemPerc) / 100,
      netRx,
      netTx,
      blkRead,
      blkWrite,
    },
  };
}

/** Aggregates the stream of each container into per-repetition samples, keyed by compose service. */
export function aggregateStats(points: Map<string, StatsPoint[]>, services: Map<string, string>, window: { start: number; end: number }): MetricSample[] {
  const samples: MetricSample[] = [];
  for (const [id, series] of points) {
    const subject = services.get(id);
    if (!subject) continue;
    const of = (pick: (p: StatsPoint) => number): Samples => series.map((p) => [p.t, pick(p)]);
    const values: Record<(typeof FALLBACK_METRICS)[number], number | null> = {
      cpu_cores_avg: aggregate(of((p) => p.cpuCores), 'avg', window),
      cpu_cores_p95: aggregate(of((p) => p.cpuCores), 'p95', window),
      mem_working_set_avg: aggregate(of((p) => p.memBytes), 'avg', window),
      mem_working_set_max: aggregate(of((p) => p.memBytes), 'max', window),
      mem_limit_ratio_max: aggregate(of((p) => p.memLimitRatio), 'max', window),
      net_rx_bps: aggregate(of((p) => p.netRx), 'rate', window),
      net_tx_bps: aggregate(of((p) => p.netTx), 'rate', window),
      blkio_read_bps: aggregate(of((p) => p.blkRead), 'rate', window),
      blkio_write_bps: aggregate(of((p) => p.blkWrite), 'rate', window),
    };
    for (const metric of FALLBACK_METRICS) {
      const value = values[metric];
      if (value !== null) samples.push({ metric, subject, key: '', value });
    }
  }
  return samples;
}

/** Streams `docker stats` for the given containers until stopped. */
export class DockerStatsSampler {
  private readonly points = new Map<string, StatsPoint[]>();
  private child: ChildProcess | null = null;
  private buffer = '';

  start(containerIds: string[]): void {
    if (containerIds.length === 0) return;
    this.child = spawn('docker', ['stats', '--format', '{{json .}}', ...containerIds], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      const t = Date.now() / 1000;
      for (const line of lines) {
        const parsed = parseStatsLine(line, t);
        if (!parsed) continue;
        const series = this.points.get(parsed.id) ?? [];
        series.push(parsed.point);
        this.points.set(parsed.id, series);
      }
    });
  }

  /** Stops the stream and returns everything sampled, keyed by short container id. */
  async stop(): Promise<Map<string, StatsPoint[]>> {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        child.once('close', () => resolve());
        child.kill('SIGTERM');
      });
    }
    return this.points;
  }
}
