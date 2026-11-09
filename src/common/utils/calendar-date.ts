const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real `YYYY-MM-DD` calendar day: no time, no offset, no roll-over (2026-02-30). */
export function isCalendarDate(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = ISO_DATE.exec(v);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The UTC day of `now` as `YYYY-MM-DD`. */
export function todayIsoDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The day of `now` in Chisinau as `YYYY-MM-DD`; it may differ from UTC. */
export function chisinauToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Chisinau',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** `day` moved by `n` calendar days (negative goes back). */
export function addCalendarDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
