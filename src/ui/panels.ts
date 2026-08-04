import { api, fmtBytes, fmtHours, h, mount, post, tag } from './dom.ts';
import type { AppState } from './app.ts';

/* ================================================================== */
/* Settings                                                            */
/* ================================================================== */

interface RepoRow {
  repoId: string;
  root: string;
  displayPath: string;
  name: string;
  isGit: boolean;
  fileCount: number | null;
  excluded: boolean;
}

export function renderSettings(
  state: AppState,
  reload: () => Promise<void>,
  tab: 'preferences' | 'privacy' = 'preferences',
): HTMLElement {
  const s = (state.status?.settings ?? {}) as Record<string, unknown>;
  const feedback = h('div', {
    style: { minHeight: '22px', fontSize: '12.5px', marginTop: '10px' },
  });
  const reposSlot = h('div', {}, h('div', { class: 'skeleton', style: { height: '80px' } }));

  const save = async (patch: Record<string, unknown>): Promise<void> => {
    try {
      await post('/api/settings', patch);
      mount(
        feedback,
        h(
          'span',
          { style: { color: 'var(--verified)' } },
          'Saved. Affected numbers were recalculated.',
        ),
      );
      await reload();
    } catch (err) {
      mount(feedback, h('span', { style: { color: 'var(--fail)' } }, String(err)));
    }
  };

  void (async () => {
    try {
      const repos = await api<RepoRow[]>('/api/repos');
      mount(reposSlot, repoList(repos, save));
    } catch {
      mount(reposSlot, h('p', { class: 'faint' }, 'Could not load repositories.'));
    }
  })();

  const semanticEnabled = Boolean(s['semanticEnabled']);

  const collection = h(
    'div',
    { class: 'col' },
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Collection')),
      h(
        'div',
        { class: 'grid-2' },
        h(
          'div',
          { class: 'stack' },
          h(
            'div',
            { class: 'panel' },
            h('h3', {}, 'Providers'),
            ...(state.status?.detections ?? []).map((d) =>
              h(
                'label',
                { class: 'check' },
                h('input', {
                  type: 'checkbox',
                  checked: (s['providers'] as Record<string, boolean>)?.[d.provider] !== false,
                  onchange: (e: Event) => {
                    const providers = { ...((s['providers'] as Record<string, boolean>) ?? {}) };
                    providers[d.provider] = (e.target as HTMLInputElement).checked;
                    void save({ providers });
                  },
                }),
                h(
                  'span',
                  {},
                  d.displayName,
                  h(
                    'small',
                    {},
                    d.installed
                      ? `${d.sessionFileCount} session files · ${fmtBytes(d.totalBytes)} · ${d.dataDirs.join(', ')}`
                      : `not detected · would read ${d.dataDirs.join(', ')}`,
                  ),
                ),
              ),
            ),
          ),
          h(
            'div',
            { class: 'panel' },
            h('h3', {}, 'Scope'),
            h(
              'label',
              { class: 'field' },
              h('span', {}, 'History window (days, 0 = everything)'),
              h('input', {
                type: 'number',
                min: '0',
                value: String(s['historyDays'] ?? 30),
                onchange: (e: Event) =>
                  void save({ historyDays: Number((e.target as HTMLInputElement).value) }),
              }),
            ),
            h(
              'label',
              { class: 'field' },
              h('span', {}, 'Default estimate mode'),
              h(
                'select',
                {
                  onchange: (e: Event) =>
                    void save({ mode: (e.target as HTMLSelectElement).value }),
                },
                ...['conservative', 'balanced', 'upper-range'].map((m) =>
                  h('option', { value: m, selected: m === s['mode'] }, m),
                ),
              ),
            ),
            h(
              'label',
              { class: 'check' },
              h('input', {
                type: 'checkbox',
                checked: Boolean(s['paused']),
                onchange: (e: Event) =>
                  void save({ paused: (e.target as HTMLInputElement).checked }),
              }),
              h('span', {}, 'Pause collection', h('small', {}, 'No files are read while paused.')),
            ),
          ),
        ),
        h(
          'div',
          { class: 'stack' },
          h('div', { class: 'panel' }, h('h3', {}, 'Repositories'), reposSlot),
        ),
      ),
      feedback,
    ),
  );

  const privacy = h(
    'div',
    { class: 'col' },
    h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        h('h2', {}, 'Privacy'),
        h('span', { class: 'note' }, 'Everything below happens on this machine'),
      ),
      h(
        'div',
        { class: 'grid-2' },
        h(
          'div',
          { class: 'stack' },
          h(
            'div',
            { class: 'panel' },
            h('h3', {}, 'Redaction'),
            h(
              'p',
              { class: 'prose', style: { fontSize: '12.5px', marginTop: '-4px' } },
              'Applied when transcripts are read, before anything is written to disk. Secret values are never stored, not even to prove they were found. Redaction is best-effort and should not be relied on as a guarantee.',
            ),
            h(
              'label',
              { class: 'field' },
              h('span', {}, 'Level'),
              h(
                'select',
                {
                  onchange: (e: Event) =>
                    void save({ redactMode: (e.target as HTMLSelectElement).value }),
                },
                h(
                  'option',
                  { value: 'standard', selected: s['redactMode'] === 'standard' },
                  'Standard — secrets, keys, tokens',
                ),
                h(
                  'option',
                  { value: 'strict', selected: s['redactMode'] === 'strict' },
                  'Strict — also emails, hostnames, usernames',
                ),
              ),
            ),
            h(
              'label',
              { class: 'field' },
              h('span', {}, 'Additional terms to scrub (comma separated)'),
              h('input', {
                type: 'text',
                value: ((s['customRedactTerms'] as string[]) ?? []).join(', '),
                placeholder: 'customer name, internal codename',
                onchange: (e: Event) =>
                  void save({
                    customRedactTerms: (e.target as HTMLInputElement).value
                      .split(',')
                      .map((x) => x.trim())
                      .filter(Boolean),
                  }),
              }),
            ),
            h(
              'p',
              { class: 'faint', style: { fontSize: '11.5px', marginBottom: 0 } },
              'Changing this re-processes stored text on the next scan. Already-stored text is not retroactively re-redacted — use "Delete everything" if that matters.',
            ),
          ),
          h(
            'div',
            { class: 'panel' },
            h('h3', {}, 'Semantic analysis'),
            h(
              'p',
              { class: 'prose', style: { fontSize: '12.5px', marginTop: '-4px' } },
              'Optional. Off by default. When on, a language model sees only: task category, integer counts, and a strict-redacted 600-character summary. Never source code, diffs, transcripts, paths, or repository names. Its influence on any estimate is clamped to ±60% and it never sets an estimate alone.',
            ),
            h(
              'label',
              { class: 'check' },
              h('input', {
                type: 'checkbox',
                checked: semanticEnabled,
                onchange: (e: Event) =>
                  void save({ semanticEnabled: (e.target as HTMLInputElement).checked }),
              }),
              h('span', {}, 'Enable semantic task understanding'),
            ),
            h(
              'label',
              { class: 'field' },
              h('span', {}, 'Provider'),
              h(
                'select',
                {
                  onchange: (e: Event) =>
                    void save({ semanticProvider: (e.target as HTMLSelectElement).value }),
                },
                h('option', { value: 'none', selected: s['semanticProvider'] === 'none' }, 'None'),
                h(
                  'option',
                  { value: 'local', selected: s['semanticProvider'] === 'local' },
                  'Local model (nothing leaves this machine)',
                ),
                h(
                  'option',
                  { value: 'anthropic', selected: s['semanticProvider'] === 'anthropic' },
                  'Anthropic API (ANTHROPIC_API_KEY)',
                ),
                h(
                  'option',
                  { value: 'openai', selected: s['semanticProvider'] === 'openai' },
                  'OpenAI API (OPENAI_API_KEY)',
                ),
              ),
            ),
            h(
              'label',
              { class: 'field' },
              h('span', {}, 'Model'),
              h('input', {
                type: 'text',
                value: String(s['semanticModel'] ?? ''),
                onchange: (e: Event) =>
                  void save({ semanticModel: (e.target as HTMLInputElement).value }),
              }),
            ),
            h(
              'label',
              { class: 'field' },
              h('span', {}, 'Local server base URL'),
              h('input', {
                type: 'text',
                value: String(s['semanticLocalBaseUrl'] ?? ''),
                onchange: (e: Event) =>
                  void save({ semanticLocalBaseUrl: (e.target as HTMLInputElement).value }),
              }),
            ),
            h(
              'button',
              {
                class: 'btn',
                disabled: semanticEnabled ? null : true,
                onclick: async () => {
                  try {
                    const r = await post<{ applied: number; requested: number; reason?: string }>(
                      '/api/semantic/run',
                      { days: 7 },
                    );
                    mount(
                      feedback,
                      h(
                        'span',
                        {},
                        `Semantic pass: ${r.applied} of ${r.requested} tasks adjusted. ${r.reason ?? ''}`,
                      ),
                    );
                    await reload();
                  } catch (err) {
                    mount(feedback, h('span', { style: { color: 'var(--fail)' } }, String(err)));
                  }
                },
              },
              'Run semantic pass on the last 7 days',
            ),
          ),
        ),
        h(
          'div',
          { class: 'stack' },
          h(
            'div',
            { class: 'panel' },
            h('h3', {}, 'Your data'),
            h(
              'dl',
              { class: 'kv' },
              h('dt', {}, 'database'),
              h(
                'dd',
                { class: 'mono', style: { fontSize: '11px', wordBreak: 'break-all' } },
                state.status?.dbPath ?? '',
              ),
              h('dt', {}, 'size'),
              h('dd', {}, fmtBytes(state.status?.dbBytes ?? 0)),
              h('dt', {}, 'events'),
              h('dd', {}, (state.status?.eventCount ?? 0).toLocaleString()),
              h('dt', {}, 'tasks'),
              h('dd', {}, (state.status?.taskCount ?? 0).toLocaleString()),
            ),
            h(
              'label',
              { class: 'field', style: { marginTop: '12px' } },
              h('span', {}, 'Delete events older than (days, 0 = keep everything)'),
              h('input', {
                type: 'number',
                min: '0',
                value: String(s['retentionDays'] ?? 0),
                onchange: async (e: Event) => {
                  const days = Number((e.target as HTMLInputElement).value);
                  const r = await post<{ deleted: number }>('/api/privacy/retention', { days });
                  mount(feedback, h('span', {}, `Retention set. ${r.deleted} old events deleted.`));
                  await reload();
                },
              }),
            ),
            h(
              'div',
              { class: 'row', style: { marginTop: '8px' } },
              h(
                'button',
                {
                  class: 'btn',
                  onclick: async () => {
                    const data = await api<unknown>('/api/export');
                    const blob = new Blob([JSON.stringify(data, null, 2)], {
                      type: 'application/json',
                    });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `leverage-export-${new Date().toISOString().slice(0, 10)}.json`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                  },
                },
                'Export my data',
              ),
              h(
                'button',
                {
                  class: 'btn',
                  onclick: async () => {
                    if (
                      !confirm(
                        'Delete all reconstructed tasks and estimates? Raw events are kept and everything can be rebuilt.',
                      )
                    )
                      return;
                    await post('/api/privacy/delete', { scope: 'derived' });
                    await reload();
                  },
                },
                'Delete derived data',
              ),
              h(
                'button',
                {
                  class: 'btn',
                  style: { borderColor: 'var(--fail)', color: 'var(--fail)' },
                  onclick: async () => {
                    if (
                      !confirm(
                        'Delete everything Leverage has imported, including all events? Your Claude Code and Codex files are never touched.',
                      )
                    )
                      return;
                    await post('/api/privacy/delete', { scope: 'all' });
                    await reload();
                  },
                },
                'Delete everything',
              ),
            ),
            h(
              'p',
              { class: 'faint', style: { fontSize: '11.5px', marginTop: '12px', marginBottom: 0 } },
              'Leverage never modifies, moves, or deletes Claude Code, Codex, or Git files. It only reads them.',
            ),
          ),
        ),
      ),
    ),
  );

  return tab === 'privacy' ? privacy : collection;
}

function repoList(
  repos: RepoRow[],
  save: (patch: Record<string, unknown>) => Promise<void>,
): HTMLElement {
  if (repos.length === 0) {
    return h(
      'p',
      { class: 'faint', style: { fontSize: '12.5px' } },
      'No repositories discovered yet. Run a scan first.',
    );
  }
  const excludedRoots = new Set(repos.filter((r) => r.excluded).map((r) => r.root));
  return h(
    'div',
    { class: 'stack', style: { gap: '2px' } },
    ...repos.map((r) =>
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: !r.excluded,
          onchange: (e: Event) => {
            if ((e.target as HTMLInputElement).checked) excludedRoots.delete(r.root);
            else excludedRoots.add(r.root);
            void save({ excludedRepos: [...excludedRoots] });
          },
        }),
        h(
          'span',
          {},
          r.name,
          h(
            'small',
            {},
            `${r.displayPath}${r.isGit ? ' · git' : ' · not a git repository'}${r.fileCount ? ` · ~${r.fileCount.toLocaleString()} files` : ''}`,
          ),
        ),
      ),
    ),
  );
}

/* ================================================================== */
/* Diagnostics                                                         */
/* ================================================================== */

export function renderDiagnostics(state: AppState): HTMLElement {
  const slot = h('div', {}, h('div', { class: 'skeleton', style: { height: '300px' } }));

  void (async () => {
    try {
      const d = await api<Record<string, unknown>>('/api/diagnostics');
      mount(slot, diagnosticsBody(d));
    } catch (err) {
      mount(slot, h('div', { class: 'banner warn' }, String(err)));
    }
  })();

  return h(
    'main',
    { id: 'main', class: 'page' },
    h(
      'section',
      { class: 'band' },
      h(
        'div',
        { class: 'band-head' },
        h('h2', {}, 'Collector'),
        h(
          'span',
          { class: 'note' },
          'Exactly what was read, what was parsed, and what was skipped.',
        ),
      ),
      slot,
    ),
    void state,
  );
}

function diagnosticsBody(d: Record<string, unknown>): HTMLElement {
  const health = (d['health'] ?? []) as Record<string, unknown>[];
  const sources = (d['sources'] ?? []) as Record<string, unknown>[];
  const detections = (d['detections'] ?? []) as Record<string, unknown>[];
  const external = (d['externalRequests'] ?? []) as Record<string, unknown>[];
  const stats = d['lastComputeStats'] as {
    tasksBuilt?: number;
    nonEngineeringRejected?: number;
  } | null;

  return h(
    'div',
    { class: 'grid-2' },
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'panel' },
        h('h3', {}, 'Directories being watched'),
        h(
          'div',
          { class: 'stack', style: { gap: '3px' } },
          ...((d['watchedDirs'] ?? []) as string[]).map((dir) =>
            h('div', { class: 'mono', style: { fontSize: '11.5px', wordBreak: 'break-all' } }, dir),
          ),
        ),
        h(
          'p',
          { class: 'faint', style: { fontSize: '11.5px', marginBottom: 0, marginTop: '10px' } },
          'Nothing outside these directories is read. Leverage does not scan your home directory.',
        ),
      ),
      h(
        'div',
        { class: 'panel' },
        h('h3', {}, 'Parser health'),
        health.length === 0
          ? h(
              'p',
              { class: 'muted', style: { fontSize: '12.5px', margin: 0 } },
              'No transcripts have been parsed yet. Run a scan, or load the demo dataset with ',
              h('code', {}, 'leverage demo'),
              ' (demo events are synthetic and bypass the parsers).',
            )
          : null,
        ...health.map((hh) => {
          const unknown = (hh['unknownTypes'] ?? {}) as Record<string, number>;
          const versions = (hh['providerVersions'] ?? {}) as Record<string, number>;
          return h(
            'div',
            { style: { marginBottom: '16px' } },
            h(
              'div',
              { class: 'mono', style: { fontSize: '12px', marginBottom: '6px' } },
              `${hh['provider']} · ${hh['parser']}`,
            ),
            h(
              'dl',
              { class: 'kv' },
              h('dt', {}, 'events emitted'),
              h('dd', {}, Number(hh['eventsEmitted'] ?? 0).toLocaleString()),
              h('dt', {}, 'lines read'),
              h('dd', {}, Number(hh['linesRead'] ?? 0).toLocaleString()),
              h('dt', {}, 'records ignored'),
              h('dd', {}, Number(hh['recordsIgnored'] ?? 0).toLocaleString()),
              h('dt', {}, 'malformed'),
              h(
                'dd',
                {
                  style: { color: Number(hh['recordsMalformed']) > 0 ? 'var(--warn)' : undefined },
                },
                Number(hh['recordsMalformed'] ?? 0).toLocaleString(),
              ),
              h('dt', {}, 'duplicates dropped'),
              h('dd', {}, Number(hh['recordsDuplicate'] ?? 0).toLocaleString()),
              h('dt', {}, 'replayed history'),
              h('dd', {}, Number(hh['recordsReplay'] ?? 0).toLocaleString()),
              h('dt', {}, 'versions seen'),
              h(
                'dd',
                { class: 'mono', style: { fontSize: '11px' } },
                Object.keys(versions).join(', ') || '—',
              ),
            ),
            Object.keys(unknown).length > 0
              ? h(
                  'p',
                  { style: { fontSize: '12px', color: 'var(--warn)', marginBottom: 0 } },
                  'Unsupported record types (skipped, not counted): ',
                  h(
                    'span',
                    { class: 'mono' },
                    Object.entries(unknown)
                      .map(([k, v]) => `${k}×${v}`)
                      .join(', '),
                  ),
                )
              : h(
                  'p',
                  { class: 'faint', style: { fontSize: '11.5px', marginBottom: 0 } },
                  'Every record type in these files is understood.',
                ),
          );
        }),
      ),
      stats
        ? h(
            'div',
            { class: 'panel' },
            h('h3', {}, 'Last analysis'),
            h(
              'dl',
              { class: 'kv' },
              h('dt', {}, 'engineering tasks'),
              h('dd', {}, String(stats.tasksBuilt ?? 0)),
              h('dt', {}, 'excluded as non-engineering'),
              h('dd', {}, String(stats.nonEngineeringRejected ?? 0)),
            ),
            h(
              'p',
              { class: 'faint', style: { fontSize: '11.5px', marginBottom: 0 } },
              'Coding agents are general assistants. Segments that changed no source files, ran no commands, and touched no repository are excluded from every total — they have no conventional engineering equivalent.',
            ),
          )
        : null,
      h(
        'div',
        { class: 'panel' },
        h('h3', {}, 'Outbound network requests'),
        external.length === 0
          ? h(
              'p',
              { class: 'muted', style: { fontSize: '12.5px', margin: 0 } },
              'None. Leverage has never sent anything off this machine.',
            )
          : h(
              'div',
              { class: 'stack', style: { gap: '6px' } },
              ...external
                .slice(0, 20)
                .map((r) =>
                  h(
                    'div',
                    { class: 'mono', style: { fontSize: '11px' } },
                    `${new Date(Number(r['ts'])).toLocaleString()} · ${r['provider']} · ${r['status']} · ${Number(r['bytes_sent'] ?? 0)} bytes · ${r['purpose']}`,
                  ),
                ),
            ),
      ),
    ),
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'panel' },
        h('h3', {}, 'Providers detected'),
        ...detections.map((dd) =>
          h(
            'div',
            { style: { marginBottom: '14px' } },
            h(
              'div',
              { class: 'row', style: { gap: '8px' } },
              h(
                'span',
                { style: { color: dd['installed'] ? 'var(--verified)' : 'var(--text-faint)' } },
                dd['installed'] ? '●' : '○',
              ),
              h('strong', {}, String(dd['displayName'])),
            ),
            h(
              'div',
              { class: 'mono faint', style: { fontSize: '11px', marginTop: '4px' } },
              `${dd['sessionFileCount']} files · ${fmtBytes(Number(dd['totalBytes'] ?? 0))} · versions ${((dd['versionsSeen'] ?? []) as string[]).slice(0, 4).join(', ') || 'unknown'}`,
            ),
            ...((dd['notes'] ?? []) as string[]).map((n) =>
              h('p', { class: 'faint', style: { fontSize: '11.5px', margin: '4px 0 0' } }, n),
            ),
          ),
        ),
      ),
      h(
        'div',
        { class: 'panel' },
        h('h3', {}, `Source files (${sources.length})`),
        sources.length === 0
          ? h(
              'p',
              { class: 'muted', style: { fontSize: '12.5px', margin: 0 } },
              'No source files tracked yet. Press Rescan to read your Claude Code and Codex sessions.',
            )
          : null,
        h(
          'div',
          { class: 'stack', style: { gap: '4px', maxHeight: '520px', overflowY: 'auto' } },
          ...sources.slice(0, 200).map((sf) =>
            h(
              'div',
              { class: 'row spread mono', style: { fontSize: '10.5px', gap: '10px' } },
              h(
                'span',
                {
                  style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                  title: String(sf['fullPath']),
                },
                String(sf['path']),
              ),
              h(
                'span',
                {
                  class: 'faint',
                  style: {
                    whiteSpace: 'nowrap',
                    color: sf['status'] === 'ok' ? undefined : 'var(--warn)',
                  },
                },
                `${Number(sf['eventsIngested'] ?? 0)} ev · ${fmtBytes(Number(sf['bytesConsumed'] ?? 0))}/${fmtBytes(Number(sf['size'] ?? 0))}${sf['status'] === 'ok' ? '' : ` · ${sf['status']}`}`,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/* ================================================================== */
/* Methodology                                                         */
/* ================================================================== */

export function renderMethodology(state: AppState): HTMLElement {
  const slot = h('div', {}, h('div', { class: 'skeleton', style: { height: '400px' } }));

  void (async () => {
    try {
      const m = await api<Record<string, unknown>>('/api/methodology');
      mount(slot, methodologyBody(m));
    } catch (err) {
      mount(slot, h('div', { class: 'banner warn' }, String(err)));
    }
  })();

  return h(
    'main',
    { id: 'main', class: 'page' },
    h(
      'section',
      { class: 'band' },
      h(
        'div',
        { class: 'band-head' },
        h('h2', {}, 'The benchmark'),
        h('span', { class: 'note' }, state.status?.benchmarkVersion ?? ''),
      ),
      h(
        'div',
        { class: 'prose', style: { fontSize: '15px' } },
        h(
          'p',
          {},
          h('strong', {}, 'Conventional engineering hours'),
          ' are the estimated time a competent software engineer would have needed to produce ',
          h('strong', {}, 'the same accepted outcome'),
          ' using a normal development workflow, without generative-AI assistants or coding agents.',
        ),
        h(
          'p',
          {},
          'The comparison engineer has a modern IDE, a debugger, terminal tooling, documentation, search engines, Stack Overflow, package managers, test frameworks, linters, compilers, deterministic automation, and normal code review. They do not have ChatGPT, Claude, Copilot, Cursor, Codex, AI-generated code, or autonomous agents.',
        ),
        h(
          'p',
          {},
          'This is not a claim about wages, headcount, or economic value, and it is not "working like it is 1995". It is a counterfactual workflow, approximately representative of competent development before generative coding tools became normal.',
        ),
      ),
    ),
    slot,
  );
}

function methodologyBody(m: Record<string, unknown>): HTMLElement {
  const sources = (m['sources'] ?? []) as Record<string, unknown>[];
  const priors = (m['priors'] ?? []) as Record<string, unknown>[];
  const cal = (m['calibration'] ?? {}) as Record<string, unknown>;

  return h(
    'div',
    {},
    h(
      'section',
      { class: 'band' },
      h('div', { class: 'band-head' }, h('h2', {}, 'How a number is built')),
      h(
        'div',
        { class: 'grid-2' },
        h(
          'div',
          { class: 'prose' },
          h(
            'p',
            {},
            h('strong', {}, '1. Tasks, not prompts.'),
            ' Sessions are split where the work demonstrably changed — a long idle gap, or an instruction that is both unrelated in wording and lands in different files. Segments are then merged across sessions and providers when they share a repository and either several changed files or closely related instructions. A correction stays attached to the task it corrects.',
          ),
          h(
            'p',
            {},
            h('strong', {}, '2. Only engineering counts.'),
            ' Coding agents answer all kinds of questions. A segment must show positive evidence of software engineering — source files changed, commands run, a repository involved — before it becomes a task at all. Everything else is excluded from every total and counted in Data.',
          ),
          h(
            'p',
            {},
            h('strong', {}, '3. Outcome before output.'),
            ' Each task is verified from evidence: do the files still exist, did tests pass after the last edit, was it committed, was it reverted, did you interrupt it. Agent self-reports are evidence, never proof, and can never alone produce a validated status.',
          ),
          h(
            'p',
            {},
            h('strong', {}, '4. A distribution, not a number.'),
            ' A category prior supplies a lognormal starting distribution — lognormal because software effort is consistently found to be right-skewed. Bounded, named multipliers adjust its median from structural evidence. Nothing is ever tokens × k, lines × k, or runtime × k; those appear only as heavily sublinear complexity signals.',
          ),
          h(
            'p',
            {},
            h('strong', {}, '5. Three quantities, never conflated.'),
            ' Gross is what the intended outcome would have cost. Accepted is gross scaled by how much was actually produced. Verified is accepted scaled by how strongly it was validated. The headline uses verified.',
          ),
        ),
        h(
          'div',
          { class: 'stack' },
          h(
            'div',
            { class: 'panel' },
            h('h3', {}, 'Steering time'),
            h(
              'div',
              { class: 'prose', style: { fontSize: '12.5px' } },
              h(
                'p',
                { style: { marginTop: 0 } },
                "A person is modelled as present in bounded windows around each observable action: composing an instruction, the moments just after acting, and reading an agent's output once a turn ends. Windows are capped and further bounded by real conversational gaps.",
              ),
              h(
                'p',
                {},
                'The windows are then ',
                h('strong', {}, 'unioned across all sessions'),
                '. That is what stops four concurrent agents from producing four hours of human time in one hour. Unattended agent execution, idle terminals, and background processes contribute nothing.',
              ),
              h(
                'p',
                { style: { marginBottom: 0 } },
                'Because the caps are the model, three parameterisations are computed and a range is shown rather than one falsely precise figure.',
              ),
            ),
          ),
          h(
            'div',
            { class: 'panel' },
            h('h3', {}, 'Known failure modes'),
            h(
              'ul',
              { class: 'exposure' },
              h(
                'li',
                {},
                'Task boundaries are inferred lexically and structurally. Two unrelated tasks in the same files may merge; one task spread across unrelated files may split.',
              ),
              h(
                'li',
                {},
                'Steering time is modelled, not measured. If you read a diff for twenty minutes without touching anything, that time is capped away.',
              ),
              h(
                'li',
                {},
                'Category priors are anchored to a handful of studies, none of which measured your repository or your tasks.',
              ),
              h(
                'li',
                {},
                'Day-level ranges assume tasks are independent, which understates correlated uncertainty.',
              ),
              h(
                'li',
                {},
                'Attribution is ambiguous when you and an agent edit the same files; those tasks are discounted but not excluded.',
              ),
              h('li', {}, 'Work done entirely outside Claude Code and Codex is invisible.'),
            ),
          ),
        ),
      ),
    ),
    h(
      'section',
      { class: 'band' },
      h(
        'div',
        { class: 'band-head' },
        h('h2', {}, 'Empirical anchors'),
        h('span', { class: 'note' }, 'Including the ones that argue against a large multiplier.'),
      ),
      h(
        'div',
        { class: 'stack' },
        ...sources.map((s) =>
          h(
            'div',
            { class: 'panel' },
            h(
              'div',
              { style: { fontSize: '14.5px', fontWeight: '600', marginBottom: '2px' } },
              String(s['title']),
            ),
            h(
              'div',
              { class: 'mono faint', style: { fontSize: '11px', marginBottom: '10px' } },
              String(s['citation']),
            ),
            h(
              'dl',
              { class: 'kv' },
              h('dt', {}, 'population'),
              h('dd', {}, String(s['population'])),
              h('dt', {}, 'setting'),
              h('dd', {}, String(s['setting'])),
              h('dt', {}, 'finding'),
              h('dd', {}, String(s['finding'])),
              h('dt', {}, 'limitations'),
              h('dd', { style: { color: 'var(--warn)' } }, String(s['limitations'])),
              h('dt', {}, 'applied to'),
              h('dd', {}, String(s['appliedTo'])),
            ),
          ),
        ),
      ),
    ),
    h(
      'section',
      { class: 'band' },
      h(
        'div',
        { class: 'band-head' },
        h('h2', {}, 'Category priors'),
        h('span', { class: 'note' }, 'Median hours and spread for a typical task of each kind.'),
      ),
      h(
        'table',
        { class: 'tasks' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', {}, 'Category'),
            h('th', { style: { textAlign: 'right' } }, 'Median'),
            h('th', { style: { textAlign: 'right' } }, 'σ'),
            h('th', {}, 'Why'),
          ),
        ),
        h(
          'tbody',
          {},
          ...priors.map((p) =>
            h(
              'tr',
              { style: { cursor: 'default' } },
              h('td', {}, String(p['label'])),
              h('td', { class: 'num' }, `${fmtHours(Number(p['medianHours']))}h`),
              h('td', { class: 'num faint' }, Number(p['sigma']).toFixed(2)),
              h(
                'td',
                { style: { fontSize: '12px', color: 'var(--text-dim)', whiteSpace: 'normal' } },
                String(p['rationale']),
              ),
            ),
          ),
        ),
      ),
    ),
    h(
      'section',
      { class: 'band' },
      h('div', { class: 'band-head' }, h('h2', {}, 'Your calibration')),
      Number(cal['totalEntries'] ?? 0) === 0
        ? h(
            'div',
            { class: 'prose' },
            h(
              'p',
              {},
              'You have not calibrated any estimates yet. Open a task and answer "how long would this have taken you?" — after three answers a personalised view becomes available alongside the standardised one. The two are always kept separate: your correction calibrates your model, not the shared benchmark.',
            ),
          )
        : h(
            'div',
            { class: 'panel' },
            h(
              'dl',
              { class: 'kv' },
              h('dt', {}, 'calibrations'),
              h('dd', {}, String(cal['totalEntries'])),
              h('dt', {}, 'overall ratio'),
              h(
                'dd',
                {},
                `${Number(cal['overallMultiplier'] ?? 1).toFixed(2)}× the standardised estimate`,
                ' ',
                tag('user-corrected'),
              ),
              h('dt', {}, 'personalised view'),
              h(
                'dd',
                {},
                cal['personalisedViewAvailable'] ? 'available' : 'needs at least 3 calibrations',
              ),
            ),
          ),
    ),
  );
}
