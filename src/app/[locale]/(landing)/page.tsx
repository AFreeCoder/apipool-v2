import {
  getQuickstartCurl,
  publicModels,
} from '@/features/api-catalog/lib/catalog';
import { CtaButton } from '@/features/apipool-ui/site-shell';
import { ArrowRight, BarChart3, CircleDollarSign, PlugZap, Wallet } from 'lucide-react';
import { setRequestLocale } from 'next-intl/server';

import { Link } from '@/core/i18n/navigation';
import {
  APIPOOL_CONFIG,
  PRICE_DISCLAIMER_EN,
  PRICE_DISCLAIMER_ZH,
} from '@/config/apipool';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';

export const revalidate = 3600;

const providers = ['OpenAI', 'Anthropic', 'Google', 'Qwen', 'Kimi', 'MiniMax'];

const steps = [
  {
    index: '01',
    title: 'Create an account',
    description:
      'Sign up and add credit to your balance. Usage is billed per token — no subscription, balance never expires.',
  },
  {
    index: '02',
    title: 'Create an API key',
    description:
      'Generate a key in the console. The plaintext key is shown once — keep it safe.',
  },
  {
    index: '03',
    title: 'Call any model',
    description:
      'Point your OpenAI-compatible SDK at our Base URL and switch models by name. That is the whole migration.',
  },
];

const features = [
  {
    icon: CircleDollarSign,
    title: 'Transparent pricing',
    description: 'Per-token prices listed next to official rates. What you see is what you pay.',
  },
  {
    icon: Wallet,
    title: 'Pay as you go',
    description: 'Top up in dollars, spend by the token. No plans, no lock-in, no expiry.',
  },
  {
    icon: PlugZap,
    title: 'OpenAI-compatible',
    description: 'Works with the official SDKs and most tools by changing one Base URL.',
  },
  {
    icon: BarChart3,
    title: 'Real usage data',
    description: 'Requests, tokens, and spend per model — live in your console.',
  },
];

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const quickstartCurl = getQuickstartCurl();
  const featuredModels = publicModels.slice(0, 5);
  const priceDisclaimer =
    locale === 'zh' ? PRICE_DISCLAIMER_ZH : PRICE_DISCLAIMER_EN;

  return (
    <div>
      {/* Hero */}
      <section className="border-border border-b">
        <div className="mx-auto grid max-w-7xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:px-8 lg:py-24">
          <div>
            <div className="text-primary font-mono text-xs tracking-widest uppercase">
              {'// unified llm api'}
            </div>
            <h1 className="mt-4 text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">
              One endpoint.
              <br />
              Every frontier model.
            </h1>
            <p className="text-muted-foreground mt-5 max-w-xl text-base leading-7">
              Call OpenAI, Anthropic, and more through a single
              OpenAI-compatible API. Transparent per-token pricing, balance you
              control, usage you can see.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <CtaButton href="/dashboard">Start building</CtaButton>
              <Button asChild variant="outline" className="h-10 rounded-md px-5">
                <Link href="/docs">Read the docs</Link>
              </Button>
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">Base URL</span>
              <code className="bg-muted rounded-md border px-2.5 py-1.5 font-mono">
                {APIPOOL_CONFIG.apiBaseUrl}
              </code>
            </div>
          </div>

          <div className="min-w-0">
            <div className="overflow-hidden rounded-xl border bg-[#0a0a0a] text-white">
              <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3 text-xs text-white/50">
                <span className="size-2.5 rounded-full bg-white/15" />
                <span className="size-2.5 rounded-full bg-white/15" />
                <span className="size-2.5 rounded-full bg-white/15" />
                <span className="ml-2 font-mono">quickstart.sh</span>
              </div>
              <pre className="overflow-x-auto px-4 py-5 font-mono text-xs leading-6 text-white/90 sm:text-[13px]">
                <code>{quickstartCurl}</code>
              </pre>
              <div className="border-t border-white/10 px-4 py-3 font-mono text-xs leading-6">
                <span className="text-white/60">{'// response'}</span>
                <div className="text-white/70">
                  {'{ "choices": [ { "message": { "content": "Hello!" } } ] }'}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Providers */}
      <section className="border-border border-b">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-8 gap-y-3 px-4 py-6 sm:px-6 lg:px-8">
          <span className="text-muted-foreground text-xs tracking-widest uppercase">
            Providers
          </span>
          {providers.map((provider) => (
            <span
              key={provider}
              className="text-muted-foreground font-mono text-sm"
            >
              {provider}
            </span>
          ))}
        </div>
      </section>

      {/* Model pricing excerpt */}
      <section className="border-border border-b py-14 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-3xl font-semibold tracking-tight">
                Models & pricing
              </h2>
              <p className="text-muted-foreground mt-2">
                Per 1M tokens, billed by actual usage.
              </p>
            </div>
            <Link
              href="/models"
              className="text-primary inline-flex items-center gap-1 text-sm font-medium"
            >
              View all models
              <ArrowRight className="size-4" />
            </Link>
          </div>

          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="bg-muted text-muted-foreground border-b text-xs uppercase">
                  <th className="px-4 py-3 text-left font-medium">Model</th>
                  <th className="px-4 py-3 text-left font-medium">Provider</th>
                  <th className="px-4 py-3 text-right font-medium">
                    Input / 1M
                  </th>
                  <th className="px-4 py-3 text-right font-medium">
                    Output / 1M
                  </th>
                  <th className="px-4 py-3 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {featuredModels.map((model) => (
                  <tr
                    key={model.slug}
                    className="hover:bg-muted/50 border-b transition-colors last:border-b-0"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium">{model.displayName}</div>
                      <div className="text-muted-foreground font-mono text-xs">
                        {model.modelId}
                      </div>
                    </td>
                    <td className="text-muted-foreground px-4 py-3">
                      {model.provider}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      ${model.pricing.inputPerMillionUsd.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      ${model.pricing.outputPerMillionUsd.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Badge
                        variant={
                          model.status === 'available' ? 'default' : 'secondary'
                        }
                        className={
                          model.status === 'available'
                            ? 'bg-primary/10 text-primary border-transparent'
                            : ''
                        }
                      >
                        {model.status === 'available'
                          ? 'Available'
                          : 'Coming soon'}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground mt-3 text-xs">
            {priceDisclaimer}
          </p>
        </div>
      </section>

      {/* How it works */}
      <section className="border-border border-b py-14 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-semibold tracking-tight">
            Up and running in minutes
          </h2>
          <div className="mt-10 grid gap-8 md:grid-cols-3">
            {steps.map((step) => (
              <div key={step.index}>
                <div className="text-primary font-mono text-sm">
                  {step.index}
                </div>
                <h3 className="mt-3 text-lg font-semibold">{step.title}</h3>
                <p className="text-muted-foreground mt-2 text-sm leading-6">
                  {step.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-border border-b py-14 sm:py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:grid-cols-2 sm:px-6 lg:grid-cols-4 lg:px-8">
          {features.map((feature) => (
            <div key={feature.title}>
              <feature.icon className="text-primary size-5" />
              <h3 className="mt-3 font-semibold">{feature.title}</h3>
              <p className="text-muted-foreground mt-2 text-sm leading-6">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="text-3xl font-semibold tracking-tight">
            Ship with one API today
          </h2>
          <p className="text-muted-foreground mx-auto mt-3 max-w-md">
            Create a key, add credit, and make your first call in under five
            minutes.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <CtaButton href="/dashboard">Open the console</CtaButton>
            <Button asChild variant="outline" className="h-10 rounded-md px-5">
              <Link href="/models">Browse models</Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
