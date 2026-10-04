/** UTC timestamp for CreatedOn/UpdatedOn. */
export const nowUtc = () => new Date().toISOString();

/** Local business date as YYYY-MM-DD. */
export function todayLocal(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return todayLocal(new Date(y, m - 1, d + days));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-04-05" -> "05 Apr 2026" */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${formatDate(todayLocal(d))} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function ageFrom(dob: string | null | undefined, today = todayLocal()): number | null {
  if (!dob) return null;
  const [y, m, d] = dob.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  let age = ty - y;
  if (tm < m || (tm === m && td < d)) age--;
  return age;
}

export function daysBetween(fromIso: string, toIso: string): number {
  const utc = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(toIso) - utc(fromIso)) / 86400000);
}

export type DateFormat =
  | 'DD/MM/YYYY'
  | 'DD-MM-YYYY'
  | 'DD-MMM-YYYY'
  | 'DD/MM/YY'
  | 'YYYY-MM-DD'
  | 'MM/DD/YYYY'
  | 'DD MMM YYYY';
export const DATE_FORMATS: DateFormat[] = [
  'DD/MM/YYYY',
  'DD-MM-YYYY',
  'DD/MM/YY',
  'DD-MMM-YYYY',
  'DD MMM YYYY',
  'YYYY-MM-DD',
  'MM/DD/YYYY',
];

function valid(y: number, m: number, d: number): string | null {
  if (!(y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getMonth() !== m - 1) return null;
  return todayLocal(dt);
}

/** Parse a statement date cell into YYYY-MM-DD. Accepts Date objects from XLSX. */
export function parseDate(value: unknown, fmt: DateFormat): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return todayLocal(value);
  }
  const s = String(value)
    .trim()
    .split(/[ T]\d{1,2}:\d{2}/)[0]
    .trim();
  const parts = s.split(/[/\-. ]+/);
  if (parts.length < 3) return null;
  let y: number, m: number, d: number;
  switch (fmt) {
    case 'YYYY-MM-DD':
      [y, m, d] = parts.map(Number);
      break;
    case 'MM/DD/YYYY':
      [m, d, y] = parts.map(Number);
      break;
    case 'DD-MMM-YYYY':
    case 'DD MMM YYYY': {
      d = Number(parts[0]);
      m = MONTHS.findIndex((x) => x.toLowerCase() === parts[1].slice(0, 3).toLowerCase()) + 1;
      y = Number(parts[2]);
      if (y < 100) y += 2000;
      break;
    }
    default:
      [d, m, y] = parts.map(Number);
      if (y < 100) y += 2000;
  }
  return valid(y, m, d);
}

/** Indian financial year label for a date, e.g. "2026-27". */
export function financialYear(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
