import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Db } from '../../src/store/db.ts';
import { cleanup, tmpDir } from '../helpers.ts';

/**
 * The tool was called `leverage` before it was called `screentime`. Opening a
 * fresh empty database beside a populated old one is indistinguishable from
 * data loss to the person looking at the screen, so the old file is adopted.
 */
describe('adopting a database from the previous name', () => {
  test('a leverage.db is picked up and keeps its contents', () => {
    const dir = tmpDir('screentime-migrate-');
    try {
      // Write a real database under the old name, then close it.
      const seeded = new Db({ dir, filename: 'leverage.db' });
      seeded.setConfig('marker', { kept: true });
      seeded.close();

      assert.ok(fs.existsSync(path.join(dir, 'leverage.db')), 'the old file exists');
      assert.ok(!fs.existsSync(path.join(dir, 'screentime.db')), 'the new one does not yet');

      const db = new Db({ dir });
      try {
        assert.deepEqual(
          db.getConfig('marker', null),
          { kept: true },
          'the adopted database still has its rows',
        );
        assert.ok(fs.existsSync(path.join(dir, 'screentime.db')), 'renamed to the new name');
        assert.ok(!fs.existsSync(path.join(dir, 'leverage.db')), 'and the old name is gone');
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('an existing screentime.db is never overwritten by an old one', () => {
    const dir = tmpDir('screentime-migrate-');
    try {
      const current = new Db({ dir });
      current.setConfig('marker', { current: true });
      current.close();

      const legacy = new Db({ dir, filename: 'leverage.db' });
      legacy.setConfig('marker', { stale: true });
      legacy.close();

      const db = new Db({ dir });
      try {
        assert.deepEqual(
          db.getConfig('marker', null),
          { current: true },
          'the live database wins; adoption only fills a gap',
        );
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('a clean install is unaffected', () => {
    const dir = tmpDir('screentime-migrate-');
    try {
      const db = new Db({ dir });
      try {
        assert.equal(db.getConfig('marker', null), null);
        assert.ok(fs.existsSync(path.join(dir, 'screentime.db')));
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });
});
