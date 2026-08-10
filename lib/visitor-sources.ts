// Fixed non-member options for the kiosk visitor form's optional "Who
// invited you?" select (Phase 2 Task 6) — deliberately zero dependencies
// (no db/schema, no drizzle) so app/kiosk/kiosk-client.tsx ('use client')
// can import this directly without pulling any server-only code into the
// client bundle. lib/emails/compile.ts imports it too, so the weekly
// report's VISITOR SOURCES grouping and the kiosk form's option list can
// never drift on the literal strings — a visitor who picks one of these
// leaves people.invitedBy set to this exact string, same as picking an
// active member's fullName.
export const INVITED_BY_OTHER_OPTIONS = ['Found us online', 'Referral', 'Other'] as const;
