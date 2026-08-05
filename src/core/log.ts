import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = (process.env.LEVERAGE_LOG_LEVEL as LogLevel) || 'info';
let logFile: string | undefined;
let stream: fs.WriteStream | undefined;
let quiet = false;

export function configureLogging(opts: { level?: LogLevel; dir?: string; quiet?: boolean }): void {
  if (opts.level) minLevel = opts.level;
  if (opts.quiet !== undefined) quiet = opts.quiet;
  if (opts.dir) {
    // Owner-only: log lines carry file paths and command text.
    fs.mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    logFile = path.join(opts.dir, 'leverage.log');
    stream?.end();
    stream = fs.createWriteStream(logFile, { flags: 'a', mode: 0o600 });
  }
}

/** Structured local logs. Never leaves the machine. */
function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const rec = { t: new Date().toISOString(), level, msg, ...fields };
  const line = JSON.stringify(rec);
  stream?.write(`${line}\n`);
  if (quiet) return;
  if (level === 'error') process.stderr.write(`${line}\n`);
  else if (level === 'warn') process.stderr.write(`${line}\n`);
  else if (process.env.LEVERAGE_LOG_STDOUT === '1') process.stdout.write(`${line}\n`);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
