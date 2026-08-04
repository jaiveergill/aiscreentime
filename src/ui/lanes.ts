import { fmtTime, h } from './dom.ts';
import type { StripData } from './strip.ts';

/**
 * Lane timeline.
 *
 * Five lanes that mean something — you, each provider, verification, commits —
 * rather than one anonymous row per session. Fourteen `CH 0n` rows showed the
 * concurrency honestly but read as noise; this answers the question people
 * actually ask of a day ("when was I involved, and what were the agents doing
 * while I wasn't?") at a glance.
 *
 * Concurrency is not lost: it moves to the count badge on each provider lane
 * and stays available in full on the Timeline view.
 */

export interface LaneOptions {
  readonly onSelectTask: (taskId: string) => void;
  readonly selectedTaskId?: string | null;
  readonly compact?: boolean;
}

interface LaneSpec {
  key: string;
  label: string;
  colour: string;
  /** Rendered as dots rather than bars. */
  point?: boolean;
}

const LANES: LaneSpec[] = [
  { key: 'steering', label: 'Steering', colour: 'var(--human)' },
  { key: 'claude-code', label: 'Claude Code', colour: 'var(--trace)' },
  { key: 'codex', label: 'Codex', colour: 'var(--info)' },
  { key: 'verify', label: 'Tests / builds', colour: 'var(--verified)', point: true },
  { key: 'fail', label: 'Failures', colour: 'var(--fail)', point: true },
];

export function renderLanes(data: StripData, opts: LaneOptions): HTMLElement {
  const stamps: number[] = [];
  for (const [a, b] of data.steering) stamps.push(a, b);
  for (const a of data.agents) stamps.push(a.start, a.end);
  for (const t of data.tasks) stamps.push(t.startedAt, t.endedAt);

  if (stamps.length === 0) {
    return h(
      'p',
      {
        class: 'faint',
        style: { fontSize: '13px', textAlign: 'center', padding: '28px 0', margin: 0 },
      },
      'Nothing recorded for this day yet.',
    );
  }

  const tMin = Math.min(...stamps);
  const tMax = Math.max(...stamps);
  const span = Math.max(60_000, tMax - tMin);
  const left = (t: number): number => ((t - tMin) / span) * 100;
  const width = (a: number, b: number): number => Math.max(0.3, ((b - a) / span) * 100);

  // Which provider does each session belong to? Tasks carry the mapping.
  const providerOf = new Map<string, string>();
  for (const t of data.tasks) {
    for (const sid of t.sessionIds) providerOf.set(sid, t.providers[0] ?? 'claude-code');
  }

  const sel = opts.selectedTaskId ?? null;

  const barsFor = (spec: LaneSpec): HTMLElement[] => {
    if (spec.key === 'steering') {
      return data.steering.map(([a, b]) =>
        h('div', {
          class: 'lane-bar',
          style: {
            left: `${left(a)}%`,
            width: `${width(a, b)}%`,
            background: spec.colour,
            opacity: '0.85',
          },
          title: `You were steering ${fmtTime(a)} – ${fmtTime(b)}`,
        }),
      );
    }

    if (spec.key === 'claude-code' || spec.key === 'codex') {
      // Task bars first (clickable, meaningful), then faint runtime underneath.
      const tasks = data.tasks.filter((t) => (t.providers[0] ?? 'claude-code') === spec.key);
      const runtime = data.agents.filter((a) => (providerOf.get(a.sessionId) ?? '') === spec.key);
      return [
        ...runtime.map((a) =>
          h('div', {
            class: 'lane-bar',
            style: {
              left: `${left(a.start)}%`,
              width: `${width(a.start, a.end)}%`,
              background: spec.colour,
              opacity: '0.16',
              height: '4px',
              pointerEvents: 'none',
            },
          }),
        ),
        ...tasks.map((t) => {
          const bad = ['failed', 'reverted', 'abandoned'].includes(t.status);
          const good = t.status === 'completed-validated';
          return h('button', {
            class: `lane-bar${sel && sel !== t.taskId ? ' dim' : ''}`,
            style: {
              left: `${left(t.startedAt)}%`,
              width: `${width(t.startedAt, t.endedAt)}%`,
              background: good ? 'var(--verified)' : bad ? 'var(--fail)' : spec.colour,
              opacity: bad ? '0.5' : '0.9',
            },
            title: `${t.title}\n${fmtTime(t.startedAt)} – ${fmtTime(t.endedAt)} · ${t.status}`,
            'aria-label': `${t.title}, ${t.status}`,
            onclick: () => opts.onSelectTask(t.taskId),
          });
        }),
      ];
    }

    const wantPass = spec.key === 'verify';
    return data.markers
      .filter((m) =>
        wantPass
          ? m.kind === 'test.run' || m.kind === 'build.run'
          : m.outcome === 'fail' || m.kind === 'user.interrupt',
      )
      .slice(0, 300)
      .map((m) =>
        h('div', {
          class: 'lane-bar point',
          style: {
            left: `${left(m.ts)}%`,
            background: wantPass && m.outcome === 'fail' ? 'var(--fail)' : spec.colour,
            opacity: '0.85',
          },
          title: `${m.kind.replace('.', ' ')}${m.outcome ? ` · ${m.outcome}` : ''} at ${fmtTime(m.ts)}`,
        }),
      );
  };

  const ticks: number[] = [];
  for (let i = 0; i < 7; i++) ticks.push(tMin + (span * i) / 6);

  const lanes = LANES.map((spec) => {
    const bars = barsFor(spec);
    return h(
      'div',
      { class: 'lane' },
      h('span', { class: 'lane-name' }, h('i', { style: { background: spec.colour } }), spec.label),
      h('div', { class: 'lane-track' }, ...bars),
    );
  });

  return h(
    'div',
    { class: 'lanes' },
    h('div', { class: 'lane-axis' }, ...ticks.map((t) => h('span', {}, fmtTime(t)))),
    ...lanes,
  );
}
