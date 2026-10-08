import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { kitPath } from '../config/load.js';
import type { Versions } from '../config/schema.js';

const SINK_FILES = ['Dockerfile', 'server.js'];

/** Content-addressed tag of the callback sink image: it changes only when the sink or its base changes. */
export function sinkImageTag(versions: Versions): string {
  const hash = createHash('sha256').update(versions.images.node);
  for (const file of SINK_FILES) hash.update(readFileSync(kitPath('core', 'sink', file)));
  return `dexter-bench-sink:${hash.digest('hex').slice(0, 12)}`;
}
