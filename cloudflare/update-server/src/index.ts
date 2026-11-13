// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
import { AccessJwtVerifier, type AccessCertsLoader } from './accessJwt';
import type { Env, IReleaseRecord } from './types';

/**
 * Implements two feed contracts consumed by Para Code clients:
 *
 *   GET /api/update/:platform/:quality/:commit
 *
 * Response: 204 when the client is already on the latest known commit (or
 * the platform/quality pair has no published release yet); otherwise 200
 * with an IUpdate JSON body ({ url, version, productVersion, timestamp,
 * sha256hash }) plus the `name` / `notes` pair that Squirrel.Mac reads on
 * macOS. The client treats any other shape as "no update".
 *
 *   GET /api/changelog/:quality
 *
 * Response: 200 with the full app changelog (`paradisChangelog.md`) as
 * text/markdown, or 204 when nothing has been published yet. Consumed by the
 * in-app changelog modal (src/vs/paradis/contrib/releaseNotes/) so users can
 * read what a newer version changes before installing it. Written by the
 * release CI next to the per-platform records (see para-release.yml).
 *
 * Access control for the update feed is enforced by a Cloudflare Access
 * Application (Service Auth, non-interactive) configured separately in the
 * Zero Trust dashboard, scoped to the `/api/update` path. The changelog route
 * is outside that Application on purpose and is readable without credentials
 * (it carries the same text that ships inside every build).
 *
 * As defense in depth, when CF_ACCESS_AUD and CF_ACCESS_TEAM_DOMAIN are both
 * set, the worker also verifies the `Cf-Access-Jwt-Assertion` on the update
 * feed (RS256 signature against the team's keys, `aud`, `iss`, `exp`, `nbf`;
 * see accessJwt.ts), so a detached or misconfigured Access Application does
 * not silently open the feed. CF_ACCESS_AUD without a team domain denies every
 * update-feed request instead of falling back to a presence check.
 *
 * Release artifacts themselves are NOT served by this worker — `url` points
 * directly at a public R2 object under an unguessable, commit-scoped path
 * (bucket listing must stay disabled). This keeps asset downloads reachable
 * without the Access headers, which macOS's Squirrel.Mac updater does not
 * forward from the feed request to the asset download.
 *
 * Setup (already deployed: the RELEASES KV namespace id and the route are in
 * wrangler.toml). To recreate it, see the NOTES.md release-infra section:
 *   wrangler kv namespace create RELEASES        # then paste the id into wrangler.toml
 *   wrangler deploy
 *   wrangler kv key put --binding RELEASES "stable:darwin-arm64" '{"commit":"...","version":"...","productVersion":"...","url":"https://.../CodeSetup.zip","sha256hash":"...","timestamp":0}'
 */
const UPDATE_FEED_RE = /^\/api\/update\/([^/]+)\/([^/]+)\/([^/]+)$/;
const CHANGELOG_RE = /^\/api\/changelog\/([^/]+)$/;

// The update feed is fetched from the main process (Squirrel.Mac / the native
// updaters), which never applies CORS. The changelog feed is fetched from the
// renderer's IRequestService instead (see paradisReleaseNotes.contribution.ts),
// which is a real fetch() and so is subject to it. Without these headers the
// preflight OPTIONS request has no Access-Control-Allow-Origin to read, and
// Chromium fails the whole request client-side before this worker's 200 ever
// reaches the caller — the changelog modal then silently falls back to the
// bundled markdown forever. The renderer always runs under the
// `vscode-file://vscode-app` origin (Schemas.vscodeFileResource +
// VSCODE_AUTHORITY in src/vs/base/common/network.ts), so only that origin is
// allowed; other web pages cannot read the responses.
const RENDERER_ORIGIN = 'vscode-file://vscode-app';

const COMMON_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': RENDERER_ORIGIN,
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Cf-Access-Client-Id, Cf-Access-Client-Secret',
	'X-Content-Type-Options': 'nosniff'
};

function withCommonHeaders(response: Response): Response {
	const headers = new Headers(response.headers);
	for (const [key, value] of Object.entries(COMMON_HEADERS)) {
		headers.set(key, value);
	}
	return new Response(response.body, { status: response.status, headers });
}

/** Dependencies the worker reaches outside itself; tests replace them. */
export interface IUpdateWorkerOptions {
	readonly loadAccessCerts?: AccessCertsLoader;
	readonly now?: () => number;
}

async function isUpdateFeedRequestAllowed(request: Request, env: Env, verifier: AccessJwtVerifier): Promise<boolean> {
	if (!env.CF_ACCESS_AUD) {
		return true;
	}
	const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
	if (!assertion || !env.CF_ACCESS_TEAM_DOMAIN) {
		return false;
	}
	return verifier.verify(assertion, env.CF_ACCESS_AUD, env.CF_ACCESS_TEAM_DOMAIN);
}

/** Creates the worker; each instance keeps its own cache of the Access keys. */
export function createUpdateWorker(options: IUpdateWorkerOptions = {}): { fetch(request: Request, env: Env): Promise<Response> } {
	const verifier = new AccessJwtVerifier(options.loadAccessCerts, options.now);
	return {
		async fetch(request: Request, env: Env): Promise<Response> {
			if (request.method === 'OPTIONS') {
				return new Response(null, { status: 204, headers: COMMON_HEADERS });
			}

			const url = new URL(request.url);
			const updateMatch = url.pathname.match(UPDATE_FEED_RE);
			const changelogMatch = url.pathname.match(CHANGELOG_RE);

			if (changelogMatch) {
				return withCommonHeaders(await serveChangelog(env, changelogMatch[1]));
			}

			if (!updateMatch) {
				return withCommonHeaders(new Response('Not found', { status: 404 }));
			}

			if (!await isUpdateFeedRequestAllowed(request, env, verifier)) {
				return withCommonHeaders(new Response('Unauthorized', { status: 401 }));
			}

			return withCommonHeaders(await serveUpdateFeed(env, updateMatch));
		}
	} satisfies ExportedHandler<Env>;
}

export default createUpdateWorker();

async function serveChangelog(env: Env, quality: string): Promise<Response> {
	const markdown = await env.RELEASES.get(`changelog:${quality}`);

	if (!markdown) {
		return new Response(null, { status: 204 });
	}

	return new Response(markdown, {
		headers: {
			'Content-Type': 'text/markdown; charset=utf-8',
			// 更新はリリース時の KV 書き込みでのみ起こるので、キャッシュは再検証まで
			'Cache-Control': 'no-cache'
		}
	});
}

async function serveUpdateFeed(env: Env, match: RegExpMatchArray): Promise<Response> {
	const [, platform, quality, commit] = match;
	const record = await env.RELEASES.get<IReleaseRecord>(`${quality}:${platform}`, 'json');

	if (!record || record.commit === commit) {
		return new Response(null, { status: 204 });
	}

	// The Windows updater uses IUpdate.version as a build-specific cache key.
	// Keep the native updaters on their existing semantic-version contract.
	const updateVersion = platform.startsWith('win32-') ? record.commit : record.version;

	// macOS never parses this JSON itself: Squirrel.Mac reads only `notes` and
	// `name` and hands them to Electron's `update-downloaded` event, which the
	// client stores as IUpdate.version and IUpdate.productVersion respectively.
	// The commit therefore has to travel in `notes` — without it the pending
	// update carries an empty version, and the client's periodic "is the pending
	// update still the latest?" re-check bails out on that empty value, pinning
	// macOS to whichever build it downloaded first until the app is restarted.
	// Windows and Linux parse the payload themselves and ignore both fields.
	return Response.json({
		url: record.url,
		name: record.productVersion,
		notes: record.commit,
		version: updateVersion,
		productVersion: record.productVersion,
		timestamp: record.timestamp,
		sha256hash: record.sha256hash
	});
}
