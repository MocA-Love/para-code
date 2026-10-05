/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// wait_until の network idle のための、共有中のタブの通信の出入りの台帳（ペインごと）。
// CDP ゲートウェイ（paradisCdpFilterProxy.ts）が、内蔵 chrome-devtools-mcp（puppeteer）へ流す
// Network.* のイベントのうち、共有中のタブとその iframe・worker のセッションのものだけを渡す。
// puppeteer はページのセッションで Network.enable するので、puppeteer が接続している間だけ数えられる。
//
// 決め事:
// - 1 つの要求は「target:requestId」で数える（同じ target に複数のセッション・接続があっても二重にしない）
// - 開始は requestWillBeSent（リダイレクトでは増えない）、終わりは loadingFinished / loadingFailed
// - 接続が閉じたら、その接続で始まった要求は台帳から外す（終わりのイベントがもう来ないため）
// - 上限を超えたら古いものから捨てる

const MAX_INFLIGHT = 2000;
const MAX_URL = 200;

interface IInflight {
	readonly startedAt: number;
	readonly url: string;
	readonly connection: object;
}

/** ある時点の通信の様子。 */
export interface IParadisNetworkActivitySnapshot {
	/** 終わっていない要求（`ignoreOlderThanMs` より古いものは数えない）。 */
	readonly inflight: number;
	/** 最後に要求が始まった・終わった時刻からの経過。まだ何も見ていなければ undefined。 */
	readonly quietMs: number | undefined;
	/** 終わっていない要求の URL（先頭のいくつか）。 */
	readonly pendingUrls: readonly string[];
	/** 数えなかった長く続く要求（ストリーミング・ロングポーリング）。 */
	readonly longLived: number;
}

/** 1 ペインの台帳。 */
export class ParadisNetworkActivity {
	private readonly _inflight = new Map<string, IInflight>();
	private _lastActivityAt: number | undefined;

	constructor(private readonly _now: () => number = Date.now) { }

	/** ゲートウェイから。`targetId` はイベントが来たセッションの target。 */
	onEvent(connection: object, targetId: string, method: string, params: unknown): void {
		const requestId = (params as { requestId?: unknown } | undefined)?.requestId;
		if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 200) {
			return;
		}
		const key = `${targetId}:${requestId}`;
		switch (method) {
			case 'Network.requestWillBeSent': {
				this._lastActivityAt = this._now();
				if (!this._inflight.has(key)) {
					if (this._inflight.size >= MAX_INFLIGHT) {
						this._inflight.delete(this._inflight.keys().next().value!);
					}
					const url = (params as { request?: { url?: unknown } }).request?.url;
					this._inflight.set(key, { startedAt: this._lastActivityAt, url: typeof url === 'string' ? url.slice(0, MAX_URL) : '', connection });
				}
				return;
			}
			case 'Network.responseReceived':
			case 'Network.dataReceived':
				if (this._inflight.has(key)) {
					this._lastActivityAt = this._now();
				}
				return;
			case 'Network.loadingFinished':
			case 'Network.loadingFailed':
				if (this._inflight.delete(key)) {
					this._lastActivityAt = this._now();
				}
				return;
		}
	}

	/** 接続が閉じた。その接続で始まった要求の終わりはもう来ない。 */
	forgetConnection(connection: object): void {
		for (const [key, entry] of this._inflight) {
			if (entry.connection === connection) {
				this._inflight.delete(key);
			}
		}
	}

	/** 共有の相手が変わった。 */
	reset(): void {
		this._inflight.clear();
		this._lastActivityAt = undefined;
	}

	snapshot(ignoreOlderThanMs: number): IParadisNetworkActivitySnapshot {
		const now = this._now();
		let inflight = 0;
		let longLived = 0;
		const pendingUrls: string[] = [];
		for (const entry of this._inflight.values()) {
			if (now - entry.startedAt > ignoreOlderThanMs) {
				longLived++;
				continue;
			}
			inflight++;
			if (pendingUrls.length < 5) {
				pendingUrls.push(entry.url);
			}
		}
		return { inflight, quietMs: this._lastActivityAt === undefined ? undefined : now - this._lastActivityAt, pendingUrls, longLived };
	}
}

/** ゲートウェイが持つ、ペインごとの台帳。 */
export class ParadisNetworkActivityRegistry {
	private readonly _byToken = new Map<string, ParadisNetworkActivity>();

	constructor(private readonly _now: () => number = Date.now) { }

	forAuthority(token: string): ParadisNetworkActivity {
		let activity = this._byToken.get(token);
		if (!activity) {
			activity = new ParadisNetworkActivity(this._now);
			this._byToken.set(token, activity);
		}
		return activity;
	}

	get(token: string): ParadisNetworkActivity | undefined {
		return this._byToken.get(token);
	}

	retire(token: string): void {
		this._byToken.delete(token);
	}

	dispose(): void {
		this._byToken.clear();
	}
}

/**
 * セッションを親へたどって、トップのセッションの target を返す（iframe・worker のイベントを、
 * それを載せたタブに帰属させる）。たどれなければ undefined。
 */
export function paradisRootTargetOfSession(sessionId: string, parentOf: ReadonlyMap<string, string | undefined>, targetOf: ReadonlyMap<string, string>): string | undefined {
	let current = sessionId;
	for (let depth = 0; depth < 32; depth++) {
		const parent = parentOf.get(current);
		if (parent === undefined) {
			return targetOf.get(current);
		}
		current = parent;
	}
	return undefined;
}
