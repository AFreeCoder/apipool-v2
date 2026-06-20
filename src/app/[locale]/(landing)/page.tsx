import {
  ArrowRight,
  BarChart3,
  Check,
  Code2,
  KeyRound,
  Wallet,
} from 'lucide-react';
import { setRequestLocale } from 'next-intl/server';

import { APIPOOL_PUBLIC_CONFIG } from '@/config/apipool';
import { AppLocale, normalizeLocale } from '@/config/locale';
import { Link } from '@/core/i18n/navigation';
import { Button } from '@/shared/components/ui/button';

export const revalidate = 3600;

type LocaleKey = AppLocale;

const homeCopy = {
  'zh-CN': {
    eyebrow: 'APIPool · 模型 API 服务',
    title: '一个账户，统一调用主流大模型 API。',
    lead: 'APIPool 是面向开发者和小团队的 API 门户：充值余额、创建 API Key、调用模型、查看用量和账单，都在一个地方完成。',
    primaryCta: '查看模型与价格',
    secondaryCta: '查看接入文档',
    facts: [
      { label: 'Base URL', value: APIPOOL_PUBLIC_CONFIG.apiBaseUrl },
      { label: '首发模型', value: APIPOOL_PUBLIC_CONFIG.defaultLaunchModel },
      { label: '计费方式', value: '按 Token 用量扣费' },
    ],
    introTitle: 'APIPool 做什么',
    introLead:
      '它不是复杂后台，也不是卡密站。它把模型调用需要的购买、密钥、余额、用量和日志整理成一个清楚的开发者入口。',
    features: [
      {
        icon: Wallet,
        title: '购买和余额',
        description: '充值后按真实模型用量扣费，余额和消费记录在控制台查看。',
      },
      {
        icon: KeyRound,
        title: 'API Key 管理',
        description: '创建、复制、停用和轮换密钥，减少凭据散落在不同项目里。',
      },
      {
        icon: BarChart3,
        title: '用量和日志',
        description: '查看请求、Token、费用和最近调用状态，方便排查问题。',
      },
    ],
    quickstartTitle: '怎么开始',
    quickstartLead: '确认模型价格后，创建账户并生成 Key；代码里只需要替换 Base URL 和模型名。',
    steps: ['查看模型与价格', '充值并创建 API Key', '替换 Base URL 后调用模型'],
    codeTitle: 'OpenAI 兼容调用',
  },
  'zh-TW': {
    eyebrow: 'APIPool · 模型 API 服務',
    title: '一個帳戶，統一調用主流大模型 API。',
    lead: 'APIPool 是面向開發者和小團隊的 API 門戶：儲值餘額、建立 API Key、調用模型、查看用量和帳單，都在一個地方完成。',
    primaryCta: '查看模型與價格',
    secondaryCta: '查看接入文件',
    facts: [
      { label: 'Base URL', value: APIPOOL_PUBLIC_CONFIG.apiBaseUrl },
      { label: '首發模型', value: APIPOOL_PUBLIC_CONFIG.defaultLaunchModel },
      { label: '計費方式', value: '按 Token 用量扣費' },
    ],
    introTitle: 'APIPool 做什麼',
    introLead:
      '它不是複雜後台，也不是卡密站。它把模型調用需要的購買、金鑰、餘額、用量和日誌整理成一個清楚的開發者入口。',
    features: [
      {
        icon: Wallet,
        title: '購買和餘額',
        description: '儲值後按真實模型用量扣費，餘額和消費記錄在控制台查看。',
      },
      {
        icon: KeyRound,
        title: 'API Key 管理',
        description: '建立、複製、停用和輪換金鑰，減少憑證散落在不同專案裡。',
      },
      {
        icon: BarChart3,
        title: '用量和日誌',
        description: '查看請求、Token、費用和最近調用狀態，方便排查問題。',
      },
    ],
    quickstartTitle: '怎麼開始',
    quickstartLead: '確認模型價格後，建立帳戶並產生 Key；代碼裡只需要替換 Base URL 和模型名。',
    steps: ['查看模型與價格', '儲值並建立 API Key', '替換 Base URL 後調用模型'],
    codeTitle: 'OpenAI 相容調用',
  },
  en: {
    eyebrow: 'APIPool · Model API service',
    title: 'One account for calling mainstream model APIs.',
    lead: 'APIPool is an API portal for developers and small teams: add credit, create API keys, call models, and review usage and billing in one place.',
    primaryCta: 'View models & pricing',
    secondaryCta: 'View docs',
    facts: [
      { label: 'Base URL', value: APIPOOL_PUBLIC_CONFIG.apiBaseUrl },
      { label: 'Launch model', value: APIPOOL_PUBLIC_CONFIG.defaultLaunchModel },
      { label: 'Billing', value: 'Token-based usage' },
    ],
    introTitle: 'What APIPool does',
    introLead:
      'It is not a complicated admin console or a voucher shop. It turns model API purchase, keys, balance, usage, and logs into a clear developer entry point.',
    features: [
      {
        icon: Wallet,
        title: 'Credit and balance',
        description: 'Top up credit and pay by real model usage, with balance and spend visible in the console.',
      },
      {
        icon: KeyRound,
        title: 'API key management',
        description: 'Create, copy, disable, and rotate keys so credentials do not spread across projects.',
      },
      {
        icon: BarChart3,
        title: 'Usage and logs',
        description: 'Review requests, tokens, cost, and recent call status when debugging issues.',
      },
    ],
    quickstartTitle: 'How to start',
    quickstartLead: 'Check model prices, create an account and key, then replace the Base URL and model name in your code.',
    steps: ['Review models and prices', 'Add credit and create a key', 'Replace Base URL and call a model'],
    codeTitle: 'OpenAI-compatible call',
  },
} satisfies Record<
  LocaleKey,
  {
    eyebrow: string;
    title: string;
    lead: string;
    primaryCta: string;
    secondaryCta: string;
    facts: Array<{ label: string; value: string }>;
    introTitle: string;
    introLead: string;
    features: Array<{
      icon: typeof Wallet;
      title: string;
      description: string;
    }>;
    quickstartTitle: string;
    quickstartLead: string;
    steps: string[];
    codeTitle: string;
  }
>;

function createCurlSnippet(model: string) {
  return `curl ${APIPOOL_PUBLIC_CONFIG.apiBaseUrl}/chat/completions \\
  -H "Authorization: Bearer $APIPOOL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{ "role": "user", "content": "Hello" }]
  }'`;
}

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const localeKey = normalizeLocale(locale);
  const copy = homeCopy[localeKey];
  const snippet = createCurlSnippet(APIPOOL_PUBLIC_CONFIG.defaultLaunchModel);

  return (
    <div className="bg-slate-50 text-slate-950">
      <section className="border-b border-slate-200 bg-white">
        <div className="mx-auto grid max-w-7xl items-center gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[1fr_0.86fr] lg:px-8 lg:py-24">
          <div>
            <div className="inline-flex rounded-full border border-blue-100 bg-blue-50 px-3 py-1 font-mono text-xs tracking-widest text-blue-700 uppercase">
              {copy.eyebrow}
            </div>
            <h1 className="mt-5 max-w-3xl text-4xl leading-tight font-semibold tracking-tight text-slate-950 sm:text-5xl">
              {copy.title}
            </h1>
            <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-600">
              {copy.lead}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button
                asChild
                size="lg"
                className="bg-orange-500 text-white hover:bg-orange-600"
              >
                <Link href="/models">
                  {copy.primaryCta}
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="border-slate-300 bg-white text-slate-800 hover:bg-slate-50"
              >
                <Link href="/docs">{copy.secondaryCta}</Link>
              </Button>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xl shadow-slate-200/60">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold">
              <Code2 className="size-4 text-blue-600" />
              {copy.codeTitle}
            </div>
            <pre className="overflow-x-auto rounded-xl bg-[#0a0a0a] p-4 font-mono text-xs leading-6 text-white/90">
              <code>{snippet}</code>
            </pre>
          </div>
        </div>
      </section>

      <section className="border-b border-slate-200 bg-slate-50">
        <div className="mx-auto grid max-w-7xl gap-3 px-4 py-5 sm:px-6 md:grid-cols-3 lg:px-8">
          {copy.facts.map((fact) => (
            <div
              key={fact.label}
              className="rounded-xl border border-slate-200 bg-white p-5"
            >
              <div className="text-xs text-slate-500">{fact.label}</div>
              <div className="mt-1 break-all font-mono text-sm font-medium text-slate-950">
                {fact.value}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="border-b border-slate-200 bg-white py-14 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-semibold tracking-tight text-slate-950">
              {copy.introTitle}
            </h2>
            <p className="mt-3 leading-7 text-slate-600">
              {copy.introLead}
            </p>
          </div>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {copy.features.map((feature) => (
              <div
                key={feature.title}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-5"
              >
                <div className="flex size-10 items-center justify-center rounded-xl bg-teal-50">
                  <feature.icon className="size-5 text-teal-700" />
                </div>
                <h3 className="mt-4 font-semibold text-slate-950">
                  {feature.title}
                </h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-14 sm:py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.8fr_1.2fr] lg:px-8">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight text-slate-950">
              {copy.quickstartTitle}
            </h2>
            <p className="mt-3 leading-7 text-slate-600">
              {copy.quickstartLead}
            </p>
          </div>
          <div className="grid gap-3">
            {copy.steps.map((step, index) => (
              <div
                key={step}
                className="flex gap-3 rounded-xl border border-slate-200 bg-white p-4"
              >
                <div className="font-mono text-sm text-blue-600">
                  {String(index + 1).padStart(2, '0')}
                </div>
                <div className="flex items-center gap-2 font-medium text-slate-950">
                  <Check className="size-4 text-teal-700" />
                  {step}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
