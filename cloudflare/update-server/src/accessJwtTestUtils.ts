/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { IAccessJsonWebKey, IAccessJsonWebKeySet } from './accessJwt';

export const TEST_TEAM_DOMAIN = 'https://para-test.cloudflareaccess.com';
export const TEST_AUDIENCE = 'para-code-update-feed';
export const TEST_NOW_MS = 1_785_294_000_000;

/** An RSA signing key and the public JWK that Access would publish for it. */
export interface ITestSigningKey {
	readonly kid: string;
	readonly privateKey: CryptoKey;
	readonly publicJwk: IAccessJsonWebKey;
}

export async function createTestSigningKey(kid: string): Promise<ITestSigningKey> {
	const pair = await crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
		true,
		['sign', 'verify']
	) as CryptoKeyPair;
	const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey;
	return { kid, privateKey: pair.privateKey, publicJwk: { ...publicJwk, kid, alg: 'RS256', use: 'sig' } };
}

export function keySetOf(...keys: ITestSigningKey[]): IAccessJsonWebKeySet {
	return { keys: keys.map(key => key.publicJwk) };
}

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJson(value: object): string {
	return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Signs a token the way Access does; `claims` overrides the valid defaults. */
export async function signTestToken(key: ITestSigningKey, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): Promise<string> {
	const nowSeconds = Math.floor(TEST_NOW_MS / 1000);
	const signingInput = `${encodeJson({ alg: 'RS256', kid: key.kid, ...header })}.${encodeJson({
		aud: [TEST_AUDIENCE],
		iss: TEST_TEAM_DOMAIN,
		iat: nowSeconds,
		nbf: nowSeconds,
		exp: nowSeconds + 3600,
		type: 'app',
		common_name: 'test.access',
		...claims
	})}`;
	const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(signingInput));
	return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}
