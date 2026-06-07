import { notFound } from 'next/navigation';
import {
  formatModelPrice,
  getCallableModelQuickstartCurl,
  getModelBySlug,
  publicModels,
} from '@/features/api-catalog/lib/catalog';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  CircleDollarSign,
  Code2,
  KeyRound,
} from 'lucide-react';
import { setRequestLocale } from 'next-intl/server';

import { Link } from '@/core/i18n/navigation';
import { APIPOOL_CONFIG } from '@/config/apipool';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';

export function generateStaticParams() {
  return publicModels.map((model) => ({ slug: model.slug }));
}

export default async function ModelDetailPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const model = getModelBySlug(slug);
  if (!model) notFound();
  const price = formatModelPrice(model);
  const quickstartCurl = getCallableModelQuickstartCurl(model);

  return (
    <div className="bg-background">
      <section className="border-border/70 border-b py-12 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Button asChild variant="ghost" size="sm" className="mb-8 rounded-md">
            <Link href="/models">
              <ArrowLeft className="size-4" />
              Back to Model Market
            </Link>
          </Button>

          <div className="grid gap-8 lg:grid-cols-[1fr_0.78fr] lg:items-start">
            <div>
              <div className="flex flex-wrap gap-2">
                <Badge>{model.provider}</Badge>
                <Badge variant="secondary">LLM</Badge>
                <Badge
                  variant={
                    model.status === 'available' ? 'default' : 'secondary'
                  }
                >
                  {model.status === 'available' ? 'Available' : 'Coming soon'}
                </Badge>
              </div>

              <h1 className="mt-5 text-4xl leading-tight font-semibold tracking-normal sm:text-5xl">
                {model.displayName}
              </h1>
              <p className="text-muted-foreground mt-3 font-mono text-sm">
                {model.modelId}
              </p>
              <p className="text-muted-foreground mt-5 max-w-3xl text-base leading-7 sm:text-lg">
                {model.longDescription}
              </p>

              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                {quickstartCurl && (
                  <Button asChild className="h-10 rounded-md px-5">
                    <Link href="/dashboard/api-keys">
                      <KeyRound className="size-4" />
                      Get API key
                    </Link>
                  </Button>
                )}
                <Button
                  asChild
                  variant="outline"
                  className="h-10 rounded-md px-5"
                >
                  <Link href="/docs">
                    <BookOpen className="size-4" />
                    View docs
                  </Link>
                </Button>
              </div>
            </div>

            <div className="bg-card rounded-2xl border p-5 shadow-sm">
              <div className="bg-muted/40 rounded-xl border p-4">
                <div className="mb-4 flex items-center gap-2 text-sm font-medium">
                  <CircleDollarSign className="text-primary size-4" />
                  Reference pricing
                </div>
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Input</span>
                    <span>{price.input}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Output</span>
                    <span>{price.output}</span>
                  </div>
                </div>
                <p className="text-muted-foreground mt-4 text-xs leading-5">
                  {price.disclaimer}
                </p>
              </div>

              <div className="bg-muted/40 mt-4 rounded-xl border p-4">
                <div className="mb-4 flex items-center gap-2 text-sm font-medium">
                  <CheckCircle2 className="text-primary size-4" />
                  Capabilities
                </div>
                <div className="flex flex-wrap gap-2">
                  {model.capabilities.map((capability) => (
                    <span
                      key={capability}
                      className="bg-background text-muted-foreground rounded-md border px-2 py-1 text-xs"
                    >
                      {capability}
                    </span>
                  ))}
                </div>
                <div className="text-muted-foreground mt-4 text-sm">
                  Context window: {model.contextWindow.toLocaleString()} tokens
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {quickstartCurl ? (
        <section className="py-12 sm:py-14">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="bg-card overflow-hidden rounded-2xl border shadow-sm">
              <div className="border-b p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-2xl font-semibold tracking-normal">
                      Quickstart
                    </h2>
                    <p className="text-muted-foreground mt-2 text-sm">
                      Use the APIPool Base URL with your portal-created key.
                    </p>
                  </div>
                  <Button asChild variant="outline" className="rounded-md">
                    <Link href="/docs">
                      Read full docs
                      <ArrowRight className="size-4" />
                    </Link>
                  </Button>
                </div>
              </div>

              <div className="grid gap-5 p-5 lg:grid-cols-[0.8fr_1.2fr]">
                <div className="bg-muted/40 rounded-xl border p-4">
                  <div className="mb-2 text-sm font-medium">Base URL</div>
                  <code className="bg-background block overflow-x-auto rounded-lg p-3 font-mono text-sm">
                    {APIPOOL_CONFIG.apiBaseUrl}
                  </code>
                  <div className="mt-5 text-sm font-medium">Model ID</div>
                  <code className="bg-background mt-2 block overflow-x-auto rounded-lg p-3 font-mono text-sm">
                    {model.modelId}
                  </code>
                </div>

                <div className="overflow-hidden rounded-xl border bg-[#0a0a0a] text-white">
                  <div className="border-b border-white/10 px-4 py-3">
                    <div className="flex items-center gap-2 text-sm text-white/60">
                      <Code2 className="size-4" />
                      apipool — demo.request
                    </div>
                  </div>
                  <pre className="overflow-x-auto p-5 font-mono text-xs leading-6 text-white/80">
                    <code>{quickstartCurl}</code>
                  </pre>
                </div>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section className="py-12 sm:py-14">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="bg-card rounded-2xl border p-8">
              <h2 className="text-2xl font-semibold tracking-normal">
                Availability
              </h2>
              <p className="text-muted-foreground mt-2 max-w-2xl text-sm leading-6">
                This candidate model is not available for API calls until
                supply, billing, and smoke-call validation are complete.
              </p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
