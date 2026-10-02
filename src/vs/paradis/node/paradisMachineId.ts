/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「この機械」の印。モバイルが複数の PC の使用量を合計するとき、PC の SSH 先が別のペアリング済みの
// PC と同じ機械か（同じ値を二重に数えないか）を見分けるために使う。
//
// VS Code の machineId（telemetry の値）は使わない。あれはインストールごとに保存された値で、
// 同じ機械で動く PC 版と REH サーバーとで一致しない。OS が持つ機械の ID なら、PC 版（shared process）と
// SSH 先の REH サーバーが同じ計算をすれば同じ値になる。
//
// 生の ID は外へ出さず、`sha256('para-code-machine-v1:' + id + ':' + OS のユーザー名)` の hex だけを出す。
// ユーザー名を混ぜるのは、同じ機械の別のユーザーへの SSH を別の相手として数えるため（ccusage・rtk・
// gh の値はユーザーのホームにあるので、ユーザーが違えば中身も違う）。
// Linux のコンテナの中では印を出さない。コンテナは /etc/machine-id をイメージから受け継ぐので、
// 無関係なコンテナどうし・ホストと同じ値になりうる。

import * as cp from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { win32 } from '../../base/common/path.js';

const MACHINE_ID_PREFIX = 'para-code-machine-v1:';
const READ_TIMEOUT_MS = 10_000;

/** 機械 ID の読み元。テストで差し替える。 */
export interface IParadisMachineIdSources {
	readonly platform: NodeJS.Platform;
	/** コマンドを実行して stdout を返す（失敗は reject）。 */
	readonly execFile: (file: string, args: readonly string[]) => Promise<string>;
	/** ファイルを読む（無ければ reject）。 */
	readonly readFile: (filePath: string) => Promise<string>;
	/** ファイルがあるか。 */
	readonly fileExists: (filePath: string) => Promise<boolean>;
	/** OS のユーザー名（読めなければ undefined）。 */
	readonly username: () => string | undefined;
	readonly env: NodeJS.ProcessEnv;
}

/** 正規化した機械 ID と OS のユーザー名からモバイルへ出す印を作る。 */
export function paradisMachineIdHash(machineId: string, username: string): string {
	return createHash('sha256').update(`${MACHINE_ID_PREFIX}${machineId}:${username}`).digest('hex');
}

/** Linux のコンテナの中か（docker・podman・containerd・Kubernetes・LXC の印、ルートが overlay）。 */
export async function paradisIsInLinuxContainer(sources: Pick<IParadisMachineIdSources, 'fileExists' | 'readFile' | 'env'>): Promise<boolean> {
	if (sources.env.KUBERNETES_SERVICE_HOST) {
		return true;
	}
	for (const marker of ['/.dockerenv', '/run/.containerenv', '/run/secrets/kubernetes.io']) {
		if (await sources.fileExists(marker)) {
			return true;
		}
	}
	try {
		if (/docker|containerd|kubepods|libpod|podman|lxc/i.test(await sources.readFile('/proc/1/cgroup'))) {
			return true;
		}
	} catch {
		// 読めなければ次へ
	}
	try {
		return paradisIsOverlayRoot(await sources.readFile('/proc/1/mountinfo'));
	} catch {
		return false;
	}
}

/**
 * `/proc/1/mountinfo` で `/` が overlay か（コンテナのルートの典型）。行の形は
 * `ID 親 major:minor root マウント先 オプション... - 種類 元 ...`。
 */
export function paradisIsOverlayRoot(mountinfo: string): boolean {
	return mountinfo.split('\n').some(line => {
		const [mountFields, fsFields] = line.split(' - ');
		return mountFields?.split(' ')[4] === '/' && fsFields?.split(' ')[0] === 'overlay';
	});
}

/**
 * 前後の空白を落として小文字にする。使えない値（空、すべて 0 や - だけの仮の値）は undefined。
 * 仮想マシンには全部 0 の UUID を返すものがあり、それを印にすると無関係な機械どうしが同じになる。
 */
export function paradisNormalizeMachineId(raw: string | undefined): string | undefined {
	const value = raw?.trim().toLowerCase();
	if (!value || value.length > 256 || /^[0\-]+$/.test(value)) {
		return undefined;
	}
	return value;
}

/** `ioreg -rd1 -c IOPlatformExpertDevice` の出力から IOPlatformUUID を取り出す。 */
export function paradisParseIoregPlatformUuid(output: string): string | undefined {
	return /"IOPlatformUUID"\s*=\s*"(?<uuid>[^"]+)"/.exec(output)?.groups?.uuid;
}

/** `reg query ... /v MachineGuid` の出力から値を取り出す。 */
export function paradisParseWindowsMachineGuid(output: string): string | undefined {
	return /MachineGuid\s+REG_SZ\s+(?<guid>\S+)/i.exec(output)?.groups?.guid;
}

/** OS の機械 ID を読む。読めなければ undefined（例外は投げない）。 */
export async function paradisReadOsMachineId(sources: IParadisMachineIdSources): Promise<string | undefined> {
	try {
		switch (sources.platform) {
			case 'darwin':
				return paradisNormalizeMachineId(paradisParseIoregPlatformUuid(await sources.execFile('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])));
			case 'win32': {
				const systemRoot = sources.env.SystemRoot || sources.env.windir || 'C:\\Windows';
				// 32 ビットのプロセスから読んでも WOW64 の別の場所へ振り替えられないよう /reg:64 を付ける
				const output = await sources.execFile(win32.join(systemRoot, 'System32', 'reg.exe'), ['query', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64']);
				return paradisNormalizeMachineId(paradisParseWindowsMachineGuid(output));
			}
			default:
				for (const candidate of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
					try {
						const value = paradisNormalizeMachineId(await sources.readFile(candidate));
						if (value !== undefined) {
							return value;
						}
					} catch {
						// 次の候補へ
					}
				}
				return undefined;
		}
	} catch {
		return undefined;
	}
}

/** 機械の印を求める。読めない・コンテナの中・ユーザー名が分からないときは undefined。 */
export async function paradisReadMachineIdHash(sources: IParadisMachineIdSources): Promise<string | undefined> {
	if (sources.platform === 'linux' && await paradisIsInLinuxContainer(sources)) {
		return undefined;
	}
	const machineId = await paradisReadOsMachineId(sources);
	let username: string | undefined;
	try {
		username = sources.username()?.trim();
	} catch {
		username = undefined;
	}
	return machineId === undefined || !username ? undefined : paradisMachineIdHash(machineId, username);
}

function defaultSources(): IParadisMachineIdSources {
	return {
		platform: process.platform,
		env: process.env,
		execFile: (file, args) => new Promise<string>((resolve, reject) => {
			cp.execFile(file, [...args], { encoding: 'utf8', timeout: READ_TIMEOUT_MS, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout));
		}),
		readFile: filePath => fs.promises.readFile(filePath, 'utf8'),
		fileExists: filePath => fs.promises.access(filePath).then(() => true, () => false),
		username: () => os.userInfo().username,
	};
}

let cachedMachineIdHash: Promise<string | undefined> | undefined;

/**
 * このプロセスが動いている機械の印。プロセスの中で1回だけ読む（機械の ID は動いている間に変わらない）。
 * 読めなかったとき（undefined）は覚えずに、次に聞かれたときに読み直す。
 */
export function paradisGetMachineIdHash(): Promise<string | undefined> {
	if (cachedMachineIdHash === undefined) {
		const pending = paradisReadMachineIdHash(defaultSources());
		cachedMachineIdHash = pending;
		pending.then(value => {
			if (value === undefined && cachedMachineIdHash === pending) {
				cachedMachineIdHash = undefined;
			}
		});
	}
	return cachedMachineIdHash;
}
