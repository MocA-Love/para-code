/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エントリポイントの一覧が2箇所に分かれている問題への網。
//
// パッケージに入る「独立した .js」の一覧は、`build/buildfile.ts` と `build/next/index.ts` の
// **両方**に書かれている。前者は gulp の旧経路、後者が `buildConfig.useEsbuildTranspile` で
// 選ばれている現行の経路で、実際に配布物を作るのは後者。
//
// この二重化が危ないのは、**片方だけに足しても何も起きないから**。ビルドは通り、型検査も lint も
// 通り、開発ビルド (out/ を直接読む) では動く。壊れるのはパッケージ版だけで、症状も「その機能が
// 静かに動かない」になる。実際 `paradisPtyHostDaemonEntry` は `buildfile.ts` にだけ登録されたまま
// 配布され、常駐ターミナルが毎回 ERR_MODULE_NOT_FOUND で起動できなかった。
//
// なので「片方だけに載っている」状態そのものを落とす。どちらへ足すかを覚えていなくても、
// 足りない方をこのテストが名指ししてくれる。

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { suite, test } from 'node:test';

const buildRoot = path.join(import.meta.dirname, '..', '..');

function read(relativePath: string): string {
	return fs.readFileSync(path.join(buildRoot, relativePath), 'utf-8');
}

/** 行コメントを落とす。コメント中のパス例を実体と取り違えないため。 */
function stripLineComments(source: string): string {
	return source.replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * `const NAME = ...;` の右辺から、引用符で囲まれた `vs/...` を順に拾う。
 *
 * 配列でも単体 (`export const workerEditor = createModuleDescription('…');`) でも同じ形で
 * 取れるので、2つのファイルの書き方の違いをここで吸収する。
 */
function modulesOf(source: string, name: string): string[] {
	const start = source.search(new RegExp(`^(export )?const ${name}\\b[^=]*=`, 'm'));
	assert.notStrictEqual(start, -1, `${name} が見つからない`);
	const rest = source.slice(start);
	const firstLineEnd = rest.indexOf('\n');
	const isArray = rest.slice(0, firstLineEnd).trimEnd().endsWith('[');
	const end = isArray ? rest.indexOf('\n];') : firstLineEnd;
	assert.notStrictEqual(end, -1, `${name} の終わりが見つからない`);
	const body = stripLineComments(rest.slice(0, end));
	return [...body.matchAll(/'(vs\/[^']+)'/g)].map(match => match[1]);
}

function modulesOfAll(source: string, names: readonly string[]): string[] {
	return names.flatMap(name => modulesOf(source, name)).sort();
}

const buildfile = read('buildfile.ts');
const next = read('next/index.ts');

/**
 * 対応する組。左が旧経路 (`buildfile.ts`)、右が現行経路 (`next/index.ts`) の変数名。
 *
 * 名前が揃っていないのは upstream 由来の事情なので、対応表をここに置いて突き合わせる。
 */
const PAIRS: readonly { readonly what: string; readonly legacy: readonly string[]; readonly current: readonly string[] }[] = [
	{
		what: 'desktop',
		legacy: ['workbenchDesktop', 'code'],
		current: ['desktopEntryPoints', 'codeEntryPoints'],
	},
	{
		what: 'server (reh)',
		legacy: ['codeServer'],
		current: ['serverEntryPoints'],
	},
	{
		what: 'workers',
		legacy: [
			'workerEditor',
			'workerExtensionHost',
			'workerNotebook',
			'workerLanguageDetection',
			'workerLocalFileSearch',
			'workerProfileAnalysis',
			'workerOutputLinks',
			'workerBackgroundTokenization',
		],
		current: ['workerEntryPoints', 'desktopWorkerEntryPoints'],
	},
	{
		what: 'web',
		legacy: ['workbenchWeb', 'codeWeb', 'sessionsWeb'],
		current: ['webEntryPoints', 'webOnlyEntryPoints'],
	},
	{
		what: 'keyboard maps',
		legacy: ['keyboardMaps'],
		current: ['keyboardMapEntryPoints'],
	},
];

suite('entry points stay in sync between buildfile.ts and next/index.ts', () => {
	for (const pair of PAIRS) {
		test(pair.what, () => {
			assert.deepStrictEqual(
				modulesOfAll(buildfile, pair.legacy),
				modulesOfAll(next, pair.current)
			);
		});
	}

	// 現行経路にしか無い形の取りこぼしを直接押さえる。上の突き合わせが通っていても、
	// **両方から同時に抜け落ちた**ときは気づけないため。
	test('the reconnect-across-updates pty daemon entry ships', () => {
		const entry = 'vs/paradis/contrib/ptyDaemon/node/paradisPtyHostDaemonEntry';
		assert.deepStrictEqual(
			{
				desktop: modulesOf(next, 'desktopEntryPoints').includes(entry),
				server: modulesOf(next, 'serverEntryPoints').includes(entry),
			},
			{ desktop: true, server: true }
		);
	});
});
