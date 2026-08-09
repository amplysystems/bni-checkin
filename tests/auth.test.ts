import { describe, it, expect } from 'vitest';
import { isAllowed } from '@/lib/allowlist';

describe('admin allowlist', () => {
  it('allows listed emails case-insensitively', () => {
    expect(isAllowed('barriosj4@gmail.com', 'barriosj4@gmail.com')).toBe(true);
    expect(isAllowed('BarriosJ4@Gmail.com', 'barriosj4@gmail.com')).toBe(true);
  });
  it('fails closed for unlisted, empty, and undefined emails', () => {
    expect(isAllowed('intruder@evil.com', 'barriosj4@gmail.com')).toBe(false);
    expect(isAllowed('', 'barriosj4@gmail.com')).toBe(false);
    expect(isAllowed(undefined, 'barriosj4@gmail.com')).toBe(false);
    expect(isAllowed('barriosj4@gmail.com', '')).toBe(false);
  });
  it('supports comma-separated lists with spaces', () => {
    expect(isAllowed('carey@example.com', 'barriosj4@gmail.com, carey@example.com')).toBe(true);
  });
});
