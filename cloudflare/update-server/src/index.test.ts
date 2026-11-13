/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestSigningKey, keySetOf, signTestToken, TEST_AUDIENCE, TEST_NOW_MS, TEST_TEAM_DOMAIN, type ITestSigningKey } from './accessJwtTestUtils';
import defaultWorker, { createUpdateWorker } from './index';
import type { Env, IReleaseRecord } from './types';

let teamKey: ITestSigningKey;

beforeAll(async () => {
	teamKey = await createTestSigningKey('team-key');
});

const worker = createUpdateWorker({ loadAccessCerts: async () => keySetOf(teamKey), now: () => TEST_NOW_MS });

const publishedRelease: IReleaseRecord = {
	commit: '0123456789abcdef',
	version: '1.104.2',
	productVersion: '1.104.2 Para Code',
	url: 'https://downloads.para-code.dev/0123456789abcdef/ParaCode.zip',
	sha256hash: '8a67ff5aeab88d89adad6e792d3eb35f65c11cbb42a17f707e6261179a711a30',
	timestamp: 1785294000000
};

interface TestEnv {
	readonly RELEASES: {
		get(key: string, type?: 'json'): Promise<IReleaseRecord | string | null>;
	};
	readonly CF_ACCESS_AUD?: string;
	readonly CF_ACCESS_TEAM_DOMAIN?: string;
}

function createEnv(record: IReleaseRecord | null, changelogMd: string | null = null, cfAccessAudience?: string, cfAccessTeamDomain: string | null = TEST_TEAM_DOMAIN) {
	const get = vi.fn(async (key: string, type?: 'json') =>
		type === 'json' ? record : changelogMd
	);
	const env: TestEnv = {
		RELEASES: { get },
		...(cfAccessAudience ? { CF_ACCESS_AUD: cfAccessAudience } : {}),
		...(cfAccessAudience && cfAccessTeamDomain ? { CF_ACCESS_TEAM_DOMAIN: cfAccessTeamDomain } : {})
	};

	return { env, get };
}

function fetchUpdate(path: string, env: TestEnv, headers?: HeadersInit): Promise<Response> {
	return worker.fetch(
		new Request(`https://updates.para-code.dev${path}`, { headers }),
		env as Env
	);
}

describe('update feed', () => {
	it('returns 404 for paths outside the update feed route', async () => {
		const { env } = createEnv(null);

		const response = await fetchUpdate('/health', env);

		expect(response.status).toBe(404);
		expect(await response.text()).toBe('Not found');
	});

	it('returns 401 when Cloudflare Access is configured and the assertion is missing', async () => {
		const { env, get } = createEnv(publishedRelease, null, TEST_AUDIENCE);

		const response = await fetchUpdate('/api/update/darwin-arm64/stable/old-commit', env);

		expect(response.status).toBe(401);
		expect(await response.text()).toBe('Unauthorized');
		expect(get).not.toHaveBeenCalled();
	});

	it('returns 200 when the Cloudflare Access assertion is signed by the team for this audience', async () => {
		const { env } = createEnv(publishedRelease, null, TEST_AUDIENCE);

		const response = await fetchUpdate(
			'/api/update/darwin-arm64/stable/old-commit',
			env,
			{ 'Cf-Access-Jwt-Assertion': await signTestToken(teamKey) }
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ version: '1.104.2' });
	});

	it('returns 401 when the Cloudflare Access assertion is present but does not verify', async () => {
		const { env, get } = createEnv(publishedRelease, null, TEST_AUDIENCE);

		const statuses = [
			(await fetchUpdate('/api/update/darwin-arm64/stable/old-commit', env, { 'Cf-Access-Jwt-Assertion': 'signed-service-token' })).status,
			(await fetchUpdate('/api/update/darwin-arm64/stable/old-commit', env, { 'Cf-Access-Jwt-Assertion': await signTestToken(teamKey, { aud: ['another-app'] }) })).status
		];

		expect({ statuses, kvReads: get.mock.calls.length }).toEqual({ statuses: [401, 401], kvReads: 0 });
	});

	it('returns 401 for every update request when the audience is set without a team domain', async () => {
		const { env, get } = createEnv(publishedRelease, null, TEST_AUDIENCE, null);

		const response = await fetchUpdate(
			'/api/update/darwin-arm64/stable/old-commit',
			env,
			{ 'Cf-Access-Jwt-Assertion': await signTestToken(teamKey) }
		);

		expect({ status: response.status, kvReads: get.mock.calls.length }).toEqual({ status: 401, kvReads: 0 });
	});

	it('returns 204 when no release is published for the platform and quality', async () => {
		const { env } = createEnv(null);

		const response = await fetchUpdate('/api/update/linux-x64/stable/current-commit', env);

		expect(response.status).toBe(204);
		expect(await response.text()).toBe('');
	});

	it('returns 204 when the client commit is already current', async () => {
		const { env } = createEnv(publishedRelease);

		const response = await fetchUpdate(
			'/api/update/darwin-arm64/stable/0123456789abcdef',
			env
		);

		expect(response.status).toBe(204);
		expect(await response.text()).toBe('');
	});

	it('reads the release using the quality and platform KV key', async () => {
		const { env, get } = createEnv(publishedRelease);

		const response = await fetchUpdate(
			'/api/update/darwin-arm64/insider/previous-commit',
			env
		);

		expect(response.status).toBe(200);
		expect(get).toHaveBeenCalledOnce();
		expect(get).toHaveBeenCalledWith('insider:darwin-arm64', 'json');
	});

	it('uses the commit as the Windows update version and returns the feed metadata', async () => {
		const { env } = createEnv(publishedRelease);

		const response = await fetchUpdate('/api/update/win32-x64/stable/previous-commit', env);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			url: 'https://downloads.para-code.dev/0123456789abcdef/ParaCode.zip',
			name: '1.104.2 Para Code',
			notes: '0123456789abcdef',
			version: '0123456789abcdef',
			productVersion: '1.104.2 Para Code',
			timestamp: 1785294000000,
			sha256hash: '8a67ff5aeab88d89adad6e792d3eb35f65c11cbb42a17f707e6261179a711a30'
		});
	});

	it('uses the semantic version for Linux updates', async () => {
		const { env } = createEnv(publishedRelease);

		const response = await fetchUpdate('/api/update/linux-x64/stable/previous-commit', env);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ version: '1.104.2' });
	});

	it('uses the semantic version for macOS updates and returns the feed metadata', async () => {
		const { env } = createEnv(publishedRelease);

		const response = await fetchUpdate('/api/update/darwin-arm64/stable/previous-commit', env);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			url: 'https://downloads.para-code.dev/0123456789abcdef/ParaCode.zip',
			name: '1.104.2 Para Code',
			notes: '0123456789abcdef',
			version: '1.104.2',
			productVersion: '1.104.2 Para Code',
			timestamp: 1785294000000,
			sha256hash: '8a67ff5aeab88d89adad6e792d3eb35f65c11cbb42a17f707e6261179a711a30'
		});
	});
});

describe('changelog feed', () => {
	const changelogMd = '# Para Code 更新履歴\n\n## paracode-123（2026-08-22）\n';

	function fetchChangelog(path: string, env: TestEnv, headers?: HeadersInit): Promise<Response> {
		return worker.fetch(
			new Request(`https://updates.para-code.dev${path}`, { headers }),
			env as Env
		);
	}

	it('returns the published changelog as text/markdown', async () => {
		const { env, get } = createEnv(publishedRelease, changelogMd);

		const response = await fetchChangelog('/api/changelog/stable', env);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/markdown');
		expect(await response.text()).toBe(changelogMd);
		expect(get).toHaveBeenCalledWith('changelog:stable');
	});

	it('returns 204 when no changelog has been published yet', async () => {
		const { env } = createEnv(publishedRelease, null);

		const response = await fetchChangelog('/api/changelog/stable', env);

		expect(response.status).toBe(204);
		expect(await response.text()).toBe('');
	});

	// The Access Application covers /api/update only; the changelog is public.
	it('stays readable without an assertion when Cloudflare Access is configured', async () => {
		const { env } = createEnv(publishedRelease, changelogMd, TEST_AUDIENCE);

		const response = await fetchChangelog('/api/changelog/stable', env);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(changelogMd);
	});

	it('serves different qualities under separate KV keys', async () => {
		const { env, get } = createEnv(null, changelogMd);

		await fetchChangelog('/api/changelog/insider', env);

		expect(get).toHaveBeenCalledWith('changelog:insider');
	});
});

describe('CORS', () => {
	// The changelog modal fetches this feed from the renderer with a real
	// fetch(), which sends a preflight OPTIONS request. Without an
	// Access-Control-Allow-Origin on both the preflight and the actual
	// response, Chromium fails the request client-side and the modal never
	// sees the 200 the worker sent — this is what silently broke it.
	it('answers a changelog preflight with the headers the browser checks', async () => {
		const { env } = createEnv(null, null);

		const response = await worker.fetch(
			new Request('https://updates.para-code.dev/api/changelog/stable', { method: 'OPTIONS' }),
			env as Env
		);

		expect(response.status).toBe(204);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('vscode-file://vscode-app');
		expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Cf-Access-Client-Id');
	});

	it('answers an update-feed preflight the same way', async () => {
		const { env } = createEnv(null);

		const response = await worker.fetch(
			new Request('https://updates.para-code.dev/api/update/darwin-arm64/stable/old-commit', { method: 'OPTIONS' }),
			env as Env
		);

		expect(response.status).toBe(204);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('vscode-file://vscode-app');
	});

	it('stamps the actual changelog response with Access-Control-Allow-Origin too', async () => {
		const { env } = createEnv(publishedRelease, '# changelog\n');

		const response = await worker.fetch(
			new Request('https://updates.para-code.dev/api/changelog/stable'),
			env as Env
		);

		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('vscode-file://vscode-app');
	});

	it('stamps error responses (404/401) as well, since those are still read by the browser', async () => {
		const { env } = createEnv(publishedRelease, '# changelog\n', TEST_AUDIENCE);

		const notFound = await worker.fetch(new Request('https://updates.para-code.dev/health'), env as Env);
		expect(notFound.headers.get('Access-Control-Allow-Origin')).toBe('vscode-file://vscode-app');

		const unauthorized = await worker.fetch(
			new Request('https://updates.para-code.dev/api/update/darwin-arm64/stable/old-commit'),
			env as Env
		);
		expect(unauthorized.status).toBe(401);
		expect(unauthorized.headers.get('Access-Control-Allow-Origin')).toBe('vscode-file://vscode-app');
	});
});

describe('response headers', () => {
	it('sends nosniff on every kind of response', async () => {
		const { env } = createEnv(publishedRelease, '# changelog\n', TEST_AUDIENCE);
		const requests = [
			new Request('https://updates.para-code.dev/api/changelog/stable', { method: 'OPTIONS' }),
			new Request('https://updates.para-code.dev/api/changelog/stable'),
			new Request('https://updates.para-code.dev/api/update/darwin-arm64/stable/old-commit', { headers: { 'Cf-Access-Jwt-Assertion': await signTestToken(teamKey) } }),
			new Request('https://updates.para-code.dev/api/update/darwin-arm64/stable/old-commit'),
			new Request('https://updates.para-code.dev/health')
		];

		const results = [];
		for (const request of requests) {
			const response = await worker.fetch(request, env as Env);
			results.push([response.status, response.headers.get('X-Content-Type-Options')]);
		}

		expect(results).toEqual([[204, 'nosniff'], [200, 'nosniff'], [200, 'nosniff'], [401, 'nosniff'], [404, 'nosniff']]);
	});

	it('exports a ready-made worker as the module default', async () => {
		const { env } = createEnv(null);

		const response = await defaultWorker.fetch(new Request('https://updates.para-code.dev/api/update/linux-x64/stable/current-commit'), env as Env);

		expect(response.status).toBe(204);
	});
});
