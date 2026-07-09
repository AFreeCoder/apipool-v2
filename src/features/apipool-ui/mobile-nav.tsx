'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, Menu } from 'lucide-react';

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
 * The console CTA and theme/language preferences live here on mobile so the
 * compact header stays at two controls.
 */
export function MobileNav({
  items,
  openLabel,
  menuTitle,
  consoleItem,
  themeLabel,
  languageLabel,
}: {
  items: { href: string; label: string }[];
  openLabel: string;
  menuTitle: string;
  consoleItem: { href: string; label: string };
  themeLabel: string;
  languageLabel: string;
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
      <SheetContent side="left" className="flex w-72 flex-col">
        <SheetHeader>
          <SheetTitle>{menuTitle}</SheetTitle>
        </SheetHeader>
        <nav className="grid gap-1 px-2">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className="text-foreground hover:bg-muted rounded-md px-3 py-3 text-base transition-colors"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="px-4 pt-2">
          <Button asChild variant="outline" className="w-full">
            <Link href={consoleItem.href} onClick={() => setOpen(false)}>
              {consoleItem.label}
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
        <div className="mt-auto space-y-3 border-t px-4 py-4">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-sm">{themeLabel}</span>
            <ThemeToggler type="toggle" className="h-8" />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-sm">
              {languageLabel}
            </span>
            <LocaleSelector type="button" />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
