// Display formatting helpers. Pure functions, no DOM.

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function timeAgo(iso) {
  if (!iso) return '—';
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const units = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

export function dateTime(iso) {
  return iso ? new Date(iso).toLocaleString() : '—';
}

export function duration(startIso, endIso) {
  if (!startIso) return '—';
  const ms = new Date(endIso ?? Date.now()).getTime() - new Date(startIso).getTime();
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function usd(value) {
  if (!value) return '$0';
  if (value < 0.01) return `$${value.toFixed(5)}`;
  return `$${value.toFixed(4)}`;
}

export function number(value) {
  return new Intl.NumberFormat('en').format(value ?? 0);
}

export function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function shortId(id) {
  return id.slice(0, 8);
}
