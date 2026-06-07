export function withNoStore(response: Response) {
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}
