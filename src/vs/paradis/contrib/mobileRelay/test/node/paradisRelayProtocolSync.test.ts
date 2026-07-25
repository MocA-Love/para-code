/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_RELAY_KEEPALIVE_PING, PARADIS_RELAY_KEEPALIVE_PONG } from '../../common/paradisMobileProtocol.js';

/**
 * リレープロトコルは app/protocol（リレーWorkerとモバイルが使う）と
 * src/vs/paradis/contrib/mobileRelay/common（PCが使う）に複製が2つある。
 * 保活のping/pongはリレー側が「バイト列の完全一致」で自動応答する仕組みなので、
 * 複製がズレると pong が返らなくなり、保活が黙って無効化される（PC側は
 * 「このリレーは保活未対応」と判断して死活検知をやめる）。ここで両者を突き合わせる。
 *
 * app/protocol 側の vitest はこのリポジトリのCIでは実行されないため、
 * CIが必ず走らせる src/vs 配下のテストからソースを読んで検証する。
 */

/** このテストのレイヤーでは `path` を import できないため、区切りは '/' に正規化して扱う。 */
function findRepositoryDirectory(relativePath: string): string | undefined {
	let directory = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/');
	if (!directory.endsWith('/')) {
		directory += '/';
	}
	for (let depth = 0; depth < 12; depth++) {
		const candidate = `${directory}${relativePath}`;
		if (existsSync(candidate)) {
			return candidate;
		}
		const parent = directory.slice(0, directory.lastIndexOf('/', directory.length - 2) + 1);
		if (parent.length === 0 || parent === directory) {
			return undefined;
		}
		directory = parent;
	}
	return undefined;
}

function declaredConstant(source: string, name: string): string | undefined {
	return new RegExp(`export const ${name}\\s*=\\s*'([^']*)'`).exec(source)?.[1];
}

suite('ParadisRelayProtocolSync', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the app/protocol copy declares the same keepalive constants', function () {
		const protocolRoot = findRepositoryDirectory('app/protocol/src');
		if (protocolRoot === undefined) {
			// リポジトリ外（配布物など）から実行された場合は照合対象が無いので検証しない。
			this.skip();
		}
		// app/protocol はあるのに relay.ts が無い＝移動/削除された。無言で通すと複製の同期が
		// 担保されなくなるので失敗させる。
		const protocolPath = `${protocolRoot}/relay.ts`;
		assert.ok(existsSync(protocolPath), `${protocolPath} not found; keepalive constants can no longer be cross-checked`);
		const source = readFileSync(protocolPath, 'utf8');
		assert.strictEqual(declaredConstant(source, 'PARADIS_RELAY_KEEPALIVE_PING'), PARADIS_RELAY_KEEPALIVE_PING);
		assert.strictEqual(declaredConstant(source, 'PARADIS_RELAY_KEEPALIVE_PONG'), PARADIS_RELAY_KEEPALIVE_PONG);
	});
});
