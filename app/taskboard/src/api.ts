// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useSyncExternalStore } from 'react';
import type { ITaskBoardNotice, ITaskBoardRpc, ITaskBoardSnapshot, TaskBoardErrorCode, TaskBoardRpcMethod, TaskBoardServerMessage } from '@engine/paradisTaskBoard.js';

/*
 * サーバーとのやりとり。状態はサーバーが送るスナップショットを丸ごと持つ（台帳は小さいので差分にしない）。
 * 受け渡しの口はここだけにしておき、Para Code に載せるときは IPC に差し替える。
 */

const TOKEN_KEY = 'taskboard:token';

/**
 * 鍵は、開いた URL（?token=）から読んでこのオリジン（ポート込み）の localStorage に置き、URL からは消す。
 * Cookie にはしない（Cookie はポートを区別せず、同じ PC の別のポートのサーバーにも送られる）。
 */
function readToken(): string | undefined {
	try {
		const url = new URL(location.href);
		const given = url.searchParams.get('token');
		if (given) {
			localStorage.setItem(TOKEN_KEY, given);
			url.searchParams.delete('token');
			history.replaceState(history.state, '', url.pathname + url.search + url.hash);
			return given;
		}
		return localStorage.getItem(TOKEN_KEY) ?? undefined;
	} catch {
		return undefined;
	}
}

const token = readToken();

function authHeaders(): Record<string, string> {
	return token ? { 'x-taskboard-token': token } : {};
}

/** 画像とモックの URL に付ける読むだけの鍵（スナップショットで届く）。 */
export function withAssetKey(url: string): string {
	const key = state.snapshot?.runtime.assetKey;
	return key ? `${url}${url.includes('?') ? '&' : '?'}k=${encodeURIComponent(key)}` : url;
}

export class RpcError extends Error {
	constructor(readonly code: TaskBoardErrorCode | 'network', message: string) {
		super(message);
	}
}

export async function rpc<M extends TaskBoardRpcMethod>(method: M, params: ITaskBoardRpc[M]['params']): Promise<ITaskBoardRpc[M]['result']> {
	let res: Response;
	try {
		res = await fetch('/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify({ method, params }) });
	} catch (err) {
		throw new RpcError('network', (err as Error).message);
	}
	if (res.status === 401) {
		throw new RpcError('network', 'unauthorized');
	}
	const body = await res.json() as { ok: true; result: ITaskBoardRpc[M]['result'] } | { ok: false; error: { code: TaskBoardErrorCode; message: string } };
	if (!body.ok) {
		throw new RpcError(body.error.code, body.error.message);
	}
	return body.result;
}

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'unauthorized';

interface IState {
	readonly snapshot: ITaskBoardSnapshot | undefined;
	readonly connection: ConnectionState;
	readonly receivedAt: number;
}

let state: IState = { snapshot: undefined, connection: 'connecting', receivedAt: 0 };
const listeners = new Set<() => void>();
const noticeListeners = new Set<(notice: ITaskBoardNotice) => void>();

function set(patch: Partial<IState>): void {
	state = { ...state, ...patch };
	listeners.forEach(l => l());
}

let socket: WebSocket | undefined;
let retry = 0;
let retryTimer: number | undefined;

export function connect(force = false): void {
	if (!force && socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
		return; // 開発時の StrictMode で 2 回呼ばれても、張り直さない
	}
	clearTimeout(retryTimer);
	if (socket) {
		// 古い接続は閉じてから張り直す（二重に通知を受けないように）
		const old = socket;
		socket = undefined;
		old.onclose = null;
		old.onmessage = null;
		old.close();
	}
	if (!token) {
		set({ connection: 'unauthorized' });
		return;
	}
	const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`, ['taskboard', `taskboard.${token}`]); // サーバーは鍵を含まない `taskboard` を選んで返す
	socket = ws;
	set({ connection: 'connecting' });
	ws.onopen = () => {
		retry = 0;
		set({ connection: 'open' });
	};
	ws.onmessage = event => {
		const message = JSON.parse(String(event.data)) as TaskBoardServerMessage;
		if (message.type === 'snapshot') {
			set({ snapshot: message.snapshot, receivedAt: Date.now() });
		} else if (message.type === 'notice') {
			noticeListeners.forEach(l => l(message.notice));
		}
	};
	ws.onclose = () => {
		if (socket !== ws) {
			return;
		}
		set({ connection: 'closed' });
		retry++;
		const delay = Math.min(15000, 500 * 2 ** Math.min(retry, 5));
		retryTimer = window.setTimeout(async () => {
			// 認証切れ（サーバーの再起動でトークンが変わった）は再接続しても通らない
			const health = await fetch('/api/health', { headers: authHeaders() }).catch(() => undefined);
			if (health?.status === 401) {
				set({ connection: 'unauthorized' });
				return;
			}
			connect(true);
		}, delay);
	};
}

export function reconnectNow(): void {
	retry = 0;
	connect(true);
}

export function onNotice(listener: (notice: ITaskBoardNotice) => void): () => void {
	noticeListeners.add(listener);
	return () => noticeListeners.delete(listener);
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useBoard(): IState {
	return useSyncExternalStore(subscribe, () => state);
}

/** スナップショットを受け取ってからの経過で、サーバーの時計に合わせた「今」を返す。 */
export function serverNow(): number {
	const snap = state.snapshot;
	return snap ? snap.now + (Date.now() - state.receivedAt) : Date.now();
}

export function artifactUrl(taskId: string, artifactId: string): string {
	return withAssetKey(`/api/artifacts/${encodeURIComponent(taskId)}/${encodeURIComponent(artifactId)}`);
}

/* ---------------- 詳細のキャッシュ（タブを行き来しても読み直さない） ---------------- */

const detailCache = new Map<string, { at: number; value: unknown }>();

export async function cachedRpc<M extends 'issueDetail' | 'pullDetail' | 'pullFilePatch'>(method: M, params: ITaskBoardRpc[M]['params'], ttl = 20000, force = false): Promise<ITaskBoardRpc[M]['result']> {
	const key = `${method}:${JSON.stringify(params)}`;
	const hit = detailCache.get(key);
	if (!force && hit && Date.now() - hit.at < ttl) {
		return hit.value as ITaskBoardRpc[M]['result'];
	}
	const value = await rpc(method, params);
	detailCache.set(key, { at: Date.now(), value });
	return value;
}

export async function fetchText(url: string): Promise<string> {
	const res = await fetch(url, { headers: authHeaders() });
	if (!res.ok) {
		throw new RpcError('not-found', `${res.status}`);
	}
	return res.text();
}
