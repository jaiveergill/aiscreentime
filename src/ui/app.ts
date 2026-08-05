import {
  api,
  confidence,
  fmtDayLong,
  fmtCount,
  fmtDayShort,
  fmtDuration,
  fmtHours,
  fmtHoursShort,
  fmtMultiplier,
  h,
  mount,
  post,
  tag,
  todayKey,
  type Epistemics,
} from './dom.ts';
import { chooseDay } from './day.ts';
import { renderStrip, type StripData } from './strip.ts';
import { renderLanes } from './lanes.ts';
import { ICONS, sidebar } from './chrome.ts';
import { renderTaskDrawer } from './task.ts';
import { renderSettings, renderDiagnostics, renderMethodology } from './panels.ts';
import { renderOnboarding } from './onboarding.ts';
import { renderShare } from './share.ts';

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

export interface AppState {
  route:
    | 'day'
    | 'timeline'
    | 'projects'
    | 'tasks'
    | 'settings'
    | 'privacy'
    | 'diagnostics'
    | 'methodology'
    | 'share'
    | 'onboarding';
  day: string;
  status: StatusPayload | null;
  dayData: DayPayload | null;
  timeline: StripData | null;
  trend: TrendPoint[];
  selectedTaskId: string | null;
  openTaskId: string | null;
  loading: boolean;
  error: string | null;
}

export interface StatusPayload {
  onboarded: boolean;
  settings: Record<string, unknown>;
  detections: Detection[];
  eventCount: number;
  taskCount: number;
  days: string[];
  today: string;
  benchmarkVersion: string;
  ingesting: boolean;
  lastIngest: { at: number; events: number; files: number; durationMs: number } | null;
  lastCompute: { at: number; tasks: number; rejected: number; durationMs: number } | null;
  dbPath: string;
  dbBytes: number;
}

export interface Detection {
  provider: string;
  displayName: string;
  installed: boolean;
  dataDirs: string[];
  foundDirs: string[];
  sessionFileCount: number;
  totalBytes: number;
  versionsSeen: string[];
  notes: string[];
}

export interface Dist {
  median: number;
  sigma: number;
  p10: number;
  p50: number;
  p90: number;
  mean: number;
}

export interface DayMetrics {
  dayKey: string;
  benchmarkVersion: string;
  verifiedHours: Dist;
  acceptedHours: Dist;
  grossHours: Dist;
  steeringMs: number;
  steeringLowMs: number;
  steeringHighMs: number;
  promptingMs: number;
  llmMs: number;
  agentActiveMs: number;
  outputLeverage: number;
  wallClockAcceleration: number;
  parallelismLeverage: number;
  acceptanceRate: number;
  verificationRate: number;
  reworkRate: number;
  agentAutonomy: number;
  peakConcurrency: number;
  meanConcurrency: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  concurrentAgentHours: number;
  taskCount: number;
  statusCounts: Record<string, number>;
  categoryHours: Record<string, number>;
  repoHours: Record<string, number>;
  projectCount: number;
  confidence: 'high' | 'medium' | 'low';
  confidenceScore: number;
}

export interface TaskRow {
  taskId: string;
  title: string;
  category: string;
  categoryLabel: string;
  categorySource: Epistemics;
  status: string;
  statusSource: Epistemics;
  repoId?: string;
  repoName: string | null;
  startedAt: number;
  endedAt: number;
  sessionIds: string[];
  providers: string[];
  evidence: Record<string, number>;
  steeringMs: number;
  agentActiveMs: number;
  excluded: boolean;
  userEdited: boolean;
  estimate: EstimatePayload | null;
}

export interface EstimatePayload {
  verified: Dist;
  accepted: Dist;
  gross: Dist;
  completionFactor: number;
  verificationFactor: number;
  confidence: 'high' | 'medium' | 'low';
  confidenceScore: number;
  factors: {
    key: string;
    label: string;
    multiplier: number;
    rationale: string;
    epistemics: Epistemics;
  }[];
  uncertaintyNotes: string[];
  benchmarkVersion: string;
  calibrated: boolean;
  semanticUsed: boolean;
  userOverrideHours?: number;
}

export interface DayPayload {
  day: string;
  metrics: DayMetrics;
  repos: Record<string, string>;
  tasks: TaskRow[];
}

export interface TrendPoint {
  day: string;
  verifiedHours: number;
  steeringHours: number;
  promptingHours: number;
  llmHours: number;
  leverage: number;
  taskCount: number;
}

const state: AppState = {
  route: 'day',
  day: todayKey(),
  status: null,
  dayData: null,
  timeline: null,
  trend: [],
  selectedTaskId: null,
  openTaskId: null,
  loading: true,
  error: null,
};

const root = document.getElementById('root') as HTMLElement;

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

const ROUTES = new Set([
  'day',
  'timeline',
  'projects',
  'tasks',
  'settings',
  'privacy',
  'diagnostics',
  'methodology',
  'share',
  'onboarding',
]);

function readHash(): void {
  const hash = location.hash.replace(/^#\/?/, '');
  const [route, ...rest] = hash.split('/');
  if (route && ROUTES.has(route)) {
    state.route = route as AppState['route'];
  } else {
    state.route = 'day';
  }
  if (rest[0] && /^\d{4}-\d{2}-\d{2}$/.test(rest[0])) {
    state.day = rest[0];
    pinnedDay = true;
    state.openTaskId = rest[1] ?? null;
  } else if (rest[0]) {
    state.openTaskId = rest[0];
  } else {
    // No date in the URL means the user is asking for "whatever is current"
    // again, so resume following today rather than staying on an old pin.
    pinnedDay = false;
    state.openTaskId = null;
  }
}

export function navigate(hash: string): void {
  location.hash = hash;
}

window.addEventListener('hashchange', () => {
  readHash();
  void refresh();
});

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

/** True when the user picked a specific day, rather than following today. */
let pinnedDay = false;

/**
 * Choose which day to show when the user has not pinned one.
 *
 * Prefer today as soon as it has any activity, and fall back to the most
 * recent day that does. Opening on an empty "today" makes the product look
 * broken when the user simply has not started yet — but the fallback has to be
 * re-evaluated on every status poll, not just at load. Otherwise a session
 * opened before the first task of the day lands on yesterday and stays there
 * for the life of the page, silently ignoring everything ingested since.
 *
 * Reading `today` from the status payload rather than the clock also means a
 * tab left open overnight rolls over on its own.
 *
 * @returns true when the selected day changed and its data needs reloading.
 */
function syncDay(): boolean {
  if (pinnedDay || !state.status) return false;
  const target = chooseDay(state.status.days, state.status.today);
  if (target === state.day) return false;
  state.day = target;
  return true;
}

async function loadStatus(): Promise<void> {
  state.status = await api<StatusPayload>('/api/status');
  syncDay();
}

async function loadDay(): Promise<void> {
  const [day, timeline, trendRes] = await Promise.all([
    api<DayPayload>(`/api/day/${state.day}`),
    api<StripData>(`/api/timeline/${state.day}`),
    api<{ trend: TrendPoint[] }>('/api/trend?days=14'),
  ]);
  state.dayData = day;
  state.timeline = timeline;
  state.trend = trendRes.trend;
}

async function refresh(): Promise<void> {
  state.loading = true;
  state.error = null;
  render();
  try {
    if (!state.status) await loadStatus();
    if (state.status && !state.status.onboarded && state.route !== 'onboarding') {
      state.route = 'onboarding';
    }
    const dayScoped = ['day', 'timeline', 'projects', 'tasks', 'share'];
    if (dayScoped.includes(state.route)) await loadDay();
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.loading = false;
    render();
  }
}

export async function reloadAll(): Promise<void> {
  state.status = null;
  await refresh();
}

/* ------------------------------------------------------------------ */
/* Chrome                                                              */
/* ------------------------------------------------------------------ */

function routeKey(): string {
  switch (state.route) {
    case 'settings':
      return 'settings';
    case 'privacy':
      return 'privacy';
    case 'diagnostics':
      return 'diagnostics';
    case 'methodology':
      return 'method';
    case 'share':
      return 'share';
    case 'timeline':
      return 'timeline';
    case 'projects':
      return 'projects';
    case 'tasks':
      return 'tasks';
    default:
      return 'overview';
  }
}

function shiftDay(delta: number): void {
  const days = state.status?.days ?? [];
  const i = days.indexOf(state.day);
  // `days` is newest-first, so moving back in time means moving forward in it.
  const next = i === -1 ? days[0] : days[i - delta];
  if (next) navigate(`${routeHashBase()}/${next}`);
}

function routeHashBase(): string {
  const r = state.route;
  return r === 'day' ? '/day' : `/${r === 'methodology' ? 'methodology' : r}`;
}

function topbar(): HTMLElement {
  const days = state.status?.days ?? [];
  const i = days.indexOf(state.day);
  const hasNewer = i > 0;
  const hasOlder = i >= 0 && i < days.length - 1;

  return h(
    'div',
    { class: 'topbar' },
    h(
      'div',
      { class: 'daynav' },
      h(
        'button',
        {
          onclick: () => shiftDay(-1),
          disabled: hasOlder ? null : true,
          'aria-label': 'Previous day',
        },
        ICONS.chevL(),
      ),
      h(
        'button',
        { onclick: () => shiftDay(1), disabled: hasNewer ? null : true, 'aria-label': 'Next day' },
        ICONS.chevR(),
      ),
    ),
    h(
      'select',
      {
        class: 'day-title',
        'aria-label': 'Select day',
        onchange: (e: Event) =>
          navigate(`${routeHashBase()}/${(e.target as HTMLSelectElement).value}`),
      },
      ...(days.length ? days : [state.day]).map((d) =>
        h(
          'option',
          { value: d, selected: d === state.day },
          d === state.status?.today ? `${fmtDayLong(d)} · today` : fmtDayLong(d),
        ),
      ),
    ),
    h(
      'div',
      { class: 'topbar-right' },
      h(
        'button',
        {
          class: 'icon-btn',
          title: state.status?.ingesting ? 'Scanning…' : 'Scan for new sessions',
          'aria-label': 'Rescan',
          disabled: state.status?.ingesting ? true : null,
          onclick: async () => {
            try {
              await post('/api/ingest');
              await reloadAll();
            } catch (err) {
              state.error = err instanceof Error ? err.message : String(err);
              render();
            }
          },
        },
        ICONS.refresh(),
      ),
      h(
        'button',
        {
          class: 'icon-btn',
          'aria-label': 'Toggle colour theme',
          onclick: () => {
            const next = document.documentElement.dataset['theme'] === 'light' ? 'dark' : 'light';
            document.documentElement.dataset['theme'] = next;
            try {
              localStorage.setItem('screentime-theme', next);
            } catch {
              /* storage unavailable */
            }
          },
        },
        ICONS.sun(),
      ),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

function heroCard(m: DayMetrics, day: DayPayload): HTMLElement {
  const done =
    (m.statusCounts['completed-validated'] ?? 0) +
    (m.statusCounts['completed-weak-validation'] ?? 0);

  const stat = (n: string, label: string, cls?: string, title?: string): HTMLElement =>
    h('div', { class: 'hero-stat', title }, h('b', { class: cls ?? '' }, n), h('span', {}, label));

  return h(
    'section',
    { class: 'card hero' },
    h('span', { class: 'pill' }, day.day === state.status?.today ? 'Today' : fmtDayShort(day.day)),
    h(
      'span',
      { class: 'hero-number' },
      fmtHours(m.verifiedHours.median),
      h('span', { class: 'unit' }, 'hrs'),
    ),
    h(
      'p',
      { class: 'hero-sub' },
      'of conventional engineering work',
      h('br', {}),
      'in ',
      h('b', {}, fmtDuration(m.steeringMs)),
      ' of yours',
    ),
    h('div', { class: 'hero-lev' }, ICONS.pulse(), `${fmtMultiplier(m.outputLeverage)} more work`),
    h(
      'div',
      { class: 'hero-range' },
      tag('estimated'),
      h('span', {}, `${fmtHours(m.verifiedHours.p10)}–${fmtHours(m.verifiedHours.p90)}h range`),
      confidence(m.confidence, m.confidenceScore),
    ),
    h(
      'div',
      { class: 'hero-stats' },
      stat(
        fmtHoursShort(m.llmMs),
        'LLM hours',
        'blue',
        'Model runtime summed across concurrent agents, so it can exceed the length of the day.',
      ),
      stat(
        fmtHoursShort(m.steeringMs),
        'your time',
        'white',
        `${fmtHoursShort(m.promptingMs)} prompting, ${fmtHoursShort(Math.max(0, m.steeringMs - m.promptingMs))} reviewing. Counted once however many agents ran at the same time.`,
      ),
      stat(String(done), 'tasks completed'),
      stat(String(m.peakConcurrency), 'peak agents'),
    ),
  );
}

function timelineCard(): HTMLElement {
  return h(
    'section',
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      h('h2', {}, 'Timeline'),
      h('span', { class: 'note' }, 'Agents ran while you were elsewhere'),
    ),
    h(
      'div',
      { id: 'lane-slot' },
      state.timeline
        ? renderLanes(state.timeline, {
            onSelectTask: openTask,
            selectedTaskId: state.selectedTaskId,
          })
        : h('div', { class: 'skeleton', style: { height: '170px' } }),
    ),
    h(
      'div',
      { class: 'card-foot' },
      h(
        'button',
        { onclick: () => navigate(`/timeline/${state.day}`) },
        'View full timeline',
        ICONS.arrowR(),
      ),
    ),
  );
}

function railSummary(m: DayMetrics): HTMLElement {
  const row = (label: string, value: string, cls?: string): HTMLElement =>
    h('div', { class: 'rail-row' }, h('span', {}, label), h('b', { class: cls ?? '' }, value));
  const reviewMs = Math.max(0, m.steeringMs - m.promptingMs);
  const sub = (label: string, value: string): HTMLElement =>
    h('div', { class: 'rail-row sub' }, h('span', {}, label), h('b', {}, value));
  const rule = (): HTMLElement =>
    h('div', { style: { height: '1px', background: 'var(--rule)', margin: '10px 0' } });

  return h(
    'section',
    { class: 'card' },
    h('h3', {}, 'Summary'),
    row('LLM hours', fmtHoursShort(m.llmMs), 'blue'),
    h('p', { class: 'rail-note' }, `peak ${m.peakConcurrency} agents`),
    rule(),
    row('Your time', fmtHoursShort(m.steeringMs), 'white'),
    sub('prompting', fmtHoursShort(m.promptingMs)),
    sub('reviewing', fmtHoursShort(reviewMs)),
    rule(),
    row('Conventional work', `${fmtHours(m.verifiedHours.median)} hrs`, 'green'),
    row('More work', fmtMultiplier(m.outputLeverage), 'amber'),
    row('Verified', `${Math.round(m.verificationRate * 100)}%`),
  );
}

function statusBadge(status: string): HTMLElement {
  const cls =
    status === 'completed-validated'
      ? 'ok'
      : status === 'completed-weak-validation'
        ? 'ok'
        : status === 'exploratory'
          ? 'info'
          : ['failed', 'reverted', 'abandoned'].includes(status)
            ? 'bad'
            : 'warn';
  const label =
    status === 'completed-validated'
      ? 'Validated'
      : status === 'completed-weak-validation'
        ? 'Completed'
        : status.charAt(0).toUpperCase() + status.slice(1).replace(/-/g, ' ');
  return h('span', { class: `badge ${cls}` }, label);
}

function railTopTask(day: DayPayload): HTMLElement | null {
  const done = day.tasks
    .filter((t) => !t.excluded && t.status.startsWith('completed'))
    .sort((a, b) => (b.estimate?.verified.median ?? 0) - (a.estimate?.verified.median ?? 0));
  const top = done[0];
  if (!top) return null;
  return h(
    'section',
    { class: 'card' },
    h('h3', {}, 'Top task'),
    h(
      'div',
      { class: 'top-task' },
      h(
        'div',
        { class: 'top-task-title' },
        h('span', { style: { flex: '1' } }, top.title),
        statusBadge(top.status),
      ),
      h(
        'div',
        { style: { fontSize: '11.5px', color: 'var(--text-faint)' } },
        top.repoName ?? 'no repository',
      ),
      h(
        'div',
        { class: 'top-task-meta' },
        h('span', {}, `${top.evidence['filesChanged'] ?? 0} files`),
        h('span', {}, `${top.evidence['testsRun'] ?? 0} tests`),
        h('span', {}, `${fmtHours(top.estimate?.verified.median ?? 0)}h`),
      ),
    ),
  );
}

function railRecent(day: DayPayload): HTMLElement {
  const recent = day.tasks
    .filter((t) => !t.excluded)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 6);
  return h(
    'section',
    { class: 'card' },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', marginBottom: '8px' } },
      h('h3', { style: { margin: '0' } }, 'Recent tasks'),
      h(
        'button',
        { class: 'rail-link', onclick: () => navigate(`/tasks/${state.day}`) },
        'View all',
      ),
    ),
    ...(recent.length === 0
      ? [h('p', { class: 'faint', style: { fontSize: '12.5px', margin: 0 } }, 'Nothing yet.')]
      : recent.map((t) =>
          h(
            'button',
            { class: 'rail-task', onclick: () => openTask(t.taskId) },
            h('span', { class: `status-dot ${t.status}` }),
            h('span', { class: 't' }, t.title),
            h('span', { class: 'h' }, `${fmtHours(t.estimate?.verified.median ?? 0)}h`),
          ),
        )),
  );
}

function railShare(): HTMLElement {
  const img = h('img', {
    src: `/api/share/${state.day}?variant=headline&theme=dark`,
    alt: 'Share card preview',
  });
  return h(
    'section',
    { class: 'card' },
    h('h3', {}, 'Share'),
    h('div', { class: 'share-mini' }, img),
    h(
      'button',
      { class: 'btn-wide', onclick: () => navigate(`/share/${state.day}`) },
      ICONS.share(),
      'Make a card',
    ),
  );
}

function overview(): HTMLElement {
  const day = state.dayData;
  if (!day) {
    return h(
      'div',
      { class: 'col' },
      h('div', { class: 'skeleton', style: { height: '320px', borderRadius: '12px' } }),
      h('div', { class: 'skeleton', style: { height: '220px', borderRadius: '12px' } }),
    );
  }
  return h(
    'div',
    { class: 'col' },
    state.error ? h('div', { class: 'banner warn' }, state.error) : null,
    heroCard(day.metrics, day),
    timelineCard(),
  );
}

function rail(): HTMLElement {
  const day = state.dayData;
  if (!day) return h('div', { class: 'rail' });
  return h(
    'aside',
    { class: 'rail' },
    railSummary(day.metrics),
    railTopTask(day),
    railRecent(day),
    railShare(),
  );
}

function stripOpts() {
  return {
    selectedTaskId: state.selectedTaskId,
    onSelect: (id: string | null) => {
      state.selectedTaskId = id;
      if (id) openTask(id);
      else renderStripOnly();
    },
  };
}

function renderStripOnly(): void {
  const slot = document.getElementById('strip-slot');
  if (slot && state.timeline) mount(slot, renderStrip(state.timeline, stripOpts()));
}

function openTask(taskId: string): void {
  state.openTaskId = taskId;
  render();
}

export function closeTask(): void {
  state.openTaskId = null;
  state.selectedTaskId = null;
  render();
}

export async function reloadDay(): Promise<void> {
  await loadDay();
  render();
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

function statusBreakdown(m: DayMetrics): HTMLElement {
  const rows: [string, string, string][] = [
    ['completed-validated', 'Completed & validated', 'var(--verified)'],
    [
      'completed-weak-validation',
      'Completed, weak validation',
      'color-mix(in srgb, var(--verified) 55%, transparent)',
    ],
    ['partial', 'Partially completed', 'var(--warn)'],
    ['exploratory', 'Exploratory', 'var(--info)'],
    ['failed', 'Failed', 'var(--fail)'],
    ['abandoned', 'Abandoned', 'var(--fail)'],
    ['reverted', 'Reverted', 'var(--fail)'],
    ['unknown', 'Unknown', 'var(--text-faint)'],
  ];
  const total = Object.values(m.statusCounts).reduce((a, b) => a + b, 0) || 1;
  const present = rows.filter(([k]) => (m.statusCounts[k] ?? 0) > 0);

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'bars' },
      ...present.map(([k, label, colour]) => {
        const n = m.statusCounts[k] ?? 0;
        return h(
          'div',
          { class: 'bar-row' },
          h('span', { class: 'bar-label' }, label),
          h('span', { class: 'bar-value' }, String(n)),
          h(
            'div',
            { class: 'bar-track' },
            h('div', {
              class: 'bar-fill',
              style: { width: `${(n / total) * 100}%`, background: colour },
            }),
          ),
        );
      }),
    ),
    h(
      'dl',
      { class: 'kv', style: { marginTop: '18px' } },
      h('dt', {}, 'acceptance'),
      h('dd', {}, `${Math.round(m.acceptanceRate * 100)}%`, ' ', tag('derived')),
      h('dt', {}, 'verification'),
      h('dd', {}, `${Math.round(m.verificationRate * 100)}%`, ' ', tag('derived')),
      h('dt', {}, 'rework'),
      h('dd', {}, `${Math.round(m.reworkRate * 100)}%`, ' ', tag('derived')),
      h('dt', {}, 'autonomy'),
      h('dd', {}, `${Math.round(m.agentAutonomy * 100)}%`, ' ', tag('inferred')),
      h('dt', {}, 'parallel'),
      h('dd', {}, `${Math.round(m.parallelismLeverage * 100)}%`, ' ', tag('derived')),
      // Tokens are the only figures here the providers hand us outright, so
      // they carry 'measured' rather than 'derived' or 'inferred'.
      h('dt', {}, 'tokens in'),
      h('dd', {}, fmtCount(m.tokensIn), ' ', tag('measured')),
      h('dt', {}, 'tokens out'),
      h('dd', {}, fmtCount(m.tokensOut), ' ', tag('measured')),
      h('dt', {}, 'cached'),
      h(
        'dd',
        {},
        `${m.tokensIn > 0 ? Math.round((m.tokensCacheRead / m.tokensIn) * 100) : 0}%`,
        ' ',
        tag('measured'),
      ),
    ),
  );
}

function trendView(): HTMLElement {
  const points = state.trend;
  const max = Math.max(0.0001, ...points.map((p) => p.verifiedHours));
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'trend' },
      ...points.map((p) =>
        h(
          'div',
          {
            class: `trend-col${p.day === state.day ? ' today' : ''}`,
            title: `${p.day}: ${fmtHours(p.verifiedHours)}h from ${fmtDuration(p.steeringHours * 3600000)} steering (${fmtMultiplier(p.leverage)})`,
            onclick: () => navigate(`/projects/${p.day}`),
          },
          h('div', {
            class: 'trend-bar',
            style: { height: `${Math.max(2, (p.verifiedHours / max) * 72)}px` },
          }),
        ),
      ),
    ),
    h(
      'div',
      { class: 'trend-axis' },
      ...points.map((p) => h('span', {}, fmtDayShort(p.day).split(' ')[1] ?? '')),
    ),
  );
}

function taskTable(day: DayPayload): HTMLElement {
  const tasks = [...day.tasks].sort(
    (a, b) => (b.estimate?.verified.median ?? 0) - (a.estimate?.verified.median ?? 0),
  );

  if (tasks.length === 0) {
    return h(
      'div',
      { class: 'empty' },
      h('h3', {}, 'No engineering tasks'),
      h(
        'p',
        {},
        'Conversations that changed no files, ran no commands, and touched no repository are excluded. Collector shows how many.',
      ),
    );
  }

  return h(
    'table',
    { class: 'tasks' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { style: { width: '48%' } }, 'Task'),
        h('th', {}, 'Category'),
        h('th', { style: { textAlign: 'right' } }, 'Verified'),
        h('th', { style: { textAlign: 'right' } }, 'Range'),
        h('th', { style: { textAlign: 'right' } }, 'Conf.'),
      ),
    ),
    h(
      'tbody',
      {},
      ...tasks.map((t) => {
        const e = t.estimate;
        return h(
          'tr',
          {
            class: t.excluded ? 'excluded' : '',
            tabindex: '0',
            onclick: () => openTask(t.taskId),
            onkeydown: (kv: KeyboardEvent) => {
              if (kv.key === 'Enter' || kv.key === ' ') {
                kv.preventDefault();
                openTask(t.taskId);
              }
            },
          },
          h(
            'td',
            {},
            h('span', { class: `status-dot ${t.status}` }),
            h('span', { class: 'task-title' }, t.title),
            h(
              'span',
              { class: 'task-meta' },
              [
                t.repoName ?? 'no repository',
                `${t.evidence['filesChanged'] ?? 0} files`,
                `+${t.evidence['linesAdded'] ?? 0}/-${t.evidence['linesRemoved'] ?? 0}`,
                (t.evidence['testsRun'] ?? 0) > 0
                  ? `${t.evidence['testsPassed'] ?? 0}/${t.evidence['testsRun']} tests pass`
                  : 'no tests',
                t.providers.join('+'),
                t.sessionIds.length > 1 ? `${t.sessionIds.length} sessions` : null,
                t.userEdited ? 'edited by you' : null,
              ]
                .filter(Boolean)
                .join(' · '),
            ),
          ),
          h('td', { style: { fontSize: '11.5px', color: 'var(--text-dim)' } }, t.categoryLabel),
          h('td', { class: 'num' }, e ? `${fmtHours(e.verified.median)}h` : '—'),
          h(
            'td',
            { class: 'num', style: { color: 'var(--text-faint)', fontSize: '11.5px' } },
            e ? `${fmtHours(e.verified.p10)}–${fmtHours(e.verified.p90)}` : '—',
          ),
          h(
            'td',
            { class: 'num', style: { fontSize: '11px', color: 'var(--text-dim)' } },
            e?.confidence ?? '—',
          ),
        );
      }),
    ),
  );
}

function pageFor(): HTMLElement {
  switch (state.route) {
    case 'settings':
      return renderSettings(state, reloadAll, 'preferences');
    case 'privacy':
      return renderSettings(state, reloadAll, 'privacy');
    case 'diagnostics':
      return renderDiagnostics(state);
    case 'methodology':
      return renderMethodology(state);
    case 'share':
      return renderShare(state);
    case 'timeline':
      return fullTimeline();
    case 'projects':
      return projectsView();
    case 'tasks':
      return tasksView();
    default:
      return overview();
  }
}

function fullTimeline(): HTMLElement {
  return h(
    'div',
    { class: 'col' },
    h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        h('h2', {}, 'Full timeline'),
        h('span', { class: 'note' }, 'One channel per session; you are on top'),
      ),
      h(
        'div',
        { id: 'strip-slot' },
        state.timeline
          ? renderStrip(state.timeline, stripOpts())
          : h('div', { class: 'skeleton', style: { height: '300px' } }),
      ),
    ),
  );
}

function projectsView(): HTMLElement {
  const day = state.dayData;
  if (!day)
    return h('div', { class: 'col' }, h('div', { class: 'skeleton', style: { height: '260px' } }));
  const entries = Object.entries(day.metrics.repoHours).sort((a, b) => b[1] - a[1]);
  const max = Math.max(0.0001, ...entries.map(([, v]) => v));
  const catEntries = Object.entries(day.metrics.categoryHours).sort((a, b) => b[1] - a[1]);
  const catMax = Math.max(0.0001, ...catEntries.map(([, v]) => v));

  const bars = (
    list: [string, number][],
    max2: number,
    label: (k: string) => string,
  ): HTMLElement =>
    list.length === 0
      ? h('p', { class: 'faint', style: { fontSize: '12.5px', margin: 0 } }, 'Nothing recorded.')
      : h(
          'div',
          { class: 'bars' },
          ...list.map(([k, v]) =>
            h(
              'div',
              { class: 'bar-row' },
              h('span', { class: 'bar-label' }, label(k)),
              h('span', { class: 'bar-value' }, `${fmtHours(v)}h`),
              h(
                'div',
                { class: 'bar-track' },
                h('div', { class: 'bar-fill', style: { width: `${(v / max2) * 100}%` } }),
              ),
            ),
          ),
        );

  return h(
    'div',
    { class: 'col' },
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'By project')),
      bars(entries, max, (k) => day.repos[k] ?? 'Unnamed project'),
    ),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'By category')),
      bars(catEntries, catMax, (k) => day.tasks.find((t) => t.category === k)?.categoryLabel ?? k),
    ),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Last 14 days')),
      trendView(),
    ),
  );
}

function tasksView(): HTMLElement {
  const day = state.dayData;
  if (!day)
    return h('div', { class: 'col' }, h('div', { class: 'skeleton', style: { height: '300px' } }));
  return h(
    'div',
    { class: 'col' },
    h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        h('h2', {}, `Tasks (${day.tasks.filter((t) => !t.excluded).length})`),
        h('span', { class: 'note' }, 'Open a row for its reasoning'),
      ),
      taskTable(day),
    ),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Outcomes')),
      statusBreakdown(day.metrics),
    ),
  );
}

function render(): void {
  if (state.route === 'onboarding') {
    mount(
      root,
      renderOnboarding(state, async () => {
        await post('/api/onboard/complete', {});
        state.status = null;
        navigate(`/day/${todayKey()}`);
        await refresh();
      }),
    );
    return;
  }

  const showRail = state.route === 'day';
  const main = h('main', { class: 'main', id: 'main' }, topbar(), pageFor());

  mount(
    root,
    h(
      'div',
      { class: 'shell', style: showRail ? {} : { gridTemplateColumns: '232px minmax(0, 1fr)' } },
      sidebar(routeKey(), navigate),
      main,
      showRail ? rail() : null,
    ),
  );

  if (state.openTaskId) {
    root.appendChild(renderTaskDrawer(state.openTaskId, closeTask, reloadDay));
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

try {
  const saved = localStorage.getItem('screentime-theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset['theme'] = saved;
} catch {
  /* storage unavailable */
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.openTaskId) {
    e.preventDefault();
    closeTask();
  }
});

readHash();
void refresh();

// Reflect live ingestion progress without the user having to reload.
setInterval(async () => {
  if (!state.status) return;
  try {
    const next = await api<StatusPayload>('/api/status');
    const wasIngesting = state.status.ingesting;
    state.status = next;
    // A background scan that picks up the first task of a new day, or a tab
    // left open past midnight, both change which day we should be showing.
    const dayChanged = syncDay();
    if (dayChanged || (wasIngesting && !next.ingesting)) await refresh();
    else render();
  } catch {
    /* server not reachable; keep the last known state */
  }
}, 4000);
