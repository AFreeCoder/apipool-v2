import { ReactNode } from 'react';
import { LocaleDetector } from '@/shared/blocks/common';
import { SiteShell } from '@/features/apipool-ui/site-shell';

export default async function LandingLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <SiteShell>
      <LocaleDetector />
      {children}
    </SiteShell>
  );
}
