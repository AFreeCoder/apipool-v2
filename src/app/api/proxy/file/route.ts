import { disabledTemplateApiResponse } from '@/features/apipool-ui/lib/template-api';

export async function GET() {
  return disabledTemplateApiResponse();
}
