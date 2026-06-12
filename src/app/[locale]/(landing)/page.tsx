import Image from 'next/image';
import {
  formatModelPrice,
  getQuickstartCurl,
  publicModels,
} from '@/features/api-catalog/lib/catalog';
import { CtaButton } from '@/features/apipool-ui/site-shell';
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  CheckCircle2,
  Code2,
  Copy,
  Gauge,
  Headphones,
  PlugZap,
  Route,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Wallet,
} from 'lucide-react';
import { setRequestLocale } from 'next-intl/server';

import { Link } from '@/core/i18n/navigation';
import { APIPOOL_CONFIG } from '@/config/apipool';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';

export const revalidate = 3600;

const providerChips = [
  'OpenAI',
  'Anthropic',
  'Google',
  'Qwen',
  'Kimi',
  'MiniMax',
];

const categoryTabs = ['Image', 'Video', 'LLM'];

const quickSteps = [
  {
    title: 'Sign Up & Create Key',
    description:
      'Register an account and generate an APIPool key in the dashboard.',
    actions: [
      { label: 'Get API Key', href: '/dashboard/api-keys' },
      { label: 'View Docs', href: '/docs' },
    ],
  },
  {
    title: 'Update Configuration',
    description:
      'Change the API endpoint to APIPool while keeping familiar request formats.',
    actions: [{ label: 'View Docs', href: '/docs' }],
  },
  {
    title: 'Start Calling Models',
    description:
      'Send requests through one Base URL and monitor quota, requests, and tokens.',
    actions: [{ label: 'Track Usage', href: '/dashboard/usage' }],
  },
];

const reasons = [
  {
    title: 'Official routes',
    description: 'Curated launch routes with visible status and smoke checks.',
    icon: ShieldCheck,
  },
  {
    title: 'Transparent pricing',
    description: 'Per-token reference prices and billing notes stay visible.',
    icon: Wallet,
  },
  {
    title: 'One console',
    description: 'Keys, quota, usage, and billing live in the APIPool portal.',
    icon: Gauge,
  },
  {
    title: 'Fast integration',
    description: 'OpenAI-style snippets are ready for existing toolchains.',
    icon: PlugZap,
  },
  {
    title: 'Usage visibility',
    description: 'Request counts, tokens, and model distribution are surfaced.',
    icon: BarChart3,
  },
  {
    title: 'Human support',
    description: 'Support remains reachable when an integration needs help.',
    icon: Headphones,
  },
];

const faqs = [
  {
    question: 'What is APIPool?',
    answer:
      'APIPool is a multi-model API portal for developers who want one Base URL, one key workflow, and clear usage visibility.',
  },
  {
    question: 'Which models are available first?',
    answer:
      'The public catalog starts with a smoke-tested OpenAI route, while additional OpenAI and Anthropic candidates remain marked until supply and billing are verified.',
  },
  {
    question: 'How do I integrate it?',
    answer:
      'Create an account, generate an API key, set the Base URL to APIPool, and call the chat completions endpoint with your selected model ID.',
  },
  {
    question: 'Can I see usage and quota?',
    answer:
      'Yes. The APIPool dashboard is designed to show quota, request counts, token usage, billing entries, and model distribution.',
  },
];

export default async function LandingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const popularModels = publicModels
    .filter((model) => model.featured)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .slice(0, 6);
  const quickstartCurl = getQuickstartCurl();
  const promptText = `Please read APIPool's documentation index and answer my integration questions based on it:

${APIPOOL_CONFIG.siteUrl}/docs

About APIPool: a multi-model API portal for OpenAI and Anthropic launch routes through one APIPool Base URL. Keep answers focused on API keys, model IDs, quota, usage, and request examples.

My question: How do I send my first chat request with ${APIPOOL_CONFIG.defaultLaunchModel}?`;

  return (
    <div className="bg-background">
      <section className="border-border/70 overflow-hidden border-b py-16 sm:py-20 lg:py-24">
        <div className="mx-auto grid max-w-7xl grid-cols-1 gap-10 px-4 sm:px-6 lg:grid-cols-2 lg:items-center lg:px-8">
          <div className="min-w-0 flex flex-col justify-center gap-7">
            <div className="border-border bg-muted/50 text-muted-foreground inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-xs">
              <Sparkles className="text-primary size-3" />
              One endpoint · curated models · usage clarity
            </div>

            <div className="space-y-5">
              <h1 className="text-foreground max-w-3xl text-4xl leading-[1.18] font-semibold tracking-normal sm:text-5xl lg:text-6xl lg:leading-[1.12]">
                <span className="block">Aggregate routes</span>
                <span className="bg-primary text-primary-foreground mt-2 inline-flex rounded-xl px-3 py-1">
                  for top AI APIs
                </span>
              </h1>
              <p className="text-muted-foreground max-w-xl text-base leading-7 sm:text-lg">
                One Base URL for launch-ready AI models, clear pricing, and a
                dashboard built for API usage control.
              </p>
            </div>

            <div className="grid gap-2 text-sm sm:flex sm:flex-wrap sm:gap-x-5 sm:gap-y-2">
              {['Clear pricing', 'Reliable routes', 'Easy integration'].map(
                (label) => (
                  <span key={label} className="inline-flex items-center gap-1">
                    <CheckCircle2 className="fill-primary text-primary-foreground size-4" />
                    {label}
                  </span>
                )
              )}
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <CtaButton
                href="/dashboard/api-keys"
                className="w-full justify-center sm:w-auto"
              >
                Get Started
              </CtaButton>
              <Button
                asChild
                variant="outline"
                className="bg-background h-10 w-full justify-center rounded-md px-5 sm:w-auto"
              >
                <Link href="/docs">
                  <BookOpen className="size-4" />
                  View Documentation
                </Link>
              </Button>
            </div>

            <div className="grid max-w-xl grid-cols-1 gap-3 text-sm sm:grid-cols-3">
              {[
                ['1', 'Base URL'],
                ['API', 'Key flow'],
                ['Usage', 'Visibility'],
              ].map(([value, label]) => (
                <div key={label} className="bg-card rounded-lg border p-3">
                  <div className="text-foreground font-semibold">{value}</div>
                  <div className="text-muted-foreground mt-1 text-xs">
                    {label}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-card relative min-w-0 overflow-hidden rounded-2xl border p-5 shadow-sm lg:min-h-[420px]">
            <div className="absolute top-8 right-8 size-40 opacity-10">
              <Image
                src="/logo.png"
                alt=""
                width={160}
                height={160}
                className="object-contain"
              />
            </div>
            <div className="relative flex h-full flex-col justify-between gap-5 lg:min-h-[380px]">
              <div className="bg-background rounded-xl border p-4 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-muted-foreground text-xs">
                      apipool — request router
                    </div>
                    <div className="mt-1 break-all font-mono text-sm">
                      {APIPOOL_CONFIG.apiBaseUrl}/chat/completions
                    </div>
                  </div>
                  <Badge>Live</Badge>
                </div>
                <div className="mt-5 grid grid-cols-1 items-center gap-3 text-xs sm:grid-cols-[1fr_auto_1fr]">
                  <div className="bg-muted/60 min-w-0 rounded-lg border p-3">
                    <div className="font-medium">Client app</div>
                    <div className="text-muted-foreground mt-1">
                      Codex · Claude · SaaS
                    </div>
                  </div>
                  <ArrowRight className="text-muted-foreground hidden size-4 sm:block" />
                  <div className="bg-muted/60 min-w-0 rounded-lg border p-3">
                    <div className="font-medium">APIPool API</div>
                    <div className="text-muted-foreground mt-1">
                      Key · quota · usage
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {popularModels.slice(0, 4).map((model) => (
                  <Link
                    key={model.slug}
                    href="/models"
                    className="bg-background hover:border-primary/40 rounded-xl border p-4 transition hover:shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium">{model.displayName}</div>
                        <div className="text-muted-foreground mt-1 font-mono text-xs">
                          {model.modelId}
                        </div>
                      </div>
                      <span className="bg-muted text-muted-foreground rounded-md px-2 py-1 text-xs">
                        {model.provider}
                      </span>
                    </div>
                    <div className="mt-4 text-sm">
                      {formatModelPrice(model).input}
                    </div>
                  </Link>
                ))}
              </div>

              <div className="rounded-xl border bg-[#0a0a0a] p-4 text-white">
                <div className="mb-3 flex items-center gap-2 text-xs text-white/60">
                  <span className="size-2 rounded-full bg-red-400" />
                  <span className="size-2 rounded-full bg-yellow-400" />
                  <span className="size-2 rounded-full bg-green-500" />
                  <span className="ml-2">demo.request</span>
                </div>
                <pre className="max-h-[260px] overflow-auto font-mono text-xs leading-6 text-white/80 sm:max-h-none">
                  <code>{quickstartCurl}</code>
                </pre>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-border/70 border-b py-8">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-3 px-4 sm:px-6 lg:px-8">
          {providerChips.map((provider) => (
            <div
              key={provider}
              className="bg-card text-muted-foreground inline-flex min-w-32 items-center justify-center rounded-lg border px-4 py-3 text-sm font-medium"
            >
              {provider}
            </div>
          ))}
        </div>
      </section>

      <section className="border-border/70 border-b py-14 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-3xl font-semibold tracking-normal">
                Popular Models
              </h2>
              <p className="text-muted-foreground mt-2 max-w-xl">
                Curated launch and candidate models across the APIPool catalog.
              </p>
            </div>
            <div className="bg-muted flex rounded-lg border p-1">
              {categoryTabs.map((tab) => (
                <span
                  key={tab}
                  className={
                    tab === 'LLM'
                      ? 'bg-background rounded-md px-4 py-2 text-sm font-medium shadow-sm'
                      : 'text-muted-foreground px-4 py-2 text-sm'
                  }
                >
                  {tab}
                </span>
              ))}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {popularModels.map((model) => {
              const price = formatModelPrice(model);

              return (
                <Link
                  key={model.slug}
                  href="/models"
                  className="group bg-card hover:border-primary/40 flex min-h-60 flex-col rounded-xl border p-5 transition hover:shadow-md"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-muted-foreground text-sm">
                        {model.provider}
                      </div>
                      <h3 className="mt-2 text-lg leading-6 font-semibold">
                        {model.displayName}
                      </h3>
                    </div>
                    <Badge
                      variant={
                        model.status === 'available' ? 'default' : 'secondary'
                      }
                    >
                      {model.status === 'available' ? 'Ready' : 'Soon'}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground mt-4 line-clamp-4 text-sm leading-6">
                    {model.shortDescription}
                  </p>
                  <div className="mt-auto pt-5">
                    <div className="text-muted-foreground font-mono text-xs">
                      {model.modelId}
                    </div>
                    <div className="mt-3 flex items-end justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold">
                          {price.input}
                        </div>
                        <div className="text-muted-foreground mt-1 text-xs">
                          {price.output}
                        </div>
                      </div>
                      <span className="text-primary group-hover:bg-primary group-hover:text-primary-foreground rounded-md bg-green-50 px-2 py-1 text-xs font-medium">
                        Try it
                      </span>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>

          <div className="mt-8 text-center">
            <Button asChild variant="outline" className="rounded-md">
              <Link href="/models">
                View all models
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="border-border/70 border-b py-14 sm:py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:px-8">
          <div className="flex flex-col justify-center">
            <h2 className="text-3xl font-semibold tracking-normal">
              One prompt — use APIPool from any Agent
            </h2>
            <p className="text-muted-foreground mt-3 max-w-lg leading-7">
              Copy one prompt into Codex, Claude, Cursor, or any agent so it can
              reason from APIPool docs and model IDs while you integrate.
            </p>
          </div>
          <div className="bg-card overflow-hidden rounded-xl border shadow-sm">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <TerminalSquare className="size-4" />
                apipool — llms prompt
              </div>
              <Button variant="outline" size="sm" className="rounded-md">
                <Copy className="size-4" />
                Copy prompt
              </Button>
            </div>
            <pre className="bg-muted/40 max-h-80 overflow-auto p-5 font-mono text-xs leading-6">
              <code>{promptText}</code>
            </pre>
          </div>
        </div>
      </section>

      <section className="border-border/70 border-b py-14 sm:py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:px-8">
          <div>
            <h2 className="text-3xl font-semibold tracking-normal">
              3 minute quick integration
            </h2>
            <p className="text-muted-foreground mt-3">
              Within minutes, you can create a key and route requests through
              APIPool.
            </p>

            <div className="mt-8 space-y-4">
              {quickSteps.map((step, index) => (
                <div key={step.title} className="bg-card rounded-xl border p-5">
                  <div className="flex gap-4">
                    <div className="bg-primary text-primary-foreground flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold">
                      {index + 1}
                    </div>
                    <div>
                      <h3 className="font-semibold">{step.title}</h3>
                      <p className="text-muted-foreground mt-1 text-sm leading-6">
                        {step.description}
                      </p>
                      <div className="mt-4 flex flex-wrap gap-2">
                        {step.actions.map((action) => (
                          <Button
                            key={action.label}
                            asChild
                            variant="outline"
                            size="sm"
                            className="rounded-md"
                          >
                            <Link href={action.href}>{action.label}</Link>
                          </Button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border bg-[#0a0a0a] text-white shadow-sm lg:self-start">
            <div className="border-b border-white/10 px-5 py-4">
              <div className="flex items-center gap-2 text-sm text-white/60">
                <Code2 className="size-4" />
                apipool — demo.request
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {['cURL', 'Python', 'JavaScript', 'Go', 'Java', 'PHP'].map(
                  (lang) => (
                    <span
                      key={lang}
                      className={
                        lang === 'cURL'
                          ? 'rounded-md bg-white px-3 py-1.5 text-xs font-medium text-black'
                          : 'rounded-md border border-white/10 px-3 py-1.5 text-xs text-white/60'
                      }
                    >
                      {lang}
                    </span>
                  )
                )}
              </div>
            </div>
            <pre className="overflow-x-auto p-5 font-mono text-xs leading-6 text-white/80">
              <code>{quickstartCurl}</code>
            </pre>
          </div>
        </div>
      </section>

      <section className="border-border/70 border-b py-14 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-8 max-w-2xl">
            <h2 className="text-3xl font-semibold tracking-normal">
              Why teams choose APIPool
            </h2>
            <p className="text-muted-foreground mt-3">
              One platform, clear pricing, visible usage, and a direct path from
              key creation to production calls.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {reasons.map((reason, index) => (
              <div key={reason.title} className="bg-card rounded-xl border p-6">
                <div className="flex items-start gap-4">
                  <div className="text-muted-foreground text-sm font-semibold">
                    {String(index + 1).padStart(2, '0')}
                  </div>
                  <reason.icon className="text-primary size-5" />
                </div>
                <h3 className="mt-6 text-lg font-semibold">{reason.title}</h3>
                <p className="text-muted-foreground mt-2 text-sm leading-6">
                  {reason.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-border/70 border-b py-14 sm:py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.8fr_1.2fr] lg:px-8">
          <div>
            <h2 className="text-3xl font-semibold tracking-normal">FAQ</h2>
            <p className="text-muted-foreground mt-3">
              Short answers for developers evaluating the APIPool launch flow.
            </p>
          </div>
          <div className="bg-card divide-y rounded-xl border">
            {faqs.map((faq) => (
              <div key={faq.question} className="p-6">
                <h3 className="font-semibold">{faq.question}</h3>
                <p className="text-muted-foreground mt-2 text-sm leading-6">
                  {faq.answer}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-14 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="bg-card rounded-2xl border p-8 text-center shadow-sm sm:p-12">
            <div className="bg-muted mx-auto flex size-12 items-center justify-center rounded-full">
              <Route className="text-primary size-6" />
            </div>
            <h2 className="mt-6 text-3xl font-semibold tracking-normal">
              Ready to get started?
            </h2>
            <p className="text-muted-foreground mt-3">
              Trusted by developers · Powered by verified AI routes
            </p>
            <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
              <CtaButton
                href="/dashboard/api-keys"
                className="w-full justify-center sm:w-auto"
              >
                Get started
              </CtaButton>
              <Button
                asChild
                variant="outline"
                className="h-10 w-full justify-center rounded-md sm:w-auto"
              >
                <Link href="/docs">
                  View documentation
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
