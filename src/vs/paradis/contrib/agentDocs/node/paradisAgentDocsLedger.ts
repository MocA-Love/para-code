/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 資料の台帳（ファイル → 持ち主の会話）。shared process の中で 1 つだけ持ち、利用者データの
// `paradis-docs/ledger.json` へ書く。書き込みはまとめて遅らせ、一時ファイルからの置き換えで行う。

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import {
	IParadisDocOwner,
	IParadisDocRecord,
	IParadisDocRemoval,
	IParadisDocWrite,
	PARADIS_DOC_MAX_RECORDS,
	PARADIS_DOC_MAX_REMOVALS,
	ParadisDocOwnerVia,
	ParadisDocRegisteredBy,
	paradisDocKey,
	paradisDocKind,
	paradisDocLastActivity,
	paradisParseDocLedger,
	paradisParseDocRemovals,
	paradisSerializeDocLedger,
	paradisWithDocOwner,
	paradisWithDocWrite,
} from '../common/paradisAgentDocs.js';

/** 台帳のファイルの読み書き（テストでは差し替える）。 */
export interface IParadisDocLedgerStorage {
	read(): Promise<string | undefined>;
	write(text: string): Promise<void>;
}

/** 持ち主にする会話（持ち主になった経路と時刻は台帳が付ける）。 */
export type ParadisDocOwnerCandidate = Pick<IParadisDocOwner, 'agent' | 'session' | 'cwd'>;

/** 書き込みを遅らせる時間。 */
const SAVE_DELAY_MS = 500;

export class ParadisAgentDocsLedger extends Disposable {

	private readonly _records = new Map<string, IParadisDocRecord>();
	/** 利用者が一覧から外した資料（キー → 控え）。その後の書き込み・登録で消える。 */
	private readonly _removed = new Map<string, IParadisDocRemoval>();
	private readonly _saver: RunOnceScheduler;
	private _saving: Promise<void> = Promise.resolve();
	readonly ready: Promise<void>;

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** 台帳の中身が変わった（「資料」ビューが一覧を取り直す）。 */
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		private readonly _storage: IParadisDocLedgerStorage,
		private readonly _onError: (error: unknown) => void,
		private readonly _now: () => number = Date.now,
	) {
		super();
		this._saver = this._register(new RunOnceScheduler(() => this._save(), SAVE_DELAY_MS));
		this.ready = this._load();
	}

	private async _load(): Promise<void> {
		let text: string | undefined;
		try {
			text = await this._storage.read();
		} catch (error) {
			this._onError(error);
		}
		// 読み込みの前に届いた更新を消さないよう、まだ無いものだけを足す
		for (const record of paradisParseDocLedger(text)) {
			const key = paradisDocKey(record.hostId, record.path);
			if (!this._records.has(key)) {
				this._records.set(key, record);
			}
		}
		for (const removal of paradisParseDocRemovals(text)) {
			const key = paradisDocKey(removal.hostId, removal.path);
			if (!this._records.has(key) && !this._removed.has(key)) {
				this._removed.set(key, removal);
			}
		}
		this._onDidChange.fire();
	}

	get(hostId: string, path: string): IParadisDocRecord | undefined {
		return this._records.get(paradisDocKey(hostId, path));
	}

	all(): readonly IParadisDocRecord[] {
		return [...this._records.values()];
	}

	/**
	 * 書き込みを記録し、書いた会話を持ち主にする（最後に書いた会話が持ち主）。資料でないパスは何もしない。
	 * 同じ会話の同じ呼び出し（toolUseId）が既に載っていれば何もしない（hook と会話の記録の両方から届くため）。
	 */
	recordWrite(hostId: string, path: string, owner: ParadisDocOwnerCandidate, write: Omit<IParadisDocWrite, 'session'>): void {
		const record = this._getOrCreate(hostId, path, 'write');
		if (record === undefined || (write.toolUseId !== undefined && record.writes.some(known => known.toolUseId === write.toolUseId && known.session === owner.session))) {
			return;
		}
		const { missingSince: _missingSince, ...present } = record;
		this._set(paradisWithDocWrite(paradisWithDocOwner(present, this._owner(owner, 'write')), { ...write, session: owner.session }));
	}

	/**
	 * 会話の記録（transcript）から拾った書き込みを記録する。`at` は記録の行の時刻。
	 *
	 * 書かれてすぐ読んだ行（`live`）は hook と同じ扱い（書いた会話が持ち主）。過去の分として読んだ行（起動の後の
	 * 読み込み・読み直し）は、台帳がまだ知らないことだけを足す: 台帳に無い資料を載せる、持ち主のいない資料の持ち主にする、
	 * 台帳の最後の動きより新しい書き込みなら持ち主を移す。台帳の最後の動きより古い書き込みは、引き取り（adopt_doc）や
	 * 後から書いた会話を巻き戻すので使わない。利用者が一覧から外した資料は、外す前の書き込みからは載せ直さない。
	 * @returns 台帳を変えたか
	 */
	recordTranscriptWrite(hostId: string, path: string, owner: ParadisDocOwnerCandidate, write: Omit<IParadisDocWrite, 'session'>, live: boolean): boolean {
		const existing = this.get(hostId, path);
		if (existing !== undefined && write.toolUseId !== undefined && existing.writes.some(known => known.toolUseId === write.toolUseId && known.session === owner.session)) {
			return false;
		}
		if (!live) {
			const removal = this._removed.get(paradisDocKey(hostId, path));
			if (existing === undefined ? removal !== undefined && write.at <= removal.at : existing.owner !== undefined && write.at <= paradisDocLastActivity(existing)) {
				return false;
			}
		}
		if (paradisDocKind(path) === undefined) {
			return false;
		}
		this.recordWrite(hostId, path, owner, write);
		return true;
	}

	/**
	 * preview_file で開いた資料を、持ち主がいなければ開いた会話の資料にする。
	 * @returns registered = 今登録した、mine = もともとこの会話の資料、other = 別の会話の資料、undefined = 資料ではない
	 */
	registerPreview(hostId: string, path: string, owner: ParadisDocOwnerCandidate): 'registered' | 'mine' | 'other' | undefined {
		const existing = this.get(hostId, path);
		if (existing?.owner !== undefined) {
			if (existing.owner.session !== owner.session) {
				return 'other';
			}
			// 終わったはずの会話が開き直した（再開した）なら、終了の印を外す
			if (existing.owner.ended !== undefined) {
				this._set(paradisWithDocOwner(existing, existing.owner));
			}
			return 'mine';
		}
		const record = existing ?? this._getOrCreate(hostId, path, 'preview');
		if (record === undefined) {
			return undefined;
		}
		this._set(paradisWithDocOwner(record, this._owner(owner, 'preview')));
		return 'registered';
	}

	/** adopt_doc で引き取る（判定は呼び出し側で済ませる）。 */
	adopt(hostId: string, path: string, owner: ParadisDocOwnerCandidate): void {
		const record = this._getOrCreate(hostId, path, 'adopt');
		if (record !== undefined) {
			this._set(paradisWithDocOwner(record, this._owner(owner, 'adopt')));
		}
	}

	/**
	 * 利用者が Para Code のプレビューで開いた資料を、まだ台帳に無ければ持ち主なしで載せる。持ち主には触らない
	 * （preview_file で開いたときもプレビューは開くので、エージェントの登録を上書きしない）。
	 * @returns 今載せたか
	 */
	registerUserOpened(hostId: string, path: string): boolean {
		if (this.get(hostId, path) !== undefined) {
			return false;
		}
		const record = this._getOrCreate(hostId, path, 'user_opened');
		if (record === undefined) {
			return false;
		}
		this._set(record);
		return true;
	}

	/**
	 * 持ち主のいない資料を、利用者が選んだ会話の資料にする（「このセッションの資料にする」）。
	 * @returns assigned = 持ち主にした、owned = 既に持ち主がいる（何もしない）、unknown = 台帳に無い
	 */
	assignOwner(hostId: string, path: string, owner: ParadisDocOwnerCandidate): 'assigned' | 'owned' | 'unknown' {
		const record = this.get(hostId, path);
		if (record === undefined) {
			return 'unknown';
		}
		if (record.owner !== undefined) {
			return 'owned';
		}
		this._set(paradisWithDocOwner(record, this._owner(owner, 'user')));
		return 'assigned';
	}

	/** ファイルが見つからない・また見つかったのを記録する。変わらなければ何もしない。 */
	setMissing(hostId: string, path: string, missing: boolean): void {
		const record = this.get(hostId, path);
		if (record === undefined || (record.missingSince !== undefined) === missing) {
			return;
		}
		if (missing) {
			this._set({ ...record, missingSince: this._now() });
		} else {
			const { missingSince: _missingSince, ...present } = record;
			this._set(present);
		}
	}

	/** 一覧から外す（ファイルには触らない）。 */
	remove(hostId: string, path: string): boolean {
		const key = paradisDocKey(hostId, path);
		const removed = this._records.delete(key);
		if (removed) {
			this._removed.delete(key);
			this._removed.set(key, { hostId, path, at: this._now() });
			if (this._removed.size > PARADIS_DOC_MAX_REMOVALS) {
				const oldest = this._removed.keys().next();
				if (oldest.done !== true) {
					this._removed.delete(oldest.value);
				}
			}
			this._saver.schedule();
			this._onDidChange.fire();
		}
		return removed;
	}

	/** 会話の終わりを見た。その会話が持ち主の資料に終了の印を付ける。 */
	markSessionEnded(session: string): void {
		const at = this._now();
		for (const record of this._records.values()) {
			if (record.owner?.session === session && record.owner.ended === undefined) {
				this._set({ ...record, owner: { ...record.owner, ended: at } });
			}
		}
	}

	/** 会話がまた動いた（再開は同じ ID）。終了の印を外す。 */
	markSessionAlive(session: string): void {
		for (const record of this._records.values()) {
			if (record.owner?.session === session && record.owner.ended !== undefined) {
				this._set(paradisWithDocOwner(record, record.owner));
			}
		}
	}

	/** 待っている書き込みをすぐ行う（終了の前に呼ぶ）。 */
	async flush(): Promise<void> {
		if (this._saver.isScheduled()) {
			this._saver.cancel();
			this._save();
		}
		await this._saving;
	}

	/** 終わり際に、遅らせている書き込みを済ませる。 */
	override dispose(): void {
		if (this._saver.isScheduled()) {
			this._saver.cancel();
			this._save();
		}
		super.dispose();
	}

	private _owner(owner: ParadisDocOwnerCandidate, via: ParadisDocOwnerVia): IParadisDocOwner {
		return { agent: owner.agent, session: owner.session, ...(owner.cwd !== undefined ? { cwd: owner.cwd } : {}), via, since: this._now() };
	}

	private _getOrCreate(hostId: string, path: string, via: ParadisDocRegisteredBy): IParadisDocRecord | undefined {
		const existing = this.get(hostId, path);
		if (existing !== undefined) {
			return existing;
		}
		const kind = paradisDocKind(path);
		return kind === undefined ? undefined : { hostId, path, kind, previousOwners: [], writes: [], registeredBy: via, firstSeen: this._now() };
	}

	private _set(record: IParadisDocRecord): void {
		const key = paradisDocKey(record.hostId, record.path);
		this._records.delete(key);
		this._records.set(key, record);
		this._removed.delete(key);
		if (this._records.size > PARADIS_DOC_MAX_RECORDS) {
			const oldest = [...this._records.entries()].sort((a, b) => paradisDocLastActivity(a[1]) - paradisDocLastActivity(b[1]))[0];
			this._records.delete(oldest[0]);
		}
		this._saver.schedule();
		this._onDidChange.fire();
	}

	private _save(): void {
		// 読み込みの前に書くと、ファイルにあった分を消してしまう
		this._saving = this._saving.then(async () => {
			await this.ready;
			await this._storage.write(paradisSerializeDocLedger(this.all(), [...this._removed.values()]));
		}).catch(error => this._onError(error));
	}
}
