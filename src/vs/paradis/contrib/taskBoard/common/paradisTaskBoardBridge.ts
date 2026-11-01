/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タスクボードの接続口（bridge）の約束。ボードサーバー（app/taskboard/server）と shared process の
// HTTP、shared process とウィンドウの IPC の両方で使う形と、要求の検証・イベントの組み立てを置く。
// VS Code の仕組み（サービス・nls）には依存しない（純粋な関数だけ）。

import { StringSHA1 } from '../../../../base/common/hash.js';
import { paradisIsCodexFormCancel } from '../../mobileRelay/common/paradisAgentApprovalOptions.js';

/** 接続口を有効にする設定（オフなら HTTP を立てない）。 */
export const PARADIS_TASK_BOARD_BRIDGE_ENABLED_SETTING = 'paradis.taskBoard.bridge.enabled';

/** ボードサーバーが接続先を知るためのファイル（`<userData>` の直下）。 */
export const PARADIS_TASK_BOARD_BRIDGE_DISCOVERY_FILE = 'paradis-taskboard-bridge.json';

/** ウィンドウが shared process を呼ぶチャネル（状態の報告・自分のターミナルの一覧）。 */
export const PARADIS_TASK_BOARD_BRIDGE_CHANNEL = 'paradisTaskBoardBridge';

/** shared process がウィンドウを呼ぶチャネル（ウィンドウが shared process の接続へ登録する）。 */
export const PARADIS_TASK_BOARD_WINDOW_CHANNEL = 'paradisTaskBoardWindow';

export const PARADIS_TASK_BOARD_BRIDGE_VERSION = 1;

/** 要求の本文の上限。 */
export const PARADIS_TASK_BOARD_MAX_BODY_BYTES = 1024 * 1024;
/** 起動の指示の上限（起動の引数になる）。 */
export const PARADIS_TASK_BOARD_MAX_PROMPT_LENGTH = 32_000;
/** 送る文の上限。 */
export const PARADIS_TASK_BOARD_MAX_TEXT_LENGTH = 32_000;
/** ツールのイベントに添える詳細の上限。 */
export const PARADIS_TASK_BOARD_TOOL_DETAIL_LENGTH = 200;
/** MCP の報告への返事を待つ上限。 */
export const PARADIS_TASK_BOARD_REPLY_TIMEOUT_MS = 20_000;
/** SSE の生存確認の間隔。 */
export const PARADIS_TASK_BOARD_PING_INTERVAL_MS = 15_000;

export type ParadisTaskBoardAgent = 'claude' | 'codex';

/** ボードへ流すターミナルの状態。 */
export type ParadisTaskBoardTerminalStatus = 'working' | 'question' | 'permission' | 'review' | 'idle' | 'exited';

export const PARADIS_TASK_BOARD_KEYS = ['enter', 'escape', 'ctrl_c', 'up', 'down', 'tab', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
export type ParadisTaskBoardKey = typeof PARADIS_TASK_BOARD_KEYS[number];

/** 質問・許可の中身（分かる範囲）。 */
export interface IParadisTaskBoardQuestionPayload {
	readonly text: string;
	readonly options: readonly { readonly label: string; readonly detail?: string }[];
	readonly allowText: boolean;
}

/**
 * ボードから選ばせない許可の選択肢か（この先も許可し続ける「このセッションでは許可」「常に許可」）。ボードの HTTP の口は
 * 接続元を確かめないので、ペインの中のエージェント自身が自分のツールを恒久的に許可できてしまうため。
 */
export function paradisTaskBoardIsLastingApproval(screenLabel: string): boolean {
	return /^(?:Allow for this session|Always allow)\b/.test(screenLabel);
}

/**
 * 画面に Codex の MCP のツールの許可のフォームが出ている間、ボードのキー（`/v1/key`）で送らないキー（数字と Enter）。
 * フォームは数字や Enter でそのまま確定するので、ペインの中のエージェントが自分のツールの「常に許可」を選べてしまう
 * （`/v1/answer` で塞いだ経路の迂回）。フォームへの答えは `/v1/answer` に一本化する。Esc（取り消し）は通す。
 */
export function paradisTaskBoardKeyBlockedOnApprovalForm(key: ParadisTaskBoardKey): boolean {
	return key === 'enter' || /^[1-9]$/.test(key);
}

/**
 * 画面の許可の選択肢のうち、ボードに出すもの。{@link paradisTaskBoardIsLastingApproval} と「Cancel」（ボードの「拒否」と同じ）を
 * 除く。番号はそのまま持つ。残りが 1 つ以下なら、ボードは今までどおり「許可 / 拒否」を出す。
 */
export function paradisTaskBoardApprovalChoices<T extends { readonly n: number; readonly label: string }>(options: readonly T[]): readonly T[] {
	return options.filter(option => !paradisTaskBoardIsLastingApproval(option.label) && !paradisIsCodexFormCancel(option.label));
}

/**
 * 断った理由。HTTP の状態は {@link paradisTaskBoardHttpStatus} で決める。
 * - `busy` / `question` / `permission` / `exited`: 今は送れない（409）
 * - `rejected`: 回答などを受け付けられない（409）
 * - `not-found`: ボードの起動したターミナルではない・もう無い（404）
 * - `invalid`: 要求の形が違う（400）
 * - `unavailable`: ウィンドウが無い・応答しない（503）
 * - `failed`: 内部の失敗（500）
 */
export type ParadisTaskBoardErrorCode = 'busy' | 'question' | 'permission' | 'exited' | 'rejected' | 'not-found' | 'invalid' | 'unavailable' | 'failed';

export type ParadisTaskBoardResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: ParadisTaskBoardErrorCode; readonly message: string };

export function paradisTaskBoardFail(code: ParadisTaskBoardErrorCode, message: string): { readonly ok: false; readonly code: ParadisTaskBoardErrorCode; readonly message: string } {
	return { ok: false, code, message };
}

export function paradisTaskBoardHttpStatus(code: ParadisTaskBoardErrorCode): number {
	switch (code) {
		case 'not-found': return 404;
		case 'invalid': return 400;
		case 'unavailable': return 503;
		case 'failed': return 500;
		default: return 409;
	}
}

// --- ターミナルの ID ----------------------------------------------------------------------------

/**
 * ペイントークンからボードへ見せる ID を作る。IDE 操作ツール（`list_terminals` の id）と同じ規則
 * （agentIde/electron-browser/paradisAgentIdeChannel.ts の `paradisAgentIdeTerminalId`）。
 * トークンは推測できない乱数なので、ハッシュから元へは戻せない。
 */
export function paradisTaskBoardTerminalId(paneToken: string): string {
	const sha = new StringSHA1();
	sha.update(`paradis-agent-ide:${paneToken}`);
	return `t_${sha.digest().slice(0, 12)}`;
}

export function paradisIsTaskBoardTerminalId(value: unknown): value is string {
	return typeof value === 'string' && /^t_[0-9a-f]{12}$/.test(value);
}

// --- 状態 ----------------------------------------------------------------------------------------

/** ウィンドウで分かることから、ボードへ流す状態を決める。 */
export function paradisTaskBoardStatusFrom(input: {
	readonly closed: boolean;
	readonly agentExited: boolean;
	readonly agentStatus: 'working' | 'permission' | 'question' | 'review' | undefined;
	/** Codex の Plan メニューなど、選択を待つ画面が出ている。 */
	readonly choiceMenu: boolean;
}): ParadisTaskBoardTerminalStatus {
	if (input.closed || input.agentExited) {
		return 'exited';
	}
	switch (input.agentStatus) {
		case 'working': return 'working';
		case 'permission': return 'permission';
		case 'question': return 'question';
	}
	if (input.choiceMenu) {
		return 'question';
	}
	return input.agentStatus === 'review' ? 'review' : 'idle';
}

/** 前面がシェルへ戻ったのを、エージェントの終わりと決めるまでに続いてほしい長さ。 */
export const PARADIS_TASK_BOARD_AGENT_EXIT_CONFIRM_MS = 4_000;
/** 見張っていたターミナルの instance が破棄された後、同じペインが別の instance で戻るのを待つ長さ。 */
export const PARADIS_TASK_BOARD_DISPOSED_GRACE_MS = 5_000;
/** ターミナルが見つからない（再読み込みの後の復元待ち）ままでいられる時間。過ぎたら終わったとみなす。 */
export const PARADIS_TASK_BOARD_MISSING_GRACE_MS = 60_000;

/** 前面がシェルへ戻ったのを続けて見ているか（{@link paradisTaskBoardConfirmAgentExit} が書き換える）。 */
export interface IParadisTaskBoardExitWatch {
	/** 前面がシェルへ戻ったのを最初に見た時刻。 */
	shellSince?: number;
	/** 続けて見た回数。 */
	shellSeen: number;
}

/**
 * 前面がシェルへ戻った（エージェントが終わった）と認めるか。続けて 2 回以上、{@link PARADIS_TASK_BOARD_AGENT_EXIT_CONFIRM_MS}
 * 以上見たときだけ認める。1 回の見え方で決めると、プロセス名や実行中のコマンドの知らせが遅れた・一時的に
 * 外れた瞬間を終わりと取り違え、動いているエージェントを「終了」と知らせる。本当に終わったなら前面は
 * シェルのままなので、待っても見逃さない。
 */
export function paradisTaskBoardConfirmAgentExit(watch: IParadisTaskBoardExitWatch, shellBack: boolean, now: number): boolean {
	if (!shellBack) {
		watch.shellSince = undefined;
		watch.shellSeen = 0;
		return false;
	}
	watch.shellSince ??= now;
	watch.shellSeen++;
	return watch.shellSeen >= 2 && now - watch.shellSince >= PARADIS_TASK_BOARD_AGENT_EXIT_CONFIRM_MS;
}

/**
 * {@link paradisTaskBoardConfirmAgentExit} の読むだけの版。これまでに見た回数だけで、終わりと認められているか
 * （見張りの見直し以外で様子を確かめるときに使う。そこで回数を進めると、続けて見たことにならない）。
 */
export function paradisTaskBoardAgentExitConfirmed(watch: Readonly<IParadisTaskBoardExitWatch>, shellBack: boolean, now: number): boolean {
	return shellBack && watch.shellSince !== undefined && watch.shellSeen >= 2 && now - watch.shellSince >= PARADIS_TASK_BOARD_AGENT_EXIT_CONFIRM_MS;
}

/**
 * 見張っているターミナルが見つからないとき、終わったとみなすか。instance が破棄されたのを見たなら
 * {@link PARADIS_TASK_BOARD_DISPOSED_GRACE_MS}、そうでなければ（再読み込みの後の復元待ち）
 * {@link PARADIS_TASK_BOARD_MISSING_GRACE_MS} 待つ。同じ pty を別の instance へ付け替える（detach / reattach）と、
 * 古い instance は破棄されるがペインは動き続けるので、破棄だけでは終わりと決めない。
 */
export function paradisTaskBoardMissingTerminalExited(missing: { readonly missingSince: number; readonly disposedAt?: number }, now: number): boolean {
	return missing.disposedAt !== undefined
		? now - missing.disposedAt >= PARADIS_TASK_BOARD_DISPOSED_GRACE_MS
		: now - missing.missingSince >= PARADIS_TASK_BOARD_MISSING_GRACE_MS;
}

/** 文を送ってはいけない状態なら、その理由のコード。入力待ち（idle / review）なら undefined。 */
export function paradisTaskBoardSendBlock(status: ParadisTaskBoardTerminalStatus, shellBack = false): 'busy' | 'question' | 'permission' | 'exited' | undefined {
	// 終わりと決める前でも、前面がシェルに見える間は送らない（指示がシェルのコマンドとして走らないように）
	if (shellBack && status !== 'exited') {
		return 'busy';
	}
	switch (status) {
		case 'working': return 'busy';
		case 'question': return 'question';
		case 'permission': return 'permission';
		case 'exited': return 'exited';
		default: return undefined;
	}
}

// --- 要求の検証 ------------------------------------------------------------------------------------

export interface IParadisTaskBoardLaunchRequest {
	readonly launchId: string;
	readonly repoPath: string;
	readonly agent: ParadisTaskBoardAgent;
	readonly prompt: string;
	readonly modelId?: string;
	readonly effortId?: string;
	readonly permissionId?: string;
}

export interface IParadisTaskBoardSendRequest {
	readonly terminal: string;
	readonly text: string;
	readonly submit: boolean;
	/**
	 * ボードが付ける印（タスクと試行。例 `<タスク>:<試行>`）。送れたらターミナルの印を置き換え、
	 * `/v1/terminals` で返す。ボードが再起動したとき、同じターミナルで続いている工程に結び直すのに使う。
	 */
	readonly tag?: string;
}

export interface IParadisTaskBoardKeyRequest {
	readonly terminal: string;
	readonly key: ParadisTaskBoardKey;
}

export interface IParadisTaskBoardAnswerRequest {
	readonly terminal: string;
	readonly kind: 'question' | 'permission';
	readonly optionIndex?: number;
	readonly text?: string;
	readonly allow?: boolean;
}

export interface IParadisTaskBoardReplyRequest {
	readonly replyId: string;
	readonly ok: boolean;
	readonly message: string;
}

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: 'invalid'; readonly message: string };

function invalid(message: string): { readonly ok: false; readonly code: 'invalid'; readonly message: string } {
	return { ok: false, code: 'invalid', message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** 短い識別子（モデル・権限・起動 ID）。制御文字を含まない 1〜max 文字。 */
function shortText(value: unknown, max: number): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL_CHARACTERS.test(value) ? value : undefined;
}

function optionalShortText(record: Record<string, unknown>, key: string, max: number): { readonly ok: true; readonly value: string | undefined } | { readonly ok: false } {
	const value = record[key];
	if (value === undefined || value === null) {
		return { ok: true, value: undefined };
	}
	const text = shortText(value, max);
	return text === undefined ? { ok: false } : { ok: true, value: text };
}

/** 絶対パスか（POSIX の `/…` と Windows の `C:\…`）。 */
export function paradisTaskBoardIsAbsolutePath(value: string): boolean {
	return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

export function paradisParseTaskBoardLaunch(body: unknown): Parsed<IParadisTaskBoardLaunchRequest> {
	if (!isRecord(body)) {
		return invalid('The body must be a JSON object.');
	}
	const launchId = shortText(body.launchId, 200);
	if (launchId === undefined) {
		return invalid('launchId must be a non-empty string (up to 200 characters).');
	}
	const repoPath = body.repoPath;
	if (typeof repoPath !== 'string' || repoPath.length === 0 || repoPath.length > 4096 || repoPath.includes('\0') || !paradisTaskBoardIsAbsolutePath(repoPath)) {
		return invalid('repoPath must be an absolute path.');
	}
	if (body.agent !== 'claude' && body.agent !== 'codex') {
		return invalid('agent must be "claude" or "codex".');
	}
	if (typeof body.prompt !== 'string' || body.prompt.length > PARADIS_TASK_BOARD_MAX_PROMPT_LENGTH) {
		return invalid(`prompt must be a string (up to ${PARADIS_TASK_BOARD_MAX_PROMPT_LENGTH} characters).`);
	}
	const modelId = optionalShortText(body, 'modelId', 100);
	const effortId = optionalShortText(body, 'effortId', 100);
	const permissionId = optionalShortText(body, 'permissionId', 100);
	if (!modelId.ok || !effortId.ok || !permissionId.ok) {
		return invalid('modelId, effortId and permissionId must be short strings.');
	}
	return {
		ok: true,
		value: {
			launchId,
			repoPath,
			agent: body.agent,
			prompt: body.prompt,
			...(modelId.value !== undefined ? { modelId: modelId.value } : {}),
			...(effortId.value !== undefined ? { effortId: effortId.value } : {}),
			...(permissionId.value !== undefined ? { permissionId: permissionId.value } : {}),
		},
	};
}

function parseTerminal(body: unknown): Parsed<{ readonly record: Record<string, unknown>; readonly terminal: string }> {
	if (!isRecord(body)) {
		return invalid('The body must be a JSON object.');
	}
	if (!paradisIsTaskBoardTerminalId(body.terminal)) {
		return invalid('terminal must be a terminal id ("t_" and 12 hex digits).');
	}
	return { ok: true, value: { record: body, terminal: body.terminal } };
}

export function paradisParseTaskBoardTerminalOnly(body: unknown): Parsed<{ readonly terminal: string }> {
	const parsed = parseTerminal(body);
	return parsed.ok ? { ok: true, value: { terminal: parsed.value.terminal } } : parsed;
}

export function paradisParseTaskBoardSend(body: unknown): Parsed<IParadisTaskBoardSendRequest> {
	const parsed = parseTerminal(body);
	if (!parsed.ok) {
		return parsed;
	}
	const { record, terminal } = parsed.value;
	if (typeof record.text !== 'string' || record.text.length === 0 || record.text.length > PARADIS_TASK_BOARD_MAX_TEXT_LENGTH) {
		return invalid(`text must be a non-empty string (up to ${PARADIS_TASK_BOARD_MAX_TEXT_LENGTH} characters).`);
	}
	if (record.submit !== undefined && typeof record.submit !== 'boolean') {
		return invalid('submit must be a boolean.');
	}
	const tag = record.tag;
	if (tag !== undefined && (typeof tag !== 'string' || tag.length === 0 || tag.length > 200)) {
		return invalid('tag must be a non-empty string (up to 200 characters).');
	}
	return { ok: true, value: { terminal, text: record.text, submit: record.submit !== false, ...(tag !== undefined ? { tag } : {}) } };
}

export function paradisParseTaskBoardKey(body: unknown): Parsed<IParadisTaskBoardKeyRequest> {
	const parsed = parseTerminal(body);
	if (!parsed.ok) {
		return parsed;
	}
	const key = parsed.value.record.key;
	if (typeof key !== 'string' || !(PARADIS_TASK_BOARD_KEYS as readonly string[]).includes(key)) {
		return invalid(`key must be one of: ${PARADIS_TASK_BOARD_KEYS.join(', ')}.`);
	}
	return { ok: true, value: { terminal: parsed.value.terminal, key: key as ParadisTaskBoardKey } };
}

export function paradisParseTaskBoardAnswer(body: unknown): Parsed<IParadisTaskBoardAnswerRequest> {
	const parsed = parseTerminal(body);
	if (!parsed.ok) {
		return parsed;
	}
	const { record, terminal } = parsed.value;
	if (record.kind !== 'question' && record.kind !== 'permission') {
		return invalid('kind must be "question" or "permission".');
	}
	const optionIndex = record.optionIndex;
	if (optionIndex !== undefined && (typeof optionIndex !== 'number' || !Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 99)) {
		return invalid('optionIndex must be an integer from 0.');
	}
	const text = record.text;
	if (text !== undefined && (typeof text !== 'string' || text.trim().length === 0 || text.length > 4000)) {
		return invalid('text must be a non-empty string (up to 4000 characters).');
	}
	const allow = record.allow;
	if (allow !== undefined && typeof allow !== 'boolean') {
		return invalid('allow must be a boolean.');
	}
	if (record.kind === 'question' && optionIndex === undefined && text === undefined) {
		return invalid('A question answer needs optionIndex or text.');
	}
	if (record.kind === 'permission' && allow === undefined && optionIndex === undefined) {
		return invalid('A permission answer needs allow (or optionIndex).');
	}
	return {
		ok: true,
		value: {
			terminal,
			kind: record.kind,
			...(optionIndex !== undefined ? { optionIndex } : {}),
			...(text !== undefined ? { text } : {}),
			...(allow !== undefined ? { allow } : {}),
		},
	};
}

export function paradisParseTaskBoardReply(body: unknown): Parsed<IParadisTaskBoardReplyRequest> {
	if (!isRecord(body)) {
		return invalid('The body must be a JSON object.');
	}
	const replyId = shortText(body.replyId, 100);
	if (replyId === undefined) {
		return invalid('replyId must be a non-empty string.');
	}
	if (typeof body.ok !== 'boolean') {
		return invalid('ok must be a boolean.');
	}
	const message = body.message ?? '';
	if (typeof message !== 'string' || message.length > 4000) {
		return invalid('message must be a string (up to 4000 characters).');
	}
	return { ok: true, value: { replyId, ok: body.ok, message } };
}

// --- HTTP の認証 --------------------------------------------------------------------------------------

/** Host ヘッダーが、この接続口（127.0.0.1 / localhost と自分のポート）を指しているか。 */
export function paradisTaskBoardIsAllowedHost(host: string | undefined, port: number): boolean {
	return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** `Authorization: Bearer <token>` から token を取り出す。 */
export function paradisTaskBoardBearerToken(header: string | undefined): string | undefined {
	const match = header !== undefined ? /^Bearer ([A-Za-z0-9_-]{16,200})$/.exec(header.trim()) : null;
	return match ? match[1] : undefined;
}

// --- イベント ---------------------------------------------------------------------------------------

export interface IParadisTaskBoardStatusEvent {
	readonly type: 'status';
	readonly terminal: string;
	readonly launchId: string;
	readonly status: ParadisTaskBoardTerminalStatus;
	readonly question?: IParadisTaskBoardQuestionPayload;
}

export interface IParadisTaskBoardToolEvent {
	readonly type: 'tool';
	readonly terminal: string;
	readonly name: string;
	readonly detail?: string;
}

export interface IParadisTaskBoardReportEvent {
	readonly type: 'report';
	readonly terminal: string;
	readonly replyId: string;
	readonly tool: 'complete_step' | 'ask_human';
	readonly args: object;
}

export type ParadisTaskBoardEvent = IParadisTaskBoardStatusEvent | IParadisTaskBoardToolEvent | IParadisTaskBoardReportEvent;

/** SSE の 1 件（`data: <JSON>\n\n`）。JSON は改行を含まない。 */
export function paradisTaskBoardSseData(event: ParadisTaskBoardEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

export const PARADIS_TASK_BOARD_SSE_PING = ': ping\n\n';

const TOOL_DETAIL_KEYS = ['file_path', 'notebook_path', 'path', 'command', 'cmd', 'pattern', 'url', 'query', 'description'];

/** hook のツール入力から、ボードへ見せる短い詳細（ファイルパス・コマンドの先頭）を取り出す。 */
export function paradisTaskBoardToolDetail(toolInput: unknown): string | undefined {
	if (!isRecord(toolInput)) {
		return undefined;
	}
	for (const key of TOOL_DETAIL_KEYS) {
		let value = toolInput[key];
		if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
			value = value.join(' ');
		}
		if (typeof value === 'string' && value.trim().length > 0) {
			return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, PARADIS_TASK_BOARD_TOOL_DETAIL_LENGTH);
		}
	}
	return undefined;
}

// --- MCP ツール -------------------------------------------------------------------------------------

export const PARADIS_TASK_BOARD_TOOL_COMPLETE_STEP = 'board_complete_step';
export const PARADIS_TASK_BOARD_TOOL_ASK_HUMAN = 'board_ask_human';

export const PARADIS_TASK_BOARD_ARTIFACT_KINDS = ['plan', 'mock', 'screenshot', 'report'] as const;

export interface IParadisTaskBoardArtifactArg {
	readonly kind: typeof PARADIS_TASK_BOARD_ARTIFACT_KINDS[number];
	readonly title: string;
	readonly path?: string;
	readonly content?: string;
}

export interface IParadisTaskBoardCompleteStepArgs {
	readonly summary: string;
	readonly artifacts?: readonly IParadisTaskBoardArtifactArg[];
}

export interface IParadisTaskBoardAskHumanArgs {
	readonly question: string;
	readonly options?: readonly string[];
	readonly allow_text?: boolean;
}

const MAX_ARTIFACTS = 20;
const MAX_ARTIFACT_CONTENT = 200_000;

export const PARADIS_TASK_BOARD_TOOLS = [
	{
		name: PARADIS_TASK_BOARD_TOOL_COMPLETE_STEP,
		description: 'Report to the Para Code task board that you finished the current step of your task, with a short summary and optional artifacts (a plan, a mock, a screenshot or a report: give a file path or the content). Only works in a terminal that the task board started. The result may contain the board\'s reply (for example what to do next).',
		inputSchema: {
			type: 'object',
			properties: {
				summary: { type: 'string', description: 'What you did in this step, in a few sentences.' },
				artifacts: {
					type: 'array',
					maxItems: MAX_ARTIFACTS,
					items: {
						type: 'object',
						properties: {
							kind: { type: 'string', enum: [...PARADIS_TASK_BOARD_ARTIFACT_KINDS] },
							title: { type: 'string' },
							path: { type: 'string', description: 'Path of the file: absolute, or relative to the workspace (the repository folder the board started you in). The board reads it; files outside the workspace are refused.' },
							content: { type: 'string', description: 'The content itself (for example Markdown or HTML), when there is no file.' },
						},
						required: ['kind', 'title'],
						additionalProperties: false,
					},
				},
			},
			required: ['summary'],
			additionalProperties: false,
		},
	},
	{
		name: PARADIS_TASK_BOARD_TOOL_ASK_HUMAN,
		description: 'Ask the person watching the Para Code task board a question (for example to choose between options). The answer arrives later as the user\'s next message, so end your turn after calling this and wait. Only works in a terminal that the task board started.',
		inputSchema: {
			type: 'object',
			properties: {
				question: { type: 'string' },
				options: { type: 'array', items: { type: 'string' }, maxItems: 10 },
				allow_text: { type: 'boolean', description: 'Whether the person may answer in their own words (default true).' },
			},
			required: ['question'],
			additionalProperties: false,
		},
	},
] as const;

export const PARADIS_TASK_BOARD_TOOL_NAMES: ReadonlySet<string> = new Set(PARADIS_TASK_BOARD_TOOLS.map(tool => tool.name));

export const PARADIS_TASK_BOARD_SERVER_INSTRUCTIONS = 'Task board tools (board_complete_step, board_ask_human): use them only when this terminal was started from the Para Code task board (your task prompt says so). Call board_complete_step when you finish a step, and board_ask_human when you need the person to decide; then end your turn.';

type ParsedArgs<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

export function paradisParseTaskBoardCompleteStepArgs(args: unknown): ParsedArgs<IParadisTaskBoardCompleteStepArgs> {
	if (!isRecord(args)) {
		return { ok: false, message: 'Arguments must be an object.' };
	}
	if (typeof args.summary !== 'string' || args.summary.trim().length === 0 || args.summary.length > 4000) {
		return { ok: false, message: 'summary must be a non-empty string (up to 4000 characters).' };
	}
	if (args.artifacts === undefined) {
		return { ok: true, value: { summary: args.summary } };
	}
	if (!Array.isArray(args.artifacts) || args.artifacts.length > MAX_ARTIFACTS) {
		return { ok: false, message: `artifacts must be an array of up to ${MAX_ARTIFACTS} items.` };
	}
	const artifacts: IParadisTaskBoardArtifactArg[] = [];
	for (const item of args.artifacts) {
		if (!isRecord(item) || typeof item.kind !== 'string' || !(PARADIS_TASK_BOARD_ARTIFACT_KINDS as readonly string[]).includes(item.kind)) {
			return { ok: false, message: `Each artifact needs kind (${PARADIS_TASK_BOARD_ARTIFACT_KINDS.join(', ')}) and title.` };
		}
		if (typeof item.title !== 'string' || item.title.trim().length === 0 || item.title.length > 200) {
			return { ok: false, message: 'Each artifact needs a title (up to 200 characters).' };
		}
		// 相対パスは作業場所からのパスとしてボードが読む（作業場所の外を指すものはボードが断る）
		if (item.path !== undefined && (typeof item.path !== 'string' || item.path.trim().length === 0 || item.path.length > 4096 || item.path.includes('\0'))) {
			return { ok: false, message: 'An artifact path must be a non-empty path (absolute, or relative to the workspace).' };
		}
		if (item.content !== undefined && (typeof item.content !== 'string' || item.content.length > MAX_ARTIFACT_CONTENT)) {
			return { ok: false, message: `An artifact content must be a string (up to ${MAX_ARTIFACT_CONTENT} characters).` };
		}
		artifacts.push({
			kind: item.kind as IParadisTaskBoardArtifactArg['kind'],
			title: item.title,
			...(item.path !== undefined ? { path: item.path } : {}),
			...(item.content !== undefined ? { content: item.content } : {}),
		});
	}
	return { ok: true, value: { summary: args.summary, artifacts } };
}

export function paradisParseTaskBoardAskHumanArgs(args: unknown): ParsedArgs<IParadisTaskBoardAskHumanArgs> {
	if (!isRecord(args)) {
		return { ok: false, message: 'Arguments must be an object.' };
	}
	if (typeof args.question !== 'string' || args.question.trim().length === 0 || args.question.length > 4000) {
		return { ok: false, message: 'question must be a non-empty string (up to 4000 characters).' };
	}
	if (args.options !== undefined && (!Array.isArray(args.options) || args.options.length > 10 || !args.options.every(option => typeof option === 'string' && option.trim().length > 0 && option.length <= 200))) {
		return { ok: false, message: 'options must be an array of up to 10 short strings.' };
	}
	if (args.allow_text !== undefined && typeof args.allow_text !== 'boolean') {
		return { ok: false, message: 'allow_text must be a boolean.' };
	}
	return {
		ok: true,
		value: {
			question: args.question,
			...(args.options !== undefined ? { options: args.options as string[] } : {}),
			...(args.allow_text !== undefined ? { allow_text: args.allow_text } : {}),
		},
	};
}

// --- ウィンドウとの IPC の形 ---------------------------------------------------------------------------

/** ウィンドウが開いているリポジトリ（スペース）1 件。 */
export interface IParadisTaskBoardWindowSpace {
	readonly path: string;
	readonly name: string;
}

/** `describe` の答え。 */
export interface IParadisTaskBoardWindowDescription {
	readonly focused: boolean;
	/** リポジトリを登録できるか（Para Code のマルチリポジトリのワークスペースを開いているウィンドウだけ）。 */
	readonly canAddRepository?: boolean;
	/**
	 * SSH などの接続先を開いているウィンドウ。ボードのターミナルは手元のフォルダで動くが、このウィンドウで作ると
	 * 接続先用のランチャーとポートの場所が付き、Codex が共有サーバーへ相乗りして MCP と hook が別のペインへ流れる。
	 * 起動先に選ばない。
	 */
	readonly remote?: boolean;
	/** 登録リポジトリ（health に出す）。 */
	readonly repositories: readonly IParadisTaskBoardWindowSpace[];
	/** 登録リポジトリと、その worktree のスペース（起動先の選択に使う）。 */
	readonly spaces: readonly IParadisTaskBoardWindowSpace[];
}

/** ウィンドウからの状態の報告。 */
export interface IParadisTaskBoardStatusReport {
	readonly terminal: string;
	readonly status: ParadisTaskBoardTerminalStatus;
	readonly question?: IParadisTaskBoardQuestionPayload;
}

/** `screen` の答え。 */
export interface IParadisTaskBoardScreen {
	readonly text: string;
	readonly status: ParadisTaskBoardTerminalStatus;
	readonly readable: boolean;
}

/** ウィンドウのチャネルのメソッド。引数は 1 つ（要求のオブジェクト）。 */
export type ParadisTaskBoardWindowMethod = 'describe' | 'launch' | 'send' | 'key' | 'answer' | 'screen' | 'close' | 'relay';

/**
 * shared process のチャネルのメソッド。
 * - `listWindowTerminals`: 呼んだウィンドウが受け持つボードのターミナル ID の一覧（再読み込みの後に見張りを戻す）
 * - `reportStatus`: 状態の報告（{@link IParadisTaskBoardStatusReport}）
 */
export type ParadisTaskBoardBridgeMethod = 'listWindowTerminals' | 'reportStatus';

/** 2 つのパスが同じ場所か（末尾の区切りを無視。大文字小文字を区別しない OS では無視する）。 */
export function paradisTaskBoardSamePath(a: string, b: string, ignoreCase: boolean): boolean {
	const normalize = (value: string) => {
		let result = value.replace(/\\/g, '/');
		while (result.length > 1 && result.endsWith('/') && !/^[A-Za-z]:\/$/.test(result)) {
			result = result.slice(0, -1);
		}
		return ignoreCase ? result.toLowerCase() : result;
	};
	return normalize(a) === normalize(b);
}

/** 状態の報告の形を確かめる（ウィンドウからの IPC）。 */
export function paradisParseTaskBoardStatusReport(value: unknown): IParadisTaskBoardStatusReport | undefined {
	if (!isRecord(value) || !paradisIsTaskBoardTerminalId(value.terminal)) {
		return undefined;
	}
	const statuses: readonly string[] = ['working', 'question', 'permission', 'review', 'idle', 'exited'];
	if (typeof value.status !== 'string' || !statuses.includes(value.status)) {
		return undefined;
	}
	let question: IParadisTaskBoardQuestionPayload | undefined;
	if (isRecord(value.question) && typeof value.question.text === 'string' && Array.isArray(value.question.options)) {
		const options = value.question.options
			.filter((option): option is Record<string, unknown> => isRecord(option) && typeof option.label === 'string')
			.slice(0, 20)
			.map(option => ({ label: (option.label as string).slice(0, 500), ...(typeof option.detail === 'string' && option.detail.length > 0 ? { detail: option.detail.slice(0, 1000) } : {}) }));
		question = { text: value.question.text.slice(0, 4000), options, allowText: value.question.allowText === true };
	}
	return { terminal: value.terminal, status: value.status as ParadisTaskBoardTerminalStatus, ...(question ? { question } : {}) };
}
