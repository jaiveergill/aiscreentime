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

/**
 * `mkdirSync`'s `mode` applies only at creation, and `createWriteStream`'s is
 * ignored when appending to an existing file. A directory left behind by an
 * earlier version therefore keeps its original permissions forever unless they
 * are reasserted — which is how 40MB of transcript data ended up
 * world-readable on a real machine.
 */
describe('permissions are reasserted, not assumed', () => {
  test('an already world-readable directory is locked down on open', () => {
    const dir = tmpDir('screentime-perm-');
    try {
      fs.chmodSync(dir, 0o755);
      assert.equal(fs.statSync(dir).mode & 0o777, 0o755, 'starts world-readable');

      const db = new Db({ dir });
      try {
        assert.equal(
          fs.statSync(dir).mode & 0o777,
          0o700,
          'opening the database must restrict a pre-existing directory',
        );
        assert.equal(
          fs.statSync(path.join(dir, 'screentime.db')).mode & 0o777,
          0o600,
          'and the database file itself',
        );
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('WAL sidecars are restricted too, not just the database', () => {
    const dir = tmpDir('screentime-perm-');
    try {
      const db = new Db({ dir });
      try {
        // Force a WAL to exist by writing something.
        db.setConfig('marker', { a: 1 });
        for (const suffix of ['-wal', '-shm']) {
          const f = path.join(dir, `screentime.db${suffix}`);
          if (!fs.existsSync(f)) continue;
          assert.equal(
            fs.statSync(f).mode & 0o777,
            0o600,
            `${suffix} holds the same pages as the database and must match its permissions`,
          );
        }
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('a legacy database brings its sidecars across', () => {
    const dir = tmpDir('screentime-perm-');
    try {
      const seeded = new Db({ dir, filename: 'leverage.db' });
      seeded.setConfig('marker', { kept: true });
      seeded.close();
      // Simulate the sidecars an unclean shutdown leaves behind.
      fs.writeFileSync(path.join(dir, 'leverage.db-wal'), 'stale pages');
      fs.writeFileSync(path.join(dir, 'leverage.db-shm'), 'stale index');

      const db = new Db({ dir });
      try {
        assert.ok(!fs.existsSync(path.join(dir, 'leverage.db-wal')), 'no orphaned -wal is left');
        assert.ok(!fs.existsSync(path.join(dir, 'leverage.db-shm')), 'no orphaned -shm is left');
      } finally {
        db.close();
      }
    } finally {
      cleanup(dir);
    }
  });
});
