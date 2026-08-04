import { api, fmtBytes, h, mount, post } from './dom.ts';
import type { AppState, Detection } from './app.ts';

/**
 * First run.
 *
 * Order matters here: explain the metric, state the privacy position, show
 * exactly which directories were found, then ingest. No account, no API key,
 * no permission to read anything the user has not seen listed.
 */
export function renderOnboarding(state: AppState, onDone: () => Promise<void>): HTMLElement {
  const detections = state.status?.detections ?? [];
  const anyInstalled = detections.some((d) => d.installed);
  const status = h('div', { style: { minHeight: '24px', fontSize: '13px', marginTop: '14px' } });
  let historyDays = 30;

  const step = (n: number, title: string, ...body: (Node | string | null)[]): HTMLElement =>
    h(
      'section',
      { class: 'band' },
      h('div', { class: 'band-head' }, h('h2', {}, `${String(n).padStart(2, '0')} · ${title}`)),
      ...body,
    );

  const providerCard = (d: Detection): HTMLElement =>
    h(
      'div',
      { class: 'panel' },
      h(
        'div',
        { class: 'row spread' },
        h(
          'div',
          { class: 'row', style: { gap: '9px' } },
          h(
            'span',
            {
              style: {
                color: d.installed ? 'var(--verified)' : 'var(--text-faint)',
                fontSize: '11px',
              },
            },
            d.installed ? '●' : '○',
          ),
          h('strong', {}, d.displayName),
        ),
        h(
          'span',
          { class: 'mono faint', style: { fontSize: '11px' } },
          d.installed ? `${d.sessionFileCount} sessions · ${fmtBytes(d.totalBytes)}` : 'not found',
        ),
      ),
      h(
        'div',
        {
          class: 'mono',
          style: {
            fontSize: '11px',
            color: 'var(--text-faint)',
            marginTop: '8px',
            wordBreak: 'break-all',
          },
        },
        ...d.dataDirs.map((dir) => h('div', {}, dir)),
      ),
      d.versionsSeen.length > 0
        ? h(
            'div',
            { class: 'mono faint', style: { fontSize: '11px', marginTop: '6px' } },
            `versions: ${d.versionsSeen.slice(0, 5).join(', ')}`,
          )
        : null,
      ...d.notes.map((n) =>
        h('p', { class: 'faint', style: { fontSize: '12px', margin: '8px 0 0' } }, n),
      ),
    );

  return h(
    'main',
    { id: 'main', class: 'page', style: { maxWidth: '900px' } },
    h(
      'section',
      { style: { padding: '72px 0 40px' } },
      h('div', { class: 'brand', style: { marginBottom: '28px' } }, 'LEVERAGE'),
      h(
        'h1',
        {
          style: {
            fontFamily: 'var(--sans)',
            fontSize: 'clamp(30px, 4.6vw, 46px)',
            lineHeight: '1.1',
            letterSpacing: '-0.03em',
            margin: '0 0 18px',
            maxWidth: '20ch',
          },
        },
        'See how much engineering work you actually produced.',
      ),
      h(
        'p',
        { class: 'prose', style: { fontSize: '16px' } },
        'Leverage reads your Claude Code and Codex sessions, reconstructs the engineering tasks you actually completed, and estimates how long each one would have taken a competent engineer working without AI. ',
        h('strong', {}, 'It counts what survived — not what was generated.'),
      ),
    ),

    step(
      1,
      'What the number means',
      h(
        'div',
        { class: 'prose' },
        h(
          'p',
          {},
          h('strong', {}, 'One conventional engineering hour'),
          ' is an hour a competent engineer would have needed to produce the same accepted result using a normal workflow: IDE, debugger, docs, Stack Overflow, tests, code review — and no generative AI.',
        ),
        h(
          'p',
          {},
          'Work that failed, was reverted, or never got verified is discounted. Conversations that were not software engineering are excluded entirely. Every figure carries a range and a confidence level, and you can open any task to see exactly how it was scored.',
        ),
      ),
    ),

    step(
      2,
      'Everything stays here',
      h(
        'div',
        { class: 'prose' },
        h(
          'p',
          {},
          'All processing is local. No account, no API key, no cloud sync, no telemetry, no crash reports. Your transcripts and code never leave this machine, and Leverage only ever ',
          h('strong', {}, 'reads'),
          ' — it never modifies, moves, or deletes a Claude Code, Codex, or Git file.',
        ),
        h(
          'p',
          {},
          'Secrets, keys, and tokens are redacted as files are read, before anything is stored. Optional semantic analysis is off by default; if you turn it on later, you will see exactly what would be sent.',
        ),
      ),
    ),

    step(
      3,
      anyInstalled ? 'Found on this machine' : 'Nothing detected yet',
      h('div', { class: 'stack' }, ...detections.map(providerCard)),
      anyInstalled
        ? null
        : h(
            'div',
            { class: 'banner demo', style: { marginTop: '16px' } },
            h(
              'div',
              {},
              h('strong', {}, 'No Claude Code or Codex data found. '),
              'Install either tool and run a session, or set ',
              h('code', {}, 'CLAUDE_CONFIG_DIR'),
              ' / ',
              h('code', {}, 'CODEX_HOME'),
              ' if they live elsewhere. You can also explore a clearly-labelled synthetic dataset with ',
              h('code', {}, 'leverage demo'),
              '.',
            ),
          ),
    ),

    step(
      4,
      'How far back to look',
      h(
        'label',
        { class: 'field', style: { maxWidth: '320px' } },
        h('span', {}, 'History window (days)'),
        h(
          'select',
          { onchange: (e: Event) => (historyDays = Number((e.target as HTMLSelectElement).value)) },
          h('option', { value: '7' }, 'Last 7 days — fastest'),
          h('option', { value: '30', selected: true }, 'Last 30 days'),
          h('option', { value: '90' }, 'Last 90 days'),
          h('option', { value: '0' }, 'Everything — slowest first run'),
        ),
      ),
      h(
        'p',
        { class: 'faint', style: { fontSize: '12.5px' } },
        'Later scans are incremental: only new bytes are read, so this cost is paid once.',
      ),
    ),

    h(
      'section',
      { class: 'band', style: { borderBottom: 'none' } },
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn btn-primary',
            style: { fontSize: '13px', padding: '10px 18px' },
            onclick: async (e: Event) => {
              const btn = e.currentTarget as HTMLButtonElement;
              btn.disabled = true;
              mount(status, h('span', { class: 'faint' }, 'Reading sessions…'));
              try {
                const r = await post<{
                  lastIngest: { events: number; files: number } | null;
                  lastCompute: { tasks: number; rejected: number } | null;
                }>('/api/ingest', { historyDays });
                mount(
                  status,
                  h(
                    'span',
                    { style: { color: 'var(--verified)' } },
                    `${r.lastIngest?.events.toLocaleString() ?? 0} events from ${r.lastIngest?.files ?? 0} files · ${r.lastCompute?.tasks ?? 0} engineering tasks reconstructed`,
                  ),
                );
                await onDone();
              } catch (err) {
                btn.disabled = false;
                mount(status, h('span', { style: { color: 'var(--fail)' } }, String(err)));
              }
            },
          },
          anyInstalled ? 'Scan and build my dashboard' : 'Scan anyway',
        ),
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              mount(status, h('span', { class: 'faint' }, 'Skipping the scan…'));
              await onDone();
            },
          },
          'Skip for now',
        ),
      ),
      status,
      h(
        'p',
        { class: 'faint', style: { fontSize: '12px', marginTop: '20px' } },
        'After the scan, review the first few reconstructed tasks and calibrate one or two — telling Leverage how long a task would really have taken you makes every later estimate more accurate for you specifically.',
      ),
      void api,
    ),
  );
}
