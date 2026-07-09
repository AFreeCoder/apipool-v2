'use client';

import { ArrowRight } from 'lucide-react';

import { Link, usePathname } from '@/core/i18n/navigation';
import { SignUser } from '@/shared/blocks/sign/sign-user';
import { Button } from '@/shared/components/ui/button';
import { useAppContext } from '@/shared/contexts/app';
import { UserNav } from '@/shared/types/blocks/common';

/**
 * Header auth cluster: at most two controls, per docs/test/ui-review P0-1.
 *
 * - Signed out:  [sign in (ghost)] [get started (outline)]
 * - Signed in:   [console (outline)] [avatar] — console hidden while already
 *   inside /dashboard so the header never advertises the page you are on.
 *
 * Theme + language live in the avatar dropdown (show_preferences) and in the
 * footer for signed-out visitors, keeping the header itself quiet.
 */
export function HeaderAuthCluster({
  consoleLabel,
  getStartedLabel,
  userNav,
}: {
  consoleLabel: string;
  getStartedLabel: string;
  userNav: UserNav;
}) {
  const { user, isCheckSign } = useAppContext();
  const pathname = usePathname();
  const inConsole = pathname.startsWith('/dashboard');

  const cta = user ? (
    inConsole ? null : (
      <Button asChild variant="outline" size="sm">
        <Link href="/dashboard">
          {consoleLabel}
          <ArrowRight className="size-4" />
        </Link>
      </Button>
    )
  ) : (
    <Button asChild variant="outline" size="sm">
      <Link href="/sign-up">
        {getStartedLabel}
        <ArrowRight className="size-4" />
      </Link>
    </Button>
  );

  return (
    <div className="flex items-center gap-2">
      {user && cta}
      <SignUser
        signButtonSize="sm"
        signButtonVariant="ghost"
        userNav={userNav}
      />
      {!user && !isCheckSign && cta}
    </div>
  );
}
