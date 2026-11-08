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
// - 会話ごとに、最後の内訳と一番大きかった時点の内訳（`/compact` の前の山。「AI コスト」の期間の集計に使う）を持つ
// - 件数は {@link MAX_SESSIONS}、ファイルの大きさは {@link MAX_FILE_CHARS} まで。超えたら古い会話から捨てる
// - 書き込みはまとめて遅らせる（応答の終わりごとに書かない）。書きかけで落ちても前のファイルが残るよう、別名で書いてから置き換える
// - 「動いている」会話は、mod が生きているペインの最後の会話（`bye`・`alive-changed` で外す）
// - 鍵はペインと会話の組。別のペインが同じ会話 ID を名乗っても上書きできない。ペイントークンはファイルに書かず、指紋だけを書く

import { createHash } from 'crypto';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IParadisClaudeContextBreakdown, paradisParseClaudeContextBreakdown } from '../common/paradisClaudeContextBreakdown.js';
import { ParadisClaudeModEvent } from './paradisClaudeModBridge.js';

/**
 * 覚えておく会話の数。1 会話は最後と山の 2 件でおよそ 7 KB（MCP サーバー 9・スキル 220・メモリファイル 6 の設定で測った）、
 * 一覧が上限の 20 行で名前が長いと 46 KB。90 日間を選んでも足りるよう多めに持つ。
 */
const MAX_SESSIONS = 1_500;
/** 保存するファイルの大きさの上限（文字数）。 */
const MAX_FILE_CHARS = 12 * 1024 * 1024;
/** 書き込みをまとめる間隔（ファイルが数 MB になるので、応答の終わりごとには書かない）。 */
const WRITE_DELAY_MS = 30_000;
const FILE_VERSION = 1;

/** 保存したペインの指紋の形。 */
const OWNER_PATTERN = /^[0-9a-f]{16}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

interface IRecord {
	/** 送ってきたペイン（ペイントークンの指紋）。 */
	readonly owner: string;
	/** 最後の内訳。 */
	readonly breakdown: IParadisClaudeContextBreakdown;
	/** 一番大きかった時点の内訳（山を持たない古い保存は最後の内訳と同じ）。 */
	readonly peak: IParadisClaudeContextBreakdown;
}

/** 大きい方の内訳（同じなら後のもの）。 */
function larger(a: IParadisClaudeContextBreakdown, b: IParadisClaudeContextBreakdown): IParadisClaudeContextBreakdown {
	return a.totalTokens > b.totalTokens ? a : b;
}

/** ペイントークンの指紋（ファイルにはトークンそのものを書かない）。 */
function ownerOf(token: string): string {
	return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function keyOf(owner: string, sessionId: string): string {
	return `${owner}\0${sessionId}`;
}

/** 保存先（テストでは差し替える）。 */
export interface IParadisClaudeContextFiles {
	/** 無ければ undefined。 */
	read(): Promise<string | undefined>;
	write(text: string): Promise<void>;
	/** プロセスの終わりに使う同期の読み書き（{@link ParadisClaudeContextStore.flushSync}）。 */
	readSync?(): string | undefined;
	writeSync?(text: string): void;
}

export class ParadisClaudeContextStore extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** 動いている会話か、保存した内訳が変わった。 */
	readonly onDidChange: Event<void> = this._onDidChange.event;

	/** ペインと会話の組 → 最後の内訳（古い順に並ぶ。書き直すと末尾へ移る）。 */
	private readonly sessions = new Map<string, IRecord>();
	/** ペイン → いま動いている会話の鍵。 */
	private readonly live = new Map<string, string>();
	private loaded: Promise<void> | undefined;
	/** 終了時に同期で読み込んだ（後から非同期の読み込みが終わっても合わせ直さない）。 */
	private loadedSync = false;
	/** 非同期の読み込みが終わった。 */
	private loadSettled = false;
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
				const owner = ownerOf(event.token);
				const key = keyOf(owner, event.sessionId);
				const previous = this.sessions.get(key);
				this.sessions.delete(key);
				this.sessions.set(key, { owner, breakdown: event.breakdown, peak: previous !== undefined ? larger(previous.peak, event.breakdown) : event.breakdown });
				this.live.set(event.token, key);
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

	/**
	 * 最後の応答が `from`〜`to`（PC の時計、両端を含む）にある会話の、一番大きかった時点の内訳。同じ会話を 2 つのペインが
	 * 送っていれば大きい方を使う。`since` は保存してある内訳のうち一番古い時刻。
	 */
	async peaksBetween(from: number, to: number): Promise<{ readonly peaks: IParadisClaudeContextBreakdown[]; readonly since?: number }> {
		await this.ensureLoaded();
		const bySession = new Map<string, IRecord>();
		let since: number | undefined;
		for (const record of this.sessions.values()) {
			since = since === undefined ? record.breakdown.at : Math.min(since, record.breakdown.at);
			if (record.breakdown.at < from || record.breakdown.at > to) {
				continue;
			}
			const other = bySession.get(record.breakdown.sessionId);
			if (other === undefined || record.peak.totalTokens > other.peak.totalTokens) {
				bySession.set(record.breakdown.sessionId, record);
			}
		}
		return { peaks: [...bySession.values()].map(record => record.peak), ...(since !== undefined ? { since } : {}) };
	}

	/**
	 * 会話の最後の内訳（保存したものを含む）。`token` を渡すとそのペインが送ったものだけ、渡さなければ（「最近のセッション」の行。
	 * 会話の ID しか分からない）その会話の内訳のうち一番新しいもの。
	 */
	async breakdownOf(sessionId: string, token?: string): Promise<IParadisClaudeContextBreakdown | undefined> {
		await this.ensureLoaded();
		if (token !== undefined) {
			return this.sessions.get(keyOf(ownerOf(token), sessionId))?.breakdown;
		}
		let newest: IParadisClaudeContextBreakdown | undefined;
		for (const record of this.sessions.values()) {
			if (record.breakdown.sessionId === sessionId && (newest === undefined || record.breakdown.at > newest.at)) {
				newest = record.breakdown;
			}
		}
		return newest;
	}

	/**
	 * そのペインがいま動かしている会話の最後の内訳（エディタのターミナル右上のポップオーバー）。そのペインが送ったものだけで、
	 * 会話が終わった（`bye`）・mod が途絶えたペインは undefined。
	 */
	async breakdownForPane(token: string): Promise<IParadisClaudeContextBreakdown | undefined> {
		await this.ensureLoaded();
		const key = this.live.get(token);
		return key !== undefined ? this.sessions.get(key)?.breakdown : undefined;
	}

	/** その会話がいま動いているペインの会話か。 */
	isLive(sessionId: string): boolean {
		for (const key of this.live.values()) {
			if (this.sessions.get(key)?.breakdown.sessionId === sessionId) {
				return true;
			}
		}
		return false;
	}

	/**
	 * プロセスの終わり（`exit`。非同期の処理はもう走らない）に、まだ書いていない内訳を同期で書く。まだファイルを読んでいなければ
	 * 先に同期で読み、保存してあった過去の内訳を消さない。
	 */
	flushSync(): void {
		if (!this.dirty && this.writeTimer === undefined) {
			return;
		}
		if (this.writeTimer !== undefined) {
			clearTimeout(this.writeTimer);
			this.writeTimer = undefined;
		}
		const files = this.files;
		if (files.readSync === undefined || files.writeSync === undefined) {
			return;
		}
		try {
			if (!this.loadSettled) {
				this.loadedSync = true;
				this.applyLoaded(files.readSync());
			}
			const text = this.serializeTrimmed();
			if (text !== undefined) {
				files.writeSync(text);
			}
		} catch (error) {
			this.onError(error);
		}
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
			// 読み込む前に書くと、保存してあった過去の内訳を上書きして失う
			void this.writing.then(async () => {
				await this.ensureLoaded();
				await this.writeNow();
			});
		}
		super.dispose();
	}

	private dropLive(token: string, sessionId: string): void {
		if (this.live.get(token) === keyOf(ownerOf(token), sessionId)) {
			this.live.delete(token);
			this._onDidChange.fire();
		}
	}

	private ensureLoaded(): Promise<void> {
		this.loaded ??= this.load().finally(() => {
			this.loadSettled = true;
		});
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
		if (!this.loadedSync) {
			this.applyLoaded(text);
		}
	}

	/** 読んだファイルの中身を、読む前に届いた内訳と合わせる。 */
	private applyLoaded(text: string | undefined): void {
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
			const raw = entry !== null && typeof entry === 'object' ? entry as { owner?: unknown; sessionId?: unknown; at?: unknown; peak?: unknown } : undefined;
			const owner = typeof raw?.owner === 'string' && OWNER_PATTERN.test(raw.owner) ? raw.owner : undefined;
			const sessionId = typeof raw?.sessionId === 'string' && SESSION_ID_PATTERN.test(raw.sessionId) ? raw.sessionId : undefined;
			const at = typeof raw?.at === 'number' && Number.isFinite(raw.at) ? raw.at : undefined;
			const breakdown = owner !== undefined && sessionId !== undefined && at !== undefined ? paradisParseClaudeContextBreakdown(entry, sessionId, at) : undefined;
			const key = owner !== undefined && breakdown !== undefined ? keyOf(owner, breakdown.sessionId) : undefined;
			if (owner === undefined || breakdown === undefined || key === undefined) {
				continue;
			}
			// 山を持たない保存（#741 の形）は、最後の内訳を山とみなす
			const peakRaw = raw?.peak !== null && typeof raw?.peak === 'object' ? raw.peak as { at?: unknown } : undefined;
			const peakAt = typeof peakRaw?.at === 'number' && Number.isFinite(peakRaw.at) ? peakRaw.at : undefined;
			const peak = peakAt !== undefined ? paradisParseClaudeContextBreakdown(peakRaw, breakdown.sessionId, peakAt) : undefined;
			const saved: IRecord = { owner, breakdown, peak: peak !== undefined ? larger(peak, breakdown) : breakdown };
			const newer = fresh.get(key);
			if (newer !== undefined) {
				// 読む前に届いた内訳を残し、保存してあった山とは大きい方を使う
				fresh.set(key, { ...newer, peak: larger(saved.peak, newer.peak) });
				continue;
			}
			this.sessions.delete(key);
			this.sessions.set(key, saved);
		}
		for (const [key, record] of fresh) {
			this.sessions.delete(key);
			this.sessions.set(key, record);
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
		const text = this.serializeTrimmed();
		if (text === undefined) {
			return;
		}
		try {
			await this.files.write(text);
		} catch (error) {
			this.onError(error);
		}
	}

	/** 書く中身（大きすぎれば古い会話から捨てる）。書くものが無ければ undefined。 */
	private serializeTrimmed(): string | undefined {
		if (!this.dirty) {
			return undefined;
		}
		this.dirty = false;
		let sessions = [...this.sessions.values()];
		let text = serialize(sessions);
		// 大きすぎれば古い会話から捨てる（覚えている方も合わせる）
		while (text.length > MAX_FILE_CHARS && sessions.length > 0) {
			const drop = Math.max(1, Math.ceil(sessions.length / 10));
			for (const record of sessions.slice(0, drop)) {
				this.sessions.delete(keyOf(record.owner, record.breakdown.sessionId));
			}
			sessions = sessions.slice(drop);
			text = serialize(sessions);
		}
		return text;
	}
}

function serialize(sessions: readonly IRecord[]): string {
	return JSON.stringify({
		version: FILE_VERSION,
		// 山が最後の内訳と同じなら書かない（読むときは最後の内訳を山とみなす）
		sessions: sessions.map(record => ({ owner: record.owner, ...record.breakdown, ...(record.peak !== record.breakdown ? { peak: record.peak } : {}) })),
	});
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
