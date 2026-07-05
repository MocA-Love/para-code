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
//  - モバイルからの入力・承認キーは既存の term チャネル (PTY stdin注入) を使うため、
//    このチャネルは読み取り専用ミラー + 購読管理のみを担う
//
// 切断・再接続への堅牢性 (設計方針):
//  - 真実の源は常にディスク上の transcript ファイル。プロセス再起動・リレー切断で
//    何かが失われることはなく、再購読すれば必ず再構築できる
//  - 各tailerは epoch (tail開始ごとに一意) + rev (メッセージ連番) を持つ。モバイルは
//    attach 時に手元の epoch/afterRev を申告し、epoch一致なら差分のみ、不一致
//    (shared process再起動・セッション切替) なら全量スナップショットを受け取る
//  - ファイル監視は fs.watch + ポーリングの二重化 (watchの取りこぼし・未作成ファイル対応)。
//    truncate/置き換え (サイズ減少) を検知したら epoch を切り替えて読み直す

import { watch, FSWatcher, promises as fs } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, resolve, sep } from '../../../../base/common/path.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisAgentHookEvent, onParadisAgentHookEvent } from '../../agentBrowser/node/paradisAgentHookBus.js';

/** エージェントCLIの種別 (transcriptパスから判定)。 */
export type ParadisAgentKind = 'claude' | 'codex';

/** モバイルへ送る正規化済みチャットメッセージ1件。 */
export interface IParadisAgentChatMessage {
	/** epoch内で単調増加する連番 (差分同期用)。 */
	readonly rev: number;
	readonly role: 'user' | 'assistant' | 'tool';
	readonly kind: 'text' | 'thinking' | 'tool_use' | 'tool_result';
	readonly text: string;
	/** kind==='tool_use' のときのツール名。 */
	readonly tool?: string;
	/** 元イベントの時刻 (epoch ms、取れた場合のみ)。 */
	readonly ts?: number;
}

/** agentチャネルのモバイル→PCメッセージ。 */
type AgentInbound =
	| { t: 'attach'; id: number; epoch?: string; afterRev?: number }
	| { t: 'detach'; id: number };

/** agentチャネルのPC→モバイルメッセージ。 */
type AgentOutbound =
	| { t: 'snapshot'; id: number; agent: ParadisAgentKind; epoch: string; rev: number; messages: IParadisAgentChatMessage[]; truncated?: boolean }
	| { t: 'delta'; id: number; agent: ParadisAgentKind; epoch: string; rev: number; messages: IParadisAgentChatMessage[] }
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

function truncateText(text: string, limit: number): string {
	// allow-any-unicode-next-line
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function newEpoch(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function agentKindForPath(transcriptPath: string): ParadisAgentKind {
	return /[\\/]\.codex[\\/]/.test(transcriptPath) ? 'codex' : 'claude';
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
	const roots = [join(homedir(), '.claude'), join(homedir(), '.codex')];
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
	readonly kind: 'text' | 'thinking' | 'tool_use' | 'tool_result';
	readonly text: string;
	readonly tool?: string;
	readonly ts?: number;
}

/** unknown からの安全なプロパティ読み出し。 */
function rec(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
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

/** Claude Code transcript JSONL の1行をパースする。表示対象外の行は空配列。 */
function parseClaudeLine(obj: Record<string, unknown>): IRawMessage[] {
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
			if (content.trim().length > 0) {
				out.push({ role: 'user', kind: 'text', text: truncateText(content, TEXT_LIMIT), ts });
			}
			return out;
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
						out.push({ role: 'user', kind: 'text', text: truncateText(text, TEXT_LIMIT), ts });
					}
				} else if (b['type'] === 'tool_result') {
					const text = flattenContent(b['content']);
					if (text.trim().length > 0) {
						out.push({ role: 'tool', kind: 'tool_result', text: truncateText(text, TOOL_TEXT_LIMIT), ts });
					}
				}
			}
		}
		return out;
	}

	// assistant
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
				let text = '';
				try {
					text = JSON.stringify(b['input']);
				} catch { /* 表示は空でよい */ }
				out.push({ role: 'assistant', kind: 'tool_use', tool, text: truncateText(text, TOOL_TEXT_LIMIT), ts });
			}
		}
	}
	return out;
}

/** Codex rollout JSONL の1行をパースする。表示対象外の行は空配列。 */
function parseCodexLine(obj: Record<string, unknown>): IRawMessage[] {
	// rollout行: { timestamp, type, payload }
	if (obj['type'] !== 'response_item') {
		return []; // event_msg は response_item と重複するため使わない。session_meta 等も対象外
	}
	const payload = rec(obj['payload']);
	if (!payload) {
		return [];
	}
	const tsRaw = str(obj['timestamp']);
	const tsParsed = tsRaw !== undefined ? Date.parse(tsRaw) : NaN;
	const ts = Number.isFinite(tsParsed) ? tsParsed : undefined;
	const ptype = str(payload['type']);
	const out: IRawMessage[] = [];

	if (ptype === 'message') {
		const role = str(payload['role']);
		if (role !== 'user' && role !== 'assistant') {
			return []; // developer / system プロンプトは出さない
		}
		const text = flattenContent(payload['content']);
		// Codexはuserメッセージとして環境コンテキストXMLを注入するため表示から除く
		if (text.trim().length === 0 || /^<(environment_context|user_instructions|ENVIRONMENT_CONTEXT)/.test(text.trim())) {
			return [];
		}
		out.push({ role, kind: 'text', text: truncateText(text, TEXT_LIMIT), ts });
	} else if (ptype === 'reasoning') {
		const text = flattenContent(payload['summary']);
		if (text.trim().length > 0) {
			out.push({ role: 'assistant', kind: 'thinking', text: truncateText(text, TOOL_TEXT_LIMIT), ts });
		}
	} else if (ptype === 'function_call') {
		const tool = str(payload['name']) ?? 'tool';
		const text = str(payload['arguments']) ?? '';
		out.push({ role: 'assistant', kind: 'tool_use', tool, text: truncateText(text, TOOL_TEXT_LIMIT), ts });
	} else if (ptype === 'local_shell_call') {
		let text = '';
		try {
			text = JSON.stringify(payload['action']);
		} catch { /* 表示は空でよい */ }
		out.push({ role: 'assistant', kind: 'tool_use', tool: 'shell', text: truncateText(text, TOOL_TEXT_LIMIT), ts });
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
			out.push({ role: 'tool', kind: 'tool_result', text: truncateText(text, TOOL_TEXT_LIMIT), ts });
		}
	}
	return out;
}

// ---- tailer ---------------------------------------------------------------------------------

interface ITailerDelegate {
	/** 追記分のメッセージが確定した (差分push用)。 */
	onDelta(messages: IParadisAgentChatMessage[]): void;
	/** epoch が切り替わった (truncate検知・読み直し)。購読者へ全量スナップショットを送り直す。 */
	onEpochReset(): void;
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
	/** 初回読み込みが完了したら resolve (attach応答はこれを待つ)。 */
	readonly ready: Promise<void>;

	private offset = 0;
	private remainder = '';
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
			let text = decoder.decode(buffer.subarray(0, bytesRead));
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
				this.initialTruncated = false;
				await handle.close().catch(() => { /* ignore */ });
				await this.initialLoad();
				this.delegate.onEpochReset();
				return;
			}
			if (stat.size === this.offset) {
				return;
			}
			const length = stat.size - this.offset;
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
			this.offset += bytesRead;
			this.consumeText(decoder.decode(buffer.subarray(0, bytesRead)), true);
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
			const raw = this.agent === 'claude' ? parseClaudeLine(obj) : parseCodexLine(obj);
			for (const message of raw) {
				added.push({ ...message, rev: this.rev++ });
			}
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
}

// ---- マネージャ ------------------------------------------------------------------------------

interface IPaneSessionInfo {
	readonly token: string;
	readonly agent: ParadisAgentKind;
	readonly transcriptPath: string;
	readonly sessionId: string | undefined;
}

/**
 * agentチャネル本体。hookバスからペイン⇔transcriptの対応を学習し、モバイルの購読
 * (attach/detach) に応じて tailer を起動・停止する。tailer は購読者がいる間だけ動かし、
 * 誰も見ていないファイルの監視コストを避ける (再attach時はファイルから全量再構築)。
 */
export class ParadisMobileAgentChat extends Disposable {

	/** ペイントークン → 既知のセッション情報 (hookバスから学習、購読の有無に関わらず保持)。 */
	private readonly paneSessions = new Map<string, IPaneSessionInfo>();
	/** ターミナルinstanceId → ペイントークン (rendererから同期)。 */
	private readonly terminalToToken = new Map<number, string>();
	/** ペイントークン → 稼働中の tailer (購読者がいる間のみ)。 */
	private readonly tailers = new Map<string, TranscriptTailer>();
	/** ペイントークン → 購読中モバイルID (最後にattachしたモバイルが勝つ。termチャネルと同じM-2方針)。 */
	private readonly subscribers = new Map<string, string>();

	constructor(
		private readonly send: (mobileId: string, payload: Uint8Array) => void,
		private readonly logService: ILogService,
	) {
		super();
		this._register(onParadisAgentHookEvent(event => this.onHookEvent(event)));
		this._register(toDisposable(() => {
			for (const tailer of this.tailers.values()) {
				tailer.dispose();
			}
			this.tailers.clear();
		}));
	}

	/** renderer から同期される「ターミナルinstanceId ⇔ ペイントークン」対応表 (全置換)。 */
	syncPanes(entries: readonly { terminalId: number; token: string }[]): void {
		this.terminalToToken.clear();
		for (const entry of entries) {
			if (typeof entry.terminalId === 'number' && typeof entry.token === 'string' && entry.token.length > 0) {
				this.terminalToToken.set(entry.terminalId, entry.token);
			}
		}
		// 消えたターミナル（PC側でclose等）の購読・tailerを掃除する。detachは
		// terminalId→token解決に依存するため、ここで拾わないとtailerがリークする。
		const liveTokens = new Set(this.terminalToToken.values());
		for (const token of [...this.subscribers.keys()]) {
			if (!liveTokens.has(token)) {
				this.subscribers.delete(token);
			}
		}
		for (const [token, tailer] of [...this.tailers]) {
			if (!liveTokens.has(token)) {
				tailer.dispose();
				this.tailers.delete(token);
			}
		}
	}

	/** モバイルの切断 (presence offline)。そのモバイルの購読をすべて解放する。 */
	dropSubscriber(mobileId: string): void {
		for (const [token, subscriber] of [...this.subscribers]) {
			if (subscriber === mobileId) {
				this.subscribers.delete(token);
				this.stopTailerIfUnsubscribed(token);
			}
		}
	}

	/** agentチャネルのモバイル→PCメッセージを処理する。 */
	handleInbound(mobileId: string, payload: Uint8Array): void {
		let msg: AgentInbound;
		try {
			msg = JSON.parse(decoder.decode(payload)) as AgentInbound;
		} catch {
			return;
		}
		if (msg.t === 'attach' && typeof msg.id === 'number') {
			this.handleAttach(mobileId, msg).catch(err => this.logService.warn('[paradisAgentChat] attach failed', err));
		} else if (msg.t === 'detach' && typeof msg.id === 'number') {
			const token = this.terminalToToken.get(msg.id);
			if (token !== undefined && this.subscribers.get(token) === mobileId) {
				this.subscribers.delete(token);
				this.stopTailerIfUnsubscribed(token);
			}
		}
	}

	private async handleAttach(mobileId: string, msg: { id: number; epoch?: string; afterRev?: number }): Promise<void> {
		const token = this.terminalToToken.get(msg.id);
		const session = token !== undefined ? this.paneSessions.get(token) : undefined;
		if (token === undefined || session === undefined) {
			// このターミナルではまだエージェントのhookが発火していない (エージェント未起動、
			// または旧notify.sh)。モバイル側は「ターミナルタブで見る」案内を出す。
			this.sendTo(mobileId, { t: 'none', id: msg.id });
			return;
		}
		this.subscribers.set(token, mobileId);
		const tailer = this.ensureTailer(token, session);
		await tailer.ready;
		// attach処理中に購読が置き換わっていたら何もしない
		if (this.subscribers.get(token) !== mobileId) {
			return;
		}
		const afterRev = msg.afterRev;
		// 差分応答は「afterRevの続きが欠けなくリングに残っている」場合のみ。切断中に
		// リング上限を超えて古い分が退避済みだと、先頭revが飛んでいてサイレント欠落に
		// なるため、その場合は全量スナップショットへフォールバックする。
		const oldestRev = tailer.messages.length > 0 ? tailer.messages[0].rev : tailer.rev;
		if (msg.epoch === tailer.epoch && typeof afterRev === 'number' && afterRev >= oldestRev - 1) {
			// モバイルが同一epochの途中まで持っている → 差分のみ (リレー瞬断からの再接続)
			const messages = tailer.messages.filter(m => m.rev > afterRev);
			this.sendTo(mobileId, { t: 'delta', id: msg.id, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev, messages });
		} else {
			const messages = tailer.messages.slice(-SNAPSHOT_SEND_LIMIT);
			this.sendTo(mobileId, {
				t: 'snapshot', id: msg.id, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev, messages,
				...(tailer.wasInitialTruncated || tailer.messages.length > messages.length ? { truncated: true } : {}),
			});
		}
	}

	private onHookEvent(event: IParadisAgentHookEvent): void {
		if (event.transcriptPath === undefined || event.transcriptPath.length === 0) {
			return;
		}
		this.onHookEventChecked(event, event.transcriptPath).catch(err => this.logService.warn('[paradisAgentChat] hook event handling failed', err));
	}

	private async onHookEventChecked(event: IParadisAgentHookEvent, transcriptPath: string): Promise<void> {
		if (!(await isAllowedTranscriptPath(transcriptPath))) {
			this.logService.warn(`[paradisAgentChat] rejected transcript path outside allowed roots: ${transcriptPath}`);
			return;
		}
		const previous = this.paneSessions.get(event.token);
		const info: IPaneSessionInfo = {
			token: event.token,
			agent: agentKindForPath(transcriptPath),
			transcriptPath,
			sessionId: event.sessionId,
		};
		this.paneSessions.set(event.token, info);

		// 同じペインで別セッションが始まった (claude再起動・/clear・resume等でファイルが変わる)
		// → 稼働中の tailer を張り替え、購読者には新セッションのスナップショットを送り直す。
		if (previous !== undefined && previous.transcriptPath !== info.transcriptPath) {
			const tailer = this.tailers.get(event.token);
			if (tailer !== undefined) {
				tailer.dispose();
				this.tailers.delete(event.token);
				const subscriber = this.subscribers.get(event.token);
				if (subscriber !== undefined) {
					const terminalId = this.terminalIdForToken(event.token);
					if (terminalId !== undefined) {
						this.handleAttach(subscriber, { id: terminalId }).catch(err => this.logService.warn('[paradisAgentChat] re-attach after session switch failed', err));
					}
				}
			}
		}
	}

	private ensureTailer(token: string, session: IPaneSessionInfo): TranscriptTailer {
		const existing = this.tailers.get(token);
		if (existing !== undefined && existing.transcriptPath === session.transcriptPath) {
			return existing;
		}
		existing?.dispose();
		const tailer = new TranscriptTailer(session.transcriptPath, session.agent, {
			onDelta: messages => {
				const subscriber = this.subscribers.get(token);
				const terminalId = this.terminalIdForToken(token);
				if (subscriber !== undefined && terminalId !== undefined) {
					this.sendTo(subscriber, { t: 'delta', id: terminalId, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev, messages });
				}
			},
			onEpochReset: () => {
				const subscriber = this.subscribers.get(token);
				const terminalId = this.terminalIdForToken(token);
				if (subscriber !== undefined && terminalId !== undefined) {
					const messages = tailer.messages.slice(-SNAPSHOT_SEND_LIMIT);
					this.sendTo(subscriber, { t: 'snapshot', id: terminalId, agent: tailer.agent, epoch: tailer.epoch, rev: tailer.rev, messages });
				}
			},
		}, this.logService);
		this.tailers.set(token, tailer);
		return tailer;
	}

	private stopTailerIfUnsubscribed(token: string): void {
		if (!this.subscribers.has(token)) {
			const tailer = this.tailers.get(token);
			if (tailer !== undefined) {
				tailer.dispose();
				this.tailers.delete(token);
			}
		}
	}

	private terminalIdForToken(token: string): number | undefined {
		for (const [terminalId, candidate] of this.terminalToToken) {
			if (candidate === token) {
				return terminalId;
			}
		}
		return undefined;
	}

	private sendTo(mobileId: string, msg: AgentOutbound): void {
		this.send(mobileId, encoder.encode(JSON.stringify(msg)));
	}
}
