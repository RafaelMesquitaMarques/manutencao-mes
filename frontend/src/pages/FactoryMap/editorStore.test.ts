import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from './editorStore';

const tick = () => new Promise((r) => setTimeout(r, 0));
const st = () => useEditorStore.getState();

beforeEach(() => {
  st().reset();
  st().discardFailed();
});

describe('save ledger (runSave)', () => {
  it('tracks pending and lastSavedAt on success', async () => {
    expect(st().pending).toBe(0);
    st().runSave(() => Promise.resolve());
    expect(st().pending).toBe(1);
    await tick();
    expect(st().pending).toBe(0);
    expect(st().lastSavedAt).not.toBeNull();
    expect(st().status()).toBe('saved');
  });

  it('moves a failing op to the failed list and retries it', async () => {
    let attempts = 0;
    const op = () => { attempts += 1; return attempts === 1 ? Promise.reject(new Error('net')) : Promise.resolve(); };
    st().runSave(op);
    await tick();
    expect(st().pending).toBe(0);
    expect(st().failed).toHaveLength(1);
    expect(st().status()).toBe('error');
    st().retryFailed();
    await tick();
    expect(attempts).toBe(2);
    expect(st().failed).toHaveLength(0);
    expect(st().status()).toBe('saved');
  });

  it('discardFailed drops failed ops without retrying', async () => {
    st().runSave(() => Promise.reject(new Error('x')));
    await tick();
    expect(st().failed).toHaveLength(1);
    st().discardFailed();
    expect(st().failed).toHaveLength(0);
  });

  it('status precedence: error > saving > saved > idle', async () => {
    expect(st().status()).toBe('idle');
    let release: () => void = () => {};
    st().runSave(() => new Promise<void>((r) => { release = r; }));
    expect(st().status()).toBe('saving');
    st().runSave(() => Promise.reject(new Error('x')));
    await tick();
    expect(st().status()).toBe('error');   // even with one still pending
    st().discardFailed();
    release();
    await tick();
    expect(st().status()).toBe('saved');
  });
});

describe('undo/redo history', () => {
  const entry = (log: string[], name: string) => ({
    label: name,
    undo: () => log.push(`undo-${name}`),
    redo: () => log.push(`redo-${name}`),
  });

  it('undo pops history into future and runs the entry; redo reverses', () => {
    const log: string[] = [];
    st().pushHistory(entry(log, 'a'));
    st().pushHistory(entry(log, 'b'));
    st().undo();
    expect(log).toEqual(['undo-b']);
    expect(st().history).toHaveLength(1);
    expect(st().future).toHaveLength(1);
    st().undo();
    expect(log).toEqual(['undo-b', 'undo-a']);
    st().redo();
    st().redo();
    expect(log).toEqual(['undo-b', 'undo-a', 'redo-a', 'redo-b']);
    expect(st().future).toHaveLength(0);
  });

  it('a new push clears the redo stack', () => {
    const log: string[] = [];
    st().pushHistory(entry(log, 'a'));
    st().undo();
    expect(st().future).toHaveLength(1);
    st().pushHistory(entry(log, 'b'));
    expect(st().future).toHaveLength(0);
  });

  it('undo/redo on empty stacks are no-ops', () => {
    expect(() => { st().undo(); st().redo(); }).not.toThrow();
  });

  it('caps the history at 100 entries', () => {
    const log: string[] = [];
    for (let i = 0; i < 120; i++) st().pushHistory(entry(log, String(i)));
    expect(st().history).toHaveLength(100);
    expect(st().history[0].label).toBe('20');   // oldest 20 dropped
  });
});

describe('batch', () => {
  const entry = (log: string[], name: string) => ({
    label: name,
    undo: () => log.push(`undo-${name}`),
    redo: () => log.push(`redo-${name}`),
  });

  it('groups several entries into one composite step (undo reversed)', () => {
    const log: string[] = [];
    st().batch('group', () => {
      st().pushHistory(entry(log, 'a'));
      st().pushHistory(entry(log, 'b'));
      st().pushHistory(entry(log, 'c'));
    });
    expect(st().history).toHaveLength(1);
    st().undo();
    expect(log).toEqual(['undo-c', 'undo-b', 'undo-a']);
    st().redo();
    expect(log).toEqual(['undo-c', 'undo-b', 'undo-a', 'redo-a', 'redo-b', 'redo-c']);
  });

  it('a single-entry batch pushes the entry unwrapped', () => {
    const log: string[] = [];
    st().batch('one', () => st().pushHistory(entry(log, 'a')));
    expect(st().history).toHaveLength(1);
    expect(st().history[0].label).toBe('a');
  });

  it('an empty batch pushes nothing', () => {
    st().batch('none', () => {});
    expect(st().history).toHaveLength(0);
  });

  it('nested batches flatten into the outer one', () => {
    const log: string[] = [];
    st().batch('outer', () => {
      st().pushHistory(entry(log, 'a'));
      st().batch('inner', () => st().pushHistory(entry(log, 'b')));
    });
    expect(st().history).toHaveLength(1);
    st().undo();
    expect(log).toEqual(['undo-b', 'undo-a']);
  });

  it('still pushes collected entries when fn throws', () => {
    const log: string[] = [];
    expect(() => st().batch('boom', () => {
      st().pushHistory(entry(log, 'a'));
      throw new Error('boom');
    })).toThrow('boom');
    expect(st().history).toHaveLength(1);
  });
});

describe('prop-id aliasing', () => {
  it('resolves ids through the alias map', () => {
    st().addAlias('old', 'new');
    expect(st().resolveId('old')).toBe('new');
    expect(st().resolveId('other')).toBe('other');
  });

  it('re-points existing aliases when the target is re-created again', () => {
    st().addAlias('v1', 'v2');
    st().addAlias('v2', 'v3');   // v2 deleted+recreated as v3
    expect(st().resolveId('v1')).toBe('v3');
    expect(st().resolveId('v2')).toBe('v3');
  });
});

describe('snap preference', () => {
  it('persists to localStorage', () => {
    st().setSnap(false);
    expect(localStorage.getItem('kaizo-map-snap')).toBe('0');
    expect(st().snap).toBe(false);
    st().setSnap(true);
    expect(localStorage.getItem('kaizo-map-snap')).toBe('1');
    expect(st().snap).toBe(true);
  });
});

describe('reset', () => {
  it('clears stacks, ledger and aliases', async () => {
    st().pushHistory({ label: 'x', undo: () => {}, redo: () => {} });
    st().addAlias('a', 'b');
    st().runSave(() => Promise.reject(new Error('x')));
    await tick();
    st().reset();
    expect(st().history).toHaveLength(0);
    expect(st().future).toHaveLength(0);
    expect(st().failed).toHaveLength(0);
    expect(st().resolveId('a')).toBe('a');
    expect(st().status()).toBe('idle');
  });
});
