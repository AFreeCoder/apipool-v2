import { redirect } from '@/core/i18n/navigation';

export default async function BillingCancelRedirect({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect({ href: '/dashboard/billing', locale });
}
