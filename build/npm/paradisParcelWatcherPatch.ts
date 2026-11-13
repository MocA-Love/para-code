/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as fs from 'fs';
import path from 'path';
import * as child_process from 'child_process';
import { getPnpmCommand } from '../lib/pnpm.ts';

/**
 * `@parcel/watcher` の `Glob::isIgnored` が長い相対パスでプロセスごとクラッシュする問題
 * (https://github.com/parcel-bundler/watcher/issues/250) を回避するパッチを当て、再ビルドする。
 *
 * `src/Glob.cc` は除外 glob の判定に `std::regex_match` を使うが、regex は入力長に比例して再帰するため、
 * 長い相対パスでウォッチャースレッドのスタックを溢れさせる。Windows では `STATUS_STACK_BUFFER_OVERRUN`
 * (0xC0000409) でファイル監視プロセスが即死し、JS 側からは catch できない。issue は 2.5.6 時点で未修正。
 *
 * ここでは閾値を超える相対パスを regex に掛けずに「無視しない」と返すガードを入れる。落ちなくなった
 * 代わりに長いパスは native 側で除外されなくなるため、`parcelWatcher.ts` 側でイベントを JS の除外
 * パターンで落とし直している (PARA-PATCH)。ただし JS 側で回収できるのは通知だけで、`isIgnored` が
 * 兼ねている「走査の枝刈り」(unix/fts.cc の `FTS_SKIP`、linux/InotifyBackend.cc の `inotify_add_watch`
 * 抑止、windows/WindowsBackend.cc の DirTree 登録) は効かなくなる。実際に枝刈りが失われるのは
 * 「親ディレクトリの相対パスが閾値以下では除外パターンに一致せず、閾値超えの深さで初めて一致する」
 * ケースに限られる (`**\/node_modules/**` のような一般的なパターンでは浅い階層で先に枝刈りされる)。
 *
 * `pnpm-workspace.yaml` の `ignoredOptionalDependencies` が prebuilt の `@parcel/watcher-*` を入れず、
 * `allowBuilds` で許可された install script がソースからビルドするため、実際に読み込まれるのは常に
 * ソースからビルドした `build/Release/watcher.node`。よってソースへのパッチが確実に効く。
 *
 * pnpm の `nodeLinker: hoisted` は store のファイルを node_modules へハードリンクすることがある。
 * そのまま上書きすると store の中身まで書き換わるので、書き込みはリンクを切ってから行う
 * ({@link writeUnlinked})。
 *
 * パッチ適用は冪等。再ビルドに失敗した場合はソースを元に戻し、次回の postinstall で再試行させる
 * (パッチ済みマーカーだけ残って古いバイナリが使われ続ける状態を避ける)。
 *
 * @param packageRoot `package.json` のあるディレクトリ (root または remote) の絶対パス
 * @param env 再ビルドに使う環境変数。**呼び出し側が `pnpm install` に渡したものと同じ物を渡すこと**
 *            (`undefined` なら `process.env` を継承する)。ネイティブビルドの `npm_config_*` は
 *            その install root の `.pnpmfile.mjs` が `pnpm rebuild` にも渡す
 * @param log 進捗の出力先
 */
export function paradisPatchAndRebuildParcelWatcher(packageRoot: string, env: NodeJS.ProcessEnv | undefined, log: (message: string) => void): void {
	let patch: ParcelWatcherPatch | undefined;
	try {
		if (!paradisCheckParcelWatcherVersion(packageRoot, log)) {
			return; // 版が違う。手元では警告だけ出して素の watcher のまま続ける
		}
		patch = paradisPatchParcelWatcher(packageRoot);
	} catch (error) {
		// upstream の実装が変わっている。黙って素通りするとクラッシュだけが再発するので、明示的に失敗させる。
		// process.exit ではなく throw する: postinstall はネイティブの install root を並べて入れ、全部が
		// 終わってから失敗を報告する（途中で終わると、ほかの root の install が半端なまま止まる）
		const reason = error instanceof Error ? error.message : String(error);
		log(`ERR Could not patch ${reason}. See https://github.com/parcel-bundler/watcher/issues/250`);
		throw new Error(`Could not patch @parcel/watcher in ${packageRoot}: ${reason}`);
	}

	if (!patch) {
		return; // 適用済み、または対象外
	}

	log('Patching @parcel/watcher for parcel-bundler/watcher#250 and rebuilding...');

	const pnpm = getPnpmCommand();
	const result = child_process.spawnSync(pnpm.command, [...pnpm.args, 'rebuild', '@parcel/watcher'], {
		cwd: packageRoot,
		env,
		stdio: 'inherit',
		shell: pnpm.shell,
	});

	if (result.error || result.status !== 0) {
		// 元に戻して次回に再試行させる。ここで postinstall ごと止めはしない: ネイティブビルドの
		// 失敗は環境要因 (toolchain や C++ 標準の食い違い) で起きることがあり、revert 済みで
		// node_modules は元の動く状態に戻っているため、開発環境まで巻き添えにする理由が無い。
		// パッチが当たらないので #250 のクラッシュは残る。目立つよう警告だけ出す。
		writeUnlinked(patch.globPath, patch.original);
		log(`ERR Failed to rebuild @parcel/watcher after patching; reverted ${patch.globPath}. The watcher remains vulnerable to parcel-bundler/watcher#250.`);
	}
}

/**
 * `@parcel/watcher` のソースへ長い相対パスのガードを適用する。
 *
 * 書き込み前に適用箇所の検証を完了するため、未対応のソースではファイルを変更せずに例外を送出する。
 *
 * @returns 適用済みまたは対象外なら `undefined`、成功なら復元に必要な元の内容
 */
export function paradisPatchParcelWatcher(packageRoot: string): ParcelWatcherPatch | undefined {
	if (paradisIsParcelWatcherPatched(packageRoot)) {
		return undefined;
	}

	const watcherRoot = path.join(packageRoot, 'node_modules', '@parcel', 'watcher');
	const globPath = path.join(watcherRoot, 'src', 'Glob.cc');
	const original = fs.readFileSync(globPath, 'utf8');
	const patched = paradisApplyGlobGuard(original);

	if (patched === undefined) {
		return undefined;
	}
	if (patched === original) {
		throw new Error(`${globPath}: expected code not found`);
	}

	writeUnlinked(globPath, patched);
	return { globPath, original };
}

/**
 * ファイルを消してから書く。pnpm が store からハードリンクしたファイルをその場で上書きすると、
 * store と、同じ store を使うほかの node_modules の中身まで書き換わるため。
 */
function writeUnlinked(file: string, contents: string): void {
	fs.rmSync(file, { force: true });
	fs.writeFileSync(file, contents, 'utf8');
}

interface ParcelWatcherPatch {
	globPath: string;
	original: string;
}

/**
 * そのパッケージの `@parcel/watcher` に既にガードが当たっているか。
 *
 * 「ソースからビルドされた成果物が実際にある」ことも対象条件に含める。`@parcel/watcher` が
 * 依存に載っていても、その環境ではビルドされていないことがある (例: remote は macOS では
 * `std::optional` を巡る C++ 標準の食い違いでビルドが通らず、`build/Release/watcher.node` が
 * 生成されない)。そこへパッチを当てて再ビルドを試みても失敗するだけで、そもそもその
 * `watcher.node` は読み込まれない。ビルド済みの場所だけを対象にする。
 *
 * @returns パッチ適用済み、または対象外 (`@parcel/watcher` が無い / ビルドされていない) なら true
 */
export function paradisIsParcelWatcherPatched(packageRoot: string): boolean {
	const watcherRoot = path.join(packageRoot, 'node_modules', '@parcel', 'watcher');
	const globPath = path.join(watcherRoot, 'src', 'Glob.cc');
	if (!fs.existsSync(globPath) || !fs.existsSync(path.join(watcherRoot, 'build', 'Release', 'watcher.node'))) {
		return true; // 対象外
	}
	if (!paradisIsSupportedParcelWatcherVersion(path.join(watcherRoot, 'package.json'))) {
		return true; // issue #250 の未修正版だけを対象にする
	}

	return fs.readFileSync(globPath, 'utf8').includes(PATCH_MARKER);
}

/**
 * ビルド済みの `@parcel/watcher` が、ガードを確かめた版 ({@link SUPPORTED_PARCEL_WATCHER_VERSION}) と違うことを知らせる。
 *
 * {@link paradisIsParcelWatcherPatched} は版が違えば「対象外」と答える。ここではその代わりに、黙ってガードが外れないよう CI では例外で止め、手元では警告を出す
 * (xterm の IME パッチと同じ扱い)。版が上がったら issue #250 が直ったかを確かめ、このファイルを更新する。
 *
 * @returns パッチを当ててよい (版が一致する、または対象外) なら true、版が違って手元で警告しただけなら false
 * @throws CI (`process.env.CI`) で版が違うとき
 */
export function paradisCheckParcelWatcherVersion(packageRoot: string, log: (message: string) => void): boolean {
	const watcherRoot = path.join(packageRoot, 'node_modules', '@parcel', 'watcher');
	if (!fs.existsSync(path.join(watcherRoot, 'src', 'Glob.cc')) || !fs.existsSync(path.join(watcherRoot, 'build', 'Release', 'watcher.node'))) {
		return true; // ビルドされていない場所は読み込まれないので対象外
	}
	const packageJsonPath = path.join(watcherRoot, 'package.json');
	if (paradisIsSupportedParcelWatcherVersion(packageJsonPath)) {
		return true;
	}

	const message = `@parcel/watcher is ${paradisReadParcelWatcherVersion(packageJsonPath) ?? 'of an unknown version'}, but the long-path guard was checked against ${SUPPORTED_PARCEL_WATCHER_VERSION}; skipped. Check whether https://github.com/parcel-bundler/watcher/issues/250 is fixed and update build/npm/paradisParcelWatcherPatch.ts`;
	if (process.env['CI']) {
		throw new Error(message);
	}
	log(`WARNING: ${message}`);
	return false;
}

function paradisReadParcelWatcherVersion(packageJsonPath: string): string | undefined {
	try {
		const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: string };
		return packageJson.version;
	} catch {
		return undefined;
	}
}

function paradisIsSupportedParcelWatcherVersion(packageJsonPath: string): boolean {
	return paradisReadParcelWatcherVersion(packageJsonPath) === SUPPORTED_PARCEL_WATCHER_VERSION;
}

/**
 * `Glob.cc` の中身にガードを挿入する。ファイル入出力から切り離してあるので、生成結果だけを単体で確かめられる。
 *
 * @returns 適用済みなら `undefined`、目印の箇所が見つからなければ入力をそのまま、成功なら適用後の内容
 */
export function paradisApplyGlobGuard(contents: string): string | undefined {
	if (contents.includes(PATCH_MARKER)) {
		return undefined;
	}

	return contents.replace(ANCHOR, REPLACEMENT);
}

/** パッチ済み判定に使う目印。{@link REPLACEMENT} に必ず含める。 */
const PATCH_MARKER = 'PARADIS_MAX_GLOB_MATCH_LENGTH';

/** `Glob::isIgnored` の長い相対パスでクラッシュすることを確認済みの最終版。 */
const SUPPORTED_PARCEL_WATCHER_VERSION = '2.5.6';

/**
 * 閾値 (バイト数)。issue #250 の報告では約300バイトで落ち、約200バイトまでは安全とされる実測に基づく
 * (Windows 11 x64 / Node.js v24 / 既定のスレッドスタック / `**\/*.log` 相当の単純なパターン)。
 * `std::regex` の再帰深度は入力長だけでなくパターンの複雑さにも左右され、パターンは
 * `files.watcherExclude` でユーザーが自由に書けるため、「どんなパターンでも安全」を保証する値ではない。
 * 下げるほど安全側だが、その分だけ native 側の枝刈りを捨てることになる。
 * 相対パスは UTF-8 バイト列で数えるため、日本語パスは1文字3バイトとして扱われる。
 */
const MAX_GLOB_MATCH_LENGTH = '200u'; // std::string::size_type との比較で符号の警告が出ないよう unsigned

/**
 * 置換対象は wasm 以外の分岐のみ。wasm ビルドは JS の正規表現エンジンを使い (`wasm_regex_match`)
 * ネイティブスタックを再帰消費しないため、ガードを入れると無用に除外を捨てるだけになる。
 */
// C++ 側は2スペースインデント。行ごとの文字列として組み立てないと、このファイルの
// インデント (タブ) を検査する hygiene に引っかかる
const ANCHOR = [
	'  #else',
	'    return std::regex_match(relative_path, mRegex);',
	'  #endif',
].join('\n');

const REPLACEMENT = [
	'  #else',
	`    // PARA-PATCH (${PATCH_MARKER}): std::regex_match recurses on input length and blows this`,
	'    // thread\'s stack on long paths, killing the whole process (parcel-bundler/watcher#250,',
	'    // unfixed as of 2.5.6). Skip the regex for over-long paths; parcelWatcher.ts re-applies the',
	'    // excludes in JS. See build/npm/paradisParcelWatcherPatch.ts for the threshold and its cost.',
	`    if (relative_path.size() > ${MAX_GLOB_MATCH_LENGTH}) {`,
	'      return false;',
	'    }',
	'',
	'    return std::regex_match(relative_path, mRegex);',
	'  #endif',
].join('\n');
