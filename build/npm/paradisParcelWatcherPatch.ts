/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as fs from 'fs';
import path from 'path';
import * as child_process from 'child_process';

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
 * `.npmrc` が `build_from_source="true"` を指定しており、さらに postinstall が prebuilt を削除するため、
 * 実際に読み込まれるのは常にソースからビルドした `build/Release/watcher.node`。よってソースへの
 * パッチが確実に効く。
 *
 * パッチ適用は冪等。再ビルドに失敗した場合はソースを元に戻し、次回の postinstall で再試行させる
 * (パッチ済みマーカーだけ残って古いバイナリが使われ続ける状態を避ける)。
 *
 * @param packageRoot `package.json` のあるディレクトリ (root または remote) の絶対パス
 * @param env 再ビルドに使う環境変数。**呼び出し側が `npm install` に渡したものと同じ物を渡すこと**。
 *            npm は環境変数をプロジェクトの `.npmrc` より優先するため、これを省いて `process.env` を
 *            継承すると、remote (`runtime=node`) の再ビルドが root から継承した `runtime=electron` /
 *            `target` / `disturl` で走り、ABI の違う `watcher.node` ができてしまう
 * @param log 進捗の出力先
 */
export function paradisPatchAndRebuildParcelWatcher(packageRoot: string, env: NodeJS.ProcessEnv | undefined, log: (message: string) => void): void {
	let patch: ParcelWatcherPatch | undefined;
	try {
		patch = paradisPatchParcelWatcher(packageRoot);
	} catch (error) {
		// upstream の実装が変わっている。黙って素通りするとクラッシュだけが再発するので、明示的に失敗させる
		const reason = error instanceof Error ? error.message : String(error);
		log(`ERR Could not patch ${reason}. See https://github.com/parcel-bundler/watcher/issues/250`);
		process.exit(1);
		return;
	}

	if (!patch) {
		return; // 適用済み、または対象外
	}

	log('Patching @parcel/watcher for parcel-bundler/watcher#250 and rebuilding...');

	const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
	const result = child_process.spawnSync(npm, ['rebuild', '@parcel/watcher'], {
		cwd: packageRoot,
		env,
		stdio: 'inherit',
		shell: true,
	});

	if (result.error || result.status !== 0) {
		// 元に戻して次回に再試行させる。ここで postinstall ごと止めはしない: ネイティブビルドの
		// 失敗は環境要因 (toolchain や C++ 標準の食い違い) で起きることがあり、revert 済みで
		// node_modules は元の動く状態に戻っているため、開発環境まで巻き添えにする理由が無い。
		// パッチが当たらないので #250 のクラッシュは残る。目立つよう警告だけ出す。
		fs.writeFileSync(patch.globPath, patch.original, 'utf8');
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

	fs.writeFileSync(globPath, patched, 'utf8');
	return { globPath, original };
}

interface ParcelWatcherPatch {
	globPath: string;
	original: string;
}

/**
 * そのパッケージの `@parcel/watcher` に既にガードが当たっているか。
 *
 * postinstall は「依存が最新なら丸ごと skip」する高速経路を持つが、その判定材料は
 * `package.json` / `package-lock.json` / `.npmrc` / `.nvmrc` のハッシュだけで、ビルドスクリプトの
 * 変更は入らない。依存が最新の状態でこのパッチを取り込んだ環境へガードを届けるため、
 * 高速経路に入ってよいかの判断にこれを併用する。
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
		return true; // PARA-PATCH: issue #250 の未修正版だけを対象にする
	}

	return fs.readFileSync(globPath, 'utf8').includes(PATCH_MARKER);
}

function paradisIsSupportedParcelWatcherVersion(packageJsonPath: string): boolean {
	try {
		const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: string };
		return packageJson.version === SUPPORTED_PARCEL_WATCHER_VERSION;
	} catch {
		return false;
	}
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
