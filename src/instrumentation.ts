export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.GATEWAY_JOBS_ENABLED === 'false') return;
  const { startGatewayJobs } = await import('@/features/gateway/server/jobs');
  startGatewayJobs();
}
