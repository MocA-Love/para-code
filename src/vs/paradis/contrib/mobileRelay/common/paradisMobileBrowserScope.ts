/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイルのブラウザのページ一覧をスペースで絞るための台帳（browser.space.v1）。
// Renderer がウィンドウごとに「どのブラウザビューがどのスペース（stateKey）のものか」を shared process へ送り、
// shared process のミラーがモバイルの `targets` の `windowId` / `ws` でそれを引いて絞る。

/** 1 ウィンドウぶんの台帳。`stateKey` の無いビューは、スペースを持たないウィンドウのものか、所属が決まっていないもの。 */
export interface IParadisMobileBrowserScopeSnapshot {
	/** スペース（managed workspace）のウィンドウか。そうでなければ `stateKey` の無いビューがそのウィンドウのページ。 */
	readonly managed: boolean;
	readonly views: readonly { readonly viewId: string; readonly stateKey?: string }[];
}

const MAX_VIEWS = 500;
const MAX_ID_LENGTH = 512;
/**
 * スペースの id（stateKey = モバイルの `sourceId`）の上限。worktree の stateKey はパスを含み、日本語のパスは
 * エンコードで 1 文字が 9 文字になるので長い。PC 自身が作る値なので大きく取る。
 */
const MAX_STATE_KEY_LENGTH = 4096;

/** Renderer から届いた台帳を確かめる（形が違えば `undefined`。上限を超えたビューは落とす）。 */
export function paradisSanitizeMobileBrowserScopeSnapshot(value: unknown): IParadisMobileBrowserScopeSnapshot | undefined {
	if (value === null || typeof value !== 'object') {
		return undefined;
	}
	const candidate = value as { managed?: unknown; views?: unknown };
	if (typeof candidate.managed !== 'boolean' || !Array.isArray(candidate.views)) {
		return undefined;
	}
	const views: { viewId: string; stateKey?: string }[] = [];
	for (const entry of candidate.views.slice(0, MAX_VIEWS)) {
		const view = entry as { viewId?: unknown; stateKey?: unknown } | null;
		if (view === null || typeof view !== 'object' || typeof view.viewId !== 'string' || view.viewId.length === 0 || view.viewId.length > MAX_ID_LENGTH) {
			continue;
		}
		const stateKey = typeof view.stateKey === 'string' && view.stateKey.length > 0 && view.stateKey.length <= MAX_STATE_KEY_LENGTH ? view.stateKey : undefined;
		views.push(stateKey !== undefined ? { viewId: view.viewId, stateKey } : { viewId: view.viewId });
	}
	return { managed: candidate.managed, views };
}

/** 台帳の中で、モバイルのスペース `ws`（`sourceId` = stateKey）に属するビュー。 */
export function paradisMobileBrowserViewsInSpace(snapshot: IParadisMobileBrowserScopeSnapshot, ws: string): string[] {
	return snapshot.views
		.filter(view => view.stateKey !== undefined ? view.stateKey === ws : !snapshot.managed)
		.map(view => view.viewId);
}

/** 台帳の署名（無変化なら送らない・同じ台帳を二度処理しないため）。 */
export function paradisMobileBrowserScopeSignature(snapshot: IParadisMobileBrowserScopeSnapshot): string {
	return `${snapshot.managed ? 1 : 0}\u0001${snapshot.views.map(view => `${view.viewId}\u0000${view.stateKey ?? ''}`).sort().join('\u0001')}`;
}

/**
 * `targets` / `start` の要求の `windowId` / `ws`。どちらも無ければ `undefined`（古いアプリ。全件）、
 * 両方あって形が正しければそのスペース、片方だけ・形が違う（長すぎる等）なら `'invalid'`
 * （黙って全件に戻さず、絞れないと返すため）。`ws` の長さの上限は台帳の stateKey と同じ（4096 文字）。
 */
export function paradisMobileBrowserTargetsScope(request: { readonly windowId?: unknown; readonly ws?: unknown }): { readonly windowId: number; readonly ws: string } | 'invalid' | undefined {
	const { windowId, ws } = request;
	if (windowId === undefined && ws === undefined) {
		return undefined;
	}
	return typeof windowId === 'number' && Number.isSafeInteger(windowId) && typeof ws === 'string' && ws.length > 0 && ws.length <= MAX_STATE_KEY_LENGTH
		? { windowId, ws }
		: 'invalid';
}

/** CDP の targetId として受け付ける形（英数字と `-_.`、128 文字まで。URL のパスへそのまま入れるため）。 */
export function paradisIsMobileBrowserTargetId(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}
