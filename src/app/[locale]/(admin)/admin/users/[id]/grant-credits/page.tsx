import { redirect } from '@/core/i18n/navigation';

export default async function UserGrantCreditsRedirect({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  redirect({ href: `/admin/apipool-adjustments?portalUserId=${id}`, locale });
}
