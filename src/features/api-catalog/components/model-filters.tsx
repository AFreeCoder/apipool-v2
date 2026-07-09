'use client';

import { Check, ChevronDown } from 'lucide-react';

import { Link } from '@/core/i18n/navigation';
import { Button } from '@/shared/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu';
import { cn } from '@/shared/lib/utils';

export interface ModelFilterOption {
  slug: string;
  name: string;
  href: string;
  active: boolean;
}

export interface ModelFilterGroup {
  key: string;
  label: string;
  allHref: string;
  activeName: string | null;
  options: ModelFilterOption[];
}

/**
 * Single-row filter bar for /models (docs/05 §6: the table must be visible
 * in the first viewport). Each dimension is a dropdown of plain links, so
 * filter state keeps living in the URL exactly like the old pill rows.
 */
export function ModelFilters({
  groups,
  allLabel,
  clearLabel,
  clearHref,
}: {
  groups: ModelFilterGroup[];
  allLabel: string;
  clearLabel: string;
  clearHref: string;
}) {
  const hasAnyActive = groups.some((group) => group.activeName !== null);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {groups.map((group) => (
        <DropdownMenu key={group.key}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn(
                'h-8 gap-1.5 px-2.5 text-xs',
                group.activeName !== null && 'border-primary/50'
              )}
            >
              <span className="text-muted-foreground">{group.label}</span>
              <span className="font-medium">
                {group.activeName ?? allLabel}
              </span>
              <ChevronDown className="size-3.5 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem asChild>
              <Link className="w-full cursor-pointer" href={group.allHref}>
                <span>{allLabel}</span>
                {group.activeName === null && (
                  <Check size={16} className="text-primary ml-auto" />
                )}
              </Link>
            </DropdownMenuItem>
            {group.options.map((option) => (
              <DropdownMenuItem asChild key={option.slug}>
                <Link className="w-full cursor-pointer" href={option.href}>
                  <span>{option.name}</span>
                  {option.active && (
                    <Check size={16} className="text-primary ml-auto" />
                  )}
                </Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
      {hasAnyActive && (
        <Link
          href={clearHref}
          className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 transition-colors hover:underline"
        >
          {clearLabel}
        </Link>
      )}
    </div>
  );
}
