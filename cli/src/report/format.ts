/** Human formatting of a metric value by its catalogue unit. */
export function formatValue(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  switch (unit) {
    case 'bytes': {
      const abs = Math.abs(value);
      if (abs >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
      if (abs >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
      if (abs >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
      return `${value.toFixed(0)} B`;
    }
    case 'bytes/s':
      return `${formatValue(value, 'bytes')}/s`;
    case 'ratio':
      return `${(value * 100).toFixed(2)}%`;
    case 'cores':
      return value.toFixed(3);
    case 'count':
      return Number.isInteger(value) ? String(value) : value.toFixed(1);
    default:
      return Math.abs(value) >= 100 ? value.toFixed(1) : Math.abs(value) >= 1 ? value.toFixed(2) : value.toPrecision(3);
  }
}

export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** Markdown table; cells are escaped for pipes. */
export function table(header: string[], rows: string[][]): string {
  const esc = (cell: string) => cell.replaceAll('|', '\\|');
  return [`| ${header.map(esc).join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
}

export const HEADLINE_CAVEAT =
  '> **Results are relative.** They compare versions measured on the same host class. They are not predictions of production behaviour (docs/methodology.md §1, §8).';
