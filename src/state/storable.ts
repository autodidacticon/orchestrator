/**
 * Storable values: the one write boundary of the store's rows (ORC-88). Postgres refuses what SQLite
 * accepts: a NUL character in `text` or `jsonb`, a lone UTF-16 surrogate in `jsonb`, and a number that is
 * not an integer in a `bigint` column. A refused batch would stall the journal, so nothing unstorable
 * enters the image: every string bound to a text column, and every string (and object key) inside a
 * value bound to a JSON column, has NUL characters and lone surrogates replaced with U+FFFD; every value
 * bound to an integer column must be a safe integer (or null where the column allows it), or the write
 * throws `UnstorableValueError` before anything is written. `SqliteStore` binds every write through
 * `bindRow`, so the SQLite file, the memory image and the Postgres sink hold the same rows.
 * See specs/state-backend "Storable values".
 */
import type { SQLInputValue } from 'node:sqlite';
import { COLUMNS } from './pg/schema.js';

/** A value the store cannot hold in a column; the write did not happen. The API answers 400 naming `field`. */
export class UnstorableValueError extends Error {
  readonly code = 'unstorable';
  constructor(
    /** The field, as `table.column`, or the API field when a caller validated first. */
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'UnstorableValueError';
  }
}

export function isUnstorable(err: unknown): err is UnstorableValueError {
  return err instanceof UnstorableValueError || (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'unstorable' && typeof (err as { field?: unknown }).field === 'string');
}

// Without the `u` flag a regex works on UTF-16 code units: a high surrogate not followed by a low one, or a low one not preceded by a high one.
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const MAYBE = /[\u0000\uD800-\uDFFF]/;

/** `s` with NUL characters and lone surrogates replaced with U+FFFD; `s` itself when it has none. */
export function storableString(s: string): string {
  return MAYBE.test(s) ? s.replace(UNSTORABLE, '�') : s;
}

function clean(v: unknown): unknown {
  if (typeof v === 'string') return storableString(v);
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') {
    // No prototype: a `__proto__` key stays a key, as it does on the fast path.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, x] of Object.entries(v)) out[storableString(k)] = clean(x);
    return out;
  }
  return v;
}

// JSON.stringify writes NUL and lone surrogates as \u escapes (a pair is written as the characters). A false positive
// (an escaped backslash followed by such text) only takes the slow path, which is still right.
const ESCAPED = /\\u(?:0000|d[89a-f][0-9a-f]{2})/i;

/** The JSON text of `value` as a JSON column stores it: every string and key storable. `undefined` stays `undefined`. */
export function storableJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined || !ESCAPED.test(text)) return text;
  return JSON.stringify(clean(JSON.parse(text)));
}

/** `v` checked for an integer column: a safe integer, or null (and undefined, as null) when `nullable`. */
export function storableInt(field: string, v: unknown, nullable = false): number | null {
  if ((v === null || v === undefined) && nullable) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw new UnstorableValueError(field, `${field} must be a safe integer, got ${typeof v === 'number' ? String(v) : typeof v}`);
  }
  return v;
}

/** The nullable integer and JSON columns per table, for the integer check. Every other column is NOT NULL. */
const NULLABLE: Readonly<Record<string, ReadonlySet<string>>> = {
  events: new Set(['task_id', 'launch_id', 'payload']),
  outbox: new Set(['result', 'error', 'applied_at']),
};

/**
 * The bind values for a write to `table`, in the order of `row`'s keys. `row` maps column names to values: a JSON
 * column takes the document (serialized here: `null` is the JSON text `null`, `undefined` is SQL NULL), a text column
 * a string, an integer column a number.
 */
export function bindRow(table: string, row: Record<string, unknown>): SQLInputValue[] {
  const kinds = COLUMNS[table];
  if (!kinds) throw new Error(`unknown table ${table}`);
  const nullable = NULLABLE[table];
  return Object.entries(row).map(([col, v]) => {
    const kind = kinds[col];
    if (!kind) throw new Error(`unknown column ${table}.${col}`);
    if (kind === 'int') return storableInt(`${table}.${col}`, v, nullable?.has(col) ?? false);
    if (kind === 'json') return v === undefined ? null : (storableJson(v) ?? null);
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') throw new Error(`${table}.${col} must be a string`);
    return storableString(v);
  });
}
