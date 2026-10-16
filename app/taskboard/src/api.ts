// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useSyncExternalStore } from 'react';
import type { ITaskBoardNotice, ITaskBoardRpc, ITaskBoardSnapshot, TaskBoardErrorCode, TaskBoardRpcMethod, TaskBoardServerMessage } from '@engine/paradisTaskBoard.js';

/*
 * サーバーとのやりとり。状態はサーバーが送るスナップショットを丸ごと持つ（台帳は小さいので差分にしない）。
 * 受け渡しの口はここだけにしておき、Para Code に載せるときは IPC に差し替える。
 */

export class RpcError extends Error {
	constructor(readonly code: TaskBoardErrorCode | 'network', message: string) {
		super(message);
	}
}

export async function rpc<M extends TaskBoardRpcMethod>(method: M, params: ITaskBoardRpc[M]['params']): Promise<ITaskBoardRpc[M]['result']> {
	let res: Response;
	try {
		res = await fetch('/api/rpc', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) });
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
	const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`);
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
			const health = await fetch('/api/health', { credentials: 'same-origin' }).catch(() => undefined);
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
	return `/api/artifacts/${encodeURIComponent(taskId)}/${encodeURIComponent(artifactId)}`;
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
	const res = await fetch(url, { credentials: 'same-origin' });
	if (!res.ok) {
		throw new RpcError('not-found', `${res.status}`);
	}
	return res.text();
}
