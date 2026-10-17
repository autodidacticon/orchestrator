import { describe, expect, it } from 'vitest';
import { formatLogLine, logFormatOf, makeStderrLogger } from '../../src/log.js';

const at = new Date('2026-10-17T12:00:00.000Z');

describe('daemon log format', () => {
  it('keeps the text format by default', () => {
    expect(logFormatOf({})).toBe('text');
    expect(logFormatOf({ ORCH_LOG_FORMAT: 'text' })).toBe('text');
    expect(formatLogLine('text', 'info', 'listening', { url: 'http://127.0.0.1:1', pid: 7 }, at)).toBe('2026-10-17T12:00:00.000Z INFO listening {"url":"http://127.0.0.1:1","pid":7}\n');
    expect(formatLogLine('text', 'warn', 'no data', undefined, at)).toBe('2026-10-17T12:00:00.000Z WARN no data\n');
  });

  it('writes one JSON object per line with ts, level, msg, and the data fields under ORCH_LOG_FORMAT=json', () => {
    expect(logFormatOf({ ORCH_LOG_FORMAT: 'json' })).toBe('json');
    const line = formatLogLine('json', 'error', 'tick failed', { err: 'boom\nsecond line', taskId: 'T1' }, at);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({ ts: '2026-10-17T12:00:00.000Z', level: 'error', msg: 'tick failed', err: 'boom\nsecond line', taskId: 'T1' });
    expect(Object.keys(JSON.parse(line) as object).slice(0, 3)).toEqual(['ts', 'level', 'msg']);
    expect(JSON.parse(formatLogLine('json', 'info', 'bare', undefined, at))).toEqual({ ts: '2026-10-17T12:00:00.000Z', level: 'info', msg: 'bare' });
    // A data field cannot overwrite the record's own keys.
    expect(JSON.parse(formatLogLine('json', 'warn', 'real', { msg: 'fake', level: 'x', other: 1 }, at))).toEqual({ ts: '2026-10-17T12:00:00.000Z', level: 'warn', msg: 'real', other: 1 });
  });

  it('routes every level through the chosen format', () => {
    const lines: string[] = [];
    const log = makeStderrLogger('json', (l) => lines.push(l));
    log.info('a', { n: 1 });
    log.warn('b');
    log.error('c', { n: 3 });
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>).map((r) => [r['level'], r['msg']])).toEqual([
      ['info', 'a'],
      ['warn', 'b'],
      ['error', 'c'],
    ]);
  });
});
