import { EventEmitter } from "node:events";

/**
 * Per-build event bus. The worker emits events here; WS subscribers tail them.
 * Single in-process emitter is fine for the alpha — when we run multiple API
 * instances we'll switch to NOTIFY/LISTEN or Redis pub-sub.
 */
type Event =
  | { type: "log"; line: string; offset: number }
  | { type: "step"; name: string; status: string; exitCode?: number }
  | { type: "status"; status: string; errorMessage?: string | null }
  | { type: "artifacts"; artifacts: { kind: string; url: string }[] };

class BuildBus {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(0);
  }
  on(buildId: string, fn: (e: Event) => void) {
    this.emitter.on(buildId, fn);
    return () => this.emitter.off(buildId, fn);
  }
  emit(buildId: string, e: Event) {
    this.emitter.emit(buildId, e);
  }
}

export const buildBus = new BuildBus();
export type BuildEvent = Event;
