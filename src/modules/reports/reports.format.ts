import { createHash } from 'node:crypto';

import { money, toPayable, type Money } from '../../pricing/money';

import type { ReportType } from './reports.model';

export function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [
    headers.map(csvEscape).join(','),
    ...rows.map((row) => row.map(csvEscape).join(',')),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

export function anonymisePlate(registration: string): string {
  const clean = registration.replace(/[\s-]/g, '').toUpperCase();
  if (clean.length <= 4) return '••••';
  return `••••${clean.slice(-4)}`;
}

export function slugOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'campaign';
}

export function fileNameFor(
  type: ReportType,
  campaignName: string,
  from: string,
  to: string,
  ext: 'html' | 'csv',
): string {
  return `MoveAd-${type}-${slugOf(campaignName)}-${from}-to-${to}.${ext}`;
}

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const km1 = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const count = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

const pct = new Intl.NumberFormat('en-IN', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const date = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const dateTime = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

export function formatInr(value: Money | number): string {
  return inr.format(Number(money(value).toFixed(2)));
}

export function formatKm(value: number): string {
  return `${km1.format(value)} km`;
}

export function formatCount(value: number): string {
  return count.format(value);
}

export function formatShare(value: number): string {
  return pct.format(value);
}

export function formatIstDate(value: string | Date): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return date.format(new Date(`${value}T00:00:00+05:30`));
  }
  return date.format(value instanceof Date ? value : new Date(value));
}

export function formatIstDateTime(value: string | Date): string {
  return dateTime.format(value instanceof Date ? value : new Date(value));
}

export function payableOf(value: Money): Money {
  return toPayable(money(value));
}
