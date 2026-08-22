// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
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
 * Access control for both routes is enforced by a Cloudflare Access
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
const UPDATE_FEED_RE = /^\/api\/update\/([^/]+)\/([^/]+)\/([^/]+)$/;
const CHANGELOG_RE = /^\/api\/changelog\/([^/]+)$/;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const updateMatch = url.pathname.match(UPDATE_FEED_RE);
		const changelogMatch = url.pathname.match(CHANGELOG_RE);

		if (!updateMatch && !changelogMatch) {
			return new Response('Not found', { status: 404 });
		}

		if (env.CF_ACCESS_AUD && !request.headers.get('Cf-Access-Jwt-Assertion')) {
			return new Response('Unauthorized', { status: 401 });
		}

		if (changelogMatch) {
			return serveChangelog(env, changelogMatch[1]);
		}

		return serveUpdateFeed(env, updateMatch!);
	}
} satisfies ExportedHandler<Env>;

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
