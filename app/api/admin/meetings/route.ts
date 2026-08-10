import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { attendance, meetings, people } from '@/db/schema';
import { requireAdmin } from '@/lib/admin-guard';

// Option B "Meeting list" — GET only, admin-guarded (identical pattern to
// the other admin routes). Two queries merged in JS rather than a per-
// meeting attendance fetch: meetings first (reverse-chron, capped at 26),
// then a single attendance-with-people query scoped to just those meeting
// ids — no N+1 as the list grows.
const MEETING_LIMIT = 26;

// Task 8: "Show earlier" pagination — req reads the ?offset= query param,
// same required-Request convention as app/api/admin/roster/route.ts's own
// GET (an optional param here would satisfy this file's own callers, but
// Next.js' generated route type-check requires an App Router GET's
// parameter type to be exactly Request|NextRequest, not Request|undefined
// — see .next/types' own ParamCheck).
export async function GET(req: Request) {
  const guard = await requireAdmin();
  if (guard instanceof Response) return guard;
  const db = getDb();

  const rawOffset = Number(new URL(req.url).searchParams.get('offset') ?? '0');
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

  // No status filter ("excluding none") and no date-range cutoff beyond the
  // LIMIT itself — today's meeting row (created via getOrCreateMeetingFor
  // as soon as the kiosk roster or admin attendance panel is loaded today)
  // is included like any other once it exists.
  //
  // Fetches one extra row (MEETING_LIMIT + 1) beyond the page size purely to
  // answer "is there another page" without a second COUNT query — sliced
  // back down to MEETING_LIMIT before it's ever used for anything else.
  const rawRows = await db.select().from(meetings)
    .orderBy(desc(meetings.meetingDate))
    .limit(MEETING_LIMIT + 1)
    .offset(offset);
  const hasMore = rawRows.length > MEETING_LIMIT;
  const meetingRows = rawRows.slice(0, MEETING_LIMIT);

  if (meetingRows.length === 0) {
    return Response.json({ meetings: [], hasMore: false });
  }

  const meetingIds = meetingRows.map((m) => m.id);
  const attendanceRows = await db.select({
    id: attendance.id,
    meetingId: attendance.meetingId,
    personId: attendance.personId,
    kind: attendance.kind,
    visitNumber: attendance.visitNumber,
    fullName: people.fullName,
  }).from(attendance)
    .innerJoin(people, eq(people.id, attendance.personId))
    .where(and(inArray(attendance.meetingId, meetingIds), isNull(attendance.voidedAt)));

  const byMeeting = new Map<string, typeof attendanceRows>();
  for (const row of attendanceRows) {
    const list = byMeeting.get(row.meetingId);
    if (list) list.push(row);
    else byMeeting.set(row.meetingId, [row]);
  }

  const result = meetingRows.map((m) => {
    const rows = (byMeeting.get(m.id) ?? []).slice()
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
    return {
      id: m.id,
      meetingDate: m.meetingDate,
      status: m.status,
      total: rows.length,
      memberCount: rows.filter((r) => r.kind === 'member').length,
      leadershipCount: rows.filter((r) => r.kind === 'leadership').length,
      visitorCount: rows.filter((r) => r.kind === 'visitor').length,
      attendees: rows.map((r) => ({
        personId: r.personId, fullName: r.fullName, kind: r.kind, visitNumber: r.visitNumber,
      })),
    };
  });

  return Response.json({ meetings: result, hasMore });
}
