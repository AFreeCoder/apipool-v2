import { handleGatewayRequest } from '@/features/gateway/server/handler';

export const dynamic = 'force-dynamic';

type GatewayRouteContext = {
  params: Promise<{ path: string[] }>;
};

export async function GET(req: Request, context: GatewayRouteContext) {
  const { path } = await context.params;
  return handleGatewayRequest(req, path ?? []);
}

export async function POST(req: Request, context: GatewayRouteContext) {
  const { path } = await context.params;
  return handleGatewayRequest(req, path ?? []);
}
