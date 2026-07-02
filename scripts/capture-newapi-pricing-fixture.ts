import { createNewApiClient } from '@/features/newapi-bridge/server/client';

async function main() {
  const snapshot = await createNewApiClient().getPricingSnapshot();

  process.stdout.write(
    `${JSON.stringify(
      {
        models: snapshot.models,
        vendors: snapshot.vendors,
        groupRatios: snapshot.groupRatios,
        usableGroups: snapshot.usableGroups,
        sourceFingerprint: snapshot.sourceFingerprint,
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
