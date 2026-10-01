/**
 * When readable driving happened, from the pair's own start in IST.
 *
 * Speed already answers whether someone could physically read the wrap.
 * Clock answers a different question: were people likely around. Night
 * highway at 70 km/h is already "low" on speed and is not counted here.
 * Only high and medium kilometres are banded — a fly-by does not become
 * a daytime audience just because the sun was up.
 *
 * Hours are platform-fixed and versioned the same way as 15 / 35, so a
 * campaign is not re-bucketed silently. Neither layer multiplies a charge.
 */

export type Daypart = 'morning' | 'midday' | 'evening' | 'night';

export interface DaypartWindows {
  morning: string;
  midday: string;
  evening: string;
  night: string;
}

export const CURRENT_DAYPART_VERSION = 'v1.0.0';

const VERSIONS = new Set(['v1.0.0']);

export function daypartCutoffsFor(version: string): void {
  if (!VERSIONS.has(version)) throw new Error(`Unknown daypart version: ${version}`);
}

export function knownDaypartVersions(): string[] {
  return [...VERSIONS];
}

/**
 * Which published window an IST hour of day falls in.
 *
 * `hour` is 0–23 from `EXTRACT(HOUR … AT TIME ZONE 'Asia/Kolkata')`.
 * 07:00 is morning, 11:00 is midday, 21:00 is night, 06:59 is still night.
 */
export function daypartOf(hour: number, version: string = CURRENT_DAYPART_VERSION): Daypart {
  daypartCutoffsFor(version);
  if (!Number.isFinite(hour)) return 'night';
  const clock = ((Math.floor(hour) % 24) + 24) % 24;

  if (clock >= 7 && clock < 11) return 'morning';
  if (clock >= 11 && clock < 17) return 'midday';
  if (clock >= 17 && clock < 21) return 'evening';
  return 'night';
}

export function publishedDayparts(version: string = CURRENT_DAYPART_VERSION): DaypartWindows {
  daypartCutoffsFor(version);
  return {
    morning: '07:00–11:00 IST',
    midday: '11:00–17:00 IST',
    evening: '17:00–21:00 IST',
    night: '21:00–07:00 IST',
  };
}
