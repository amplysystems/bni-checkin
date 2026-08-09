import { getDb } from '@/lib/db';
import { kioskRoster } from '@/lib/checkins';
import { greetingFor } from '@/lib/time';

export async function GET() {
  const roster = await kioskRoster(getDb(), new Date());
  return Response.json({ greeting: greetingFor(new Date()), ...roster });
}
