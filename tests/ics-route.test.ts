import { describe, it, expect } from 'vitest';
import { GET as icsGET } from '@/app/api/ics/route';

describe('GET /api/ics', () => {
  it('serves a downloadable, public (no-token) calendar invite', async () => {
    const res = await icsGET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-disposition')).toContain('bni-wheeling-meeting.ics');
    const body = await res.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('SUMMARY:BNI Wheeling weekly meeting');
  });
});
