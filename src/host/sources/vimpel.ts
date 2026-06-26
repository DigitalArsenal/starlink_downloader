/**
 * JSC Vimpel space-object catalog (http://spacedata.vimpel.ru) — login required.
 *
 * Independent Russian catalog (GEO/HEO debris bulletins), an alternative to the
 * US 18 SDS catalog. The portal is a Drupal 7 site gated behind registration +
 * login; there is no anonymous file. Register manually at
 * `/ru/user/register` (CAPTCHA + approval), then set `VIMPEL_IDENTITY` /
 * `VIMPEL_PASSWORD` in `.env`. Without them this source is inert.
 *
 * Discovery: GET the login page (scrape `form_build_id`), POST the Drupal login
 * form, capture the `SESS…` session cookie, and return the `/data_provider`
 * catalog page as a cookie-authenticated resource. HTTP only (the portal's TLS
 * cert is dead) — `VIMPEL_BASE_URL` stays `http://…`.
 */
import type { DiscoveredResource } from '../types.js';
import type { EphemerisSource, SourceContext } from './index.js';
import { vimpelCredentials } from '../env.js';
import { childLogger } from '../logger.js';

const log = childLogger({ component: 'source:vimpel' });

function extractCookie(headers: Record<string, string>): string | null {
  const raw = headers['set-cookie'] ?? headers['Set-Cookie'];
  if (!raw) return null;
  // Vimpel sets a Drupal `SESS<hash>` cookie; keep the first cookie pair.
  const pair = raw.split(/,(?=[^;]+=)/).find((c) => /SESS[0-9a-f]+=/i.test(c)) ?? raw;
  return pair.split(';')[0]?.trim() ?? null;
}

function scrapeFormBuildId(html: string): string | null {
  return (
    html.match(/name="form_build_id"[^>]*value="([^"]+)"/i)?.[1] ??
    html.match(/value="([^"]+)"[^>]*name="form_build_id"/i)?.[1] ??
    null
  );
}

export const vimpelSource: EphemerisSource = {
  id: 'vimpel',
  name: 'JSC Vimpel catalog (login)',
  operator: 'JSC MAK Vimpel',
  parserTag: 'vimpel',
  contentExt: 'html',
  host: 'spacedata.vimpel.ru',

  async discover(ctx: SourceContext): Promise<DiscoveredResource[]> {
    const creds = vimpelCredentials();
    if (!creds) {
      log.warn('VIMPEL_IDENTITY/PASSWORD not set — skipping Vimpel (register at /ru/user/register)');
      return [];
    }

    const loginUrl = `${creds.baseUrl}/ru/user/login`;
    const page = await ctx.http.getText(loginUrl);
    const formBuildId = scrapeFormBuildId(page);
    if (!formBuildId) throw new Error('Vimpel login: could not find form_build_id');

    const body =
      `name=${encodeURIComponent(creds.identity)}` +
      `&pass=${encodeURIComponent(creds.password)}` +
      `&form_id=user_login` +
      `&op=${encodeURIComponent('Войти')}` +
      `&form_build_id=${encodeURIComponent(formBuildId)}`;
    const loginRes = await ctx.http.post(loginUrl, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const cookie = extractCookie(loginRes.headers);
    if (!cookie) {
      throw new Error('Vimpel login returned no session cookie (check credentials / redirect handling)');
    }

    return [
      {
        id: 'data_provider.html',
        url: `${creds.baseUrl}/data_provider`,
        noradId: null,
        ext: 'html',
        headers: { Cookie: cookie },
        hints: { satelliteName: 'Vimpel catalog (GEO/HEO)' },
      },
    ];
  },
};
