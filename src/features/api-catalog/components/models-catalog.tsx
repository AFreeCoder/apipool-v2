'use client';

import { useState, type ReactNode } from 'react';
import { ArrowDown, RotateCcw, Search } from 'lucide-react';

import { Link } from '@/core/i18n/navigation';

export interface CatalogRow {
  key: string;
  displayName: string;
  modelId: string;
  description: string | null;
  vendorName: string;
  category: string;
  capabilities: string[];
  pricingBasis: 'token' | 'unit' | 'duration';
  tiers: { skuKey: string; price: string; originalPrice: string | null }[];
  inputMain: string;
  inputOrig: string | null;
  outputMain: string;
  outputOrig: string | null;
  savings: string | null;
  note: string | null;
  statusName: string;
  statusSlug: string;
  isCallable: boolean;
  searchText: string;
}

export interface CatalogLabels {
  model: string;
  provider: string;
  inputOrCall: string;
  output: string;
  savings: string;
  search: string;
  reset: string;
  count: string;
  emptyTitle: string;
  emptyClear: string;
  notReady: string;
}

/**
 * /models 目录：服务端把每行价格/折扣/状态都预格式化成字符串传进来，
 * 本组件只做「按名称/ID 的客户端搜索 + 计数 + 渲染」，不触碰服务端查询。
 * 维度筛选 chip（href 驱动、仍是 server 组件）通过 children 放进筛选卡内。
 */
export function ModelsCatalog({
  rows,
  labels,
  clearHref,
  children,
}: {
  rows: CatalogRow[];
  labels: CatalogLabels;
  clearHref: string;
  children: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const visible = q ? rows.filter((row) => row.searchText.includes(q)) : rows;

  return (
    <div>
      {/* 筛选卡：搜索 + 重置 + 维度 chip 行 */}
      <div className="border-border bg-card rounded-2xl border p-4 shadow-sm sm:p-5">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={labels.search}
              className="border-input bg-background focus-visible:ring-ring w-full rounded-lg border py-2.5 pr-3 pl-10 text-sm outline-none focus-visible:ring-2"
            />
          </div>
          <Link
            href={clearHref}
            onClick={() => setQuery('')}
            className="border-input text-muted-foreground hover:border-primary/40 hover:text-primary inline-flex items-center gap-1.5 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors"
          >
            <RotateCcw className="size-3.5" />
            {labels.reset}
          </Link>
        </div>
        {children}
      </div>

      {/* 计数 */}
      <div className="text-muted-foreground mt-6 mb-3 font-mono text-xs">
        {labels.count.replace('{count}', String(visible.length))}
      </div>

      {/* 价格表 */}
      {visible.length === 0 ? (
        <div className="border-border bg-card rounded-2xl border p-12 text-center">
          <div className="font-medium">{labels.emptyTitle}</div>
          <Link
            href={clearHref}
            onClick={() => setQuery('')}
            className="text-primary mt-3 inline-block text-sm font-medium"
          >
            {labels.emptyClear}
          </Link>
        </div>
      ) : (
        <div className="border-border bg-card overflow-hidden rounded-2xl border shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="bg-muted/40 text-muted-foreground border-border border-b text-xs tracking-wide uppercase">
                  <th className="w-full px-4 py-3.5 text-left font-medium">
                    {labels.model}
                  </th>
                  <th className="px-4 py-3.5 text-left font-medium">
                    {labels.provider}
                  </th>
                  <th className="px-4 py-3.5 text-right font-medium whitespace-nowrap">
                    {labels.inputOrCall}
                  </th>
                  <th className="px-4 py-3.5 text-right font-medium whitespace-nowrap">
                    {labels.output}
                  </th>
                  <th className="px-4 py-3.5 text-right font-medium whitespace-nowrap">
                    {labels.savings}
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr
                    key={row.key}
                    className="border-border/70 hover:bg-muted/30 border-b transition-colors last:border-b-0"
                  >
                    <td className="px-4 py-4 align-top">
                      <div className="font-semibold">{row.displayName}</div>
                      <div className="text-muted-foreground font-mono text-xs">
                        {row.modelId}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <span className="border-primary/20 bg-primary/5 text-primary rounded-md border px-2 py-0.5 text-[11px]">
                          {row.category}
                        </span>
                        {row.capabilities.map((capability) => (
                          <span
                            key={capability}
                            className="border-border bg-muted/60 text-muted-foreground rounded-md border px-2 py-0.5 text-[11px]"
                          >
                            {capability}
                          </span>
                        ))}
                        {row.statusSlug !== 'available' ? (
                          <span className="border-border text-muted-foreground rounded-md border border-dashed px-2 py-0.5 text-[11px]">
                            {row.statusName}
                          </span>
                        ) : !row.isCallable ? (
                          // status=available 但发布未就绪：显式标「未就绪」，
                          // 不沿用会误导为可调用的「Available」。
                          <span className="border-border text-muted-foreground rounded-md border border-dashed px-2 py-0.5 text-[11px]">
                            {labels.notReady}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="text-muted-foreground px-4 py-4 align-top whitespace-nowrap">
                      {row.vendorName}
                    </td>
                    <td className="px-4 py-4 text-right align-top font-mono whitespace-nowrap">
                      {row.pricingBasis !== 'token' ? (
                        <div className="space-y-1 text-xs">
                          {row.tiers.map((tier) => (
                            <div key={tier.skuKey}>
                              <div className="text-muted-foreground break-all">
                                {tier.skuKey}
                              </div>
                              <div className="font-semibold">{tier.price}</div>
                              {tier.originalPrice && (
                                <div className="text-muted-foreground/70 line-through">
                                  {tier.originalPrice}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <>
                          <div className="font-semibold">{row.inputMain}</div>
                          {row.inputOrig && (
                            <div className="text-muted-foreground/70 text-xs line-through">
                              {row.inputOrig}
                            </div>
                          )}
                        </>
                      )}
                    </td>
                    <td className="px-4 py-4 text-right align-top font-mono whitespace-nowrap">
                      <div className="font-semibold">{row.outputMain}</div>
                      {row.outputOrig && (
                        <div className="text-muted-foreground/70 text-xs line-through">
                          {row.outputOrig}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-4 text-right align-top whitespace-nowrap">
                      {row.savings ? (
                        <span className="text-primary inline-flex items-center gap-1 font-mono text-xs font-semibold">
                          {row.savings}
                          <ArrowDown className="size-3" />
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                      {row.note && (
                        <div className="text-muted-foreground mt-1 text-[11px]">
                          {row.note}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
