/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Electron main プロセスが「パッケージ版で解決できない依存」を静的 import しないことを守るテスト。
//
// パッケージ版の main は ASAR の中から ESM で読み込まれる。Node の ESM ローダーは ASAR 内の
// パッケージを解決できないため、main のトップレベル import グラフが `node-pty` のような
// node_modules 上の依存に届いた時点で ERR_MODULE_NOT_FOUND になり、**アプリが起動しなくなる**。
// dev ビルド（out/ を直接読む）では再現しないので、CI とパッケージングまで気付けない。
//
// 実際に2度踏んでいる:
//   - @sentry/electron/main（paracode-68。`import type` + 動的 import へ直して解決）
//   - node-pty（2026-08-23。electron-main が ptyDaemon の node/ 層を1つ import しただけで、
//     paradisTerminalProcessFactory -> platform/terminal/node/terminalProcess -> node-pty と辿った）
//
// どちらも「1行の import を足しただけ」で起きる。人の目では追えないので機械で見張る。
//
// 検査は**許可制**。禁止リストにすると「次に踏むのが node-pty でも Sentry でもなかった場合」を
// 取り逃すため、main が静的に触れてよい非相対依存を数えるほうを列挙している。

import { deepStrictEqual, ok } from 'assert';
import * as fs from 'fs';
import * as path from '../../../base/common/path.js';
import { FileAccess } from '../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';

/**
 * main プロセスが静的に import してよい非相対の依存。**許可制**にしてあるのは、
 * 禁止リストだと「次に踏むのが node-pty 以外だった場合」を取り逃すため。
 * ここに足すときは「パッケージ版でも解決できる」根拠を必ず確認すること。
 */
const ALLOWED_PACKAGES = new Set([
	// Electron 本体（ASAR の外、ランタイムが提供する）
	'electron',
	// ASAR 対応の fs。Electron が同じくランタイムとして提供する
	'original-fs',
	// 素の JS で完結する引数パーサ。ネイティブ拡張を持たず bundle 済み
	'minimist',
]);

/** Node の組込みモジュール。`node:` 接頭辞は呼び出し側で剥がしてから渡す。 */
const NODE_BUILTINS = new Set([
	'assert', 'buffer', 'child_process', 'cluster', 'console', 'crypto', 'dns', 'events',
	'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path',
	'perf_hooks', 'process', 'querystring', 'readline', 'stream', 'string_decoder', 'timers',
	'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
]);

/** main プロセスの入口。ここから辿れる範囲が「起動時に必ず読まれるもの」。 */
const MAIN_ENTRY_POINTS = [
	'src/main.ts',
	'src/vs/code/electron-main/main.ts',
	'src/vs/code/electron-main/app.ts',
];

/**
 * `import ... from '<spec>'` と `export ... from '<spec>'` の <spec>。
 * `import type` / `export type` は実行時に消えるので除外する。再エクスポートを辿らないと、
 * 経由するだけのファイル（`colorRegistry.ts` など）の先が丸ごと未検査になる。
 */
const IMPORT_PATTERN = /^[ \t]*(?:import|export)[ \t]+(?!type[ \t])(?:[^'";]*?from[ \t]*)?['"]([^'"]+)['"]/gm;

function repositoryRoot(): string {
	// out/vs を起点にリポジトリの src を指し、その親をルートとする
	// （paradisDefaultExtensions.test.ts と同じ辿り方）。
	return path.dirname(FileAccess.asFileUri('vs/../../src').fsPath);
}

/**
 * `<spec>` を実ファイルへ解決する。相対 import 以外は解決しない（呼び出し側で判定済み）。
 *
 * 解決できないものを黙って捨てると、その先の枝が丸ごと未検査になる（偽陰性）。そうならないよう、
 * 「型しか無い（`.d.ts` だけ）」と「同梱の素の `.js`」だけを**意図的に辿らない**ものとして扱い、
 * それ以外の未解決は呼び出し側が失敗として報告する。
 */
function resolveRelative(fromFile: string, specifier: string): { readonly file: string } | 'no-runtime-source' | undefined {
	const asJs = path.resolve(path.dirname(fromFile), specifier);
	const asTs = asJs.replace(/\.js$/, '.ts');
	if (fs.existsSync(asTs)) {
		return { file: asTs };
	}
	if (fs.existsSync(`${asTs}.ts`)) {
		return { file: `${asTs}.ts` };
	}
	// 型定義しか無いもの（`debuggerApi.d.ts` 等）は実行時に消えるので辿る先が無い。
	if (fs.existsSync(asJs.replace(/\.js$/, '.d.ts'))) {
		return 'no-runtime-source';
	}
	// 同梱済みの素の JS（`base/common/semver/semver.js` 等）。npm から解決されるものではないので
	// パッケージ版でも問題にならない。バンドル済みで外部 import を持たない前提。
	if (fs.existsSync(asJs)) {
		return 'no-runtime-source';
	}
	return undefined;
}

/**
 * 入口から相対 import だけを辿り、許可されていないパッケージに届いた経路を返す。
 * 返す文字列は「入口 -> ... -> そのパッケージを import しているファイル」の1行表現。
 */
function findForbiddenImportChains(root: string): string[] {
	const visited = new Set<string>();
	const cameFrom = new Map<string, string>();
	const queue: string[] = [];
	for (const entry of MAIN_ENTRY_POINTS) {
		const absolute = path.join(root, entry);
		visited.add(absolute);
		queue.push(absolute);
	}

	const chains: string[] = [];
	while (queue.length) {
		const file = queue.shift()!;
		let source: string;
		try {
			source = fs.readFileSync(file, 'utf8');
		} catch {
			continue;
		}

		IMPORT_PATTERN.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = IMPORT_PATTERN.exec(source))) {
			const specifier = match[1];
			if (!specifier.startsWith('.')) {
				const bare = specifier.replace(/^node:/, '');
				if (!NODE_BUILTINS.has(bare) && !ALLOWED_PACKAGES.has(bare)) {
					const chain = [`${specifier} (package)`];
					for (let current: string | undefined = file; current; current = cameFrom.get(current)) {
						chain.push(path.relative(root, current));
					}
					chains.push(chain.reverse().join(' -> '));
				}
				continue;
			}
			const resolved = resolveRelative(file, specifier);
			if (resolved === undefined) {
				// 辿れないものを黙って飛ばすと、そこから先が永久に未検査になる。
				chains.push(`${path.relative(root, file)} -> ${specifier} (解決できない相対 import)`);
				continue;
			}
			if (resolved === 'no-runtime-source' || visited.has(resolved.file)) {
				continue;
			}
			visited.add(resolved.file);
			cameFrom.set(resolved.file, file);
			queue.push(resolved.file);
		}
	}
	return chains;
}

suite('paradis main process import graph', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the electron-main entry points never statically reach a package the packaged build cannot resolve', () => {
		const root = repositoryRoot();
		// 黙って通さない: ルートの導出が壊れると、検査が空回りしたまま永久に緑になる。
		ok(fs.existsSync(path.join(root, MAIN_ENTRY_POINTS[0])), `main entry not found under ${root} — repositoryRoot() is wrong`);
		deepStrictEqual(findForbiddenImportChains(root), []);
	});
});
