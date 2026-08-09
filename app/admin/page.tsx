import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import AdminClient from './admin-client';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const session = await auth();
  if (!session?.user?.email) redirect('/admin/login');
  return <AdminClient adminEmail={session.user.email} />;
}
