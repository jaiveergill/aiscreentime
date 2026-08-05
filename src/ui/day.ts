/**
 * Which day the dashboard should be showing.
 *
 * Kept free of DOM references so the rule can be tested directly — the bug
 * this encodes was invisible in review and only showed up after midnight.
 */

/**
 * Pick the day to display when the user has not pinned one.
 *
 * Today wins as soon as it has any activity. Before that we fall back to the
 * most recent day that does, because opening on an empty "today" reads as a
 * broken product rather than as an honest "you have not started yet".
 *
 * The subtlety is that this must be re-evaluated continuously, not just at
 * load. A dashboard opened before the first task of the day would otherwise
 * fall back to yesterday and stay there — yesterday is a day *with* data, so a
 * one-shot "is the current selection valid?" check is satisfied forever and
 * every task ingested during the day is silently ignored.
 *
 * @param days   Days that have activity, most recent first.
 * @param today  Today's key, from the server, so an open tab rolls over.
 * @returns The day to show, or `today` when nothing has any data yet.
 */
export function chooseDay(days: readonly string[], today: string): string {
  if (days.includes(today)) return today;
  return days[0] ?? today;
}
