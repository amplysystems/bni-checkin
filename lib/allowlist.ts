export function isAllowed(email: string | undefined | null, allowlist: string | undefined): boolean {
  if (!email || !allowlist) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return allowlist.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean).includes(normalized);
}
