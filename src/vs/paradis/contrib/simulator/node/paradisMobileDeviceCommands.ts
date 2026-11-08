/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// アプリのインストール・起動・権限の付与を `xcrun simctl` / `adb` で行う（B13）。
//
// - シェルを通さない（`execFile` に引数配列で渡す）。パスや ID に空白や記号があっても、そのまま1つの引数になる
// - `adb shell` の後ろは端末側のシェルが解釈し直すので、そこへ渡す値は呼び出す前に
//   `paradisIsValidAppId` / `paradisResolveMobilePermission` で形を確かめてあることが前提
// - 実行とファイルの確認は差し替えられる（テストでは本物の端末に触らない）

import { execFile } from 'child_process';
import { constants as fsConstants } from 'fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { basename, dirname, isAbsolute, join } from '../../../../base/common/path.js';
import { ParadisMobileAppKind, ParadisMobileInstallKind, ParadisMobilePlatform, paradisListappsApplicationType, paradisMobileInstallKindFor, paradisPackageListIncludes, paradisParseDangerousPermissions } from '../common/paradisMobileDeviceOps.js';

export interface IParadisMobileCommandResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** 実行ファイルを引数配列で1回動かす。終了コードが 0 でなくても投げずに結果を返す。 */
export type ParadisMobileCommandRunner = (file: string, args: readonly string[], options: { readonly timeoutMs: number; readonly signal?: AbortSignal }) => Promise<IParadisMobileCommandResult>;

/** ファイルの実在と種類を確かめる口（テストで差し替える）。 */
export interface IParadisMobileFileProbe {
	realpath(path: string): Promise<string>;
	/** 無ければ undefined。 */
	kind(path: string): Promise<'file' | 'directory' | 'other' | undefined>;
}

/**
 * インストールするものを、Para Code だけが書ける一時フォルダへ写す口（テストで差し替える）。
 * 承認の後に元のパスの中身や行き先を差し替えられても、写しは変わらない。
 */
export interface IParadisMobileStagingFs {
	/** 所有者だけが読み書きできる（0700）新しい一時フォルダを作る。 */
	makePrivateDir(): Promise<string>;
	/** `source` を `destination` へ写す。中にシンボリックリンクがあれば投げる。大きすぎても投げる。 */
	copy(source: string, destination: string, signal?: AbortSignal): Promise<void>;
	remove(path: string): Promise<void>;
	/** フォルダの中の名前の一覧（無ければ空）。 */
	list(path: string): Promise<string[]>;
}

/** 写すものの上限。壊れた・悪意のある成果物で一時フォルダを埋めないため。 */
const STAGING_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const STAGING_MAX_ENTRIES = 200_000;

export const paradisNodeMobileStagingFs: IParadisMobileStagingFs = {
	makePrivateDir: async () => {
		const dir = await mkdtemp(join(tmpdir(), 'paradis-mobile-install-'));
		await chmod(dir, 0o700);
		return dir;
	},
	copy: async (source, destination, signal) => {
		const budget = { bytes: STAGING_MAX_BYTES, entries: STAGING_MAX_ENTRIES };
		const walk = async (from: string, to: string): Promise<void> => {
			if (signal?.aborted) {
				throw new Error('The install was cancelled.');
			}
			if (--budget.entries < 0) {
				throw new Error('The app has too many files to install.');
			}
			// リンクは辿らない。写しの外（あとで書き換えられる場所）を指したまま入れることになるため
			const info = await lstat(from);
			if (info.isSymbolicLink()) {
				throw new Error(`The app contains a symbolic link (${basename(from)}). Para Code only installs apps without symbolic links.`);
			}
			if (info.isDirectory()) {
				await mkdir(to, { mode: 0o700 });
				for (const name of await readdir(from)) {
					await walk(join(from, name), join(to, name));
				}
				return;
			}
			if (!info.isFile()) {
				throw new Error(`The app contains something that is not a file or a folder (${basename(from)}).`);
			}
			budget.bytes -= info.size;
			if (budget.bytes < 0) {
				throw new Error('The app is too large to install.');
			}
			await copyFile(from, to, fsConstants.COPYFILE_EXCL);
		};
		await walk(source, destination);
	},
	remove: path => rm(path, { recursive: true, force: true }),
	list: async path => readdir(path).catch(() => []),
};

/** 承認の前に写したインストールするもの。承認ダイアログにはここから読んだ中身を出す。 */
export interface IParadisMobileStagedInstall extends IParadisMobileInstallTarget {
	/** 写しから読んだバンドル ID / パッケージ名。読めなければ undefined。 */
	readonly appId: string | undefined;
	/** 写しから読んだ表示名（iOS の `.app` だけ）。 */
	readonly appName: string | undefined;
	/** 写しを消す。 */
	dispose(): Promise<void>;
}

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** 本物の実行。`shell` は付けない（既定の false のまま）。 */
export const paradisExecFileMobileCommand: ParadisMobileCommandRunner = (file, args, options) => new Promise(resolve => {
	execFile(file, [...args], { timeout: options.timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, signal: options.signal }, (error, stdout, stderr) => {
		const code = !error ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1;
		resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (error && code !== 0 && !stderr ? error.message : '') });
	});
});

export const paradisNodeMobileFileProbe: IParadisMobileFileProbe = {
	realpath: path => realpath(path),
	kind: async path => {
		try {
			const info = await stat(path);
			return info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other';
		} catch {
			return undefined;
		}
	},
};

/**
 * adb の置き場所の候補（先に見つかったものを使う）。SDK の環境変数 → 既定の SDK フォルダ → PATH の各項目の順。
 * PATH は絶対パスの項目だけを自前でたどり、見つけた絶対パスで起動する（裸の `adb` を渡すと、Windows では
 * 今のフォルダが先に探されうる）。環境変数は shared process のもので、ペインの環境は見ない。
 */
export function paradisAdbCandidates(env: { readonly [name: string]: string | undefined }, platform: NodeJS.Platform, home: string): string[] {
	const executable = platform === 'win32' ? 'adb.exe' : 'adb';
	const roots: string[] = [];
	for (const name of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
		const value = env[name];
		if (value && isAbsolute(value)) {
			roots.push(value);
		}
	}
	if (platform === 'darwin') {
		roots.push(join(home, 'Library', 'Android', 'sdk'));
	} else if (platform === 'win32') {
		const localAppData = env.LOCALAPPDATA;
		if (localAppData && isAbsolute(localAppData)) {
			roots.push(join(localAppData, 'Android', 'Sdk'));
		}
	} else {
		roots.push(join(home, 'Android', 'Sdk'));
	}
	const pathEntries = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(entry => entry && isAbsolute(entry));
	return [...roots.map(root => join(root, 'platform-tools', executable)), ...pathEntries.map(entry => join(entry, executable))];
}

/** 失敗の理由として返す出力（長すぎる分は切る）。 */
function describeFailure(label: string, result: IParadisMobileCommandResult): string {
	const output = (result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`).slice(0, 500);
	return `${label} failed: ${output}`;
}

/** インストールの前に確かめたファイル。 */
export interface IParadisMobileInstallTarget {
	/** シンボリックリンクを解いた実際のパス（コマンドにはこちらを渡す）。 */
	readonly path: string;
	readonly kind: ParadisMobileInstallKind;
}

const INSTALL_TIMEOUT_MS = 50_000;
const COMMAND_TIMEOUT_MS = 20_000;

/**
 * `xcrun simctl` / `adb` の呼び出し。端末の番号・アプリの ID・権限名は、呼び出す側で形を確かめた値を渡す。
 */
export class ParadisMobileDeviceCommands {

	private _adb: string | undefined;

	constructor(
		private readonly _run: ParadisMobileCommandRunner = paradisExecFileMobileCommand,
		private readonly _files: IParadisMobileFileProbe = paradisNodeMobileFileProbe,
		private readonly _env: { readonly [name: string]: string | undefined } = process.env,
		private readonly _platform: NodeJS.Platform = process.platform,
		private readonly _home: string = homedir(),
		private readonly _staging: IParadisMobileStagingFs = paradisNodeMobileStagingFs,
	) { }

	/**
	 * インストールするパスを確かめる。
	 * **これはセキュリティの境界ではない**: 確かめた後、simctl / adb が読むまでの間にパスを差し替えられるし、
	 * `.app` の中身も見ていない。利用者に分かりやすいエラーを返すためのもので、守りはインストールごとの承認が担う。絶対パスで、実在し、種類（`.app` はフォルダで中に `Info.plist`、
	 * `.ipa` / `.apk` は普通のファイル）がその端末に合うものだけを通す。拡張子はリンクを解いた先でも見る。
	 * 通らなければ理由の英文を投げる。
	 */
	async resolveInstallTarget(platform: ParadisMobilePlatform, path: unknown): Promise<IParadisMobileInstallTarget> {
		if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
			throw new Error('"path" must be a non-empty string.');
		}
		// UNC（`\\host\share`、`\\?\`、`//host`）は断る。`realpath` だけで SMB へ繋ぎ、認証情報を送りうるため
		if (/^[\\/]{2}/.test(path)) {
			throw new Error('"path" must be on a local disk, not a network share.');
		}
		if (!isAbsolute(path)) {
			throw new Error('"path" must be an absolute path on this computer.');
		}
		const expected = platform === 'ios' ? 'a .app bundle or an .ipa file' : 'an .apk file';
		if (!paradisMobileInstallKindFor(platform, path)) {
			throw new Error(`This ${platform === 'ios' ? 'iOS simulator' : 'Android emulator'} can only install ${expected}.`);
		}
		let real: string;
		try {
			real = await this._files.realpath(path);
		} catch {
			throw new Error(`Nothing exists at ${path}.`);
		}
		const kind = paradisMobileInstallKindFor(platform, real);
		if (!kind) {
			throw new Error(`${path} resolves to a file that is not ${expected}.`);
		}
		const found = await this._files.kind(real);
		if (kind === 'app') {
			if (found !== 'directory' || await this._files.kind(join(real, 'Info.plist')) !== 'file') {
				throw new Error(`${path} is not an app bundle (a folder ending in .app with an Info.plist inside).`);
			}
		} else if (found !== 'file') {
			throw new Error(`${path} is not a regular file.`);
		}
		return { path: real, kind };
	}

	async install(platform: ParadisMobilePlatform, deviceId: string, target: IParadisMobileInstallTarget, signal?: AbortSignal): Promise<void> {
		if (platform === 'ios') {
			const result = await this._run(this._xcrun(), ['simctl', 'install', deviceId, target.path], { timeoutMs: INSTALL_TIMEOUT_MS, signal });
			if (result.code !== 0) {
				throw new Error(describeFailure('simctl install', result));
			}
			return;
		}
		// -r: 入っていれば入れ直す（データは残る）
		const result = await this._run(await this._adbPath(), ['-s', deviceId, 'install', '-r', target.path], { timeoutMs: INSTALL_TIMEOUT_MS, signal });
		// adb install は失敗しても 0 で終わり、出力に Failure と書くことがある
		if (result.code !== 0 || !/\bSuccess\b/.test(result.stdout) || /Failure/i.test(`${result.stdout}${result.stderr}`)) {
			throw new Error(describeFailure('adb install', result));
		}
	}

	/**
	 * インストールするものを Para Code だけが書ける一時フォルダ（0700）へ写し、写しから中身（ID と名前）を読む。
	 * 承認ダイアログにはこの中身を出し、インストールするのも写し。終わったら `dispose()` で消す。
	 */
	async stageInstall(target: IParadisMobileInstallTarget, signal?: AbortSignal): Promise<IParadisMobileStagedInstall> {
		const dir = await this._staging.makePrivateDir();
		const dispose = () => this._staging.remove(dir);
		try {
			const path = join(dir, basename(target.path));
			await this._staging.copy(target.path, path, signal);
			const staged = { path, kind: target.kind };
			const [appId, appName] = target.kind === 'app'
				? [await this._readPlistString(path, 'CFBundleIdentifier', signal), await this._readPlistString(path, 'CFBundleDisplayName', signal) ?? await this._readPlistString(path, 'CFBundleName', signal)]
				: target.kind === 'apk' ? [await this._readApkPackage(path, signal), undefined] : [undefined, undefined];
			return { ...staged, appId, appName, dispose };
		} catch (error) {
			await dispose().catch(() => undefined);
			throw error;
		}
	}

	private async _readPlistString(app: string, key: string, signal?: AbortSignal): Promise<string | undefined> {
		if (this._platform !== 'darwin') {
			return undefined;
		}
		const result = await this._run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(app, 'Info.plist')], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
		const value = result.stdout.trim();
		return result.code === 0 && value ? value : undefined;
	}

	/** SDK の build-tools の aapt2 でパッケージ名を読む（adb と同じ SDK の、いちばん新しい版）。無ければ undefined。 */
	private async _readApkPackage(apk: string, signal?: AbortSignal): Promise<string | undefined> {
		let adb: string;
		try {
			adb = await this._adbPath();
		} catch {
			return undefined;
		}
		const buildTools = join(dirname(dirname(adb)), 'build-tools');
		const versions = (await this._staging.list(buildTools)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
		const executable = this._platform === 'win32' ? 'aapt2.exe' : 'aapt2';
		for (const version of versions) {
			const aapt2 = join(buildTools, version, executable);
			if (await this._files.kind(aapt2) !== 'file') {
				continue;
			}
			const result = await this._run(aapt2, ['dump', 'packagename', apk], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
			const value = result.stdout.trim();
			return result.code === 0 && /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value) ? value : undefined;
		}
		return undefined;
	}

	async launch(platform: ParadisMobilePlatform, deviceId: string, appId: string, relaunch: boolean, signal?: AbortSignal): Promise<void> {
		if (platform === 'ios') {
			const args = ['simctl', 'launch', ...(relaunch ? ['--terminate-running-process'] : []), deviceId, appId];
			const result = await this._run(this._xcrun(), args, { timeoutMs: COMMAND_TIMEOUT_MS, signal });
			if (result.code !== 0) {
				throw new Error(describeFailure('simctl launch', result));
			}
			return;
		}
		const adb = await this._adbPath();
		if (relaunch) {
			const stopped = await this._run(adb, ['-s', deviceId, 'shell', 'am', 'force-stop', appId], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
			if (stopped.code !== 0) {
				throw new Error(describeFailure('adb am force-stop', stopped));
			}
		}
		// 起動する Activity の名前を知らなくてよいよう、LAUNCHER の入口を1回だけ叩く
		const result = await this._run(adb, ['-s', deviceId, 'shell', 'monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1'], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
		if (result.code !== 0 || /No activities found|monkey aborted/i.test(`${result.stdout}${result.stderr}`)) {
			throw new Error(describeFailure('adb launch', result));
		}
	}

	/**
	 * そのアプリがその端末でどういう扱いか（名前ではなく端末に聞く）。
	 * iOS は `simctl listapps` の `ApplicationType`、Android は `pm list packages -3`（利用者が入れたもの）に入っているか。
	 */
	async appKind(platform: ParadisMobilePlatform, deviceId: string, appId: string, signal?: AbortSignal): Promise<ParadisMobileAppKind> {
		if (platform === 'ios') {
			const result = await this._run(this._xcrun(), ['simctl', 'listapps', deviceId], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
			if (result.code !== 0) {
				throw new Error(describeFailure('simctl listapps', result));
			}
			const type = paradisListappsApplicationType(result.stdout, appId);
			return type === undefined ? 'missing' : type === 'User' ? 'user' : 'system';
		}
		const adb = await this._adbPath();
		const user = await this._run(adb, ['-s', deviceId, 'shell', 'pm', 'list', 'packages', '-3'], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
		if (user.code !== 0) {
			throw new Error(describeFailure('adb pm list packages', user));
		}
		if (paradisPackageListIncludes(user.stdout, appId)) {
			return 'user';
		}
		const path = await this._run(adb, ['-s', deviceId, 'shell', 'pm', 'path', appId], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
		return path.code === 0 && /^package:/m.test(path.stdout) ? 'system' : 'missing';
	}

	/** その端末のそのアプリへ1つの権限を付ける（取り消し・全部の初期化はしない）。 */
	async grantPermission(platform: ParadisMobilePlatform, deviceId: string, appId: string, permission: string, signal?: AbortSignal): Promise<void> {
		if (platform === 'ios') {
			const result = await this._run(this._xcrun(), ['simctl', 'privacy', deviceId, 'grant', permission, appId], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
			if (result.code !== 0) {
				throw new Error(describeFailure('simctl privacy grant', result));
			}
			return;
		}
		const adb = await this._adbPath();
		// 付けてよいのは実行時の確認が出る dangerous 権限だけ（development 権限の WRITE_SECURE_SETTINGS・READ_LOGS などは断る）
		const listed = await this._run(adb, ['-s', deviceId, 'shell', 'pm', 'list', 'permissions', '-g', '-d'], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
		if (listed.code !== 0) {
			throw new Error(describeFailure('adb pm list permissions', listed));
		}
		if (!paradisParseDangerousPermissions(listed.stdout).has(permission)) {
			throw new Error(`${permission} is not a runtime (dangerous) permission on this device, so Para Code does not grant it.`);
		}
		const result = await this._run(adb, ['-s', deviceId, 'shell', 'pm', 'grant', appId, permission], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
		// pm grant も失敗を出力にだけ書くことがある
		if (result.code !== 0 || /Exception|not a changeable permission|Unknown permission/i.test(`${result.stdout}${result.stderr}`)) {
			throw new Error(describeFailure('adb pm grant', result));
		}
	}

	private _xcrun(): string {
		if (this._platform !== 'darwin') {
			throw new Error('iOS simulators are only available on macOS.');
		}
		// PATH を見ずに固定のパスを使う（GUI から起動した Para Code の PATH は利用者のシェルと違う）
		return '/usr/bin/xcrun';
	}

	/** 見つかった adb の絶対パス。見つからなければ投げ、覚えない（後から SDK を入れても再起動なしで使えるように）。 */
	private async _adbPath(): Promise<string> {
		if (this._adb === undefined) {
			for (const candidate of paradisAdbCandidates(this._env, this._platform, this._home)) {
				if (await this._files.kind(candidate) === 'file') {
					this._adb = candidate;
					break;
				}
			}
		}
		if (this._adb === undefined) {
			throw new Error('Para Code could not find adb. Install the Android SDK platform-tools, or set ANDROID_HOME for Para Code, and try again.');
		}
		return this._adb;
	}
}
