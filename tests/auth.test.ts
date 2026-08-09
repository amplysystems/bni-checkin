import { describe, it, expect, vi, afterEach } from 'vitest';
import { isAllowed } from '@/lib/allowlist';
import { authConfig } from '@/lib/auth-config';

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

describe('authConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('signIn callback rejects an un-allowlisted email', async () => {
    vi.stubEnv('ADMIN_ALLOWLIST', 'barriosj4@gmail.com');
    const result = await authConfig.callbacks.signIn({
      user: { email: 'intruder@evil.com' },
    } as Parameters<typeof authConfig.callbacks.signIn>[0]);
    expect(result).toBe(false);
  });

  it('signIn callback allows an allowlisted email', async () => {
    vi.stubEnv('ADMIN_ALLOWLIST', 'barriosj4@gmail.com');
    const result = await authConfig.callbacks.signIn({
      user: { email: 'barriosj4@gmail.com' },
    } as Parameters<typeof authConfig.callbacks.signIn>[0]);
    expect(result).toBe(true);
  });

  it('sets a 7-day session maxAge and no other session overrides', () => {
    expect(authConfig.session).toEqual({ maxAge: 7 * 24 * 60 * 60 });
  });
});
