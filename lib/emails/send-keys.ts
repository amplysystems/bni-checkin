// Central definition of email_messages.send_key shapes — the uniqueness
// guard the whole engine leans on for "double-send is structurally
// impossible" (spec §6). Both lib/emails/compile.ts (which stamps a
// sendKey onto every draft it produces) and lib/emails/engine.ts (which
// uses it as the createDrafts ON CONFLICT target) import from here so the
// two shapes can never drift apart.
//
// DECISION (documented per the task): visitor_thankyou keys by PERSON, not
// by email address, even though the plan's sketch was
// `{meetingId}:{type}:{email}`. Rationale — spec §11 is explicit that
// "email is a hint, not an identity": shared addresses (spouses,
// info@company.com) are an expected, normal case. Keying by email would
// let two DIFFERENT visitors who happen to share an inbox address collide
// on the same send_key at the same meeting; createDrafts' ON CONFLICT DO
// NOTHING would then silently drop the second person's thank-you as
// "already exists". personId is the identity the rest of the app already
// treats as authoritative (attendance, checkIn, roster) and cannot collide
// that way, so it's the safer and more consistent choice here.
export function leadershipReportSendKey(meetingId: string): string {
  return `${meetingId}:leadership_report`;
}

export function visitorThankyouSendKey(meetingId: string, personId: string): string {
  return `${meetingId}:visitor_thankyou:${personId}`;
}

// One per meeting, matching the plan's literal `{meetingId}:approval_notice`
// — lib/emails/engine.ts's ensureApprovalNotice relies on this being unique
// per meeting for the "second tick can't re-send" idempotency guarantee.
export function approvalNoticeSendKey(meetingId: string): string {
  return `${meetingId}:approval_notice`;
}
