import { CtaButton } from '@/features/apipool-ui/site-shell';
import {
  ArrowRight,
  BarChart3,
  Check,
  CircleDollarSign,
  PlugZap,
  Wallet,
} from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/core/i18n/navigation';
import { APIPOOL_CONFIG } from '@/config/apipool';
import { Button } from '@/shared/components/ui/button';

export const revalidate = 3600;

const providers = ['OpenAI', 'Anthropic', 'Google', 'Qwen', 'Kimi', 'MiniMax'];

const featureIcons = [CircleDollarSign, Wallet, PlugZap, BarChart3] as const;

// 终端配色仅用于深底代码块（设计规范允许的唯一例外区）
const t = {
  cmd: '#7ee787',
  str: '#a5d6ff',
  url: '#79c0ff',
  dim: 'rgba(255,255,255,0.45)',
  fg: 'rgba(255,255,255,0.92)',
  comment: '#9aa4ae',
};

function QuickstartTerminal({
  model,
  response,
}: {
  model: string;
  response: string;
}) {
  return (
    <div className="relative">
      <div
        aria-hidden
        className="bg-primary/15 absolute -inset-3 rounded-2xl blur-2xl"
      />
      <div className="relative overflow-hidden rounded-xl border border-white/10 bg-[#0a0a0a]">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3 text-xs">
          <span className="size-2.5 rounded-full bg-[#ff5f56]/90" />
          <span className="size-2.5 rounded-full bg-[#ffbd2e]/90" />
          <span className="size-2.5 rounded-full bg-[#27c93f]/90" />
          <span className="ml-2 font-mono text-white/60">quickstart.sh</span>
          <span className="ml-auto font-mono text-white/30">zsh</span>
        </div>
        <pre className="overflow-x-auto px-4 py-5 font-mono text-xs leading-6 sm:text-[13px]">
          <code>
            <span style={{ color: t.dim }}>$ </span>
            <span style={{ color: t.cmd }}>curl</span>{' '}
            <span style={{ color: t.url }}>https://api2.apipool.dev</span>
            <span style={{ color: t.dim }}>/v1/chat/completions</span>
            <span style={{ color: t.dim }}> \</span>
            {'\n  '}
            <span style={{ color: t.fg }}>-H</span>{' '}
            <span style={{ color: t.str }}>
              {'"Authorization: Bearer $APIPOOL_API_KEY"'}
            </span>
            <span style={{ color: t.dim }}> \</span>
            {'\n  '}
            <span style={{ color: t.fg }}>-d</span>{' '}
            <span style={{ color: t.dim }}>{"'{"}</span>
            {'\n    '}
            <span style={{ color: t.cmd }}>{'"model"'}</span>
            <span style={{ color: t.dim }}>: </span>
            <span style={{ color: t.str }}>{`"${model}"`}</span>
            <span style={{ color: t.dim }}>,</span>
            {'\n    '}
            <span style={{ color: t.cmd }}>{'"messages"'}</span>
            <span style={{ color: t.dim }}>: [</span>
            <span style={{ color: t.dim }}>{'{ '}</span>
            <span style={{ color: t.cmd }}>{'"role"'}</span>
            <span style={{ color: t.dim }}>: </span>
            <span style={{ color: t.str }}>{'"user"'}</span>
            <span style={{ color: t.dim }}>, </span>
            <span style={{ color: t.cmd }}>{'"content"'}</span>
            <span style={{ color: t.dim }}>: </span>
            <span style={{ color: t.str }}>{'"Hello!"'}</span>
            <span style={{ color: t.dim }}>{' }'}]</span>
            {'\n  '}
            <span style={{ color: t.dim }}>{"}'"}</span>
          </code>
        </pre>
        <div className="border-t border-white/10 px-4 py-3 font-mono text-xs leading-6">
          <div className="mb-1 flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-[#27c93f]" />
            <span style={{ color: t.comment }}>200 OK · 412ms</span>
          </div>
          <span style={{ color: t.dim }}>{'{ '}</span>
          <span style={{ color: t.cmd }}>{'"content"'}</span>
          <span style={{ color: t.dim }}>: </span>
          <span style={{ color: t.str }}>{JSON.stringify(response)}</span>
          <span style={{ color: t.dim }}>{' }'}</span>
        </div>
      </div>
    </div>
  );
}

function ScenarioVignette({
  index,
  item,
}: {
  index: number;
  item: Record<string, string>;
}) {
  if (index === 0) {
    return (
      <div className="h-36 overflow-hidden rounded-lg bg-[#0a0a0a] p-4 font-mono text-xs leading-6">
        <div style={{ color: t.dim }}>{item.vignetteLine1}</div>
        <div style={{ color: t.fg }}>{item.vignetteLine2}</div>
        <div style={{ color: t.cmd }}>{item.vignetteLine3}</div>
        <div style={{ color: t.cmd }}>{item.vignetteLine4}</div>
        <div style={{ color: t.dim }}>▮</div>
      </div>
    );
  }

  if (index === 1) {
    return (
      <div className="bg-muted/50 flex h-36 flex-col justify-center gap-2 rounded-lg border p-4">
        <div className="bg-background text-muted-foreground w-3/4 rounded-lg rounded-bl-sm border px-3 py-2 text-xs">
          {item.vignetteUser}
        </div>
        <div className="bg-primary/10 text-foreground ml-auto w-3/4 rounded-lg rounded-br-sm px-3 py-2 text-xs">
          {item.vignetteAssistant}
        </div>
      </div>
    );
  }

  if (index === 2) {
    return (
      <div className="grid h-36 grid-cols-3 gap-2 rounded-lg border p-3">
        {[
          'from-emerald-200 to-teal-400',
          'from-stone-200 to-emerald-300',
          'from-teal-300 to-emerald-500',
          'from-emerald-300 to-stone-300',
          'from-teal-200 to-emerald-400',
          'from-emerald-400 to-teal-600',
        ].map((gradient, index) => (
          <div
            key={index}
            className={`rounded-md bg-gradient-to-br ${gradient}`}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-36 flex-col justify-center gap-2 rounded-lg border p-4 font-mono text-xs">
      <div className="text-muted-foreground">{item.vignetteLine1}</div>
      <div className="bg-muted h-2 w-full overflow-hidden rounded-full">
        <div className="bg-primary h-full w-4/5 rounded-full" />
      </div>
      <div className="text-muted-foreground flex justify-between">
        <span>{item.vignetteFile}</span>
        <span className="text-primary">82%</span>
      </div>
    </div>
  );
}

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const home = await getTranslations({ locale, namespace: 'pages.home' });
  const heroBullets = home.raw('hero.bullets') as string[];
  const steps = home.raw('steps.items') as Array<{
    index: string;
    title: string;
    description: string;
  }>;
  const features = (
    home.raw('features.items') as Array<{
      title: string;
      description: string;
    }>
  ).map((feature, index) => ({
    ...feature,
    icon: featureIcons[index] ?? CircleDollarSign,
  }));
  const scenarios = home.raw('scenarios.items') as Array<
    Record<string, string>
  >;

  return (
    <div>
      {/* Hero */}
      <section className="border-border border-b">
        <div className="mx-auto grid max-w-7xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:px-8 lg:py-24">
          <div className="min-w-0">
            <div className="text-primary font-mono text-xs tracking-widest uppercase">
              {home('hero.eyebrow')}
            </div>
            <h1 className="mt-4 text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">
              {home('hero.titleLine1')}
              <br />
              {home('hero.titleLine2')}
            </h1>
            <p className="text-muted-foreground mt-5 max-w-xl text-base leading-7">
              {home('hero.description')}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <CtaButton href="/dashboard">{home('hero.start')}</CtaButton>
              <Button
                asChild
                variant="outline"
                className="h-10 rounded-md px-5"
              >
                <Link href="/docs">{home('hero.docs')}</Link>
              </Button>
            </div>
            <div className="text-muted-foreground mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
              {heroBullets.map((bullet) => (
                <span key={bullet} className="inline-flex items-center gap-1.5">
                  <Check className="text-primary size-3.5" />
                  {bullet}
                </span>
              ))}
            </div>
          </div>

          <div className="min-w-0">
            <QuickstartTerminal
              model={APIPOOL_CONFIG.defaultLaunchModel}
              response={home('terminal.response')}
            />
          </div>
        </div>
      </section>

      {/* Providers */}
      <section className="border-border border-b">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-8 gap-y-3 px-4 py-6 sm:px-6 lg:px-8">
          <span className="text-muted-foreground text-xs tracking-widest uppercase">
            {home('providers.label')}
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

      {/* Scenarios */}
      <section className="border-border border-b py-14 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-10 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-3xl font-semibold tracking-tight">
                {home('scenarios.title')}
              </h2>
              <p className="text-muted-foreground mt-2 max-w-xl">
                {home('scenarios.description')}
              </p>
            </div>
            <Link
              href="/models"
              className="text-primary inline-flex items-center gap-1 text-sm font-medium"
            >
              {home('scenarios.modelsLink')}
              <ArrowRight className="size-4" />
            </Link>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {scenarios.map((scenario, index) => (
              <div key={scenario.title}>
                <ScenarioVignette index={index} item={scenario} />
                <h3 className="mt-4 font-semibold">{scenario.title}</h3>
                <p className="text-muted-foreground mt-1.5 text-sm leading-6">
                  {scenario.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-border border-b py-14 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-semibold tracking-tight">
            {home('steps.title')}
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
            {home('cta.title')}
          </h2>
          <p className="text-muted-foreground mx-auto mt-3 max-w-md">
            {home('cta.description')}
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <CtaButton href="/dashboard">{home('cta.console')}</CtaButton>
            <Button asChild variant="outline" className="h-10 rounded-md px-5">
              <Link href="/models">{home('cta.models')}</Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
