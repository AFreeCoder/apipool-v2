import { CtaButton } from '@/features/apipool-ui/site-shell';
import {
  ArrowRight,
  BarChart3,
  Check,
  CircleDollarSign,
  PlugZap,
  Wallet,
} from 'lucide-react';
import { setRequestLocale } from 'next-intl/server';

import { Link } from '@/core/i18n/navigation';
import { APIPOOL_CONFIG } from '@/config/apipool';
import { Button } from '@/shared/components/ui/button';

export const revalidate = 3600;

const providers = ['OpenAI', 'Anthropic', 'Google', 'Qwen', 'Kimi', 'MiniMax'];

const heroBullets = ['OpenAI-compatible', 'No subscription', 'Balance never expires'];

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
      'Use your favorite SDK with one key. Switch models by name — that is the whole migration.',
  },
];

const features = [
  {
    icon: CircleDollarSign,
    title: 'Transparent pricing',
    description:
      'Per-token prices listed next to official rates. What you see is what you pay.',
  },
  {
    icon: Wallet,
    title: 'Pay as you go',
    description:
      'Top up in dollars, spend by the token. No plans, no lock-in, no expiry.',
  },
  {
    icon: PlugZap,
    title: 'OpenAI-compatible',
    description:
      'Works with the official SDKs and most tools by changing one base URL.',
  },
  {
    icon: BarChart3,
    title: 'Real usage data',
    description: 'Requests, tokens, and spend per model — live in your console.',
  },
];

// 终端配色仅用于深底代码块（设计规范允许的唯一例外区）
const t = {
  cmd: '#7ee787',
  str: '#a5d6ff',
  url: '#79c0ff',
  dim: 'rgba(255,255,255,0.45)',
  fg: 'rgba(255,255,255,0.92)',
  comment: '#9aa4ae',
};

function QuickstartTerminal({ model }: { model: string }) {
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
            <span style={{ color: t.url }}>
              https://api.apipool.dev/v1/chat/completions
            </span>
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
          <span style={{ color: t.str }}>
            {'"Hello! How can I help you today?"'}
          </span>
          <span style={{ color: t.dim }}>{' }'}</span>
        </div>
      </div>
    </div>
  );
}

const scenarios = [
  {
    title: 'Coding agents',
    description:
      'Long-running agents and dev tools that plan, edit, and test with frontier models.',
    vignette: (
      <div className="h-36 overflow-hidden rounded-lg bg-[#0a0a0a] p-4 font-mono text-xs leading-6">
        <div style={{ color: t.dim }}>▸ agent run · fix-build</div>
        <div style={{ color: t.fg }}>plan → edit → test</div>
        <div style={{ color: t.cmd }}>✓ 14 files changed</div>
        <div style={{ color: t.cmd }}>✓ tests passed in 42s</div>
        <div style={{ color: t.dim }}>▮</div>
      </div>
    ),
  },
  {
    title: 'Chat & copilots',
    description:
      'Production assistants with streaming responses and per-conversation cost control.',
    vignette: (
      <div className="bg-muted/50 flex h-36 flex-col justify-center gap-2 rounded-lg border p-4">
        <div className="bg-background text-muted-foreground w-3/4 rounded-lg rounded-bl-sm border px-3 py-2 text-xs">
          Summarize this PR for review
        </div>
        <div className="bg-primary/10 text-foreground ml-auto w-3/4 rounded-lg rounded-br-sm px-3 py-2 text-xs">
          3 changes: auth middleware, retry logic, tests…
        </div>
      </div>
    ),
  },
  {
    title: 'Image & media generation',
    description:
      'Multimodal pipelines for product art, thumbnails, and creative tooling.',
    vignette: (
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
    ),
  },
  {
    title: 'Batch & data pipelines',
    description:
      'Large-scale extraction, classification, and evals with predictable spend.',
    vignette: (
      <div className="flex h-36 flex-col justify-center gap-2 rounded-lg border p-4 font-mono text-xs">
        <div className="text-muted-foreground">processing 12,408 docs…</div>
        <div className="bg-muted h-2 w-full overflow-hidden rounded-full">
          <div className="bg-primary h-full w-4/5 rounded-full" />
        </div>
        <div className="text-muted-foreground flex justify-between">
          <span>batch-07.jsonl</span>
          <span className="text-primary">82%</span>
        </div>
      </div>
    ),
  },
];

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <div>
      {/* Hero */}
      <section className="border-border border-b">
        <div className="mx-auto grid max-w-7xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:px-8 lg:py-24">
          <div className="min-w-0">
            <div className="text-primary font-mono text-xs tracking-widest uppercase">
              {'// unified llm api'}
            </div>
            <h1 className="mt-4 text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">
              One endpoint.
              <br />
              Every frontier model.
            </h1>
            <p className="text-muted-foreground mt-5 max-w-xl text-base leading-7">
              Call OpenAI, Anthropic, and more through a single API. Transparent
              per-token pricing, balance you control, usage you can see.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <CtaButton href="/dashboard">Start building</CtaButton>
              <Button asChild variant="outline" className="h-10 rounded-md px-5">
                <Link href="/docs">Read the docs</Link>
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
            <QuickstartTerminal model={APIPOOL_CONFIG.defaultLaunchModel} />
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

      {/* Scenarios */}
      <section className="border-border border-b py-14 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-10 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-3xl font-semibold tracking-tight">
                From agents to images
              </h2>
              <p className="text-muted-foreground mt-2 max-w-xl">
                One balance and one key behind whatever you are building.
              </p>
            </div>
            <Link
              href="/models"
              className="text-primary inline-flex items-center gap-1 text-sm font-medium"
            >
              Models & pricing
              <ArrowRight className="size-4" />
            </Link>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {scenarios.map((scenario) => (
              <div key={scenario.title}>
                {scenario.vignette}
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
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
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
