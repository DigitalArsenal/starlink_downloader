/** Minimal typed event emitter used to decouple the engine from the UI. */
import type { SourceRefreshResult } from './types.js';

export interface ProgressEventMap {
  'source:start': { source: string; total: number };
  'source:progress': {
    source: string;
    done: number;
    total: number;
    stored: number;
    skipped: number;
    failed: number;
    bytes: number;
  };
  'resource:done': {
    source: string;
    id: string;
    status: 'stored' | 'skipped' | 'failed';
    error?: string;
  };
  'source:finish': { result: SourceRefreshResult };
}

type Handler<K extends keyof ProgressEventMap> = (payload: ProgressEventMap[K]) => void;

export class ProgressEmitter {
  private readonly handlers = new Map<keyof ProgressEventMap, Set<Handler<never>>>();

  on<K extends keyof ProgressEventMap>(event: K, handler: Handler<K>): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as Handler<never>);
    this.handlers.set(event, set);
    return () => set.delete(handler as Handler<never>);
  }

  emit<K extends keyof ProgressEventMap>(event: K, payload: ProgressEventMap[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of set) (h as Handler<K>)(payload);
  }
}
