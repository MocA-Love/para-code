/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Verifies the `Cf-Access-Jwt-Assertion` that Cloudflare Access adds to the
 * requests it lets through: RS256 signature against the team's published keys,
 * `aud` (the Access Application's AUD tag), `iss` (the team domain), `exp` and
 * `nbf`. Uses only WebCrypto so the worker keeps no runtime dependencies.
 *
 * See https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */

/** One RSA key of the team's `/cdn-cgi/access/certs` document. */
export interface IAccessJsonWebKey extends JsonWebKey {
	readonly kid?: string;
}

/** The part of the `/cdn-cgi/access/certs` document this verifier reads. */
export interface IAccessJsonWebKeySet {
	readonly keys: readonly IAccessJsonWebKey[];
}

/** Fetches the team's key set. Injectable so tests can serve their own keys. */
export type AccessCertsLoader = (url: string) => Promise<IAccessJsonWebKeySet>;

/** Allowed clock difference between Cloudflare and this worker, in seconds. */
const CLOCK_LEEWAY_SECONDS = 60;

/**
 * A token with an unknown `kid` makes the verifier fetch the key set again
 * (Access rotates its keys), but not more often than this, so made-up `kid`s
 * cannot turn every request into a fetch.
 */
const UNKNOWN_KID_REFETCH_INTERVAL_MS = 60_000;

async function defaultCertsLoader(url: string): Promise<IAccessJsonWebKeySet> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Access certs request failed with ${response.status}`);
	}
	return response.json<IAccessJsonWebKeySet>();
}

/**
 * Turns the configured team domain (`https://<team>.cloudflareaccess.com`,
 * with or without the scheme) into the `iss` value Access writes into its
 * tokens. Returns undefined for anything that is not a bare https origin.
 */
export function normalizeAccessTeamDomain(teamDomain: string): string | undefined {
	const trimmed = teamDomain.trim();
	if (!trimmed) {
		return undefined;
	}
	let url: URL;
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
	} catch {
		return undefined;
	}
	if (url.protocol !== 'https:' || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
		return undefined;
	}
	return url.origin;
}

function decodeBase64Url(value: string): Uint8Array {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function decodeJsonSegment(value: string): Record<string, unknown> | undefined {
	const parsed: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
	return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
}

/**
 * Checks Access JWTs for one team. Keeps the team's public keys between
 * requests (per worker isolate).
 */
export class AccessJwtVerifier {

	private readonly keys = new Map<string, Promise<CryptoKey>>();
	private loading: Promise<void> | undefined;
	private lastLoadAt: number | undefined;

	constructor(
		private readonly loadCerts: AccessCertsLoader = defaultCertsLoader,
		private readonly now: () => number = Date.now
	) { }

	/**
	 * Returns true only when `token` is a well-formed RS256 JWT signed by one
	 * of the team's keys, issued by `teamDomain` for `audience`, and inside its
	 * validity window. Any parsing, fetching or crypto failure returns false.
	 */
	async verify(token: string, audience: string, teamDomain: string): Promise<boolean> {
		const issuer = normalizeAccessTeamDomain(teamDomain);
		if (!issuer || !audience) {
			return false;
		}
		try {
			const segments = token.split('.');
			if (segments.length !== 3) {
				return false;
			}
			const [headerSegment, payloadSegment, signatureSegment] = segments;
			const header = decodeJsonSegment(headerSegment);
			const payload = decodeJsonSegment(payloadSegment);
			if (!header || !payload || header.alg !== 'RS256' || typeof header.kid !== 'string') {
				return false;
			}

			const key = await this.getKey(issuer, header.kid);
			if (!key) {
				return false;
			}
			const signed = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
			if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodeBase64Url(signatureSegment), signed)) {
				return false;
			}

			return this.checkClaims(payload, audience, issuer);
		} catch {
			return false;
		}
	}

	private checkClaims(payload: Record<string, unknown>, audience: string, issuer: string): boolean {
		const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
		if (!audiences.includes(audience)) {
			return false;
		}
		if (payload.iss !== issuer) {
			return false;
		}
		const nowSeconds = this.now() / 1000;
		if (typeof payload.exp !== 'number' || payload.exp + CLOCK_LEEWAY_SECONDS < nowSeconds) {
			return false;
		}
		if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf - CLOCK_LEEWAY_SECONDS > nowSeconds)) {
			return false;
		}
		return true;
	}

	private async getKey(issuer: string, kid: string): Promise<CryptoKey | undefined> {
		if (!this.keys.has(kid)) {
			const canRefetch = this.lastLoadAt === undefined || this.now() - this.lastLoadAt >= UNKNOWN_KID_REFETCH_INTERVAL_MS;
			if (this.loading) {
				await this.loading;
			} else if (canRefetch) {
				this.loading = this.loadKeys(issuer).finally(() => this.loading = undefined);
				await this.loading;
			}
		}
		return this.keys.get(kid);
	}

	private async loadKeys(issuer: string): Promise<void> {
		this.lastLoadAt = this.now();
		const jwks = await this.loadCerts(`${issuer}/cdn-cgi/access/certs`);
		this.keys.clear();
		for (const jwk of jwks.keys ?? []) {
			if (typeof jwk.kid !== 'string' || jwk.kty !== 'RSA') {
				continue;
			}
			const { kid, ...keyData } = jwk;
			const key = crypto.subtle.importKey('jwk', keyData, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
			// A key that fails to import must not reject callers asking for other keys.
			key.catch(() => undefined);
			this.keys.set(kid, key);
		}
	}
}
