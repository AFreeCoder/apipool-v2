import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const REQUIREMENTS_PATH = join(
  process.cwd(),
  'docs/08-user-mvp-requirements.md'
);
const REPORT_PATH = join(
  process.cwd(),
  'docs/test/user-mvp/2026-06-30-line-by-line-acceptance-report.md'
);

test('line-by-line user MVP acceptance report covers every requirements section', async () => {
  const requirements = await readFile(REQUIREMENTS_PATH, 'utf8');
  const report = await readFile(REPORT_PATH, 'utf8');

  const requiredSections = [
    '## 1. 版本目标',
    '## 2. 用户侧需求',
    '### 2.1 模型广场 `/models`',
    '### 2.2 登录注册',
    '### 2.3 控制台 `/dashboard`',
    '## 3. 管理员侧需求 `/admin`',
    '### 3.1 模型目录管理',
    '### 3.2 支付与额度运营',
    '### 3.3 登录与邮件配置',
    '## 4. 状态与错误处理基线',
    '### 4.1 API Key 管理范围',
    '### 4.2 支付与额度状态',
    '### 4.3 用量同步状态',
    '## 5. 验收标准',
    '## 6. 本版本明确不做',
    '## 7. 默认假设',
    '## 8. 12 个月方向，不进入 user-mvp',
  ];

  for (const section of requiredSections) {
    assert.match(requirements, new RegExp(escapeRegExp(section)));
  }

  const requiredLineRanges = [
    'L16-L18',
    'L20-L22',
    'L24-L31',
    'L35-L37',
    'L39-L45',
    'L49-L51',
    'L52',
    'L53-L55',
    'L56-L58',
    'L59',
    'L61-L65',
    'L67-L73',
    'L75-L82',
    'L83-L86',
    'L88-L98',
    'L100-L109',
    'L111-L119',
    'L121-L127',
    'L129-L138',
    'L140-L147',
    'L148-L152',
    'L154-L157',
    'L159-L167',
    'L169-L180',
    'L182-L188',
    'L190-L198',
    'L200-L210',
    'L212-L228',
    'L230-L236',
    'L238-L248',
    'L250-L260',
    'L262-L277',
    'L279-L290',
    'L292-L303',
    'L305-L309',
    'L311-L329',
    'L331-L343',
    'L345-L354',
  ];

  for (const range of requiredLineRanges) {
    assert.match(report, new RegExp(`\\| ${range} \\|`));
  }

  assert.match(report, /✅/);
  assert.match(report, /🟡/);
  assert.match(report, /⛔/);
  assert.match(report, /➖/);
  assert.doesNotMatch(report, /TODO|TBD|FIXME|待定/);
});

test('line-by-line user MVP acceptance report names required edge cases', async () => {
  const report = await readFile(REPORT_PATH, 'utf8');
  const edgeCases = [
    '同模型 ID 多分组独立售卖项',
    '未知筛选不回退全量',
    '禁用供应商/分组/分类/能力',
    '无 callable 模型分组',
    '完整 Key 只展示一次',
    '远端同步失败',
    '重复 webhook',
    '非 USD',
    '零金额',
    'reconciliation_required',
    'ready/empty/syncing/stale/failed',
    '刚好 5 分钟/2 小时',
    'OAuth',
    'Resend',
    '支付 Provider',
    'Google Fonts',
  ];

  for (const edgeCase of edgeCases) {
    assert.match(report, new RegExp(escapeRegExp(edgeCase)));
  }
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
