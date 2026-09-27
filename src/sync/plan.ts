import {addDays, toIsoDate} from "../mcp/periods";

/** Search Console finalizes data with a delay; empty days this recent are retried on the next sync. */
export const FRESH_DAYS = 5;

/**
 * Days to import, newest first — so recent analysis is available within minutes
 * while the rest of the history keeps loading.
 */
export function planDays(options: {today: Date; historyMonths: number; loaded: ReadonlySet<string>}): string[] {
  const end = addDays(toIsoDate(options.today), -1);
  // Search Console keeps 16 months of data, so older days are never requested
  const monthsBack = new Date(`${toIsoDate(options.today)}T00:00:00Z`);
  monthsBack.setUTCMonth(monthsBack.getUTCMonth() - Math.min(options.historyMonths, 16));
  const oldest = addDays(toIsoDate(monthsBack), 1);
  const days: string[] = [];
  for (let day = end; day >= oldest; day = addDays(day, -1)) {
    if (!options.loaded.has(day)) days.push(day);
  }
  return days;
}

/** Whether an empty response for this day is final (old enough) or should be retried later. */
export function isFinalEmptyDay(day: string, today: Date): boolean {
  return day < addDays(toIsoDate(today), -FRESH_DAYS);
}
