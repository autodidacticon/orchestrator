/**
 * Graph source: where the graph file comes from. Tracker adapters are external
 * exporters that write the file.
 */
import { readFile, stat } from 'node:fs/promises';
import { parseGraph } from './load.js';
import type { Graph } from './model.js';
import type { Store } from '../state/store.js';

export interface GraphSource {
  /**
   * Return the current text if it changed since `knownRev`, else undefined. `stamp` identifies one write of a stored
   * proposal; the reload passes it to `rejected` when it refuses the document.
   */
  poll(knownRev: string | undefined): Promise<{ content: string; graph: Graph; stamp?: number } | undefined>;
  /** Record that the document written at `stamp` was rejected. Only a source that evaluates a write once keeps it. */
  rejected?(stamp: number, reasons: string[]): void;
  /** The recorded rejection of the current document, which is not evaluated again; undefined when there is none. */
  standingRejection?(): { reasons: string[] } | undefined;
}

export class StaticGraphSource implements GraphSource {
  private content: string;
  constructor(content: string) {
    this.content = content;
  }
  /** Test helper: replace the content (simulates editing the file). */
  set(content: string): void {
    this.content = content;
  }
  async poll(knownRev: string | undefined) {
    const graph = parseGraph(this.content);
    if (graph.rev === knownRev) return undefined;
    return { content: this.content, graph };
  }
}

/** The file is evaluated again whenever it differs from the active graph, so a rejected file becomes active once it is compatible. */
export class FileGraphSource implements GraphSource {
  private lastMtime = -1;
  private lastRev: string | undefined;
  constructor(public readonly path: string) {}
  async poll(knownRev: string | undefined) {
    const st = await stat(this.path);
    if (st.mtimeMs === this.lastMtime && this.lastRev === knownRev) return undefined;
    this.lastMtime = st.mtimeMs;
    const content = await readFile(this.path, 'utf8');
    const graph = parseGraph(content);
    this.lastRev = graph.rev;
    if (graph.rev === knownRev) return undefined;
    return { content, graph };
  }
}

/** The kv key holding the last proposed graph the reload rejected: `{ stamp, reasons }` as JSON. */
export const REJECTED_STAMP_KEY = 'graph.rejectedStamp';

function readRejection(raw: string | undefined): { stamp: number; reasons: string[] } | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as { stamp?: unknown; reasons?: unknown };
    return typeof v.stamp === 'number' ? { stamp: v.stamp, reasons: Array.isArray(v.reasons) ? v.reasons.map(String) : [] } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The proposed-graph slot of the store as the graph source, for a run whose state is in Postgres: `PUT /v1/graph`
 * writes the slot and the reload reads it. A document is evaluated once per write (its stamp): a rejected one stays
 * rejected, across restarts too, until it is sent again, and a re-sent one is evaluated. The accepted graph stays in the
 * snapshot. See specs/graph-import "Rejected proposal stays rejected".
 */
export class StoreGraphSource implements GraphSource {
  private lastStamp: number | undefined;
  private lastKnown: string | undefined;
  constructor(private readonly store: Pick<Store, 'getProposedGraph' | 'getKv' | 'setKv'>) {}
  async poll(knownRev: string | undefined) {
    const proposed = this.store.getProposedGraph();
    if (!proposed) return undefined;
    if (proposed.stamp === this.lastStamp && knownRev === this.lastKnown) return undefined;
    this.lastStamp = proposed.stamp;
    this.lastKnown = knownRev;
    // Rejected before, possibly by an earlier daemon: not evaluated again until a new write.
    if (readRejection(this.store.getKv(REJECTED_STAMP_KEY))?.stamp === proposed.stamp) return undefined;
    let graph: Graph;
    try {
      graph = parseGraph(proposed.content);
    } catch (err) {
      this.rejected(proposed.stamp, [err instanceof Error ? err.message : String(err)]);
      throw err;
    }
    if (graph.rev === knownRev) return undefined;
    return { content: proposed.content, graph, stamp: proposed.stamp };
  }
  rejected(stamp: number, reasons: string[]): void {
    this.store.setKv(REJECTED_STAMP_KEY, JSON.stringify({ stamp, reasons }));
  }
  standingRejection(): { reasons: string[] } | undefined {
    const proposed = this.store.getProposedGraph();
    const r = readRejection(this.store.getKv(REJECTED_STAMP_KEY));
    return proposed && r?.stamp === proposed.stamp ? { reasons: r.reasons } : undefined;
  }
}
