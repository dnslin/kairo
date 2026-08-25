import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveDatabaseLocation } from '../src/path-resolver.js';

describe('Database Location Resolver (Path Normalization)', () => {
  it('should normalize different relative path representations to the same absolute path and file URL', () => {
    const cwd = process.cwd();
    const expectedAbs = path.resolve(cwd, 'data', 'kkbot.db');

    const inputs = [
      'data/kkbot.db',
      './data/kkbot.db',
      'data/../data/kkbot.db',
      './data/./kkbot.db',
      'file:data/kkbot.db',
      'file:./data/kkbot.db',
      'file:data/../data/kkbot.db',
      expectedAbs,
      `file:${expectedAbs}`,
    ];

    const results = inputs.map((input) => resolveDatabaseLocation(input, cwd));

    for (const res of results) {
      expect(res.isMemory).toBe(false);
      expect(res.absolutePath).toBe(expectedAbs);
      expect(res.fileUrl).toBe(results[0].fileUrl);
    }
  });

  it('should handle custom baseDir correctly', () => {
    const baseDir = path.resolve(process.cwd(), 'temp-test-dir');
    const expectedAbs = path.resolve(baseDir, 'test.db');

    const res1 = resolveDatabaseLocation('test.db', baseDir);
    const res2 = resolveDatabaseLocation('./test.db', baseDir);
    const res3 = resolveDatabaseLocation('file:./test.db', baseDir);

    expect(res1.absolutePath).toBe(expectedAbs);
    expect(res2.absolutePath).toBe(expectedAbs);
    expect(res3.absolutePath).toBe(expectedAbs);
  });

  it('should recognize in-memory databases', () => {
    const memoryInputs = [
      ':memory:',
      'file::memory:',
      'file::memory:?cache=shared',
      'file:memdb?mode=memory&cache=shared',
    ];

    for (const input of memoryInputs) {
      const res = resolveDatabaseLocation(input);
      expect(res.isMemory).toBe(true);
    }
  });
});
