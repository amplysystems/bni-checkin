import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from './helpers/db';
import { seed } from '../scripts/seed';
import { people, memberships, meetings, attendance, settings, rsvpTokens } from '@/db/schema';
import { checkIn, voidCheckIn } from '@/lib/checkins';
import { getOrCreateMeetingFor } from '@/lib/meetings';
import { registerVisitor } from '@/lib/visitors';
import { compileForMeeting, CompileError, type VisitorThankyouDraft } from '@/lib/emails/compile';
import { visitorThankyouSendKey, leadershipReportSendKey } from '@/lib/emails/send-keys';

const TARGET_NOW = new Date('2026-08-12T19:00:00Z'); // Wednesday, 14:00 CT

describe('compileForMeeting', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
  });

  async function personByName(name: string) {
    const [p] = await db.select().from(people).where(eq(people.fullName, name));
    return p;
  }

  it('throws CompileError(meeting_not_found) for an unknown meeting id', async () => {
    const err = await compileForMeeting(db, '00000000-0000-0000-0000-000000000000').catch((e) => e);
    expect(err).toBeInstanceOf(CompileError);
    expect((err as CompileError).code).toBe('meeting_not_found');
  });

  it('produces exactly one leadership_report draft with the meeting-scoped send key', async () => {
    const meeting = await getOrCreateMeetingFor(db, TARGET_NOW);
    const { drafts } = await compileForMeeting(db, meeting.id);
    const reports = drafts.filter((d) => d.type === 'leadership_report');
    expect(reports).toHaveLength(1);
    expect(reports[0].sendKey).toBe(leadershipReportSendKey(meeting.id));
  });

  it('report recipients = settings.reportRecipients ∪ owner, deduped', async () => {
    await db.insert(settings).values({ id: 1, reportRecipients: ['carey@example.com', 'marisa@example.com'] })
      .onConflictDoUpdate({ target: settings.id, set: { reportRecipients: ['carey@example.com', 'marisa@example.com'] } });
    const meeting = await getOrCreateMeetingFor(db, TARGET_NOW);
    const { drafts } = await compileForMeeting(db, meeting.id);
    const report = drafts.find((d) => d.type === 'leadership_report')!;
    expect(report.recipients).toEqual(expect.arrayContaining(['carey@example.com', 'marisa@example.com', 'barriosj4@gmail.com']));
    expect(report.recipients).toHaveLength(3);
  });

  it('owner is included exactly once even if already present in settings.reportRecipients', async () => {
    await db.update(settings).set({ reportRecipients: ['barriosj4@gmail.com'] }).where(eq(settings.id, 1));
    const meeting = await getOrCreateMeetingFor(db, TARGET_NOW);
    const { drafts } = await compileForMeeting(db, meeting.id);
    const report = drafts.find((d) => d.type === 'leadership_report')!;
    expect(report.recipients).toEqual(['barriosj4@gmail.com']);
  });

  it('present members/leadership and voided/absent members are correctly separated', async () => {
    const meeting = await getOrCreateMeetingFor(db, TARGET_NOW);
    const jason = await personByName('Jason Barrios');
    const mike = await personByName('Mike Anderson');
    const carey = await personByName('Carey Rothbardt');

    await checkIn(db, { personId: jason.id, clientOpId: 'j-1', source: 'kiosk', now: TARGET_NOW });
    // Mike checks in then voids — should land in absentMembers, not presentMembers.
    const mikeIn = await checkIn(db, { personId: mike.id, clientOpId: 'm-1', source: 'kiosk', now: TARGET_NOW });
    await voidCheckIn(db, { attendanceId: mikeIn.attendance.id, by: 'kiosk' });
    await checkIn(db, { personId: carey.id, clientOpId: 'c-1', source: 'kiosk', now: TARGET_NOW });

    const { drafts } = await compileForMeeting(db, meeting.id);
    const report = drafts.find((d) => d.type === 'leadership_report')!;
    expect(report.html).toContain('Jason Barrios');
    expect(report.html).toContain('Carey Rothbardt');
    // Mike voided -> absent, not present.
    expect(report.text).toContain('Absent members: ');
    const absentLine = report.text.split('\n').find((l) => l.startsWith('Absent members:'))!;
    expect(absentLine).toContain('Mike Anderson');
    const presentLine = report.text.split('\n').find((l) => l.startsWith('Members present:'))!;
    expect(presentLine).not.toContain('Mike Anderson');
  });

  it('visit-1 visitor gets a v1 (non-conversion) thank-you draft', async () => {
    const meeting = await getOrCreateMeetingFor(db, TARGET_NOW);
    await registerVisitor(db, {
      fullName: 'First Timer', industry: 'Roofing', company: null,
      email: 'first@example.com', phone: null, clientOpId: 'v-first', now: TARGET_NOW,
    });

    const { drafts } = await compileForMeeting(db, meeting.id);
    const visitorDrafts = drafts.filter((d): d is VisitorThankyouDraft => d.type === 'visitor_thankyou');
    expect(visitorDrafts).toHaveLength(1);
    expect(visitorDrafts[0].isConversion).toBe(false);
    expect(visitorDrafts[0].recipients).toEqual(['first@example.com']);
    expect(visitorDrafts[0].subject).toContain('First');
  });

  it('visit-2+ visitor gets a v2 conversion draft (approved copy), keyed by personId not email', async () => {
    const priorWeek = new Date('2026-08-05T19:00:00Z'); // the Wednesday before
    const { person } = await registerVisitor(db, {
      fullName: 'Repeat Visitor', industry: 'HVAC', company: null,
      email: 'repeat@example.com', phone: null, clientOpId: 'v-repeat-1', now: priorWeek,
    });

    const meeting = await getOrCreateMeetingFor(db, TARGET_NOW);
    const second = await checkIn(db, { personId: person!.id, clientOpId: 'v-repeat-2', source: 'kiosk', now: TARGET_NOW });
    expect(second.attendance.visitNumber).toBe(2);

    const { drafts } = await compileForMeeting(db, meeting.id);
    const visitorDrafts = drafts.filter((d): d is VisitorThankyouDraft => d.type === 'visitor_thankyou');
    expect(visitorDrafts).toHaveLength(1);
    const draft = visitorDrafts[0];
    expect(draft.isConversion).toBe(true);
    expect(draft.sendKey).toBe(visitorThankyouSendKey(meeting.id, person!.id));
    expect(draft.sendKey).not.toContain('repeat@example.com');

    // Approved copy (Jason, 2026-08-10) — industry substitution and the
    // road-to-25 activeMemberCount (10 seeded members) both threaded through.
    expect(draft.subject).toBe('The HVAC seat is still open, Repeat');
    expect(draft.html).not.toContain('COPY PENDING');
    expect(draft.html).toContain('The HVAC seat at Wheeling is still open');
    expect(draft.html).toContain('10 founding members have already claimed theirs');
    expect(draft.html).toContain('I&rsquo;m coming Wednesday &mdash; hold the seat');
    expect(draft.text).toContain('The HVAC seat at Wheeling is still open');
    expect(draft.text).toContain('10 founding members have already claimed theirs');
  });

  it('v2 conversion draft falls back to generic wording when the visitor has no industry on file', async () => {
    const priorWeek = new Date('2026-08-05T19:00:00Z');
    const [noIndustryPerson] = await db.insert(people).values({
      fullName: 'No Industry Visitor', email: 'noindustry@example.com',
    }).returning();
    await db.insert(memberships).values({ personId: noIndustryPerson.id, status: 'visitor' });
    await checkIn(db, { personId: noIndustryPerson.id, clientOpId: 'ni-1', source: 'kiosk', now: priorWeek });

    const meeting = await getOrCreateMeetingFor(db, TARGET_NOW);
    await checkIn(db, { personId: noIndustryPerson.id, clientOpId: 'ni-2', source: 'kiosk', now: TARGET_NOW });

    const { drafts } = await compileForMeeting(db, meeting.id);
    const draft = drafts.find((d): d is VisitorThankyouDraft => d.type === 'visitor_thankyou')!;
    expect(draft.subject).toBe('A seat is still open for you, No');
    expect(draft.html).toContain('Your seat at Wheeling is still open');
  });

  it('HTML-escapes a maliciously-named visitor in both the report and the conversion email', async () => {
    const priorWeek = new Date('2026-08-05T19:00:00Z');
    const maliciousName = '<img src=x onerror=1>';
    const { person } = await registerVisitor(db, {
      fullName: maliciousName, industry: 'Plumbing', company: null,
      email: 'xss@example.com', phone: null, clientOpId: 'xss-1', now: priorWeek,
    });
    const meeting = await getOrCreateMeetingFor(db, TARGET_NOW);
    const second = await checkIn(db, { personId: person!.id, clientOpId: 'xss-2', source: 'kiosk', now: TARGET_NOW });
    expect(second.attendance.visitNumber).toBe(2); // -> v2 conversion template

    const { drafts } = await compileForMeeting(db, meeting.id);
    const report = drafts.find((d) => d.type === 'leadership_report')!;
    const conversion = drafts.find((d): d is VisitorThankyouDraft => d.type === 'visitor_thankyou')!;
    expect(conversion.isConversion).toBe(true);

    for (const html of [report.html, conversion.html]) {
      expect(html).not.toContain('<img src=x onerror=1>');
      // Each template has exactly one legitimate <img> (the BNI logo) —
      // confirm no ADDITIONAL <img appears from the unescaped visitor name.
      expect((html.match(/<img /g) ?? []).length).toBe(1);
    }
    expect(report.html).toContain('&lt;img src=x onerror=1&gt;');
    // firstNameOf() truncates to the first whitespace-delimited token
    // ("<img"), which is exactly why escaping the truncated value still
    // matters — it's still an open angle bracket.
    expect(conversion.html).toContain('&lt;img');
  });

  it('a present visitor with no email is skipped from thank-you drafts but listed in the report', async () => {
    const meeting = await getOrCreateMeetingFor(db, TARGET_NOW);
    const [noEmailPerson] = await db.insert(people).values({ fullName: 'No Email Visitor', industry: 'Dentist' }).returning();
    await db.insert(memberships).values({ personId: noEmailPerson.id, status: 'visitor' });
    await checkIn(db, { personId: noEmailPerson.id, clientOpId: 'no-email-1', source: 'kiosk', now: TARGET_NOW });

    const { drafts } = await compileForMeeting(db, meeting.id);
    const visitorDrafts = drafts.filter((d) => d.type === 'visitor_thankyou');
    expect(visitorDrafts).toHaveLength(0);

    const report = drafts.find((d) => d.type === 'leadership_report')!;
    expect(report.text).toContain('No email on file (not sent a thank-you): No Email Visitor');
  });

  it('two visitors sharing the same email each get their own draft (personId-keyed, not email-keyed)', async () => {
    const meeting = await getOrCreateMeetingFor(db, TARGET_NOW);
    await registerVisitor(db, {
      fullName: 'Spouse One', industry: 'Retail', company: null,
      email: 'shared@example.com', phone: null, clientOpId: 'spouse-1', now: TARGET_NOW,
    });
    await registerVisitor(db, {
      fullName: 'Spouse Two', industry: 'Retail', company: null,
      email: 'shared@example.com', phone: null, clientOpId: 'spouse-2', now: TARGET_NOW,
    });

    const { drafts } = await compileForMeeting(db, meeting.id);
    const visitorDrafts = drafts.filter((d): d is VisitorThankyouDraft => d.type === 'visitor_thankyou');
    expect(visitorDrafts).toHaveLength(2);
    expect(new Set(visitorDrafts.map((d) => d.sendKey)).size).toBe(2);
  });

  it('road-to-25 reflects the active member count from seed data', async () => {
    const meeting = await getOrCreateMeetingFor(db, TARGET_NOW);
    const { drafts } = await compileForMeeting(db, meeting.id);
    const report = drafts.find((d) => d.type === 'leadership_report')!;
    expect(report.text).toContain('Road to 25: 10 / 25 active members');
  });

  it('last-6-weeks counts are chronological, capped at 6, and exclude future meetings and voids', async () => {
    // Seed prior weeks directly with known attendance counts.
    const jason = await personByName('Jason Barrios');
    const mike = await personByName('Mike Anderson');

    const [wk1] = await db.insert(meetings).values({
      meetingDate: '2026-07-22', startsAt: new Date('2026-07-22T20:30:00Z'),
    }).returning();
    await db.insert(attendance).values({ personId: jason.id, meetingId: wk1.id, kind: 'member', checkedInBy: 'kiosk' });

    const [wk2] = await db.insert(meetings).values({
      meetingDate: '2026-07-29', startsAt: new Date('2026-07-29T20:30:00Z'),
    }).returning();
    await db.insert(attendance).values({ personId: jason.id, meetingId: wk2.id, kind: 'member', checkedInBy: 'kiosk' });
    await db.insert(attendance).values({ personId: mike.id, meetingId: wk2.id, kind: 'member', checkedInBy: 'kiosk' });

    const [wk3] = await db.insert(meetings).values({
      meetingDate: '2026-08-05', startsAt: new Date('2026-08-05T20:30:00Z'),
    }).returning();
    // 2 real check-ins, one voided -> should count as 1, not 2.
    await db.insert(attendance).values({ personId: jason.id, meetingId: wk3.id, kind: 'member', checkedInBy: 'kiosk' });
    const [voided] = await db.insert(attendance).values({
      personId: mike.id, meetingId: wk3.id, kind: 'member', checkedInBy: 'kiosk',
    }).returning();
    await db.update(attendance).set({ voidedAt: new Date(), voidedBy: 'kiosk' }).where(eq(attendance.id, voided.id));

    const meeting = await getOrCreateMeetingFor(db, TARGET_NOW); // 2026-08-12, target
    await checkIn(db, { personId: jason.id, clientOpId: 'target-1', source: 'kiosk', now: TARGET_NOW });

    // A FUTURE meeting that must not leak into "last 6 weeks".
    const [future] = await db.insert(meetings).values({
      meetingDate: '2026-08-19', startsAt: new Date('2026-08-19T20:30:00Z'),
    }).returning();
    await db.insert(attendance).values({ personId: jason.id, meetingId: future.id, kind: 'member', checkedInBy: 'kiosk' });

    const { drafts } = await compileForMeeting(db, meeting.id);
    const report = drafts.find((d) => d.type === 'leadership_report')!;
    const line = report.text.split('\n').find((l) => l.startsWith('Last 6 weeks:'))!;
    // Oldest -> newest: wk1=1, wk2=2, wk3=1 (voided excluded), target=1.
    expect(line).toBe('Last 6 weeks: 1 · 2 · 1 · 1');
  });

  it('a canceled meeting in the window is excluded from last-6-weeks entirely, not shown as a 0 (P2-3 minor #5)', async () => {
    const jason = await personByName('Jason Barrios');

    const [wk1] = await db.insert(meetings).values({
      meetingDate: '2026-07-29', startsAt: new Date('2026-07-29T20:30:00Z'),
    }).returning();
    await db.insert(attendance).values({ personId: jason.id, meetingId: wk1.id, kind: 'member', checkedInBy: 'kiosk' });

    // A canceled meeting the following week — never actually happened, so
    // it must not appear at all (neither as a real count nor as a 0).
    await db.insert(meetings).values({
      meetingDate: '2026-08-05', startsAt: new Date('2026-08-05T20:30:00Z'), status: 'canceled',
    });

    const meeting = await getOrCreateMeetingFor(db, TARGET_NOW); // 2026-08-12
    await checkIn(db, { personId: jason.id, clientOpId: 'cancel-target-1', source: 'kiosk', now: TARGET_NOW });

    const { drafts } = await compileForMeeting(db, meeting.id);
    const report = drafts.find((d) => d.type === 'leadership_report')!;
    const line = report.text.split('\n').find((l) => l.startsWith('Last 6 weeks:'))!;
    // wk1=1, canceled week skipped entirely, target=1 — only two entries.
    expect(line).toBe('Last 6 weeks: 1 · 1');
  });

  describe('possible-repeat-visitor note (P2-6 carry-in)', () => {
    it('flags a present visitor whose email matches a DIFFERENT person with 2+ prior visits', async () => {
      // "Original" — a different person row, already at 2 prior visits.
      const priorWeek1 = new Date('2026-07-29T19:00:00Z');
      const priorWeek2 = new Date('2026-08-05T19:00:00Z');
      const { person: original } = await registerVisitor(db, {
        fullName: 'Original Person', industry: 'Roofing', company: null,
        email: 'shared-repeat@example.com', phone: null, clientOpId: 'orig-1', now: priorWeek1,
      });
      await checkIn(db, { personId: original!.id, clientOpId: 'orig-2', source: 'kiosk', now: priorWeek2 });

      // "New" registration, same email, present at TODAY's meeting — a
      // fresh person row (e.g. the kiosk form filled out again).
      const meeting = await getOrCreateMeetingFor(db, TARGET_NOW);
      await registerVisitor(db, {
        fullName: 'Newly Registered', industry: 'Roofing', company: null,
        email: 'shared-repeat@example.com', phone: null, clientOpId: 'newreg-1', now: TARGET_NOW,
      });

      const { drafts } = await compileForMeeting(db, meeting.id);
      const report = drafts.find((d) => d.type === 'leadership_report')!;
      expect(report.text).toContain('Possible repeat visitor');
      expect(report.text).toContain('Newly Registered (shared-repeat@example.com) may be the same person as Original Person, who has 2 prior visits.');
      expect(report.html).toContain('Possible repeat visitor');
    });

    it('does not flag a visitor on their own genuine 2nd visit (same person id, not a different record)', async () => {
      const priorWeek = new Date('2026-08-05T19:00:00Z');
      const { person } = await registerVisitor(db, {
        fullName: 'Genuine Repeat', industry: 'HVAC', company: null,
        email: 'genuine-repeat@example.com', phone: null, clientOpId: 'genuine-1', now: priorWeek,
      });
      const meeting = await getOrCreateMeetingFor(db, TARGET_NOW);
      await checkIn(db, { personId: person!.id, clientOpId: 'genuine-2', source: 'kiosk', now: TARGET_NOW });

      const { drafts } = await compileForMeeting(db, meeting.id);
      const report = drafts.find((d) => d.type === 'leadership_report')!;
      expect(report.text).not.toContain('Possible repeat visitor');
    });

    it('does not flag two unrelated visitors sharing an email who each only have 1 visit', async () => {
      const meeting = await getOrCreateMeetingFor(db, TARGET_NOW);
      await registerVisitor(db, {
        fullName: 'Household One', industry: 'Retail', company: null,
        email: 'household@example.com', phone: null, clientOpId: 'hh-1', now: TARGET_NOW,
      });
      await registerVisitor(db, {
        fullName: 'Household Two', industry: 'Retail', company: null,
        email: 'household@example.com', phone: null, clientOpId: 'hh-2', now: TARGET_NOW,
      });

      const { drafts } = await compileForMeeting(db, meeting.id);
      const report = drafts.find((d) => d.type === 'leadership_report')!;
      expect(report.text).not.toContain('Possible repeat visitor');
    });
  });

  // Phase 2 Task 6: RSVP/interest token wiring.
  describe('RSVP token wiring', () => {
    it('v1 thank-you CTA links to a real /rsvp/{token} page for the NEXT meeting — no mailto', async () => {
      const meeting = await getOrCreateMeetingFor(db, TARGET_NOW);
      await registerVisitor(db, {
        fullName: 'First Timer', industry: 'Roofing', company: null,
        email: 'first@example.com', phone: null, clientOpId: 'v-rsvp-1', now: TARGET_NOW,
      });

      const { drafts } = await compileForMeeting(db, meeting.id);
      const draft = drafts.find((d): d is VisitorThankyouDraft => d.type === 'visitor_thankyou')!;
      expect(draft.html).not.toContain('mailto:');

      const [token] = await db.select().from(rsvpTokens).where(eq(rsvpTokens.personId, draft.personId));
      expect(token.purpose).toBe('rsvp');
      // TARGET_NOW's meeting is 2026-08-12 (Wednesday); next meeting = +7 days.
      expect(token.targetDate).toBe('2026-08-19');
      expect(draft.html).toContain(`/rsvp/${token.token}`);
    });

    it('v2 conversion CTA links to a real interest-purpose token, distinct from an rsvp token', async () => {
      const priorWeek = new Date('2026-08-05T19:00:00Z');
      const { person } = await registerVisitor(db, {
        fullName: 'Repeat Visitor', industry: 'HVAC', company: null,
        email: 'repeat-rsvp@example.com', phone: null, clientOpId: 'v-rsvp-2a', now: priorWeek,
      });
      const meeting = await getOrCreateMeetingFor(db, TARGET_NOW);
      await checkIn(db, { personId: person!.id, clientOpId: 'v-rsvp-2b', source: 'kiosk', now: TARGET_NOW });

      const { drafts } = await compileForMeeting(db, meeting.id);
      const draft = drafts.find((d): d is VisitorThankyouDraft => d.type === 'visitor_thankyou')!;
      expect(draft.isConversion).toBe(true);

      const tokenRows = await db.select().from(rsvpTokens).where(eq(rsvpTokens.personId, person!.id));
      expect(tokenRows).toHaveLength(1);
      expect(tokenRows[0].purpose).toBe('interest');
      expect(draft.html).toContain(`/rsvp/${tokenRows[0].token}`);
      // Still the currently-approved RSVP-style CTA text (pending Jason's
      // interest-specific copy) — only the href is interest-purpose.
      expect(draft.html).toContain('I&rsquo;m coming Wednesday &mdash; hold the seat');
    });

    it('is idempotent: compiling the same meeting twice reuses the same token, not a fresh one', async () => {
      const meeting = await getOrCreateMeetingFor(db, TARGET_NOW);
      await registerVisitor(db, {
        fullName: 'Repeat Preview', industry: 'Roofing', company: null,
        email: 'repeat-preview@example.com', phone: null, clientOpId: 'v-rsvp-3', now: TARGET_NOW,
      });

      const first = await compileForMeeting(db, meeting.id);
      const second = await compileForMeeting(db, meeting.id);
      const draft1 = first.drafts.find((d): d is VisitorThankyouDraft => d.type === 'visitor_thankyou')!;
      const draft2 = second.drafts.find((d): d is VisitorThankyouDraft => d.type === 'visitor_thankyou')!;
      expect(draft1.html).toBe(draft2.html); // same embedded token both times

      const tokenRows = await db.select().from(rsvpTokens).where(eq(rsvpTokens.personId, draft1.personId));
      expect(tokenRows).toHaveLength(1); // never duplicated
    });
  });

  describe('VISITOR SOURCES', () => {
    it('groups visitors by invitedBy, falling back to "Not specified" for blanks', async () => {
      const meeting = await getOrCreateMeetingFor(db, TARGET_NOW);
      await registerVisitor(db, {
        fullName: 'Sourced One', industry: 'Roofing', company: null,
        email: 'sourced-one@example.com', phone: null, clientOpId: 'src-1', now: TARGET_NOW,
        invitedBy: 'Jason Barrios',
      });
      await registerVisitor(db, {
        fullName: 'Sourced Two', industry: 'HVAC', company: null,
        email: 'sourced-two@example.com', phone: null, clientOpId: 'src-2', now: TARGET_NOW,
        invitedBy: 'Jason Barrios',
      });
      await registerVisitor(db, {
        fullName: 'Sourced Three', industry: 'Plumbing', company: null,
        email: 'sourced-three@example.com', phone: null, clientOpId: 'src-3', now: TARGET_NOW,
        invitedBy: 'Found us online',
      });
      await registerVisitor(db, {
        fullName: 'No Source', industry: 'Legal', company: null,
        email: 'no-source@example.com', phone: null, clientOpId: 'src-4', now: TARGET_NOW,
      });

      const { drafts } = await compileForMeeting(db, meeting.id);
      const report = drafts.find((d) => d.type === 'leadership_report')!;
      const line = report.text.split('\n').find((l) => l.startsWith('Visitor sources:'))!;
      expect(line).toBe('Visitor sources: Jason Barrios (2) · Found us online (1) · Not specified (1)');
      expect(report.html).toContain('Jason Barrios (2)');
      expect(report.html).toContain('Found us online (1)');
      expect(report.html).toContain('Not specified (1)');
    });
  });
});
