'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

// 终端配色仅用于深底代码块（设计规范允许的唯一硬编码色例外区）。
const C = {
  g: '#c8d3ce', // 默认前景
  s: '#86efac', // 字符串（绿）
  k: '#f0a4bd', // 关键字（粉）
  f: '#5eead4', // 函数（青）
  c: '#5b6b64', // 注释/静音
} as const;

type Tab = 'curl' | 'python' | 'node';
type Token = { t: string; c: string };

const TABS: { id: Tab; label: string }[] = [
  { id: 'curl', label: 'cURL' },
  { id: 'python', label: 'Python' },
  { id: 'node', label: 'Node' },
];

function buildTokens(
  tab: Tab,
  { baseUrl, model, apiKey }: { baseUrl: string; model: string; apiKey: string }
): Token[] {
  if (tab === 'python') {
    return [
      { t: 'from', c: C.k },
      { t: ' openai ', c: C.g },
      { t: 'import', c: C.k },
      { t: ' OpenAI\n', c: C.g },
      { t: 'client = ', c: C.g },
      { t: 'OpenAI', c: C.f },
      { t: '(base_url=', c: C.g },
      { t: `"${baseUrl}"`, c: C.s },
      { t: ', api_key=', c: C.g },
      { t: `"${apiKey}"`, c: C.s },
      { t: ')\n', c: C.g },
      { t: 'resp = client.chat.completions.', c: C.g },
      { t: 'create', c: C.f },
      { t: '(\n    model=', c: C.g },
      { t: `"${model}"`, c: C.s },
      { t: ',\n    messages=[{', c: C.g },
      { t: '"role"', c: C.s },
      { t: ': ', c: C.g },
      { t: '"user"', c: C.s },
      { t: ', ', c: C.g },
      { t: '"content"', c: C.s },
      { t: ': ', c: C.g },
      { t: '"Hello!"', c: C.s },
      { t: '}])\n', c: C.g },
      { t: 'print', c: C.f },
      { t: '(resp.choices[0].message.content)', c: C.g },
    ];
  }
  if (tab === 'node') {
    return [
      { t: 'import', c: C.k },
      { t: ' OpenAI ', c: C.g },
      { t: 'from', c: C.k },
      { t: ' ', c: C.g },
      { t: '"openai"', c: C.s },
      { t: ';\n', c: C.g },
      { t: 'const', c: C.k },
      { t: ' client = ', c: C.g },
      { t: 'new', c: C.k },
      { t: ' ', c: C.g },
      { t: 'OpenAI', c: C.f },
      { t: '({ baseURL: ', c: C.g },
      { t: `"${baseUrl}"`, c: C.s },
      { t: ', apiKey: ', c: C.g },
      { t: `"${apiKey}"`, c: C.s },
      { t: ' });\n', c: C.g },
      { t: 'const', c: C.k },
      { t: ' resp = ', c: C.g },
      { t: 'await', c: C.k },
      { t: ' client.chat.completions.', c: C.g },
      { t: 'create', c: C.f },
      { t: '({\n  model: ', c: C.g },
      { t: `"${model}"`, c: C.s },
      { t: ',\n  messages: [{ role: ', c: C.g },
      { t: '"user"', c: C.s },
      { t: ', content: ', c: C.g },
      { t: '"Hello!"', c: C.s },
      { t: ' }],\n});', c: C.g },
    ];
  }
  return [
    { t: 'curl', c: C.f },
    { t: ` ${baseUrl}/chat/completions \\\n  -H `, c: C.g },
    { t: `"Authorization: Bearer ${apiKey}"`, c: C.s },
    { t: ' \\\n  -H ', c: C.g },
    { t: '"Content-Type: application/json"', c: C.s },
    { t: ' \\\n  -d ', c: C.g },
    {
      t: `'{"model":"${model}",\n       "messages":[{"role":"user","content":"Hello!"}]}'`,
      c: C.s,
    },
  ];
}

export function HeroTerminal({
  apiBaseUrl,
  model,
}: {
  apiBaseUrl: string;
  model: string;
}) {
  const [tab, setTab] = useState<Tab>('curl');
  const [typed, setTyped] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const apiKey = 'sk-...9f2a';
  // apiBaseUrl 可能已带 /v1（如本地环境），也可能不带（默认站点域名）；
  // 统一规范化为恰好一个 /v1 结尾，避免出现 /v1/v1。
  const trimmedBase = apiBaseUrl.replace(/\/+$/, '');
  const baseUrl = trimmedBase.endsWith('/v1')
    ? trimmedBase
    : `${trimmedBase}/v1`;
  const tokens = buildTokens(tab, { baseUrl, model, apiKey });
  const total = tokens.reduce((n, tk) => n + tk.t.length, 0);

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      setTyped(total);
      return;
    }
    setTyped(0);
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => {
      setTyped((prev) => {
        const next = prev + 2;
        if (next >= total) {
          if (timer.current) clearInterval(timer.current);
          return total;
        }
        return next;
      });
    }, 26);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [tab, total]);

  // 按已输入字符数逐 token 截取
  const spans: ReactNode[] = [];
  let remaining = typed;
  for (let i = 0; i < tokens.length; i += 1) {
    if (remaining <= 0) break;
    const tk = tokens[i];
    spans.push(
      <span key={i} style={{ color: tk.c }}>
        {tk.t.slice(0, remaining)}
      </span>
    );
    remaining -= tk.t.length;
  }

  return (
    <div className="relative">
      <div
        aria-hidden
        className="bg-primary/15 absolute -inset-3 rounded-2xl blur-2xl"
      />
      <div className="relative overflow-hidden rounded-xl border border-white/10 bg-[#0b0d0c] shadow-2xl">
        {/* 标题栏 */}
        <div className="flex items-center gap-2.5 border-b border-white/[0.07] bg-[#0e120f] px-4 py-3">
          <span className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-[#ff5f57]" />
            <span className="size-2.5 rounded-full bg-[#febc2e]" />
            <span className="size-2.5 rounded-full bg-[#28c840]" />
          </span>
          <span className="ml-1 font-mono text-xs text-white/40">
            quickstart
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-[#2e8269]/40 bg-[#2e8269]/15 px-2.5 py-1 font-mono text-[11px] text-[#cfe0d8]">
            <span className="size-1.5 rounded-full bg-[#4ade80] shadow-[0_0_8px_#4ade80]" />
            {model}
          </span>
        </div>
        {/* 标签页 */}
        <div className="flex gap-0.5 border-b border-white/[0.07] px-2.5 pt-2">
          {TABS.map((t) => {
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={
                  'border-0 border-b-2 bg-transparent px-4 py-2 font-mono text-[12.5px] transition-colors ' +
                  (active
                    ? 'border-[#4ade80] text-white'
                    : 'border-transparent text-white/45 hover:text-white/75')
                }
              >
                {t.label}
              </button>
            );
          })}
        </div>
        {/* 代码区 */}
        <pre className="m-0 h-[188px] overflow-hidden px-5 py-5 font-mono text-[13px] leading-[1.8] [overflow-wrap:anywhere] whitespace-pre-wrap">
          <code>
            {spans}
            <span
              aria-hidden
              className="ml-px inline-block h-[15px] w-[7px] translate-y-[2px] animate-pulse bg-[#4ade80]"
            />
          </code>
        </pre>
      </div>
    </div>
  );
}
