import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { chooseDay } from '../../src/ui/day.ts';

describe('which day the dashboard lands on', () => {
  test('shows today once today has activity', () => {
    assert.equal(chooseDay(['2026-08-05', '2026-08-04'], '2026-08-05'), '2026-08-05');
  });

  test('falls back to the most recent day with data before the day starts', () => {
    // Opening on an empty today looks like the product is broken.
    assert.equal(chooseDay(['2026-08-04', '2026-08-03'], '2026-08-05'), '2026-08-04');
  });

  test('a new day takes over as soon as its first task lands', () => {
    // The original bug: the fallback ran once, pinned the view to yesterday,
    // and never reconsidered — so a session opened before the first task of
    // the day ignored everything ingested afterwards. Re-running the choice
    // against fresh status has to move the view forward.
    const today = '2026-08-05';
    let days = ['2026-08-04', '2026-08-03'];
    const morning = chooseDay(days, today);
    assert.equal(morning, '2026-08-04', 'starts on yesterday, as intended');

    // Background scan picks up the first task of the new day.
    days = ['2026-08-05', ...days];
    assert.equal(
      chooseDay(days, today),
      today,
      'must move to today rather than staying on a day that merely still has data',
    );
  });

  test('rolls over at midnight for a tab left open', () => {
    // `today` comes from the server on every poll, so the date advancing is
    // enough to move the view without a reload.
    const days = ['2026-08-05', '2026-08-04'];
    assert.equal(chooseDay(days, '2026-08-04'), '2026-08-04');
    assert.equal(chooseDay(days, '2026-08-05'), '2026-08-05');
  });

  test('a first run with no data at all still names today', () => {
    assert.equal(chooseDay([], '2026-08-05'), '2026-08-05');
  });
});
