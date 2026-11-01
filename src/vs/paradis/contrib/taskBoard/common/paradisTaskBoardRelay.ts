/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/*
 * タスクボードの SSH 中継の、手元の側の決まり（q.html Q472 = A、Q525。設計書 taskboard-ssh-relay-design.html の G1〜G4・G8）。
 *
 *  - ボードの鍵（G1）: main がボードを起動するたびに作り、ボードへは stdio の ipc で、開いた窓へは open() の結果で渡す。
 *    窓が shared process へ鍵と pid を登録し、接続口はすべての要求でこの鍵と接続元の pid を確かめる。発見ファイルの
 *    Bearer だけでは通さない（同じ PC のどのプロセスでも読めるため）
 *  - 中継のセッション（G3）: SSH の窓が作り、その窓・その接続先のリポジトリ・そのボードの鍵に結び付く
 *  - 依頼の形（G4）: ボードから来た操作は、許す欄だけを取り出して組み直す。2 本目で通すのは読むだけの git と readFile
 */

import { paradisTaskBoardRemoteIsReadablePath, paradisTaskBoardRemoteRelativePathError } from './paradisTaskBoardRemote.js';

/** ボードが接続口へ送る、起動ごとの鍵のヘッダー。 */
export const PARADIS_TASK_BOARD_BOARD_KEY_HEADER = 'x-para-board-key';

/** 鍵の形（main が作る 32 バイトの base64url）。 */
const BOARD_KEY = /^[A-Za-z0-9_-]{43}$/;

export function paradisTaskBoardIsBoardKey(value: unknown): value is string {
	return typeof value === 'string' && BOARD_KEY.test(value);
}

/** 窓が shared process へ登録するボード（main の open() が返したもの）。 */
export interface IParadisTaskBoardBoardRegistration {
	readonly pid: number;
	readonly key: string;
}

export function paradisParseTaskBoardBoardRegistration(value: unknown): IParadisTaskBoardBoardRegistration | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const { pid, key } = value as { pid?: unknown; key?: unknown };
	return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1 && paradisTaskBoardIsBoardKey(key) ? { pid, key } : undefined;
}

/** 中継のセッションの ID（REH の SESSION_ID と同じ形）。 */
const SESSION_ID = /^[A-Za-z0-9_-]{16,128}$/;

export function paradisTaskBoardIsRelaySessionId(value: unknown): value is string {
	return typeof value === 'string' && SESSION_ID.test(value);
}

/** 窓が shared process へ登録する中継のセッション。 */
export interface IParadisTaskBoardRelaySessionRegistration {
	readonly sessionId: string;
	/** このセッションを使ってよいボードの鍵。 */
	readonly boardKey: string;
}

export function paradisParseTaskBoardRelaySessionRegistration(value: unknown): IParadisTaskBoardRelaySessionRegistration | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const { sessionId, boardKey } = value as { sessionId?: unknown; boardKey?: unknown };
	return paradisTaskBoardIsRelaySessionId(sessionId) && paradisTaskBoardIsBoardKey(boardKey) ? { sessionId, boardKey } : undefined;
}

/**
 * 2 本目で通す、読むだけの git の操作（common/paradisTaskBoardRemote.ts の ParadisTaskBoardRemoteGitOp の一部）。
 * 書き換える操作・コマンド・push は、窓の確認が入る後の PR まで「まだ使えません」で断る。
 */
const READ_ONLY_GIT_KINDS: ReadonlySet<string> = new Set(['toplevel', 'commonDir', 'remoteUrl', 'defaultBranch', 'status', 'currentBranch', 'refExists', 'aheadCount', 'boardDirTracked', 'worktreeList']);

/** 中継で受ける操作（組み直した後の形）。 */
export type ParadisTaskBoardRelayOp =
	| { readonly kind: 'git'; readonly git: Readonly<Record<string, unknown>> }
	| { readonly kind: 'readFile'; readonly path: string; readonly maxBytes: number | undefined };

/** 中継の依頼（組み直した後の形）。 */
export interface IParadisTaskBoardRelayRequest {
	readonly sessionId: string;
	readonly op: ParadisTaskBoardRelayOp;
}

export type ParadisTaskBoardRelayParse =
	| { readonly ok: true; readonly value: IParadisTaskBoardRelayRequest }
	| { readonly ok: false; readonly code: 'invalid' | 'unavailable' | 'rejected'; readonly message: string };

function rev(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const { kind, branch } = value as { kind?: unknown; branch?: unknown };
	if (kind === 'head') {
		return { kind };
	}
	return (kind === 'local' || kind === 'remote') && typeof branch === 'string' ? { kind, branch } : undefined;
}

/** 読むだけの git の操作を、種類ごとに決まった欄だけで組み直す。値の形は REH が確かめる。 */
function rebuildGit(value: unknown): Record<string, unknown> | 'invalid' | 'unavailable' {
	if (!value || typeof value !== 'object') {
		return 'invalid';
	}
	const op = value as Record<string, unknown>;
	if (typeof op.kind !== 'string') {
		return 'invalid';
	}
	if (!READ_ONLY_GIT_KINDS.has(op.kind)) {
		return 'unavailable';
	}
	switch (op.kind) {
		case 'remoteUrl': return { kind: op.kind, push: op.push === true };
		case 'refExists': {
			const r = rev(op.rev);
			return r ? { kind: op.kind, rev: r } : 'invalid';
		}
		case 'aheadCount': {
			const base = rev(op.base);
			const head = rev(op.head);
			return base && head ? { kind: op.kind, base, head } : 'invalid';
		}
		default: return { kind: op.kind };
	}
}

/**
 * ボードから来た中継の依頼を解く。許す欄だけを取り出して新しいオブジェクトに組み直す（余分な欄は REH まで届かない）。
 * 読むだけの git と readFile 以外は `unavailable`。
 */
export function paradisParseTaskBoardRelayRequest(body: unknown): ParadisTaskBoardRelayParse {
	if (!body || typeof body !== 'object') {
		return { ok: false, code: 'invalid', message: 'The body must be an object.' };
	}
	const { sessionId, op } = body as { sessionId?: unknown; op?: unknown };
	if (!paradisTaskBoardIsRelaySessionId(sessionId)) {
		return { ok: false, code: 'invalid', message: 'sessionId is not valid.' };
	}
	if (!op || typeof op !== 'object') {
		return { ok: false, code: 'invalid', message: 'op must be an object.' };
	}
	const record = op as Record<string, unknown>;
	switch (record.kind) {
		case 'git': {
			const git = rebuildGit(record.git);
			if (git === 'invalid') {
				return { ok: false, code: 'invalid', message: 'The git operation is not valid.' };
			}
			if (git === 'unavailable') {
				return { ok: false, code: 'unavailable', message: 'This git operation is not available over SSH yet.' };
			}
			return { ok: true, value: { sessionId, op: { kind: 'git', git } } };
		}
		case 'readFile': {
			if (typeof record.path !== 'string' || paradisTaskBoardRemoteRelativePathError(record.path) !== undefined) {
				return { ok: false, code: 'invalid', message: 'path must be a relative path inside the workspace.' };
			}
			// 読めるのは `.para/` の中とフローの定義だけ（REH でも同じ検査を重ねる）
			if (!paradisTaskBoardRemoteIsReadablePath(record.path)) {
				return { ok: false, code: 'rejected', message: 'The task board may read only files in .para/ and the flow files.' };
			}
			const maxBytes = typeof record.maxBytes === 'number' && Number.isSafeInteger(record.maxBytes) && record.maxBytes > 0 ? record.maxBytes : undefined;
			return { ok: true, value: { sessionId, op: { kind: 'readFile', path: record.path, maxBytes } } };
		}
		default:
			return { ok: false, code: 'unavailable', message: 'This operation is not available over SSH yet.' };
	}
}

/** 監査ログに残す操作の名前（ボードから来た文字列はそのまま残さない）。 */
export function paradisTaskBoardRelayOperationName(body: unknown): string {
	const op = body && typeof body === 'object' ? (body as { op?: unknown }).op : undefined;
	if (!op || typeof op !== 'object') {
		return 'unknown';
	}
	const { kind, git } = op as { kind?: unknown; git?: unknown };
	const name = (value: unknown) => typeof value === 'string' && /^[A-Za-z]{1,32}$/.test(value) ? value : 'unknown';
	if (kind === 'git') {
		return `git.${name(git && typeof git === 'object' ? (git as { kind?: unknown }).kind : undefined)}`;
	}
	return name(kind);
}

/** 監査ログの 1 行（出力・env・ファイルの中身は残さない）。 */
export interface IParadisTaskBoardAuditEntry {
	readonly time: string;
	/** 断ったところ（接続口の鍵と pid、セッション、窓の検査）か、通したか。 */
	readonly outcome: 'allowed' | 'denied' | 'failed';
	readonly operation: string;
	readonly sessionId?: string;
	readonly authority?: string;
	readonly repository?: string;
	/** ボードから（自動の進行・担当の報告）か、利用者の操作か。2 本目では常にボード。 */
	readonly initiator: 'board';
	readonly reason?: string;
	readonly code?: number;
	readonly durationMs?: number;
	/** 相対パス・大きさなど、操作ごとに残す補足（設計書 3 節の「監査で追加に残すもの」）。 */
	readonly detail?: string;
}

/** 窓へ振り分ける打ち切り時間。REH の長い git（120 秒）と、心拍の打ち切りより長くする。 */
export const PARADIS_TASK_BOARD_RELAY_TIMEOUT_MS = 180_000;

/** 窓から REH への心拍の間隔（REH は 120 秒途絶えたら閉じる）。 */
export const PARADIS_TASK_BOARD_RELAY_HEARTBEAT_MS = 30_000;
