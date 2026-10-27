import { describe, expect, it } from "vitest";
import { Scheduler } from "../src/scheduler";

function setup(opts: { visible?: boolean; runMs?: number } = {}) {
  let t = 0, nextId = 1, visible = opts.visible ?? true;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const runs: number[] = [];
  let release: (() => void) | null = null;
  let blocking = false;
  const s = new Scheduler({
    now: () => t,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    isVisible: () => visible,
    run: async () => {
      runs.push(t);
      if (blocking) await new Promise<void>((r) => (release = r));
    },
  });
  const advance = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      t = Math.max(t, next[1].at);
      next[1].fn();
      await Promise.resolve();
    }
    t = end;
    await Promise.resolve();
  };
  return {
    s, runs, advance, timers,
    setVisible: (v: boolean) => { visible = v; },
    block: () => { blocking = true; },
    finish: async () => { blocking = false; release?.(); await Promise.resolve(); await Promise.resolve(); },
  };
}

describe("Scheduler", () => {
  it("single edit runs after 2s", async () => {
    const h = setup(); h.s.start(); h.s.onLocalChange();
    await h.advance(1999); expect(h.runs).toEqual([]);
    await h.advance(1); expect(h.runs).toEqual([2000]);
  });

  it("continuous edits every 1s run at 15s, not earlier", async () => {
    const h = setup({ visible: false }); h.s.start();
    for (let i = 0; i < 15; i++) { h.s.onLocalChange(); await h.advance(1000); }
    expect(h.runs).toEqual([15000]);
  });

  it("hidden polls every 60s; showing runs immediately", async () => {
    const h = setup({ visible: false }); h.s.start();
    await h.advance(59_999); expect(h.runs).toEqual([]);
    await h.advance(1); expect(h.runs).toEqual([60_000]);
    h.setVisible(true); h.s.onVisibilityChange(); await h.advance(0);
    expect(h.runs).toEqual([60_000, 60_000]);
    await h.advance(4000); expect(h.runs.length).toBe(3);
  });

  it("never overlaps; edits during a long run cause exactly one rerun", async () => {
    const h = setup({ visible: false }); h.s.start(); h.block();
    h.s.onLocalChange(); await h.advance(2000); expect(h.runs.length).toBe(1);
    h.s.onLocalChange(); await h.advance(2000); h.s.onLocalChange(); await h.advance(2000);
    expect(h.runs.length).toBe(1);
    await h.finish(); // rerun starts, blocks again
    expect(h.runs.length).toBe(2);
    await h.finish();
    expect(h.runs.length).toBe(2);
  });

  it("pauseUntil suppresses runs until the deadline", async () => {
    const h = setup(); h.s.start(); h.s.pauseUntil(10_000);
    h.s.onLocalChange(); await h.advance(9_999);
    expect(h.runs).toEqual([]);
    await h.advance(1); expect(h.runs).toEqual([10_000]);
  });

  it("stop cancels timers and prevents runs", async () => {
    const h = setup(); h.s.start(); h.s.onLocalChange(); h.s.stop();
    expect(h.timers.size).toBe(0);
    h.s.onLocalChange(); await h.advance(100_000); expect(h.runs).toEqual([]);
  });

  it("runNow runs immediately unless stopped or paused", async () => {
    const h = setup(); h.s.runNow(); await h.advance(0); expect(h.runs).toEqual([]);
    h.s.start(); h.s.runNow(); await h.advance(0); expect(h.runs).toEqual([0]);
    h.s.pauseUntil(5_000); h.s.runNow(); await h.advance(4_999); expect(h.runs).toEqual([0]);
    await h.advance(1); expect(h.runs).toEqual([0, 5_000]);
  });

  it("stop resolves only after the in-flight run finishes", async () => {
    const h = setup(); h.block(); h.s.start(); h.s.runNow(); await h.advance(0);
    let stopped = false;
    void h.s.stop().then(() => { stopped = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(stopped).toBe(false);
    await h.finish(); await Promise.resolve(); await Promise.resolve();
    expect(stopped).toBe(true);
    expect(h.runs).toEqual([0]);
  });
});
