/**
 * The daemon's stderr logger. `ORCH_LOG_FORMAT=json` writes one JSON object
 * per line (`ts`, `level`, `msg`, then the data fields) for container log
 * collectors; anything else keeps the text format. See specs/operator-control
 * "Container mode".
 */
import type { Logger } from './loop/core.js';

export type LogFormat = 'text' | 'json';
export type LogLevel = 'info' | 'warn' | 'error';

export function logFormatOf(env: NodeJS.ProcessEnv = process.env): LogFormat {
  return env['ORCH_LOG_FORMAT'] === 'json' ? 'json' : 'text';
}

/** One log line, newline included. In JSON, `ts`, `level`, and `msg` win over data fields of the same name. */
export function formatLogLine(format: LogFormat, level: LogLevel, msg: string, data?: Record<string, unknown>, now = new Date()): string {
  const ts = now.toISOString();
  if (format === 'json') {
    const fields = Object.fromEntries(Object.entries(data ?? {}).filter(([k]) => k !== 'ts' && k !== 'level' && k !== 'msg'));
    return `${JSON.stringify({ ts, level, msg, ...fields })}\n`;
  }
  return `${ts} ${level.toUpperCase()} ${msg}${data ? ` ${JSON.stringify(data)}` : ''}\n`;
}

export function makeStderrLogger(format: LogFormat = logFormatOf(), write: (line: string) => void = (line) => process.stderr.write(line)): Logger {
  return {
    info: (msg, data) => write(formatLogLine(format, 'info', msg, data)),
    warn: (msg, data) => write(formatLogLine(format, 'warn', msg, data)),
    error: (msg, data) => write(formatLogLine(format, 'error', msg, data)),
  };
}
