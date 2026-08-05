import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { containsSecret, redact, redactPath } from '../../src/privacy/redact.ts';
import {
  buildPrompt,
  createSemanticProvider,
  parseAdjustments,
  sanitizeTask,
} from '../../src/semantic/provider.ts';
import { DEFAULT_SETTINGS, loadSettings, sanitizeSettingsPatch } from '../../src/core/config.ts';
import { Db } from '../../src/store/db.ts';
import { tmpDir } from '../helpers.ts';
import {
  aliasProjects,
  describeExposure,
  renderCard,
  DEFAULT_CARD_OPTIONS,
} from '../../src/share/card.ts';
import { emptyDayMetrics } from '../../src/analytics/metrics.ts';
import type { TaskRecord } from '../../src/core/types.ts';

/* ================================================================== */
/* Redaction                                                           */
/* ================================================================== */

/**
 * Test credentials are assembled at runtime from fragments.
 *
 * A literal key-shaped string in source trips GitHub push protection and
 * every other secret scanner, even when the value is invented. Composing them
 * keeps the scanners quiet while `redact()` still receives byte-identical
 * input, so the tests lose nothing.
 */
const FAKE = {
  anthropic: ['sk', 'ant', 'api03', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'].join('-'),
  openai: ['sk', 'proj', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'].join('-'),
  github: `gh${'p'}_${'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'}`,
  githubPat: `github${'_'}pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz012345`,
  aws: `AK${'IA'}IOSFODNN7EXAMPLE`,
  slack: ['xoxb', '1234567890', 'abcdefghijkl'].join('-'),
  google: `AI${'za'}SyA1234567890abcdefghijklmnopqrstuvw`,
  stripe: ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_'),
  jwt: [
    'eyJhbGciOiJIUzI1NiJ9',
    'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  ].join('.'),
  bearerToken: 'abcdefghijklmnopqrstuvwxyz012345',
  postgres: `postgres://user:hunter2@db.internal:5432/app`,
};

describe('secret redaction', () => {
  const cases: [string, string, string][] = [
    ['anthropic key', `export ANTHROPIC_API_KEY=${FAKE.anthropic}`, 'sk-ant-'],
    ['openai key', `key is ${FAKE.openai}`, 'sk-proj-'],
    ['github token', `token ${FAKE.github}`, 'ghp_'],
    ['github pat', FAKE.githubPat, 'github_pat_'],
    ['aws key', `${FAKE.aws} is the id`, 'AKIA'],
    ['slack token', FAKE.slack, 'xoxb-'],
    ['google key', FAKE.google, 'AIza'],
    ['stripe key', FAKE.stripe, 'sk_live_'],
    ['jwt', FAKE.jwt, 'eyJhbGci'],
    ['bearer', `Authorization: Bearer ${FAKE.bearerToken}`, 'abcdefghijklmnop'],
    ['postgres url', FAKE.postgres, 'hunter2'],
    ['env secret', 'DATABASE_PASSWORD=sup3rs3cret!', 'sup3rs3cret'],
    ['password assignment', 'password: "correct-horse-battery"', 'correct-horse'],
  ];

  for (const [name, input, leak] of cases) {
    test(`removes ${name} and leaves a labelled marker`, () => {
      const r = redact(input);
      assert.ok(!r.text.includes(leak), `"${leak}" survived redaction: ${r.text}`);
      assert.ok(r.text.includes('[REDACTED'), 'a marker is left in place');
      assert.equal(r.redacted, true);
      assert.ok(r.hits.length > 0);
    });
  }

  test('a private key block is removed in full', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc123\n-----END RSA PRIVATE KEY-----';
    const r = redact(`here it is:\n${pem}\nthanks`);
    assert.ok(!r.text.includes('MIIEow'));
    assert.ok(
      r.text.includes('here it is:') && r.text.includes('thanks'),
      'surrounding text is preserved',
    );
  });

  test('never stores the secret value alongside the marker', () => {
    const r = redact(`token ${FAKE.github}`);
    assert.ok(!/ghp_[A-Za-z0-9]{10}/.test(r.text));
    assert.ok(
      !JSON.stringify(r.hits).includes('ghp_'),
      'hit records carry a kind and a count, never the value',
    );
  });

  test('standard mode keeps ordinary text and paths intact', () => {
    const input = 'Refactor src/auth/session.ts and run npm test in /Users/alice/project';
    const r = redact(input, { mode: 'standard' });
    assert.equal(r.text, input);
    assert.equal(r.redacted, false);
  });

  test('strict mode additionally removes emails, private hosts and usernames', () => {
    const r = redact('mail alice@corp.example from /Users/alice/proj via http://10.0.0.5:8080/x', {
      mode: 'strict',
    });
    assert.ok(!r.text.includes('alice@corp.example'));
    assert.ok(!r.text.includes('/Users/alice'), 'the filesystem username is masked');
    assert.ok(!r.text.includes('10.0.0.5'));
  });

  test('custom terms are scrubbed case-insensitively', () => {
    const r = redact('The Acme Corp integration is done', { customTerms: ['acme corp'] });
    assert.ok(!r.text.toLowerCase().includes('acme corp'));
  });

  test('redaction is idempotent', () => {
    const once = redact(`key ${FAKE.anthropic}`).text;
    assert.equal(redact(once).text, once);
  });

  test('containsSecret detects only always-on rules', () => {
    assert.equal(containsSecret(FAKE.github), true);
    assert.equal(containsSecret('just some prose'), false);
    assert.equal(containsSecret('alice@corp.example'), false, 'emails are not always-on secrets');
  });

  test('redactPath keeps meaning and drops the machine-specific prefix', () => {
    assert.equal(redactPath('/Users/alice/work/proj/src/auth/session.ts'), '…/src/auth/session.ts');
    assert.equal(redactPath('a/b'), 'a/b');
  });

  test('large inputs do not blow up', () => {
    const big = `${'lorem ipsum '.repeat(50_000)}${FAKE.github}`;
    const r = redact(big);
    assert.ok(!r.text.includes('ghp_A'));
  });
});

/* ================================================================== */
/* Semantic opt-in boundary                                            */
/* ================================================================== */

describe('semantic layer privacy', () => {
  const task = {
    taskId: 't1',
    title: 'Fix login for alice@corp.example on /Users/alice/secret-project',
    category: 'debugging' as const,
    status: 'completed-validated',
    filesChanged: 2,
    linesAdded: 30,
    linesRemoved: 4,
    subsystems: 1,
    testsRun: 1,
    testsPassed: 1,
    errors: 2,
    userInstructions: 3,
    instructionSummary: `Login fails for alice@corp.example. The token is ${FAKE.anthropic} and the repo is /Users/alice/secret-project.`,
    fileBasenames: ['/Users/alice/secret-project/src/auth/session.ts'],
  };

  test('outbound payloads carry no secrets, emails, usernames or directory structure', () => {
    const clean = sanitizeTask(task, []);
    const payload = buildPrompt([clean]);
    assert.ok(!payload.includes('sk-ant-'), 'API keys never leave');
    assert.ok(!payload.includes('alice@corp.example'), 'emails never leave');
    assert.ok(!payload.includes('/Users/alice'), 'usernames never leave');
    assert.ok(!payload.includes('secret-project'), 'directory structure never leaves');
    assert.ok(payload.includes('session.ts'), 'only basenames are sent');
    assert.ok(payload.includes('debugging'), 'the category is sent');
  });

  test('custom redaction terms apply to outbound payloads too', () => {
    const clean = sanitizeTask({ ...task, instructionSummary: 'Work for Northwind Traders' }, [
      'Northwind Traders',
    ]);
    assert.ok(!buildPrompt([clean]).includes('Northwind'));
  });

  test('summaries are length-capped before leaving', () => {
    const clean = sanitizeTask({ ...task, instructionSummary: 'x'.repeat(10_000) }, []);
    assert.ok(clean.instructionSummary.length <= 600);
  });

  test('model output is validated and clamped, never trusted verbatim', () => {
    const parsed = parseAdjustments(
      JSON.stringify([
        { taskId: 'a', complexityMultiplier: 1000, boilerplateFraction: 5, rationale: 'x' },
        { taskId: 'b', complexityMultiplier: -3, boilerplateFraction: -1, rationale: 'y' },
        { taskId: 'c', complexityMultiplier: 'not a number', rationale: 'z' },
      ]),
      'test-model',
    );
    assert.equal(parsed.get('a')?.complexityMultiplier, 1.6);
    assert.equal(parsed.get('a')?.boilerplateFraction, 0.85);
    assert.equal(parsed.get('b')?.complexityMultiplier, 0.6);
    assert.equal(parsed.get('b')?.boilerplateFraction, 0);
    assert.equal(parsed.get('c')?.complexityMultiplier, 1, 'garbage falls back to neutral');
  });

  test('malformed model output yields nothing rather than throwing', () => {
    assert.equal(parseAdjustments('I refuse to answer.', 'm').size, 0);
    assert.equal(parseAdjustments('[not json', 'm').size, 0);
    assert.equal(parseAdjustments('', 'm').size, 0);
    assert.equal(parseAdjustments('{"taskId":"a"}', 'm').size, 0, 'a bare object is not an array');
  });
});

/* ================================================================== */
/* Share-card privacy                                                  */
/* ================================================================== */

describe('share card privacy defaults', () => {
  const day = '2026-05-12';
  const metrics = {
    ...emptyDayMetrics(day),
    verifiedHours: { median: 27, sigma: 0.5, p10: 19, p50: 27, p90: 38, mean: 29 },
    steeringMs: 3180_000,
    outputLeverage: 30,
    peakConcurrency: 4,
    taskCount: 12,
    projectCount: 2,
    repoHours: { r1: 11.5, r2: 11 },
    statusCounts: {
      ...emptyDayMetrics(day).statusCounts,
      'completed-validated': 9,
    },
  };

  const tasks: TaskRecord[] = [
    {
      taskId: 't1',
      title: 'Implement password reset for acme-corp customer portal',
      intent: 'secret intent',
      category: 'feature-brownfield',
      categorySource: 'inferred',
      status: 'completed-validated',
      statusSource: 'inferred',
      repoId: 'r1',
      startedAt: Date.UTC(2026, 4, 12, 9),
      endedAt: Date.UTC(2026, 4, 12, 10),
      sessionIds: ['s1'],
      providers: ['claude-code'],
      evidence: {} as never,
      wallClockMs: 3600_000,
      agentActiveMs: 1800_000,
      steeringMs: 600_000,
      excluded: false,
      userEdited: false,
      dayKey: day,
    },
    {
      taskId: 't2',
      title: 'Migrate northwind-internal billing schema',
      intent: '',
      category: 'migration',
      categorySource: 'inferred',
      status: 'completed-validated',
      statusSource: 'inferred',
      repoId: 'r2',
      startedAt: Date.UTC(2026, 4, 12, 11),
      endedAt: Date.UTC(2026, 4, 12, 12),
      sessionIds: ['s2'],
      providers: ['codex'],
      evidence: {} as never,
      wallClockMs: 3600_000,
      agentActiveMs: 1800_000,
      steeringMs: 600_000,
      excluded: false,
      userEdited: false,
      dayKey: day,
    },
  ];

  const data = {
    day,
    metrics,
    tasks,
    repoNames: { r1: 'acme-corp-portal', r2: 'northwind-internal' },
    concurrency: [],
    steeringIntervals: [[Date.UTC(2026, 4, 12, 9), Date.UTC(2026, 4, 12, 9, 30)]] as [
      number,
      number,
    ][],
    weekly: [{ day, verifiedHours: 27, steeringHours: 0.9 }],
  };

  for (const variant of ['headline', 'timeline', 'projects', 'weekly'] as const) {
    test(`${variant} card leaks no project names, titles or paths by default`, () => {
      const svg = renderCard(data, { ...DEFAULT_CARD_OPTIONS, variant });
      assert.ok(!svg.includes('acme-corp-portal'), 'repository names are hidden');
      assert.ok(!svg.includes('northwind-internal'), 'repository names are hidden');
      assert.ok(!svg.includes('password reset'), 'task titles are hidden');
      assert.ok(!svg.includes('billing schema'), 'task titles are hidden');
      assert.ok(!svg.includes('/Users/'), 'no filesystem paths');
      assert.ok(!svg.includes('secret intent'), 'no prompts');
      assert.ok(svg.includes('<svg'), 'still renders');
    });
  }

  test('the qualifier is present on every variant', () => {
    for (const variant of ['headline', 'timeline', 'projects', 'weekly'] as const) {
      const svg = renderCard(data, { ...DEFAULT_CARD_OPTIONS, variant });
      assert.ok(
        svg.includes('conventional non-AI engineering workflow'),
        `${variant} must carry the benchmark qualifier`,
      );
    }
  });

  test('projects appear as aliases unless explicitly revealed', () => {
    const hidden = renderCard(data, { ...DEFAULT_CARD_OPTIONS, variant: 'projects' });
    assert.ok(hidden.includes('Project A'));
    assert.ok(!hidden.includes('acme-corp-portal'));

    const shown = renderCard(data, {
      ...DEFAULT_CARD_OPTIONS,
      variant: 'projects',
      revealProjects: true,
    });
    assert.ok(shown.includes('acme-corp-portal'), 'opting in works');
  });

  test('alias letters follow the displayed ordering', () => {
    const aliases = aliasProjects(tasks, data.repoNames, false, metrics.repoHours);
    assert.equal(aliases['r1'], 'Project A', 'the largest bar is Project A');
    assert.equal(aliases['r2'], 'Project B');
  });

  test('exposure lines are well-formed English, not mangled by a rename', () => {
    for (const variant of ['headline', 'timeline', 'projects', 'weekly'] as const) {
      for (const line of describeExposure({ ...DEFAULT_CARD_OPTIONS, variant }, data)) {
        assert.ok(line.length > 3, `empty exposure line in ${variant}`);
        // A blind find-and-replace across labels once produced "Your your
        // time time". Any immediately repeated word is a rename gone wrong.
        const repeated = /\b(\w+)\s+\1\b/i.exec(line);
        assert.equal(repeated, null, `repeated word in ${variant}: "${line}"`);
      }
    }
  });

  test('the exposure list matches what the card actually contains', () => {
    const opts = { ...DEFAULT_CARD_OPTIONS, variant: 'projects' as const };
    const hiddenList = describeExposure(opts, data);
    assert.ok(hiddenList.some((l) => l.includes('Project A')));
    assert.ok(!hiddenList.some((l) => l.includes('acme-corp-portal')));

    const shownList = describeExposure({ ...opts, revealProjects: true }, data);
    assert.ok(
      shownList.some((l) => l.includes('acme-corp-portal')),
      'revealing is disclosed',
    );
  });

  test('user-supplied text is XML-escaped rather than injected', () => {
    const evil = {
      ...data,
      repoNames: { r1: '</text><script>alert(1)</script>', r2: 'b' },
    };
    const svg = renderCard(evil, {
      ...DEFAULT_CARD_OPTIONS,
      variant: 'projects',
      revealProjects: true,
    });
    assert.ok(!svg.includes('<script>'), 'markup is escaped');
    assert.ok(svg.includes('&lt;script&gt;'));
  });
});

/* ================================================================== */
/* Egress guarantees                                                   */
/* ================================================================== */

describe('the local semantic provider keeps its promise', () => {
  const openDb = () => new Db({ dir: tmpDir('screentime-egress-') });

  test('never sends an API key to a local endpoint', () => {
    // The settings UI labels this provider "nothing leaves this machine".
    // It is built by spreading the OpenAI config, so a regression here means
    // the user's OPENAI_API_KEY is sent to whatever the base URL points at.
    const prev = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-must-never-be-sent';
    const db = openDb();
    try {
      const p = createSemanticProvider(db, {
        ...DEFAULT_SETTINGS,
        semanticEnabled: true,
        semanticProvider: 'local',
      });
      assert.ok(p, 'provider is built');
      assert.equal(p.isLocal, true);
      const headers = (p as unknown as { cfg: { headers: (k?: string) => object } }).cfg.headers(
        process.env['OPENAI_API_KEY'],
      );
      const serialized = JSON.stringify(headers).toLowerCase();
      assert.ok(!serialized.includes('authorization'), 'no authorization header');
      assert.ok(!serialized.includes('sk-must-never-be-sent'), 'no key in headers');
      assert.equal(
        (p as unknown as { cfg: { apiKeyEnv?: string } }).cfg.apiKeyEnv,
        undefined,
        'no key is even read from the environment',
      );
    } finally {
      db.close();
      if (prev === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = prev;
    }
  });

  test('the remote providers still authenticate normally', () => {
    const db = openDb();
    try {
      const p = createSemanticProvider(db, {
        ...DEFAULT_SETTINGS,
        semanticEnabled: true,
        semanticProvider: 'openai',
      });
      assert.ok(p);
      assert.equal(p.isLocal, false);
      const headers = (p as unknown as { cfg: { headers: (k?: string) => object } }).cfg.headers(
        'sk-test',
      );
      assert.ok(JSON.stringify(headers).includes('sk-test'), 'remote calls are still authorised');
    } finally {
      db.close();
    }
  });
});

describe('settings are validated at the trust boundary', () => {
  test('a non-loopback local base URL is refused', () => {
    for (const bad of [
      'https://attacker.example/v1',
      'http://169.254.169.254/latest',
      'file:///etc/passwd',
      'not a url',
    ]) {
      const patch = sanitizeSettingsPatch({ semanticLocalBaseUrl: bad });
      assert.equal(
        patch.semanticLocalBaseUrl,
        undefined,
        `${bad} must not become the local endpoint`,
      );
    }
  });

  test('loopback URLs are accepted', () => {
    for (const ok of ['http://127.0.0.1:11434/v1', 'http://localhost:1234/v1']) {
      assert.equal(sanitizeSettingsPatch({ semanticLocalBaseUrl: ok }).semanticLocalBaseUrl, ok);
    }
  });

  test('unknown keys are dropped and known ones are type-checked', () => {
    const patch = sanitizeSettingsPatch({
      __proto__: { polluted: true },
      notASetting: 'nope',
      historyDays: 'thirty',
      excludedRepos: [1, 2, 3],
      redactMode: 'off',
      semanticProvider: 'evil',
      autoRefreshSeconds: -5,
    });
    assert.equal((patch as Record<string, unknown>)['notASetting'], undefined);
    assert.equal(patch.historyDays, undefined, 'a string is not a day count');
    assert.equal(patch.excludedRepos, undefined, 'numbers are not repo paths');
    assert.equal(patch.redactMode, undefined, 'redaction cannot be turned off');
    assert.equal(patch.semanticProvider, undefined, 'provider is an enum');
    assert.equal(patch.autoRefreshSeconds, 0, 'out-of-range numbers are clamped, not stored raw');
  });
});

describe('a hostile endpoint cannot reach the network by any route', () => {
  const HOSTILE = [
    'https://attacker.example/v1',
    // Classic DNS-suffix trick: starts with a loopback literal, resolves out.
    'http://127.0.0.1.evil.com/v1',
    // Cloud metadata service.
    'http://169.254.169.254/v1',
  ];

  test('a value already in the database is re-validated on read', () => {
    // Checking only on write would trust anything written by an older build,
    // a restored backup, or a hand-edited row.
    const db = new Db({ dir: tmpDir('screentime-stored-') });
    try {
      for (const bad of HOSTILE) {
        db.setConfig('settings', {
          ...DEFAULT_SETTINGS,
          semanticEnabled: true,
          semanticProvider: 'local',
          semanticLocalBaseUrl: bad,
        });
        assert.notEqual(
          loadSettings(db).semanticLocalBaseUrl,
          bad,
          `${bad} must not survive a load`,
        );
      }
    } finally {
      db.close();
    }
  });

  test('the provider refuses to build even if handed a hostile URL directly', () => {
    const db = new Db({ dir: tmpDir('screentime-direct-') });
    try {
      for (const bad of HOSTILE) {
        const p = createSemanticProvider(db, {
          ...DEFAULT_SETTINGS,
          semanticEnabled: true,
          semanticProvider: 'local',
          semanticLocalBaseUrl: bad,
        });
        assert.equal(p, undefined, `${bad} must not produce a provider`);
      }
      // …and a genuine loopback endpoint still works.
      const ok = createSemanticProvider(db, {
        ...DEFAULT_SETTINGS,
        semanticEnabled: true,
        semanticProvider: 'local',
        semanticLocalBaseUrl: 'http://127.0.0.1:11434/v1',
      });
      assert.ok(ok, 'a loopback endpoint is still allowed');
    } finally {
      db.close();
    }
  });
});
