'use client';

import { Link } from '@/core/i18n/navigation';
import { ScrollArea, ScrollBar } from '@/shared/components/ui/scroll-area';
import {
  Tabs as TabsComponent,
  TabsList,
  TabsTrigger,
} from '@/shared/components/ui/tabs';
import { cn } from '@/shared/lib/utils';
import { Tab } from '@/shared/types/blocks/common';

export function Tabs({
  tabs,
  size,
}: {
  tabs: Tab[];
  size?: 'sm' | 'md' | 'lg';
}) {
  // The active tab is decided server-side (per route) via `is_active`; render
  // each tab as a real <Link> so navigation goes through the anchor. This drops
  // the old mount-time `router.push` (which stacked a duplicate history entry
  // every visit) and makes tabs middle-clickable / openable in a new tab.
  const activeName = tabs?.find((tab) => tab.is_active)?.name || '';

  return (
    <div className="relative mb-8">
      <ScrollArea className="w-full lg:max-w-none">
        <div className="flex items-center space-x-2">
          <TabsComponent value={activeName}>
            <TabsList className={cn(size === 'sm' && 'h-8')}>
              {tabs.map((tab, idx) => (
                <TabsTrigger key={idx} value={tab.name || ''} asChild>
                  <Link href={tab.url || ''}>{tab.title}</Link>
                </TabsTrigger>
              ))}
            </TabsList>
          </TabsComponent>
        </div>
        <ScrollBar orientation="horizontal" className="invisible" />
      </ScrollArea>
    </div>
  );
}
