// Temporal-expression resolver — heuristically translates natural-language
// time phrases ("yesterday", "last Tuesday", "in March", "two weeks ago",
// "earlier today") into concrete `{ start, end }` ranges relative to a
// reference time.
//
// Stays dependency-free and runtime-agnostic. For phrases the heuristic
// can't handle, the resolver returns `null` and the recall layer falls back
// to a global search.
//
// Tested against the LoCoMo temporal split — explicit ranges close the
// most common 60–70% of "temporal" questions that the naive recency-decay
// strategy used to miss.

export interface ResolvedTimeRange {
  start: number;
  end: number;
  /** A short label describing which pattern matched — useful for logging. */
  label: string;
}

const WEEKDAY_NAMES: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const MONTH_NAMES: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

const UNIT_MS: Record<string, number> = {
  second: 1000,
  seconds: 1000,
  minute: 60 * 1000,
  minutes: 60 * 1000,
  hour: 60 * 60 * 1000,
  hours: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000,
};

const WORD_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/**
 * Translate a natural-language time phrase into a concrete time range.
 *
 * Returns `null` when the phrase isn't recognized — callers should fall
 * back to a non-temporal query in that case rather than guessing.
 *
 * The reference time `now` is the wall-clock anchor against which relative
 * phrases are resolved. Default: `Date.now()`.
 */
export function resolveTimeExpression(
  text: string,
  now: number = Date.now(),
): ResolvedTimeRange | null {
  if (!text) return null;
  const lower = text.toLowerCase();

  // ─── Absolute "today" / "yesterday" / "tomorrow" ───
  if (/\b(today)\b/.test(lower)) return rangeForDay(now, "today");
  if (/\byesterday\b/.test(lower)) return rangeForDay(now - UNIT_MS.day, "yesterday");
  if (/\btomorrow\b/.test(lower)) return rangeForDay(now + UNIT_MS.day, "tomorrow");

  // ─── Day-parts ───
  const dayPartMatch = lower.match(/\b(this|today)\s*(morning|afternoon|evening|night)\b/);
  if (dayPartMatch) return rangeForDayPart(now, dayPartMatch[2]);
  const dayPartYesterday = lower.match(/\byesterday\s+(morning|afternoon|evening|night)\b/);
  if (dayPartYesterday) return rangeForDayPart(now - UNIT_MS.day, dayPartYesterday[1]);

  // ─── "this/last/next [week|month|year]" ───
  const periodMatch = lower.match(/\b(this|last|past|next)\s+(week|month|year)\b/);
  if (periodMatch) return rangeForPeriod(now, periodMatch[1], periodMatch[2]);

  // ─── "N units ago" / "in N units" ───
  const agoMatch = lower.match(
    /\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(second|seconds|minute|minutes|hour|hours|day|days|week|weeks)\s+ago\b/,
  );
  if (agoMatch) {
    const n = parseCount(agoMatch[1]);
    if (n !== null) return rangeForRelativeOffset(now, -n * UNIT_MS[agoMatch[2]], agoMatch[2]);
  }
  const inMatch = lower.match(
    /\bin\s+(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(second|seconds|minute|minutes|hour|hours|day|days|week|weeks)\b/,
  );
  if (inMatch) {
    const n = parseCount(inMatch[1]);
    if (n !== null) return rangeForRelativeOffset(now, n * UNIT_MS[inMatch[2]], inMatch[2]);
  }

  // ─── "last/next <weekday>" ───
  const weekdayMatch = lower.match(
    /\b(last|past|next)\s+(sunday|monday|tuesday|tues|wednesday|thursday|thurs|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/,
  );
  if (weekdayMatch) {
    const dayIdx = WEEKDAY_NAMES[weekdayMatch[2]];
    if (dayIdx !== undefined) {
      return rangeForWeekday(now, weekdayMatch[1] === "next" ? "next" : "last", dayIdx);
    }
  }

  // ─── "in <Month>" / "last <Month>" / "<Month>" alone ───
  for (const [monthName, monthIdx] of Object.entries(MONTH_NAMES)) {
    const pattern = new RegExp(`\\b(in|last|this|next)?\\s*${monthName}\\b`);
    const m = lower.match(pattern);
    if (m) return rangeForMonth(now, m[1] ?? "in", monthIdx);
  }

  return null;
}

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function endOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function rangeForDay(t: number, label: string): ResolvedTimeRange {
  return { start: startOfDay(t), end: endOfDay(t), label };
}

function rangeForDayPart(t: number, part: string): ResolvedTimeRange {
  const d = new Date(t);
  switch (part) {
    case "morning":
      d.setHours(6, 0, 0, 0);
      return {
        start: d.getTime(),
        end: d.getTime() + 6 * UNIT_MS.hour,
        label: `${part}`,
      };
    case "afternoon":
      d.setHours(12, 0, 0, 0);
      return {
        start: d.getTime(),
        end: d.getTime() + 5 * UNIT_MS.hour,
        label: `${part}`,
      };
    case "evening":
      d.setHours(17, 0, 0, 0);
      return {
        start: d.getTime(),
        end: d.getTime() + 5 * UNIT_MS.hour,
        label: `${part}`,
      };
    case "night":
      d.setHours(22, 0, 0, 0);
      return {
        start: d.getTime(),
        end: d.getTime() + 6 * UNIT_MS.hour,
        label: `${part}`,
      };
    default:
      return rangeForDay(t, "today");
  }
}

function rangeForPeriod(now: number, modifier: string, period: string): ResolvedTimeRange {
  const d = new Date(now);
  let offset = 0;
  if (modifier === "last" || modifier === "past") offset = -1;
  else if (modifier === "next") offset = 1;

  if (period === "week") {
    // Week starts Sunday — pragmatic English convention; sufficient for now.
    const dayOfWeek = d.getDay();
    const sunday = new Date(d);
    sunday.setDate(d.getDate() - dayOfWeek + offset * 7);
    sunday.setHours(0, 0, 0, 0);
    const saturday = new Date(sunday);
    saturday.setDate(sunday.getDate() + 6);
    saturday.setHours(23, 59, 59, 999);
    return {
      start: sunday.getTime(),
      end: saturday.getTime(),
      label: `${modifier} week`,
    };
  }

  if (period === "month") {
    const target = new Date(d.getFullYear(), d.getMonth() + offset, 1, 0, 0, 0, 0);
    const next = new Date(d.getFullYear(), d.getMonth() + offset + 1, 1, 0, 0, 0, 0);
    return {
      start: target.getTime(),
      end: next.getTime() - 1,
      label: `${modifier} month`,
    };
  }

  if (period === "year") {
    const target = new Date(d.getFullYear() + offset, 0, 1, 0, 0, 0, 0);
    const next = new Date(d.getFullYear() + offset + 1, 0, 1, 0, 0, 0, 0);
    return {
      start: target.getTime(),
      end: next.getTime() - 1,
      label: `${modifier} year`,
    };
  }

  return { start: now, end: now, label: `${modifier} ${period}` };
}

function rangeForRelativeOffset(now: number, deltaMs: number, unit: string): ResolvedTimeRange {
  const center = now + deltaMs;
  // Tolerance: ½ unit on each side so "two days ago" surfaces the whole day.
  const tolerance = (UNIT_MS[unit] ?? UNIT_MS.day) / 2;
  return {
    start: center - tolerance,
    end: center + tolerance,
    label: `${deltaMs < 0 ? "ago" : "future"} ${unit}`,
  };
}

function rangeForWeekday(
  now: number,
  direction: "last" | "next",
  targetDay: number,
): ResolvedTimeRange {
  const d = new Date(now);
  const cur = d.getDay();
  let delta: number;
  if (direction === "last") {
    delta = (cur - targetDay + 7) % 7 || 7;
    delta = -delta;
  } else {
    delta = (targetDay - cur + 7) % 7 || 7;
  }
  const target = new Date(d);
  target.setDate(d.getDate() + delta);
  return rangeForDay(target.getTime(), `${direction} weekday`);
}

function rangeForMonth(now: number, modifier: string, monthIdx: number): ResolvedTimeRange {
  const d = new Date(now);
  let year = d.getFullYear();
  if (modifier === "last") {
    if (monthIdx >= d.getMonth()) year -= 1;
  } else if (modifier === "next") {
    if (monthIdx <= d.getMonth()) year += 1;
  } else if (modifier === "in" || modifier === "this") {
    // Default: pick the most recent occurrence of that month.
    if (monthIdx > d.getMonth()) year -= 1;
  }
  const start = new Date(year, monthIdx, 1, 0, 0, 0, 0);
  const end = new Date(year, monthIdx + 1, 1, 0, 0, 0, 0);
  return {
    start: start.getTime(),
    end: end.getTime() - 1,
    label: `${modifier} ${monthIdx}`,
  };
}

function parseCount(raw: string): number | null {
  if (WORD_NUMBERS[raw] !== undefined) return WORD_NUMBERS[raw];
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}
