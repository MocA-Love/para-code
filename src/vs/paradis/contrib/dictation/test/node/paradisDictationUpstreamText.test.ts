/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 音声入力まわりで upstream のファイルに当てた PARA-PATCH の見張り。upstream を取り込んだときに
// 上書きされて戻ると、通常のウィンドウに使えないコマンドが出たり、設定の説明が Foundry Local を名指ししたりする。
// どちらも動きには出ないので、ファイルの中身で確かめる。

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

/** このテストのレイヤーでは `path` を import できないため、区切りは '/' に正規化して扱う。 */
function findRepositoryFile(relativePath: string): string | undefined {
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

suite('Paradis dictation upstream patches', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the Install Dictation Model command stays limited to the Agent Sessions window', function () {
		const file = findRepositoryFile('src/vs/workbench/contrib/chat/electron-browser/actions/installDictationModelAction.ts');
		if (file === undefined) {
			this.skip();
		}
		const source = readFileSync(file!, 'utf8');
		// precondition と menu.when は同じ `enabled` を使うので、その組み立てに入っていればよい
		const enabled = /const enabled = ContextKeyExpr\.and\(([\s\S]*?)\n\t\);/.exec(source)?.[1] ?? '';
		assert.deepStrictEqual({
			limited: enabled.includes(`ContextKeyExpr.equals('isSessionsWindow', true)`),
			sharedByPreconditionAndMenu: /precondition: enabled,[\s\S]*when: enabled,/.test(source),
		}, { limited: true, sharedByPreconditionAndMenu: true });
	});

	test('the dictation.model setting does not name Foundry Local or a download', function () {
		const file = findRepositoryFile('src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts');
		if (file === undefined) {
			this.skip();
		}
		const source = readFileSync(file!, 'utf8');
		const start = source.indexOf(`'dictation.model': {`);
		const section = start >= 0 ? source.slice(start, source.indexOf('policy:', start)) : '';
		const descriptions = [...section.matchAll(/nls\.localize\('(?<key>[^']+)', "(?<text>[^"]*)"\)/g)]
			.filter(match => !match.groups!.key.endsWith('.label'))
			.map(match => match.groups!.text);
		assert.deepStrictEqual({
			found: descriptions.length,
			namesFoundry: descriptions.some(text => /Foundry/i.test(text)),
			mentionsDownload: descriptions.some(text => /download/i.test(text)),
		}, { found: 3, namesFoundry: false, mentionsDownload: false });
	});
});
