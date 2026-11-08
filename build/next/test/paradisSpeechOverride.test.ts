/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 音声入力の認識の中身（ILocalTranscriptionService）を Para の実装に差し替える仕組みの網。
//
// 差し替えは「upstream の登録より後に Para の集約から registerSingleton する（後勝ち）」で効いている。
// upstream の取り込みで workbench.desktop.main.ts の import の順が変わり、Para の集約が upstream の
// localTranscriptionService より先に読まれるようになると、何のエラーも出ずに upstream の Foundry Local
// （Q92 で断った部品を初回に取りに行く実装）へ戻る。その順をここで押さえる。

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { suite, test } from 'node:test';

const srcRoot = path.join(import.meta.dirname, '..', '..', '..', 'src');

function read(relativePath: string): string {
	return fs.readFileSync(path.join(srcRoot, relativePath), 'utf-8');
}

/** コメントでない行の import の位置。無ければ -1。 */
function importLine(source: string, module: string): number {
	return source.split('\n').findIndex(line => /^\s*import\s/.test(line) && line.includes(`'${module}'`));
}

suite('Para Code replaces the upstream speech recognition service', () => {
	test('the Para aggregate is imported after the upstream local transcription service in the desktop workbench', () => {
		const desktopMain = read('vs/workbench/workbench.desktop.main.ts');
		const upstream = importLine(desktopMain, './services/localTranscription/electron-browser/localTranscriptionService.js');
		const paradis = importLine(desktopMain, '../paradis/paradis.electron-browser.contribution.js');
		assert.deepStrictEqual({ upstreamFound: upstream >= 0, paradisFound: paradis >= 0, paradisAfterUpstream: paradis > upstream }, { upstreamFound: true, paradisFound: true, paradisAfterUpstream: true });
	});

	test('the Para aggregate registers the replacement', () => {
		const aggregate = read('vs/paradis/paradis.electron-browser.contribution.ts');
		const replacement = read('vs/paradis/contrib/dictation/electron-browser/paradisLocalTranscriptionService.ts');
		assert.deepStrictEqual({
			imported: importLine(aggregate, './contrib/dictation/electron-browser/paradisLocalTranscriptionService.js') >= 0,
			registers: /registerSingleton\(ILocalTranscriptionService, ParadisLocalTranscriptionService,/.test(replacement),
			// Foundry Local の部品へつながるものを読み込まない
			foundryFree: !/localTranscriptionMain|foundry|dictationRuntime/i.test(replacement.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
		}, { imported: true, registers: true, foundryFree: true });
	});
});
