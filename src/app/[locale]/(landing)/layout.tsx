import { ReactNode } from 'react';
import { SiteShell } from '@/features/apipool-ui/site-shell';

export default async function LandingLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <SiteShell>{children}</SiteShell>;
}
