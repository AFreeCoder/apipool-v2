import 'server-only';

import { getCallableModelIds } from './routing';

export async function buildModelsResponse(
  keyRow: { groupId: string },
  portalRequestId: string
): Promise<Response> {
  const modelIds = await getCallableModelIds(keyRow.groupId);
  return new Response(
    JSON.stringify({
      object: 'list',
      data: modelIds.map((id) => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'apipool',
      })),
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-apipool-request-id': portalRequestId,
      },
    }
  );
}
