/**
 * Graph source: where the graph file comes from. Tracker adapters are external
 * exporters that write the file.
 */
import { readFile, stat } from 'node:fs/promises';
import { parseGraph } from './load.js';
import type { Graph } from './model.js';
import type { Store } from '../state/store.js';

export interface GraphSource {
  /** Return the current text if it changed since `knownRev`, else undefined. */
  poll(knownRev: string | undefined): Promise<{ content: string; graph: Graph } | undefined>;
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

/**
 * The proposed-graph slot of the store as the graph source, for a run whose state is in Postgres: `PUT /v1/graph`
 * writes the slot and the reload reads it. A document is evaluated once per write (its stamp), so a rejected one is not
 * classified again every tick, and a re-sent one is. The accepted graph stays in the snapshot. See specs/graph-import.
 */
export class StoreGraphSource implements GraphSource {
  private lastStamp: number | undefined;
  private lastKnown: string | undefined;
  constructor(private readonly store: Pick<Store, 'getProposedGraph'>) {}
  async poll(knownRev: string | undefined) {
    const proposed = this.store.getProposedGraph();
    if (!proposed) return undefined;
    if (proposed.stamp === this.lastStamp && knownRev === this.lastKnown) return undefined;
    this.lastStamp = proposed.stamp;
    this.lastKnown = knownRev;
    const graph = parseGraph(proposed.content);
    if (graph.rev === knownRev) return undefined;
    return { content: proposed.content, graph };
  }
}
