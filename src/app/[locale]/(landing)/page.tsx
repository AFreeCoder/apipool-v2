import { CtaButton } from '@/features/apipool-ui/site-shell';
import {
  Activity,
  ArrowRight,
  BarChart3,
  Check,
  CircleDollarSign,
  Clock,
  Code2,
  Gauge,
  KeyRound,
  Layers3,
  LineChart,
  PlugZap,
  ReceiptText,
  Route,
  ShieldCheck,
  Shuffle,
  Terminal,
  Wallet,
} from 'lucide-react';
import { setRequestLocale } from 'next-intl/server';

import { Link } from '@/core/i18n/navigation';
import { APIPOOL_PUBLIC_CONFIG } from '@/config/apipool';
import { Copy } from '@/shared/blocks/table/copy';
import { Button } from '@/shared/components/ui/button';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/shared/components/ui/tabs';

export const revalidate = 3600;

type LocaleKey = 'en' | 'zh';

const providers = [
  { name: 'OpenAI', status: 'available' },
  { name: 'Anthropic', status: 'candidate' },
  { name: 'Google', status: 'candidate' },
  { name: 'DeepSeek', status: 'candidate' },
  { name: 'Qwen', status: 'candidate' },
  { name: 'Moonshot', status: 'candidate' },
];

const providerRoutes = [
  { name: 'OpenAI', latency: '412ms', share: '38%' },
  { name: 'Anthropic', latency: '508ms', share: '24%' },
  { name: 'Gemini', latency: '466ms', share: '18%' },
  { name: 'DeepSeek', latency: '451ms', share: '12%' },
  { name: 'Qwen', latency: '489ms', share: '8%' },
];

const homeCopy = {
  en: {
    eyebrow: '// unified model gateway',
    heroTitle: 'One endpoint for every model your app calls.',
    heroLead:
      'Use an OpenAI-compatible API to route requests, manage keys, track usage, and keep billing visible from one developer console.',
    primaryCta: 'Get API key',
    secondaryCta: 'View docs',
    heroBullets: [
      'OpenAI-compatible',
      'Usage-based billing',
      'Logs and balance in one place',
    ],
    topologyTitle: 'Live routing map',
    topologySubtitle:
      'APIPool routes each request to the selected provider and keeps operational data together.',
    appNode: 'Your app',
    gatewayNode: 'APIPool Gateway',
    providerNode: 'Model providers',
    operationsNode: 'Logs · Billing · Fallback · Monitoring',
    quickstartTitle: 'Developer quickstart',
    quickstartLead:
      'Change the Base URL, keep your SDK workflow, and call the launch model with one key.',
    baseUrlLabel: 'Base URL',
    copyLabel: 'Copy',
    copiedMessage: 'Copied quickstart',
    featuresTitle: 'Core gateway features',
    featuresLead:
      'The homepage now mirrors the real product loop: connect, route, spend, and inspect.',
    providersTitle: 'Provider coverage',
    providersLead:
      'Provider names support discovery and trust, while the gateway workflow remains the main visual.',
    dashboardTitle: 'Console preview',
    dashboardLead:
      'A denser operational preview puts requests, cost, latency, and recent logs above decorative logos.',
    useCasesTitle: 'Built for real API workloads',
    useCasesLead:
      'From a personal side project to internal platform teams, the same endpoint scales with the workflow.',
    stepsTitle: 'From sign-up to first request',
    ctaTitle: 'Ship with one API today',
    ctaLead:
      'Create a key, add credit, and make your first model call in minutes.',
    ctaSecondary: 'Browse models',
    quickstartPill: '5 min quickstart',
    subscriptionPill: 'No subscription',
    providerAvailable: 'available',
    providerCandidate: 'candidate',
  },
  zh: {
    eyebrow: '// unified model gateway',
    heroTitle: '一个接口，接入所有主流大模型。',
    heroLead:
      '兼容 OpenAI API，统一管理模型路由、API Key、用量日志、余额账单与失败兜底，让应用不再分别维护多套供应商接入。',
    primaryCta: '获取 API Key',
    secondaryCta: '查看接入文档',
    heroBullets: ['OpenAI API 兼容', '按量计费', '日志与余额集中可见'],
    topologyTitle: '实时路由拓扑',
    topologySubtitle:
      'APIPool 按模型选择路由请求，并把调用、计费和监控数据集中在控制台。',
    appNode: '你的应用',
    gatewayNode: 'APIPool 网关',
    providerNode: '模型供应商',
    operationsNode: '日志 · 计费 · 兜底 · 监控',
    quickstartTitle: '开发者快速接入',
    quickstartLead:
      '替换 Base URL，保留熟悉的 SDK 工作流，用一个 Key 调用首发模型。',
    baseUrlLabel: 'Base URL',
    copyLabel: '复制',
    copiedMessage: '已复制接入示例',
    featuresTitle: '核心网关能力',
    featuresLead: '首页信息层级收敛到真实产品闭环：接入、路由、消费、观测。',
    providersTitle: '供应商覆盖',
    providersLead: '供应商标识只作为信任补充，主视觉聚焦请求如何经过统一网关。',
    dashboardTitle: '控制台预览',
    dashboardLead:
      '用更高信息密度展示请求量、成本、延迟和最近日志，而不是把 logo 墙当成主视觉。',
    useCasesTitle: '面向真实 API 工作负载',
    useCasesLead: '从个人项目到企业内部平台，同一个端点覆盖不同开发工作流。',
    stepsTitle: '从注册到首次调用',
    ctaTitle: '今天就用一个 API 发货',
    ctaLead: '创建密钥、充值余额，并在几分钟内完成首次模型调用。',
    ctaSecondary: '浏览模型',
    quickstartPill: '5 分钟接入',
    subscriptionPill: '无需订阅',
    providerAvailable: '可调用',
    providerCandidate: '候选',
  },
};

const featureCopy = {
  en: [
    {
      icon: PlugZap,
      title: 'OpenAI-compatible API',
      description:
        'Use familiar chat completion clients by changing the base URL and model name.',
    },
    {
      icon: Route,
      title: 'Multi-model routing',
      description:
        'Keep provider choices behind one endpoint instead of wiring each SDK separately.',
    },
    {
      icon: ShieldCheck,
      title: 'Fallback-ready calls',
      description:
        'Design production flows around visible retries, status, and provider health.',
    },
    {
      icon: CircleDollarSign,
      title: 'Unified billing',
      description:
        'Top up a dollar balance and track spend by request, token, and model.',
    },
    {
      icon: KeyRound,
      title: 'API key management',
      description:
        'Create, copy, disable, and rotate keys from the console workflow.',
    },
    {
      icon: BarChart3,
      title: 'Request logs and monitoring',
      description:
        'Inspect requests, latency, token usage, and model distribution in one place.',
    },
  ],
  zh: [
    {
      icon: PlugZap,
      title: 'OpenAI API 兼容',
      description:
        '只需替换 Base URL 和模型名，就能沿用熟悉的 Chat Completions 客户端。',
    },
    {
      icon: Route,
      title: '多模型路由',
      description:
        '把供应商选择收敛到一个端点，而不是在业务里分别维护多套 SDK。',
    },
    {
      icon: ShieldCheck,
      title: '失败兜底预留',
      description: '围绕可见重试、状态和供应商健康度设计生产调用流程。',
    },
    {
      icon: CircleDollarSign,
      title: '统一计费',
      description: '充值美元余额，并按请求、Token 和模型维度追踪实际消费。',
    },
    {
      icon: KeyRound,
      title: 'API Key 管理',
      description: '在控制台完成创建、复制、禁用和轮换，减少密钥散落风险。',
    },
    {
      icon: BarChart3,
      title: '请求日志与监控',
      description: '集中查看请求、延迟、Token 用量和模型分布。',
    },
  ],
};

const useCasesCopy = {
  en: [
    {
      title: 'Individual developers',
      description:
        'Prototype with several model families before committing to a provider.',
      metric: '1 key',
    },
    {
      title: 'AI application teams',
      description:
        'Share cost visibility across agents, copilots, and batch jobs.',
      metric: '4 flows',
    },
    {
      title: 'Internal model gateway',
      description:
        'Centralize access patterns before teams scatter credentials across services.',
      metric: '12 teams',
    },
    {
      title: 'Agent, RAG, and bot platforms',
      description:
        'Route high-volume calls while keeping logs and billing reviewable.',
      metric: '99.9%',
    },
  ],
  zh: [
    {
      title: '个人开发者',
      description: '在决定主供应商前，快速试用多个模型家族。',
      metric: '1 key',
    },
    {
      title: 'AI 应用团队',
      description: '让 Agent、Copilot、批处理任务共享统一成本可见性。',
      metric: '4 flows',
    },
    {
      title: '企业内部模型网关',
      description: '在团队把凭据散落到各服务前，先集中接入规范。',
      metric: '12 teams',
    },
    {
      title: 'Agent / RAG / Bot 平台',
      description: '承载高频调用，同时保留可审计的日志与账单。',
      metric: '99.9%',
    },
  ],
};

const stepsCopy = {
  en: [
    {
      index: '01',
      title: 'Create an account',
      description:
        'Sign up and add a small balance. Usage is billed by real API consumption.',
    },
    {
      index: '02',
      title: 'Create an API key',
      description:
        'Generate a key in the console and store the plaintext value safely.',
    },
    {
      index: '03',
      title: 'Call a model',
      description:
        'Use the OpenAI-compatible endpoint and switch models by name.',
    },
  ],
  zh: [
    {
      index: '01',
      title: '注册账户',
      description: '创建账户并充值少量余额，后续按真实 API 用量扣费。',
    },
    {
      index: '02',
      title: '创建 API Key',
      description: '在控制台生成密钥，并安全保存只展示一次的明文 Key。',
    },
    {
      index: '03',
      title: '调用模型',
      description: '使用兼容 OpenAI 的端点，通过模型名切换不同供应商。',
    },
  ],
};

const dashboardCopy = {
  en: {
    metrics: [
      { label: 'Requests today', value: '128,420', trend: '+18.4%' },
      { label: 'Success rate', value: '99.92%', trend: '+0.3%' },
      { label: 'Spend today', value: '$42.18', trend: '-7.6%' },
      { label: 'P95 latency', value: '812ms', trend: '-41ms' },
    ],
    tableHead: ['Model', 'Status', 'Tokens', 'Cost'],
    rows: [
      ['gpt-4o-mini', '200 OK', '1,284', '$0.018'],
      ['claude-3-5-haiku', '200 OK', '904', '$0.021'],
      ['deepseek-chat', 'fallback', '2,166', '$0.014'],
    ],
  },
  zh: {
    metrics: [
      { label: '今日请求', value: '128,420', trend: '+18.4%' },
      { label: '成功率', value: '99.92%', trend: '+0.3%' },
      { label: '今日消费', value: '$42.18', trend: '-7.6%' },
      { label: 'P95 延迟', value: '812ms', trend: '-41ms' },
    ],
    tableHead: ['模型', '状态', 'Token', '费用'],
    rows: [
      ['gpt-4o-mini', '200 OK', '1,284', '$0.018'],
      ['claude-3-5-haiku', '200 OK', '904', '$0.021'],
      ['deepseek-chat', 'fallback', '2,166', '$0.014'],
    ],
  },
};

function createQuickstartSnippets(apiBaseUrl: string, model: string) {
  return {
    curl: `curl ${apiBaseUrl}/chat/completions \\
  -H "Authorization: Bearer $APIPOOL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{ "role": "user", "content": "Hello from APIPool" }]
  }'`,
    python: `from openai import OpenAI

client = OpenAI(
    api_key=os.environ["APIPOOL_API_KEY"],
    base_url="${apiBaseUrl}",
)

response = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hello from APIPool"}],
)

print(response.choices[0].message.content)`,
    node: `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.APIPOOL_API_KEY,
  baseURL: "${apiBaseUrl}",
});

const response = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "Hello from APIPool" }],
});

console.log(response.choices[0].message.content);`,
  };
}

function GatewayNode({
  icon: Icon,
  label,
  detail,
  emphasis = false,
}: {
  icon: typeof PlugZap;
  label: string;
  detail: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`bg-card rounded-xl border p-4 ${
        emphasis ? 'border-primary/40 bg-primary/5' : ''
      }`}
    >
      <div className="flex items-center gap-3">
        <span className="bg-muted inline-flex size-9 items-center justify-center rounded-md border">
          <Icon className="text-primary size-4" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{label}</div>
          <div className="text-muted-foreground truncate font-mono text-xs">
            {detail}
          </div>
        </div>
      </div>
    </div>
  );
}

function Connector() {
  return (
    <div className="flex justify-center py-2">
      <div className="bg-border h-8 w-px" />
    </div>
  );
}

function GatewayTopology({
  copy,
  model,
}: {
  copy: (typeof homeCopy)[LocaleKey];
  model: string;
}) {
  return (
    <div className="bg-card relative min-w-0 overflow-hidden rounded-xl border">
      <div className="bg-muted/40 border-b px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">{copy.topologyTitle}</div>
            <p className="text-muted-foreground mt-1 text-xs leading-5">
              {copy.topologySubtitle}
            </p>
          </div>
          <span className="bg-primary/10 text-primary shrink-0 rounded-md px-2 py-1 font-mono text-xs">
            live
          </span>
        </div>
      </div>
      <div className="p-4 sm:p-5">
        <GatewayNode
          icon={Code2}
          label={copy.appNode}
          detail="POST /chat/completions"
        />
        <Connector />
        <GatewayNode
          icon={Shuffle}
          label={copy.gatewayNode}
          detail={`model=${model}`}
          emphasis
        />
        <Connector />
        <div className="bg-muted/30 rounded-xl border p-3">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Layers3 className="text-primary size-4" />
            {copy.providerNode}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {providerRoutes.map((provider) => (
              <div
                key={provider.name}
                className="bg-background rounded-md border px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs">
                    {provider.name}
                  </span>
                  <span className="text-muted-foreground font-mono text-xs">
                    {provider.share}
                  </span>
                </div>
                <div className="text-muted-foreground mt-1 font-mono text-[11px]">
                  p50 {provider.latency}
                </div>
              </div>
            ))}
          </div>
        </div>
        <Connector />
        <GatewayNode
          icon={Gauge}
          label={copy.operationsNode}
          detail="/dashboard"
        />
      </div>
    </div>
  );
}

function QuickstartTabs({
  copy,
  snippets,
}: {
  copy: (typeof homeCopy)[LocaleKey];
  snippets: ReturnType<typeof createQuickstartSnippets>;
}) {
  const entries = [
    { value: 'curl', label: 'curl', code: snippets.curl },
    { value: 'python', label: 'Python', code: snippets.python },
    { value: 'node', label: 'Node.js', code: snippets.node },
  ];

  return (
    <Tabs defaultValue="curl" className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabsList className="h-9">
          {entries.map((entry) => (
            <TabsTrigger
              key={entry.value}
              value={entry.value}
              className="h-7 text-xs"
            >
              {entry.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="text-muted-foreground font-mono text-xs">
          {copy.baseUrlLabel}: {APIPOOL_PUBLIC_CONFIG.apiBaseUrl}
        </div>
      </div>
      {entries.map((entry) => (
        <TabsContent key={entry.value} value={entry.value} className="mt-4">
          <div className="overflow-hidden rounded-xl border bg-[#0a0a0a] text-white">
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
              <Terminal className="size-3.5 text-white/60" />
              <span className="font-mono text-xs text-white/60">
                quickstart.{entry.value}
              </span>
              <Copy
                value={entry.code}
                metadata={{ message: copy.copiedMessage }}
                className="ml-auto rounded-md border border-white/10 px-2 py-1 font-mono text-xs text-white/70 transition-colors hover:bg-white/10"
              >
                <span>{copy.copyLabel}</span>
              </Copy>
            </div>
            <pre className="overflow-x-auto py-5 font-mono text-xs leading-6 text-white/90 sm:text-[13px]">
              <code>{entry.code}</code>
            </pre>
          </div>
        </TabsContent>
      ))}
    </Tabs>
  );
}

function DashboardPreview({ localeKey }: { localeKey: LocaleKey }) {
  const copy = dashboardCopy[localeKey];

  return (
    <div className="bg-card overflow-hidden rounded-xl border">
      <div className="bg-muted/40 flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <LineChart className="text-primary size-4" />
          <span className="text-sm font-semibold">APIPool Console</span>
        </div>
        <div className="text-muted-foreground font-mono text-xs">last 24h</div>
      </div>
      <div className="bg-border grid gap-px sm:grid-cols-2 lg:grid-cols-4">
        {copy.metrics.map((metric) => (
          <div key={metric.label} className="bg-card p-4">
            <div className="text-muted-foreground text-xs">{metric.label}</div>
            <div className="mt-2 font-mono text-2xl font-semibold">
              {metric.value}
            </div>
            <div className="text-primary mt-1 font-mono text-xs">
              {metric.trend}
            </div>
          </div>
        ))}
      </div>
      <div className="grid gap-0 border-t lg:grid-cols-[0.9fr_1.1fr]">
        <div className="border-b p-4 lg:border-r lg:border-b-0">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div className="text-sm font-semibold">Model distribution</div>
            <Activity className="text-primary size-4" />
          </div>
          <div className="space-y-3">
            {providerRoutes.slice(0, 4).map((provider, index) => (
              <div key={provider.name}>
                <div className="mb-1 flex items-center justify-between font-mono text-xs">
                  <span>{provider.name}</span>
                  <span className="text-muted-foreground">
                    {provider.share}
                  </span>
                </div>
                <div className="bg-muted h-2 overflow-hidden rounded-full">
                  <div
                    className="bg-primary h-full rounded-full"
                    style={{ width: `${52 - index * 10}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="min-w-0 p-4">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div className="text-sm font-semibold">Recent requests</div>
            <ReceiptText className="text-primary size-4" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="bg-muted text-muted-foreground text-xs uppercase">
                <tr>
                  {copy.tableHead.map((head) => (
                    <th key={head} className="px-3 py-2 font-medium">
                      {head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {copy.rows.map((row) => (
                  <tr key={row.join('-')} className="border-t">
                    {row.map((cell, index) => (
                      <td
                        key={cell}
                        className={`px-3 py-2.5 font-mono text-xs ${
                          index === 1 ? 'text-primary' : ''
                        }`}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
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

  const localeKey: LocaleKey = locale === 'zh' ? 'zh' : 'en';
  const copy = homeCopy[localeKey];
  const snippets = createQuickstartSnippets(
    APIPOOL_PUBLIC_CONFIG.apiBaseUrl,
    APIPOOL_PUBLIC_CONFIG.defaultLaunchModel
  );

  return (
    <div>
      <section className="border-border border-b">
        <div className="mx-auto grid max-w-7xl items-center gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1.03fr_0.97fr] lg:px-8 lg:py-20">
          <div className="min-w-0">
            <div className="text-primary font-mono text-xs tracking-widest uppercase">
              {copy.eyebrow}
            </div>
            <h1 className="mt-4 max-w-3xl text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">
              {copy.heroTitle}
            </h1>
            <p className="text-muted-foreground mt-5 max-w-2xl text-base leading-7">
              {copy.heroLead}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <CtaButton href="/dashboard">{copy.primaryCta}</CtaButton>
              <Button
                asChild
                variant="outline"
                className="h-10 rounded-md px-5"
              >
                <Link href="/docs">{copy.secondaryCta}</Link>
              </Button>
            </div>
            <div className="text-muted-foreground mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
              {copy.heroBullets.map((bullet) => (
                <span key={bullet} className="inline-flex items-center gap-1.5">
                  <Check className="text-primary size-3.5" />
                  {bullet}
                </span>
              ))}
            </div>
          </div>

          <div className="min-w-0">
            <GatewayTopology
              copy={copy}
              model={APIPOOL_PUBLIC_CONFIG.defaultLaunchModel}
            />
          </div>
        </div>
      </section>

      <section className="border-border border-b">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-8 gap-y-3 px-4 py-6 sm:px-6 lg:px-8">
          <span className="text-muted-foreground text-xs tracking-widest uppercase">
            Providers
          </span>
          {providers.map((provider) => (
            <span
              key={provider.name}
              className="text-muted-foreground font-mono text-sm"
            >
              {provider.name}
            </span>
          ))}
        </div>
      </section>

      <section className="border-border border-b py-14 sm:py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.78fr_1.22fr] lg:px-8">
          <div>
            <div className="text-primary mb-3 font-mono text-xs tracking-widest uppercase">
              Quickstart
            </div>
            <h2 className="text-3xl font-semibold tracking-tight">
              {copy.quickstartTitle}
            </h2>
            <p className="text-muted-foreground mt-3 leading-7">
              {copy.quickstartLead}
            </p>
            <div className="mt-6 grid gap-3 text-sm">
              {[
                ['Base URL', APIPOOL_PUBLIC_CONFIG.apiBaseUrl],
                ['Model', APIPOOL_PUBLIC_CONFIG.defaultLaunchModel],
              ].map(([label, value]) => (
                <div key={label} className="bg-card rounded-xl border p-4">
                  <div className="text-muted-foreground text-xs">{label}</div>
                  <div className="mt-2 font-mono text-sm break-all">
                    {value}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <QuickstartTabs copy={copy} snippets={snippets} />
        </div>
      </section>

      <section className="border-border border-b py-14 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-10 max-w-2xl">
            <div className="text-primary mb-3 font-mono text-xs tracking-widest uppercase">
              Capabilities
            </div>
            <h2 className="text-3xl font-semibold tracking-tight">
              {copy.featuresTitle}
            </h2>
            <p className="text-muted-foreground mt-3 leading-7">
              {copy.featuresLead}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {featureCopy[localeKey].map((feature) => (
              <div
                key={feature.title}
                className="bg-card rounded-xl border p-5"
              >
                <feature.icon className="text-primary size-5" />
                <h3 className="mt-4 font-semibold">{feature.title}</h3>
                <p className="text-muted-foreground mt-2 text-sm leading-6">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-border border-b py-14 sm:py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.68fr_1.32fr] lg:px-8">
          <div>
            <div className="text-primary mb-3 font-mono text-xs tracking-widest uppercase">
              Providers
            </div>
            <h2 className="text-3xl font-semibold tracking-tight">
              {copy.providersTitle}
            </h2>
            <p className="text-muted-foreground mt-3 leading-7">
              {copy.providersLead}
            </p>
            <Link
              href="/models"
              className="text-primary mt-6 inline-flex items-center gap-1 text-sm font-medium"
            >
              Models & pricing
              <ArrowRight className="size-4" />
            </Link>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {providers.map((provider) => (
              <div
                key={provider.name}
                className="bg-card flex items-center justify-between gap-3 rounded-xl border p-4"
              >
                <span className="font-mono text-sm">{provider.name}</span>
                <span
                  className={`rounded-md px-2 py-1 font-mono text-xs ${
                    provider.status === 'available'
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {provider.status === 'available'
                    ? copy.providerAvailable
                    : copy.providerCandidate}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-border border-b py-14 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-10 max-w-2xl">
            <div className="text-primary mb-3 font-mono text-xs tracking-widest uppercase">
              Dashboard
            </div>
            <h2 className="text-3xl font-semibold tracking-tight">
              {copy.dashboardTitle}
            </h2>
            <p className="text-muted-foreground mt-3 leading-7">
              {copy.dashboardLead}
            </p>
          </div>
          <DashboardPreview localeKey={localeKey} />
        </div>
      </section>

      <section className="border-border border-b py-14 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-10 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="text-primary mb-3 font-mono text-xs tracking-widest uppercase">
                Use cases
              </div>
              <h2 className="text-3xl font-semibold tracking-tight">
                {copy.useCasesTitle}
              </h2>
              <p className="text-muted-foreground mt-2 max-w-xl">
                {copy.useCasesLead}
              </p>
            </div>
            <Link
              href="/docs"
              className="text-primary inline-flex items-center gap-1 text-sm font-medium"
            >
              {copy.secondaryCta}
              <ArrowRight className="size-4" />
            </Link>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {useCasesCopy[localeKey].map((scenario) => (
              <div
                key={scenario.title}
                className="bg-card rounded-xl border p-5"
              >
                <div className="text-primary font-mono text-2xl font-semibold">
                  {scenario.metric}
                </div>
                <h3 className="mt-5 font-semibold">{scenario.title}</h3>
                <p className="text-muted-foreground mt-2 text-sm leading-6">
                  {scenario.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-border border-b py-14 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-semibold tracking-tight">
            {copy.stepsTitle}
          </h2>
          <div className="mt-10 grid gap-8 md:grid-cols-3">
            {stepsCopy[localeKey].map((step) => (
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

      <section className="py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <div className="bg-card mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border">
            <Wallet className="text-primary size-5" />
          </div>
          <h2 className="text-3xl font-semibold tracking-tight">
            {copy.ctaTitle}
          </h2>
          <p className="text-muted-foreground mx-auto mt-3 max-w-md">
            {copy.ctaLead}
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <CtaButton href="/dashboard">{copy.primaryCta}</CtaButton>
            <Button asChild variant="outline" className="h-10 rounded-md px-5">
              <Link href="/models">{copy.ctaSecondary}</Link>
            </Button>
          </div>
          <div className="text-muted-foreground mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="text-primary size-3.5" />
              {copy.quickstartPill}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Wallet className="text-primary size-3.5" />
              {copy.subscriptionPill}
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
