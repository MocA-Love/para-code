/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import worker from './index';
import type { Env, IReleaseRecord } from './types';

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
		get(key: string, type: 'json'): Promise<IReleaseRecord | null>;
	};
	readonly CF_ACCESS_AUD?: string;
}

function createEnv(record: IReleaseRecord | null, cfAccessAudience?: string) {
	const get = vi.fn(async (_key: string, _type: 'json') => record);
	const env: TestEnv = {
		RELEASES: { get },
		...(cfAccessAudience ? { CF_ACCESS_AUD: cfAccessAudience } : {})
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
		const { env, get } = createEnv(publishedRelease, 'para-code-update-feed');

		const response = await fetchUpdate('/api/update/darwin-arm64/stable/old-commit', env);

		expect(response.status).toBe(401);
		expect(await response.text()).toBe('Unauthorized');
		expect(get).not.toHaveBeenCalled();
	});

	it('returns 200 when the Cloudflare Access assertion is present', async () => {
		const { env } = createEnv(publishedRelease, 'para-code-update-feed');

		const response = await fetchUpdate(
			'/api/update/darwin-arm64/stable/old-commit',
			env,
			{ 'Cf-Access-Jwt-Assertion': 'signed-service-token' }
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ version: '1.104.2' });
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
