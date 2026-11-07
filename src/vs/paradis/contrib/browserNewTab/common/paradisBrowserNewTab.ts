/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの新しいタブ: 待ち受けのポートを「このスペース」「ほかのスペース」「Para Code の外」に分ける。
// 決め手はポートを持つプロセスの作業フォルダ（cwd）で、いちばん深く一致したスペースに入れる。
// スペースのフォルダがホームや / のときは、無関係なプロセスまで拾うので一致に使わない。

import { IParadisPortServerEntry } from '../../portList/common/paradisPortList.js';

export interface IParadisNewTabSpace {
	/** スペースの状態キー（リポジトリ ID か worktree のキー）。 */
	readonly key: string;
	/** 見出しや行に出す名前（「リポジトリ / ブランチ」）。 */
	readonly label: string;
	/** cwd と突き合わせるルートのパス（接続先なら接続先から見た POSIX のパス）。 */
	readonly rootPath: string;
}

export interface IParadisNewTabServer {
	readonly port: number;
	/** 待ち受けのアドレス（ページを読みに行く先を決める）。 */
	readonly address: string;
	readonly processName: string;
	readonly pid: number;
	/** 属するスペース。Para Code の外なら undefined。 */
	readonly space: IParadisNewTabSpace | undefined;
}

export interface IParadisNewTabServerGroups {
	/** このスペースのもの（ポートの小さい順）。 */
	readonly current: readonly IParadisNewTabServer[];
	/** ほかのスペースのもの。 */
	readonly otherSpaces: readonly IParadisNewTabServer[];
	/** どのスペースのフォルダの下でも動いていないもの。 */
	readonly outside: readonly IParadisNewTabServer[];
}

function trimTrailingSeparators(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, '');
	return trimmed === '' ? path.slice(0, 1) : trimmed;
}

function normalizeForCompare(path: string, caseInsensitive: boolean): string {
	const unified = trimTrailingSeparators(path.replace(/\\/g, '/'));
	return caseInsensitive ? unified.toLowerCase() : unified;
}

/** `cwd` が `root` そのものか、その下にあるか（パスの区切りで判定する）。 */
export function paradisIsPathInside(cwd: string, root: string, caseInsensitive = false): boolean {
	const c = normalizeForCompare(cwd, caseInsensitive);
	const r = normalizeForCompare(root, caseInsensitive);
	return c === r || c.startsWith(r.endsWith('/') ? r : `${r}/`);
}

/** ホーム・/・ドライブの直下のように広すぎて、cwd での判定に使えないフォルダか。 */
export function paradisIsTooBroadRoot(root: string, homeDir: string, caseInsensitive = false): boolean {
	const r = normalizeForCompare(root, caseInsensitive);
	if (r === '/' || r === '' || /^[a-z]:\/?$/i.test(r)) {
		return true;
	}
	return homeDir !== '' && r === normalizeForCompare(homeDir, caseInsensitive);
}

/** cwd がいちばん深く一致するスペース。 */
export function paradisSpaceForCwd(cwd: string | undefined, spaces: readonly IParadisNewTabSpace[], homeDir: string, caseInsensitive = false): IParadisNewTabSpace | undefined {
	if (!cwd) {
		return undefined;
	}
	let best: IParadisNewTabSpace | undefined;
	for (const space of spaces) {
		if (paradisIsTooBroadRoot(space.rootPath, homeDir, caseInsensitive) || !paradisIsPathInside(cwd, space.rootPath, caseInsensitive)) {
			continue;
		}
		if (!best || normalizeForCompare(space.rootPath, caseInsensitive).length > normalizeForCompare(best.rootPath, caseInsensitive).length) {
			best = space;
		}
	}
	return best;
}

/**
 * 待ち受けのポートを分ける。同じポートを IPv4 と IPv6 で 2 回待ち受けているもの・親子のプロセスが
 * 同じソケットを持つものは 1 行にまとめる（先に来た持ち主を使う）。
 */
export function paradisGroupNewTabServers(
	entries: readonly IParadisPortServerEntry[],
	spaces: readonly IParadisNewTabSpace[],
	currentSpaceKey: string | undefined,
	homeDir: string,
	caseInsensitive = false,
): IParadisNewTabServerGroups {
	const byPort = new Map<number, IParadisNewTabServer>();
	for (const entry of [...entries].sort((a, b) => a.port - b.port || a.pid - b.pid)) {
		if (entry.proto !== 'TCP') {
			continue;
		}
		const existing = byPort.get(entry.port);
		const space = paradisSpaceForCwd(entry.cwd, spaces, homeDir, caseInsensitive);
		// まとめるときは、スペースが分かっている持ち主を優先する（シェルの親が cwd を持たないことがある）
		if (existing && (existing.space || !space)) {
			continue;
		}
		byPort.set(entry.port, { port: entry.port, address: entry.address, processName: entry.processName, pid: entry.pid, space });
	}
	const current: IParadisNewTabServer[] = [];
	const otherSpaces: IParadisNewTabServer[] = [];
	const outside: IParadisNewTabServer[] = [];
	for (const server of byPort.values()) {
		if (!server.space) {
			outside.push(server);
		} else if (server.space.key === currentSpaceKey) {
			current.push(server);
		} else {
			otherSpaces.push(server);
		}
	}
	return { current, otherSpaces, outside };
}

/** 一覧に出すアドレス（`localhost:5173`）。 */
export function paradisNewTabServerAddress(port: number): string {
	return `localhost:${port}`;
}
