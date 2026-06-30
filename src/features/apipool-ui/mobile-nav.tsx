'use client';

import { useEffect, useState } from 'react';
import { Menu } from 'lucide-react';

import { Link } from '@/core/i18n/navigation';
import { LocaleSelector, ThemeToggler } from '@/shared/blocks/common';
import { Button } from '@/shared/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/shared/components/ui/sheet';

/**
 * Mobile navigation drawer. The design system requires the nav to collapse into
 * a drawer below the lg breakpoint instead of an always-open inline strip.
 */
export function MobileNav({
  items,
  openLabel,
  menuTitle,
}: {
  items: { href: string; label: string }[];
  openLabel: string;
  menuTitle: string;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const triggerButton = (
    <Button
      variant="ghost"
      size="icon"
      aria-label={openLabel}
      className="lg:hidden"
    >
      <Menu className="size-5" />
    </Button>
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return triggerButton;
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>{triggerButton}</SheetTrigger>
      <SheetContent side="left" className="w-72">
        <SheetHeader>
          <SheetTitle>{menuTitle}</SheetTitle>
        </SheetHeader>
        <nav className="grid gap-1 px-2">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className="text-muted-foreground hover:text-foreground hover:bg-muted rounded-md px-3 py-2.5 text-sm transition-colors"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-2 flex items-center gap-2 border-t px-4 pt-4">
          <ThemeToggler />
          <LocaleSelector type="button" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
