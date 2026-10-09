/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// fork 独自のエントリポイントがパッケージに入ることの網。
//
// パッケージに入る「独立した .js」の一覧は `build/next/index.ts` にある。以前は gulp の旧経路
// (`build/buildfile.ts`) との二重管理で、片方にだけ足された `paradisPtyHostDaemonEntry` が
// 配布物から抜け、常駐ターミナルが毎回 ERR_MODULE_NOT_FOUND で起動できなかった。旧経路は
// upstream 1.139 で消えたので二重管理は無くなったが、**この一覧から抜けても何も起きない**
// 性質は変わらない。ビルドも型検査も lint も通り、開発ビルド (out/ を直接読む) では動き、
// パッケージ版だけでその機能が静かに動かなくなる。
//
// なので fork が足したエントリを名指しで押さえ、ついでにソースの実在も確かめる。
// upstream のリファクタで一覧の変数名が変わったときは、ここが「見つからない」で落ちる。

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { suite, test } from 'node:test';

const buildRoot = path.join(import.meta.dirname, '..', '..');
const srcRoot = path.join(buildRoot, '..', 'src');

function read(relativePath: string): string {
	return fs.readFileSync(path.join(buildRoot, relativePath), 'utf-8');
}

/** 行コメントを落とす。コメント中のパス例を実体と取り違えないため。 */
function stripLineComments(source: string): string {
	return source.replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * `const NAME = [ ... ];` の右辺から、引用符で囲まれた `vs/...` を順に拾う。
 */
function modulesOf(source: string, name: string): string[] {
	const start = source.search(new RegExp(`^(export )?const ${name}\\b[^=]*=`, 'm'));
	assert.notStrictEqual(start, -1, `${name} が見つからない`);
	const rest = source.slice(start);
	const end = rest.indexOf('\n];');
	assert.notStrictEqual(end, -1, `${name} の終わりが見つからない`);
	const body = stripLineComments(rest.slice(0, end));
	return [...body.matchAll(/'(vs\/[^']+)'/g)].map(match => match[1]);
}

const next = read('next/index.ts');

/** fork が足したエントリと、それが載っているべき一覧。 */
const PARADIS_ENTRY_POINTS: readonly { readonly entry: string; readonly lists: readonly string[] }[] = [
	{
		// ウィンドウのメッセージポートを常駐 pty デーモンへ中継する橋渡しプロセス
		entry: 'vs/paradis/contrib/ptyDaemon/node/paradisPtyDaemonBridgeMain',
		lists: ['desktopEntryPoints'],
	},
	{
		// 更新をまたいで生き残る pty デーモン。どこからも import されないので一覧だけが頼り
		entry: 'vs/paradis/contrib/ptyDaemon/node/paradisPtyHostDaemonEntry',
		lists: ['desktopEntryPoints', 'serverEntryPoints'],
	},
	{
		// エージェント CLI が `node out/.../paradisBrowserMcpShim.js` で直接起動する MCP シム
		entry: 'vs/paradis/contrib/agentBrowser/node/paradisBrowserMcpShim',
		lists: ['desktopEntryPoints'],
	},
	{
		// shared process が worker_threads で起動する、会話ログを読む worker（パスを指定して起動するので import されない）
		entry: 'vs/paradis/contrib/agentActivity/node/paradisAgentActivityWorkerMain',
		lists: ['desktopEntryPoints'],
	},
	{
		// shared process が worker_threads で起動する、Word の詳しい解析の worker（同じくパスを指定して起動する）
		entry: 'vs/paradis/contrib/fileViewers/node/word/paradisWordSemanticWorkerMain',
		lists: ['desktopEntryPoints'],
	},
	{
		// shared process が worker_threads で起動する、Excel の詳しい解析の worker（同じくパスを指定して起動する）
		entry: 'vs/paradis/contrib/fileViewers/node/spreadsheet/paradisSpreadsheetSemanticWorkerMain',
		lists: ['desktopEntryPoints'],
	},
];

suite('Para Code entry points ship in the esbuild bundle', () => {
	for (const { entry, lists } of PARADIS_ENTRY_POINTS) {
		test(entry, () => {
			assert.deepStrictEqual(
				{
					lists: Object.fromEntries(lists.map(list => [list, modulesOf(next, list).includes(entry)])),
					sourceExists: fs.existsSync(path.join(srcRoot, `${entry}.ts`)),
				},
				{
					lists: Object.fromEntries(lists.map(list => [list, true])),
					sourceExists: true,
				}
			);
		});
	}

	test('the @sentry inlining plugin is wired into the bundle', () => {
		assert.match(next, /plugins\.push\(inlineParadisSentryPlugin\(\)\);/);
	});
});
