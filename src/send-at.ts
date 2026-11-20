import { ValidationError } from './errors.ts';
import type { EmailRecord } from './types.ts';

interface Fields {
  y: number;
  m: number;
  d: number;
  h: number;
  i: number;
  s: number;
  ms: number;
  zone?: Zone;
}

type Zone = { offsetSeconds: number } | { timeZone: string };

type Token = 'Y' | 'm' | 'd' | 'H' | 'g' | 'i' | 's' | 'u' | 'A' | 'P' | ' ' | '-' | ':' | '.' | 'T';

// Recognised send_at formats, in this order. The first three need a zone in the value.
const WITH_ZONE: readonly (readonly Token[])[] = [
  ['Y', '-', 'm', '-', 'd', 'T', 'H', ':', 'i', ':', 's', 'P'],
  ['Y', '-', 'm', '-', 'd', ' ', 'H', ':', 'i', ':', 's', 'P'],
  ['Y', '-', 'm', '-', 'd', 'T', 'H', ':', 'i', ':', 's', '.', 'u', 'P'],
];
const WITHOUT_ZONE: readonly (readonly Token[])[] = [
  ['Y', '-', 'm', '-', 'd', ' ', 'g', ':', 'i', ':', 's', ' ', 'A'],
  ['Y', '-', 'm', '-', 'd', ' ', 'H', ':', 'i', ':', 's'],
  ['Y', '-', 'm', '-', 'd', 'T', 'H', ':', 'i', ':', 's'],
];

/**
 * `sendAt` from a fetched record as a `Date`, or `null` when it is missing or in a format the
 * SDK does not recognise.
 *
 * The API returns `send_at` without a UTC offset, for example `2026-11-16 2:36:59 PM`. That clock
 * time is read in UTC unless you pass another `assumedTimeZone`: an IANA name (`Asia/Manila`, any case),
 * an offset (`+08:00`), or an abbreviation (`EST`, a fixed offset). A value with its own zone, or a Unix timestamp,
 * keeps its own instant.
 */
export function sendAtDateTime(record: Pick<EmailRecord, 'sendAt'>, assumedTimeZone?: string): Date | null {
  const assumed = assumedTimeZone === undefined ? undefined : assumedZone(assumedTimeZone);
  const value: unknown = record.sendAt;
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? validDate(value * 1000) : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  if (/^[0-9]{1,12}$/.test(value)) {
    return validDate(Number(value) * 1000);
  }

  const text = value.replace(/^[ \t\n\r\0\v]+|[ \t\n\r\0\v]+$/g, '');
  for (const format of WITH_ZONE) {
    const fields = parse(format, text);
    if (fields?.zone !== undefined) {
      return toDate(fields, fields.zone);
    }
  }
  for (const format of WITHOUT_ZONE) {
    const fields = parse(format, text);
    if (fields !== null) {
      return toDate(fields, assumed ?? { offsetSeconds: 0 });
    }
  }

  return null;
}

function assumedZone(timeZone: string): Zone {
  // The whole string must be one zone, under 100 hours.
  if (typeof timeZone === 'string' && !timeZone.includes('\0')) {
    const parsed = parseZone(timeZone, 0);
    if (
      parsed !== null &&
      parsed.end === timeZone.length &&
      !('offsetSeconds' in parsed.zone && Math.abs(parsed.zone.offsetSeconds) >= 360_000)
    ) {
      return parsed.zone;
    }
  }
  throw new ValidationError('assumedTimeZone is an unknown or bad time zone');
}

/**
 * Time zone abbreviations as fixed UTC offsets in seconds (first match per name).
 * An abbreviation is a fixed offset, so PST is always -08:00.
 */
const ABBREVIATION_TABLE =
  '-43200:y -39600:sst,x -36000:ahst,bdt,hst,w -34200:hdt,hpt,hwt -32400:ahdt,akst,v,yst -28800:akdt,pst,u,ydt,ypt,ywt ' +
  '-26248:emt -25200:mst,pdt,ppt,pwt,t,yddt -21600:cst,mdt,mpt,mwt,pddt,s -20173:sjmt -19776:hmt -18840:qmt ' +
  '-18000:cdt,cpt,cwt,est,mddt,r -17340:ppmt -16800:sdmt -15408:cmt -14660:ffmt -14400:ast,cddt,edt,ept,ewt,q ' +
  '-14309:bmt -13884:smt -13840:amt -13236:pmt -12600:nst -10800:adt,apt,awt,eddt,p -9052:ndt -9000:npt,nwt ' +
  '-7200:addt,o -5400:nddt -4056:fmt -3600:n -1521:dmt 0:gmt,uct,utc,wet,z 3600:a,bst,cet,met,wat,west 5040:wmt ' +
  '5736:kmt 5794:rmt 7200:b,bdst,cat,cest,eet,ist,mest,sast,wast,wemt 8440:jmt 9017:mmt 9394:lst 10751:tbmt ' +
  '10800:c,cemt,eat,eest,idt,msk 12344:tmt 14400:d,iddt,msd 16279:mdst 18000:e,pkt 21600:f,pkst 25025:imt ' +
  '25200:g,wib 25590:plmt 28800:awst,h,hkt,wita 30600:kst 32400:awdt,hkst,i,jst,wit 34200:acst,cast ' +
  '36000:aest,chst,gst,jdt,k,kdt 37800:acdt 39600:aedt,gdt,l 41400:nzmt 43200:m,nzst 46800:nzdt';

const ABBREVIATIONS: ReadonlyMap<string, number> = new Map(
  ABBREVIATION_TABLE.split(' ').flatMap((group) => {
    const [offset = '0', names = ''] = group.split(':');
    return names.split(',').map((name) => [name, Number(offset)] as const);
  }),
);

/** A time zone identifier: UTC/GMT, an abbreviation under 6 letters, or an IANA name. */
function zoneWord(word: string): Zone | undefined {
  if (word === '') {
    return undefined;
  }
  const lower = word.toLowerCase();
  if (lower === 'utc' || lower === 'gmt') {
    return { offsetSeconds: 0 };
  }
  const fixed = word.length < 6 ? ABBREVIATIONS.get(lower) : undefined;
  if (fixed !== undefined) {
    return { offsetSeconds: fixed };
  }
  try {
    return { timeZone: new Intl.DateTimeFormat('en-US', { timeZone: word }).resolvedOptions().timeZone };
  } catch {
    return undefined;
  }
}
/** Parse one date format with no backtracking. */
function parse(format: readonly Token[], text: string): Fields | null {
  const f: Fields = { y: 0, m: 1, d: 1, h: 0, i: 0, s: 0, ms: 0 };
  let pos = 0;
  const digits = (max: number, exact = false): number | null => {
    let end = pos;
    while (end < text.length && end - pos < max && text[end]! >= '0' && text[end]! <= '9') {
      end += 1;
    }
    if (end === pos || (exact && end - pos !== max)) {
      return null;
    }
    const n = Number(text.slice(pos, end));
    pos = end;
    return n;
  };

  for (const token of format) {
    let n: number | null;
    switch (token) {
      case 'Y':
        if ((n = digits(4)) === null) return null;
        f.y = n;
        break;
      case 'm':
        if ((n = digits(2)) === null) return null;
        f.m = n;
        break;
      case 'd':
        if ((n = digits(2)) === null) return null;
        f.d = n;
        break;
      case 'H':
        if ((n = digits(2)) === null) return null;
        f.h = n;
        break;
      case 'g':
        if ((n = digits(2)) === null || n > 12) return null;
        f.h = n;
        break;
      case 'i':
        if ((n = digits(2, true)) === null) return null;
        f.i = n;
        break;
      case 's':
        if ((n = digits(2, true)) === null) return null;
        f.s = n;
        break;
      case 'u': {
        const start = pos;
        if ((n = digits(6)) === null) return null;
        f.ms = Math.floor((n * 10 ** (6 - (pos - start))) / 1000);
        break;
      }
      case 'A': {
        // Skip anything up to the first a or p, then need "m" or ".m.".
        while (pos < text.length && !'AaPp'.includes(text[pos]!)) pos += 1;
        const meridian = /^([AaPp])(?:[Mm]|\.[Mm]\.)/.exec(text.slice(pos));
        if (meridian === null) return null;
        pos += meridian[0].length;
        if (/[Aa]/.test(meridian[1]!)) {
          if (f.h === 12) f.h = 0;
        } else if (f.h !== 12) {
          f.h += 12;
        }
        break;
      }
      case 'P': {
        const zone = parseZone(text, pos);
        if (zone === null) return null;
        f.zone = zone.zone;
        pos = zone.end;
        break;
      }
      case ' ':
        while (pos < text.length && ' \t\u00a0\u202f'.includes(text[pos]!)) pos += 1;
        break;
      default:
        if (text[pos] !== token) return null;
        pos += 1;
    }
  }
  if (pos !== text.length) {
    return null;
  }
  if (f.h > 23 || f.i > 59 || f.s > 59 || f.m < 1 || f.m > 12 || f.d < 1 || f.d > daysInMonth(f.y, f.m)) {
    return null;
  }
  return f;
}

/** Offsets, GMT+offset, abbreviations (fixed offsets), and IANA names. */
function parseZone(text: string, start: number): { zone: Zone; end: number } | null {
  let pos = start;
  let parens = 0;
  while (pos < text.length && ' \t('.includes(text[pos]!)) {
    if (text[pos] === '(') parens += 1;
    pos += 1;
  }
  if (/^GMT[+-]/.test(text.slice(pos))) pos += 3;

  let zone: Zone | undefined;
  const sign = text[pos];
  if (sign === '+' || sign === '-') {
    pos += 1;
    const begin = pos;
    while (pos < text.length && /[0-9:]/.test(text[pos]!)) pos += 1;
    const seconds = offsetSeconds(text.slice(begin, pos));
    if (seconds === null) return null;
    zone = { offsetSeconds: sign === '-' ? -seconds : seconds };
  } else {
    const begin = pos;
    while (pos < text.length && /[A-Za-z0-9/_+-]/.test(text[pos]!)) pos += 1;
    zone = zoneWord(text.slice(begin, pos));
    if (zone === undefined) return null;
  }
  while (parens > 0 && text[pos] === ')') {
    pos += 1;
    parens -= 1;
  }
  return { zone, end: pos };
}

/** Offset forms: H, HH, H:M, H:MM, HH:M, HHMM, HH:MM, HHMMSS, HH:MM:SS. */
function offsetSeconds(raw: string): number | null {
  const num = (s: string): number => {
    const m = /^\d*/.exec(s)![0];
    return m === '' ? 0 : Number(m);
  };
  switch (raw.length) {
    case 1:
    case 2:
      return num(raw) * 3600;
    case 3:
    case 4:
      if (raw[1] === ':') return num(raw) * 3600 + num(raw.slice(2)) * 60;
      if (raw[2] === ':') return num(raw) * 3600 + num(raw.slice(3)) * 60;
      return Math.trunc(num(raw) / 100) * 3600 + (num(raw) % 100) * 60;
    case 5:
      return raw[2] === ':' ? num(raw) * 3600 + num(raw.slice(3)) * 60 : null;
    case 6: {
      const n = num(raw);
      return Math.trunc(n / 10000) * 3600 + (Math.trunc(n / 100) % 100) * 60 + (n % 100);
    }
    case 8:
      return raw[2] === ':' && raw[5] === ':' ? num(raw) * 3600 + num(raw.slice(3)) * 60 + num(raw.slice(6)) : null;
    default:
      return null;
  }
}

function daysInMonth(y: number, m: number): number {
  const wall = new Date(0);
  wall.setUTCFullYear(y, m, 0);
  return wall.getUTCDate();
}

function wallTimeMs(f: Fields): number {
  const wall = new Date(0);
  wall.setUTCFullYear(f.y, f.m - 1, f.d);
  wall.setUTCHours(f.h, f.i, f.s, f.ms);
  return wall.getTime();
}

function toDate(f: Fields, zone: Zone): Date | null {
  const wall = wallTimeMs(f);
  if ('offsetSeconds' in zone) {
    return validDate(wall - zone.offsetSeconds * 1000);
  }
  // For a zone given as an identifier. A gap time moves
  // forward (02:30 becomes 03:30). An overlap time takes the first matching offset, which is
  // the earlier instant in New York but the later one in London.
  const tz = zone.timeZone;
  const current = offsetInfo(wall, tz);
  const actual = offsetInfo(wall - current.offset, tz);
  const inTransition =
    actual.since !== Number.NEGATIVE_INFINITY &&
    wall - actual.offset >= actual.since + (current.offset - actual.offset) &&
    wall - actual.offset < actual.since;
  const offset = current.offset !== actual.offset && !inTransition ? actual.offset : current.offset;
  return validDate(wall - offset);
}

/** The zone's UTC offset at an instant, and when that offset started. */
function offsetInfo(instant: number, timeZone: string): { offset: number; since: number } {
  const offset = zoneOffsetMs(instant, timeZone);
  const week = 7 * 86_400_000;
  let same = instant;
  let other: number | undefined;
  for (let step = 1; step <= 60; step += 1) {
    const probe = instant - step * week;
    if (zoneOffsetMs(probe, timeZone) !== offset) {
      other = probe;
      break;
    }
    same = probe;
  }
  if (other === undefined) {
    return { offset, since: Number.NEGATIVE_INFINITY };
  }
  // Narrow to the first second with the current offset.
  let lo = Math.floor(other / 1000);
  let hi = Math.floor(same / 1000);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (zoneOffsetMs(mid * 1000, timeZone) === offset) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return { offset, since: hi * 1000 };
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function zoneOffsetMs(instant: number, timeZone: string): number {
  let formatter = FORMATTERS.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
    hourCycle: 'h23',
    era: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
      second: 'numeric',
    });
    FORMATTERS.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(instant));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const era = parts.find((p) => p.type === 'era')?.value ?? '';
  const year = /^B/i.test(era) ? 1 - get('year') : get('year');
  const wall = new Date(0);
  wall.setUTCFullYear(year, get('month') - 1, get('day'));
  wall.setUTCHours(get('hour'), get('minute'), get('second'), 0);
  return wall.getTime() - (instant - (((instant % 1000) + 1000) % 1000));
}

function validDate(ms: number): Date | null {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}