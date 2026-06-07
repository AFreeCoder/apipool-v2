import { withNoStore } from '@/shared/lib/http-cache';

export const TEMPLATE_API_DISABLED_MESSAGE =
  'This template API is disabled for APIPool MVP.';

export function disabledTemplateApiResponse() {
  return withNoStore(
    Response.json(
      {
        code: -1,
        message: TEMPLATE_API_DISABLED_MESSAGE,
      },
      { status: 404 }
    )
  );
}
