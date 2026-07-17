import { getVendorById } from '@/features/api-catalog/server/catalog-service';
import { filterModelPricingCandidates } from '@/features/api-catalog/server/model-candidate-search';
import { createNewApiClient } from '@/features/newapi-bridge/server/client';

import { PERMISSIONS } from '@/core/rbac';
import { withNoStore } from '@/shared/lib/http-cache';
import { respData, respErr } from '@/shared/lib/resp';
import { getUserInfo } from '@/shared/models/user';
import { hasPermission } from '@/shared/services/rbac';

export const dynamic = 'force-dynamic';

const MAX_RESULTS = 20;

export async function GET(req: Request) {
  try {
    const operator = await getUserInfo();
    if (!operator) return withNoStore(respErr('no auth, please sign in'));

    const allowed = await hasPermission(operator.id, PERMISSIONS.CATALOG_WRITE);
    if (!allowed) {
      return withNoStore(respErr('Model catalog write permission required'));
    }

    const url = new URL(req.url);
    const keyword = (url.searchParams.get('keyword') || '').trim();
    const localVendorId = (url.searchParams.get('vendorId') || '').trim();
    const vendor = localVendorId ? await getVendorById(localVendorId) : null;

    const pricing = await createNewApiClient().listPricingModels();
    const models = filterModelPricingCandidates({
      pricing,
      keyword,
      localVendorId,
      vendor: vendor ?? null,
      limit: MAX_RESULTS,
    }).map((model) => ({
      modelId: model.modelId,
      displayName: model.displayName,
      vendorId: vendor?.id ?? model.vendorId,
      vendorSlug: model.vendorId,
      vendorName: vendor?.name ?? model.vendorName,
      source: model.source,
      inputMicroUsd: model.inputMicroUsd,
      outputMicroUsd: model.outputMicroUsd,
      imageInputMicroUsd: model.imageInputMicroUsd,
      imageOutputMicroUsd: model.imageOutputMicroUsd,
      supportedEndpointTypes: model.supportedEndpointTypes,
    }));

    return withNoStore(respData({ models }));
  } catch {
    return withNoStore(respErr('Model pricing candidates are unavailable'));
  }
}
