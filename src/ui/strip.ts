import { fmtTime, h, svg } from './dom.ts';

/**
 * The strip chart — the signature visualisation.
 *
 * One shared time axis. The top channel is you; every channel below is an agent
 * session. Amber is the machine, white is you, green means the task ended
 * validated, red means it did not survive.
 *
 * The point it makes in one glance: a single white channel, intermittently
 * active, driving many amber channels that are busy simultaneously. That is the
 * product's entire thesis, drawn rather than asserted.
 */

export interface StripTask {
  taskId: string;
  title: string;
  startedAt: number;
  endedAt: number;
  status: string;
  category: string;
  sessionIds: string[];
  providers: string[];
  repoId: string | null;
}

export interface StripAgent {
  sessionId: string;
  start: number;
  end: number;
  measured: boolean;
}

export interface StripMarker {
  taskId: string;
  ts: number;
  kind: string;
  outcome: string | null;
}

export interface StripData {
  from: number;
  to: number;
  steering: [number, number][];
  agents: StripAgent[];
  concurrency: { ts: number; activeAgents: number }[];
  markers: StripMarker[];
  tasks: StripTask[];
  peak: number;
}

export interface StripOptions {
  onSelect: (taskId: string | null) => void;
  selectedTaskId: string | null;
  maxChannels?: number;
}

export function renderStrip(data: StripData, opts: StripOptions): HTMLElement {
  // Bound the axis to observed activity so an empty night does not squash the
  // day into a sliver.
  const stamps: number[] = [];
  for (const [a, b] of data.steering) stamps.push(a, b);
  for (const a of data.agents) stamps.push(a.start, a.end);
  for (const t of data.tasks) stamps.push(t.startedAt, t.endedAt);

  if (stamps.length === 0) {
    return h(
      'div',
      { class: 'strip' },
      h(
        'div',
        { class: 'empty', style: { border: 'none' } },
        h('h3', {}, 'Nothing recorded for this day'),
        h('p', {}, 'Once Claude Code or Codex writes a session, its trace appears here.'),
      ),
    );
  }

  const tMin = Math.min(...stamps);
  const tMax = Math.max(...stamps);
  const span = Math.max(60_000, tMax - tMin);
  const pct = (t: number): number => ((t - tMin) / span) * 100;
  const width = (a: number, b: number): number => Math.max(0.35, ((b - a) / span) * 100);

  // ---- channels ---------------------------------------------------------
  // One channel per session, ordered by first activity so the chart reads
  // top-to-bottom in the order work started.
  const bySession = new Map<string, StripAgent[]>();
  for (const a of data.agents) {
    const arr = bySession.get(a.sessionId);
    if (arr) arr.push(a);
    else bySession.set(a.sessionId, [a]);
  }
  const sessionOrder = [...bySession.entries()]
    .map(([sid, spans]) => ({ sid, first: Math.min(...spans.map((s) => s.start)), spans }))
    .sort((x, y) => x.first - y.first);

  const maxChannels = opts.maxChannels ?? 14;
  const shown = sessionOrder.slice(0, maxChannels);
  const overflow = sessionOrder.length - shown.length;

  const taskBySession = new Map<string, StripTask[]>();
  for (const t of data.tasks) {
    for (const sid of t.sessionIds) {
      const arr = taskBySession.get(sid);
      if (arr) arr.push(t);
      else taskBySession.set(sid, [t]);
    }
  }

  const selected = opts.selectedTaskId;
  const selectedSessions = new Set(
    selected ? (data.tasks.find((t) => t.taskId === selected)?.sessionIds ?? []) : [],
  );

  // ---- axis -------------------------------------------------------------
  const tickCount = 7;
  const ticks: number[] = [];
  for (let i = 0; i < tickCount; i++) ticks.push(tMin + (span * i) / (tickCount - 1));

  const axis = h('div', { class: 'strip-axis' }, ...ticks.map((t) => h('span', {}, fmtTime(t))));

  const gridlines = ticks
    .slice(1, -1)
    .map((t) => h('div', { class: 'strip-gridline', style: { left: `${pct(t)}%` } }));

  // ---- human channel ----------------------------------------------------
  const humanTrack = h(
    'div',
    { class: 'strip-track' },
    ...data.steering.map(([a, b]) =>
      h('div', {
        class: 'strip-bar',
        style: { left: `${pct(a)}%`, width: `${width(a, b)}%` },
        title: `Steering ${fmtTime(a)} – ${fmtTime(b)}`,
      }),
    ),
  );

  const humanRow = h(
    'div',
    { class: 'strip-row human' },
    h('div', { class: 'strip-label' }, 'You'),
    humanTrack,
  );

  // ---- agent channels ---------------------------------------------------
  const channelRows = shown.map((ch, i) => {
    const tasks = taskBySession.get(ch.sid) ?? [];
    const label = `CH ${String(i + 1).padStart(2, '0')}`;
    const provider = tasks[0]?.providers?.[0] ?? '';

    const bars = tasks.map((t) => {
      const isSel = selected === t.taskId;
      const dim = selected !== null && !isSel;
      return h('button', {
        class: `strip-bar st-${t.status}${dim ? ' dimmed' : ''}${isSel ? ' selected' : ''}`,
        style: {
          left: `${pct(t.startedAt)}%`,
          width: `${width(t.startedAt, t.endedAt)}%`,
          animationDelay: `${Math.min(240, i * 26)}ms`,
        },
        title: `${t.title}\n${fmtTime(t.startedAt)} – ${fmtTime(t.endedAt)}\n${t.status}`,
        'aria-label': `${t.title}, ${t.status}`,
        onclick: (e: Event) => {
          e.stopPropagation();
          opts.onSelect(isSel ? null : t.taskId);
        },
      });
    });

    // Runtime spans the agent was active but no task claimed — still evidence
    // the channel was busy.
    const runtime = ch.spans.map((s) =>
      h('div', {
        class: 'strip-bar',
        style: {
          left: `${pct(s.start)}%`,
          width: `${width(s.start, s.end)}%`,
          height: '3px',
          opacity: selected && !selectedSessions.has(ch.sid) ? '0.08' : '0.22',
          background: 'var(--trace)',
          pointerEvents: 'none',
        },
      }),
    );

    const markers = data.markers
      .filter((m) => {
        const t = data.tasks.find((x) => x.taskId === m.taskId);
        return t?.sessionIds.includes(ch.sid);
      })
      .slice(0, 120)
      .map((m) =>
        h('span', {
          class: `strip-marker ${
            m.kind === 'user.interrupt' ? 'interrupt' : m.outcome === 'fail' ? 'fail' : 'pass'
          }`,
          style: { left: `${pct(m.ts)}%` },
          title: `${m.kind}${m.outcome ? ` · ${m.outcome}` : ''} at ${fmtTime(m.ts)}`,
        }),
      );

    return h(
      'div',
      { class: 'strip-row' },
      h('div', { class: 'strip-label', title: `${ch.sid} · ${provider}` }, label),
      h('div', { class: 'strip-track' }, ...runtime, ...bars, ...markers),
    );
  });

  // ---- concurrency footer ------------------------------------------------
  const conc = renderConcurrency(data.concurrency, tMin, span, data.peak);

  const legend = h(
    'div',
    { class: 'strip-legend' },
    h('span', {}, h('i', { style: { background: 'var(--human)' } }), 'You steering'),
    h('span', {}, h('i', { style: { background: 'var(--trace)' } }), 'Agent working'),
    h('span', {}, h('i', { style: { background: 'var(--verified)' } }), 'Validated'),
    h('span', {}, h('i', { style: { background: 'var(--fail)' } }), 'Failed or reverted'),
    h('span', {}, h('i', { style: { background: 'var(--info)' } }), 'Exploratory'),
    overflow > 0 ? h('span', { class: 'faint' }, `+${overflow} more channels`) : null,
  );

  return h(
    'div',
    { class: 'strip', onclick: () => opts.onSelect(null) },
    axis,
    h('div', { class: 'strip-body' }, ...gridlines, humanRow, ...channelRows),
    conc,
    legend,
  );
}

function renderConcurrency(
  samples: { ts: number; activeAgents: number }[],
  tMin: number,
  span: number,
  peak: number,
): HTMLElement {
  const W = 1000;
  const H = 46;
  const maxY = Math.max(1, peak);

  // Step function: concurrency changes instantly, so the path must too.
  let d = `M 0 ${H}`;
  let prevX = 0;
  let prevY = H;
  for (const s of samples) {
    const x = ((s.ts - tMin) / span) * W;
    const y = H - (s.activeAgents / maxY) * (H - 4);
    if (x < 0 || x > W) continue;
    d += ` L ${x.toFixed(1)} ${prevY.toFixed(1)} L ${x.toFixed(1)} ${y.toFixed(1)}`;
    prevX = x;
    prevY = y;
  }
  d += ` L ${W} ${prevY.toFixed(1)} L ${W} ${H} Z`;
  void prevX;

  return h(
    'div',
    { class: 'strip-conc' },
    h(
      'div',
      { class: 'row spread', style: { marginBottom: '4px' } },
      h('span', { class: 'eyebrow' }, 'Concurrent agents'),
      h('span', { class: 'eyebrow' }, `peak ${peak}`),
    ),
    svg(
      'svg',
      {
        viewBox: `0 0 ${W} ${H}`,
        preserveAspectRatio: 'none',
        role: 'img',
        'aria-label': `Concurrency over the day, peak ${peak}`,
      },
      svg('path', {
        d,
        fill: 'var(--trace-soft)',
        stroke: 'var(--trace-line)',
        'stroke-width': '1.5',
      }),
    ),
  );
}
