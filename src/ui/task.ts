import {
  api,
  confidence,
  fmtDuration,
  fmtHours,
  fmtTime,
  h,
  mount,
  post,
  tag,
  type Epistemics,
} from './dom.ts';
import type { EstimatePayload, TaskRow } from './app.ts';

interface TaskDetail {
  task: TaskRow & { intent: string; wallClockMs: number; dayKey: string };
  estimates: Record<string, EstimatePayload | null>;
  events: {
    id: string;
    kind: string;
    ts: number;
    provider: string;
    sessionId: string;
    payload: Record<string, unknown>;
    source: {
      file: string;
      line: number;
      byte: number;
      parser: string;
      providerVersion: string | null;
    };
  }[];
  sessions: {
    sessionId: string;
    provider: string;
    title: string | null;
    startedAt: number;
    endedAt: number;
    model: string | null;
    providerVersion: string | null;
    kind: string;
    sourceFile: string;
  }[];
  groupingReasons: string[];
  categories: { key: string; label: string }[];
  prior: { medianHours: number; sigma: number; anchor: string; rationale: string };
}

/**
 * Task drawer.
 *
 * The whole point of this view is that the headline number survives scrutiny.
 * It shows the estimate, every factor that produced it, the evidence behind
 * each factor, and a link down to the exact line of the exact transcript file
 * the evidence came from.
 */
export function renderTaskDrawer(
  taskId: string,
  mode: string,
  onClose: () => void,
  onChanged: () => Promise<void>,
): HTMLElement {
  const body = h('div', {}, h('div', { class: 'skeleton', style: { height: '300px' } }));
  const drawer = h(
    'div',
    { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Task detail' },
    body,
  );
  const scrim = h(
    'div',
    {
      class: 'scrim',
      onclick: (e: Event) => {
        if (e.target === e.currentTarget) onClose();
      },
    },
    drawer,
  );

  void (async () => {
    try {
      const detail = await api<TaskDetail>(`/api/task/${taskId}`);
      mount(body, ...content(detail, mode, onClose, onChanged));
      drawer.querySelector<HTMLElement>('.drawer-close')?.focus();
    } catch (err) {
      mount(
        body,
        h(
          'div',
          { class: 'banner warn', style: { marginTop: '24px' } },
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  })();

  return scrim;
}

function content(
  d: TaskDetail,
  mode: string,
  onClose: () => void,
  onChanged: () => Promise<void>,
): HTMLElement[] {
  const t = d.task;
  const est = d.estimates[mode] ?? d.estimates['conservative'] ?? null;

  const tabs = ['Estimate', 'Evidence', 'Timeline', 'Correct'] as const;
  let active: (typeof tabs)[number] = 'Estimate';
  const panel = h('div', {});

  const renderPanel = (): void => {
    switch (active) {
      case 'Evidence':
        mount(panel, evidenceTab(d));
        break;
      case 'Timeline':
        mount(panel, timelineTab(d));
        break;
      case 'Correct':
        mount(panel, correctTab(d, onChanged));
        break;
      default:
        mount(panel, estimateTab(d, est, mode));
    }
  };

  const tabBar = h(
    'div',
    { class: 'tabs', role: 'tablist' },
    ...tabs.map((name) =>
      h(
        'button',
        {
          role: 'tab',
          'aria-selected': name === active ? 'true' : 'false',
          onclick: (e: Event) => {
            active = name;
            for (const b of (e.currentTarget as HTMLElement).parentElement?.children ?? []) {
              b.setAttribute('aria-selected', b === e.currentTarget ? 'true' : 'false');
            }
            renderPanel();
          },
        },
        name,
      ),
    ),
  );

  renderPanel();

  return [
    h(
      'div',
      { class: 'drawer-head' },
      h('button', { class: 'drawer-close', 'aria-label': 'Close', onclick: onClose }, '✕'),
      h(
        'div',
        { class: 'row', style: { gap: '8px' } },
        h('span', { class: `status-dot ${t.status}` }),
        h('span', { class: 'eyebrow' }, t.status.replace(/-/g, ' ')),
        t.statusSource === 'user-corrected' ? tag('user-corrected', 'you set this') : null,
        t.userEdited ? h('span', { class: 'chip' }, 'edited') : null,
      ),
      h('h2', {}, t.title),
      h(
        'div',
        { class: 'row', style: { gap: '10px', fontSize: '12px', color: 'var(--text-dim)' } },
        h('span', { class: 'mono' }, t.categoryLabel),
        h('span', { class: 'faint' }, '·'),
        h('span', { class: 'mono' }, t.repoName ?? 'no repository'),
        h('span', { class: 'faint' }, '·'),
        h('span', { class: 'mono' }, `${fmtTime(t.startedAt)} – ${fmtTime(t.endedAt)}`),
        h('span', { class: 'faint' }, '·'),
        h('span', { class: 'mono' }, t.providers.join(' + ')),
      ),
    ),
    tabBar,
    panel,
  ];
}

/* ------------------------------------------------------------------ */
/* Estimate tab — "why this number?"                                   */
/* ------------------------------------------------------------------ */

function estimateTab(d: TaskDetail, est: EstimatePayload | null, mode: string): HTMLElement {
  if (!est) {
    return h(
      'div',
      { class: 'panel' },
      h('p', { class: 'muted' }, 'No estimate was computed for this task.'),
    );
  }

  const chain = h(
    'div',
    { class: 'panel' },
    h('h3', {}, 'How the number narrows'),
    h(
      'div',
      { class: 'stack', style: { gap: '10px' } },
      chainRow(
        'Gross',
        est.gross,
        'What the full intended outcome would have taken a conventional engineer.',
        1,
      ),
      chainRow(
        'Accepted',
        est.accepted,
        `Gross × ${est.completionFactor.toFixed(2)} completion — how much of the intended outcome was actually produced.`,
        est.completionFactor,
      ),
      chainRow(
        'Verified',
        est.verified,
        `Accepted × ${est.verificationFactor.toFixed(2)} verification — how strongly the result was validated. This is the headline.`,
        est.verificationFactor,
        true,
      ),
    ),
  );

  const factors = h(
    'div',
    { class: 'panel' },
    h('h3', {}, 'Every factor applied'),
    h(
      'p',
      { class: 'faint', style: { fontSize: '12px', marginTop: '-4px', marginBottom: '12px' } },
      `Starting from the ${d.prior.medianHours}h category median. ${d.prior.rationale}`,
    ),
    ...est.factors.map((f) =>
      h(
        'div',
        { class: 'factor' },
        h('span', { class: 'factor-name' }, f.label, ' ', tag(f.epistemics as Epistemics)),
        h(
          'span',
          { class: `factor-mult ${f.multiplier > 1 ? 'up' : 'down'}` },
          `${f.multiplier > 1 ? '×' : '×'}${f.multiplier.toFixed(2)}`,
        ),
        h('span', { class: 'factor-why' }, f.rationale),
      ),
    ),
  );

  const notes =
    est.uncertaintyNotes.length > 0
      ? h(
          'div',
          { class: 'panel' },
          h('h3', {}, 'What we are unsure about'),
          h('ul', { class: 'exposure' }, ...est.uncertaintyNotes.map((n) => h('li', {}, n))),
        )
      : null;

  const modes = h(
    'div',
    { class: 'panel' },
    h('h3', {}, 'Across modes'),
    h(
      'dl',
      { class: 'kv' },
      ...(['conservative', 'balanced', 'upper-range'] as const).flatMap((m) => {
        const e = d.estimates[m];
        return [
          h('dt', {}, m === mode ? `${m} ◂` : m),
          h(
            'dd',
            {},
            e
              ? `${fmtHours(e.verified.median)}h  (${fmtHours(e.verified.p10)}–${fmtHours(e.verified.p90)})`
              : '—',
          ),
        ];
      }),
    ),
  );

  return h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'row spread' },
      h(
        'div',
        {},
        h('span', { class: 'eyebrow' }, 'Credited'),
        h(
          'div',
          {
            class: 'mono',
            style: {
              fontSize: '34px',
              fontWeight: '600',
              letterSpacing: '-0.03em',
              marginTop: '4px',
            },
          },
          `${fmtHours(est.verified.median)}h`,
        ),
      ),
      h(
        'div',
        { style: { textAlign: 'right' } },
        confidence(est.confidence, est.confidenceScore),
        h(
          'div',
          { class: 'faint mono', style: { fontSize: '11px', marginTop: '6px' } },
          `${est.benchmarkVersion} · ${est.mode}${est.calibrated ? ' · calibrated' : ''}${est.semanticUsed ? ' · semantic' : ''}`,
        ),
      ),
    ),
    chain,
    factors,
    notes,
    modes,
  );
}

function chainRow(
  label: string,
  dist: { median: number; p10: number; p90: number },
  why: string,
  factor: number,
  emphasise = false,
): HTMLElement {
  return h(
    'div',
    {
      style: {
        borderLeft: `2px solid ${emphasise ? 'var(--trace)' : 'var(--rule-bright)'}`,
        paddingLeft: '12px',
      },
    },
    h(
      'div',
      { class: 'row spread' },
      h('span', { class: 'eyebrow' }, label),
      h(
        'span',
        { class: 'mono', style: { fontSize: '15px', fontWeight: emphasise ? '600' : '400' } },
        `${fmtHours(dist.median)}h`,
        h(
          'span',
          { class: 'faint', style: { fontSize: '11px', marginLeft: '8px' } },
          `${fmtHours(dist.p10)}–${fmtHours(dist.p90)}`,
        ),
      ),
    ),
    h('p', { class: 'faint', style: { fontSize: '12px', margin: '2px 0 0' } }, why),
    void factor,
  );
}

/* ------------------------------------------------------------------ */
/* Evidence tab                                                         */
/* ------------------------------------------------------------------ */

function evidenceTab(d: TaskDetail): HTMLElement {
  const ev = d.task.evidence;
  const num = (k: string): number => Number(ev[k] ?? 0);

  const files = new Map<string, { added: number; removed: number }>();
  const commands: { cmd: string; outcome: string; kind: string }[] = [];
  for (const e of d.events) {
    const p = e.payload as {
      files?: { path: string; linesAdded: number; linesRemoved: number }[];
      command?: string;
      outcome?: string;
    };
    for (const f of p.files ?? []) {
      const cur = files.get(f.path) ?? { added: 0, removed: 0 };
      cur.added += f.linesAdded;
      cur.removed += f.linesRemoved;
      files.set(f.path, cur);
    }
    if (p.command) commands.push({ cmd: p.command, outcome: p.outcome ?? 'unknown', kind: e.kind });
  }

  return h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'panel' },
      h('h3', {}, 'Measured counts'),
      h(
        'dl',
        { class: 'kv' },
        ...(
          [
            ['files changed', num('filesChanged')],
            ['files added', num('filesAdded')],
            ['lines added', num('linesAdded')],
            ['lines removed', num('linesRemoved')],
            ['generated lines excluded', num('generatedLinesAdded')],
            ['subsystems touched', num('subsystemsTouched')],
            ['test runs', num('testsRun')],
            ['tests passed', num('testsPassed')],
            ['tests failed', num('testsFailed')],
            ['builds run', num('buildsRun')],
            ['type checks', num('typecheckRuns')],
            ['lint runs', num('lintRuns')],
            ['errors encountered', num('errorsEncountered')],
            ['commits touching these files', num('commits')],
            ['reverts', num('revertedCommits')],
            ['your interruptions', num('humanInterrupts')],
            ['instruction rounds', num('userInstructions')],
            ['files still on disk', num('filesStillPresent')],
            ['files now missing', num('filesMissing')],
          ] as [string, number][]
        ).flatMap(([k, v]) => [h('dt', {}, k), h('dd', { class: 'mono' }, String(v))]),
      ),
      h(
        'p',
        { class: 'faint', style: { fontSize: '11.5px', marginBottom: 0 } },
        'All counts above are ',
        tag('measured'),
        ' — read directly from the transcripts and the filesystem.',
      ),
    ),
    files.size > 0
      ? h(
          'div',
          { class: 'panel' },
          h('h3', {}, `Files touched (${files.size})`),
          h(
            'div',
            { class: 'stack', style: { gap: '4px' } },
            ...[...files.entries()].slice(0, 40).map(([path, n]) =>
              h(
                'div',
                { class: 'row spread mono', style: { fontSize: '11.5px' } },
                h(
                  'span',
                  {
                    style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    title: path,
                  },
                  shorten(path),
                ),
                h(
                  'span',
                  { class: 'faint', style: { whiteSpace: 'nowrap' } },
                  h('span', { style: { color: 'var(--verified)' } }, `+${n.added}`),
                  ' ',
                  h('span', { style: { color: 'var(--fail)' } }, `−${n.removed}`),
                ),
              ),
            ),
          ),
        )
      : null,
    commands.length > 0
      ? h(
          'div',
          { class: 'panel' },
          h('h3', {}, `Commands (${commands.length})`),
          h(
            'div',
            { class: 'stack', style: { gap: '5px' } },
            ...commands.slice(0, 30).map((c) =>
              h(
                'div',
                {
                  class: 'row mono',
                  style: { fontSize: '11.5px', gap: '8px', alignItems: 'baseline' },
                },
                h(
                  'span',
                  {
                    style: {
                      color:
                        c.outcome === 'pass'
                          ? 'var(--verified)'
                          : c.outcome === 'fail'
                            ? 'var(--fail)'
                            : 'var(--text-faint)',
                      width: '10px',
                    },
                  },
                  c.outcome === 'pass' ? '✓' : c.outcome === 'fail' ? '✕' : '·',
                ),
                h(
                  'span',
                  {
                    style: {
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: '1',
                    },
                    title: c.cmd,
                  },
                  c.cmd,
                ),
              ),
            ),
          ),
        )
      : null,
    h(
      'div',
      { class: 'panel' },
      h('h3', {}, 'Why these events were grouped'),
      d.groupingReasons.length === 0
        ? h(
            'p',
            { class: 'muted', style: { fontSize: '12.5px', margin: 0 } },
            'A single continuous run of work in one session.',
          )
        : h('ul', { class: 'exposure' }, ...d.groupingReasons.map((r) => h('li', {}, r))),
    ),
    h(
      'div',
      { class: 'panel' },
      h('h3', {}, `Sessions (${d.sessions.length})`),
      ...d.sessions.map((s) =>
        h(
          'div',
          { class: 'factor' },
          h('span', { class: 'factor-name' }, s.title ?? s.sessionId.slice(0, 12)),
          h('span', { class: 'factor-mult' }, `${fmtTime(s.startedAt)}–${fmtTime(s.endedAt)}`),
          h(
            'span',
            { class: 'factor-why mono', style: { fontSize: '11px' } },
            `${s.provider}${s.providerVersion ? ` ${s.providerVersion}` : ''} · ${s.kind}${s.model ? ` · ${s.model}` : ''} · ${s.sourceFile}`,
          ),
        ),
      ),
    ),
  );
}

function shorten(p: string): string {
  const parts = p.split('/');
  return parts.length > 4 ? `…/${parts.slice(-3).join('/')}` : p;
}

/* ------------------------------------------------------------------ */
/* Timeline tab                                                         */
/* ------------------------------------------------------------------ */

const KIND_COLOR: Record<string, string> = {
  'user.instruction': 'var(--human)',
  'user.interrupt': 'var(--human)',
  'test.run': 'var(--verified)',
  'build.run': 'var(--verified)',
  'typecheck.run': 'var(--verified)',
  'lint.run': 'var(--verified)',
  'error.encountered': 'var(--fail)',
  'file.created': 'var(--trace)',
  'file.modified': 'var(--trace)',
  'file.deleted': 'var(--fail)',
};

function timelineTab(d: TaskDetail): HTMLElement {
  const interesting = d.events.filter(
    (e) =>
      e.kind !== 'tokens.reported' && e.kind !== 'assistant.reasoning' && e.kind !== 'tool.result',
  );
  return h(
    'div',
    { class: 'panel' },
    h('h3', {}, `Reconstructed timeline (${interesting.length} events)`),
    h(
      'div',
      { class: 'stack', style: { gap: '0' } },
      ...interesting.slice(0, 400).map((e) => {
        const p = e.payload as {
          text?: string;
          command?: string;
          outcome?: string;
          paths?: string[];
        };
        const detail = p.command ?? p.text ?? (p.paths ?? []).map(shorten).join(', ') ?? '';
        return h(
          'div',
          {
            class: 'signal',
            style: { gridTemplateColumns: '58px 90px 1fr', alignItems: 'baseline' },
          },
          h('span', { class: 'mono faint', style: { fontSize: '10.5px' } }, fmtTime(e.ts)),
          h(
            'span',
            {
              class: 'mono',
              style: { fontSize: '10.5px', color: KIND_COLOR[e.kind] ?? 'var(--text-faint)' },
            },
            e.kind.replace(/^\w+\./, ''),
          ),
          h(
            'span',
            {
              style: {
                fontSize: '12px',
                color: 'var(--text-dim)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
              title: `${detail}\n\nsource: ${e.source.file}:${e.source.line} (${e.source.parser})`,
            },
            detail.slice(0, 160) || '—',
          ),
        );
      }),
    ),
    h(
      'p',
      { class: 'faint', style: { fontSize: '11.5px', marginBottom: 0 } },
      'Hover any row to see the exact source file, line, and parser it came from.',
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Correct tab — user overrides and calibration                        */
/* ------------------------------------------------------------------ */

function correctTab(d: TaskDetail, onChanged: () => Promise<void>): HTMLElement {
  const t = d.task;
  const status = h(
    'select',
    { id: 'ov-status' },
    ...[
      'completed-validated',
      'completed-weak-validation',
      'partial',
      'exploratory',
      'failed',
      'abandoned',
      'reverted',
      'superseded',
      'unknown',
    ].map((s) => h('option', { value: s, selected: s === t.status }, s.replace(/-/g, ' '))),
  );
  const category = h(
    'select',
    { id: 'ov-category' },
    ...d.categories.map((c) =>
      h('option', { value: c.key, selected: c.key === t.category }, c.label),
    ),
  );
  const title = h('input', { type: 'text', id: 'ov-title', value: t.title });
  const excluded = h('input', { type: 'checkbox', id: 'ov-excluded', checked: t.excluded });
  const feedback = h('div', { style: { minHeight: '20px', fontSize: '12px' } });

  const hours = h('input', {
    type: 'number',
    id: 'cal-hours',
    min: '0',
    step: '0.5',
    placeholder: 'e.g. 3.5',
  });
  const familiarity = h(
    'select',
    { id: 'cal-fam' },
    h('option', { value: 'expert' }, 'I know this codebase well'),
    h('option', { value: 'some', selected: true }, 'Some familiarity'),
    h('option', { value: 'new' }, 'New to this codebase'),
  );
  const usable = h('input', {
    type: 'number',
    id: 'cal-usable',
    min: '0',
    max: '100',
    step: '5',
    value: '90',
  });
  const rewrote = h('input', { type: 'checkbox', id: 'cal-rewrote' });
  const peer = h(
    'select',
    { id: 'cal-peer' },
    h('option', { value: 'similar', selected: true }, 'About the same'),
    h('option', { value: 'slower' }, 'They would take longer'),
    h('option', { value: 'faster' }, 'They would be quicker'),
  );

  return h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'panel' },
      h('h3', {}, 'Correct this task'),
      h('label', { class: 'field' }, h('span', {}, 'Title'), title),
      h('label', { class: 'field' }, h('span', {}, 'Category'), category),
      h('label', { class: 'field' }, h('span', {}, 'Outcome'), status),
      h(
        'label',
        { class: 'check' },
        excluded,
        h(
          'span',
          {},
          'Exclude from all totals',
          h('small', {}, 'Use for work that should not count at all.'),
        ),
      ),
      h(
        'button',
        {
          class: 'btn btn-primary',
          onclick: async () => {
            try {
              await post(`/api/task/${t.taskId}/override`, {
                title: (title as HTMLInputElement).value,
                category: (category as HTMLSelectElement).value,
                status: (status as HTMLSelectElement).value,
                excluded: (excluded as HTMLInputElement).checked,
              });
              mount(
                feedback,
                h('span', { style: { color: 'var(--verified)' } }, 'Saved. Totals recalculated.'),
              );
              await onChanged();
            } catch (err) {
              mount(feedback, h('span', { style: { color: 'var(--fail)' } }, String(err)));
            }
          },
        },
        'Save correction',
      ),
      feedback,
    ),
    h(
      'div',
      { class: 'panel' },
      h('h3', {}, 'Calibrate the estimate'),
      h(
        'p',
        { class: 'prose', style: { fontSize: '12.5px', marginTop: '-4px' } },
        'Your answer trains a ',
        h('strong', {}, 'personal'),
        ' baseline. It never changes the standardised competent-engineer estimate, and the two views stay separate.',
      ),
      h(
        'label',
        { class: 'field' },
        h('span', {}, 'How long would this have taken you, without AI? (hours)'),
        hours,
      ),
      h(
        'label',
        { class: 'field' },
        h('span', {}, 'How familiar are you with this repository?'),
        familiarity,
      ),
      h(
        'label',
        { class: 'field' },
        h('span', {}, 'How much of the result was genuinely usable? (%)'),
        usable,
      ),
      h('label', { class: 'check' }, rewrote, h('span', {}, 'I substantially rewrote the output')),
      h(
        'label',
        { class: 'field' },
        h('span', {}, 'Would another competent engineer differ?'),
        peer,
      ),
      h(
        'button',
        {
          class: 'btn btn-primary',
          onclick: async () => {
            const v = Number((hours as HTMLInputElement).value);
            if (!Number.isFinite(v) || v < 0) {
              mount(
                feedback,
                h('span', { style: { color: 'var(--fail)' } }, 'Enter a number of hours.'),
              );
              return;
            }
            try {
              await post(`/api/task/${t.taskId}/calibrate`, {
                userHours: v,
                familiarity: (familiarity as HTMLSelectElement).value,
                usableFraction: Number((usable as HTMLInputElement).value) / 100,
                rewrote: (rewrote as HTMLInputElement).checked,
                peerComparison: (peer as HTMLSelectElement).value,
              });
              mount(
                feedback,
                h(
                  'span',
                  { style: { color: 'var(--verified)' } },
                  'Calibration recorded. Your personal baseline updated.',
                ),
              );
              await onChanged();
            } catch (err) {
              mount(feedback, h('span', { style: { color: 'var(--fail)' } }, String(err)));
            }
          },
        },
        'Record calibration',
      ),
    ),
    h(
      'div',
      { class: 'panel' },
      h('h3', {}, 'Set the hours directly'),
      h(
        'p',
        { class: 'prose', style: { fontSize: '12.5px', marginTop: '-4px' } },
        'Replaces the model entirely for this task. The value is labelled as edited by you everywhere it appears, including on share cards.',
      ),
      h(
        'div',
        { class: 'row' },
        h('input', {
          type: 'number',
          id: 'ov-hours',
          min: '0',
          step: '0.5',
          style: { maxWidth: '140px' },
          placeholder: 'hours',
        }),
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              const el = document.getElementById('ov-hours') as HTMLInputElement;
              const v = el.value === '' ? null : Number(el.value);
              await post(`/api/task/${t.taskId}/override`, { hours: v });
              mount(
                feedback,
                h(
                  'span',
                  { style: { color: 'var(--verified)' } },
                  v === null ? 'Override cleared.' : 'Override applied.',
                ),
              );
              await onChanged();
            },
          },
          'Apply',
        ),
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              await post(`/api/task/${t.taskId}/override`, { hours: null });
              await onChanged();
            },
          },
          'Clear override',
        ),
      ),
      h(
        'p',
        { class: 'faint', style: { fontSize: '11.5px', marginBottom: 0 } },
        `Task steering: ${fmtDuration(t.steeringMs)} · agent runtime: ${fmtDuration(t.agentActiveMs)}`,
      ),
    ),
  );
}
