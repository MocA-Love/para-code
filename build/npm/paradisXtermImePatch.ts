/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as fs from 'fs';
import * as os from 'os';
import path from 'path';
import * as child_process from 'child_process';
import { createRequire } from 'module';

/**
 * ターミナル（xterm）の日本語入力の表示を直すパッチを当てる（Q51 A / TM16）。
 *
 * 直す症状: 変換中の文字の幅がずれる、変換中の文字が黒い箱で出てカーソル位置の文字を隠す、
 * 変換を確定・取り消ししたときに文字が二重に送られる／落ちる（macOS の日本語入力、MS-IME）。
 * 中身は Orca（stablyai/orca、MIT）が beta.303 向けに作った CompositionHelper の作り直しで、
 * IME に関係する src/ の差分だけを `paradisXtermIme/xterm-ime.patch` に置いてある。
 *
 * **npm の配布物の lib/ は1行に縮められたバンドルなので、差分をそのまま当てられない。** Orca の
 * パッチは beta.303 用にビルドし直したバンドルを丸ごと含んでいて、beta.304 には使えない。
 * そこで配布物に同梱されている src/（beta.304 のソース）へ差分を当て、esbuild でバンドルし直して
 * lib/xterm.js（UMD。レンダラが `importAMDNodeModule` で読むもの）と lib/xterm.mjs を置き換える。
 *
 * - 対象の版（{@link PARADIS_XTERM_IME_TARGET_VERSION}）以外には当てない。xterm を上げたら、
 *   差分が当たるか確かめてからこの版を書き換える（当たらなければ作り直す）
 * - esbuild は build/ の依存にある。まだ入っていない（初回の install で build/ より前）ときは
 *   何もせず、install の最後にもう一度呼ばれたときに当てる
 * - 失敗しても install は止めない（素の xterm のまま動く）。警告だけ出す
 * - 当てたかどうかは lib/xterm.js の先頭の印で見る。npm が入れ直せば印ごと消えるので、また当たる
 */
export const PARADIS_XTERM_IME_TARGET_VERSION = '6.1.0-beta.304';

const MARKER = '/* PARA-CODE: xterm IME patch v1 (build/npm/paradisXtermImePatch.ts) */';

const PATCH_FILE = path.join(import.meta.dirname, 'paradisXtermIme', 'xterm-ime.patch');

function xtermDir(root: string): string {
	return path.join(root, 'node_modules', '@xterm', 'xterm');
}

function installedVersion(root: string): string | undefined {
	try {
		return JSON.parse(fs.readFileSync(path.join(xtermDir(root), 'package.json'), 'utf8')).version;
	} catch {
		return undefined;
	}
}

/** パッチ済み、または当てる対象ではない（版が違う・xterm が無い）なら true。 */
export function paradisIsXtermImePatched(root: string): boolean {
	if (installedVersion(root) !== PARADIS_XTERM_IME_TARGET_VERSION) {
		return true;
	}
	try {
		const fd = fs.openSync(path.join(xtermDir(root), 'lib', 'xterm.js'), 'r');
		try {
			const head = Buffer.alloc(MARKER.length);
			fs.readSync(fd, head, 0, MARKER.length, 0);
			return head.toString('utf8') === MARKER;
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return true;
	}
}

/**
 * CommonJS のバンドルを、元の lib/xterm.js と同じ UMD の形に包む。
 * レンダラの `importAMDNodeModule` は AMD の define として読み、node（テスト・headless）は
 * require で読むので、どちらにも答えられる形が要る。
 */
function wrapUmd(cjs: string): string {
	return '!function(e,t){if("object"==typeof exports&&"object"==typeof module)module.exports=t();else if("function"==typeof define&&define.amd)define([],t);else{var i=t();for(var s in i)("object"==typeof exports?exports:e)[s]=i[s]}}(globalThis,()=>{var module={exports:{}};(function(module,exports){\n'
		+ cjs
		+ '\n})(module,module.exports);return module.exports});\n';
}

interface IEsbuild {
	build(options: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
}

/**
 * パッチを当ててバンドルし直す。
 * @param log install のログへ出す関数。
 */
export async function paradisApplyXtermImePatch(root: string, log: (message: string) => void): Promise<void> {
	const version = installedVersion(root);
	if (version === undefined) {
		return;
	}
	if (version !== PARADIS_XTERM_IME_TARGET_VERSION) {
		log(`WARNING: @xterm/xterm is ${version}, but the IME patch targets ${PARADIS_XTERM_IME_TARGET_VERSION}; skipped (regenerate build/npm/paradisXtermIme/xterm-ime.patch)`);
		return;
	}
	if (paradisIsXtermImePatched(root)) {
		return;
	}
	const esbuildDir = path.join(root, 'build', 'node_modules', 'esbuild');
	if (!fs.existsSync(esbuildDir)) {
		log('esbuild is not installed in build/ yet; the xterm IME patch will be applied after it is');
		return;
	}
	const pkgDir = xtermDir(root);
	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paradis-xterm-ime-'));
	try {
		fs.cpSync(path.join(pkgDir, 'src'), path.join(workDir, 'src'), { recursive: true });
		// git apply はリポジトリの外でも patch として働く（-p1 で a/src/... → src/...）
		child_process.execFileSync('git', ['apply', '--whitespace=nowarn', PATCH_FILE], { cwd: workDir, stdio: 'pipe' });

		const esbuild = createRequire(import.meta.url)(esbuildDir) as IEsbuild;
		const options = {
			entryPoints: [path.join(workDir, 'src', 'browser', 'public', 'Terminal.ts')],
			bundle: true,
			minify: true,
			target: 'es2022',
			write: false,
			logLevel: 'warning',
			// xterm は DI に TypeScript の（旧来の）パラメーターデコレーターを使う。クラスフィールドは
			// tsc の従来どおり、コンストラクターでの代入として出す（初期化の順を変えない）
			tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
			// 型だけの import（'@xterm/xterm' の d.ts）。値の import は無いので出力には残らない
			external: ['@xterm/xterm'],
		};
		const cjs = await esbuild.build({ ...options, format: 'cjs' });
		const esm = await esbuild.build({ ...options, format: 'esm' });
		const cjsText = cjs.outputFiles[0].text;
		if (/require\(["']@xterm\/xterm["']\)/.test(cjsText)) {
			throw new Error('the rebuilt bundle unexpectedly requires @xterm/xterm');
		}

		fs.writeFileSync(path.join(pkgDir, 'lib', 'xterm.js'), `${MARKER}\n${wrapUmd(cjsText)}`);
		fs.writeFileSync(path.join(pkgDir, 'lib', 'xterm.mjs'), `${MARKER}\n${esm.outputFiles[0].text}`);
		// src/ も当てた後のものにしておく（lib/ と食い違うと、調べるときに読み違える）
		fs.cpSync(path.join(workDir, 'src'), path.join(pkgDir, 'src'), { recursive: true });
		log(`Patched @xterm/xterm ${version} IME handling (rebuilt lib/xterm.js and lib/xterm.mjs)`);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		log(`WARNING: could not apply the xterm IME patch, keeping the stock xterm: ${detail}`);
	} finally {
		fs.rmSync(workDir, { recursive: true, force: true });
	}
}
