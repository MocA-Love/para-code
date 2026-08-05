/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_MOBILE_PC_NAME_MAX_LENGTH, paradisFormatPcName } from '../../common/paradisMobileRelay.js';
import { encodePairingUri, PairingPayload } from '../../common/paradisMobileProtocol.js';

/**
 * モバイルのPC一覧に出す表示名。複数のPCとペアリングしたときの見分けに使うため、
 * 「設定が空ならホスト名」「mDNSのサフィックスは落とす」を守る必要がある。
 */
suite('ParadisMobilePcName', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('prefers the configured name and falls back to the hostname', () => {
		assert.strictEqual(paradisFormatPcName('作業用マシン', 'MacBook-Pro.local'), '作業用マシン');
		assert.strictEqual(paradisFormatPcName('  ', 'MacBook-Pro.local'), 'MacBook-Pro');
		assert.strictEqual(paradisFormatPcName(undefined, 'desktop.lan'), 'desktop');
		assert.strictEqual(paradisFormatPcName(undefined, 'plain-host'), 'plain-host');
		assert.strictEqual(paradisFormatPcName(undefined, undefined), undefined);
		assert.strictEqual(paradisFormatPcName('', ''), undefined);
	});

	test('caps the name so the pairing QR does not grow without bound', () => {
		const long = 'x'.repeat(PARADIS_MOBILE_PC_NAME_MAX_LENGTH + 20);
		assert.strictEqual(paradisFormatPcName(long, undefined)?.length, PARADIS_MOBILE_PC_NAME_MAX_LENGTH);
		assert.strictEqual(paradisFormatPcName(undefined, long)?.length, PARADIS_MOBILE_PC_NAME_MAX_LENGTH);
	});

	test('carries the name in the pairing URI only when there is one', () => {
		const base: PairingPayload = {
			version: 1,
			relayUrl: 'wss://relay.example',
			deviceId: 'device',
			pairId: 'pair',
			pairingToken: new Uint8Array([1, 2, 3]),
			pcPublicKey: new Uint8Array(32).fill(7),
		};
		const decode = (uri: string): Record<string, unknown> => {
			const encoded = uri.slice(uri.indexOf('?d=') + 3).replace(/-/g, '+').replace(/_/g, '/');
			const padded = encoded.padEnd(encoded.length + (4 - encoded.length % 4) % 4, '=');
			return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
		};
		assert.strictEqual(decode(encodePairingUri(base))['n'], undefined);
		assert.strictEqual(decode(encodePairingUri({ ...base, pcName: ' MacBook Pro ' }))['n'], 'MacBook Pro');
	});
});
