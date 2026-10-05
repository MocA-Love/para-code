/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// PC からリレーへのプッシュの依頼（push-notify）を、リレーが受理するまで持っておく outbox（設計 2.6・4 章 #6）。
//
// 以前は依頼をリレーへのソケットが開いているときに 1 回だけ送り、閉じていれば黙って捨てていた。通知のフレームは
// 「プッシュで鳴らすから重ねるな」（quiet: 'pushed'）で送っているので、捨てると誰も鳴らさない。
//
// - 依頼には依頼 ID（requestId）を付け、ディスクに書いてから送る（最大 50 件・最長 10 分）
// - リレーが push-ack を返したら外す（リレーは依頼を書き留めてから返す。同じ ID の送り直しは APNs へ送らない）
// - まだ 1 度も送れていない依頼は、ソケットが開いたら送る
// - 送ったのに ack が来ない依頼を送り直すのは、このリレーが push-ack を返すと分かっているときだけ
//   （返さない旧リレーへ送り直すと、同じ通知が二重に鳴る）。分かるのは一度でも push-ack を受けた後
// - 登録し直した（deviceId が変わった）後は、古い登録宛ての依頼を捨てる

/** 依頼 1 件（outbox のファイルの `entries`）。 */
export interface IParadisPushOutboxEntry {
	readonly requestId: string;
	/** 依頼先の登録（リレー上の deviceId）。 */
	readonly deviceId: string;
	readonly mobileId: string;
	/** 通知鍵で封緘した本文（base64url）。リレーは開けない。 */
	readonly payload: string;
	readonly collapseId?: string;
	readonly threadId?: string;
	/** 積んだ時刻（epoch ms）。 */
	readonly since: number;
	/** 送った回数。 */
	readonly sends: number;
	/** 最後に送った時刻（epoch ms。送っていなければ 0）。 */
	readonly lastSentAt: number;
}

/** リレーへ送る push-notify の中身。 */
export interface IParadisPushRequest {
	readonly mobileId: string;
	readonly payload: string;
	readonly collapseId?: string;
	readonly threadId?: string;
}

export const PARADIS_PUSH_OUTBOX_LIMIT = 50;
export const PARADIS_PUSH_OUTBOX_MAX_AGE_MS = 10 * 60_000;
/** 送ったのに ack が来ない依頼を送り直すまでの時間。 */
export const PARADIS_PUSH_OUTBOX_RESEND_AFTER_MS = 20_000;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

interface IParadisPushOutboxFile {
	readonly relayAcks: boolean;
	readonly entries: readonly IParadisPushOutboxEntry[];
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** ファイルから読んだ値を検証する（形の合わない項目は捨てる）。 */
export function paradisParsePushOutbox(raw: string | undefined): IParadisPushOutboxFile {
	let parsed: unknown;
	try {
		parsed = raw === undefined ? undefined : JSON.parse(raw);
	} catch {
		parsed = undefined;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return { relayAcks: false, entries: [] };
	}
	const record = parsed as Record<string, unknown>;
	const entries: IParadisPushOutboxEntry[] = [];
	for (const item of Array.isArray(record.entries) ? record.entries : []) {
		if (typeof item !== 'object' || item === null) {
			continue;
		}
		const entry = item as Record<string, unknown>;
		if (typeof entry.requestId !== 'string' || !REQUEST_ID_PATTERN.test(entry.requestId)
			|| typeof entry.deviceId !== 'string' || entry.deviceId.length === 0
			|| typeof entry.mobileId !== 'string' || entry.mobileId.length === 0
			|| typeof entry.payload !== 'string' || entry.payload.length === 0
			|| typeof entry.since !== 'number' || !Number.isFinite(entry.since)) {
			continue;
		}
		const collapseId = optionalString(entry.collapseId);
		const threadId = optionalString(entry.threadId);
		entries.push({
			requestId: entry.requestId,
			deviceId: entry.deviceId,
			mobileId: entry.mobileId,
			payload: entry.payload,
			...(collapseId !== undefined ? { collapseId } : {}),
			...(threadId !== undefined ? { threadId } : {}),
			since: entry.since,
			sends: typeof entry.sends === 'number' && Number.isInteger(entry.sends) && entry.sends >= 0 ? entry.sends : 0,
			lastSentAt: typeof entry.lastSentAt === 'number' && Number.isFinite(entry.lastSentAt) ? entry.lastSentAt : 0,
		});
	}
	return { relayAcks: record.relayAcks === true, entries: entries.slice(-PARADIS_PUSH_OUTBOX_LIMIT) };
}

/** 期限切れ・今の登録ではない依頼を外し、件数を上限に収める（古いものから捨てる）。 */
export function paradisPrunePushOutbox(entries: readonly IParadisPushOutboxEntry[], deviceId: string | undefined, now: number): IParadisPushOutboxEntry[] {
	return entries
		.filter(entry => entry.deviceId === deviceId && now - entry.since < PARADIS_PUSH_OUTBOX_MAX_AGE_MS)
		.slice(-PARADIS_PUSH_OUTBOX_LIMIT);
}

/** 今送ってよい依頼。まだ送っていないもの、または ack を返すと分かっているリレーへ送ってから時間が経ったもの。 */
export function paradisSendablePushes(entries: readonly IParadisPushOutboxEntry[], relayAcks: boolean, now: number): IParadisPushOutboxEntry[] {
	return entries.filter(entry => entry.sends === 0 || (relayAcks && now - entry.lastSentAt >= PARADIS_PUSH_OUTBOX_RESEND_AFTER_MS));
}

export interface IParadisPushOutboxHost {
	/** outbox のファイルを読む（無ければ undefined）。 */
	read(): Promise<string | undefined>;
	/** outbox のファイルを書く（壊れない書き方で）。 */
	write(content: string): Promise<void>;
	/** 今の登録（deviceId）。未登録なら undefined。 */
	deviceId(): string | undefined;
	/** リレーへ push-notify を送る。ソケットが開いていて送れたら true。 */
	send(request: IParadisPushRequest & { readonly requestId: string }): boolean;
	/** 依頼 ID を作る（base64url 8〜64 文字）。 */
	newRequestId(): string;
	warn(message: string, error?: unknown): void;
	now?(): number;
	setTimeout?(handler: () => void, ms: number): unknown;
	clearTimeout?(handle: unknown): void;
}

/** プッシュの依頼の outbox。ファイルの読み書きと送信は host に任せる。 */
export class ParadisPushOutbox {
	private entries: IParadisPushOutboxEntry[] = [];
	private relayAcks = false;
	private readonly loaded: Promise<void>;
	private writeChain: Promise<void> = Promise.resolve();
	private timer: unknown;
	private disposed = false;

	constructor(private readonly host: IParadisPushOutboxHost) {
		this.loaded = this.host.read().then(raw => {
			const file = paradisParsePushOutbox(raw);
			// 読む前に積まれた依頼（あれば）を後ろに残す
			this.entries = [...file.entries, ...this.entries];
			this.relayAcks = this.relayAcks || file.relayAcks;
		}, error => this.host.warn('[paradisPushOutbox] failed to read the outbox', error));
	}

	/** テスト用: 今持っている依頼。 */
	get pending(): readonly IParadisPushOutboxEntry[] {
		return this.entries;
	}

	/** 依頼を積み、ディスクに書いてから送る。登録が無ければ何もしない。 */
	async submit(request: IParadisPushRequest): Promise<void> {
		await this.loaded;
		const deviceId = this.host.deviceId();
		if (deviceId === undefined || this.disposed) {
			return;
		}
		const now = this.now();
		this.entries.push({
			requestId: this.host.newRequestId(),
			deviceId,
			mobileId: request.mobileId,
			payload: request.payload,
			...(request.collapseId !== undefined ? { collapseId: request.collapseId } : {}),
			...(request.threadId !== undefined ? { threadId: request.threadId } : {}),
			since: now,
			sends: 0,
			lastSentAt: 0,
		});
		await this.persist();
		this.flush();
	}

	/** リレーが受理した。outbox から外す（このリレーは ack を返すと覚える）。 */
	async ack(requestId: string): Promise<void> {
		await this.loaded;
		const before = this.entries.length;
		this.entries = this.entries.filter(entry => entry.requestId !== requestId);
		const learned = !this.relayAcks;
		this.relayAcks = true;
		if (before !== this.entries.length || learned) {
			await this.persist();
		}
	}

	/** 送ってよい依頼を送る（リレーへつながったとき・送り直しの時刻）。 */
	flush(): void {
		void this.loaded.then(() => this.flushNow());
	}

	dispose(): void {
		this.disposed = true;
		this.clearTimer();
	}

	private flushNow(): void {
		if (this.disposed) {
			return;
		}
		const now = this.now();
		const before = this.entries.length;
		const kept = paradisPrunePushOutbox(this.entries, this.host.deviceId(), now);
		if (kept.length !== before && this.relayAcks) {
			// push-ack を返さない旧リレーでは、送った依頼が毎回ここで期限切れになるので記録しない
			this.host.warn(`[paradisPushOutbox] dropped ${before - kept.length} push request(s) the relay did not accept in time`);
		}
		const sendable = new Set(paradisSendablePushes(kept, this.relayAcks, now).map(entry => entry.requestId));
		let changed = kept.length !== before;
		this.entries = kept.map(entry => {
			if (!sendable.has(entry.requestId)) {
				return entry;
			}
			const sent = this.host.send({
				requestId: entry.requestId,
				mobileId: entry.mobileId,
				payload: entry.payload,
				...(entry.collapseId !== undefined ? { collapseId: entry.collapseId } : {}),
				...(entry.threadId !== undefined ? { threadId: entry.threadId } : {}),
			});
			if (!sent) {
				return entry;
			}
			changed = true;
			return { ...entry, sends: entry.sends + 1, lastSentAt: now };
		});
		if (changed) {
			void this.persist();
		}
		this.schedule();
	}

	/** 次の送り直し（または期限切れの掃除）の時刻にタイマーを張る。 */
	private schedule(): void {
		this.clearTimer();
		if (this.disposed || this.entries.length === 0) {
			return;
		}
		const now = this.now();
		const times = this.entries.map(entry => {
			const expiry = entry.since + PARADIS_PUSH_OUTBOX_MAX_AGE_MS;
			return entry.sends > 0 && this.relayAcks ? Math.min(expiry, entry.lastSentAt + PARADIS_PUSH_OUTBOX_RESEND_AFTER_MS) : expiry;
		});
		const delay = Math.max(1_000, Math.min(...times) - now);
		this.timer = (this.host.setTimeout ?? setTimeout)(() => {
			this.timer = undefined;
			this.flushNow();
		}, delay);
	}

	private clearTimer(): void {
		if (this.timer !== undefined) {
			(this.host.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.timer);
			this.timer = undefined;
		}
	}

	private persist(): Promise<void> {
		const content = JSON.stringify({ relayAcks: this.relayAcks, entries: this.entries } satisfies IParadisPushOutboxFile);
		const run = this.writeChain.then(() => this.host.write(content)).catch(error => this.host.warn('[paradisPushOutbox] failed to write the outbox', error));
		this.writeChain = run;
		return run;
	}

	private now(): number {
		return (this.host.now ?? Date.now)();
	}
}
