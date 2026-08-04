/**
 * Minimal DOM helpers.
 *
 * A framework would be dead weight here: the dashboard is a handful of views
 * over data that only changes when the user acts. Hand-built nodes keep the
 * bundle tiny, the first paint immediate, and the escaping rules explicit —
 * nothing in this file ever assigns untrusted content to `innerHTML`.
 */

type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'dataset' && typeof v === 'object') {
      Object.assign(el.dataset, v as Record<string, string>);
    } else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export function svg(
  tag: string,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function mount(node: Node, ...children: Child[]): void {
  clear(node);
  append(node, children);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Human-scaled rounding. Precision beyond this is not supported by the model,
 * and showing it would imply certainty we do not have.
 */
export function roundHuman(hours: number): number {
  if (!Number.isFinite(hours)) return 0;
  if (hours >= 100) return Math.round(hours / 5) * 5;
  if (hours >= 20) return Math.round(hours);
  if (hours >= 2) return Math.round(hours * 2) / 2;
  return Math.round(hours * 10) / 10;
}

export function fmtHours(hours: number): string {
  const r = roundHuman(hours);
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

export function fmtDuration(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  if (hh === 0) return `${mm}m`;
  if (mm === 0) return `${hh}h`;
  return `${hh}h ${mm}m`;
}

/**
 * Durations that can legitimately exceed a day. "15 agents for 24 hours" is
 * 360 LLM hours, so this never wraps into days — the whole point is that the
 * number is larger than wall clock.
 */
export function fmtHoursShort(ms: number): string {
  const hours = ms / 3600000;
  if (hours >= 10) return `${Math.round(hours)}h`;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.round(ms / 60000)}m`;
}

export function fmtMultiplier(x: number): string {
  if (!Number.isFinite(x) || x <= 0) return '—';
  if (x >= 100) return `${Math.round(x)}×`;
  if (x >= 10) return `${Math.round(x)}×`;
  return `${x.toFixed(1)}×`;
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function fmtDayLong(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

export function fmtDayShort(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Epistemic tags
// ---------------------------------------------------------------------------

export type Epistemics = 'measured' | 'derived' | 'inferred' | 'estimated' | 'user-corrected';

const TAG_TITLES: Record<Epistemics, string> = {
  measured: 'Read directly from a provider file or the filesystem.',
  derived: 'Computed deterministically from measured values.',
  inferred: 'Produced by a heuristic over the available evidence.',
  estimated: 'Produced by the counterfactual estimation model. Carries a range.',
  'user-corrected': 'Set or corrected by you. Your value replaces the model.',
};

export function tag(kind: Epistemics, label?: string): HTMLElement {
  return h(
    'span',
    { class: `tag tag-${kind}`, title: TAG_TITLES[kind] },
    label ?? kind.replace('-', ' '),
  );
}

export function confidence(level: 'high' | 'medium' | 'low', score?: number): HTMLElement {
  return h(
    'span',
    {
      class: 'conf',
      'data-level': level,
      title: score !== undefined ? `Confidence score ${score.toFixed(2)} of 1.00` : undefined,
    },
    h('span', { class: 'conf-bars' }, h('i', {}), h('i', {}), h('i', {})),
    `${level} confidence`,
  );
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
}
