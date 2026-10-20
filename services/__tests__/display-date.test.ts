import { describe, expect, test } from 'bun:test';
import { formatShortDate, formatShortTime, timestampToMs } from '../display-date';

// Local-time construction keeps these independent of the runner's timezone.
const oct6 = new Date(2026, 9, 6, 0, 16).getTime();
const now = new Date(2026, 11, 31, 23, 59).getTime();

describe('formatShortDate', () => {
  test('spells the month so the date cannot be read as MM.DD or DD.MM', () => {
    expect(formatShortDate(oct6, now)).toBe('Oct 6');
  });

  test('adds the year only outside the current one', () => {
    expect(formatShortDate(new Date(2025, 9, 6).getTime(), now)).toBe('Oct 6, 2025');
  });

  test('accepts seconds as well as milliseconds', () => {
    expect(formatShortDate(Math.floor(oct6 / 1000), now)).toBe('Oct 6');
  });

  test('marks a missing time instead of printing 1970', () => {
    expect(formatShortDate(0, now)).toBe('—');
    expect(formatShortDate(Number.NaN, now)).toBe('—');
  });

  test('marks a timestamp past the Date range as missing', () => {
    expect(formatShortDate(1e20, now)).toBe('—');
  });
});

describe('formatShortTime', () => {
  test('is 24-hour and zero-padded', () => {
    expect(formatShortTime(oct6)).toBe('00:16');
    expect(formatShortTime(new Date(2026, 9, 6, 14, 5).getTime())).toBe('14:05');
  });

  test('is empty for a missing time', () => {
    expect(formatShortTime(0)).toBe('');
    expect(formatShortTime(-1)).toBe('');
    expect(formatShortTime(1e20)).toBe('');
  });
});

test('timestampToMs leaves milliseconds alone', () => {
  expect(timestampToMs(oct6)).toBe(oct6);
  expect(timestampToMs(1_700_000_000)).toBe(1_700_000_000_000);
});
