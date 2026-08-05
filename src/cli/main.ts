import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { configureLogging, log } from '../core/log.ts';
import { dayKey, fmtCount, formatDuration, roundHuman } from '../core/util.ts';
import { loadSettings, saveSettings } from '../core/config.ts';
import { createContext, handleApi, runIngest, startAutoRefresh } from '../server/api.ts';
import { createServer, listen } from '../server/http.ts';
import {
  activeDays,
  computeDayMetrics,
  loadEstimates,
  loadTasksForDay,
} from '../analytics/metrics.ts';
import { CATEGORY_LABELS } from '../tasks/categorize.ts';
import { BENCHMARK_VERSION } from '../estimate/priors.ts';
import { demoBaseInstant, installDemoData } from '../demo/generate.ts';

const HELP = `
screentime — your AI screen time, for engineering

USAGE
  screentime [command] [options]

COMMANDS
  run                Open the dashboard now, scan in the background
  start              Ingest, then open the dashboard (default)
  serve              Serve the dashboard without ingesting first
  ingest             Scan Claude Code and Codex data and update the index
  today              Print today's summary to the terminal
  day <YYYY-MM-DD>   Print a specific day's summary
  tasks [day]        List reconstructed tasks for a day
  share <day>        Write a share card to an SVG file
  doctor             Show detected providers, parser health, and watched paths
  demo               Load a clearly-labelled synthetic dataset
  reset [--all]      Delete derived data (--all also deletes imported events)
  methodology        Print the benchmark definition and its sources

OPTIONS
  --port <n>         Port for the dashboard (default 7777)
  --days <n>         History window for ingest (default from settings)
  --variant <v>      headline | timeline | projects | weekly  (share)
  --theme <t>        dark | light  (share)
  --reveal-projects  Include real project names on the share card
  --out <path>       Output file for share
  --no-open          Do not open a browser
  --json             Machine-readable output
`;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  const command = positional.shift() ?? 'start';
  return { command, positional, flags };
}

const c = {
  dim: (s: string) => `[2m${s}[0m`,
  bold: (s: string) => `[1m${s}[0m`,
  green: (s: string) => `[32m${s}[0m`,
  yellow: (s: string) => `[33m${s}[0m`,
  red: (s: string) => `[31m${s}[0m`,
  cyan: (s: string) => `[36m${s}[0m`,
};

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags['help'] || args.command === 'help' || args.flags['h']) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = createContext();
  configureLogging({
    dir: ctx.db.dir,
    quiet: true,
    level: (process.env.SCREENTIME_LOG_LEVEL as 'info') ?? 'info',
  });
  const settings = loadSettings(ctx.db);

  try {
    switch (args.command) {
      case 'run':
      case 'start':
      case 'serve': {
        // Three ways to come up, differing only in when the scan happens:
        //   serve  never scans — the dashboard reads what is already stored
        //   start  scans first, so the page is complete the moment it opens
        //   run    opens first and scans behind it, so there is no wait
        // `run` is the one you want on a machine with a lot of history, where
        // a full scan is measured in tens of seconds.
        const scanFirst = args.command === 'start' && !settings.paused;
        const scanBehind = args.command === 'run' && !settings.paused;
        if (scanFirst) {
          process.stdout.write(c.dim('Scanning local agent data…\n'));
          await runIngestWithProgress(ctx, args);
        }
        const port = Number(args.flags['port'] ?? 7777);
        const server = createServer(ctx, { port });
        const actual = await listen(server, port);
        const url = `http://127.0.0.1:${actual}`;
        if (actual !== port) {
          // Silently sliding to another port is how you end up reading a stale
          // instance that is still holding the one you asked for.
          process.stdout.write(
            `\n  ${c.yellow(`Port ${port} was busy — using ${actual} instead.`)}\n` +
              `  ${c.dim(`Something is already listening on ${port}; if it is another AI Screen Time, stop it first.`)}\n`,
          );
        }
        process.stdout.write(
          `\n  ${c.bold('AI Screen Time')} ${c.dim(`· ${BENCHMARK_VERSION}`)}\n`,
        );
        process.stdout.write(`  ${c.cyan(url)}\n`);
        process.stdout.write(`  ${c.dim(`data: ${ctx.db.file}`)}\n`);
        process.stdout.write(`  ${c.dim('Ctrl-C to stop. Everything stays on this machine.')}\n\n`);
        const refreshEvery = loadSettings(ctx.db).autoRefreshSeconds;
        const stopRefresh = refreshEvery > 0 ? startAutoRefresh(ctx) : () => {};
        if (refreshEvery > 0) {
          process.stdout.write(
            `  ${c.dim(`watching for new sessions every ${refreshEvery}s`)}\n\n`,
          );
        }
        if (!args.flags['no-open']) openBrowser(url);
        if (scanBehind) {
          // Deliberately not awaited: the page is already open and reports
          // progress itself, and the dashboard switches to today on its own
          // once the scan turns up the first task of the day.
          process.stdout.write(`  ${c.dim('scanning in the background…')}\n\n`);
          void runIngest(ctx, settings, true).catch((err: unknown) => {
            log.warn('background scan failed', { err: String(err) });
            process.stdout.write(
              `  ${c.yellow('Background scan failed.')} ${c.dim('Run `screentime ingest` to see why.')}\n`,
            );
          });
        }
        await new Promise<void>((resolve) => {
          const shutdown = (): void => {
            stopRefresh();
            server.close(() => resolve());
          };
          process.on('SIGINT', shutdown);
          process.on('SIGTERM', shutdown);
        });
        return 0;
      }

      case 'ingest': {
        await runIngestWithProgress(ctx, args);
        // Running `screentime ingest` is itself the consent onboarding asks for,
        // so the dashboard should not demand it again afterwards.
        saveSettings(ctx.db, { onboarded: true });
        const last = ctx.state.lastIngest;
        const comp = ctx.state.lastCompute;
        if (args.flags['json']) {
          process.stdout.write(`${JSON.stringify({ ingest: last, compute: comp })}\n`);
        } else {
          process.stdout.write(
            `\n  ${c.green('✓')} ${last?.events.toLocaleString() ?? 0} events from ${last?.files ?? 0} files in ${last?.durationMs ?? 0}ms\n` +
              `  ${c.green('✓')} ${comp?.tasks ?? 0} engineering tasks reconstructed ` +
              `${c.dim(`(${comp?.rejected ?? 0} non-engineering segments excluded)`)}\n\n`,
          );
        }
        return 0;
      }

      case 'today':
      case 'day': {
        const day =
          args.command === 'today'
            ? dayKey(Date.now(), settings.timezone || undefined)
            : (args.positional[0] ?? dayKey(Date.now(), settings.timezone || undefined));
        printDay(ctx, day, Boolean(args.flags['json']));
        return 0;
      }

      case 'tasks': {
        const day = args.positional[0] ?? dayKey(Date.now(), settings.timezone || undefined);
        const tasks = loadTasksForDay(ctx.db, day);
        const est = loadEstimates(
          ctx.db,
          tasks.map((t) => t.taskId),
        );
        if (args.flags['json']) {
          process.stdout.write(
            `${JSON.stringify(
              tasks.map((t) => ({ ...t, estimate: est.get(t.taskId) ?? null })),
              null,
              2,
            )}\n`,
          );
          return 0;
        }
        process.stdout.write(`\n  ${c.bold(day)} — ${tasks.length} task(s)\n\n`);
        for (const t of tasks) {
          const e = est.get(t.taskId);
          const mark = t.excluded ? c.dim('—') : statusMark(t.status);
          process.stdout.write(
            `  ${mark} ${c.bold(t.title.slice(0, 60))}\n` +
              `     ${c.dim(`${CATEGORY_LABELS[t.category]} · ${t.status} · ${e ? `${e.verified.median.toFixed(1)}h verified` : 'no estimate'} · ${e?.confidence ?? '?'} confidence`)}\n` +
              `     ${c.dim(`${t.evidence.filesChanged} files · +${t.evidence.linesAdded}/-${t.evidence.linesRemoved} · ${t.evidence.testsRun} test runs · ${t.sessionIds.length} session(s)`)}\n`,
          );
        }
        process.stdout.write('\n');
        return 0;
      }

      case 'share': {
        const day = args.positional[0] ?? dayKey(Date.now(), settings.timezone || undefined);
        const variant = (args.flags['variant'] as string) ?? 'headline';
        const theme = (args.flags['theme'] as string) ?? 'dark';
        const reveal = args.flags['reveal-projects'] ? '1' : '0';
        const url = new URL(
          `http://local/api/share/${day}?variant=${variant}&theme=${theme}&revealProjects=${reveal}`,
        );
        const res = await handleApi(ctx, 'GET', url, undefined);
        if (typeof res.raw !== 'string') {
          process.stderr.write(`${c.red('Failed to render card')}: ${JSON.stringify(res.body)}\n`);
          return 1;
        }
        const out = (args.flags['out'] as string) ?? `screentime-${day}-${variant}.svg`;
        fs.writeFileSync(out, res.raw, 'utf8');
        const preview = await handleApi(
          ctx,
          'GET',
          new URL(
            `http://local/api/share-preview/${day}?variant=${variant}&revealProjects=${reveal}`,
          ),
          undefined,
        );
        const exposure = (preview.body as { exposure: string[] }).exposure;
        process.stdout.write(
          `\n  ${c.green('✓')} wrote ${c.bold(path.resolve(out))}\n\n  This card exposes:\n`,
        );
        for (const line of exposure) process.stdout.write(`    ${c.dim('·')} ${line}\n`);
        process.stdout.write('\n');
        return 0;
      }

      case 'doctor': {
        const res = await handleApi(ctx, 'GET', new URL('http://local/api/diagnostics'), undefined);
        const d = res.body as Record<string, unknown>;
        if (args.flags['json']) {
          process.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
          return 0;
        }
        process.stdout.write(`\n  ${c.bold('Watched directories')}\n`);
        for (const dir of d['watchedDirs'] as string[]) {
          const exists = fs.existsSync(dir);
          process.stdout.write(`    ${exists ? c.green('✓') : c.yellow('·')} ${dir}\n`);
        }
        process.stdout.write(`\n  ${c.bold('Providers')}\n`);
        for (const det of d['detections'] as Record<string, unknown>[]) {
          process.stdout.write(
            `    ${det['installed'] ? c.green('✓') : c.yellow('·')} ${det['displayName']}: ` +
              `${det['sessionFileCount']} files, ${((det['totalBytes'] as number) / 1e6).toFixed(1)} MB, ` +
              `versions ${(det['versionsSeen'] as string[]).slice(0, 3).join(', ') || 'unknown'}\n`,
          );
          for (const note of det['notes'] as string[])
            process.stdout.write(`      ${c.dim(note)}\n`);
        }
        process.stdout.write(`\n  ${c.bold('Parser health')}\n`);
        for (const h of d['health'] as Record<string, unknown>[]) {
          process.stdout.write(
            `    ${h['provider']}/${h['parser']}: ${h['eventsEmitted']} events, ` +
              `${h['recordsMalformed']} malformed, ${h['recordsDuplicate']} duplicate, ` +
              `${h['recordsReplay']} replayed\n`,
          );
          const unknown = h['unknownTypes'] as Record<string, number>;
          const keys = Object.keys(unknown ?? {});
          if (keys.length) {
            process.stdout.write(
              `      ${c.yellow('unsupported record types:')} ${keys.slice(0, 8).join(', ')}\n`,
            );
          }
        }
        const stats = d['lastComputeStats'] as {
          tasksBuilt?: number;
          nonEngineeringRejected?: number;
        } | null;
        if (stats) {
          process.stdout.write(
            `\n  ${c.bold('Last analysis')}: ${stats.tasksBuilt} engineering tasks, ` +
              `${stats.nonEngineeringRejected} non-engineering segments excluded\n`,
          );
        }
        process.stdout.write(
          `\n  ${c.dim(`database: ${d['dbPath']} (${(((d['dbBytes'] as number) || 0) / 1e6).toFixed(1)} MB)`)}\n`,
        );
        process.stdout.write(`  ${c.dim(`log: ${d['logFile']}`)}\n\n`);
        return 0;
      }

      case 'demo': {
        const n = installDemoData(ctx.db);
        const s = saveSettings(ctx.db, { onboarded: true });
        const from = 0;
        const { computeDerived } = await import('../analytics/pipeline.ts');
        const res = computeDerived(ctx.db, { settings: s, from });
        for (const d of res.daysTouched) computeDayMetrics(ctx.db, d, s);
        const demoDay = dayKey(demoBaseInstant(), s.timezone || undefined);
        process.stdout.write(
          `\n  ${c.green('✓')} loaded ${n} synthetic events → ${res.tasksBuilt} tasks on ${c.bold(demoDay)}\n` +
            `  ${c.yellow('This is clearly-labelled demo data, not your real activity.')}\n` +
            `  View it with ${c.bold(`screentime day ${demoDay}`)} · remove it with ${c.bold('screentime reset --all')}\n\n`,
        );
        return 0;
      }

      case 'reset': {
        const scope = args.flags['all'] ? 'all' : 'derived';
        await handleApi(ctx, 'POST', new URL('http://local/api/privacy/delete'), { scope });
        process.stdout.write(
          `\n  ${c.green('✓')} deleted ${scope === 'all' ? 'all imported and derived' : 'derived'} data\n\n`,
        );
        return 0;
      }

      case 'methodology': {
        const res = await handleApi(ctx, 'GET', new URL('http://local/api/methodology'), undefined);
        const m = res.body as Record<string, unknown>;
        if (args.flags['json']) {
          process.stdout.write(`${JSON.stringify(m, null, 2)}\n`);
          return 0;
        }
        process.stdout.write(`\n  ${c.bold(`Benchmark ${m['benchmarkVersion']}`)}\n\n`);
        process.stdout.write(
          `  ${c.dim('Conventional engineering hours = the time a competent engineer would have')}\n` +
            `  ${c.dim('needed to produce the same accepted outcome using a normal workflow')}\n` +
            `  ${c.dim('without generative-AI assistants or coding agents.')}\n\n`,
        );
        process.stdout.write(`  ${c.bold('Empirical anchors')}\n`);
        for (const s of m['sources'] as Record<string, unknown>[]) {
          process.stdout.write(`\n    ${c.bold(String(s['title']))}\n`);
          process.stdout.write(`    ${c.dim(String(s['citation']))}\n`);
          process.stdout.write(`    ${wrap(String(s['finding']), 74, '    ')}\n`);
          process.stdout.write(
            `    ${c.yellow('Limitations:')} ${wrap(String(s['limitations']), 74, '    ')}\n`,
          );
        }
        process.stdout.write('\n');
        return 0;
      }

      default:
        process.stderr.write(`Unknown command: ${args.command}\n${HELP}`);
        return 1;
    }
  } catch (err) {
    log.error('cli failed', { err: String(err) });
    process.stderr.write(`\n  ${c.red('Error:')} ${String(err)}\n\n`);
    return 1;
  } finally {
    // The long-running commands own the connection for the life of the server.
    if (!['start', 'serve', 'run'].includes(args.command)) ctx.db.close();
  }
}

async function runIngestWithProgress(
  ctx: ReturnType<typeof createContext>,
  args: Args,
): Promise<void> {
  const settings = loadSettings(ctx.db);
  const days = args.flags['days'] !== undefined ? Number(args.flags['days']) : settings.historyDays;
  const isTty = process.stdout.isTTY === true;
  let last = 0;
  const orig = ctx.state;
  const timer = isTty
    ? setInterval(() => {
        const p = orig.progress;
        if (!p || p.filesTotal === 0) return;
        const pct = Math.round((p.filesDone / p.filesTotal) * 100);
        if (pct === last) return;
        last = pct;
        process.stdout.write(
          `\r  ${c.dim(`${pct}%  ${p.filesDone}/${p.filesTotal} files · ${p.eventsIngested.toLocaleString()} events`)}   `,
        );
      }, 120)
    : undefined;
  try {
    await runIngest(ctx, { ...settings, historyDays: days }, true);
  } finally {
    if (timer) clearInterval(timer);
    if (isTty) process.stdout.write('\r[K');
  }
}

function printDay(ctx: ReturnType<typeof createContext>, day: string, asJson: boolean): void {
  const settings = loadSettings(ctx.db);
  const m = computeDayMetrics(ctx.db, day, settings);
  if (asJson) {
    process.stdout.write(`${JSON.stringify(m, null, 2)}\n`);
    return;
  }
  const days = activeDays(ctx.db, 200);
  if (!days.includes(day) && m.taskCount === 0) {
    process.stdout.write(
      `\n  No engineering activity recorded for ${c.bold(day)}.\n` +
        `  ${c.dim(`Days with activity: ${days.slice(0, 8).join(', ') || 'none yet — run `screentime ingest`'}`)}\n\n`,
    );
    return;
  }

  const hours = roundHuman(m.verifiedHours.median);
  const lev = m.outputLeverage;
  process.stdout.write(`\n  ${c.dim(day)}\n`);
  process.stdout.write(`  ${c.bold(`${hours} conventional engineering hours`)}\n`);
  process.stdout.write(`  ${c.dim('produced through agents')}\n\n`);
  process.stdout.write(
    `  ${c.bold(formatDuration(m.steeringMs))} steering  ${c.dim('·')}  ` +
      `${c.green(`${lev.toFixed(lev < 10 ? 1 : 0)}× more work`)}  ${c.dim('·')}  ` +
      `${m.peakConcurrency} peak concurrent agents\n\n`,
  );
  const done =
    (m.statusCounts['completed-validated'] ?? 0) +
    (m.statusCounts['completed-weak-validation'] ?? 0);
  process.stdout.write(
    `  ${m.taskCount} tasks · ${done} completed · ${m.statusCounts['partial'] ?? 0} partial · ` +
      `${(m.statusCounts['failed'] ?? 0) + (m.statusCounts['abandoned'] ?? 0)} failed or abandoned\n`,
  );
  process.stdout.write(
    `  ${m.projectCount} projects · ${m.concurrentAgentHours.toFixed(1)} concurrent agent-hours · ` +
      `${Math.round(m.verificationRate * 100)}% verification strength\n`,
  );
  const cachePct = m.tokensIn > 0 ? Math.round((m.tokensCacheRead / m.tokensIn) * 100) : 0;
  process.stdout.write(
    `  ${fmtCount(m.tokensIn)} tokens in · ${fmtCount(m.tokensOut)} out · ${cachePct}% cached\n`,
  );
  process.stdout.write(
    `  ${c.dim(`range ${roundHuman(m.verifiedHours.p10)}–${roundHuman(m.verifiedHours.p90)}h · confidence ${m.confidence} · steering ${formatDuration(m.steeringLowMs)}–${formatDuration(m.steeringHighMs)}`)}\n`,
  );
  process.stdout.write(`  ${c.dim(`benchmark ${m.benchmarkVersion}`)}\n\n`);
}

function statusMark(status: string): string {
  if (status === 'completed-validated') return c.green('●');
  if (status === 'completed-weak-validation') return c.green('◐');
  if (status === 'partial') return c.yellow('◐');
  if (status === 'exploratory') return c.cyan('○');
  if (status === 'failed' || status === 'reverted' || status === 'abandoned') return c.red('✕');
  return c.dim('·');
}

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + w).length > width) {
      lines.push(line.trimEnd());
      line = '';
    }
    line += `${w} `;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join(`\n${indent}`);
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* opening a browser is a nicety, never a requirement */
  }
}
