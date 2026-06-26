import { getApipoolCopy } from '@/features/apipool-ui/copy';

export default async function NoPermissionPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const copy = getApipoolCopy(locale).noPermission;

  return (
    <div className="flex h-screen flex-col items-center justify-center">
      <h1 className="text-2xl font-normal">{copy.accessDenied}</h1>
    </div>
  );
}
