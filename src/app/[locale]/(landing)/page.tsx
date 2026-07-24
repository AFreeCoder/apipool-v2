import { Check } from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { APIPOOL_CONFIG } from '@/config/apipool';
import { Link } from '@/core/i18n/navigation';
import { HeroTerminal } from '@/features/apipool-ui/hero-terminal';
import { CtaButton } from '@/features/apipool-ui/site-shell';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/shared/components/ui/accordion';
import { Button } from '@/shared/components/ui/button';
import { Marquee } from '@/shared/components/ui/marquee';

export const revalidate = 3600;

// 跑马灯展示数据（供应商与模型标识为语言中立的专有名词，与设计稿一致，随目录演进人工维护）
const liveProviders = ['OpenAI', 'Anthropic', 'Google', 'ByteDance'];
const soonProviders = [
  'DeepSeek',
  'Alibaba Qwen',
  'Meta Llama',
  'Mistral AI',
  'xAI Grok',
  'Zhipu GLM',
  'Moonshot Kimi',
];
const modelIds = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-image-2',
  'claude-fable-5',
  'claude-opus-4.8',
  'claude-sonnet-5',
  'claude-opus-4.7',
  'claude-opus-4.6',
];

const gridMask =
  'radial-gradient(ellipse 90% 70% at 50% 0%, #000 28%, transparent 100%)';

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const home = await getTranslations({ locale, namespace: 'pages.home' });

  const features = home.raw('features.items') as Array<{
    tag: string;
    title: string;
    description: string;
  }>;
  const usecases = home.raw('usecases.items') as Array<{
    no: string;
    title: string;
    description: string;
  }>;
  // FAQ 里的 base_url 随环境配置动态插值（规范化为恰好一个 /v1），
  // 避免硬编码生产网关导致 staging/自托管环境把密钥发往错误地址。
  const trimmedApiBase = APIPOOL_CONFIG.apiBaseUrl.replace(/\/+$/, '');
  const apiBaseWithV1 = trimmedApiBase.endsWith('/v1')
    ? trimmedApiBase
    : `${trimmedApiBase}/v1`;
  const faqItems = (
    home.raw('faq.items') as Array<{ q: string; a: string }>
  ).map((item) => ({
    q: item.q,
    a: item.a.replace('{baseUrl}', apiBaseWithV1),
  }));

  return (
    <div>
      {/* Hero */}
      <section className="border-border relative overflow-hidden border-b">
        <div
          aria-hidden
          className="bg-grid pointer-events-none absolute inset-0"
          style={{ WebkitMaskImage: gridMask, maskImage: gridMask }}
        />
        <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:px-8 lg:py-24">
          <div className="min-w-0">
            <div className="border-primary/25 bg-primary/5 text-primary inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium">
              <span className="bg-primary size-1.5 rounded-full" />
              {home('hero.badge')}
            </div>
            <h1 className="mt-6 text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
              {home('hero.titleLead')}
              <span className="text-primary">{home('hero.titleAccent')}</span>
            </h1>
            <p className="text-muted-foreground mt-5 max-w-xl text-base leading-7 text-pretty sm:text-lg">
              {home('hero.description')}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <CtaButton href="/dashboard">{home('hero.ctaPrimary')}</CtaButton>
              <Button
                asChild
                variant="outline"
                className="h-10 rounded-md px-5"
              >
                <Link href="/docs">{home('hero.ctaSecondary')}</Link>
              </Button>
            </div>
            <div className="text-muted-foreground mt-8 inline-flex items-center gap-2 font-mono text-sm">
              <Check className="text-primary size-4" />
              {home('hero.note')}
            </div>
          </div>

          <div className="min-w-0">
            <HeroTerminal
              apiBaseUrl={APIPOOL_CONFIG.apiBaseUrl}
              model={APIPOOL_CONFIG.defaultLaunchModel}
            />
          </div>
        </div>
      </section>

      {/* Model marquee */}
      <section className="border-border bg-muted/20 border-b py-12">
        <p className="text-muted-foreground mx-auto max-w-3xl px-4 text-center font-mono text-xs tracking-[0.14em] uppercase">
          {home('marquee.label')}
        </p>
        <div className="relative mt-7">
          <Marquee pauseOnHover className="[--duration:46s] [--gap:0.75rem]">
            {liveProviders.map((provider) => (
              <span
                key={provider}
                className="border-border bg-card text-foreground inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium whitespace-nowrap"
              >
                <span className="bg-primary size-1.5 rounded-full" />
                {provider}
              </span>
            ))}
            {soonProviders.map((provider) => (
              <span
                key={provider}
                className="border-border/70 text-muted-foreground inline-flex items-center gap-2 rounded-full border border-dashed px-4 py-2 text-sm font-medium whitespace-nowrap"
              >
                <span className="bg-muted-foreground/40 size-1.5 rounded-full" />
                {provider}
                <span className="border-border text-muted-foreground/70 rounded border px-1.5 py-px font-mono text-[10px] tracking-wide">
                  {home('marquee.soon')}
                </span>
              </span>
            ))}
          </Marquee>
          <Marquee
            reverse
            pauseOnHover
            className="mt-3 [--duration:56s] [--gap:0.75rem]"
          >
            {modelIds.map((model) => (
              <span
                key={model}
                className="border-border bg-card text-muted-foreground rounded-md border px-3.5 py-1.5 font-mono text-[13px] whitespace-nowrap"
              >
                {model}
              </span>
            ))}
          </Marquee>
          <div className="from-background pointer-events-none absolute inset-y-0 left-0 w-16 bg-gradient-to-r to-transparent sm:w-28" />
          <div className="from-background pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l to-transparent sm:w-28" />
        </div>
      </section>

      {/* Features */}
      <section id="features" className="border-border border-b py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <div className="text-primary font-mono text-xs tracking-[0.14em] uppercase">
              {home('features.eyebrow')}
            </div>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              {home('features.heading')}
            </h2>
            <p className="text-muted-foreground mt-3 text-base leading-7 text-pretty">
              {home('features.sub')}
            </p>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((feature) => (
              <div
                key={feature.title}
                className="border-border bg-card hover:border-primary/30 rounded-2xl border p-7 transition-shadow hover:shadow-lg"
              >
                <div className="border-primary/20 bg-primary/5 text-primary inline-flex size-11 items-center justify-center rounded-xl border font-mono text-xs font-bold">
                  {feature.tag}
                </div>
                <h3 className="mt-4 text-lg font-semibold tracking-tight">
                  {feature.title}
                </h3>
                <p className="text-muted-foreground mt-2 text-sm leading-6 text-pretty">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Use cases */}
      <section className="border-border bg-muted/20 border-b py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <div className="text-primary font-mono text-xs tracking-[0.14em] uppercase">
              {home('usecases.eyebrow')}
            </div>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              {home('usecases.heading')}
            </h2>
            <p className="text-muted-foreground mt-3 text-base leading-7 text-pretty">
              {home('usecases.sub')}
            </p>
          </div>
          <div className="grid gap-5 md:grid-cols-3">
            {usecases.map((usecase) => (
              <div
                key={usecase.title}
                className="border-border bg-card rounded-2xl border p-8"
              >
                <div className="text-primary font-mono text-base font-bold">
                  {usecase.no}
                </div>
                <h3 className="mt-5 text-xl font-semibold tracking-tight">
                  {usecase.title}
                </h3>
                <p className="text-muted-foreground mt-2.5 text-sm leading-6 text-pretty">
                  {usecase.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-border border-b py-16 sm:py-20">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <div className="mb-10 text-center">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              {home('faq.heading')}
            </h2>
            <p className="text-muted-foreground mt-3">{home('faq.sub')}</p>
          </div>
          <Accordion type="single" collapsible defaultValue="faq-0">
            {faqItems.map((item, index) => (
              <AccordionItem
                key={item.q}
                value={`faq-${index}`}
                className="bg-card ring-border mb-3 rounded-xl border-transparent px-5 ring-1 ring-inset"
              >
                <AccordionTrigger className="text-base font-semibold hover:no-underline">
                  {item.q}
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground text-[15px] leading-7 text-pretty">
                  {item.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      {/* CTA */}
      <section className="px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
        <div className="border-primary/15 bg-primary/5 relative mx-auto max-w-5xl overflow-hidden rounded-3xl border px-6 py-16 text-center sm:px-12">
          <div
            aria-hidden
            className="bg-grid pointer-events-none absolute inset-0 opacity-70"
          />
          <div className="relative">
            <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              {home('cta.title')}
            </h2>
            <p className="text-muted-foreground mx-auto mt-4 max-w-md text-base text-pretty sm:text-lg">
              {home('cta.description')}
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <CtaButton href="/dashboard">{home('cta.primary')}</CtaButton>
              <Button
                asChild
                variant="outline"
                className="h-10 rounded-md px-5"
              >
                <Link href="/models">{home('cta.secondary')}</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
