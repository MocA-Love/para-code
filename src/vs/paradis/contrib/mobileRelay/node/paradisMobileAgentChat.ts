/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェント(Claude Code / Codex)セッションのチャットミラー (agentチャネル、shared process側)。
//
// PCのターミナルでTUIとして動いているエージェントの会話を、TUIに一切手を入れずに
// 構造化チャットとしてモバイルへミラーする:
//  - セッション特定: notify.sh (v2) がPOSTするhook JSONの transcript_path / session_id
//    (paradisAgentHookBus 経由)。画面パースには依存しない
//  - 本文: transcript JSONL (Claude: ~/.claude/projects/**.jsonl、Codex: ~/.codex/sessions/**
//    rollout) を tail してパースする。append-only なのでオフセット追跡で差分だけ読む
//  - モバイルからの入力・承認キーは既存の term チャネル (PTY stdin注入) を使う
//  - Codexのモデル一覧・次ターン設定だけはagentチャネルからapp-serverへ構造化RPCする
//    （PTYの対話コマンドには依存しない）
//
// 切断・再接続への堅牢性 (設計方針):
//  - 真実の源は常にディスク上の transcript ファイル。プロセス再起動・リレー切断で
//    何かが失われることはなく、再購読すれば必ず再構築できる
//  - 各tailerは epoch (tail開始ごとに一意) + rev (メッセージ連番) を持つ。モバイルは
//    attach 時に手元の epoch/afterRev を申告し、epoch一致なら差分のみ、不一致
//    (shared process再起動・セッション切替) なら全量スナップショットを受け取る
//  - ファイル監視は fs.watch + ポーリングの二重化 (watchの取りこぼし・未作成ファイル対応)。
//    truncate/置き換え (サイズ減少) を検知したら epoch を切り替えて読み直す

import { watch, type Dirent, FSWatcher, promises as fs } from 'fs';
// eslint-disable-next-line local/code-import-patterns
import { createRequire } from 'module';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync } from 'node:sqlite';
import { isAbsolute, join, resolve, sep } from '../../../../base/common/path.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { fireParadisAgentTurnEnded, getParadisAgentPaneActivity, IParadisAgentHookEvent, onParadisAgentHookEvent, setParadisAgentPaneActivity } from '../../agentBrowser/node/paradisAgentHookBus.js';
import { paradisClaudeConfigDir, paradisCodexHome } from '../../agentBrowser/node/paradisAgentHome.js';
import { IParadisCodexDaemonEvent, IParadisCodexModelOption, IParadisCodexThreadSettings, ParadisCodexControlError, ParadisCodexLiveClient, truncateCodexLiveText } from './paradisCodexLiveClient.js';
import { IParadisAgentActivityState, ParadisAgentActivityTracker } from './paradisAgentActivity.js';

/** エージェントCLIの種別 (transcriptパスから判定)。 */
export type ParadisAgentKind = 'claude' | 'codex';

/** kind==='question' の選択肢1件。 */
export interface IParadisAgentQuestionOption {
	readonly label: string;
	readonly description?: string;
}

/** モバイルへ送る正規化済みチャットメッセージ1件。 */
export interface IParadisAgentChatMessage {
	/** epoch内で単調増加する連番 (差分同期用)。 */
	readonly rev: number;
	readonly role: 'user' | 'assistant' | 'tool';
	readonly kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'question' | 'peer_message';
	readonly text: string;
	/** kind==='tool_use' のときのツール名。 */
	readonly tool?: string;
	/** 元イベントの時刻 (epoch ms、取れた場合のみ)。 */
	readonly ts?: number;
	/** kind==='question' のとき: タブ見出し（AskUserQuestion の header）。 */
	readonly header?: string;
	/** kind==='question' のとき: 選択肢（TUIの表示順 = 番号キーの割り当て順）。 */
	readonly options?: readonly IParadisAgentQuestionOption[];
	/** kind==='question' のとき: 複数選択可能な質問か（TUIではトグル選択 + Enter確定）。 */
	readonly multiSelect?: boolean;
	/** kind==='question' | 'tool_result' のとき: 対応付け用の tool_use ID。
	 *  同じIDの tool_result が後続に現れたら質問は回答済み（モバイルはUIを非活性化する）。 */
	readonly toolUseId?: string;
	/** kind==='question' のとき: 同一 AskUserQuestion 呼び出しのグループキー。
	 *  複数質問はモバイル側でこのキーごとに1枚のステップ式カードへ集約され、
	 *  全問回答が揃ってから一括でTUIへ注入される（1問ごとのEnterはフォーム全体を
	 *  Submitしてしまうため）。 */
	readonly questionGroup?: string;
	/** kind==='question' のとき: グループ内の位置（0起点）。 */
	readonly questionIndex?: number;
	/** kind==='question' のとき: グループの総質問数。 */
	readonly questionCount?: number;
	/** kind==='peer_message': Claude Code Agent Teamsの送信元と要約。 */
	readonly peerName?: string;
	readonly peerSummary?: string;
}

/** transcript確定前に表示する一時的な実行状況。履歴revには含めず、常に最新値で置換する。 */
export interface IParadisAgentLiveState {
	readonly phase: 'thinking' | 'tool' | 'message' | 'permission';
	readonly source: 'hook' | 'transcript' | 'codex-daemon' | 'pty';
	/** 現在の処理が始まった時刻（経過時間表示用）。 */
	readonly startedAt: number;
	readonly updatedAt: number;
	readonly tool?: string;
	readonly detail?: string;
	/** MessageDisplay / daemon deltaで先出しする生成中テキスト。 */
	readonly text?: string;
	readonly final?: boolean;
	/** transcript/PTYが明示的に報告した経過秒。無ければstartedAtから算出する。 */
	readonly elapsedSeconds?: number;
	/** PTY等が表示した概算生成トークン数。 */
	readonly tokenCount?: number;
}

/** セッションのメタ情報（モバイルのエージェントタブに表示する）。 */
export interface IParadisAgentSessionInfo {
	/** モデル名（Claude: assistant行の message.model、Codex: turn_context.model）。 */
	readonly model?: string;
	/** reasoning effort（Codex: turn_context.effort、Claude: settings.json の既定値 + /effort の実行記録）。 */
	readonly effort?: string;
}

export interface IParadisAgentInteraction {
	readonly kind: 'question' | 'approval';
	readonly id: string;
}

/** agentチャネルのモバイル→PCメッセージ。 */
type AgentInbound =
	| { t: 'attach'; id: number; token?: string; epoch?: string; afterRev?: number }
	| { t: 'detach'; id: number; token?: string }
	| { t: 'action/sendMessage'; id: number; token?: string; requestId: string; epoch: string; text: string }
	| { t: 'model-catalog'; id: number; token?: string; requestId: string }
	| { t: 'settings-update'; id: number; token?: string; requestId: string; model: string; effort: string };

/** agentチャネルのPC→モバイルメッセージ。 */
type AgentOutbound =
	| { t: 'snapshot'; id: number; agent: ParadisAgentKind; epoch: string; rev: number; messages: IParadisAgentChatMessage[]; truncated?: boolean; info?: IParadisAgentSessionInfo; live?: IParadisAgentLiveState | null; activity?: IParadisAgentActivityState | null; interaction?: IParadisAgentInteraction | null; capabilities?: { readonly agentActions: true } }
	| { t: 'delta'; id: number; agent: ParadisAgentKind; epoch: string; rev: number; messages: IParadisAgentChatMessage[]; info?: IParadisAgentSessionInfo; live?: IParadisAgentLiveState | null; activity?: IParadisAgentActivityState | null; interaction?: IParadisAgentInteraction | null; capabilities?: { readonly agentActions: true } }
	| { t: 'model-catalog'; id: number; requestId: string; models: readonly IParadisCodexModelOption[] }
	| { t: 'settings-update'; id: number; requestId: string; status: 'pending' | 'confirmed' | 'failed'; info?: IParadisAgentSessionInfo; code?: string; message?: string }
	| { t: 'action-result'; id: number; requestId: string; status: 'accepted' | 'rejected'; code?: string; message?: string }
	| { t: 'model-control-error'; id: number; requestId: string; code: string; message: string }
	| { t: 'none'; id: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const POLL_INTERVAL_MS = 1500;
/** 初回読み込みでファイルがこれより大きい場合、末尾のみ読む (長大セッション対策)。 */
const INITIAL_READ_MAX_BYTES = 4 * 1024 * 1024;
const INITIAL_READ_TAIL_BYTES = 1024 * 1024;
/** 保持するメッセージ数の上限 (超過分は古いものから捨てる)。 */
const MESSAGE_RING_LIMIT = 400;
/** attach応答スナップショットで送る最大件数。 */
const SNAPSHOT_SEND_LIMIT = 200;
/** 本文テキストの上限 (モバイル表示用。超過は末尾に…を付けて切る)。 */
const TEXT_LIMIT = 6000;
const TOOL_TEXT_LIMIT = 1500;
const nodeRequire = createRequire(import.meta.url);

function truncateText(text: string, limit: number): string {
	// allow-any-unicode-next-line
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** 生成中テキストは後続deltaが見えるよう、上限超過時は末尾を保持する。 */
function truncateLiveText(text: string, limit: number): string {
	// allow-any-unicode-next-line
	return text.length > limit ? `…${text.slice(-(limit - 1))}` : text;
}

function newEpoch(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function agentKindForPath(transcriptPath: string): ParadisAgentKind {
	// CODEX_HOME を移動していると ".codex" がパスに現れないため、rolloutのファイル名規約と
	// 解決済みhome配下かでも判定する (Claude の transcript は <uuid>.jsonl でrollout-接頭辞を持たない)。
	if (/[\\/]\.codex[\\/]/.test(transcriptPath) || /[\\/]rollout-[^\\/]*\.jsonl$/.test(transcriptPath)) {
		return 'codex';
	}
	const codexHome = paradisCodexHome();
	return (transcriptPath === codexHome || transcriptPath.startsWith(codexHome + sep)) ? 'codex' : 'claude';
}

/**
 * hook経由で届いた transcript_path が許可ディレクトリ（~/.claude / ~/.codex 配下）に
 * 収まっているかを検証する。ペイントークンはターミナルの全子プロセスへ環境変数として
 * 渡るため、hookエンドポイントを騙って任意ファイルをモバイルへtailさせる悪用を防ぐ
 * （所在検証 + realpath でシンボリックリンク・`..` 経由の脱出も排除する）。
 */
async function isAllowedTranscriptPath(transcriptPath: string): Promise<boolean> {
	if (!isAbsolute(transcriptPath) || !transcriptPath.endsWith('.jsonl')) {
		return false;
	}
	const roots = [paradisClaudeConfigDir(), paradisCodexHome()];
	const within = (candidate: string) => roots.some(root => candidate === root || candidate.startsWith(root + sep));
	if (!within(resolve(transcriptPath))) {
		return false;
	}
	try {
		// 実体（シンボリックリンク解決後）も許可ディレクトリ内であること。
		return within(await fs.realpath(transcriptPath));
	} catch {
		// 未作成ファイルは字面検証のみで許可する（tailerは作成を待てる）。
		return true;
	}
}

// ---- transcript行 → 正規化メッセージ --------------------------------------------------------

interface IRawMessage {
	readonly role: 'user' | 'assistant' | 'tool';
	readonly kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'question' | 'peer_message';
	readonly text: string;
	readonly tool?: string;
	readonly ts?: number;
	readonly header?: string;
	readonly options?: readonly IParadisAgentQuestionOption[];
	readonly multiSelect?: boolean;
	readonly toolUseId?: string;
	readonly questionGroup?: string;
	readonly questionIndex?: number;
	readonly questionCount?: number;
	readonly peerName?: string;
	readonly peerSummary?: string;
}

/**
 * 表示メッセージには乗らない「状態のためのシグナル」。パース時に1バッチ分を収集し、
 * tailer がバックグラウンドタスク・質問回答待ち・セッションメタ情報の追跡へ反映する。
 */
interface IParseSignals {
	/** バックグラウンドタスク（サブエージェント等）の起動: id → 起動時刻。 */
	readonly openedTasks: Map<string, number>;
	/** task-notification が届いた（完了・失敗・停止いずれも）タスクID。 */
	readonly closedTasks: string[];
	/** 出現した質問 (AskUserQuestion) の tool_use_id。 */
	readonly askedQuestionIds: string[];
	/** tool_result が現れた tool_use_id（質問の「回答済み」判定）。 */
	readonly answeredIds: string[];
	/** 実ユーザーのテキスト発話があった（未回答質問クリアの保険）。 */
	userText: boolean;
	/**
	 * ターンが終了した（Codex event_msg の task_complete / error / turn_aborted）。
	 * usage limit 等のエラー中断は Stop 系 hook が発火しないため、transcript が唯一の検出点。
	 * ライブ追記時のみライブ状態（考え中表示）の解除に使う。
	 */
	turnEnded: 'completed' | 'failed' | 'interrupted' | undefined;
	model?: string;
	effort?: string;
}

function newParseSignals(): IParseSignals {
	return { openedTasks: new Map(), closedTasks: [], askedQuestionIds: [], answeredIds: [], userText: false, turnEnded: undefined };
}

function decodeXmlAttribute(value: string): string {
	return value.replace(/&quot;/g, '"').replace(/&apos;/g, String.fromCodePoint(39)).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Claude Code Agent TeamsのMailbox配送を通常のユーザー発言から分離する。 */
function parseClaudePeerMessage(rawText: string, ts: number | undefined): IRawMessage | null | undefined {
	// ユーザーがタグ文字列を質問に含めただけのケースを誤分類しないよう、Claude Codeが
	// 付ける配送prefixまたはcross-session wrapperが先頭にある場合だけ内部通信として扱う。
	if (!rawText.startsWith('Another Claude session sent a message') && !rawText.startsWith('<cross-session-message>')) {
		return undefined;
	}
	const tagged = /<(teammate-message|agent-message)\b([^>]*)>([\s\S]*?)<\/\1>/.exec(rawText);
	if (tagged === null) {
		const crossSession = /<cross-session-message>([\s\S]*?)<\/cross-session-message>/.exec(rawText);
		const text = (crossSession?.[1] ?? rawText.replace(/^Another Claude session sent a message(?: while you were working)?:?\s*/, '')).trim();
		return text.length > 0 ? { role: 'assistant', kind: 'peer_message', text: truncateText(text, TEXT_LIMIT), ts } : null;
	}
	const attributes = tagged[2];
	const body = tagged[3].trim();
	try {
		const protocol = rec(JSON.parse(body));
		if (protocol?.['type'] === 'idle_notification') {
			return null;
		}
	} catch {
		// 通常の自然言語レポートはJSONではない。
	}
	if (body.length === 0) {
		return null;
	}
	const name = /\b(?:teammate_id|from)="([^"]+)"/.exec(attributes)?.[1];
	const summary = /\bsummary="([^"]+)"/.exec(attributes)?.[1];
	return {
		role: 'assistant', kind: 'peer_message', text: truncateText(body, TEXT_LIMIT), ts,
		...(name !== undefined ? { peerName: decodeXmlAttribute(name) } : {}),
		...(summary !== undefined ? { peerSummary: decodeXmlAttribute(summary) } : {}),
	};
}

/** unknown からの安全なプロパティ読み出し。 */
function rec(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Codex rollout先頭行から、cwdと共有daemonのthread IDを取り出す。 */
export function paradisParseCodexSessionMeta(firstLine: string): { readonly cwd: string; readonly sessionId?: string } | undefined {
	try {
		const meta = rec(JSON.parse(firstLine));
		const payload = rec(meta?.['payload']);
		const cwd = str(payload?.['cwd']);
		if (meta?.['type'] !== 'session_meta' || cwd === undefined) {
			return undefined;
		}
		const sessionId = str(payload?.['session_id']) ?? str(payload?.['id']);
		return { cwd, ...(sessionId !== undefined && sessionId.length > 0 ? { sessionId } : {}) };
	} catch {
		return undefined;
	}
}

export function paradisSelectUnambiguousSessionCandidate<T extends { readonly transcriptPath: string; readonly mtime: number }>(
	candidates: readonly T[],
	minMtime: number | undefined,
	excludedPaths: ReadonlySet<string>,
): T | undefined {
	const fresh = candidates
		.filter(candidate => !excludedPaths.has(candidate.transcriptPath))
		.filter(candidate => minMtime === undefined || candidate.mtime >= minMtime)
		.sort((a, b) => b.mtime - a.mtime);
	return fresh.length === 1 ? fresh[0] : undefined;
}

interface ITranscriptProgress {
	readonly tool: string;
	readonly detail?: string;
	readonly elapsedSeconds?: number;
	readonly done?: boolean;
}

/** Claude transcriptのephemeral progress行を、表示に必要な最小情報へ正規化する。 */
function parseClaudeProgress(obj: Record<string, unknown>): ITranscriptProgress | undefined {
	if (obj['type'] !== 'progress') {
		return undefined;
	}
	const data = rec(obj['data']);
	const type = str(data?.['type']);
	if (type === 'bash_progress') {
		const output = str(data?.['output'])?.trim();
		const detail = output?.split(/\r?\n/).filter(Boolean).at(-1);
		const elapsedSeconds = num(data?.['elapsedTimeSeconds']);
		return {
			tool: 'Bash',
			...(detail !== undefined ? { detail: truncateText(detail, 500) } : {}),
			...(elapsedSeconds !== undefined ? { elapsedSeconds } : {}),
		};
	}
	if (type === 'mcp_progress') {
		const toolName = str(data?.['toolName']) ?? 'MCP';
		const serverName = str(data?.['serverName']);
		const progressMessage = str(data?.['progressMessage']);
		const status = str(data?.['status']);
		const elapsedTimeMs = num(data?.['elapsedTimeMs']);
		const detail = [serverName !== undefined ? `${serverName} MCP` : undefined, progressMessage].filter((part): part is string => part !== undefined && part.length > 0).join(' · ');
		return {
			tool: toolName,
			...(detail.length > 0 ? { detail: truncateText(detail, 500) } : {}),
			...(elapsedTimeMs !== undefined ? { elapsedSeconds: Math.max(0, Math.round(elapsedTimeMs / 1000)) } : {}),
			...((status === 'completed' || status === 'failed') ? { done: true } : {}),
		};
	}
	return undefined;
}

/** tool_result 等の content (string | ブロック配列) を表示テキストへ平坦化する。 */
function flattenContent(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			const b = rec(block);
			if (!b) {
				continue;
			}
			const text = str(b['text']);
			if (text !== undefined) {
				parts.push(text);
			} else if (b['type'] === 'image') {
				parts.push('[image]');
			}
		}
		return parts.join('\n');
	}
	return '';
}

/**
 * AskUserQuestion の input（{ questions: [{ question, header, options: [{label, description}] , multiSelect? }] }）を
 * question メッセージ列へ展開する。想定形でなければ空配列（呼び出し側が汎用 tool_use にフォールバック）。
 */
function parseAskUserQuestions(input: unknown, toolUseId: string | undefined, ts: number | undefined): IRawMessage[] {
	const inputRec = rec(input);
	const questionsRaw = inputRec?.['questions'];
	if (!Array.isArray(questionsRaw)) {
		return [];
	}
	const out: IRawMessage[] = [];
	for (const questionRaw of questionsRaw) {
		const q = rec(questionRaw);
		const questionText = str(q?.['question']);
		if (!q || questionText === undefined || questionText.trim().length === 0) {
			continue;
		}
		const options: IParadisAgentQuestionOption[] = [];
		const optionsRaw = q['options'];
		if (Array.isArray(optionsRaw)) {
			for (const optionRaw of optionsRaw) {
				const o = rec(optionRaw);
				const label = str(o?.['label']);
				if (label !== undefined && label.trim().length > 0) {
					const description = str(o?.['description']);
					options.push({ label: truncateText(label, 200), ...(description !== undefined ? { description: truncateText(description, 500) } : {}) });
				}
			}
		}
		out.push({
			role: 'assistant', kind: 'question', text: truncateText(questionText, TEXT_LIMIT), ts,
			...(str(q['header']) !== undefined ? { header: str(q['header']) } : {}),
			...(options.length > 0 ? { options } : {}),
			...(q['multiSelect'] === true ? { multiSelect: true } : {}),
			...(toolUseId !== undefined ? { toolUseId } : {}),
		});
	}
	// 同一呼び出しの複数質問はモバイル側で1枚のステップ式カードへ集約するため、グループメタを
	// 付与する（グループキーは transcript 経路では実 toolUseId。ライブ注入経路では toolUseId が
	// 無いため injectLiveQuestions 側で合成キーを設定する）。
	return out.map((message, index) => ({
		...message,
		questionIndex: index,
		questionCount: out.length,
		...(toolUseId !== undefined ? { questionGroup: toolUseId } : {}),
	}));
}

/**
 * ライブ質問（hook注入）と transcript 上の本物の質問を突き合わせるための内容キー。
 * 両者とも parseAskUserQuestions を通るため、truncate 後のテキストが一致する。
 */
function liveQuestionContentKey(m: IRawMessage): string {
	return `${m.text}\0${(m.options ?? []).map(o => o.label).join('\x01')}`;
}

/**
 * Claude Code のユーザーロール行のテキストを表示メッセージへ変換する。
 * ハーネスが user ロールとして注入する合成テキスト（バックグラウンドタスクの完了通知・
 * スラッシュコマンドの実行記録・system-reminder 等）は「ユーザーの発言」として
 * 吹き出し表示すると誤解を招くため、種類ごとに変換・除去する。
 */
function pushClaudeUserText(out: IRawMessage[], rawText: string, ts: number | undefined, signals: IParseSignals): void {
	const trimmed = rawText.trim();
	if (trimmed.length === 0) {
		return;
	}
	const peerMessage = parseClaudePeerMessage(trimmed, ts);
	if (peerMessage !== undefined) {
		if (peerMessage !== null) {
			out.push(peerMessage);
		}
		return;
	}
	// ユーザーがescでツール実行（AskUserQuestion等）を中断した際にハーネスが注入する
	// 内部マーカー。ユーザーの発言ではないため表示しない（signals.userTextも立てない。
	// 立てると同一バッチ内の未回答質問カードを誤ってクリアしてしまう）。
	if (/^\[Request interrupted by user( for tool use)?\]$/.test(trimmed)) {
		return;
	}
	// バックグラウンドタスク（サブエージェント等）の完了通知。ユーザーの発言ではなく
	// ハーネスからの通知なので、ツール結果カードとして表示する。
	if (trimmed.startsWith('<task-notification>')) {
		for (const match of trimmed.matchAll(/<task-id>([^<\n]+)<\/task-id>/g)) {
			signals.closedTasks.push(match[1].trim());
		}
		const summary = /<summary>([\s\S]*?)<\/summary>/.exec(trimmed)?.[1]?.trim();
		const result = /<result>([\s\S]*?)<\/result>/.exec(trimmed)?.[1]?.trim();
		const status = /<status>([^<\n]+)<\/status>/.exec(trimmed)?.[1]?.trim();
		// allow-any-unicode-next-line
		const title = summary !== undefined && summary.length > 0 ? `バックグラウンドタスク完了: ${summary}` : 'バックグラウンドタスクが完了しました';
		const parts = [title];
		if (status !== undefined && status !== 'completed') {
			parts.push(`status: ${status}`);
		}
		if (result !== undefined && result.length > 0) {
			parts.push(result);
		}
		out.push({ role: 'tool', kind: 'tool_result', text: truncateText(parts.join('\n'), TOOL_TEXT_LIMIT), ts });
		return;
	}
	// スラッシュコマンドの実行記録（/compact 等）。コマンド名だけを短く出す。
	const commandName = /<command-name>([^<\n]*)<\/command-name>/.exec(trimmed)?.[1]?.trim();
	if (commandName !== undefined && commandName.length > 0) {
		const commandArgs = /<command-args>([^<\n]*)<\/command-args>/.exec(trimmed)?.[1]?.trim();
		out.push({ role: 'user', kind: 'text', text: truncateText(commandArgs ? `${commandName} ${commandArgs}` : commandName, TEXT_LIMIT), ts });
		return;
	}
	// ローカルコマンドの出力・注意書きはノイズなので出さない。ただし /effort の実行記録は
	// セッションの effort 変更としてメタ情報へ反映する（Claude の transcript に effort の
	// 直接の記録は無く、これと settings.json の既定値だけが手掛かり）。
	if (trimmed.startsWith('<local-command-stdout>') || trimmed.startsWith('<local-command-caveat>')) {
		const effortMatch = /^<local-command-stdout>Set effort level to (\w+)/.exec(trimmed);
		if (effortMatch) {
			signals.effort = effortMatch[1];
		}
		return;
	}
	// 本文へ付随する system-reminder（メモリ想起等のハーネス注入）は表示から除く。
	const text = rawText.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
	if (text.length === 0) {
		return;
	}
	signals.userText = true;
	out.push({ role: 'user', kind: 'text', text: truncateText(text, TEXT_LIMIT), ts });
}

/** Claude Code transcript JSONL の1行をパースする。表示対象外の行は空配列。 */
function parseClaudeLine(obj: Record<string, unknown>, signals: IParseSignals): IRawMessage[] {
	if (obj['isSidechain'] === true || obj['isMeta'] === true) {
		return []; // サブエージェント内・メタ行はメインの会話に出さない
	}
	const type = str(obj['type']);
	if (type !== 'user' && type !== 'assistant') {
		return []; // summary / system / file-history-snapshot 等
	}
	const message = rec(obj['message']);
	if (!message) {
		return [];
	}
	const tsRaw = str(obj['timestamp']);
	const tsParsed = tsRaw !== undefined ? Date.parse(tsRaw) : NaN;
	const ts = Number.isFinite(tsParsed) ? tsParsed : undefined;
	const out: IRawMessage[] = [];
	const content = message['content'];

	if (type === 'user') {
		if (typeof content === 'string') {
			pushClaudeUserText(out, content, ts, signals);
			return out;
		}
		if (Array.isArray(content)) {
			for (const block of content) {
				const b = rec(block);
				if (!b) {
					continue;
				}
				if (b['type'] === 'text') {
					pushClaudeUserText(out, str(b['text']) ?? '', ts, signals);
				} else if (b['type'] === 'tool_result') {
					const text = flattenContent(b['content']);
					// toolUseId は質問(AskUserQuestion)の「回答済み」判定に使う（本文が空でも回答は成立する）。
					const toolUseId = str(b['tool_use_id']);
					if (toolUseId !== undefined) {
						signals.answeredIds.push(toolUseId);
					}
					// バックグラウンドタスク（サブエージェント等）の起動応答から実行中タスクを学習する。
					if (/Async agent launched|running in the background/i.test(text)) {
						const idMatch = /\bagentId:\s*([A-Za-z0-9_-]+)/.exec(text) ?? /background with ID:\s*([A-Za-z0-9_-]+)/.exec(text);
						if (idMatch) {
							signals.openedTasks.set(idMatch[1], ts ?? Date.now());
						}
					}
					if (text.trim().length > 0) {
						out.push({
							role: 'tool', kind: 'tool_result', text: truncateText(text, TOOL_TEXT_LIMIT), ts,
							...(toolUseId !== undefined ? { toolUseId } : {}),
						});
					}
				}
			}
		}
		return out;
	}

	// assistant
	const model = str(message['model']);
	if (model !== undefined && model.length > 0) {
		signals.model = model;
	}
	if (Array.isArray(content)) {
		for (const block of content) {
			const b = rec(block);
			if (!b) {
				continue;
			}
			if (b['type'] === 'text') {
				const text = str(b['text']) ?? '';
				if (text.trim().length > 0) {
					out.push({ role: 'assistant', kind: 'text', text: truncateText(text, TEXT_LIMIT), ts });
				}
			} else if (b['type'] === 'thinking') {
				const text = str(b['thinking']) ?? '';
				if (text.trim().length > 0) {
					out.push({ role: 'assistant', kind: 'thinking', text: truncateText(text, TOOL_TEXT_LIMIT), ts });
				}
			} else if (b['type'] === 'tool_use') {
				const tool = str(b['name']) ?? 'tool';
				// AskUserQuestion はユーザーへの選択式質問。汎用ツールとして折りたたむと
				// モバイルで質問に気づけないため、専用の question メッセージに展開する。
				if (tool === 'AskUserQuestion') {
					const toolUseId = str(b['id']);
					const questions = parseAskUserQuestions(b['input'], toolUseId, ts);
					if (questions.length > 0) {
						if (toolUseId !== undefined) {
							signals.askedQuestionIds.push(toolUseId);
						}
						out.push(...questions);
						continue;
					}
					// input が想定形でない場合は従来どおり汎用 tool_use として出す
				}
				let text = '';
				const input = rec(b['input']);
				if (tool === 'Agent' || tool === 'Task') {
					// サブエージェント起動は description（何をさせるか）を出す方が JSON より分かりやすい。
					const description = str(input?.['description']);
					const subagentType = str(input?.['subagent_type']);
					if (description !== undefined && description.length > 0) {
						text = subagentType !== undefined && subagentType.length > 0 ? `${description} (${subagentType})` : description;
					}
				}
				if (text.length === 0) {
					try {
						text = JSON.stringify(b['input']);
					} catch { /* 表示は空でよい */ }
				}
				out.push({ role: 'assistant', kind: 'tool_use', tool, text: truncateText(text, TOOL_TEXT_LIMIT), ts });
			}
		}
	}
	return out;
}

/** transcript分類の回帰テスト用。productionと同じparserを1行だけ通す。 */
export function paradisParseClaudeTranscriptLineForTest(line: string): { messages: IRawMessage[]; userText: boolean } {
	let obj: Record<string, unknown> | undefined;
	try {
		obj = rec(JSON.parse(line));
	} catch {
		return { messages: [], userText: false };
	}
	if (obj === undefined) {
		return { messages: [], userText: false };
	}
	const signals = newParseSignals();
	const messages = JSON.parse(JSON.stringify(parseClaudeLine(obj, signals))) as IRawMessage[];
	return { messages, userText: signals.userText };
}

/** Codex rollout JSONL の1行をパースする。表示対象外の行は空配列。 */
function parseCodexLine(obj: Record<string, unknown>, signals: IParseSignals): IRawMessage[] {
	// rollout行: { timestamp, type, payload }
	if (obj['type'] === 'turn_context') {
		// ターンごとの実行コンテキスト（model / effort 等）。表示メッセージは無いがメタ情報を学習する。
		const context = rec(obj['payload']);
		const model = str(context?.['model']);
		const effort = str(context?.['effort']);
		if (model !== undefined && model.length > 0) {
			signals.model = model;
		}
		if (effort !== undefined && effort.length > 0) {
			signals.effort = effort;
		}
		return [];
	}
	if (obj['type'] === 'event_msg') {
		// event_msg は表示内容としては response_item と重複するため使わないが、ターン終了の
		// 検出にだけ使う。usage limit（error / codex_error_info: usage_limit_exceeded）や
		// 中断（turn_aborted）は hooks.json に対応イベントが無く Stop hook が発火しないため、
		// ここで拾わないと「考え中」表示が永久に残る。
		const eventPayload = rec(obj['payload']);
		const eventType = str(eventPayload?.['type']);
		if (eventType === 'task_complete' || eventType === 'error' || eventType === 'turn_aborted') {
			signals.turnEnded = eventType === 'task_complete' ? 'completed' : eventType === 'turn_aborted' ? 'interrupted' : 'failed';
		}
		return [];
	}
	if (obj['type'] !== 'response_item') {
		return []; // session_meta 等も対象外
	}
	const payload = rec(obj['payload']);
	if (!payload) {
		return [];
	}
	const tsRaw = str(obj['timestamp']);
	const tsParsed = tsRaw !== undefined ? Date.parse(tsRaw) : NaN;
	const ts = Number.isFinite(tsParsed) ? tsParsed : undefined;
	const ptype = str(payload['type']);
	// Codex のツール呼び出し/結果は call_id で対応付く (Claude の tool_use_id 相当)。
	// toolUseId に載せてモバイル側で呼び出し⇔結果の突き合わせに使えるようにする
	// (質問の回答済み判定は kind==='question' 限定なので Codex の ID が混ざっても影響しない)。
	const callId = str(payload['call_id']);
	const out: IRawMessage[] = [];

	if (ptype === 'message') {
		const role = str(payload['role']);
		if (role !== 'user' && role !== 'assistant') {
			return []; // developer / system プロンプトは出さない
		}
		const text = flattenContent(payload['content']);
		// Codexはuserメッセージとして環境コンテキスト/プロジェクト指示を注入するため表示から除く。
		// 旧CLI(0.4x): <environment_context> / <user_instructions>
		// 新CLI(0.80+): 「# AGENTS.md instructions for <path>」見出し＋<INSTRUCTIONS>ラッパー
		const trimmedText = text.trim();
		if (trimmedText.length === 0
			|| /^<(environment_context|user_instructions|ENVIRONMENT_CONTEXT|INSTRUCTIONS)/.test(trimmedText)
			|| trimmedText.startsWith('# AGENTS.md instructions for')) {
			return [];
		}
		out.push({ role, kind: 'text', text: truncateText(text, TEXT_LIMIT), ts });
	} else if (ptype === 'reasoning') {
		const text = flattenContent(payload['summary']);
		if (text.trim().length > 0) {
			out.push({ role: 'assistant', kind: 'thinking', text: truncateText(text, TOOL_TEXT_LIMIT), ts });
		}
	} else if (ptype === 'function_call' || ptype === 'custom_tool_call' || ptype === 'mcp_tool_call') {
		// custom_tool_call は arguments でなく input にテキストが入る（それ以外は function_call と同形）
		const tool = str(payload['name']) ?? 'tool';
		const text = str(payload['arguments']) ?? str(payload['input']) ?? '';
		out.push({ role: 'assistant', kind: 'tool_use', tool, text: truncateText(text, TOOL_TEXT_LIMIT), ts, ...(callId !== undefined ? { toolUseId: callId } : {}) });
	} else if (ptype === 'web_search_call' || ptype === 'tool_search_call') {
		// web_search_call は action.query、tool_search_call は arguments(オブジェクト)にクエリが入る
		const action = rec(payload['action']);
		const args = rec(payload['arguments']);
		let query = str(action?.['query']) ?? str(args?.['query']) ?? '';
		if (query.length === 0) {
			try {
				query = JSON.stringify(args ?? action ?? '');
			} catch { /* 表示は空でよい */ }
		}
		out.push({ role: 'assistant', kind: 'tool_use', tool: ptype === 'web_search_call' ? 'web_search' : 'tool_search', text: truncateText(query, TOOL_TEXT_LIMIT), ts, ...(callId !== undefined ? { toolUseId: callId } : {}) });
	} else if (ptype === 'tool_search_output') {
		// tool_search_call の結果 ({ call_id, status, execution, tools: [...] })。見つかった
		// ツール一覧を結果カードとして出す (無視するとツール検索の結果だけ同期から抜ける)。
		const toolsRaw = payload['tools'];
		let text = '';
		if (Array.isArray(toolsRaw) && toolsRaw.length > 0) {
			try {
				text = toolsRaw.map(tool => {
					const t = rec(tool);
					return str(t?.['name']) ?? JSON.stringify(tool);
				}).join('\n');
			} catch { /* 表示は空でよい */ }
		}
		if (text.trim().length === 0) {
			text = str(payload['status']) ?? '';
		}
		if (text.trim().length > 0) {
			out.push({ role: 'tool', kind: 'tool_result', text: truncateText(text, TOOL_TEXT_LIMIT), ts, ...(callId !== undefined ? { toolUseId: callId } : {}) });
		}
	} else if (ptype === 'custom_tool_call_output') {
		const text = str(payload['output']) ?? '';
		if (text.trim().length > 0) {
			out.push({ role: 'tool', kind: 'tool_result', text: truncateText(text, TOOL_TEXT_LIMIT), ts, ...(callId !== undefined ? { toolUseId: callId } : {}) });
		}
	} else if (ptype === 'local_shell_call') {
		let text = '';
		try {
			text = JSON.stringify(payload['action']);
		} catch { /* 表示は空でよい */ }
		out.push({ role: 'assistant', kind: 'tool_use', tool: 'shell', text: truncateText(text, TOOL_TEXT_LIMIT), ts, ...(callId !== undefined ? { toolUseId: callId } : {}) });
	} else if (ptype === 'function_call_output') {
		const output = payload['output'];
		let text: string;
		if (typeof output === 'string') {
			text = output;
		} else {
			const o = rec(output);
			text = str(o?.['content']) ?? flattenContent(output) ?? '';
			if (!text) {
				try {
					text = JSON.stringify(output);
				} catch {
					text = '';
				}
			}
		}
		if (text.trim().length > 0) {
			out.push({ role: 'tool', kind: 'tool_result', text: truncateText(text, TOOL_TEXT_LIMIT), ts, ...(callId !== undefined ? { toolUseId: callId } : {}) });
		}
	}
	return out;
}

// ---- hook未発火時のセッション探索フォールバック ------------------------------------------------

async function discoverCodexSessionsFromStateDb(cwd: string, minMtime: number | undefined): Promise<{ agent: ParadisAgentKind; transcriptPath: string; mtime: number; sessionId?: string; createdAt?: number }[] | undefined> {
	let database: DatabaseSync | undefined;
	try {
		const names = await fs.readdir(paradisCodexHome());
		const stateDb = names.filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
		if (stateDb === undefined) {
			return undefined;
		}
		const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		database = new DatabaseSyncCtor(join(paradisCodexHome(), stateDb), { readOnly: true });
		const rows = database.prepare(`
			SELECT id, rollout_path, COALESCE(updated_at_ms, updated_at * 1000) AS mtime,
				COALESCE(created_at_ms, created_at * 1000) AS created_at
			FROM threads
			WHERE cwd = ? AND archived = 0
				AND (? IS NULL OR COALESCE(updated_at_ms, updated_at * 1000) >= ?)
			ORDER BY mtime DESC
		`).all(cwd, minMtime ?? null, minMtime ?? null) as unknown[];
		const candidates: { agent: ParadisAgentKind; transcriptPath: string; mtime: number; sessionId?: string; createdAt?: number }[] = [];
		for (const value of rows) {
			const row = rec(value);
			const transcriptPath = str(row?.['rollout_path']);
			const sessionId = str(row?.['id']);
			const mtime = num(row?.['mtime']);
			const createdAt = num(row?.['created_at']);
			if (transcriptPath === undefined || !isAbsolute(transcriptPath) || !transcriptPath.endsWith('.jsonl') || mtime === undefined) {
				continue;
			}
			candidates.push({
				agent: 'codex', transcriptPath, mtime,
				...(sessionId !== undefined && sessionId.length > 0 ? { sessionId } : {}),
				...(createdAt !== undefined ? { createdAt } : {}),
			});
		}
		return candidates;
	} catch {
		return undefined; // 古いCodex/SQLite非対応環境ではファイル走査へフォールバック
	} finally {
		database?.close();
	}
}

/**
 * ターミナルのcwdから実行中らしいエージェントセッションのtranscriptを探す。
 * hookは「アプリ起動後に発火したイベント」しか知れないため、Para Code起動前から
 * 動いているセッションや発言がまだ無いセッションはこれで拾う（後からhookが発火したら
 * そちらが正となり上書きされる）。
 * - Claude: ~/.claude/projects/<cwdスラッグ>/ の最新 .jsonl
 * - Codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl の直近ファイルのうち
 *           先頭行 session_meta の cwd が一致する最新のもの
 */
async function discoverSessionByCwd(cwd: string, agent: ParadisAgentKind, minMtime?: number, excludedPaths: ReadonlySet<string> = new Set()): Promise<{ agent: ParadisAgentKind; transcriptPath: string; mtime: number; sessionId?: string; createdAt?: number } | undefined> {
	const candidates: { agent: ParadisAgentKind; transcriptPath: string; mtime: number; sessionId?: string; createdAt?: number }[] = [];

	// Claude: cwd → プロジェクトディレクトリのスラッグ（英数字以外を '-' に置換）。
	// Claude Code はcwdをrealpath解決してからスラッグ化するため、symlink経由のターミナルでも
	// 一致するよう解決後のパスを使う（解決失敗時は文字面のまま）。
	if (agent === 'claude') {
		try {
			let resolvedCwd = cwd;
			try {
				resolvedCwd = await fs.realpath(cwd);
			} catch { /* 消えたディレクトリ等は文字面で試す */ }
			const slug = resolvedCwd.replace(/[^a-zA-Z0-9]/g, '-');
			const dir = join(paradisClaudeConfigDir(), 'projects', slug);
			const names = await fs.readdir(dir);
			for (const name of names) {
				if (!name.endsWith('.jsonl')) {
					continue;
				}
				try {
					const stat = await fs.stat(join(dir, name));
					candidates.push({ agent: 'claude', transcriptPath: join(dir, name), mtime: stat.mtimeMs });
				} catch { /* 消えた直後などは無視 */ }
			}
		} catch { /* プロジェクトディレクトリ無し = Claudeセッション無し */ }
	}

	// Codex: sessions配下を走査し、コマンド開始後に更新されたrolloutを新しい順に見て
	// session_meta.cwdを突合する。作成日が古いresumeセッションもmtime更新で候補になる。
	if (agent === 'codex') {
		const indexed = await discoverCodexSessionsFromStateDb(cwd, minMtime);
		if (indexed !== undefined) {
			candidates.push(...indexed);
		}
		if (indexed === undefined) {
			try {
				const sessionsRoot = join(paradisCodexHome(), 'sessions');
				const rollouts: { path: string; mtime: number }[] = [];
				const collect = async (dir: string, depth: number): Promise<void> => {
					let entries: Dirent[];
					try {
						entries = await fs.readdir(dir, { withFileTypes: true });
					} catch {
						return;
					}
					for (const entry of entries) {
						const path = join(dir, entry.name);
						if (entry.isDirectory() && depth < 3) {
							await collect(path, depth + 1);
						} else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
							try {
								const stat = await fs.stat(path);
								if (minMtime === undefined || stat.mtimeMs >= minMtime) {
									rollouts.push({ path, mtime: stat.mtimeMs });
								}
							} catch { /* 消えた直後などは無視 */ }
						}
					}
				};
				await collect(sessionsRoot, 0);
				rollouts.sort((a, b) => b.mtime - a.mtime);
				for (const rollout of rollouts) {
					try {
						const handle = await fs.open(rollout.path, 'r');
						let firstLine: string;
						try {
							const buffer = Buffer.alloc(16 * 1024);
							const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
							firstLine = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? '';
						} finally {
							await handle.close();
						}
						const meta = paradisParseCodexSessionMeta(firstLine);
						if (meta?.cwd === cwd) {
							const sessionId = meta.sessionId;
							candidates.push({
								agent: 'codex', transcriptPath: rollout.path, mtime: rollout.mtime,
								...(sessionId !== undefined && sessionId.length > 0 ? { sessionId } : {}),
							});
						}
					} catch { /* 壊れた行・読み取り失敗は無視 */ }
				}
			} catch { /* sessions ディレクトリ無し = Codexセッション無し */ }
		}
	}

	// minMtime 指定時は「それ以降に更新されたtranscript」だけを受け付ける (コマンド実行検知
	// トリガーの鮮度ガード。古いセッションを誤って現行扱いにしない)。
	// cwdだけでは同一cwdの複数セッションをペインへ一意に帰属できない。誤threadの会話表示や
	// モデル変更を避けるため、候補が複数ある場合は推測せず未確定のままにする。
	return paradisSelectUnambiguousSessionCandidate(candidates, minMtime, excludedPaths);
}

// ---- tailer ---------------------------------------------------------------------------------

interface ITailerDelegate {
	/** 追記分のメッセージが確定した (差分push用)。 */
	onDelta(messages: IParadisAgentChatMessage[]): void;
	/** epoch が切り替わった (truncate検知・読み直し)。購読者へ全量スナップショットを送り直す。 */
	onEpochReset(): void;
	/** アクティビティ（バックグラウンドタスク・質問回答待ち）が変化した。 */
	onActivity(): void;
	/** セッションメタ情報（model / effort）が変化した。 */
	onInfo(): void;
	/** Claude transcriptのephemeral progress行を受けた。履歴には追加しない。 */
	onProgress(progress: ITranscriptProgress): void;
	/** ライブ追記でターン終了（task_complete / error / turn_aborted）を検出した。 */
	onTurnEnded(reason: 'completed' | 'failed' | 'interrupted'): void;
}

/**
 * 1つの transcript ファイルの追記を追いかけ、正規化メッセージのリングバッファを維持する。
 * fs.watch (即時性) + ポーリング (确実性) の二重化。ファイル未作成・一時的な読み取り失敗は
 * 次のポーリングで自然に回復する。読み取りは Promise チェーンで直列化する。
 */
class TranscriptTailer {
	epoch = newEpoch();
	rev = 0;
	readonly messages: IParadisAgentChatMessage[] = [];
	/** 実行中バックグラウンドタスク（サブエージェント等）: id → 起動時刻 (epoch ms)。 */
	readonly backgroundTasks = new Map<string, number>();
	/** 回答待ちの質問 (AskUserQuestion) の tool_use_id。 */
	readonly pendingQuestions = new Set<string>();
	/**
	 * PreToolUse hook でライブ注入した質問: 内容キー → 合成toolUseId。Claude Code は
	 * AskUserQuestion の tool_use を決着（回答/中断）まで transcript へ flush しないため、
	 * hook 供給の合成カードを先に出し、決着後に transcript へ現れる本物と突き合わせる。
	 */
	private readonly liveQuestions = new Map<string, string[]>();
	/**
	 * transcript に現れた本物の tool_use_id → 合成ID群（後続 tool_result の付け替え用）。
	 * 1回の AskUserQuestion に複数の質問が含まれると、合成カードは質問ごとに別IDだが
	 * 本物の tool_use_id / tool_result は1つなので、配列で全合成IDを決着させる。
	 */
	private readonly liveQuestionRealIds = new Map<string, string[]>();
	private liveQuestionSeq = 0;
	/** ライブ注入の質問グループ連番（1回の AskUserQuestion hook = 1グループ）。 */
	private liveQuestionGroupSeq = 0;
	/** セッションメタ情報（transcriptから学習した最新値）。 */
	model: string | undefined;
	effort: string | undefined;
	/** 初回読み込みが完了したら resolve (attach応答はこれを待つ)。 */
	readonly ready: Promise<void>;

	private offset = 0;
	private remainder = '';
	// transcript を offset 連続で読み進める間、UTF-8マルチバイト文字が読み境界で分断されても
	// 化けないよう stream モードでデコードする（境界の継続バイトはデコーダ内部で持ち越される）。
	// epoch reset（offset 0 へ巻き戻し）時は新しいインスタンスに差し替えて内部状態を捨てる。
	private decoder = new TextDecoder();
	private initialTruncated = false;
	private watcher: FSWatcher | undefined;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private chain: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(
		readonly transcriptPath: string,
		readonly agent: ParadisAgentKind,
		private readonly delegate: ITailerDelegate,
		private readonly logService: ILogService,
	) {
		this.ready = this.enqueue(() => this.initialLoad());
		this.startWatching();
		this.pollTimer = setInterval(() => this.enqueue(() => this.readAppended()), POLL_INTERVAL_MS);
		if (agent === 'claude') {
			// Claude の transcript は effort を直接記録しない。既定値を settings.json から
			// 補完する（セッション内の /effort 変更は transcript の実行記録が上書きする）。
			this.loadClaudeDefaultEffort().catch(() => { /* settings.json 無し・壊れは無視 */ });
		}
	}

	/** ~/.claude/settings.json の effortLevel を、transcript由来の値が無い場合の既定として適用する。 */
	private async loadClaudeDefaultEffort(): Promise<void> {
		const raw = await fs.readFile(join(paradisClaudeConfigDir(), 'settings.json'), 'utf8');
		const effortLevel = str(rec(JSON.parse(raw))?.['effortLevel']);
		if (!this.disposed && effortLevel !== undefined && effortLevel.length > 0 && this.effort === undefined) {
			this.effort = effortLevel;
			this.delegate.onInfo();
		}
	}

	get wasInitialTruncated(): boolean {
		return this.initialTruncated;
	}

	dispose(): void {
		this.disposed = true;
		this.watcher?.close();
		this.watcher = undefined;
		if (this.pollTimer !== undefined) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	private enqueue(work: () => Promise<void>): Promise<void> {
		const run = this.chain.then(async () => {
			if (!this.disposed) {
				await work();
			}
		});
		this.chain = run.catch(err => this.logService.trace('[paradisAgentChat] tail read failed (will retry on next poll)', String(err)));
		return this.chain;
	}

	private startWatching(): void {
		// ファイル未作成だと watch は throw する。その場合はポーリングだけで追い、
		// 最初の読み取り成功時に張り直す。watchはヒント扱いで、失われても poll が拾う。
		try {
			this.watcher = watch(this.transcriptPath, { persistent: false }, () => {
				this.enqueue(() => this.readAppended());
			});
			this.watcher.on('error', () => {
				this.watcher?.close();
				this.watcher = undefined;
			});
		} catch {
			this.watcher = undefined;
		}
	}

	private async initialLoad(): Promise<void> {
		let handle: fs.FileHandle;
		try {
			handle = await fs.open(this.transcriptPath, 'r');
		} catch {
			return; // 未作成。ポーリングで readAppended が offset 0 から読み始める
		}
		try {
			const stat = await handle.stat();
			let start = 0;
			if (stat.size > INITIAL_READ_MAX_BYTES) {
				start = stat.size - INITIAL_READ_TAIL_BYTES;
				this.initialTruncated = true;
			}
			const length = stat.size - start;
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await handle.read(buffer, 0, length, start);
			let text = this.decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
			if (start > 0) {
				// 途中から読んだ場合、最初の不完全行を捨てる
				const firstNewline = text.indexOf('\n');
				text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
			}
			this.offset = start + bytesRead;
			this.consumeText(text, false);
			if (!this.watcher) {
				this.startWatching();
			}
		} finally {
			await handle.close();
		}
	}

	private async readAppended(): Promise<void> {
		let handle: fs.FileHandle;
		try {
			handle = await fs.open(this.transcriptPath, 'r');
		} catch {
			return; // 消えている/未作成。次のポーリングで再試行
		}
		try {
			const stat = await handle.stat();
			if (stat.size < this.offset) {
				// truncate / 置き換え。epoch を切り替えて読み直す (購読者は全量を受け取り直す)
				this.logService.info(`[paradisAgentChat] transcript shrank, re-reading: ${this.transcriptPath}`);
				this.epoch = newEpoch();
				this.rev = 0;
				this.messages.length = 0;
				this.offset = 0;
				this.remainder = '';
				// offset 0 から読み直すので、前のバイト境界を持ち越したデコーダは捨てる。
				this.decoder = new TextDecoder();
				this.initialTruncated = false;
				this.backgroundTasks.clear();
				this.pendingQuestions.clear();
				this.pendingApprovalId = undefined;
				this.lastApprovalKey = undefined;
				this.liveQuestions.clear();
				this.liveQuestionRealIds.clear();
				this.model = undefined;
				this.effort = undefined;
				await handle.close().catch(() => { /* ignore */ });
				await this.initialLoad();
				// initialLoad が読み直した後の状態で購読者・状態レジストリを同期し直す
				// （新ファイルにタスク・質問が無い場合も「無し」を確実に反映する）。
				this.delegate.onEpochReset();
				this.delegate.onActivity();
				this.delegate.onInfo();
				return;
			}
			if (stat.size === this.offset) {
				return;
			}
			const length = stat.size - this.offset;
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
			this.offset += bytesRead;
			this.consumeText(this.decoder.decode(buffer.subarray(0, bytesRead), { stream: true }), true);
			if (!this.watcher) {
				this.startWatching();
			}
		} finally {
			await handle.close().catch(() => { /* ignore */ });
		}
	}

	/** 読み取ったテキストを行に分割してパースし、リングへ追加する。末尾の不完全行は持ち越す。 */
	private consumeText(text: string, emitDelta: boolean): void {
		const combined = this.remainder + text;
		const lines = combined.split('\n');
		this.remainder = lines.pop() ?? '';
		const added: IParadisAgentChatMessage[] = [];
		const signals = newParseSignals();
		let latestProgress: ITranscriptProgress | undefined;
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.length === 0) {
				continue;
			}
			let obj: Record<string, unknown> | undefined;
			try {
				obj = rec(JSON.parse(trimmed));
			} catch {
				continue; // 壊れた行はスキップ (フォーマット変化への耐性)
			}
			if (!obj) {
				continue;
			}
			if (this.agent === 'claude') {
				const progress = parseClaudeProgress(obj);
				if (progress !== undefined) {
					latestProgress = progress;
					continue;
				}
			}
			const raw = this.agent === 'claude' ? parseClaudeLine(obj, signals) : parseCodexLine(obj, signals);
			for (const message of raw) {
				// ライブ質問の決着処理: hookで注入済みの質問が決着後に transcript へ本物として
				// 現れたら間引き（合成カードで表示済み）、対応する tool_result は合成IDへ
				// 付け替える（モバイル側の合成カードが「回答済み」になる）。
				if (message.kind === 'question') {
					const contentKey = liveQuestionContentKey(message);
					const syntheticIds = this.liveQuestions.get(contentKey);
					const syntheticId = syntheticIds?.shift();
					if (syntheticId !== undefined) {
						if (message.toolUseId !== undefined) {
							const ids = this.liveQuestionRealIds.get(message.toolUseId);
							if (ids !== undefined) {
								ids.push(syntheticId);
							} else {
								this.liveQuestionRealIds.set(message.toolUseId, [syntheticId]);
							}
						}
						if (syntheticIds?.length === 0) {
							this.liveQuestions.delete(contentKey);
						}
						continue;
					}
				}
				if (message.kind === 'tool_result' && message.toolUseId !== undefined) {
					const syntheticIds = this.liveQuestionRealIds.get(message.toolUseId);
					if (syntheticIds !== undefined) {
						this.liveQuestionRealIds.delete(message.toolUseId);
						for (const syntheticId of syntheticIds) {
							signals.answeredIds.push(syntheticId);
							added.push({ ...message, toolUseId: syntheticId, rev: this.rev++ });
						}
						continue;
					}
				}
				added.push({ ...message, rev: this.rev++ });
			}
		}
		this.applySignals(signals, emitDelta);
		if (latestProgress !== undefined) {
			this.delegate.onProgress(latestProgress);
		}
		if (added.length === 0) {
			return;
		}
		this.messages.push(...added);
		if (this.messages.length > MESSAGE_RING_LIMIT) {
			this.messages.splice(0, this.messages.length - MESSAGE_RING_LIMIT);
		}
		if (emitDelta) {
			this.delegate.onDelta(added);
		}
	}

	/** 直近に注入した承認要求の内容キー（PermissionRequest hookの再発火による重複注入の抑止）。 */
	private lastApprovalKey: string | undefined;
	private pendingApprovalId: string | undefined;
	private approvalSeq = 0;

	/**
	 * PermissionRequest hook で受けた承認要求の内容（ツール名・コマンド等）を表示カードとして
	 * 注入する。Codex は承認要求を rollout に一切書かず、Claude もプロンプト表示中は
	 * transcript に現れないため、hook が唯一のライブな供給源。モバイル側はこのメッセージの
	 * 内容を承認バー（許可/拒否）に添えて表示する。
	 */
	injectApprovalRequest(toolName: string | undefined, toolInput: unknown, toolUseId?: string): void {
		this.enqueue(async () => {
			const input = rec(toolInput);
			const detail = str(input?.['description']) ?? str(input?.['command']) ?? (input !== undefined ? JSON.stringify(input) : '');
			const text = [toolName, detail].filter(v => v !== undefined && v.length > 0).join(': ');
			if (text.length === 0) {
				return;
			}
			const key = toolUseId !== undefined ? `${toolUseId}:${text}` : text;
			if (this.lastApprovalKey === key) {
				return; // 同一要求の再発火（リトライ等）は無視
			}
			const interactionId = toolUseId ?? `approval:${this.epoch}:${this.approvalSeq++}`;
			this.lastApprovalKey = key;
			this.pendingApprovalId = interactionId;
			const message: IParadisAgentChatMessage = {
				role: 'assistant', kind: 'tool_use', tool: 'approval_request',
				text: truncateText(text, TOOL_TEXT_LIMIT), ts: Date.now(), rev: this.rev++, toolUseId: interactionId,
			};
			this.messages.push(message);
			if (this.messages.length > MESSAGE_RING_LIMIT) {
				this.messages.splice(0, this.messages.length - MESSAGE_RING_LIMIT);
			}
			this.delegate.onDelta([message]);
		});
	}

	clearApprovalRequest(toolUseId: string | undefined, force: boolean): void {
		this.enqueue(async () => {
			if (this.pendingApprovalId === undefined || (!force && (toolUseId === undefined || this.pendingApprovalId !== toolUseId))) {
				return;
			}
			this.pendingApprovalId = undefined;
			this.lastApprovalKey = undefined;
			this.delegate.onDelta([]);
		});
	}

	currentInteraction(): IParadisAgentInteraction | null {
		if (this.pendingApprovalId !== undefined) {
			return { kind: 'approval', id: this.pendingApprovalId };
		}
		for (let index = this.messages.length - 1; index >= 0; index--) {
			const message = this.messages[index];
			if (message.kind === 'question' && message.toolUseId !== undefined && this.pendingQuestions.has(message.toolUseId)) {
				return { kind: 'question', id: message.questionGroup ?? message.toolUseId };
			}
		}
		return null;
	}

	hasPendingInteraction(interaction: IParadisAgentInteraction): boolean {
		const current = this.currentInteraction();
		return current?.kind === interaction.kind && current.id === interaction.id;
	}

	/**
	 * PreToolUse hook で受けた AskUserQuestion の tool_input をライブ質問カードとして注入する。
	 * transcript の読み取りと同じキューで直列化し、rev 採番・リング更新の競合を防ぐ。
	 * 注入されたカードは delegate.onDelta 経由で購読者へ届き、（onDelta 内の既存処理で）
	 * 質問プッシュ通知も発火する。
	 */
	injectLiveQuestions(input: unknown): void {
		this.enqueue(async () => {
			const parsed = parseAskUserQuestions(input, undefined, Date.now());
			// 1回の hook = 1つの AskUserQuestion 呼び出し。複数質問をモバイル側で1枚の
			// ステップ式カードへ集約できるよう、共通の合成グループキーを付与する
			const groupId = `liveg:${this.epoch}:${this.liveQuestionGroupSeq++}`;
			const added: IParadisAgentChatMessage[] = [];
			const occurrences = new Map<string, number>();
			for (const message of parsed) {
				const key = liveQuestionContentKey(message);
				const occurrence = occurrences.get(key) ?? 0;
				occurrences.set(key, occurrence + 1);
				const existingIds = this.liveQuestions.get(key) ?? [];
				if (existingIds.length > occurrence) {
					continue; // 同一質問の多重hook（リトライ等）は無視
				}
				const syntheticId = `live:${this.epoch}:${this.liveQuestionSeq++}`;
				existingIds.push(syntheticId);
				this.liveQuestions.set(key, existingIds);
				this.pendingQuestions.add(syntheticId);
				added.push({ ...message, toolUseId: syntheticId, questionGroup: groupId, rev: this.rev++ });
			}
			if (added.length === 0) {
				return;
			}
			this.messages.push(...added);
			if (this.messages.length > MESSAGE_RING_LIMIT) {
				this.messages.splice(0, this.messages.length - MESSAGE_RING_LIMIT);
			}
			this.delegate.onDelta(added);
			this.delegate.onActivity();
		});
	}

	/** パースで収集したシグナルをタスク・質問・メタ情報の追跡へ反映し、変化があれば通知する。 */
	private applySignals(signals: IParseSignals, live: boolean): void {
		let activityChanged = false;
		for (const [id, at] of signals.openedTasks) {
			if (!this.backgroundTasks.has(id)) {
				this.backgroundTasks.set(id, at);
				activityChanged = true;
			}
		}
		for (const id of signals.closedTasks) {
			if (this.backgroundTasks.delete(id)) {
				activityChanged = true;
			}
		}
		for (const id of signals.askedQuestionIds) {
			if (!this.pendingQuestions.has(id)) {
				this.pendingQuestions.add(id);
				activityChanged = true;
			}
		}
		for (const id of signals.answeredIds) {
			if (this.pendingQuestions.delete(id)) {
				activityChanged = true;
			}
		}
		// 保険: 実ユーザーのテキスト発話が現れた＝会話は先へ進んでいる。未回答のまま残った
		// 質問（形式外の回答・割り込み等）は回答待ち扱いを解除し、赤表示が残らないようにする。
		if (signals.userText && this.pendingQuestions.size > 0) {
			this.pendingQuestions.clear();
			activityChanged = true;
		}
		let infoChanged = false;
		if (signals.model !== undefined && signals.model !== this.model) {
			this.model = signals.model;
			infoChanged = true;
		}
		if (signals.effort !== undefined && signals.effort !== this.effort) {
			this.effort = signals.effort;
			infoChanged = true;
		}
		if (activityChanged) {
			this.delegate.onActivity();
		}
		if (infoChanged) {
			this.delegate.onInfo();
		}
		// ターン終了はライブ追記でのみ通知する（初回読み込み・epoch読み直しの履歴に含まれる
		// 過去の task_complete で、現在進行中のライブ状態を消してしまわないように）。
		if (live && signals.turnEnded !== undefined) {
			this.delegate.onTurnEnded(signals.turnEnded);
		}
	}
}

// ---- マネージャ ------------------------------------------------------------------------------

interface IPaneSessionInfo {
	readonly token: string;
	readonly agent: ParadisAgentKind;
	readonly transcriptPath: string;
	readonly sessionId: string | undefined;
}

/** セッション確定済みかつ現在rendererから生存同期されているペインだけを公開する。 */
export function paradisConfirmedAgentPaneTokens(
	confirmedTokens: Iterable<string>,
	liveTokens: Iterable<string>,
): readonly string[] {
	const live = new Set(liveTokens);
	return [...confirmedTokens].filter(token => live.has(token)).sort();
}

/**
 * agentチャネル本体。hookバスからペイン⇔transcriptの対応を学習し、モバイルの購読
 * (attach/detach) に応じて tailer を起動・停止する。tailer は購読者がいる間だけ動かし、
 * 誰も見ていないファイルの監視コストを避ける (再attach時はファイルから全量再構築)。
 */
export class ParadisMobileAgentChat extends Disposable {

	private readonly _onDidChangeConfirmedAgentPanes = this._register(new Emitter<readonly string[]>());
	readonly onDidChangeConfirmedAgentPanes = this._onDidChangeConfirmedAgentPanes.event;
	private lastConfirmedAgentPaneTokens: readonly string[] = [];

	/** ペイントークン → 既知のセッション情報 (hookバスから学習、購読の有無に関わらず保持)。 */
	private readonly paneSessions = new Map<string, IPaneSessionInfo>();
	/** transcriptPath → 所有ペイントークン。同一threadを複数ペインへ誤割当しない。 */
	private readonly transcriptClaims = new Map<string, string>();
	/** ターミナルinstanceId → ペイントークン (rendererから同期)。 */
	private readonly terminalToToken = new Map<number, string>();
	/** ペイントークン → ターミナルのcwd (rendererから同期。hook未発火時のセッション探索用)。 */
	private readonly tokenToCwd = new Map<string, string>();
	/** ペイントークン → workspace状態キー（通知タップ先の一意化用）。 */
	private readonly tokenToWorkspace = new Map<string, string>();
	/** ペイントークン → 稼働中の tailer (購読者がいる間のみ)。 */
	private readonly tailers = new Map<string, TranscriptTailer>();
	/** ペイントークン → 購読中モバイルID。複数端末から同じエージェントを同時に閲覧できる。 */
	private readonly subscribers = new Map<string, Set<string>>();
	/** ペイントークン → transcript確定前の最新ライブ状態。履歴とは独立に置換する。 */
	private readonly liveStates = new Map<string, IParadisAgentLiveState>();
	private readonly activityTrackers = new Map<string, ParadisAgentActivityTracker>();
	/** PreToolUse/PostToolUseの対応付け。並行ツールの古い完了で最新表示を消さないために使う。 */
	private readonly liveToolIds = new Map<string, string>();
	/** Claude MessageDisplayの行バッチをメッセージ単位で連結する内部バッファ。 */
	private readonly liveMessageBuffers = new Map<string, { messageId: string; lastIndex: number; text: string; startedAt: number; final: boolean }>();
	/** Codex daemonのagentMessage deltaをitem単位で連結する内部バッファ。 */
	private readonly codexMessageBuffers = new Map<string, { itemId: string; text: string; startedAt: number }>();
	/** Codex daemonで現在表示中のitem ID。古いitem/completedによる巻き戻しを防ぐ。 */
	private readonly codexActiveItems = new Map<string, string>();
	/** daemonが確認した次ターンのCodexモデル設定。transcriptの直近ターン値より優先表示する。 */
	private readonly codexThreadSettings = new Map<string, IParadisCodexThreadSettings>();
	private readonly hookSequences = new Map<string, number>();
	private readonly pendingHooks = new Map<string, { readonly event: IParadisAgentHookEvent; readonly transcriptPath: string; readonly sequence: number; readonly receivedAt: number }>();
	private readonly pendingHookTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly codexLiveClient: ParadisCodexLiveClient;
	/** ペアリング済みモバイル向けのライブ質問/承認注入を有効にする。status用tailは常時動作する。 */
	private eagerTailing = false;
	private readonly pendingActions = new Map<string, { readonly mobileId: string; readonly token: string; readonly epoch: string; readonly timer: ReturnType<typeof setTimeout> }>();
	private readonly completedActionTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(
		private readonly send: (mobileId: string, payload: Uint8Array) => void,
		private readonly requestAction: (mobileId: string, windowId: number, payload: Uint8Array) => void,
		/** 質問(AskUserQuestion等)がtranscriptに現れた（回答待ちが始まった）。通知の発火元。 */
		private readonly onQuestion: (info: { terminalId: number; agent: ParadisAgentKind; text: string; header?: string; ws?: string; agentToken: string }) => void,
		private readonly logService: ILogService,
		codexShellEnvResolver?: () => Promise<NodeJS.ProcessEnv>,
	) {
		super();
		this.codexLiveClient = this._register(new ParadisCodexLiveClient(event => this.onCodexDaemonEvent(event), this.logService, codexShellEnvResolver));
		this._register(onParadisAgentHookEvent(event => this.onHookEvent(event)));
		const activitySweepTimer = setInterval(() => {
			const now = Date.now();
			for (const [token, tracker] of this.activityTrackers) {
				if (tracker.sweepStale(now)) {
					this.pushActivityToSubscribers(token);
				}
			}
		}, 60_000);
		this._register(toDisposable(() => clearInterval(activitySweepTimer)));
		this._register(toDisposable(() => {
			for (const token of [...this.tailers.keys()]) {
				this.disposeTailer(token);
			}
			for (const timers of this.cliDiscoveryTimers.values()) {
				for (const timer of timers) {
					clearTimeout(timer);
				}
			}
			this.cliDiscoveryTimers.clear();
			for (const timer of this.pendingHookTimers.values()) {
				clearTimeout(timer);
			}
			this.pendingHookTimers.clear();
			this.pendingHooks.clear();
			this.hookSequences.clear();
			for (const pending of this.pendingActions.values()) {
				clearTimeout(pending.timer);
			}
			this.pendingActions.clear();
			for (const timer of this.completedActionTimers.values()) {
				clearTimeout(timer);
			}
			this.completedActionTimers.clear();
		}));
	}

	/** 実験的Codex daemon購読の有効/無効（既定false、renderer設定から同期）。 */
	setCodexDaemonEnabled(enabled: boolean): void {
		this.codexLiveClient.setEnabled(enabled);
		this.syncCodexDaemonThreads();
	}

	/**
	 * hookまたは鮮度検証済みtranscript探索で、実在するエージェントセッションとの対応が
	 * 確定したペイントークン。単なる `claude` / `codex` コマンド検知は含めない。
	 */
	getConfirmedAgentPaneTokens(): readonly string[] {
		return this.confirmedAgentPaneTokens();
	}

	/** rendererがPTY画面からbest-effort抽出した装飾情報を、既存ライブ状態へだけ合成する。 */
	onTerminalHint(terminalId: number, hint: { readonly elapsedSeconds?: number; readonly tokenCount?: number }): void {
		const token = this.terminalToToken.get(terminalId);
		const previous = token !== undefined ? this.liveStates.get(token) : undefined;
		if (token === undefined || previous === undefined) {
			return; // PTY文字列だけでエージェント起動を確定しない
		}
		const now = Date.now();
		this.setLiveState(token, {
			...previous,
			...(hint.elapsedSeconds !== undefined ? { startedAt: now - hint.elapsedSeconds * 1000 } : {}),
			updatedAt: now,
			...(hint.elapsedSeconds !== undefined ? { elapsedSeconds: hint.elapsedSeconds } : {}),
			...(hint.tokenCount !== undefined ? { tokenCount: hint.tokenCount } : {}),
		});
	}

	/**
	 * ペアリング済みモバイル向けのライブ質問/承認注入を切り替える。CodexのStopなし終了を
	 * 検出するstatus用tailerはモバイル接続から独立しているため、無効化しても停止しない。
	 */
	setEagerTailing(enabled: boolean): void {
		if (this.eagerTailing === enabled) {
			return;
		}
		this.eagerTailing = enabled;
		if (enabled) {
			for (const [token, session] of this.paneSessions) {
				if (this.terminalIdForToken(token) !== undefined) {
					this.ensureTailer(token, session);
				}
			}
		}
	}

	/** windowId → そのウィンドウが最後に同期したペイン対応。ウィンドウ単位で全置換する。 */
	private readonly panesByWindow = new Map<number, readonly { terminalId: number; token: string; cwd?: string; ws?: string }[]>();

	/**
	 * renderer から同期される「ターミナルinstanceId ⇔ ペイントークン」対応表。
	 *
	 * shared process は全ウィンドウで共有されるため、全体を置換すると別ウィンドウの登録が
	 * 消え、そのウィンドウのペインの tailer (fs.watch + ポーリング) が同期のたびに破棄/再生成
	 * を繰り返してしまう。windowId 単位で置換し、全ウィンドウ分をマージして対応表を再構築する。
	 * terminalId (instanceId) はウィンドウ内でしか一意でないため、ウィンドウ間で衝突したIDは
	 * attach/controlの解決対象から外す。ペイントークンはUUIDなので確定状態の同期には使える。
	 * ウィンドウを閉じる際は renderer が空配列でベストエフォート同期して自分の分を消す
	 * (クラッシュ等で届かなかった分は relay の再起動まで残るが、実害は tailer の空回りのみ)。
	 */
	syncPanes(windowId: number, entries: readonly { terminalId: number; token: string; cwd?: string; ws?: string }[]): void {
		if (entries.length === 0) {
			this.panesByWindow.delete(windowId);
		} else {
			this.panesByWindow.set(windowId, entries);
		}
		this.terminalToToken.clear();
		this.tokenToCwd.clear();
		this.tokenToWorkspace.clear();
		const ambiguousTerminalIds = new Set<number>();
		for (const windowEntries of this.panesByWindow.values()) {
			for (const entry of windowEntries) {
				if (typeof entry.terminalId === 'number' && typeof entry.token === 'string' && entry.token.length > 0) {
					const previous = this.terminalToToken.get(entry.terminalId);
					if (previous !== undefined && previous !== entry.token) {
						ambiguousTerminalIds.add(entry.terminalId);
						this.terminalToToken.delete(entry.terminalId);
					} else if (!ambiguousTerminalIds.has(entry.terminalId)) {
						this.terminalToToken.set(entry.terminalId, entry.token);
					}
					if (typeof entry.cwd === 'string' && entry.cwd.length > 0) {
						this.tokenToCwd.set(entry.token, entry.cwd);
					}
					if (typeof entry.ws === 'string' && entry.ws.length > 0) {
						this.tokenToWorkspace.set(entry.token, entry.ws);
					}
				}
			}
		}
		// セッションは判明済みだが terminalId 対応が今届いたペインの常時tailを開始する
		// （hookが先・ペイン同期が後の順で来るケース）。
		for (const [token, session] of this.paneSessions) {
			if (this.terminalIdForToken(token) !== undefined && !this.tailers.has(token)) {
				this.ensureTailer(token, session);
			}
		}
		// 消えたターミナル（PC側でclose等）の購読・tailerを掃除する。detachは
		// terminalId→token解決に依存するため、ここで拾わないとtailerがリークする。
		const liveTokens = this.allLiveTokens();
		for (const [token, pending] of [...this.pendingHooks]) {
			if (Date.now() - pending.receivedAt > 120_000) {
				this.pendingHooks.delete(token);
				this.hookSequences.delete(token);
				const timer = this.pendingHookTimers.get(token);
				if (timer !== undefined) {
					clearTimeout(timer);
					this.pendingHookTimers.delete(token);
				}
				continue;
			}
			if (liveTokens.has(token)) {
				this.pendingHooks.delete(token);
				const timer = this.pendingHookTimers.get(token);
				if (timer !== undefined) {
					clearTimeout(timer);
					this.pendingHookTimers.delete(token);
				}
				this.onHookEventChecked(pending.event, pending.transcriptPath, pending.sequence, true).catch(err => this.logService.warn('[paradisAgentChat] pending hook handling failed', err));
			}
		}
		for (const token of [...this.subscribers.keys()]) {
			if (!liveTokens.has(token)) {
				this.subscribers.delete(token);
			}
		}
		for (const token of [...this.tailers.keys()]) {
			if (!liveTokens.has(token)) {
				this.disposeTailer(token);
			}
		}
		for (const [token, timers] of [...this.cliDiscoveryTimers]) {
			if (!liveTokens.has(token)) {
				for (const timer of timers) {
					clearTimeout(timer);
				}
				this.cliDiscoveryTimers.delete(token);
				this.cliDiscoveryGenerations.delete(token);
			}
		}
		// paneSessions も掃除する（放置するとclose済みターミナルのセッション情報が単調増加する）。
		// セッション登録側は必ずlive tokenを確認するため、現在liveでないものは即時に破棄できる。
		for (const token of [...this.paneSessions.keys()]) {
			if (!liveTokens.has(token)) {
				const removed = this.paneSessions.get(token);
				this.paneSessions.delete(token);
				if (removed !== undefined && this.transcriptClaims.get(removed.transcriptPath) === token) {
					this.transcriptClaims.delete(removed.transcriptPath);
				}
				this.liveStates.delete(token);
				this.liveToolIds.delete(token);
				this.liveMessageBuffers.delete(token);
				this.codexMessageBuffers.delete(token);
				this.codexActiveItems.delete(token);
				this.codexThreadSettings.delete(token);
				this.activityTrackers.delete(token);
			}
		}
		this.syncCodexDaemonThreads();
		this.emitConfirmedAgentPanesIfChanged();
	}

	/** コマンド検知トリガーの再探索タイマー (dispose時に確実に止める)。 */
	private readonly cliDiscoveryTimers = new Map<string, Set<ReturnType<typeof setTimeout>>>();
	private readonly cliDiscoveryGenerations = new Map<string, number>();

	/**
	 * ターミナルで `claude` / `codex` コマンドの実行開始を検知した (shell integration 由来)。
	 * これ自体を「エージェント起動」とはみなさず、cwd ベースのセッション探索を前倒しする
	 * トリガーとしてのみ使う。transcript / rollout の作成はコマンド起動から数秒遅れるため、
	 * 少し待って数回試す。鮮度ガード (コマンド開始時刻より新しい更新のみ受理) により、
	 * `claude --help` のような空振りで古いセッションを掴む誤検知は起きない。
	 */
	onCliCommandDetected(token: string, agent: ParadisAgentKind, cwd: string | undefined): void {
		if (!this.isLiveToken(token)) {
			return;
		}
		const effectiveCwd = cwd ?? this.tokenToCwd.get(token);
		if (effectiveCwd === undefined) {
			return;
		}
		this.tokenToCwd.set(token, effectiveCwd);
		this.cancelCliDiscovery(token);
		const generation = (this.cliDiscoveryGenerations.get(token) ?? 0) + 1;
		this.cliDiscoveryGenerations.set(token, generation);
		// resume 直後は既存transcriptへの追記になるため、開始時刻より少し手前まで許容する。
		const minMtime = Date.now() - 15_000;
		// 共有daemonは起動済みthreadのrollout初回flushが遅れることがあるため、短い即時探索に
		// 加えて30秒・60秒でも再確認する。鮮度ガードは維持されるので、待機を延ばしても
		// コマンド開始前の古いセッションを誤って拾うことはない。
		for (const delayMs of [2_000, 6_000, 15_000, 30_000, 60_000]) {
			const timer = setTimeout(() => {
				const timers = this.cliDiscoveryTimers.get(token);
				timers?.delete(timer);
				if (timers?.size === 0) {
					this.cliDiscoveryTimers.delete(token);
				}
				if (this.cliDiscoveryGenerations.get(token) !== generation) {
					return;
				}
				this.discoverAndNotify(token, agent, effectiveCwd, minMtime, generation).catch(err => this.logService.warn('[paradisAgentChat] discovery on cli command failed', err));
			}, delayMs);
			let timers = this.cliDiscoveryTimers.get(token);
			if (timers === undefined) {
				timers = new Set();
				this.cliDiscoveryTimers.set(token, timers);
			}
			timers.add(timer);
		}
	}

	private cancelCliDiscovery(token: string): void {
		const timers = this.cliDiscoveryTimers.get(token);
		if (timers !== undefined) {
			for (const timer of timers) {
				clearTimeout(timer);
			}
			this.cliDiscoveryTimers.delete(token);
		}
	}

	/** モバイルの切断 (presence offline)。そのモバイルの購読をすべて解放する。 */
	dropSubscriber(mobileId: string): void {
		for (const [key, pending] of [...this.pendingActions]) {
			if (pending.mobileId === mobileId) {
				clearTimeout(pending.timer);
				this.pendingActions.delete(key);
			}
		}
		for (const [key, timer] of [...this.completedActionTimers]) {
			if (key.startsWith(`${mobileId}\0`)) {
				clearTimeout(timer);
				this.completedActionTimers.delete(key);
			}
		}
		for (const token of [...this.subscribers.keys()]) {
			if (this.removeSubscriber(token, mobileId)) {
				this.stopTailerIfUnsubscribed(token);
			}
		}
	}

	/** agentチャネルのモバイル→PCメッセージを処理する。 */
	handleInbound(mobileId: string, payload: Uint8Array): void {
		let msg: AgentInbound;
		try {
			const parsed = JSON.parse(decoder.decode(payload));
			if (rec(parsed) === undefined) {
				return;
			}
			msg = parsed as AgentInbound;
		} catch {
			return;
		}
		if (msg.t === 'attach' && typeof msg.id === 'number') {
			this.handleAttach(mobileId, msg).catch(err => this.logService.warn('[paradisAgentChat] attach failed', err));
		} else if (msg.t === 'detach' && typeof msg.id === 'number') {
			const token = this.resolveInboundToken(msg.id, msg.token);
			if (token !== undefined && this.removeSubscriber(token, mobileId)) {
				this.stopTailerIfUnsubscribed(token);
			}
		} else if (msg.t === 'action/sendMessage' && this.isValidSendMessageAction(msg)) {
			this.handleSendMessageAction(mobileId, msg);
		} else if (msg.t === 'model-catalog' && this.isValidControlRequest(msg)) {
			this.handleModelCatalogRequest(mobileId, msg).catch(err => this.logService.warn('[paradisAgentChat] model catalog failed', err));
		} else if (msg.t === 'settings-update' && this.isValidControlRequest(msg)
			&& typeof msg.model === 'string' && msg.model.length > 0 && msg.model.length <= 500
			&& typeof msg.effort === 'string' && msg.effort.length > 0 && msg.effort.length <= 100) {
			this.handleSettingsUpdateRequest(mobileId, msg).catch(err => this.logService.warn('[paradisAgentChat] settings update failed', err));
		}
	}

	private isValidSendMessageAction(msg: Extract<AgentInbound, { t: 'action/sendMessage' }>): boolean {
		return this.isValidControlRequest(msg)
			&& typeof msg.epoch === 'string' && msg.epoch.length > 0 && msg.epoch.length <= 200
			&& typeof msg.text === 'string' && msg.text.trim().length > 0 && msg.text.length <= 100_000;
	}

	private handleSendMessageAction(mobileId: string, msg: Extract<AgentInbound, { t: 'action/sendMessage' }>): void {
		const token = this.resolveInboundToken(msg.id, msg.token);
		const session = token !== undefined ? this.paneSessions.get(token) : undefined;
		const tailer = token !== undefined ? this.tailers.get(token) : undefined;
		const windowId = token !== undefined ? this.windowIdForPane(msg.id, token) : undefined;
		const key = this.actionKey(mobileId, msg.requestId);
		if (token === undefined || session === undefined || tailer === undefined || tailer.epoch !== msg.epoch || windowId === undefined || !this.hasSubscriber(token, mobileId) || this.pendingActions.has(key) || this.completedActionTimers.has(key)) {
			this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'stale-session', message: '操作対象のエージェントセッションが変わりました' }, token ?? msg.token);
			return;
		}
		const timer = setTimeout(() => {
			if (this.pendingActions.delete(key)) {
				this.sendTo(mobileId, { t: 'action-result', id: msg.id, requestId: msg.requestId, status: 'rejected', code: 'action-timeout', message: '操作対象のウィンドウが応答しませんでした' }, token);
			}
		}, 5_000);
		this.pendingActions.set(key, { mobileId, token, epoch: msg.epoch, timer });
		this.requestAction(mobileId, windowId, encoder.encode(JSON.stringify({ ...msg, token, windowId })));
	}

	claimSendMessageAction(mobileId: string, requestId: string, token: string, epoch: string): 'claimed' | 'stale' | 'expired' {
		const key = this.actionKey(mobileId, requestId);
		const pending = this.pendingActions.get(key);
		if (pending === undefined) {
			return 'expired';
		}
		clearTimeout(pending.timer);
		this.pendingActions.delete(key);
		const completedTimer = setTimeout(() => this.completedActionTimers.delete(key), 60_000);
		this.completedActionTimers.set(key, completedTimer);
		const currentTailer = this.tailers.get(token);
		return pending.token === token && pending.epoch === epoch && currentTailer?.epoch === epoch && this.hasSubscriber(token, mobileId)
			? 'claimed'
			: 'stale';
	}

	private actionKey(mobileId: string, requestId: string): string {
		return `${mobileId}\0${requestId}`;
	}

	private windowIdForPane(terminalId: number, token: string): number | undefined {
		const owners = [...this.panesByWindow].filter(([, entries]) => entries.some(entry => entry.terminalId === terminalId && entry.token === token));
		return owners.length === 1 ? owners[0][0] : undefined;
	}

	private isValidControlRequest(msg: { readonly id: unknown; readonly token?: unknown; readonly requestId?: unknown }): msg is { readonly id: number; readonly token?: string; readonly requestId: string } {
		return typeof msg.id === 'number' && Number.isInteger(msg.id) && msg.id >= 0
			&& (msg.token === undefined || (typeof msg.token === 'string' && msg.token.length > 0 && msg.token.length <= 200))
			&& typeof msg.requestId === 'string' && msg.requestId.length > 0 && msg.requestId.length <= 100;
	}

	private codexControlSession(mobileId: string, terminalId: number, paneToken?: string): { readonly token: string; readonly threadId: string } | undefined {
		const token = this.resolveInboundToken(terminalId, paneToken);
		const session = token !== undefined ? this.paneSessions.get(token) : undefined;
		if (token === undefined || session?.agent !== 'codex' || session.sessionId === undefined || !this.hasSubscriber(token, mobileId)) {
			return undefined;
		}
		return { token, threadId: session.sessionId };
	}

	private async handleModelCatalogRequest(mobileId: string, msg: { readonly id: number; readonly token?: string; readonly requestId: string }): Promise<void> {
		const session = this.codexControlSession(mobileId, msg.id, msg.token);
		if (session === undefined) {
			this.sendControlError(mobileId, msg.id, msg.requestId, new ParadisCodexControlError('unavailable', '操作対象のCodexセッションを確認できません'), msg.token);
			return;
		}
		try {
			const models = await this.codexLiveClient.listModels(session.threadId);
			this.sendTo(mobileId, { t: 'model-catalog', id: msg.id, requestId: msg.requestId, models }, session.token);
		} catch (error) {
			this.sendControlError(mobileId, msg.id, msg.requestId, error, msg.token);
		}
	}

	private async handleSettingsUpdateRequest(mobileId: string, msg: { readonly id: number; readonly token?: string; readonly requestId: string; readonly model: string; readonly effort: string }): Promise<void> {
		const session = this.codexControlSession(mobileId, msg.id, msg.token);
		if (session === undefined) {
			this.sendControlError(mobileId, msg.id, msg.requestId, new ParadisCodexControlError('unavailable', '操作対象のCodexセッションを確認できません'), msg.token);
			return;
		}
		this.sendTo(mobileId, { t: 'settings-update', id: msg.id, requestId: msg.requestId, status: 'pending' }, session.token);
		try {
			const settings = await this.codexLiveClient.updateThreadSettings(session.threadId, msg.model, msg.effort);
			const current = this.codexControlSession(mobileId, msg.id, msg.token);
			if (current?.token !== session.token || current.threadId !== session.threadId) {
				return;
			}
			this.codexThreadSettings.set(session.token, settings);
			this.pushInfoToSubscribers(session.token);
			const info = { model: settings.model, ...(settings.effort !== undefined ? { effort: settings.effort } : {}) };
			this.sendTo(mobileId, { t: 'settings-update', id: msg.id, requestId: msg.requestId, status: 'confirmed', info }, session.token);
		} catch (error) {
			const normalized = ParadisMobileAgentChat.controlError(error);
			this.sendTo(mobileId, {
				t: 'settings-update', id: msg.id, requestId: msg.requestId, status: 'failed',
				code: normalized.code, message: normalized.message,
			}, session.token);
		}
	}

	private sendControlError(mobileId: string, terminalId: number, requestId: string, error: unknown, token?: string): void {
		const normalized = ParadisMobileAgentChat.controlError(error);
		this.sendTo(mobileId, { t: 'model-control-error', id: terminalId, requestId, code: normalized.code, message: normalized.message }, token);
	}

	private static controlError(error: unknown): { readonly code: string; readonly message: string } {
		if (error instanceof ParadisCodexControlError) {
			return { code: error.code, message: error.message };
		}
		return { code: 'unavailable', message: 'Codexのモデル設定を更新できませんでした' };
	}

	private async handleAttach(mobileId: string, msg: { id: number; token?: string; epoch?: string; afterRev?: number }): Promise<void> {
		const token = this.resolveInboundToken(msg.id, msg.token);
		const session = token !== undefined ? this.paneSessions.get(token) : undefined;
		if (token === undefined || session === undefined) {
			// エージェント未起動、または探索でも見つからない。モバイル側は
			// 「ターミナルタブで見る」案内を出す。トークンが分かる場合は購読者として
			// 記録しておき、後からhookでセッションが判明したら自動でスナップショットを
			// 送り直す(エージェント起動を待たずにattachしたケースの自己回復)。
			if (token !== undefined) {
				this.addSubscriber(token, mobileId);
			}
			this.sendTo(mobileId, { t: 'none', id: msg.id }, msg.token);
			return;
		}
		this.addSubscriber(token, mobileId);
		const tailer = this.ensureTailer(token, session);
		await tailer.ready;
		// attach処理中に購読またはセッションが置き換わっていたら旧snapshotを送らない。
		if (!this.hasSubscriber(token, mobileId) || this.paneSessions.get(token) !== session || this.tailers.get(token) !== tailer) {
			return;
		}
		const afterRev = msg.afterRev;
		// 差分応答は「afterRevの続きが欠けなくリングに残っている」場合のみ。切断中に
		// リング上限を超えて古い分が退避済みだと、先頭revが飛んでいてサイレント欠落に
		// なるため、その場合は全量スナップショットへフォールバックする。
		const oldestRev = tailer.messages.length > 0 ? tailer.messages[0].rev : tailer.rev;
		const info = this.infoOf(token, tailer);
		const live = this.liveStates.get(token) ?? null;
		const activity = this.activityTrackers.get(token)?.snapshot() ?? null;
		const interaction = tailer.currentInteraction();
		if (msg.epoch === tailer.epoch && typeof afterRev === 'number' && afterRev >= oldestRev - 1) {
			// モバイルが同一epochの途中まで持っている → 差分のみ (リレー瞬断からの再接続)
			const messages = tailer.messages.filter(m => m.rev > afterRev);
			this.sendTo(mobileId, { t: 'delta', id: msg.id, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev, messages, ...(info !== undefined ? { info } : {}), live, activity, interaction, capabilities: { agentActions: true } }, token);
		} else {
			const messages = tailer.messages.slice(-SNAPSHOT_SEND_LIMIT);
			this.sendTo(mobileId, {
				t: 'snapshot', id: msg.id, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev, messages,
				...(tailer.wasInitialTruncated || tailer.messages.length > messages.length ? { truncated: true } : {}),
				...(info !== undefined ? { info } : {}),
				live, activity, interaction, capabilities: { agentActions: true },
			}, token);
		}
	}

	/** tool_inputからティッカーに有用な短い説明だけを抽出する（巨大なJSONは送らない）。 */
	private static toolDetail(toolInput: unknown): string | undefined {
		const input = rec(toolInput);
		if (input === undefined) {
			return undefined;
		}
		for (const key of ['command', 'file_path', 'path', 'query', 'pattern', 'url', 'description']) {
			const value = str(input[key]);
			if (value !== undefined && value.trim().length > 0) {
				return truncateText(value.trim().replace(/\s+/g, ' '), 500);
			}
		}
		return undefined;
	}

	/** hookを履歴とは独立したライブ状態へ反映する。 */
	private updateLiveFromHook(event: IParadisAgentHookEvent): void {
		switch (event.event) {
			case 'UserPromptSubmit':
				this.liveToolIds.delete(event.token);
				this.liveMessageBuffers.delete(event.token);
				this.setLiveState(event.token, {
					phase: 'thinking', source: 'hook', startedAt: event.at, updatedAt: event.at,
				});
				return;
			case 'PreToolUse': {
				if (event.toolUseId !== undefined) {
					this.liveToolIds.set(event.token, event.toolUseId);
				} else {
					this.liveToolIds.delete(event.token);
				}
				const phase = event.toolName === 'AskUserQuestion' ? 'permission' : 'tool';
				const detail = ParadisMobileAgentChat.toolDetail(event.toolInput);
				this.setLiveState(event.token, {
					phase, source: 'hook', startedAt: event.at, updatedAt: event.at,
					...(event.toolName !== undefined ? { tool: event.toolName } : {}),
					...(detail !== undefined ? { detail } : {}),
				});
				return;
			}
			case 'PostToolUse':
			case 'PostToolUseFailure':
			case 'PermissionDenied': {
				const currentToolId = this.liveToolIds.get(event.token);
				if (event.toolUseId !== undefined && currentToolId !== undefined && event.toolUseId !== currentToolId) {
					return;
				}
				this.liveToolIds.delete(event.token);
				const previous = this.liveStates.get(event.token);
				this.setLiveState(event.token, {
					phase: 'thinking', source: 'hook', startedAt: previous?.startedAt ?? event.at, updatedAt: event.at,
				});
				return;
			}
			case 'PermissionRequest': {
				const detail = ParadisMobileAgentChat.toolDetail(event.toolInput);
				this.setLiveState(event.token, {
					phase: 'permission', source: 'hook', startedAt: event.at, updatedAt: event.at,
					...(event.toolName !== undefined ? { tool: event.toolName } : {}),
					...(detail !== undefined ? { detail } : {}),
				});
				return;
			}
			case 'MessageDisplay':
				this.updateLiveMessage(event);
				return;
			case 'Stop':
			case 'StopFailure':
			case 'SessionEnd':
			case 'TerminalExit':
			case 'agent-turn-complete':
				this.clearLiveState(event.token);
				return;
		}
	}

	/** MessageDisplayの重複バッチを除外し、同一メッセージのdeltaを順番に連結する。 */
	private updateLiveMessage(event: IParadisAgentHookEvent): void {
		if (event.messageId === undefined || event.messageDelta === undefined || event.messageIndex === undefined) {
			return;
		}
		const previous = this.liveMessageBuffers.get(event.token);
		if (previous?.messageId === event.messageId && event.messageIndex <= previous.lastIndex) {
			return;
		}
		const startedAt = previous?.messageId === event.messageId ? previous.startedAt : event.at;
		const prefix = previous?.messageId === event.messageId ? previous.text : '';
		const text = truncateLiveText(prefix + event.messageDelta, TEXT_LIMIT);
		const buffer = {
			messageId: event.messageId,
			lastIndex: event.messageIndex,
			text,
			startedAt,
			final: event.messageFinal === true,
		};
		this.liveMessageBuffers.set(event.token, buffer);
		this.setLiveState(event.token, {
			phase: 'message', source: 'hook', startedAt, updatedAt: event.at, text,
			...(buffer.final ? { final: true } : {}),
		});
	}

	private setLiveState(token: string, state: IParadisAgentLiveState): void {
		this.liveStates.set(token, state);
		this.pushLiveToSubscribers(token, state);
	}

	private clearLiveState(token: string): void {
		const hadState = this.liveStates.delete(token);
		this.liveToolIds.delete(token);
		this.liveMessageBuffers.delete(token);
		if (hadState) {
			this.pushLiveToSubscribers(token, null);
		}
	}

	/** transcriptに永続化される長時間ツールprogressを、hookティッカーの補足へ反映する。 */
	private updateLiveFromProgress(token: string, progress: ITranscriptProgress): void {
		const previous = this.liveStates.get(token);
		// 生成本文の先出しが始まった後に、遅れてflushされたツールprogressで上書きしない。
		if (previous?.phase === 'message') {
			return;
		}
		const now = Date.now();
		if (progress.done) {
			this.setLiveState(token, {
				phase: 'thinking', source: 'transcript', startedAt: previous?.startedAt ?? now, updatedAt: now,
			});
			return;
		}
		const startedAt = progress.elapsedSeconds !== undefined
			? now - progress.elapsedSeconds * 1000
			: previous?.phase === 'tool' ? previous.startedAt : now;
		this.setLiveState(token, {
			phase: 'tool', source: 'transcript', startedAt, updatedAt: now, tool: progress.tool,
			...(progress.detail !== undefined ? { detail: progress.detail } : {}),
			...(progress.elapsedSeconds !== undefined ? { elapsedSeconds: progress.elapsedSeconds } : {}),
		});
	}

	/** daemonへ購読させるのは、hookまたはrolloutメタ情報でthread IDを確定できたCodexセッションだけ。 */
	private syncCodexDaemonThreads(): void {
		const threadIds = new Set<string>();
		for (const session of this.paneSessions.values()) {
			if (session.agent === 'codex' && session.sessionId !== undefined && session.sessionId.length > 0) {
				threadIds.add(session.sessionId);
			}
		}
		this.codexLiveClient.setThreads([...threadIds]);
	}

	/** Codex daemonの通知を対応するペインの置換型ライブ状態へ投影する。 */
	private onCodexDaemonEvent(event: IParadisCodexDaemonEvent): void {
		for (const [token, session] of this.paneSessions) {
			if (session.agent === 'codex' && session.sessionId === event.threadId) {
				this.applyCodexDaemonEvent(token, event);
			}
		}
	}

	private applyCodexDaemonEvent(token: string, event: IParadisCodexDaemonEvent): void {
		const now = Date.now();
		if (this.activityTracker(token).applyCodex(event.method, event.params, now)) {
			this.pushActivityToSubscribers(token);
		}
		if (event.method === 'thread/settings/updated') {
			const settings = rec(event.params['threadSettings']);
			const model = str(settings?.['model']);
			const effort = str(settings?.['effort']);
			if (model !== undefined) {
				this.codexThreadSettings.set(token, { model, ...(effort !== undefined ? { effort } : {}) });
				this.pushInfoToSubscribers(token);
			}
			return;
		}
		if (event.method === 'turn/started') {
			if (this.activityTracker(token).beginTurn()) {
				this.pushActivityToSubscribers(token);
			}
			this.codexMessageBuffers.delete(token);
			this.codexActiveItems.delete(token);
			this.setLiveState(token, { phase: 'thinking', source: 'codex-daemon', startedAt: now, updatedAt: now });
			return;
		}
		if (event.method === 'turn/completed' || event.method === 'turn/failed' || event.method === 'turn/aborted') {
			// turn/failed は usage limit 等のエラー中断（turn/completed が来ないため、
			// ここで解除しないと「考え中」表示が残り続ける）。
			this.codexMessageBuffers.delete(token);
			this.codexActiveItems.delete(token);
			this.clearLiveState(token);
			const reason = event.method === 'turn/completed' ? 'completed' : event.method === 'turn/aborted' ? 'interrupted' : 'failed';
			if (this.activityTracker(token).endTurn(reason, now)) {
				this.pushActivityToSubscribers(token);
			}
			return;
		}
		if (event.method === 'item/started') {
			const item = rec(event.params['item']);
			const itemId = str(item?.['id']);
			const itemType = str(item?.['type']);
			const startedAt = num(event.params['startedAtMs']) ?? now;
			if (itemId !== undefined) {
				this.codexActiveItems.set(token, itemId);
			}
			if (itemType === 'agentMessage') {
				if (itemId !== undefined) {
					this.codexMessageBuffers.set(token, { itemId, text: '', startedAt });
				}
				this.setLiveState(token, { phase: 'message', source: 'codex-daemon', startedAt, updatedAt: now });
				return;
			}
			if (itemType === 'reasoning') {
				this.setLiveState(token, { phase: 'thinking', source: 'codex-daemon', startedAt, updatedAt: now });
				return;
			}
			const tool = ParadisMobileAgentChat.codexItemToolName(itemType, item);
			if (tool !== undefined) {
				const detail = ParadisMobileAgentChat.codexItemDetail(itemType, item);
				this.setLiveState(token, {
					phase: 'tool', source: 'codex-daemon', startedAt, updatedAt: now, tool,
					...(detail !== undefined ? { detail } : {}),
				});
			}
			return;
		}
		if (event.method === 'item/agentMessage/delta') {
			const itemId = str(event.params['itemId']);
			const delta = str(event.params['delta']);
			if (itemId === undefined || delta === undefined) {
				return;
			}
			const previous = this.codexMessageBuffers.get(token);
			const startedAt = previous?.itemId === itemId ? previous.startedAt : now;
			const text = truncateCodexLiveText((previous?.itemId === itemId ? previous.text : '') + delta);
			this.codexMessageBuffers.set(token, { itemId, text, startedAt });
			this.codexActiveItems.set(token, itemId);
			this.setLiveState(token, { phase: 'message', source: 'codex-daemon', startedAt, updatedAt: now, text });
			return;
		}
		if (event.method === 'item/reasoning/summaryTextDelta') {
			const delta = str(event.params['delta']);
			if (delta === undefined) {
				return;
			}
			const previous = this.liveStates.get(token);
			const detail = truncateCodexLiveText((previous?.phase === 'thinking' ? previous.detail ?? '' : '') + delta);
			this.setLiveState(token, {
				phase: 'thinking', source: 'codex-daemon', startedAt: previous?.phase === 'thinking' ? previous.startedAt : now,
				updatedAt: now, detail,
			});
			return;
		}
		if (event.method === 'item/commandExecution/outputDelta') {
			const itemId = str(event.params['itemId']);
			const delta = str(event.params['delta']);
			if (delta === undefined) {
				return;
			}
			const previous = this.liveStates.get(token);
			const detail = truncateCodexLiveText([previous?.detail, delta.trim()].filter((part): part is string => part !== undefined && part.length > 0).join('\n'));
			if (itemId !== undefined) {
				this.codexActiveItems.set(token, itemId);
			}
			this.setLiveState(token, {
				phase: 'tool', source: 'codex-daemon', startedAt: previous?.phase === 'tool' ? previous.startedAt : now,
				updatedAt: now, tool: previous?.tool ?? 'shell', ...(detail.length > 0 ? { detail } : {}),
			});
			return;
		}
		if (event.method === 'item/completed') {
			const item = rec(event.params['item']);
			const itemId = str(item?.['id']);
			if (itemId !== undefined && this.codexActiveItems.get(token) !== itemId) {
				return;
			}
			this.codexActiveItems.delete(token);
			const previous = this.liveStates.get(token);
			this.setLiveState(token, {
				phase: 'thinking', source: 'codex-daemon', startedAt: previous?.startedAt ?? now, updatedAt: now,
			});
		}
	}

	private static codexItemToolName(itemType: string | undefined, item: Record<string, unknown> | undefined): string | undefined {
		switch (itemType) {
			case 'commandExecution': return 'shell';
			case 'fileChange': return 'apply_patch';
			case 'webSearch': return 'web_search';
			case 'mcpToolCall': {
				const server = str(item?.['server']);
				const tool = str(item?.['tool']) ?? 'tool';
				return server !== undefined ? `mcp__${server}__${tool}` : tool;
			}
			case 'dynamicToolCall': return str(item?.['tool']) ?? 'tool';
			case 'collabAgentToolCall': return str(item?.['tool']) ?? 'agent';
			case 'sleep': return 'sleep';
			case 'imageView': return 'view_image';
			case 'imageGeneration': return 'image_generation';
			default: return undefined;
		}
	}

	private static codexItemDetail(itemType: string | undefined, item: Record<string, unknown> | undefined): string | undefined {
		const value = itemType === 'commandExecution' ? str(item?.['command'])
			: itemType === 'webSearch' ? str(item?.['query'])
				: itemType === 'imageView' ? str(item?.['path'])
					: itemType === 'collabAgentToolCall' ? str(item?.['prompt'])
						: undefined;
		return value !== undefined && value.length > 0 ? truncateText(value.replace(/\s+/g, ' '), 500) : undefined;
	}

	/** 現在attach中の全モバイルへライブ状態だけを空deltaとして送る。 */
	private pushLiveToSubscribers(token: string, live: IParadisAgentLiveState | null): void {
		const terminalId = this.terminalIdForToken(token);
		const tailer = this.tailers.get(token);
		if (terminalId === undefined || tailer === undefined) {
			return;
		}
		this.sendToSubscribers(token, {
			t: 'delta', id: terminalId, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev,
			messages: [], live,
		});
	}

	private activityTracker(token: string): ParadisAgentActivityTracker {
		let tracker = this.activityTrackers.get(token);
		if (tracker === undefined) {
			tracker = new ParadisAgentActivityTracker();
			this.activityTrackers.set(token, tracker);
		}
		return tracker;
	}

	private pushActivityToSubscribers(token: string): void {
		const terminalId = this.terminalIdForToken(token);
		const tailer = this.tailers.get(token);
		if (terminalId !== undefined && tailer !== undefined) {
			this.sendToSubscribers(token, {
				t: 'delta', id: terminalId, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev,
				messages: [], activity: this.activityTrackers.get(token)?.snapshot() ?? null,
			});
		}
	}

	private onHookEvent(event: IParadisAgentHookEvent): void {
		if (event.transcriptPath === undefined || event.transcriptPath.length === 0) {
			// agent種別を確定できないため、transcript_path無しのhookだけではcwd探索しない。
			// CLI検知経路がagent種別付きで鮮度検証済み探索を行う。
			return;
		}
		const sequence = (this.hookSequences.get(event.token) ?? 0) + 1;
		this.hookSequences.set(event.token, sequence);
		this.onHookEventChecked(event, event.transcriptPath, sequence, false).catch(err => this.logService.warn('[paradisAgentChat] hook event handling failed', err));
	}

	/** cwdからセッションを探し、見つかれば登録して購読者へスナップショットを送り直す。 */
	private async discoverAndNotify(token: string, agent: ParadisAgentKind, cwd: string, minMtime: number | undefined, generation: number): Promise<void> {
		const previous = this.paneSessions.get(token);
		const claimedByOthers = new Set([...this.transcriptClaims]
			.filter(([, owner]) => owner !== token)
			.map(([path]) => path));
		if (previous !== undefined) {
			claimedByOthers.add(previous.transcriptPath);
		}
		const discovered = await discoverSessionByCwd(cwd, agent, minMtime, claimedByOthers);
		if (discovered === undefined
			|| this.cliDiscoveryGenerations.get(token) !== generation
			|| !this.isLiveToken(token) || this.tokenToCwd.get(token) !== cwd
			|| this.transcriptClaimedByOther(discovered.transcriptPath, token)
			|| !(await isAllowedTranscriptPath(discovered.transcriptPath))) {
			return;
		}
		// CLI起動との相関には更新時刻ではなくファイル生成時刻を使う。別paneの古いthreadが
		// 偶然同時に更新されても、新規起動paneへ割り当てない。復元探索はこの制約を使わない。
		// state DB由来の候補はDBのcreated_atで判定する。Codexは最初のターンまでrollout実ファイルを
		// 生成しないため、ファイルのbirthtimeを待つと起動直後のセッションを取りこぼす。
		if (minMtime !== undefined) {
			if (discovered.createdAt !== undefined) {
				if (discovered.createdAt < minMtime) {
					return;
				}
			} else {
				try {
					const stat = await fs.stat(discovered.transcriptPath);
					if (stat.birthtimeMs < minMtime) {
						return;
					}
				} catch {
					return;
				}
			}
		}
		if (this.cliDiscoveryGenerations.get(token) !== generation
			|| !this.isLiveToken(token) || this.tokenToCwd.get(token) !== cwd
			|| this.transcriptClaimedByOther(discovered.transcriptPath, token)
			|| this.paneSessions.get(token) !== previous) {
			return;
		}
		if (previous?.transcriptPath === discovered.transcriptPath) {
			return;
		}
		if (previous !== undefined) {
			this.paneSessions.delete(token);
			if (this.transcriptClaims.get(previous.transcriptPath) === token) {
				this.transcriptClaims.delete(previous.transcriptPath);
			}
			this.disposeTailer(token);
			this.clearLiveState(token);
			this.activityTrackers.delete(token);
		}
		const session: IPaneSessionInfo = { token, agent: discovered.agent, transcriptPath: discovered.transcriptPath, sessionId: discovered.sessionId };
		this.paneSessions.set(token, session);
		this.transcriptClaims.set(discovered.transcriptPath, token);
		this.emitConfirmedAgentPanesIfChanged();
		this.syncCodexDaemonThreads();
		this.ensureEagerTailer(token, session);
		this.pushToSubscribers(token);
	}

	/** status収束のため、セッション確定済みの生存ペインはモバイル購読が無くてもtailする。 */
	private ensureEagerTailer(token: string, session: IPaneSessionInfo): void {
		if (this.terminalIdForToken(token) !== undefined) {
			this.ensureTailer(token, session);
		}
	}

	/** 購読者がいれば、そのペインの現行セッションでattach相当のスナップショットを送る。 */
	private pushToSubscribers(token: string): void {
		const subscribers = [...(this.subscribers.get(token) ?? [])];
		const terminalId = this.terminalIdForToken(token);
		if (terminalId !== undefined) {
			for (const subscriber of subscribers) {
				this.handleAttach(subscriber, { id: terminalId, token }).catch(err => this.logService.warn('[paradisAgentChat] push after session discovery failed', err));
			}
		}
	}

	private async onHookEventChecked(event: IParadisAgentHookEvent, transcriptPath: string, sequence: number, pathAlreadyChecked: boolean): Promise<void> {
		if (!pathAlreadyChecked && !(await isAllowedTranscriptPath(transcriptPath))) {
			this.logService.warn(`[paradisAgentChat] rejected transcript path outside allowed roots: ${transcriptPath}`);
			return;
		}
		if (this.hookSequences.get(event.token) !== sequence) {
			return;
		}
		if (!this.isLiveToken(event.token)) {
			this.pendingHooks.set(event.token, { event, transcriptPath, sequence, receivedAt: Date.now() });
			const previousTimer = this.pendingHookTimers.get(event.token);
			if (previousTimer !== undefined) {
				clearTimeout(previousTimer);
			}
			const timer = setTimeout(() => {
				if (this.pendingHooks.get(event.token)?.sequence === sequence) {
					this.pendingHooks.delete(event.token);
					this.hookSequences.delete(event.token);
				}
				this.pendingHookTimers.delete(event.token);
			}, 120_000);
			this.pendingHookTimers.set(event.token, timer);
			return;
		}
		this.pendingHooks.delete(event.token);
		const pendingTimer = this.pendingHookTimers.get(event.token);
		if (pendingTimer !== undefined) {
			clearTimeout(pendingTimer);
			this.pendingHookTimers.delete(event.token);
		}
		this.updateLiveFromHook(event);
		this.cancelCliDiscovery(event.token);
		this.cliDiscoveryGenerations.set(event.token, (this.cliDiscoveryGenerations.get(event.token) ?? 0) + 1);
		const previousOwner = this.transcriptClaims.get(transcriptPath);
		if (previousOwner !== undefined && previousOwner !== event.token) {
			// ペイン環境を伴うhookはcwd探索より強い証拠なので、探索由来の誤claimを置き換える。
			this.paneSessions.delete(previousOwner);
			this.disposeTailer(previousOwner);
			this.liveStates.delete(previousOwner);
			this.liveToolIds.delete(previousOwner);
			this.liveMessageBuffers.delete(previousOwner);
			this.codexMessageBuffers.delete(previousOwner);
			this.codexActiveItems.delete(previousOwner);
			this.codexThreadSettings.delete(previousOwner);
			this.activityTrackers.delete(previousOwner);
			this.cancelCliDiscovery(previousOwner);
			this.cliDiscoveryGenerations.set(previousOwner, (this.cliDiscoveryGenerations.get(previousOwner) ?? 0) + 1);
		}
		const previous = this.paneSessions.get(event.token);
		const info: IPaneSessionInfo = {
			token: event.token,
			agent: agentKindForPath(transcriptPath),
			transcriptPath,
			sessionId: event.sessionId,
		};
		if (previous !== undefined && previous.transcriptPath !== transcriptPath
			&& this.transcriptClaims.get(previous.transcriptPath) === event.token) {
			this.transcriptClaims.delete(previous.transcriptPath);
		}
		this.paneSessions.set(event.token, info);
		this.transcriptClaims.set(transcriptPath, event.token);
		this.emitConfirmedAgentPanesIfChanged();
		this.syncCodexDaemonThreads();

		// エージェント起動などでこのペインのセッションが初めて判明した
		// → 「セッションなし」表示のまま待っている購読者にスナップショットを送る。
		if (previous === undefined) {
			this.ensureEagerTailer(event.token, info);
			this.pushToSubscribers(event.token);
		} else if (previous.transcriptPath !== info.transcriptPath) {
			// 同じペインで別セッションが始まった (claude再起動・/clear・resume等でファイルが変わる)
			// → 稼働中の tailer を張り替え、購読者には新セッションのスナップショットを送り直す。
			this.codexThreadSettings.delete(event.token);
			this.activityTrackers.delete(event.token);
			this.disposeTailer(event.token);
			this.ensureEagerTailer(event.token, info);
			this.pushToSubscribers(event.token);
		}
		if (event.event === 'UserPromptSubmit' && this.activityTracker(event.token).beginTurn()) {
			this.pushActivityToSubscribers(event.token);
		}
		const activityChanged = event.payload !== undefined && this.activityTracker(event.token).applyClaude(event.event, event.payload, event.at);
		const activityEnded = event.event === 'Stop' || event.event === 'SessionEnd'
			? this.activityTracker(event.token).endTurn('completed', event.at)
			: event.event === 'StopFailure' ? this.activityTracker(event.token).endTurn('failed', event.at) : false;
		if (activityChanged || activityEnded) {
			this.pushActivityToSubscribers(event.token);
		}

		// AskUserQuestion のライブ検出: Claude Code は質問の tool_use を決着（回答/中断）まで
		// transcript へ flush しないため、PreToolUse hook の tool_input から合成質問カードを
		// 注入する（チャット表示・回答待ちバッジ・プッシュ通知の唯一のライブな供給源）。
		if (event.event === 'PreToolUse' && event.toolName === 'AskUserQuestion' && event.toolInput !== undefined
			&& (this.eagerTailing || this.subscribers.has(event.token))) {
			this.ensureTailer(event.token, this.paneSessions.get(event.token) ?? info).injectLiveQuestions(event.toolInput);
		}

		// 承認要求のライブ検出: Codex は承認要求を rollout に書かず、Claude もプロンプト
		// 表示中は transcript に現れないため、PermissionRequest hook の tool_name / tool_input
		// から内容カードを注入する（モバイルの承認バーに「何を承認するのか」を添える）。
		// AskUserQuestion は除外: 上の PreToolUse 経路が選択肢つき質問カードを注入済みで、
		// こちらも注入すると生JSONの承認カードが二重に出る（回答も質問カード側で完結する）。
		// tool_name が取れない PermissionRequest（旧CLI・パース失敗）でも、質問回答待ち中は
		// AskUserQuestion 由来とみなして注入しない（質問カードと承認カードの二重表示防止）。
		if (event.event === 'PermissionRequest' && event.toolName !== 'AskUserQuestion'
			&& !getParadisAgentPaneActivity(event.token).pendingQuestion
			&& (event.toolName !== undefined || event.toolInput !== undefined)
			&& (this.eagerTailing || this.subscribers.has(event.token))) {
			this.ensureTailer(event.token, this.paneSessions.get(event.token) ?? info).injectApprovalRequest(event.toolName, event.toolInput, event.toolUseId);
		}
		const forceApprovalClear = event.event === 'Stop' || event.event === 'SessionEnd' || event.event === 'StopFailure' || event.event === 'PermissionDenied';
		const matchingApprovalClear = (event.event === 'PostToolUse' || event.event === 'PostToolUseFailure') && event.toolUseId !== undefined;
		if ((forceApprovalClear || matchingApprovalClear) && this.tailers.has(event.token)) {
			this.tailers.get(event.token)?.clearApprovalRequest(event.toolUseId, forceApprovalClear);
		}
	}

	/** daemonの次ターン設定を優先し、無ければtranscriptの直近ターン値を返す。 */
	private infoOf(token: string, tailer: TranscriptTailer): IParadisAgentSessionInfo | undefined {
		const settings = this.codexThreadSettings.get(token);
		const model = settings?.model ?? tailer.model;
		const effort = settings?.effort ?? tailer.effort;
		if (model === undefined && effort === undefined) {
			return undefined;
		}
		return {
			...(model !== undefined ? { model } : {}),
			...(effort !== undefined ? { effort } : {}),
		};
	}

	private pushInfoToSubscribers(token: string): void {
		const terminalId = this.terminalIdForToken(token);
		const tailer = this.tailers.get(token);
		const info = tailer !== undefined ? this.infoOf(token, tailer) : undefined;
		if (terminalId !== undefined && tailer !== undefined && info !== undefined) {
			this.sendToSubscribers(token, { t: 'delta', id: terminalId, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev, messages: [], info });
		}
	}

	private ensureTailer(token: string, session: IPaneSessionInfo): TranscriptTailer {
		const existing = this.tailers.get(token);
		if (existing !== undefined && existing.transcriptPath === session.transcriptPath) {
			return existing;
		}
		if (existing !== undefined) {
			this.disposeTailer(token);
		}
		const pushActivity = () => {
			setParadisAgentPaneActivity(token, {
				backgroundTasks: new Map(tailer.backgroundTasks),
				pendingQuestion: tailer.pendingQuestions.size > 0,
			});
		};
		const tailer = new TranscriptTailer(session.transcriptPath, session.agent, {
			onDelta: messages => {
				const live = this.liveStates.get(token);
				if (live?.phase === 'message' && live.final && messages.some(message => message.role === 'assistant' && message.kind === 'text')) {
					// MessageDisplayの最終バッチはtranscript本文が届くまで表示し、確定本文との二重表示を避ける。
					this.clearLiveState(token);
				}
				const terminalId = this.terminalIdForToken(token);
				if (terminalId !== undefined) {
					this.sendToSubscribers(token, { t: 'delta', id: terminalId, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev, messages, interaction: tailer.currentInteraction() });
				}
				// 質問の出現は購読の有無に関わらず通知へ流す（アプリを開いていないモバイルへの
				// プッシュ供給源。onDelta はライブ追記でのみ呼ばれるため過去分の再通知はない）。
				if (terminalId !== undefined) {
					for (const message of messages) {
						if (message.kind === 'question') {
							const ws = this.tokenToWorkspace.get(token);
							this.onQuestion({ terminalId, agent: tailer.agent, text: message.text, ...(message.header !== undefined ? { header: message.header } : {}), ...(ws !== undefined ? { ws } : {}), agentToken: token });
						}
					}
				}
			},
			onEpochReset: () => {
				const terminalId = this.terminalIdForToken(token);
				if (terminalId !== undefined) {
					const messages = tailer.messages.slice(-SNAPSHOT_SEND_LIMIT);
					const info = this.infoOf(token, tailer);
					this.sendToSubscribers(token, { t: 'snapshot', id: terminalId, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev, messages, ...(info !== undefined ? { info } : {}), live: this.liveStates.get(token) ?? null, activity: this.activityTrackers.get(token)?.snapshot() ?? null, interaction: tailer.currentInteraction(), capabilities: { agentActions: true } });
				}
			},
			// バックグラウンドタスク・質問回答待ちの変化を状態レジストリへ反映する
			// （ParadisAgentBrowserService がペイン実行状態 working/question の判定に使う）。
			onActivity: pushActivity,
			// model / effort の変化は空deltaで購読者へ届ける（メッセージ本文とは独立に変わるため）。
			onInfo: () => {
				const settings = this.codexThreadSettings.get(token);
				if (settings !== undefined && tailer.model === settings.model && tailer.effort === settings.effort) {
					this.codexThreadSettings.delete(token);
				}
				this.pushInfoToSubscribers(token);
			},
			onProgress: progress => this.updateLiveFromProgress(token, progress),
			// ターン終了（Codex の task_complete / error / turn_aborted）: 考え中表示を解除し、
			// ペイン実行状態（working）側の解除は hook バス経由で ParadisAgentBrowserService に任せる。
			onTurnEnded: reason => {
				this.clearLiveState(token);
				if (this.activityTracker(token).endTurn(reason, Date.now())) {
					this.pushActivityToSubscribers(token);
				}
				fireParadisAgentTurnEnded(token);
			},
		}, this.logService);
		this.tailers.set(token, tailer);
		return tailer;
	}

	/** tailer を破棄し、そのペインのアクティビティを「何もしていない」へ戻す（stale な赤/実行中表示の防止）。 */
	private disposeTailer(token: string): void {
		const tailer = this.tailers.get(token);
		if (tailer !== undefined) {
			tailer.dispose();
			this.tailers.delete(token);
			setParadisAgentPaneActivity(token, { backgroundTasks: new Map(), pendingQuestion: false });
		}
	}

	private stopTailerIfUnsubscribed(token: string): void {
		// status用tailはセッション確定済みの生存ペインに常駐させる。
		if (this.paneSessions.has(token) && this.isLiveToken(token)) {
			return;
		}
		if (!this.subscribers.has(token)) {
			this.disposeTailer(token);
		}
	}

	private terminalIdForToken(token: string): number | undefined {
		for (const entries of this.panesByWindow.values()) {
			for (const entry of entries) {
				if (entry.token === token) {
					return entry.terminalId;
				}
			}
		}
		return undefined;
	}

	private resolveInboundToken(terminalId: number, paneToken: string | undefined): string | undefined {
		if (paneToken !== undefined) {
			return this.isLiveToken(paneToken) && this.terminalIdForToken(paneToken) === terminalId ? paneToken : undefined;
		}
		// 旧モバイル互換。複数ウィンドウでIDが衝突する場合はMapから除外済みなので拒否する。
		return this.terminalToToken.get(terminalId);
	}

	private isLiveToken(token: string): boolean {
		return this.allLiveTokens().has(token);
	}

	private allLiveTokens(): Set<string> {
		const tokens = new Set<string>();
		for (const entries of this.panesByWindow.values()) {
			for (const entry of entries) {
				tokens.add(entry.token);
			}
		}
		return tokens;
	}

	private transcriptClaimedByOther(transcriptPath: string, token: string): boolean {
		const owner = this.transcriptClaims.get(transcriptPath);
		return owner !== undefined && owner !== token;
	}

	private confirmedAgentPaneTokens(): readonly string[] {
		return paradisConfirmedAgentPaneTokens(this.paneSessions.keys(), this.allLiveTokens());
	}

	private emitConfirmedAgentPanesIfChanged(): void {
		const next = this.confirmedAgentPaneTokens();
		if (next.length === this.lastConfirmedAgentPaneTokens.length
			&& next.every((token, index) => token === this.lastConfirmedAgentPaneTokens[index])) {
			return;
		}
		this.lastConfirmedAgentPaneTokens = next;
		this._onDidChangeConfirmedAgentPanes.fire(next);
	}

	private addSubscriber(token: string, mobileId: string): void {
		let subscribers = this.subscribers.get(token);
		if (subscribers === undefined) {
			subscribers = new Set<string>();
			this.subscribers.set(token, subscribers);
		}
		subscribers.add(mobileId);
	}

	private removeSubscriber(token: string, mobileId: string): boolean {
		const subscribers = this.subscribers.get(token);
		if (subscribers === undefined || !subscribers.delete(mobileId)) {
			return false;
		}
		if (subscribers.size === 0) {
			this.subscribers.delete(token);
		}
		return true;
	}

	private hasSubscriber(token: string, mobileId: string): boolean {
		return this.subscribers.get(token)?.has(mobileId) === true;
	}

	private sendToSubscribers(token: string, msg: AgentOutbound): void {
		for (const mobileId of this.subscribers.get(token) ?? []) {
			this.sendTo(mobileId, msg, token);
		}
	}

	private sendTo(mobileId: string, msg: AgentOutbound, token?: string): void {
		this.send(mobileId, encoder.encode(JSON.stringify({ ...msg, ...(token !== undefined ? { token } : {}) })));
	}
}
