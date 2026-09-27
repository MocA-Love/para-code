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
import { realpath, stat } from 'fs/promises';
import { homedir } from 'os';
import { isAbsolute, join } from '../../../../base/common/path.js';
import { ParadisMobileInstallKind, ParadisMobilePlatform, paradisMobileInstallKindFor } from '../common/paradisMobileDeviceOps.js';

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

/** adb の置き場所の候補（先に見つかったものを使う。どれも無ければ PATH の `adb`）。 */
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
	return roots.map(root => join(root, 'platform-tools', executable));
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

	private _adb: Promise<string> | undefined;

	constructor(
		private readonly _run: ParadisMobileCommandRunner = paradisExecFileMobileCommand,
		private readonly _files: IParadisMobileFileProbe = paradisNodeMobileFileProbe,
		private readonly _env: { readonly [name: string]: string | undefined } = process.env,
		private readonly _platform: NodeJS.Platform = process.platform,
		private readonly _home: string = homedir(),
	) { }

	/**
	 * インストールするパスを確かめる。絶対パスで、実在し、種類（`.app` はフォルダで中に `Info.plist`、
	 * `.ipa` / `.apk` は普通のファイル）がその端末に合うものだけを通す。拡張子はリンクを解いた先でも見る。
	 * 通らなければ理由の英文を投げる。
	 */
	async resolveInstallTarget(platform: ParadisMobilePlatform, path: unknown): Promise<IParadisMobileInstallTarget> {
		if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
			throw new Error('"path" must be a non-empty string.');
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

	/** `.app` の Info.plist からバンドル ID を読む（起動に使えるよう返すだけ。読めなければ undefined）。 */
	async readBundleId(target: IParadisMobileInstallTarget, signal?: AbortSignal): Promise<string | undefined> {
		if (target.kind !== 'app' || this._platform !== 'darwin') {
			return undefined;
		}
		const result = await this._run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(target.path, 'Info.plist')], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
		const value = result.stdout.trim();
		return result.code === 0 && value ? value : undefined;
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

	/** そのアプリがその端末に入っているか。 */
	async isInstalled(platform: ParadisMobilePlatform, deviceId: string, appId: string, signal?: AbortSignal): Promise<boolean> {
		if (platform === 'ios') {
			const result = await this._run(this._xcrun(), ['simctl', 'get_app_container', deviceId, appId, 'app'], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
			return result.code === 0 && result.stdout.trim().length > 0;
		}
		const result = await this._run(await this._adbPath(), ['-s', deviceId, 'shell', 'pm', 'path', appId], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
		return result.code === 0 && /^package:/m.test(result.stdout);
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
		const result = await this._run(await this._adbPath(), ['-s', deviceId, 'shell', 'pm', 'grant', appId, permission], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
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

	private _adbPath(): Promise<string> {
		this._adb ??= (async () => {
			for (const candidate of paradisAdbCandidates(this._env, this._platform, this._home)) {
				if (await this._files.kind(candidate) === 'file') {
					return candidate;
				}
			}
			return this._platform === 'win32' ? 'adb.exe' : 'adb';
		})();
		return this._adb;
	}
}
