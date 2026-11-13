/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AccessJwtVerifier, normalizeAccessTeamDomain } from './accessJwt';
import { createTestSigningKey, keySetOf, signTestToken, TEST_AUDIENCE, TEST_NOW_MS, TEST_TEAM_DOMAIN, type ITestSigningKey } from './accessJwtTestUtils';

describe('AccessJwtVerifier', () => {
	let teamKey: ITestSigningKey;
	let otherKey: ITestSigningKey;

	beforeAll(async () => {
		teamKey = await createTestSigningKey('team-key');
		otherKey = await createTestSigningKey('team-key');
	});

	function createVerifier(now = () => TEST_NOW_MS) {
		const loadCerts = vi.fn(async () => keySetOf(teamKey));
		return { verifier: new AccessJwtVerifier(loadCerts, now), loadCerts };
	}

	it('accepts a token signed by the team key for the configured audience', async () => {
		const { verifier, loadCerts } = createVerifier();

		const results = [
			await verifier.verify(await signTestToken(teamKey), TEST_AUDIENCE, TEST_TEAM_DOMAIN),
			await verifier.verify(await signTestToken(teamKey, { aud: TEST_AUDIENCE }), TEST_AUDIENCE, 'para-test.cloudflareaccess.com')
		];

		expect({ results, certsUrls: loadCerts.mock.calls }).toEqual({
			results: [true, true],
			certsUrls: [[`${TEST_TEAM_DOMAIN}/cdn-cgi/access/certs`]]
		});
	});

	it('rejects tokens that are forged, for another audience or issuer, or outside their validity window', async () => {
		const { verifier } = createVerifier();
		const nowSeconds = Math.floor(TEST_NOW_MS / 1000);
		const validToken = await signTestToken(teamKey);
		const [header, payload] = validToken.split('.');

		const results = {
			signedByOtherKey: await verifier.verify(await signTestToken(otherKey), TEST_AUDIENCE, TEST_TEAM_DOMAIN),
			tamperedPayload: await verifier.verify(`${header}.${(await signTestToken(teamKey, { aud: ['other'] })).split('.')[1]}.${validToken.split('.')[2]}`, TEST_AUDIENCE, TEST_TEAM_DOMAIN),
			unsigned: await verifier.verify(`${header}.${payload}.`, TEST_AUDIENCE, TEST_TEAM_DOMAIN),
			algNone: await verifier.verify(await signTestToken(teamKey, {}, { alg: 'none' }), TEST_AUDIENCE, TEST_TEAM_DOMAIN),
			otherAudience: await verifier.verify(await signTestToken(teamKey, { aud: ['other-app'] }), TEST_AUDIENCE, TEST_TEAM_DOMAIN),
			otherIssuer: await verifier.verify(await signTestToken(teamKey, { iss: 'https://other.cloudflareaccess.com' }), TEST_AUDIENCE, TEST_TEAM_DOMAIN),
			expired: await verifier.verify(await signTestToken(teamKey, { exp: nowSeconds - 120 }), TEST_AUDIENCE, TEST_TEAM_DOMAIN),
			missingExp: await verifier.verify(await signTestToken(teamKey, { exp: undefined }), TEST_AUDIENCE, TEST_TEAM_DOMAIN),
			notYetValid: await verifier.verify(await signTestToken(teamKey, { nbf: nowSeconds + 120 }), TEST_AUDIENCE, TEST_TEAM_DOMAIN),
			malformed: await verifier.verify('not-a-jwt', TEST_AUDIENCE, TEST_TEAM_DOMAIN),
			badTeamDomain: await verifier.verify(validToken, TEST_AUDIENCE, 'http://para-test.cloudflareaccess.com')
		};

		expect(results).toEqual({
			signedByOtherKey: false,
			tamperedPayload: false,
			unsigned: false,
			algNone: false,
			otherAudience: false,
			otherIssuer: false,
			expired: false,
			missingExp: false,
			notYetValid: false,
			malformed: false,
			badTeamDomain: false
		});
	});

	it('refetches the keys for an unknown kid, but not more than once a minute', async () => {
		let now = TEST_NOW_MS;
		const rotatedKey = await createTestSigningKey('rotated-key');
		const keySets = [keySetOf(teamKey), keySetOf(teamKey, rotatedKey)];
		const loadCerts = vi.fn(async () => keySets.shift() ?? keySetOf(teamKey, rotatedKey));
		const verifier = new AccessJwtVerifier(loadCerts, () => now);
		const rotatedToken = await signTestToken(rotatedKey);

		const first = await verifier.verify(await signTestToken(teamKey), TEST_AUDIENCE, TEST_TEAM_DOMAIN);
		const tooSoon = await verifier.verify(rotatedToken, TEST_AUDIENCE, TEST_TEAM_DOMAIN);
		now += 61_000;
		const afterInterval = await verifier.verify(rotatedToken, TEST_AUDIENCE, TEST_TEAM_DOMAIN);

		expect({ first, tooSoon, afterInterval, fetches: loadCerts.mock.calls.length }).toEqual({
			first: true,
			tooSoon: false,
			afterInterval: true,
			fetches: 2
		});
	});

	it('denies instead of throwing when the keys cannot be fetched', async () => {
		const verifier = new AccessJwtVerifier(async () => { throw new Error('offline'); }, () => TEST_NOW_MS);

		expect(await verifier.verify(await signTestToken(teamKey), TEST_AUDIENCE, TEST_TEAM_DOMAIN)).toBe(false);
	});
});

describe('normalizeAccessTeamDomain', () => {
	it('accepts the bare https origin of the team, with or without the scheme', () => {
		expect([
			normalizeAccessTeamDomain('https://para-test.cloudflareaccess.com'),
			normalizeAccessTeamDomain('para-test.cloudflareaccess.com/'),
			normalizeAccessTeamDomain('http://para-test.cloudflareaccess.com'),
			normalizeAccessTeamDomain('https://para-test.cloudflareaccess.com/cdn-cgi'),
			normalizeAccessTeamDomain('')
		]).toEqual([
			'https://para-test.cloudflareaccess.com',
			'https://para-test.cloudflareaccess.com',
			undefined,
			undefined,
			undefined
		]);
	});
});
