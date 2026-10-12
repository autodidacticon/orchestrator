/**
 * Graph source: where the graph file comes from. Tracker adapters are external
 * exporters that write the file.
 */
import { readFile, stat } from 'node:fs/promises';
import { parseGraph } from './load.js';
import type { Graph } from './model.js';

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
