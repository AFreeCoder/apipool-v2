'use client';

import { useTranslations } from 'next-intl';

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/shared/components/ui/tabs';

import { AuditTab } from './audit-tab';
import { MetricsTab } from './metrics-tab';
import { ReconciliationTab } from './reconciliation-tab';
import { RequestsTab } from './requests-tab';

export function ApipoolWorkbench() {
  const t = useTranslations('admin.apipool');
  const tabs = [
    ['requests', t('tabs.requests')],
    ['reconciliation', t('tabs.reconciliation')],
    ['metrics', t('tabs.metrics')],
    ['audit', t('tabs.audit')],
  ] as const;

  return (
    <Tabs defaultValue="requests" className="space-y-4">
      <TabsList className="h-auto flex-wrap justify-start">
        {tabs.map(([value, label]) => (
          <TabsTrigger key={value} value={value}>
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="requests">
        <RequestsTab />
      </TabsContent>
      <TabsContent value="reconciliation">
        <ReconciliationTab />
      </TabsContent>
      <TabsContent value="metrics">
        <MetricsTab />
      </TabsContent>
      <TabsContent value="audit">
        <AuditTab />
      </TabsContent>
    </Tabs>
  );
}
