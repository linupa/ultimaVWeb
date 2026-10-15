import { describe, expect, it } from 'vitest';
import { DATA_OVL_SIZE, GameFiles } from '../src/gamefiles.js';

describe('GameFiles', () => {
  it('finds files by DOS name in any case, and from a path', () => {
    const files = new GameFiles();
    files.add('ultima5/data.ovl', new Uint8Array(DATA_OVL_SIZE));
    expect(files.has('DATA.OVL')).toBe(true);
    expect(files.get('Data.Ovl').length).toBe(DATA_OVL_SIZE);
  });

  it('says what is missing or wrong', () => {
    const files = new GameFiles();
    files.add('DATA.OVL', new Uint8Array(10));
    const result = files.check();
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('INIT.GAM');
    expect(result.problem).toMatch(/DATA.OVL is 10 bytes/);
  });
});
