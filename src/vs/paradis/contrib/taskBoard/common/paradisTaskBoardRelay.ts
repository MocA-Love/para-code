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

import { ParadisTaskBoardRelayEvent } from './paradisTaskBoardBridge.js';
import { PARADIS_TASK_BOARD_HIDDEN_CHARACTERS_MESSAGE, paradisTaskBoardHasHiddenCharacters } from './paradisTaskBoardDisplayText.js';
import { paradisTaskBoardRemoteCommandError, paradisTaskBoardRemoteIsReadablePath, paradisTaskBoardRemoteRelativePathError } from './paradisTaskBoardRemote.js';

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
	/** SSH の窓のボードか（main が付ける。接続口は SSH のボードに手元の口を使わせない）。 */
	readonly remote?: boolean;
}

export function paradisParseTaskBoardBoardRegistration(value: unknown): IParadisTaskBoardBoardRegistration | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const { pid, key, remote } = value as { pid?: unknown; key?: unknown; remote?: unknown };
	return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1 && paradisTaskBoardIsBoardKey(key) ? { pid, key, ...(remote === true ? { remote: true } : {}) } : undefined;
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
 * 窓が通す git の操作（common/paradisTaskBoardRemote.ts の ParadisTaskBoardRemoteGitOp の一部）。読むだけの操作と、
 * ワークツリー・ブランチの用意（3 本目）。コミット・push は、窓の確認が入る後の PR まで「まだ使えません」で断る。
 */
const RELAYED_GIT_KINDS: ReadonlySet<string> = new Set([
	'toplevel', 'commonDir', 'remoteUrl', 'defaultBranch', 'status', 'currentBranch', 'refExists', 'aheadCount', 'boardDirTracked', 'worktreeList',
	'fetch', 'worktreeAdd', 'worktreeRemove', 'switch', 'mergeFfOnly', 'detach',
	// 追跡しているファイルのコミット（ボードのワークツリーだけ）。push は pushBranch で、窓が確かめてから送る
	'addTracked', 'commit',
]);

/** 中継で受ける操作（組み直した後の形）。`place` は作業場所の root（窓が自分の記録と照らす）。 */
export type ParadisTaskBoardRelayOp =
	| { readonly kind: 'sessionInfo' }
	| { readonly kind: 'git'; readonly place: string; readonly git: Readonly<Record<string, unknown>> }
	| { readonly kind: 'readFile'; readonly place: string; readonly path: string; readonly maxBytes: number | undefined }
	| { readonly kind: 'writeFile'; readonly path: string; readonly content: string }
	| { readonly kind: 'resetBoardDir'; readonly place: string; readonly taskId: string }
	| { readonly kind: 'excludeBoardDir'; readonly place: string }
	| { readonly kind: 'runCommand'; readonly place: string; readonly runId: string; readonly command: string; readonly step: IParadisTaskBoardRelayCommandStep }
	| { readonly kind: 'cancelRun'; readonly runId: string }
	/**
	 * ボードのブランチを push する（窓が送るコミット・ファイル・リモートを見せて確かめてから。Q525 の c = B）。結果は
	 * relay-exit のイベントで返す。`interactive` が false（返却のとき）なら確認を出さず、確認が要れば送らない。
	 */
	| { readonly kind: 'pushBranch'; readonly place: string; readonly runId: string; readonly branch: string; readonly setUpstream: boolean; readonly interactive: boolean };

/**
 * 工程のコマンドの出どころ（ボードの申告。確認のダイアログで見せる）。承認の鍵は、窓が自分で決めるリポジトリと、
 * このフロー・工程の ID と、REH へ送る本文の hash の組（setup/teardown の承認と同じ考え方）。
 */
export interface IParadisTaskBoardRelayCommandStep {
	readonly flowId: string;
	readonly flowName: string;
	readonly stepId: string;
	readonly stepName: string;
	/** フローの定義の出どころ（チームのファイル・個人のファイル・既定のフロー）。 */
	readonly source: 'team' | 'personal' | 'default';
}

/** 中継の依頼（組み直した後の形）。 */
export interface IParadisTaskBoardRelayRequest {
	readonly sessionId: string;
	readonly op: ParadisTaskBoardRelayOp;
}

/** `sessionInfo` の答え。ボードはワークツリーの置き場や origin を自分で計算せず、これを使う（ずれないように）。 */
export interface IParadisTaskBoardRelaySessionInfo {
	readonly root: string;
	readonly worktreeRoot: string;
	readonly defaultBranch: string | undefined;
	/** 認証情報を外した origin の URL（fetch と push）。 */
	readonly originFetch: string | undefined;
	readonly originPush: string | undefined;
	/** 前のセッションで作って、引き取ったワークツリー。 */
	readonly worktrees: readonly string[];
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

/** git の操作を、種類ごとに決まった欄だけで組み直す。値の形（ブランチ名・パス）は REH が確かめる。 */
function rebuildGit(value: unknown): Record<string, unknown> | 'invalid' | 'unavailable' {
	if (!value || typeof value !== 'object') {
		return 'invalid';
	}
	const op = value as Record<string, unknown>;
	if (typeof op.kind !== 'string') {
		return 'invalid';
	}
	if (!RELAYED_GIT_KINDS.has(op.kind)) {
		return 'unavailable';
	}
	const mode = op.mode === 'existing' || op.mode === 'track' || op.mode === 'new' ? op.mode : undefined;
	switch (op.kind) {
		case 'remoteUrl': return { kind: op.kind, push: op.push === true };
		case 'fetch': return { kind: op.kind, prune: op.prune === true };
		case 'refExists': {
			const r = rev(op.rev);
			return r ? { kind: op.kind, rev: r } : 'invalid';
		}
		case 'aheadCount': {
			const base = rev(op.base);
			const head = rev(op.head);
			return base && head ? { kind: op.kind, base, head } : 'invalid';
		}
		case 'detach': {
			const base = rev(op.base);
			return base ? { kind: op.kind, base } : 'invalid';
		}
		case 'mergeFfOnly': return typeof op.branch === 'string' ? { kind: op.kind, branch: op.branch } : 'invalid';
		case 'commit': return typeof op.message === 'string' ? { kind: op.kind, message: op.message } : 'invalid';
		case 'worktreeRemove': return typeof op.dir === 'string' ? { kind: op.kind, dir: op.dir } : 'invalid';
		case 'worktreeAdd':
		case 'switch': {
			if (typeof op.branch !== 'string' || mode === undefined || (op.kind === 'worktreeAdd' && typeof op.dir !== 'string')) {
				return 'invalid';
			}
			const base = mode === 'new' ? rev(op.base) : undefined;
			if (mode === 'new' && !base) {
				return 'invalid';
			}
			return { kind: op.kind, ...(op.kind === 'worktreeAdd' ? { dir: op.dir } : {}), branch: op.branch, mode, ...(base ? { base } : {}) };
		}
		default: return { kind: op.kind };
	}
}

const TASK_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** 1 回に流す出力の行と長さの上限（REH の 200 行・16 KiB の行に、少し余裕を持たせる）。 */
const MAX_EVENT_LINES = 201;
const MAX_EVENT_LINE_CHARS = 64 * 1024;

/** 窓から shared process へ送る、工程のコマンドの出力と終わり。形を確かめて組み直す。 */
export function paradisParseTaskBoardRelayEvent(value: unknown): ParadisTaskBoardRelayEvent | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const event = value as Record<string, unknown>;
	if (typeof event.runId !== 'string' || !RUN_ID.test(event.runId)) {
		return undefined;
	}
	if (event.type === 'relay-output') {
		if (!Array.isArray(event.lines) || event.lines.length > MAX_EVENT_LINES || event.lines.some(line => typeof line !== 'string' || line.length > MAX_EVENT_LINE_CHARS)) {
			return undefined;
		}
		return { type: 'relay-output', runId: event.runId, lines: event.lines as string[] };
	}
	if (event.type === 'relay-exit') {
		const code = typeof event.code === 'number' && Number.isInteger(event.code) ? event.code : null;
		const signal = typeof event.signal === 'string' && event.signal.length <= 32 ? event.signal : null;
		const reason = typeof event.reason === 'string' && event.reason.length <= 500 ? event.reason : undefined;
		const pushedSha = typeof event.pushedSha === 'string' && /^[0-9a-f]{40}$/.test(event.pushedSha) ? event.pushedSha : undefined;
		const pushedCommits = typeof event.pushedCommits === 'number' && Number.isSafeInteger(event.pushedCommits) && event.pushedCommits >= 0 ? event.pushedCommits : undefined;
		return {
			type: 'relay-exit', runId: event.runId, code, signal, cancelled: event.cancelled === true, timedOut: event.timedOut === true,
			...(reason ? { reason } : {}), ...(pushedSha ? { pushedSha } : {}), ...(pushedCommits !== undefined ? { pushedCommits } : {}),
		};
	}
	return undefined;
}

function place(record: Record<string, unknown>): string | undefined {
	return typeof record.place === 'string' && record.place.startsWith('/') && record.place.length <= 4096 ? record.place : undefined;
}

/**
 * ボードから来た中継の依頼を解く。許す欄だけを取り出して新しいオブジェクトに組み直す（余分な欄は REH まで届かない）。
 * 通さない操作（コミット・push・コマンド）は `unavailable`。
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
	const at = place(record);
	const invalidPlace = { ok: false, code: 'invalid', message: 'place must be an absolute path.' } as const;
	switch (record.kind) {
		case 'sessionInfo': return { ok: true, value: { sessionId, op: { kind: 'sessionInfo' } } };
		case 'git': {
			if (at === undefined) {
				return invalidPlace;
			}
			const git = rebuildGit(record.git);
			if (git === 'invalid') {
				return { ok: false, code: 'invalid', message: 'The git operation is not valid.' };
			}
			if (git === 'unavailable') {
				return { ok: false, code: 'unavailable', message: 'This git operation is not available over SSH yet.' };
			}
			return { ok: true, value: { sessionId, op: { kind: 'git', place: at, git } } };
		}
		case 'readFile': {
			if (at === undefined) {
				return invalidPlace;
			}
			if (typeof record.path !== 'string' || paradisTaskBoardRemoteRelativePathError(record.path) !== undefined) {
				return { ok: false, code: 'invalid', message: 'path must be a relative path inside the workspace.' };
			}
			// 読めるのは `.para/` の中とフローの定義だけ（REH でも同じ検査を重ねる）
			if (!paradisTaskBoardRemoteIsReadablePath(record.path)) {
				return { ok: false, code: 'rejected', message: 'The task board may read only files in .para/ and the flow files.' };
			}
			const maxBytes = typeof record.maxBytes === 'number' && Number.isSafeInteger(record.maxBytes) && record.maxBytes > 0 ? record.maxBytes : undefined;
			return { ok: true, value: { sessionId, op: { kind: 'readFile', place: at, path: record.path, maxBytes } } };
		}
		case 'writeFile': {
			// 書けるのはリポジトリのフローの定義だけ（`.para/` への書き込みは resetBoardDir が行う）
			if (typeof record.path !== 'string' || typeof record.content !== 'string' || record.content.length > 1024 * 1024 || !/^(\.para-code\/paracode\.json|\.para-code\/[A-Za-z0-9-]{1,39}\/workflows\.json)$/.test(record.path)) {
				return { ok: false, code: 'rejected', message: 'The task board may write only the flow files.' };
			}
			return { ok: true, value: { sessionId, op: { kind: 'writeFile', path: record.path, content: record.content } } };
		}
		case 'resetBoardDir': {
			if (at === undefined || typeof record.taskId !== 'string' || !TASK_ID.test(record.taskId)) {
				return { ok: false, code: 'invalid', message: 'place and taskId are required.' };
			}
			return { ok: true, value: { sessionId, op: { kind: 'resetBoardDir', place: at, taskId: record.taskId } } };
		}
		case 'excludeBoardDir': {
			if (at === undefined) {
				return invalidPlace;
			}
			return { ok: true, value: { sessionId, op: { kind: 'excludeBoardDir', place: at } } };
		}
		case 'runCommand': {
			const step = record.step && typeof record.step === 'object' ? record.step as Record<string, unknown> : {};
			const label = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
			const flowId = label(step.flowId, 100);
			const stepId = label(step.stepId, 100);
			const source = step.source === 'team' || step.source === 'personal' || step.source === 'default' ? step.source : undefined;
			if (typeof record.command === 'string' && paradisTaskBoardHasHiddenCharacters(record.command)) {
				return { ok: false, code: 'rejected', message: PARADIS_TASK_BOARD_HIDDEN_CHARACTERS_MESSAGE };
			}
			if (at === undefined || typeof record.runId !== 'string' || !RUN_ID.test(record.runId) || typeof record.command !== 'string' || paradisTaskBoardRemoteCommandError(record.command) !== undefined || !flowId || !stepId || !source) {
				return { ok: false, code: 'invalid', message: 'place, runId, command and step are required.' };
			}
			return {
				ok: true, value: {
					sessionId, op: {
						kind: 'runCommand', place: at, runId: record.runId, command: record.command,
						step: { flowId, flowName: label(step.flowName, 200) ?? flowId, stepId, stepName: label(step.stepName, 200) ?? stepId, source },
					},
				},
			};
		}
		case 'pushBranch': {
			if (at === undefined || typeof record.runId !== 'string' || !RUN_ID.test(record.runId) || typeof record.branch !== 'string' || record.branch.length > 200) {
				return { ok: false, code: 'invalid', message: 'place, runId and branch are required.' };
			}
			return { ok: true, value: { sessionId, op: { kind: 'pushBranch', place: at, runId: record.runId, branch: record.branch, setUpstream: record.setUpstream === true, interactive: record.interactive !== false } } };
		}
		case 'cancelRun': {
			if (typeof record.runId !== 'string' || !RUN_ID.test(record.runId)) {
				return { ok: false, code: 'invalid', message: 'runId is required.' };
			}
			return { ok: true, value: { sessionId, op: { kind: 'cancelRun', runId: record.runId } } };
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
