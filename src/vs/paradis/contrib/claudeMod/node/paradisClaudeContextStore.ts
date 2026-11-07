/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude Code のコンテキストの内訳を、会話（session_id）ごとに最後の 1 件だけ覚えて保存する（shared process）。
// 内訳は同梱の mod が応答の終わりごとに送ってくる（paradisClaudeModBridge.ts の `context`）。終わった会話の内訳は
// Claude Code のどこにも残らないので、ここで保存したものが「最近のセッション」から開ける唯一の記録になる。
//
// - 件数は {@link MAX_SESSIONS}、ファイルの大きさは {@link MAX_FILE_CHARS} まで。超えたら古い会話から捨てる
// - 書き込みはまとめて遅らせる（応答の終わりごとに書かない）。書きかけで落ちても前のファイルが残るよう、別名で書いてから置き換える
// - 「動いている」会話は、mod が生きているペインの最後の会話（`bye`・`alive-changed` で外す）

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IParadisClaudeContextBreakdown, paradisParseClaudeContextBreakdown } from '../common/paradisClaudeContextBreakdown.js';
import { ParadisClaudeModEvent } from './paradisClaudeModBridge.js';

/** 覚えておく会話の数。 */
const MAX_SESSIONS = 300;
/** 保存するファイルの大きさの上限（文字数）。 */
const MAX_FILE_CHARS = 4 * 1024 * 1024;
const WRITE_DELAY_MS = 3_000;
const FILE_VERSION = 1;

/** 保存先（テストでは差し替える）。 */
export interface IParadisClaudeContextFiles {
	/** 無ければ undefined。 */
	read(): Promise<string | undefined>;
	write(text: string): Promise<void>;
}

export class ParadisClaudeContextStore extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** 動いている会話か、保存した内訳が変わった。 */
	readonly onDidChange: Event<void> = this._onDidChange.event;

	/** 会話 → 最後の内訳（古い順に並ぶ。書き直すと末尾へ移る）。 */
	private readonly sessions = new Map<string, IParadisClaudeContextBreakdown>();
	/** ペイン → いま動いている会話。 */
	private readonly live = new Map<string, string>();
	private loaded: Promise<void> | undefined;
	private writeTimer: ReturnType<typeof setTimeout> | undefined;
	private writing: Promise<void> = Promise.resolve();
	private dirty = false;

	constructor(
		private readonly files: IParadisClaudeContextFiles,
		private readonly onError: (error: unknown) => void = () => undefined,
		private readonly writeDelayMs = WRITE_DELAY_MS,
	) {
		super();
	}

	/** mod の出来事を受ける（内訳・会話の終わり・mod が途絶えた）。 */
	observe(event: ParadisClaudeModEvent): void {
		switch (event.type) {
			case 'context': {
				this.sessions.delete(event.sessionId);
				this.sessions.set(event.sessionId, event.breakdown);
				this.live.set(event.token, event.sessionId);
				this.trim();
				this.scheduleWrite();
				this._onDidChange.fire();
				break;
			}
			case 'bye':
				this.dropLive(event.token, event.sessionId);
				break;
			case 'alive-changed':
				if (!event.alive) {
					this.dropLive(event.token, event.sessionId);
				}
				break;
		}
	}

	/** 動いている会話の内訳（新しい順）。 */
	async liveBreakdowns(): Promise<IParadisClaudeContextBreakdown[]> {
		await this.ensureLoaded();
		const result: IParadisClaudeContextBreakdown[] = [];
		for (const sessionId of new Set(this.live.values())) {
			const breakdown = this.sessions.get(sessionId);
			if (breakdown !== undefined) {
				result.push(breakdown);
			}
		}
		return result.sort((a, b) => b.at - a.at);
	}

	/** 会話の最後の内訳（保存したものを含む）。 */
	async breakdownOf(sessionId: string): Promise<IParadisClaudeContextBreakdown | undefined> {
		await this.ensureLoaded();
		return this.sessions.get(sessionId);
	}

	/** その会話が動いているペインの会話か。 */
	isLive(sessionId: string): boolean {
		for (const value of this.live.values()) {
			if (value === sessionId) {
				return true;
			}
		}
		return false;
	}

	/** 遅らせている書き込みを今済ませる（終了時・テスト）。 */
	async flush(): Promise<void> {
		if (this.writeTimer !== undefined) {
			clearTimeout(this.writeTimer);
			this.writeTimer = undefined;
		}
		await this.ensureLoaded();
		this.writing = this.writing.then(() => this.writeNow());
		await this.writing;
	}

	override dispose(): void {
		const pending = this.writeTimer !== undefined || this.dirty;
		if (this.writeTimer !== undefined) {
			clearTimeout(this.writeTimer);
			this.writeTimer = undefined;
		}
		if (pending) {
			void this.writing.then(() => this.writeNow());
		}
		super.dispose();
	}

	private dropLive(token: string, sessionId: string): void {
		if (this.live.get(token) === sessionId) {
			this.live.delete(token);
			this._onDidChange.fire();
		}
	}

	private ensureLoaded(): Promise<void> {
		this.loaded ??= this.load();
		return this.loaded;
	}

	private async load(): Promise<void> {
		let text: string | undefined;
		try {
			text = await this.files.read();
		} catch (error) {
			this.onError(error);
			return;
		}
		if (text === undefined) {
			return;
		}
		let entries: unknown[] = [];
		try {
			const parsed: unknown = JSON.parse(text);
			const record = parsed !== null && typeof parsed === 'object' ? parsed as { version?: unknown; sessions?: unknown } : undefined;
			entries = record?.version === FILE_VERSION && Array.isArray(record.sessions) ? record.sessions : [];
		} catch (error) {
			this.onError(error);
			return;
		}
		// 読み込む前に届いた内訳（このプロセスで新しく取ったもの）を優先する
		const fresh = new Map(this.sessions);
		this.sessions.clear();
		for (const entry of entries.slice(-MAX_SESSIONS)) {
			const raw = entry !== null && typeof entry === 'object' ? entry as { sessionId?: unknown; at?: unknown } : undefined;
			const sessionId = typeof raw?.sessionId === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(raw.sessionId) ? raw.sessionId : undefined;
			const at = typeof raw?.at === 'number' && Number.isFinite(raw.at) ? raw.at : undefined;
			const breakdown = sessionId !== undefined && at !== undefined ? paradisParseClaudeContextBreakdown(entry, sessionId, at) : undefined;
			if (breakdown !== undefined && !fresh.has(breakdown.sessionId)) {
				this.sessions.delete(breakdown.sessionId);
				this.sessions.set(breakdown.sessionId, breakdown);
			}
		}
		for (const [sessionId, breakdown] of fresh) {
			this.sessions.set(sessionId, breakdown);
		}
		this.trim();
	}

	private trim(): void {
		while (this.sessions.size > MAX_SESSIONS) {
			const oldest = this.sessions.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.sessions.delete(oldest);
		}
	}

	private scheduleWrite(): void {
		this.dirty = true;
		if (this.writeTimer !== undefined) {
			return;
		}
		this.writeTimer = setTimeout(() => {
			this.writeTimer = undefined;
			this.writing = this.writing.then(async () => {
				await this.ensureLoaded();
				await this.writeNow();
			});
		}, this.writeDelayMs);
	}

	private async writeNow(): Promise<void> {
		if (!this.dirty) {
			return;
		}
		this.dirty = false;
		let sessions = [...this.sessions.values()];
		let text = serialize(sessions);
		// 大きすぎれば古い会話から捨てる（覚えている方も合わせる）
		while (text.length > MAX_FILE_CHARS && sessions.length > 0) {
			const drop = Math.max(1, Math.ceil(sessions.length / 10));
			for (const breakdown of sessions.slice(0, drop)) {
				this.sessions.delete(breakdown.sessionId);
			}
			sessions = sessions.slice(drop);
			text = serialize(sessions);
		}
		try {
			await this.files.write(text);
		} catch (error) {
			this.onError(error);
		}
	}
}

function serialize(sessions: readonly IParadisClaudeContextBreakdown[]): string {
	return JSON.stringify({ version: FILE_VERSION, sessions });
}

let current: ParadisClaudeContextStore | undefined;

/** shared process の内訳の保存（paradisClaudeContext.sharedProcess.ts が置く。置く前・REH では undefined）。 */
export function paradisClaudeContextStore(): ParadisClaudeContextStore | undefined {
	return current;
}

/** 内訳の保存を置く・外す（登録口だけが呼ぶ）。 */
export function paradisSetClaudeContextStore(store: ParadisClaudeContextStore | undefined): void {
	current = store;
}
