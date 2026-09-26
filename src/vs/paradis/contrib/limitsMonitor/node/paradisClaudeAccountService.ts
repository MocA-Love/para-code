/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude のアカウントと使用量（shared process に1つだけ置く）。
//
// 表示するアカウント:
//  - Para Code に登録したアカウント（認証情報は {@link IParadisClaudeSecretStore}）
//  - いまのログインが登録したどれとも一致しないときは、そのログインも1件として出す（登録ボタン付き）
// 「使用中」は `~/.claude.json` の oauthAccount と照合して決める。Para Code の外で `claude /login`
// しても正しく追従する。
//
// 使用量の取得（設問 Q8）:
//  - どのウィンドウから聞かれても、この1か所が {@link paradisClaudePlanAfterFetch} の決めた時刻に
//    だけ API を呼ぶ。ウィンドウ側は手元の結果をもらうだけ
//  - 誰も見ていない（10 分間どのウィンドウからも聞かれない）間は取りに行かない
//  - 使用中のアカウントは、いまのログインのアクセストークンで聞く。このトークンの更新は持ち主の
//    Claude Code に任せ、Para Code は更新しない（リフレッシュトークンは使い捨てなので、ここで更新すると
//    動いている Claude Code の手元のトークンが無効になる）
//  - 控えのアカウントは保存してあるトークンで聞く。期限が近ければここで更新して保存し直す
//  - 使用中の登録アカウントは、Claude Code が更新して書き戻した新しいトークンを保存し直す
//    （切り替えで控えに回ったとき、古いトークンしか残っていないと使えなくなるため）

import { IntervalTimer } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisClaudeAccountsState, IParadisClaudeStateRequest } from '../common/paradisClaudeAccounts.js';
import {
	PARADIS_CLAUDE_SERVE_TTL_S,
	paradisClaudeFailureBackoffS,
	paradisClaudePlanAfterFetch,
	paradisClaudeRecent429
} from '../common/paradisClaudePollPolicy.js';
import {
	IParadisClaudeIdentity,
	IParadisClaudeUsageWindows,
	paradisClaudeAccessToken,
	paradisClaudeIdentitiesMatch,
	paradisIsClaudeTokenExpiring,
	paradisIsUsableClaudeCredentials
} from '../common/paradisClaudeUsage.js';
import {
	IParadisLimitsAccount,
	ParadisLimitsAccountStatus,
	ParadisLimitsUnavailableReason
} from '../common/paradisLimitsMonitor.js';
import { IParadisClaudeAccountRecord, IParadisClaudeSecretStore, ParadisClaudeAccountRegistry, paradisIsClaudeAccountId } from './paradisClaudeAccountStore.js';
import { ParadisClaudeLiveAuth } from './paradisClaudeLiveAuth.js';
import { IParadisClaudeOAuthClient } from './paradisClaudeOAuthClient.js';

/** 登録したアカウントの、レンダラーへ見せる ID の接頭辞。 */
export const PARADIS_CLAUDE_MANAGED_ID_PREFIX = 'para-claude:';
/** 登録していない、いまのログインの ID。 */
export const PARADIS_CLAUDE_LIVE_ID = 'claude-live';

/** 期限を確かめる間隔（API を呼ぶ間隔ではない。呼ぶかどうかは各アカウントの予定時刻で決まる）。 */
const TICK_INTERVAL_MS = 15_000;
/** 最後に聞かれてからこの間は「誰かが見ている」とみなして取りに行く。 */
const DEMAND_WINDOW_MS = 10 * 60_000;
/** 使用中のアカウントのトークンが切れていたとき、Claude Code が更新するのを待つ間隔。 */
const ACTIVE_EXPIRED_RETRY_S = 300;
/** 403 など、すぐには直らない失敗の待ち時間の下限。 */
const FORBIDDEN_RETRY_S = 600;

export interface IParadisClaudeAccountServiceOptions {
	readonly liveAuth: ParadisClaudeLiveAuth;
	readonly registry: ParadisClaudeAccountRegistry;
	readonly secrets: IParadisClaudeSecretStore;
	readonly oauth: IParadisClaudeOAuthClient;
	readonly logService: ILogService;
	readonly now?: () => number;
	readonly random?: () => number;
}

interface IParadisClaudeUsageState {
	windows?: IParadisClaudeUsageWindows;
	fetchedAt?: number;
	status: ParadisLimitsAccountStatus;
	unavailableReason?: ParadisLimitsUnavailableReason;
	statusDetail?: string;
	intervalS?: number;
	nextPollAt: number;
	last429At?: number;
	backoffUntil?: number;
	failures: number;
}

/** 表示と取得の単位（登録したアカウント、または登録していないいまのログイン）。 */
interface IParadisClaudeTarget {
	/** 使用量の状態の鍵。 */
	readonly key: string;
	readonly record?: IParadisClaudeAccountRecord;
	readonly identity?: IParadisClaudeIdentity;
	readonly active: boolean;
}

function recordIdentity(record: IParadisClaudeAccountRecord): IParadisClaudeIdentity {
	return { accountUuid: record.accountUuid, email: record.email, organizationUuid: record.organizationUuid, organizationName: record.organizationName };
}

export class ParadisClaudeAccountService extends Disposable {

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState: Event<void> = this._onDidChangeState.event;

	protected readonly liveAuth: ParadisClaudeLiveAuth;
	protected readonly secrets: IParadisClaudeSecretStore;
	protected readonly logService: ILogService;
	private readonly registry: ParadisClaudeAccountRegistry;
	private readonly oauth: IParadisClaudeOAuthClient;
	protected readonly now: () => number;
	private readonly random: () => number;

	private records: IParadisClaudeAccountRecord[] | undefined;
	private readonly usage = new Map<string, IParadisClaudeUsageState>();
	/**
	 * 最後に保存・読み出しした認証情報（登録 ID → credentials JSON）。Claude Code が書き戻した
	 * トークンを取り込むかどうかの比較のために、毎回キーチェーンを読みに行かずに済ませる。
	 */
	private readonly knownSecrets = new Map<string, string>();
	private readonly pollTimer = this._register(new IntervalTimer());
	private lastDemandAt = 0;
	private polling: Promise<void> | undefined;
	/** 保存してある認証情報・一覧を書き換える処理を1本に並べる。 */
	private mutationQueue: Promise<unknown> = Promise.resolve();
	protected switching = false;

	constructor(options: IParadisClaudeAccountServiceOptions) {
		super();
		this.liveAuth = options.liveAuth;
		this.registry = options.registry;
		this.secrets = options.secrets;
		this.oauth = options.oauth;
		this.logService = options.logService;
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
	}

	protected fireChange(): void {
		this._onDidChangeState.fire();
	}

	/** 書き換えを1本に並べて実行する。前の処理が失敗しても後ろは動く。 */
	protected serialize<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.mutationQueue.then(fn, fn);
		this.mutationQueue = next.catch(() => undefined);
		return next;
	}

	// ---------- 一覧 ----------

	protected async loadRecords(): Promise<IParadisClaudeAccountRecord[]> {
		if (!this.records) {
			try {
				this.records = await this.registry.load();
			} catch (error) {
				// 壊れた一覧は上書きしない（書き込みは saveRecords だけで、読めたときにしか呼ばない）。
				this.logService.error('[ParadisClaudeAccounts] failed to read the account list', error);
				return [];
			}
		}
		return this.records;
	}

	protected async saveRecords(records: IParadisClaudeAccountRecord[]): Promise<void> {
		await this.registry.save(records);
		this.records = records;
	}

	protected async readSecret(accountId: string): Promise<string | undefined> {
		const value = await this.secrets.read(accountId);
		if (value !== undefined) {
			this.knownSecrets.set(accountId, value);
		} else {
			this.knownSecrets.delete(accountId);
		}
		return value;
	}

	protected async writeSecret(accountId: string, credentialsJson: string): Promise<void> {
		await this.secrets.write(accountId, credentialsJson);
		this.knownSecrets.set(accountId, credentialsJson);
	}

	protected forgetSecret(accountId: string): void {
		this.knownSecrets.delete(accountId);
	}

	/** いまのログインと登録済みアカウントから、表示と取得の単位を組み立てる。 */
	protected async resolveTargets(): Promise<IParadisClaudeTarget[]> {
		const records = await this.loadRecords();
		const liveIdentity = await this.liveAuth.readIdentity();
		const targets: IParadisClaudeTarget[] = [];
		const activeRecord = liveIdentity ? records.find(record => paradisClaudeIdentitiesMatch(recordIdentity(record), liveIdentity)) : undefined;
		if (liveIdentity && !activeRecord) {
			targets.push({ key: `live:${liveIdentity.accountUuid ?? liveIdentity.email}`, identity: liveIdentity, active: true });
		}
		for (const record of records) {
			targets.push({ key: record.id, record, identity: recordIdentity(record), active: record === activeRecord });
		}
		return targets;
	}

	// ---------- 状態 ----------

	async getState(request: IParadisClaudeStateRequest | undefined): Promise<IParadisClaudeAccountsState> {
		this.markDemand();
		const targets = await this.resolveTargets();
		const now = this.now();
		let due = false;
		for (const target of targets) {
			const state = this.usage.get(target.key);
			if (!state) {
				due = true;
				continue;
			}
			// 手動の更新でも、180 秒以内の結果は取り直さない（API の回数を守る）。429 で待っている間も同じ。
			if (request?.refresh && state.nextPollAt !== Number.POSITIVE_INFINITY && (state.fetchedAt === undefined || now - state.fetchedAt > PARADIS_CLAUDE_SERVE_TTL_S * 1000) && !(state.backoffUntil !== undefined && now < state.backoffUntil)) {
				state.nextPollAt = now;
			}
			if (now >= state.nextPollAt) {
				due = true;
			}
		}
		if (due) {
			void this.pollDue();
		}
		return this.buildState(targets);
	}

	private buildState(targets: readonly IParadisClaudeTarget[]): IParadisClaudeAccountsState {
		let oldestFetchedAt: number | undefined;
		const accounts: IParadisLimitsAccount[] = targets.map(target => {
			const state = this.usage.get(target.key);
			if (state?.fetchedAt !== undefined && (oldestFetchedAt === undefined || state.fetchedAt < oldestFetchedAt)) {
				oldestFetchedAt = state.fetchedAt;
			}
			return {
				provider: 'claude',
				id: target.record ? `${PARADIS_CLAUDE_MANAGED_ID_PREFIX}${target.record.id}` : PARADIS_CLAUDE_LIVE_ID,
				email: target.record?.email ?? target.identity?.email,
				organizationName: target.record?.organizationName ?? target.identity?.organizationName,
				active: target.active,
				managed: target.record !== undefined,
				registrable: target.record === undefined,
				status: state?.status ?? 'unavailable',
				unavailableReason: state ? state.unavailableReason : 'not_fetched',
				statusDetail: state?.statusDetail,
				fiveHour: state?.windows?.fiveHour,
				sevenDay: state?.windows?.sevenDay,
				scoped: state?.windows?.scoped,
				fetchedAt: state?.fetchedAt,
			};
		});
		return { claude: { accounts }, oldestFetchedAt, switching: this.switching };
	}

	private markDemand(): void {
		const wasIdle = this.now() - this.lastDemandAt > DEMAND_WINDOW_MS;
		this.lastDemandAt = this.now();
		if (wasIdle) {
			this.pollTimer.cancelAndSet(() => this.onTick(), TICK_INTERVAL_MS);
		}
	}

	private onTick(): void {
		if (this.now() - this.lastDemandAt > DEMAND_WINDOW_MS) {
			// 誰も見ていない。次に聞かれたときに再開する。
			this.pollTimer.cancel();
			return;
		}
		void this.pollDue();
	}

	/** 予定時刻が来たアカウントを順に取りに行く。同時に2本は走らせない（テストからも呼ぶ）。 */
	pollDue(): Promise<void> {
		if (!this.polling) {
			this.polling = this.doPollDue().finally(() => { this.polling = undefined; });
		}
		return this.polling;
	}

	private async doPollDue(): Promise<void> {
		const targets = await this.resolveTargets();
		const keys = new Set(targets.map(target => target.key));
		for (const key of [...this.usage.keys()]) {
			if (!keys.has(key)) {
				this.usage.delete(key);
			}
		}
		let changed = false;
		for (const target of targets) {
			if (this._store.isDisposed) {
				return;
			}
			const state = this.usage.get(target.key) ?? { status: 'unavailable', unavailableReason: 'not_fetched', nextPollAt: 0, failures: 0 } satisfies IParadisClaudeUsageState;
			this.usage.set(target.key, state);
			const now = this.now();
			if (now < state.nextPollAt || (state.backoffUntil !== undefined && now < state.backoffUntil)) {
				continue;
			}
			try {
				await this.fetchTarget(target, state);
			} catch (error) {
				this.logService.warn(`[ParadisClaudeAccounts] usage fetch failed unexpectedly: ${(error as Error).message}`);
				this.recordFailure(state, undefined, false, 'unexpected failure');
			}
			changed = true;
		}
		if (changed) {
			this.fireChange();
		}
	}

	/** 取得に失敗した。前に取れた値があればそれを見せ続ける。 */
	private recordFailure(state: IParadisClaudeUsageState, retryAfterS: number | undefined, rateLimited: boolean, detail: string): void {
		const now = this.now();
		state.failures++;
		if (rateLimited) {
			state.last429At = now;
		}
		const waitS = paradisClaudeFailureBackoffS(state.failures, retryAfterS, rateLimited);
		state.backoffUntil = now + waitS * 1000;
		state.nextPollAt = state.backoffUntil;
		if (state.windows) {
			return;
		}
		if (rateLimited) {
			state.status = 'unavailable';
			state.unavailableReason = 'rate_limited';
			state.statusDetail = undefined;
		} else {
			state.status = 'error';
			state.unavailableReason = undefined;
			state.statusDetail = detail;
		}
	}

	private setStatus(state: IParadisClaudeUsageState, status: ParadisLimitsAccountStatus, retryS: number, unavailableReason?: ParadisLimitsUnavailableReason, statusDetail?: string): void {
		state.status = status;
		state.unavailableReason = unavailableReason;
		state.statusDetail = statusDetail;
		state.windows = undefined;
		state.fetchedAt = undefined;
		state.nextPollAt = retryS === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : this.now() + retryS * 1000;
	}

	private async fetchTarget(target: IParadisClaudeTarget, state: IParadisClaudeUsageState): Promise<void> {
		let credentials: string | undefined;
		if (target.active) {
			const live = await this.liveAuth.readCredentials();
			if (!live.value) {
				if (live.keychainUnavailable) {
					this.setStatus(state, 'unavailable', ACTIVE_EXPIRED_RETRY_S, 'keychain_unavailable');
				} else {
					this.setStatus(state, 'no_credentials', ACTIVE_EXPIRED_RETRY_S);
				}
				return;
			}
			if (!paradisClaudeAccessToken(live.value)) {
				// OAuth でない（API キーで使っている）。使用量はサブスクリプションにしか無い。
				this.setStatus(state, 'unavailable', ACTIVE_EXPIRED_RETRY_S * 2, 'api_key');
				return;
			}
			if (target.record) {
				await this.adoptLiveCredentials(target.record, live.value);
			}
			credentials = live.value;
		} else if (target.record) {
			try {
				credentials = await this.readSecret(target.record.id);
			} catch {
				this.setStatus(state, 'unavailable', ACTIVE_EXPIRED_RETRY_S, 'keychain_unavailable');
				return;
			}
			if (!credentials || !paradisClaudeAccessToken(credentials)) {
				// 再ログインするまで取りに行かない（一覧を書き換えたときに状態ごと作り直す）。
				this.setStatus(state, 'no_credentials', Number.POSITIVE_INFINITY);
				return;
			}
			if (paradisIsClaudeTokenExpiring(credentials, this.now())) {
				const refreshed = await this.refreshStoredCredentials(target.record);
				if (refreshed === 'dead') {
					this.setStatus(state, 'relogin_required', Number.POSITIVE_INFINITY);
					return;
				}
				credentials = refreshed ?? credentials;
			}
		}
		const accessToken = paradisClaudeAccessToken(credentials);
		if (!accessToken) {
			this.setStatus(state, 'no_credentials', ACTIVE_EXPIRED_RETRY_S);
			return;
		}

		let result = await this.oauth.fetchUsage(accessToken);
		if (result.kind === 'http' && result.status === 401 && !target.active && target.record) {
			// 期限より前に失効していた。1回だけ更新して取り直す。
			const refreshed = await this.refreshStoredCredentials(target.record, true);
			if (refreshed === 'dead') {
				this.setStatus(state, 'relogin_required', Number.POSITIVE_INFINITY);
				return;
			}
			const retryToken = paradisClaudeAccessToken(refreshed);
			if (retryToken) {
				result = await this.oauth.fetchUsage(retryToken);
			}
		}

		const now = this.now();
		switch (result.kind) {
			case 'ok': {
				const recent429 = paradisClaudeRecent429(state.last429At, state.backoffUntil, now);
				const plan = paradisClaudePlanAfterFetch({
					previousIntervalS: state.intervalS,
					previousUsage: state.windows,
					newUsage: result.usage,
					isActive: target.active,
					recent429,
					now,
					random: this.random,
				});
				state.windows = result.usage;
				state.fetchedAt = now;
				state.status = 'ok';
				state.unavailableReason = undefined;
				state.statusDetail = undefined;
				state.failures = 0;
				state.backoffUntil = undefined;
				state.intervalS = plan.intervalS;
				state.nextPollAt = plan.nextPollAt;
				return;
			}
			case 'http':
				if (result.status === 429) {
					this.recordFailure(state, result.retryAfterS, true, 'usage API rate limited');
				} else if (result.status === 401) {
					if (target.active) {
						// 使用中のアカウントのトークンは Claude Code が更新する。こちらは待つだけ。
						this.setStatus(state, 'refreshing', ACTIVE_EXPIRED_RETRY_S);
					} else {
						this.setStatus(state, 'relogin_required', Number.POSITIVE_INFINITY);
					}
				} else if (result.status === 403) {
					this.recordFailure(state, FORBIDDEN_RETRY_S, false, 'usage API returned 403');
				} else {
					this.recordFailure(state, undefined, false, `usage API returned ${result.status}`);
				}
				return;
			case 'network':
				this.recordFailure(state, undefined, false, 'could not reach the usage API');
				return;
		}
	}

	/**
	 * 使用中の登録アカウントについて、Claude Code が更新して書き戻したトークンを保存し直す。
	 * 身元は oauthAccount で確かめ済み（使用中＝身元が一致）。トークンの欄が空になったもの
	 * （更新を拒否された Claude Code が消した跡）は保存しない。
	 */
	protected async adoptLiveCredentials(record: IParadisClaudeAccountRecord, liveCredentials: string): Promise<void> {
		if (!paradisIsUsableClaudeCredentials(liveCredentials) || this.knownSecrets.get(record.id) === liveCredentials) {
			return;
		}
		await this.serialize(async () => {
			try {
				const stored = await this.readSecret(record.id);
				if (stored !== liveCredentials) {
					await this.writeSecret(record.id, liveCredentials);
				}
			} catch (error) {
				this.logService.warn(`[ParadisClaudeAccounts] could not save the refreshed Claude login: ${(error as Error).message}`);
			}
		});
	}

	/**
	 * 控えのアカウントのトークンを更新して保存する。
	 * @returns 更新後の credentials JSON。更新しなかった・一時的に失敗したときは undefined。
	 * リフレッシュトークンが拒否されたときは 'dead'。
	 */
	protected refreshStoredCredentials(record: IParadisClaudeAccountRecord, force = false): Promise<string | 'dead' | undefined> {
		return this.serialize(async () => {
			// 並んでいる間に別の処理が更新したかもしれないので、保存場所から読み直す。
			const current = await this.readSecret(record.id);
			if (!current) {
				return 'dead';
			}
			if (!force && !paradisIsClaudeTokenExpiring(current, this.now())) {
				return current;
			}
			const result = await this.oauth.refresh(current);
			switch (result.kind) {
				case 'ok':
					try {
						await this.writeSecret(record.id, result.credentialsJson);
					} catch (error) {
						// 回った後のトークンを保存できなかった。メモリには残して次の機会に使う。
						this.knownSecrets.set(record.id, result.credentialsJson);
						this.logService.error(`[ParadisClaudeAccounts] refreshed a Claude token but could not save it: ${(error as Error).message}`);
					}
					return result.credentialsJson;
				case 'invalid_grant':
				case 'no_refresh_token':
					return 'dead';
				case 'transient':
					return undefined;
			}
		});
	}

	/** 一覧を書き換えた後に、そのアカウントの状態を捨てて次の機会に取り直す。 */
	protected resetUsage(key: string): void {
		this.usage.delete(key);
	}

	/** 切り替えなどで使用中が入れ替わった後、全アカウントをすぐ取り直す（180 秒以内のものは除く）。 */
	protected scheduleSoon(): void {
		const now = this.now();
		for (const state of this.usage.values()) {
			if (state.nextPollAt !== Number.POSITIVE_INFINITY && (state.fetchedAt === undefined || now - state.fetchedAt > PARADIS_CLAUDE_SERVE_TTL_S * 1000) && !(state.backoffUntil !== undefined && now < state.backoffUntil)) {
				state.nextPollAt = now;
			}
		}
		void this.pollDue();
	}

	/** レンダラーから来た ID を登録 ID にする。形が違えば undefined。 */
	static parseManagedId(id: unknown): string | undefined {
		if (typeof id !== 'string' || !id.startsWith(PARADIS_CLAUDE_MANAGED_ID_PREFIX)) {
			return undefined;
		}
		const accountId = id.slice(PARADIS_CLAUDE_MANAGED_ID_PREFIX.length);
		return paradisIsClaudeAccountId(accountId) ? accountId : undefined;
	}
}

export class ParadisClaudeAccountsChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisClaudeAccountService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		if (event === 'onDidChangeState') {
			return this.service.onDidChangeState as Event<unknown> as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'getState': {
				const request = args[0] && typeof args[0] === 'object' ? { refresh: (args[0] as IParadisClaudeStateRequest).refresh === true } : undefined;
				return this.service.getState(request) as Promise<T>;
			}
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}
