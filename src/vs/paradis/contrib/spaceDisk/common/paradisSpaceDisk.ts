/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スペース(リポジトリ/worktree)がディスクをどれだけ使っているかの型と契約。
// 計測の実体は node/paradisSpaceDiskChannel.ts、呼ぶ側は electron-browser/ の client。

import { ParadisHostPath } from '../../../common/paradisHostPath.js';

export const PARADIS_SPACE_DISK_CHANNEL = 'paradisSpaceDisk';

/** IPC の setWarmLease command が受け取る owner-scoped snapshot。`TPath` は {@link IParadisSpaceDiskTarget} と同じ意味。 */
export type ParadisSpaceDiskWarmLeasePayload<TPath extends string = ParadisHostPath> = Readonly<{
	readonly ownerId: string;
	readonly active: boolean;
	readonly targets: readonly IParadisSpaceDiskTarget<TPath>[];
}>;

/**
 * 計測してほしいスペース1件。パスは呼ぶ側(renderer)が解決して渡す。
 *
 * 既定の `TPath` は {@link ParadisHostPath}。**送る側（renderer）は何も書き足さなくてよく**、
 * パスを `paradisResolveHostPath` 経由で作らない限り型エラーになる。
 * 電文を受け取って検証する側（node）だけが `IParadisSpaceDiskTarget<string>` と明示して、
 * 検証前の素の文字列を扱う。
 */
export interface IParadisSpaceDiskTarget<TPath extends string = ParadisHostPath> {
	/** スペースの識別子(リポジトリのid、またはworktreeのstateKey)。 */
	readonly stateKey: string;
	/** 画面に出す名前。 */
	readonly name: string;
	/** 実ファイルシステム上のパス。 */
	readonly path: TPath;
	/**
	 * このスペースに属する worktree のパス。
	 *
	 * **場所は決め打ちしない**。`git worktree list` が返した実際のパスをそのまま渡すこと。
	 * 親フォルダの中に置く人もいれば外に置く人もいて、WSL の UNC パスのこともある。
	 * 親の中にあるものは親の集計に含まれてしまうので、計測側で引いて二重計上を防ぐ。
	 */
	readonly worktrees: readonly IParadisSpaceDiskWorktree<TPath>[];
}

export interface IParadisSpaceDiskWorktree<TPath extends string = ParadisHostPath> {
	readonly stateKey: string;
	readonly name: string;
	readonly path: TPath;
}

/** 1スペースぶんの計測結果。 */
export interface IParadisSpaceDiskEntry {
	readonly stateKey: string;
	readonly name: string;
	/** 親のうち worktree を除いたバイト数(worktree が親の中にある場合はそのぶん引いてある)。 */
	readonly ownBytes: number;
	readonly worktrees: readonly IParadisSpaceDiskWorktreeEntry[];
	/** 読めなかった場合の理由(フォルダが消えている等)。値は 0 になる。 */
	readonly error?: string;
	/** 上限に達して数え切れなかった。値は「少なくともこれだけ」の意味になる。 */
	readonly truncated?: boolean;
}

export interface IParadisSpaceDiskWorktreeEntry {
	readonly stateKey: string;
	readonly name: string;
	readonly bytes: number;
	/** 親フォルダの外に置かれている worktree（親から引く必要がない）。 */
	readonly outside: boolean;
	readonly error?: string;
	/** 上限に達して数え切れなかった。 */
	readonly truncated?: boolean;
}

export interface IParadisSpaceDiskResult {
	readonly spaces: readonly IParadisSpaceDiskEntry[];
	/** 計測が終わった時刻(epoch ms)。画面に「〇分前に計測」と出すために使う。 */
	readonly measuredAt: number;
	/** 計測にかかった時間(ms)。 */
	readonly durationMs: number;
}

export interface IParadisSpaceDiskService {
	readonly _serviceBrand: undefined;
	/** owner の warm snapshot を更新する。`active: false` は owner を release する。 */
	setWarmLease(ownerId: string, active: boolean, targets: readonly IParadisSpaceDiskTarget[]): void;
	/**
	 * スペースの容量を返す。既定ではキャッシュ済みの値を即座に返し、
	 * `bypassCache` のときだけ測り直す(1周に数十秒かかる)。
	 */
	measure(targets: readonly IParadisSpaceDiskTarget[], bypassCache?: boolean): Promise<IParadisSpaceDiskResult>;
}

/**
 * 親のパスの中に子のパスがあるか。
 *
 * 単純な `startsWith` だと `/a/foo` と `/a/foobar` を親子と誤判定するので、
 * 区切り文字までを見る。Windows のドライブレターと `\` 区切り、WSL の UNC
 * (`\\wsl.localhost\...`) も同じ規則で比べられるよう、区切りを `/` に寄せてから判定する。
 * 大文字小文字は Windows と macOS の既定では区別されないため、比較時に落とす。
 */
export function isPathInside(child: string, parent: string): boolean {
	const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	const c = norm(child);
	const p = norm(parent);
	return c !== p && c.startsWith(`${p}/`);
}
