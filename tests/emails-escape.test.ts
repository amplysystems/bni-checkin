import { describe, it, expect } from 'vitest';
import { escapeHtml } from '@/emails/escape-html';
import { visitorThankyouHtml, visitorThankyouText } from '@/emails/visitor-thankyou';
import { visitorConversionHtml, visitorConversionText, visitorConversionSubject } from '@/emails/visitor-conversion';
import { leadershipReportHtml, leadershipReportText, type LeadershipReportData } from '@/emails/leadership-report';

const XSS_NAME = '<img src=x onerror=1>';

function baseReportData(overrides: Partial<LeadershipReportData> = {}): LeadershipReportData {
  return {
    meetingDateLabel: 'Wednesday, August 12, 2026',
    attendanceCount: 1,
    presentMembers: [],
    presentLeadership: [],
    absentMembers: [],
    visitors: [],
    skippedVisitorEmails: [],
    activeMemberCount: 10,
    membershipGoal: 25,
    weeklyCounts: [],
    siteUrl: 'https://example.test',
    ...overrides,
  };
}

describe('escapeHtml', () => {
  it('escapes &, <, >, ", \' — & first so its own entity is not re-escaped', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('Mike Anderson, Divorce attorney')).toBe('Mike Anderson, Divorce attorney');
  });

  it('is idempotent-safe against a value that already contains an ampersand word', () => {
    expect(escapeHtml('P&C insurance')).toBe('P&amp;C insurance');
  });
});

describe('template HTML escaping at the person-data boundary', () => {
  it('visitorThankyouHtml escapes a malicious firstName; the text variant is untouched', () => {
    const html = visitorThankyouHtml({ firstName: XSS_NAME, siteUrl: 'https://example.test' });
    expect(html).not.toContain(XSS_NAME);
    expect(html).toContain('&lt;img src=x onerror=1&gt;');

    const text = visitorThankyouText({ firstName: XSS_NAME });
    expect(text).toContain(XSS_NAME); // plain text — no HTML context, escaping would be wrong here
  });

  it('visitorConversionHtml escapes a malicious firstName and industry; the text variant is untouched', () => {
    const html = visitorConversionHtml({
      firstName: XSS_NAME, industry: XSS_NAME, activeMemberCount: 10, siteUrl: 'https://example.test',
    });
    expect(html).not.toContain(XSS_NAME);
    expect(html).toContain('&lt;img src=x onerror=1&gt;');

    const text = visitorConversionText({ firstName: XSS_NAME, industry: XSS_NAME, activeMemberCount: 10 });
    expect(text).toContain(XSS_NAME);
  });

  it('leadershipReportHtml escapes member names, visitor fields, and skipped-visitor names; text is untouched', () => {
    const data = baseReportData({
      presentMembers: [XSS_NAME],
      absentMembers: [XSS_NAME],
      visitors: [{
        name: XSS_NAME, industry: XSS_NAME, email: XSS_NAME, phone: XSS_NAME, company: XSS_NAME, visitNumber: 1,
      }],
      skippedVisitorEmails: [XSS_NAME],
    });
    const html = leadershipReportHtml(data);
    expect(html).not.toContain(XSS_NAME);
    // Exactly one legitimate <img> in this template (the BNI logo) — no
    // additional <img appears from any unescaped person field.
    expect((html.match(/<img /g) ?? []).length).toBe(1);
    // Appears escaped at least once per field position (member name, absent
    // name, visitor name/industry/email/phone/company, skipped name).
    expect((html.match(/&lt;img src=x onerror=1&gt;/g) ?? []).length).toBeGreaterThanOrEqual(7);

    const text = leadershipReportText(data);
    expect(text).toContain(XSS_NAME); // plain text — untouched
  });

  it('subject lines are plain text and are never HTML-escaped', () => {
    // Resend subjects render in a mail client's subject-line UI, not an
    // HTML document — escaping there would show a literal "&lt;img..."
    // to the recipient instead of the actual (harmless-in-that-context) text.
    const subject = visitorConversionSubject(XSS_NAME, XSS_NAME);
    expect(subject).toContain(XSS_NAME);
    expect(subject).not.toContain('&lt;');
  });
});
