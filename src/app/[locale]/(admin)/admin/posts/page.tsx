import { redirect } from '@/core/i18n/navigation';

export default async function PostsRedirect({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect({ href: '/admin/apipool-adjustments', locale });
}
