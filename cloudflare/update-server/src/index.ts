// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
import type { Env, IReleaseRecord } from './types';

/**
 * Implements the update feed contract expected by
 * src/vs/platform/update/electron-main/abstractUpdateService.ts:
 *
 *   GET /api/update/:platform/:quality/:commit
 *
 * Response: 204 when the client is already on the latest known commit (or
 * the platform/quality pair has no published release yet); otherwise 200
 * with an IUpdate JSON body ({ url, version, productVersion, timestamp,
 * sha256hash }). The client treats any other shape as "no update".
 *
 * Access control for this route is enforced by a Cloudflare Access
 * Application (Service Auth, non-interactive) configured separately in the
 * Zero Trust dashboard — this worker should never see unauthenticated
 * traffic in production. The CF_ACCESS_AUD check below is defense in depth
 * only; it does not verify the JWT signature, it only checks presence.
 *
 * Release artifacts themselves are NOT served by this worker — `url` points
 * directly at a public R2 object under an unguessable, commit-scoped path
 * (bucket listing must stay disabled). This keeps asset downloads reachable
 * without the Access headers, which macOS's Squirrel.Mac updater does not
 * forward from the feed request to the asset download.
 *
 * Setup (not yet done — run only after explicit go-ahead, see CLAUDE.md /
 * NOTES.md release-infra section):
 *   wrangler kv namespace create RELEASES        # then paste the id into wrangler.toml
 *   wrangler deploy
 *   wrangler kv key put --binding RELEASES "stable:darwin-arm64" '{"commit":"...","version":"...","productVersion":"...","url":"https://.../CodeSetup.zip","sha256hash":"...","timestamp":0}'
 */
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const match = url.pathname.match(/^\/api\/update\/([^/]+)\/([^/]+)\/([^/]+)$/);

		if (!match) {
			return new Response('Not found', { status: 404 });
		}

		if (env.CF_ACCESS_AUD && !request.headers.get('Cf-Access-Jwt-Assertion')) {
			return new Response('Unauthorized', { status: 401 });
		}

		const [, platform, quality, commit] = match;
		const record = await env.RELEASES.get<IReleaseRecord>(`${quality}:${platform}`, 'json');

		if (!record || record.commit === commit) {
			return new Response(null, { status: 204 });
		}

		return Response.json({
			url: record.url,
			name: `${platform}-${record.version}`,
			version: record.version,
			productVersion: record.productVersion,
			timestamp: record.timestamp,
			sha256hash: record.sha256hash
		});
	}
} satisfies ExportedHandler<Env>;
