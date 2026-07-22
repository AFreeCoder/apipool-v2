import { runRuntimePoolMonitorOnce } from '@/features/gateway/server/runtime-pool';

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help')) {
    console.log(
      '用法：pnpm runtime-pool:check；确认后用 pnpm runtime-pool:replenish 执行低水位补充'
    );
    return;
  }
  const unknown = [...args].filter((arg) => arg !== '--apply');
  if (unknown.length > 0) {
    throw new Error(`未知参数：${unknown.join(', ')}`);
  }

  const apply = args.has('--apply');
  const result = await runRuntimePoolMonitorOnce({ apply });
  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'check',
        ...result,
      },
      null,
      2
    )
  );
  if (result.failed > 0) process.exitCode = 1;
  else if (!apply && result.uninitialized + result.low + result.depleted > 0) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
