import type { DayMetrics, TaskRecord } from '../core/types.ts';
import { HOUR, formatDuration, roundHuman } from '../core/util.ts';
import { CATEGORY_LABELS } from '../tasks/categorize.ts';
import { BENCHMARK_VERSION } from '../estimate/priors.ts';

/**
 * Share-card rendering.
 *
 * Cards are generated locally as SVG and rasterised in the browser via canvas.
 * Nothing is uploaded, no remote link is created, and no rendering service is
 * contacted.
 *
 * ## Privacy defaults
 *
 * The default card exposes **no** repository names, file paths, prompts, task
 * titles, branch names, commit messages, usernames, URLs, or code. Projects
 * appear as "Project A", "Project B". Opting into real names is an explicit,
 * per-export choice, and the preview shows exactly what will be written.
 */

export type CardVariant = 'headline' | 'timeline' | 'projects' | 'weekly';

export interface CardOptions {
  readonly variant: CardVariant;
  readonly theme: 'dark' | 'light';
  /** Reveal real project names. Off by default. */
  readonly revealProjects: boolean;
  /** Reveal task titles in the projects variant. Off by default. */
  readonly revealTaskTitles: boolean;
  readonly width?: number;
  readonly height?: number;
}

export const DEFAULT_CARD_OPTIONS: CardOptions = {
  variant: 'headline',
  theme: 'dark',
  revealProjects: false,
  revealTaskTitles: false,
};

export interface CardData {
  readonly day: string;
  readonly metrics: DayMetrics;
  readonly tasks: readonly TaskRecord[];
  /** repoId → display name, already aliased by the caller when required. */
  readonly repoNames: Readonly<Record<string, string>>;
  /** Concurrency samples for the timeline variant. */
  readonly concurrency: readonly { ts: number; activeAgents: number }[];
  /** Steering intervals for the timeline variant. */
  readonly steeringIntervals: readonly (readonly [number, number])[];
  /** Weekly trend for the weekly variant. */
  readonly weekly?: readonly { day: string; verifiedHours: number; steeringHours: number }[];
}

interface Palette {
  bg: string;
  panel: string;
  fg: string;
  muted: string;
  faint: string;
  accent: string;
  accent2: string;
  grid: string;
}

/*
 * Same identity as the dashboard: amber is the machine, white is the human,
 * green is reserved for verified outcomes.
 */
const DARK: Palette = {
  bg: '#07090C',
  panel: '#0D1116',
  fg: '#E8ECEF',
  muted: '#808D9B',
  faint: '#4A5663',
  accent: '#FFB454',
  accent2: '#62D0A0',
  grid: '#1A2028',
};

const LIGHT: Palette = {
  bg: '#F7F6F3',
  panel: '#FFFFFF',
  fg: '#14181D',
  muted: '#5B6672',
  faint: '#939BA5',
  accent: '#B06F00',
  accent2: '#0D8A5F',
  grid: '#E2E0DA',
};

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', 'Helvetica Neue', Arial, sans-serif";
const MONO_STACK = "'SF Mono', 'JetBrains Mono', ui-monospace, 'Menlo', 'Consolas', monospace";

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Anonymise project names as Project A, B, C… in a stable order. */
export function aliasProjects(
  tasks: readonly TaskRecord[],
  repoNames: Readonly<Record<string, string>>,
  reveal: boolean,
  weights?: Readonly<Record<string, number>>,
): Record<string, string> {
  // Alias letters follow the same ordering the card displays, so "Project A"
  // is always the largest bar rather than an unrelated ranking.
  const hoursByRepo = new Map<string, number>();
  for (const t of tasks) {
    if (!t.repoId) continue;
    const w = weights?.[t.repoId];
    hoursByRepo.set(
      t.repoId,
      w !== undefined ? w : (hoursByRepo.get(t.repoId) ?? 0) + t.wallClockMs,
    );
  }
  const ordered = [...hoursByRepo.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const out: Record<string, string> = {};
  ordered.forEach((id, i) => {
    out[id] = reveal
      ? (repoNames[id] ?? `Project ${String.fromCharCode(65 + i)}`)
      : `Project ${String.fromCharCode(65 + (i % 26))}`;
  });
  return out;
}

export function renderCard(data: CardData, opts: CardOptions): string {
  const p = opts.theme === 'dark' ? DARK : LIGHT;
  const w = opts.width ?? 1200;
  const h = opts.height ?? 675;
  switch (opts.variant) {
    case 'timeline':
      return renderTimeline(data, opts, p, w, h);
    case 'projects':
      return renderProjects(data, opts, p, w, h);
    case 'weekly':
      return renderWeekly(data, opts, p, w, h);
    default:
      return renderHeadline(data, opts, p, w, h);
  }
}

function frame(p: Palette, w: number, h: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Leverage daily summary">
  <defs>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${p.accent}" stop-opacity="0.20"/>
      <stop offset="55%" stop-color="${p.accent2}" stop-opacity="0.06"/>
      <stop offset="100%" stop-color="${p.bg}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="${p.bg}"/>
  <rect width="${w}" height="${h}" fill="url(#edge)"/>
  ${body}
</svg>`;
}

function wordmark(p: Palette, x: number, y: number): string {
  return `<g transform="translate(${x},${y})">
    <rect x="0" y="-11" width="4" height="14" rx="2" fill="${p.accent}"/>
    <text x="14" y="0" font-family="${FONT_STACK}" font-size="15" font-weight="600" letter-spacing="0.14em" fill="${p.muted}">LEVERAGE</text>
  </g>`;
}

function footnote(p: Palette, x: number, y: number, extra?: string): string {
  const base = `Estimated against a conventional non-AI engineering workflow · ${BENCHMARK_VERSION}`;
  return `<text x="${x}" y="${y}" font-family="${FONT_STACK}" font-size="14" fill="${p.faint}">${esc(extra ? `${base} · ${extra}` : base)}</text>`;
}

// ---------------------------------------------------------------------------
// Variant: headline
// ---------------------------------------------------------------------------

function renderHeadline(
  data: CardData,
  _opts: CardOptions,
  p: Palette,
  w: number,
  h: number,
): string {
  const m = data.metrics;
  const hours = roundHuman(m.verifiedHours.median);
  const steering = formatDuration(m.steeringMs);
  const leverage = m.outputLeverage;
  const verifiedCount =
    (m.statusCounts['completed-validated'] ?? 0) +
    (m.statusCounts['completed-weak-validation'] ?? 0);
  const verifiedPct = m.taskCount > 0 ? Math.round((verifiedCount / m.taskCount) * 100) : 0;
  const projects = new Set(
    data.tasks
      .filter((t) => !t.excluded)
      .map((t) => t.repoId)
      .filter(Boolean),
  ).size;

  const stats = [
    `${m.taskCount} task${m.taskCount === 1 ? '' : 's'}`,
    `${projects} project${projects === 1 ? '' : 's'}`,
    `${verifiedPct}% verified`,
    `peak ${m.peakConcurrency}× parallel`,
  ].join('   ·   ');

  const range = `${roundHuman(m.verifiedHours.p10)}–${roundHuman(m.verifiedHours.p90)}h range · ${m.confidence} confidence`;

  return frame(
    p,
    w,
    h,
    `
    ${wordmark(p, 72, 84)}
    <text x="72" y="126" font-family="${FONT_STACK}" font-size="19" fill="${p.muted}">${esc(formatDayLabel(data.day))}</text>

    <text x="72" y="292" font-family="${MONO_STACK}" font-size="150" font-weight="600" letter-spacing="-0.05em" fill="${p.fg}">${hours}<tspan font-family="${FONT_STACK}" font-size="52" font-weight="500" fill="${p.muted}" dx="16">hours</tspan></text>
    <text x="72" y="344" font-family="${FONT_STACK}" font-size="30" font-weight="500" fill="${p.muted}">of conventional engineering work, produced through agents</text>

    <line x1="72" y1="410" x2="${w - 72}" y2="410" stroke="${p.grid}" stroke-width="1"/>

    <text x="72" y="470" font-family="${MONO_STACK}" font-size="40" font-weight="600" fill="${p.fg}">${esc(steering)}</text>
    <text x="72" y="502" font-family="${FONT_STACK}" font-size="17" fill="${p.muted}">your time</text>

    <text x="392" y="470" font-family="${MONO_STACK}" font-size="40" font-weight="600" fill="${p.accent}">${leverage.toFixed(leverage < 10 ? 1 : 0)}×</text>
    <text x="392" y="502" font-family="${FONT_STACK}" font-size="17" fill="${p.muted}">output leverage</text>

    <text x="712" y="470" font-family="${MONO_STACK}" font-size="40" font-weight="600" fill="${p.fg}">${m.peakConcurrency}</text>
    <text x="712" y="502" font-family="${FONT_STACK}" font-size="17" fill="${p.muted}">peak concurrent agents</text>

    <text x="72" y="576" font-family="${MONO_STACK}" font-size="17" fill="${p.muted}" letter-spacing="0.02em">${esc(stats)}</text>
    <text x="72" y="606" font-family="${FONT_STACK}" font-size="15" fill="${p.faint}">${esc(range)}</text>
    ${footnote(p, 72, h - 34)}
  `,
  );
}

// ---------------------------------------------------------------------------
// Variant: timeline
// ---------------------------------------------------------------------------

function renderTimeline(
  data: CardData,
  _opts: CardOptions,
  p: Palette,
  w: number,
  h: number,
): string {
  const m = data.metrics;
  const tasks = data.tasks.filter((t) => !t.excluded);
  const x0 = 72;
  const x1 = w - 72;
  const plotW = x1 - x0;

  const times = [
    ...tasks.map((t) => t.startedAt),
    ...tasks.map((t) => t.endedAt),
    ...data.steeringIntervals.flatMap(([a, b]) => [a, b]),
  ];
  const tMin = times.length ? Math.min(...times) : 0;
  const tMax = times.length ? Math.max(...times) : 1;
  const span = Math.max(1, tMax - tMin);
  const sx = (t: number): number => x0 + ((t - tMin) / span) * plotW;

  const laneH = 15;
  const laneGap = 7;
  const maxLanes = 11;

  // Greedy lane packing so overlapping tasks stack visibly.
  const laneEnds: number[] = [];
  const placed: { t: TaskRecord; lane: number }[] = [];
  for (const t of [...tasks].sort((a, b) => a.startedAt - b.startedAt)) {
    let lane = laneEnds.findIndex((e) => e <= t.startedAt);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(t.endedAt);
    } else {
      laneEnds[lane] = t.endedAt;
    }
    if (lane < maxLanes) placed.push({ t, lane });
  }

  // Only reserve rows that are actually occupied, then centre the whole block
  // in the available area — otherwise a two-channel day leaves a conspicuous
  // void where nine empty lanes would have been.
  const lanesUsed = Math.max(1, Math.min(maxLanes, Math.max(...placed.map((x) => x.lane + 1), 1)));
  const areaTop = 250;
  const areaBottom = h - 80;
  const humanGap = 40;
  const blockH = 13 + humanGap + lanesUsed * (laneH + laneGap) + 34;
  const humanY = Math.round(areaTop + Math.max(0, (areaBottom - areaTop - blockH) / 2));
  const laneTop = humanY + 13 + humanGap;

  const bars = placed
    .map(({ t, lane }) => {
      const bx = sx(t.startedAt);
      const bw = Math.max(4, sx(t.endedAt) - bx);
      const by = laneTop + lane * (laneH + laneGap);
      const ok = t.status === 'completed-validated' || t.status === 'completed-weak-validation';
      const bad = t.status === 'failed' || t.status === 'reverted' || t.status === 'abandoned';
      const fill = ok ? p.accent2 : bad ? p.faint : p.accent;
      const op = ok ? 0.9 : bad ? 0.45 : 0.65;
      return `<rect x="${bx.toFixed(1)}" y="${by}" width="${bw.toFixed(1)}" height="${laneH}" rx="4" fill="${fill}" opacity="${op}"/>`;
    })
    .join('\n    ');

  const steerY = humanY;
  const steerBars = data.steeringIntervals
    .map(([a, b]) => {
      const bx = sx(a);
      const bw = Math.max(2, sx(b) - bx);
      return `<rect x="${bx.toFixed(1)}" y="${steerY}" width="${bw.toFixed(1)}" height="13" rx="3" fill="${p.fg}" opacity="0.85"/>`;
    })
    .join('\n    ');

  const axisBottom = laneTop + lanesUsed * (laneH + laneGap) + 6;
  const hoursMarks = axisTicks(tMin, tMax)
    .map(
      (t) =>
        `<line x1="${sx(t).toFixed(1)}" y1="${humanY - 12}" x2="${sx(t).toFixed(1)}" y2="${axisBottom}" stroke="${p.grid}" stroke-width="1"/>
         <text x="${sx(t).toFixed(1)}" y="${axisBottom + 24}" font-family="${MONO_STACK}" font-size="13" fill="${p.faint}" text-anchor="middle">${esc(hourLabel(t))}</text>`,
    )
    .join('\n    ');

  return frame(
    p,
    w,
    h,
    `
    ${wordmark(p, 72, 74)}
    <text x="72" y="152" font-family="${MONO_STACK}" font-size="76" font-weight="600" letter-spacing="-0.045em" fill="${p.fg}">${roundHuman(m.verifiedHours.median)}<tspan font-family="${FONT_STACK}" font-size="32" font-weight="500" fill="${p.muted}" dx="14">conventional hours</tspan></text>
    <text x="72" y="192" font-family="${FONT_STACK}" font-size="21" fill="${p.muted}">${esc(formatDayLabel(data.day))} · ${esc(formatDuration(m.steeringMs))} of your time · ${m.outputLeverage.toFixed(m.outputLeverage < 10 ? 1 : 0)}× leverage</text>

    ${hoursMarks}
    <text x="72" y="${humanY - 14}" font-family="${FONT_STACK}" font-size="13" font-weight="600" letter-spacing="0.12em" fill="${p.fg}">YOU STEERING</text>
    ${steerBars}
    <text x="72" y="${laneTop - 14}" font-family="${FONT_STACK}" font-size="13" font-weight="600" letter-spacing="0.12em" fill="${p.muted}">AGENTS WORKING</text>
    ${bars}
    ${footnote(p, 72, h - 34, `${m.taskCount} tasks · peak ${m.peakConcurrency} concurrent`)}
  `,
  );
}

// ---------------------------------------------------------------------------
// Variant: projects
// ---------------------------------------------------------------------------

function renderProjects(
  data: CardData,
  opts: CardOptions,
  p: Palette,
  w: number,
  h: number,
): string {
  const m = data.metrics;
  const aliases = aliasProjects(data.tasks, data.repoNames, opts.revealProjects, m.repoHours);
  const entries = Object.entries(m.repoHours)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const max = Math.max(1, ...entries.map(([, v]) => v));

  const rows = entries
    .map(([repoId, hours], i) => {
      const y = 300 + i * 54;
      const bw = (hours / max) * (w - 460);
      const name = aliases[repoId] ?? `Project ${String.fromCharCode(65 + i)}`;
      return `<text x="72" y="${y + 4}" font-family="${FONT_STACK}" font-size="21" fill="${p.fg}">${esc(name)}</text>
      <rect x="300" y="${y - 14}" width="${Math.max(3, bw).toFixed(1)}" height="20" rx="5" fill="${p.accent}" opacity="${0.9 - i * 0.1}"/>
      <text x="${(310 + Math.max(3, bw)).toFixed(1)}" y="${y + 3}" font-family="${MONO_STACK}" font-size="17" fill="${p.muted}">${roundHuman(hours)}h</text>`;
    })
    .join('\n    ');

  return frame(
    p,
    w,
    h,
    `
    ${wordmark(p, 72, 74)}
    <text x="72" y="164" font-family="${MONO_STACK}" font-size="82" font-weight="600" letter-spacing="-0.045em" fill="${p.fg}">${roundHuman(m.verifiedHours.median)}<tspan font-family="${FONT_STACK}" font-size="34" font-weight="500" fill="${p.muted}" dx="14">hours</tspan></text>
    <text x="72" y="206" font-family="${FONT_STACK}" font-size="22" fill="${p.muted}">conventional engineering work across ${entries.length} project${entries.length === 1 ? '' : 's'} · ${esc(formatDuration(m.steeringMs))} of your time</text>
    <text x="72" y="262" font-family="${FONT_STACK}" font-size="14" font-weight="600" letter-spacing="0.1em" fill="${p.muted}">BY PROJECT</text>
    ${rows}
    ${footnote(p, 72, h - 34, opts.revealProjects ? 'project names shown by your choice' : 'project names hidden')}
  `,
  );
}

// ---------------------------------------------------------------------------
// Variant: weekly
// ---------------------------------------------------------------------------

function renderWeekly(
  data: CardData,
  _opts: CardOptions,
  p: Palette,
  w: number,
  h: number,
): string {
  const week = data.weekly ?? [];
  const total = week.reduce((a, d) => a + d.verifiedHours, 0);
  const steer = week.reduce((a, d) => a + d.steeringHours, 0);
  const max = Math.max(1, ...week.map((d) => d.verifiedHours));
  const x0 = 72;
  const plotW = w - 144;
  const barW = week.length > 0 ? Math.min(96, plotW / week.length - 18) : 40;
  const baseY = 552;
  const maxH = 240;

  const bars = week
    .map((d, i) => {
      const bx = x0 + i * (plotW / Math.max(1, week.length)) + 8;
      const bh = Math.max(3, (d.verifiedHours / max) * maxH);
      return `<rect x="${bx.toFixed(1)}" y="${(baseY - bh).toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="6" fill="${p.accent}" opacity="0.88"/>
      <text x="${(bx + barW / 2).toFixed(1)}" y="${(baseY - bh - 12).toFixed(1)}" font-family="${MONO_STACK}" font-size="14" fill="${p.muted}" text-anchor="middle">${roundHuman(d.verifiedHours)}</text>
      <text x="${(bx + barW / 2).toFixed(1)}" y="${baseY + 24}" font-family="${FONT_STACK}" font-size="14" fill="${p.faint}" text-anchor="middle">${esc(weekdayLabel(d.day))}</text>`;
    })
    .join('\n    ');

  const lev = steer > 0 ? total / steer : 0;

  return frame(
    p,
    w,
    h,
    `
    ${wordmark(p, 72, 74)}
    <text x="72" y="166" font-family="${MONO_STACK}" font-size="82" font-weight="600" letter-spacing="-0.045em" fill="${p.fg}">${roundHuman(total)}<tspan font-family="${FONT_STACK}" font-size="34" font-weight="500" fill="${p.muted}" dx="14">hours this week</tspan></text>
    <text x="72" y="208" font-family="${FONT_STACK}" font-size="22" fill="${p.muted}">${esc(formatDuration(steer * HOUR))} of your time · ${lev.toFixed(lev < 10 ? 1 : 0)}× output leverage</text>
    <line x1="72" y1="${baseY}" x2="${w - 72}" y2="${baseY}" stroke="${p.grid}" stroke-width="1"/>
    ${bars}
    ${footnote(p, 72, h - 34)}
  `,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function weekdayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString('en-US', {
    weekday: 'short',
  });
}

function hourLabel(ts: number): string {
  return new Date(ts)
    .toLocaleTimeString('en-US', { hour: 'numeric', hour12: true })
    .replace(' ', '');
}

function axisTicks(min: number, max: number, count = 6): number[] {
  const out: number[] = [];
  const step = (max - min) / (count - 1);
  for (let i = 0; i < count; i++) out.push(min + step * i);
  return out;
}

/**
 * Exactly what a card exposes, for the pre-export preview. The UI renders this
 * list verbatim so the claim and the artefact cannot drift apart.
 */
export function describeExposure(opts: CardOptions, data: CardData): string[] {
  const out: string[] = [
    'Total conventional engineering hours (an estimate)',
    'Your own hands-on time (writing instructions and reviewing output)',
    'Output leverage ratio',
    'Number of tasks and projects',
    'Peak concurrent agent count',
    'The date',
  ];
  if (opts.variant === 'timeline') {
    out.push('Start and end times of each task, as unlabelled bars');
    out.push('Times of day when you were steering');
  }
  if (opts.variant === 'projects') {
    out.push(
      opts.revealProjects
        ? `Real project names: ${Object.values(aliasProjects(data.tasks, data.repoNames, true)).join(', ')}`
        : 'Project names replaced with "Project A", "Project B", …',
    );
  }
  if (opts.variant === 'weekly') out.push('Per-day totals for the last 7 days');
  return out;
}

/** Categories present in the day, for the UI legend. */
export function categoryBreakdown(m: DayMetrics): { label: string; hours: number }[] {
  return Object.entries(m.categoryHours)
    .map(([k, v]) => ({ label: CATEGORY_LABELS[k as keyof typeof CATEGORY_LABELS] ?? k, hours: v }))
    .sort((a, b) => b.hours - a.hours);
}
