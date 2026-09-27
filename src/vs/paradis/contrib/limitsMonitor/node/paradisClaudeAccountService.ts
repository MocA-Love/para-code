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
// 使用量の取得（claude-swap と同じ適応型の間隔）:
//  - どのウィンドウから聞かれても、この1か所が {@link paradisClaudePlanAfterFetch} の決めた時刻に
//    だけ API を呼ぶ。ウィンドウ側は手元の結果をもらうだけ
//  - 誰も見ていない（10 分間どのウィンドウからも聞かれない）間は取りに行かない
//  - 使用中のアカウントは、いまのログインのアクセストークンで聞く。このトークンの更新は持ち主の
//    Claude Code に任せ、Para Code は更新しない（リフレッシュトークンは使い捨てなので、ここで更新すると
//    動いている Claude Code の手元のトークンが無効になる）
//  - 控えのアカウントは保存してあるトークンで聞く。期限が近ければここで更新して保存し直す
//  - 使用中の登録アカウントは、Claude Code が更新して書き戻した新しいトークンを保存し直す
//    （切り替えで控えに回ったとき、古いトークンしか残っていないと使えなくなるため）。取り込む前に
//    「身元 → 認証情報 → 身元」の順に読み直して一致を確かめ、さらにトークンの持ち主を
//    `/api/oauth/profile` で確かめる。切り替えの最中と直後の1周は取り込まない。別のアカウントの
//    トークンを保存すると、そのアカウントの唯一のリフレッシュトークンを失うため
//  - 保存するのは credentials JSON の `claudeAiOauth` だけ。`mcpOAuth` などアカウントと関係の無い
//    秘密は保存も書き戻しもしない
//
// claude-swap (cswap) からの移行（cswap の撤去後は、アカウントを再ログインで登録し直してもらう、
// という決定）: cswap の一覧（sequence.json）を読むだけで、書き込みも認証情報の取り込みもしない。
// Para Code にまだ登録していないアカウントを並べて、登録し直しを案内する。

import * as fs from 'fs';
import * as os from 'os';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import * as path from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisClaudeAccountsState, IParadisClaudeRegisterResult, IParadisClaudeStateRequest, IParadisClaudeSwitchResult, ParadisClaudeSetupErrorCode } from '../common/paradisClaudeAccounts.js';
import {
	PARADIS_CLAUDE_RECENT_429_WINDOW_S,
	PARADIS_CLAUDE_SERVE_TTL_S,
	paradisClaudeFailureBackoffS,
	paradisClaudePlanAfterFetch,
	paradisClaudeRecent429Anchor
} from '../common/paradisClaudePollPolicy.js';
import {
	IParadisClaudeIdentity,
	IParadisClaudeUsageWindows,
	paradisClaudeAccessToken,
	paradisClaudeIdentitiesMatch,
	paradisClaudeIdentityFromOauthAccount,
	paradisClaudeOAuthOnly,
	paradisClaudeRefreshToken,
	paradisIsClaudeTokenExpiring,
	paradisIsUsableClaudeCredentials,
	paradisParseClaudeOAuthBlob
} from '../common/paradisClaudeUsage.js';
import {
	IParadisLimitsAccount,
	IParadisLimitsLegacyAccount,
	IParadisLimitsSetupHandle,
	IParadisLimitsSetupState,
	ParadisLimitsAccountStatus,
	ParadisLimitsUnavailableReason
} from '../common/paradisLimitsMonitor.js';
import { IParadisClaudeAccountRecord, IParadisClaudeSecretStore, ParadisClaudeAccountRegistry, paradisIsClaudeAccountId } from './paradisClaudeAccountStore.js';
import { ParadisKeychainError } from './paradisClaudeKeychain.js';
import { ParadisClaudeConfigUnreadableError, ParadisClaudeLiveAuth, ParadisClaudeLockTimeoutError } from './paradisClaudeLiveAuth.js';
import { IParadisClaudeLoginRunner, paradisOauthAccountFromClaudeStatus } from './paradisClaudeLogin.js';
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
/** 使用量を取っている間にいまのログインが変わったとき、取り直すまでの秒数。 */
const LOGIN_CHANGED_RETRY_S = 60;
/** 終わったログインの状態を残しておく時間（ダイアログの最後の問い合わせ用）。 */
const SETUP_RETENTION_MS = 5 * 60_000;
/** アカウント追加の一時ディレクトリの名前の頭。 */
const LOGIN_DIR_PREFIX = 'paradis-claude-login-';
/**
 * 前回の終了で消し損ねた一時ディレクトリとみなす古さ。ログインを待つ上限（10 分）より十分長くして、
 * 同じ PC で動いている別の Para Code（開発版と製品版など）がログイン中のものは消さない。
 */
const STALE_LOGIN_DIR_MS = 30 * 60_000;
/** claude-swap と同じトークンの系列を持っている控えのアカウントを取りに行く間隔。 */
const SHARED_LINEAGE_RETRY_S = 600;
/** いまのログインの持ち主を確かめられなかった後、定期の取り込みで確かめ直すまでの間。 */
const ADOPT_RETRY_AFTER_MS = 10 * 60_000;

/** {@link ParadisClaudeAccountService.refreshStoredCredentialsNow} の結果。 */
type ParadisClaudeRefreshOutcome =
	/** 更新後（または更新が要らなかった）の JSON。 */
	| string
	/** リフレッシュトークンが拒否された。再ログインでしか直らない。 */
	| 'dead'
	/** いまのログインと同じトークンの系列なので更新しなかった（使用中を控えと取り違えている）。 */
	| 'live_lineage'
	/** 一時的に失敗した・切り替えを挟んだので更新しなかった。 */
	| undefined;

/** ダイアログが日本語の説明に置き換える失敗（メッセージは種類の値そのもの）。 */
function paradisClaudeSetupError(code: ParadisClaudeSetupErrorCode): Error {
	return new Error(code);
}


export interface IParadisClaudeAccountServiceOptions {
	readonly liveAuth: ParadisClaudeLiveAuth;
	readonly registry: ParadisClaudeAccountRegistry;
	readonly secrets: IParadisClaudeSecretStore;
	readonly oauth: IParadisClaudeOAuthClient;
	readonly logService: ILogService;
	/** アカウント追加で `claude auth login` を動かす。無ければ追加・再ログインはできない。 */
	readonly loginRunner?: IParadisClaudeLoginRunner;
	/** アカウント追加の一時ディレクトリを作る場所（既定は OS の一時フォルダ）。 */
	readonly tmpdir?: string;
	/** claude-swap のデータのフォルダの候補（sequence.json を読むだけ）。 */
	readonly legacyCswapDirs?: readonly string[];
	readonly now?: () => number;
	readonly random?: () => number;
}

interface IParadisClaudeSetupSession {
	readonly id: string;
	state: IParadisLimitsSetupState;
	readonly abort: AbortController;
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
	/** 「最近 429 を受けた」を数える起点。成功しても消さない。 */
	recent429Anchor?: number;
	backoffUntil?: number;
	failures: number;
	/** この状態を作ったときに使用中だったか。変わったら状態を作り直す。 */
	active: boolean;
	/** 直近 1 時間に API を呼んだ時刻（緊急の間隔の回数予算に使う）。 */
	fetchTimes: number[];
}

/** 1回のポーリングの間の前提。 */
interface IParadisClaudePollContext {
	/** 使用中のアカウントのトークンを取り込んでよいか（切り替えの直後の1周は取り込まない）。 */
	readonly adoptAllowed: boolean;
	/** 始めたときの切り替えの世代。途中で切り替えがあれば取り込まない。 */
	readonly epoch: number;
	/** claude-swap にも登録されているアカウント。 */
	readonly legacy: readonly IParadisClaudeLegacyEntry[];
}

/** 身元を確かめた、いまのログインの認証情報。 */
interface IParadisClaudeVerifiedLive {
	/** `claudeAiOauth` だけの JSON。 */
	readonly oauthOnly: string;
}

/** claude-swap の一覧の1件。 */
interface IParadisClaudeLegacyEntry extends IParadisLimitsLegacyAccount {
	readonly organizationUuid?: string;
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
	private readonly loginRunner: IParadisClaudeLoginRunner | undefined;
	private readonly tmpdir: string;
	protected readonly now: () => number;
	private readonly random: () => number;
	private readonly setupSessions = new Map<string, IParadisClaudeSetupSession>();
	private readonly legacyCswapDirs: readonly string[];
	private legacyCache: { readonly path: string; readonly mtimeMs: number; readonly accounts: readonly IParadisClaudeLegacyEntry[] } | undefined;
	private readonly setupCleanupTimers = new Set<ReturnType<typeof setTimeout>>();

	private records: IParadisClaudeAccountRecord[] | undefined;
	/** 一覧を読めなかった（壊れている・一時的な読み取りの失敗）。この間は一覧を書き換えない。 */
	private recordsUnreadable = false;
	private readonly usage = new Map<string, IParadisClaudeUsageState>();
	/**
	 * 最後に保存・読み出しした認証情報（登録 ID → `claudeAiOauth` だけの JSON）。Claude Code が
	 * 書き戻したトークンを取り込むかどうかの比較のために、毎回キーチェーンを読みに行かずに済ませる。
	 */
	private readonly knownSecrets = new Map<string, string>();
	/**
	 * 更新したが保存できなかったトークン（登録 ID → JSON）。リフレッシュトークンは使い捨てなので、
	 * 保存場所の古い値へ戻すと次の更新が invalid_grant になる。読むときはこちらを優先し、保存し直す。
	 */
	private readonly pendingSecrets = new Map<string, string>();
	private readonly pollTimer = this._register(new IntervalTimer());
	private lastDemandAt = 0;
	private polling: Promise<void> | undefined;
	/** 保存してある認証情報・一覧を書き換える処理を1本に並べる。 */
	private mutationQueue: Promise<unknown> = Promise.resolve();
	protected switching = false;
	/** 切り替えを始めるたび・終えるたびに増やす。取り込みの前後で変わっていたら取り込まない。 */
	private switchEpoch = 0;
	/** 切り替えの直後、トークンを取り込まないポーリングの残りの周回。 */
	private skipAdoptPasses = 0;
	/** 進行中のアカウント追加（キャンセルした後も、後片付けが終わるまで次を始めない）。 */
	private loginInFlight: Promise<unknown> | undefined;
	/** 定期の取り込みで持ち主を確かめられなかったアカウント → 次に確かめる時刻。 */
	private readonly adoptRetryAfter = new Map<string, number>();

	constructor(options: IParadisClaudeAccountServiceOptions) {
		super();
		this.liveAuth = options.liveAuth;
		this.registry = options.registry;
		this.secrets = options.secrets;
		this.oauth = options.oauth;
		this.logService = options.logService;
		this.loginRunner = options.loginRunner;
		this.tmpdir = options.tmpdir ?? os.tmpdir();
		this.legacyCswapDirs = options.legacyCswapDirs ?? [];
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
		// 前回の終了で消し損ねたアカウント追加の一時ディレクトリを、起動のたびに（パネルを開かなくても）消す。
		if (this.loginRunner) {
			void this.cleanStaleLogins();
		}
		this._register(toDisposable(() => {
			for (const session of this.setupSessions.values()) {
				session.abort.abort();
			}
			this.setupSessions.clear();
			for (const timer of this.setupCleanupTimers) {
				clearTimeout(timer);
			}
			this.setupCleanupTimers.clear();
		}));
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

	/** 表示用の一覧。読めなければ空で返す（書き換えには {@link loadRecordsForWrite} を使う）。 */
	protected async loadRecords(): Promise<IParadisClaudeAccountRecord[]> {
		try {
			return await this.loadRecordsForWrite();
		} catch {
			return [];
		}
	}

	/**
	 * 書き換えるための一覧。読めないときは投げる。空の一覧に足して保存すると、既存の登録を
	 * 一覧から全部消してしまう（認証情報だけが孤児として残る）ため。
	 */
	protected async loadRecordsForWrite(): Promise<IParadisClaudeAccountRecord[]> {
		if (!this.records) {
			try {
				this.records = await this.registry.load();
				this.recordsUnreadable = false;
			} catch (error) {
				if (!this.recordsUnreadable) {
					this.logService.error('[ParadisClaudeAccounts] failed to read the account list', error);
				}
				this.recordsUnreadable = true;
				throw error;
			}
		}
		return this.records;
	}

	protected async saveRecords(records: IParadisClaudeAccountRecord[]): Promise<void> {
		await this.registry.save(records);
		this.records = records;
	}

	/** 保存してある認証情報（`claudeAiOauth` だけの JSON）。保存できていない更新があればそちら。 */
	protected async readSecret(accountId: string): Promise<string | undefined> {
		const pending = this.pendingSecrets.get(accountId);
		if (pending !== undefined) {
			// 保存し直しはほかの書き換えと同じ列に並べる（並ばずに書くと、後から保存された新しい値を
			// 古い値で上書きしうる）。
			void this.serialize(() => this.flushPendingSecret(accountId, pending));
			this.knownSecrets.set(accountId, pending);
			return pending;
		}
		const value = paradisClaudeOAuthOnly(await this.secrets.read(accountId));
		if (value !== undefined) {
			this.knownSecrets.set(accountId, value);
		} else {
			this.knownSecrets.delete(accountId);
		}
		return value;
	}

	/** 保存できていなかった更新を保存し直す。{@link serialize} の中から呼ぶ。 */
	private async flushPendingSecret(accountId: string, value: string): Promise<void> {
		if (this.pendingSecrets.get(accountId) !== value) {
			return;
		}
		try {
			await this.secrets.write(accountId, value);
			if (this.pendingSecrets.get(accountId) === value) {
				this.pendingSecrets.delete(accountId);
			}
		} catch {
			// まだ保存できない。手元の新しい方を使い続け、次に読むときにまた試す
		}
	}

	protected async writeSecret(accountId: string, credentialsJson: string): Promise<void> {
		const value = paradisClaudeOAuthOnly(credentialsJson);
		if (!value) {
			throw new Error('not an OAuth credential');
		}
		await this.secrets.write(accountId, value);
		this.pendingSecrets.delete(accountId);
		this.knownSecrets.set(accountId, value);
	}

	protected forgetSecret(accountId: string): void {
		this.knownSecrets.delete(accountId);
		this.pendingSecrets.delete(accountId);
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
		if (!request?.passive) {
			this.markDemand();
		}
		const targets = await this.resolveTargets();
		const now = this.now();
		let due = false;
		for (const target of targets) {
			const state = this.usage.get(target.key);
			if (!state || state.active !== target.active) {
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
		if (due && !request?.passive) {
			void this.pollDue();
		}
		const legacy = await this.readLegacyEntries();
		return this.buildState(targets, this.unregisteredLegacyAccounts(targets, legacy));
	}

	/** claude-swap の一覧（`sequence.json`）。読むだけで、claude-swap のデータには書き込まない。 */
	private async readLegacyEntries(): Promise<readonly IParadisClaudeLegacyEntry[]> {
		for (const dir of this.legacyCswapDirs) {
			const sequencePath = path.join(dir, 'sequence.json');
			let stat: fs.Stats;
			try {
				stat = await fs.promises.stat(sequencePath);
			} catch {
				continue;
			}
			if (this.legacyCache?.path === sequencePath && this.legacyCache.mtimeMs === stat.mtimeMs) {
				return this.legacyCache.accounts;
			}
			let accounts: IParadisClaudeLegacyEntry[] = [];
			try {
				const parsed = JSON.parse(await fs.promises.readFile(sequencePath, 'utf8')) as { accounts?: Record<string, { email?: unknown; organizationName?: unknown; organizationUuid?: unknown }> };
				for (const entry of Object.values(parsed.accounts ?? {})) {
					if (entry && typeof entry.email === 'string' && entry.email.trim()) {
						accounts.push({
							email: entry.email.trim(),
							organizationName: typeof entry.organizationName === 'string' && entry.organizationName.trim() ? entry.organizationName.trim() : undefined,
							organizationUuid: typeof entry.organizationUuid === 'string' && entry.organizationUuid.trim() ? entry.organizationUuid.trim() : undefined,
						});
					}
				}
			} catch {
				accounts = [];
			}
			this.legacyCache = { path: sequencePath, mtimeMs: stat.mtimeMs, accounts };
			return accounts;
		}
		return [];
	}

	/** claude-swap にあって、Para Code にまだ登録していないアカウント（パネルの案内に出す）。 */
	private unregisteredLegacyAccounts(targets: readonly IParadisClaudeTarget[], legacy: readonly IParadisClaudeLegacyEntry[]): IParadisLimitsLegacyAccount[] {
		// 登録していないいまのログインも案内に出す（カードの「Para Code に登録」かログインし直しで登録できる）。
		return legacy
			.filter(entry => !targets.some(target => target.record && paradisClaudeIdentitiesMatch(target.identity, { email: entry.email, organizationUuid: entry.organizationUuid })))
			.map(entry => ({ email: entry.email, organizationName: entry.organizationName }));
	}

	private buildState(targets: readonly IParadisClaudeTarget[], legacyAccounts: readonly IParadisLimitsLegacyAccount[]): IParadisClaudeAccountsState {
		let oldestFetchedAt: number | undefined;
		const accounts: IParadisLimitsAccount[] = targets.map(target => {
			const state = this.usage.get(target.key);
			const current = state?.active === target.active ? state : undefined;
			if (current?.fetchedAt !== undefined && (oldestFetchedAt === undefined || current.fetchedAt < oldestFetchedAt)) {
				oldestFetchedAt = current.fetchedAt;
			}
			return {
				provider: 'claude',
				id: target.record ? `${PARADIS_CLAUDE_MANAGED_ID_PREFIX}${target.record.id}` : PARADIS_CLAUDE_LIVE_ID,
				email: target.record?.email ?? target.identity?.email,
				organizationName: target.record?.organizationName ?? target.identity?.organizationName,
				active: target.active,
				managed: target.record !== undefined,
				registrable: target.record === undefined,
				status: current?.status ?? 'unavailable',
				unavailableReason: current ? current.unavailableReason : 'not_fetched',
				statusDetail: current?.statusDetail,
				fiveHour: current?.windows?.fiveHour,
				sevenDay: current?.windows?.sevenDay,
				scoped: current?.windows?.scoped,
				fetchedAt: current?.fetchedAt,
			};
		});
		return { claude: { accounts, legacyAccounts: legacyAccounts.length > 0 ? legacyAccounts : undefined }, oldestFetchedAt, switching: this.switching };
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
		// 切り替えの最中は取りに行かない（使用中の判定と認証情報が食い違う時間帯のため）。
		if (this.switching) {
			return;
		}
		const context: IParadisClaudePollContext = { adoptAllowed: this.skipAdoptPasses === 0, epoch: this.switchEpoch, legacy: await this.readLegacyEntries() };
		const targets = await this.resolveTargets();
		const keys = new Set(targets.map(target => target.key));
		for (const key of [...this.usage.keys()]) {
			if (!keys.has(key)) {
				this.usage.delete(key);
			}
		}
		let changed = false;
		for (const target of targets) {
			if (this._store.isDisposed || this.switching || context.epoch !== this.switchEpoch) {
				// 途中で切り替えがあった。使用中の判定からやり直すため、残りは次の周回に回す。
				break;
			}
			let state = this.usage.get(target.key);
			if (!state || state.active !== target.active) {
				// 使用中と控えが入れ替わった（外で `claude /login` した等）。控えのときに「再ログインが要る」で
				// 止めていたアカウントも、使用中になれば取り直す。
				// 取得の回数予算・429 の履歴・直前の値は引き継ぐ。180 秒以内に取った値があれば取り直さない。
				const recentFetch = state?.fetchedAt !== undefined && this.now() - state.fetchedAt < PARADIS_CLAUDE_SERVE_TTL_S * 1000;
				state = {
					status: recentFetch ? state!.status : 'unavailable',
					unavailableReason: recentFetch ? state!.unavailableReason : 'not_fetched',
					windows: recentFetch ? state!.windows : undefined,
					fetchedAt: recentFetch ? state!.fetchedAt : undefined,
					nextPollAt: recentFetch ? state!.fetchedAt! + PARADIS_CLAUDE_SERVE_TTL_S * 1000 : 0,
					failures: 0,
					active: target.active,
					fetchTimes: state?.fetchTimes ?? [],
					recent429Anchor: state?.recent429Anchor,
					last429At: state?.last429At,
					backoffUntil: state?.backoffUntil,
				};
				this.usage.set(target.key, state);
			}
			const now = this.now();
			if (now < state.nextPollAt || (state.backoffUntil !== undefined && now < state.backoffUntil)) {
				continue;
			}
			try {
				await this.fetchTarget(target, state, context);
			} catch (error) {
				this.logService.warn(`[ParadisClaudeAccounts] usage fetch failed unexpectedly: ${(error as Error).message}`);
				this.recordFailure(state, undefined, false, 'unexpected failure');
			}
			changed = true;
		}
		if (this.skipAdoptPasses > 0 && context.epoch === this.switchEpoch) {
			this.skipAdoptPasses--;
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
		if (rateLimited) {
			state.recent429Anchor = paradisClaudeRecent429Anchor(state.last429At, state.backoffUntil);
		}
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

	/**
	 * いまのログインをそのまま写して登録したアカウントで、claude-swap にも同じアカウントがあるか。
	 * その場合、同じリフレッシュトークンの系列を claude-swap も持っているかもしれない。Para Code が
	 * 控えのトークンを更新すると claude-swap 側の写しが無効になるので、更新しない。
	 */
	private sharesLineageWithCswap(record: IParadisClaudeAccountRecord, legacy: readonly IParadisClaudeLegacyEntry[]): boolean {
		return record.copiedFromLiveLogin === true && legacy.some(entry => paradisClaudeIdentitiesMatch(recordIdentity(record), { email: entry.email, organizationUuid: entry.organizationUuid }));
	}

	/** 使用量を取ったトークンと身元が、いまのログインのままか（取っている間に変わっていないか）。 */
	private async isSameActiveLogin(target: IParadisClaudeTarget, accessToken: string): Promise<boolean> {
		const [live, identity] = await Promise.all([this.liveAuth.readCredentials(), this.liveAuth.readIdentity(true)]);
		return paradisClaudeAccessToken(live.value) === accessToken && paradisClaudeIdentitiesMatch(target.identity, identity);
	}

	private async fetchTarget(target: IParadisClaudeTarget, state: IParadisClaudeUsageState, context: IParadisClaudePollContext): Promise<void> {
		let credentials: string | undefined;
		const sharedLineage = !target.active && target.record !== undefined && this.sharesLineageWithCswap(target.record, context.legacy);
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
			if (target.record && context.adoptAllowed) {
				await this.tryAdoptLiveCredentials(target.record, live.value, context.epoch);
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
				if (sharedLineage) {
					// claude-swap と共有しているかもしれない系列は更新しない。使用中に戻ったときに取り直す。
					this.setStatus(state, 'unavailable', SHARED_LINEAGE_RETRY_S, 'not_fetched', 'shared with claude-swap');
					return;
				}
				const refreshed = await this.refreshStoredCredentials(target.record, false, context.epoch);
				if (refreshed === 'dead') {
					this.setStatus(state, 'relogin_required', Number.POSITIVE_INFINITY);
					return;
				}
				if (refreshed === 'live_lineage') {
					this.setStatus(state, 'unavailable', ACTIVE_EXPIRED_RETRY_S, 'not_fetched', 'same lineage as the current login');
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

		this.noteFetch(state);
		let result = await this.oauth.fetchUsage(accessToken);
		if (result.kind === 'http' && result.status === 401 && !target.active && target.record && !sharedLineage) {
			// 期限より前に失効していた。1回だけ更新して取り直す。
			const refreshed = await this.refreshStoredCredentials(target.record, true, context.epoch);
			if (refreshed === 'dead') {
				this.setStatus(state, 'relogin_required', Number.POSITIVE_INFINITY);
				return;
			}
			if (refreshed === 'live_lineage') {
				this.setStatus(state, 'unavailable', ACTIVE_EXPIRED_RETRY_S, 'not_fetched', 'same lineage as the current login');
				return;
			}
			const retryToken = paradisClaudeAccessToken(refreshed);
			if (retryToken) {
				this.noteFetch(state);
				result = await this.oauth.fetchUsage(retryToken);
			}
		}

		if (result.kind === 'ok' && target.active && !await this.isSameActiveLogin(target, accessToken)) {
			// 取っている間にいまのログインが変わった（`claude /login`、切り替え）。別のアカウントの使用量を
			// このカードに出さないよう結果を捨て、少し置いて取り直す（身元が読めない間に取り続けないよう間を空ける）。
			state.nextPollAt = this.now() + LOGIN_CHANGED_RETRY_S * 1000;
			return;
		}

		const now = this.now();
		switch (result.kind) {
			case 'ok': {
				const anchor = state.recent429Anchor;
				const recent429 = anchor !== undefined && now - anchor < PARADIS_CLAUDE_RECENT_429_WINDOW_S * 1000;
				const plan = paradisClaudePlanAfterFetch({
					previousIntervalS: state.intervalS,
					previousUsage: state.windows,
					newUsage: result.usage,
					isActive: target.active,
					recent429,
					fetchesInLastHour: state.fetchTimes.length,
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
					} else if (sharedLineage) {
						this.setStatus(state, 'unavailable', SHARED_LINEAGE_RETRY_S, 'not_fetched', 'shared with claude-swap');
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

	/** API を呼んだ時刻を控え、1 時間より古いものを捨てる。 */
	private noteFetch(state: IParadisClaudeUsageState): void {
		const now = this.now();
		state.fetchTimes = state.fetchTimes.filter(time => now - time < 3600_000);
		state.fetchTimes.push(now);
	}

	// ---------- いまのログインのトークンの取り込み ----------

	/**
	 * いまのログインの認証情報が `expected` のアカウントのものかを確かめて返す。確かめられなければ undefined。
	 *
	 * 1. 「身元 → 認証情報 → 身元」の順に読み、2 回の身元がどちらも `expected` と一致すること
	 *    （切り替えや `claude /login` で途中の状態を読んでいないこと）
	 * 2. トークンの持ち主を `/api/oauth/profile` で確かめ、`expected` と一致すること
	 * 3. ほかの登録アカウントとして保存してあるトークンと同じ系列でないこと
	 */
	private async verifyLiveCredentials(expected: IParadisClaudeIdentity, liveHint?: string): Promise<IParadisClaudeVerifiedLive | undefined> {
		const before = await this.liveAuth.readIdentity(true);
		const live = await this.liveAuth.readCredentials();
		const after = await this.liveAuth.readIdentity(true);
		if (!live.value || !paradisIsUsableClaudeCredentials(live.value) || (liveHint !== undefined && live.value !== liveHint)) {
			return undefined;
		}
		if (!paradisClaudeIdentitiesMatch(before, expected) || !paradisClaudeIdentitiesMatch(after, expected)) {
			return undefined;
		}
		const oauthOnly = paradisClaudeOAuthOnly(live.value)!;
		const refreshToken = paradisClaudeRefreshToken(oauthOnly);
		const records = await this.loadRecords();
		for (const record of records) {
			if (paradisClaudeIdentitiesMatch(recordIdentity(record), expected)) {
				continue;
			}
			const other = this.knownSecrets.get(record.id);
			if (other !== undefined && paradisClaudeRefreshToken(other) === refreshToken) {
				return undefined;
			}
		}
		const profile = await this.oauth.fetchProfile(paradisClaudeAccessToken(oauthOnly)!);
		if (profile.kind !== 'ok' || !paradisClaudeIdentitiesMatch(profile.identity, expected)) {
			return undefined;
		}
		return { oauthOnly };
	}

	/**
	 * 使用中の登録アカウントについて、Claude Code が更新して書き戻したトークンを保存し直す。
	 * 保存してあるものと同じなら何もしない（身元の確認の API も呼ばない）。
	 */
	private async tryAdoptLiveCredentials(record: IParadisClaudeAccountRecord, liveCredentials: string, epoch: number): Promise<void> {
		const oauthOnly = paradisClaudeOAuthOnly(liveCredentials);
		if (!oauthOnly || !paradisIsUsableClaudeCredentials(oauthOnly) || this.knownSecrets.get(record.id) === oauthOnly) {
			return;
		}
		const retryAt = this.adoptRetryAfter.get(record.id);
		if (retryAt !== undefined && this.now() < retryAt) {
			return;
		}
		const verified = await this.verifyLiveCredentials(recordIdentity(record), liveCredentials);
		if (!verified) {
			// 値は出さない。確かめ直すのは一定時間後（毎回の取得で profile API を呼ばない）。
			this.logService.info('[ParadisClaudeAccounts] could not confirm the owner of the current Claude login; its refreshed token was not saved');
			this.adoptRetryAfter.set(record.id, this.now() + ADOPT_RETRY_AFTER_MS);
			return;
		}
		this.adoptRetryAfter.delete(record.id);
		await this.serialize(async () => {
			// 並んでいる間に切り替えがあったら取り込まない。
			if (this.switching || epoch !== this.switchEpoch) {
				return;
			}
			await this.adoptVerifiedCredentials(record, verified);
		});
	}

	/** 確かめ済みのトークンを保存する。{@link serialize} の中から呼ぶ。 */
	private async adoptVerifiedCredentials(record: IParadisClaudeAccountRecord, verified: IParadisClaudeVerifiedLive): Promise<void> {
		try {
			const stored = await this.readSecret(record.id);
			// 保存してある方が新しい（再ログインした直後で、いまのログインは失効したまま）なら取り込まない。
			// Claude Code が更新したトークンは期限が延びているので、この比較で取りこぼさない。
			const storedExpiresAt = paradisParseClaudeOAuthBlob(stored)?.expiresAt;
			const liveExpiresAt = paradisParseClaudeOAuthBlob(verified.oauthOnly)?.expiresAt;
			if (typeof storedExpiresAt === 'number' && typeof liveExpiresAt === 'number' && liveExpiresAt < storedExpiresAt) {
				return;
			}
			if (stored !== verified.oauthOnly) {
				await this.writeSecret(record.id, verified.oauthOnly);
			}
		} catch (error) {
			this.logService.warn(`[ParadisClaudeAccounts] could not save the refreshed Claude login: ${(error as Error).message}`);
		}
	}

	/**
	 * 控えのアカウントのトークンを更新して保存する。
	 * @returns 更新後の JSON。更新しなかった・一時的に失敗したときは undefined。
	 * リフレッシュトークンが拒否されたときは 'dead'。
	 */
	protected refreshStoredCredentials(record: IParadisClaudeAccountRecord, force: boolean, epoch: number): Promise<ParadisClaudeRefreshOutcome> {
		// 並んでいる間に別の処理が更新したかもしれないので、並んだ後で保存場所から読み直す。
		// 並んでいる間に切り替えがあったら更新しない（控えだったこのアカウントが使用中になっていれば、
		// ここで更新すると Claude Code の手元のトークンが無効になる）。
		return this.serialize(() => this.switching || epoch !== this.switchEpoch ? Promise.resolve(undefined) : this.refreshStoredCredentialsNow(record, force));
	}

	/** {@link refreshStoredCredentials} の本体。{@link serialize} の中から呼ぶ。 */
	private async refreshStoredCredentialsNow(record: IParadisClaudeAccountRecord, force: boolean): Promise<ParadisClaudeRefreshOutcome> {
		const current = await this.readSecret(record.id);
		if (!current) {
			return 'dead';
		}
		if (!force && !paradisIsClaudeTokenExpiring(current, this.now())) {
			return current;
		}
		// いまのログインと同じ系列なら更新しない（`~/.claude.json` を一瞬読めずに使用中を控えと
		// 取り違えた場合でも、Claude Code の手元のトークンを無効にしない）。確かめられなければ更新しない。
		const live = await this.liveAuth.readCredentials();
		if (live.keychainUnavailable) {
			return undefined;
		}
		const liveRefreshToken = paradisClaudeRefreshToken(live.value);
		if (liveRefreshToken !== undefined && liveRefreshToken === paradisClaudeRefreshToken(current)) {
			return 'live_lineage';
		}
		const result = await this.oauth.refresh(current);
		switch (result.kind) {
			case 'ok': {
				const refreshed = paradisClaudeOAuthOnly(result.credentialsJson)!;
				try {
					await this.writeSecret(record.id, refreshed);
				} catch (error) {
					// 回った後のトークンを保存できなかった。手元に残し、次に読むときに保存し直す。
					this.pendingSecrets.set(record.id, refreshed);
					this.knownSecrets.set(record.id, refreshed);
					this.logService.error(`[ParadisClaudeAccounts] refreshed a Claude token but could not save it: ${(error as Error).message}`);
				}
				return refreshed;
			}
			case 'invalid_grant':
			case 'no_refresh_token':
				return 'dead';
			case 'transient':
				return undefined;
		}
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

	// ---------- 切り替え ----------

	/**
	 * この PC の Claude のログインを、登録したアカウントに切り替える（PC 全体のログインを書き換える、
	 * という決定。Para Code の外の Claude Code にも効く）。
	 *
	 * 1. 切り替え先の認証情報を読む（期限が近ければ、書く前に更新しておく）
	 * 2. いまのアカウントのトークンを、身元を確かめてから控える（ロックの外。API を呼ぶため）
	 * 3. Claude Code のロックを取り、その中で
	 *    - 身元と認証情報を読み直し、登録していないログインなら止める（書き換えると失われるため）
	 *    - 2 で確かめたトークンから変わっていなければ、いまのアカウントに保存し直す
	 *    - 書く前の状態を控え、`claudeAiOauth` と `~/.claude.json` の oauthAccount を書く
	 *    - 途中で失敗したら控えへ戻す
	 * 同時に2つは走らせない（2つめは 'busy'）。
	 */
	async switchAccount(managedId: string): Promise<IParadisClaudeSwitchResult> {
		const accountId = ParadisClaudeAccountService.parseManagedId(managedId);
		if (!accountId) {
			return { outcome: 'not_found' };
		}
		if (this.switching) {
			return { outcome: 'busy' };
		}
		this.switching = true;
		this.switchEpoch++;
		this.fireChange();
		try {
			return await this.serialize(() => this.doSwitch(accountId));
		} catch (error) {
			this.logService.error(`[ParadisClaudeAccounts] switching the Claude account failed: ${(error as Error).message}`);
			return { outcome: 'failed', detail: 'unexpected' };
		} finally {
			this.switchEpoch++;
			// 直後の1周は、いまのログインのトークンを取り込まない（Claude Code が読み直す前の状態を読みうる）。
			this.skipAdoptPasses = 1;
			this.switching = false;
			this.fireChange();
			this.scheduleSoon();
		}
	}

	private async doSwitch(accountId: string): Promise<IParadisClaudeSwitchResult> {
		const records = await this.loadRecords();
		const target = records.find(record => record.id === accountId);
		if (!target) {
			return { outcome: 'not_found' };
		}
		let targetCredentials: string | undefined;
		try {
			targetCredentials = await this.readSecret(accountId);
		} catch {
			return { outcome: 'no_credentials', email: target.email, detail: 'keychain' };
		}
		if (!targetCredentials || !paradisIsUsableClaudeCredentials(targetCredentials)) {
			return { outcome: 'no_credentials', email: target.email };
		}

		const liveIdentity = await this.liveAuth.readIdentity(true);
		const outgoing = liveIdentity ? records.find(record => paradisClaudeIdentitiesMatch(recordIdentity(record), liveIdentity)) : undefined;
		const liveBefore = await this.liveAuth.readCredentials();
		if (liveBefore.keychainUnavailable) {
			return { outcome: 'failed', email: target.email, rolledBack: true, detail: 'keychain' };
		}
		const liveUsable = paradisIsUsableClaudeCredentials(liveBefore.value);
		if (outgoing?.id === accountId && liveUsable) {
			return { outcome: 'already_active', email: target.email };
		}
		if (!outgoing && liveUsable) {
			// 登録していないログインを上書きすると、そのアカウントのリフレッシュトークンを失う。
			return { outcome: 'unmanaged_live', email: target.email, previousEmail: liveIdentity?.email };
		}

		// 控えのトークンが切れかけなら、この PC へ書く前に更新しておく。まだ誰も使っていないので
		// ここで更新してよい（切り替えた後は Claude Code が自分で更新する）。
		if (paradisIsClaudeTokenExpiring(targetCredentials, this.now())) {
			const refreshed = await this.refreshStoredCredentialsNow(target, false);
			if (refreshed === 'dead') {
				this.resetUsage(target.id);
				return { outcome: 'no_credentials', email: target.email };
			}
			targetCredentials = typeof refreshed === 'string' ? refreshed : targetCredentials;
		}

		// いまのアカウントの最新のトークン（Claude Code が更新したもの）が保存分と違うなら、持ち主を
		// 確かめて保存し直してから切り替える。確かめられなければ切り替えない（切り替えるとその最新の
		// リフレッシュトークンが失われ、そのアカウントは再ログインが要るようになる）。トークンの欄が空に
		// なっている（Claude Code が更新を拒否された跡）など、守るものが無いときは確かめずに進む。
		let outgoingStored: string | undefined;
		let outgoingVerified: IParadisClaudeVerifiedLive | undefined;
		if (outgoing && liveUsable) {
			try {
				outgoingStored = await this.readSecret(outgoing.id);
			} catch {
				return { outcome: 'failed', email: target.email, rolledBack: true, detail: 'keychain' };
			}
			if (paradisClaudeOAuthOnly(liveBefore.value) !== outgoingStored) {
				outgoingVerified = await this.verifyLiveCredentials(recordIdentity(outgoing));
				if (!outgoingVerified) {
					return { outcome: 'unverified', email: target.email, previousEmail: outgoing.email };
				}
			}
		}

		try {
			return await this.liveAuth.withLocks(async (): Promise<IParadisClaudeSwitchResult> => {
				// ロックの中で読み直す。ロックの外で確かめた後に書き換わっていたら、その値は取り込まない。
				const identityInLock = await this.liveAuth.readIdentity(true);
				const live = await this.liveAuth.readCredentials();
				if (live.keychainUnavailable) {
					return { outcome: 'failed', email: target.email, rolledBack: true, detail: 'keychain' };
				}
				const ownerInLock = identityInLock ? records.find(record => paradisClaudeIdentitiesMatch(recordIdentity(record), identityInLock)) : undefined;
				if (!ownerInLock && paradisIsUsableClaudeCredentials(live.value)) {
					return { outcome: 'unmanaged_live', email: target.email, previousEmail: identityInLock?.email };
				}
				if (outgoing && paradisIsUsableClaudeCredentials(live.value)) {
					const liveInLock = paradisClaudeOAuthOnly(live.value);
					// ロックの外で確かめた後に持ち主やトークンが変わっていたら、確かめ直すためにやめる。
					if (ownerInLock?.id !== outgoing.id) {
						return { outcome: 'unverified', email: target.email, previousEmail: outgoing.email };
					}
					if (liveInLock !== outgoingStored) {
						if (!outgoingVerified || liveInLock !== outgoingVerified.oauthOnly) {
							return { outcome: 'unverified', email: target.email, previousEmail: outgoing.email };
						}
						await this.adoptVerifiedCredentials(outgoing, outgoingVerified);
					}
				}
				const snapshot = await this.liveAuth.captureSnapshot();
				try {
					await this.liveAuth.activate(targetCredentials!, target.oauthAccount, snapshot);
				} catch (error) {
					let rolledBack = true;
					try {
						await this.liveAuth.restore(snapshot);
					} catch (restoreError) {
						rolledBack = false;
						this.logService.error(`[ParadisClaudeAccounts] could not restore the Claude login after a failed switch: ${(restoreError as Error).message}`);
					}
					this.logService.warn(`[ParadisClaudeAccounts] switching the Claude account failed: ${(error as Error).message}`);
					return { outcome: 'failed', email: target.email, rolledBack, detail: this.classifySwitchError(error) };
				}
				return { outcome: 'switched', email: target.email, previousEmail: ownerInLock?.email ?? identityInLock?.email };
			});
		} catch (error) {
			if (error instanceof ParadisClaudeLockTimeoutError) {
				return { outcome: 'locked', email: target.email };
			}
			this.logService.warn(`[ParadisClaudeAccounts] switching the Claude account failed before writing: ${(error as Error).message}`);
			return { outcome: 'failed', email: target.email, rolledBack: true, detail: this.classifySwitchError(error) };
		}
	}

	/** 失敗の種類を固定の英語にする（パスや秘密の値を含めない）。 */
	private classifySwitchError(error: unknown): string {
		if (error instanceof ParadisClaudeConfigUnreadableError) {
			return 'config_unreadable';
		}
		if (error instanceof ParadisKeychainError) {
			return 'keychain';
		}
		return 'io';
	}

	// ---------- 登録・再ログイン・削除 ----------

	/**
	 * 認証情報（`claudeAiOauth` だけを保存する）と oauthAccount を登録する。同じアカウントが既に
	 * あればその認証情報を差し替える。
	 * @param reloginId 再ログインのときの登録 ID。違うアカウントでログインしていたら登録しない。
	 * @param copiedFromLiveLogin いまのログインを写して登録するか（ブラウザでログインし直したものは false）。
	 * @returns 登録（または更新）したアカウントのメールアドレスと、新規かどうか。
	 */
	protected saveAccount(credentials: string, oauthAccount: unknown, reloginId: string | undefined, copiedFromLiveLogin: boolean): Promise<{ email: string; created: boolean }> {
		return this.serialize(async () => {
			const identity = paradisClaudeIdentityFromOauthAccount(oauthAccount);
			if (!identity?.email) {
				throw paradisClaudeSetupError('no_identity');
			}
			const records = [...await this.loadRecordsForWrite()];
			const target = reloginId !== undefined
				? records.find(record => record.id === reloginId)
				: records.find(record => paradisClaudeIdentitiesMatch(recordIdentity(record), identity));
			if (reloginId !== undefined && !target) {
				throw paradisClaudeSetupError('not_found');
			}
			if (reloginId !== undefined && target && !paradisClaudeIdentitiesMatch(recordIdentity(target), identity)) {
				throw paradisClaudeSetupError('different_account');
			}
			const now = this.now();
			const fields = {
				email: identity.email,
				accountUuid: identity.accountUuid,
				organizationUuid: identity.organizationUuid,
				organizationName: identity.organizationName,
				oauthAccount,
				copiedFromLiveLogin: copiedFromLiveLogin ? true : undefined,
				updatedAt: now,
			};
			if (target) {
				await this.writeSecret(target.id, credentials);
				await this.saveRecords(records.map(record => record.id === target.id ? { ...record, ...fields } : record));
				this.resetUsage(target.id);
				return { email: identity.email, created: false };
			}
			const id = generateUuid();
			await this.writeSecret(id, credentials);
			try {
				await this.saveRecords([...records, { id, createdAt: now, ...fields }]);
			} catch (error) {
				// 一覧に載らない認証情報を残さない。
				await this.secrets.delete(id).catch(() => undefined);
				this.forgetSecret(id);
				throw error;
			}
			return { email: identity.email, created: true };
		});
	}

	/** いまのログインを Para Code に登録する（ブラウザでのログインは要らない）。 */
	async registerLiveAccount(): Promise<IParadisClaudeRegisterResult> {
		if (this.switching) {
			return { outcome: 'busy' };
		}
		const epoch = this.switchEpoch;
		const live = await this.liveAuth.readCredentials();
		const oauthAccount = await this.liveAuth.readOauthAccount(true);
		const identity = paradisClaudeIdentityFromOauthAccount(oauthAccount);
		if (!live.value || !identity) {
			return { outcome: 'no_live_login' };
		}
		if (!paradisIsUsableClaudeCredentials(live.value)) {
			return { outcome: 'not_oauth' };
		}
		// 身元と認証情報が同じアカウントのものか確かめてから登録する（別のアカウントのトークンを
		// このアカウントとして保存しないため）。
		const verified = await this.verifyLiveCredentials(identity);
		if (!verified || this.switching || epoch !== this.switchEpoch) {
			return { outcome: 'unverified' };
		}
		try {
			const { email, created } = await this.saveAccount(verified.oauthOnly, oauthAccount, undefined, true);
			this.fireChange();
			this.scheduleSoon();
			return { outcome: created ? 'registered' : 'updated', email };
		} catch (error) {
			this.logService.warn(`[ParadisClaudeAccounts] failed to register the current Claude login: ${(error as Error).message}`);
			return { outcome: 'failed' };
		}
	}

	/** 登録を消す。Claude のいまのログインには触らない（使用中のアカウントでもログアウトはしない）。 */
	removeAccount(managedId: string): Promise<boolean> {
		const accountId = ParadisClaudeAccountService.parseManagedId(managedId);
		if (!accountId) {
			return Promise.resolve(false);
		}
		return this.serialize(async () => {
			const records = await this.loadRecordsForWrite();
			if (!records.some(record => record.id === accountId)) {
				return false;
			}
			await this.secrets.delete(accountId);
			this.forgetSecret(accountId);
			await this.saveRecords(records.filter(record => record.id !== accountId));
			this.resetUsage(accountId);
			this.fireChange();
			return true;
		});
	}

	/**
	 * アカウントの追加（`managedId` を渡したときはそのアカウントの再ログイン）を始める。
	 * 進み具合は {@link getSetupState} で聞く。同時に進められるのは1つだけ（キャンセルした後も、
	 * 一時ディレクトリとキーチェーン項目の後片付けが終わるまでは次を始めない）。
	 */
	startLogin(managedId: string | undefined): IParadisLimitsSetupHandle {
		const id = generateUuid();
		const session: IParadisClaudeSetupSession = { id, state: { phase: 'starting' }, abort: new AbortController() };
		this.setupSessions.set(id, session);
		const reloginId = managedId !== undefined ? ParadisClaudeAccountService.parseManagedId(managedId) : undefined;
		let run: Promise<{ email: string }>;
		if (this.loginInFlight) {
			run = Promise.reject(paradisClaudeSetupError('busy'));
		} else if (managedId !== undefined && !reloginId) {
			run = Promise.reject(paradisClaudeSetupError('not_found'));
		} else {
			run = this.runLogin(session, reloginId);
			const inFlight = run.catch(() => undefined).finally(() => {
				if (this.loginInFlight === inFlight) {
					this.loginInFlight = undefined;
				}
			});
			this.loginInFlight = inFlight;
		}
		run.then(({ email }) => {
			session.state = { ...session.state, phase: 'done', email };
			this.fireChange();
			this.scheduleSoon();
		}, error => {
			session.state = { ...session.state, phase: 'error', error: session.abort.signal.aborted ? 'cancelled' : (error as Error).message };
		}).finally(() => this.scheduleSetupCleanup(session));
		return { sessionId: id };
	}

	private async runLogin(session: IParadisClaudeSetupSession, reloginId: string | undefined): Promise<{ email: string }> {
		if (!this.loginRunner) {
			throw paradisClaudeSetupError('unsupported');
		}
		const tempRoot = await fs.promises.mkdtemp(path.join(this.tmpdir, LOGIN_DIR_PREFIX));
		let configDir = tempRoot;
		try {
			configDir = await fs.promises.realpath(tempRoot);
		} catch {
			// 実パスが取れなければ作ったパスのまま
		}
		try {
			if (session.abort.signal.aborted) {
				throw paradisClaudeSetupError('cancelled');
			}
			session.state = { phase: 'waiting_browser' };
			await this.loginRunner.login(configDir, url => {
				if (session.state.phase === 'waiting_browser') {
					session.state = { ...session.state, url };
				}
			}, session.abort.signal);
			session.state = { ...session.state, phase: 'registering' };
			// 一時ディレクトリ用の項目（`Claude Code-credentials-<ハッシュ>`）か、そのディレクトリの
			// `.credentials.json` だけから拾う。既定の項目（いまのログイン）は見ない: ログインを待つ間に
			// Claude Code の更新や切り替えでも変わるので、「変わった値が今回のログイン」とは言えない。
			const credentials = await this.liveAuth.readScopedCredentials(configDir);
			if (!credentials || !paradisIsUsableClaudeCredentials(credentials)) {
				throw paradisClaudeSetupError('no_credentials');
			}
			const oauthAccount = await this.liveAuth.readScopedOauthAccount(configDir)
				?? paradisOauthAccountFromClaudeStatus(await this.loginRunner.status(configDir));
			return await this.saveAccount(credentials, oauthAccount, reloginId, false);
		} finally {
			await this.liveAuth.deleteScopedCredentials(configDir);
			await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/**
	 * 前回の終了で消し損ねたアカウント追加の一時ディレクトリと、そのキーチェーン項目を消す（起動のたび）。
	 * 追加したアカウントのリフレッシュトークンが残っているため。テストからも待てるように Promise を返す。
	 */
	async cleanStaleLogins(): Promise<void> {
		let entries: string[];
		try {
			entries = await fs.promises.readdir(this.tmpdir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.startsWith(LOGIN_DIR_PREFIX)) {
				continue;
			}
			const dir = path.join(this.tmpdir, entry);
			try {
				const stat = await fs.promises.lstat(dir);
				if (!stat.isDirectory() || stat.isSymbolicLink() || this.now() - stat.mtimeMs < STALE_LOGIN_DIR_MS) {
					continue;
				}
				await this.liveAuth.deleteScopedCredentials(dir);
				await fs.promises.rm(dir, { recursive: true, force: true });
			} catch {
				// 次の起動でまた試す
			}
		}
	}

	getSetupState(sessionId: string): IParadisLimitsSetupState {
		return this.setupSessions.get(sessionId)?.state ?? { phase: 'error', error: 'not_found' };
	}

	cancelSetup(sessionId: string): void {
		const session = this.setupSessions.get(sessionId);
		if (!session) {
			return;
		}
		session.abort.abort();
		this.setupSessions.delete(sessionId);
	}

	private scheduleSetupCleanup(session: IParadisClaudeSetupSession): void {
		const timer = setTimeout(() => {
			this.setupCleanupTimers.delete(timer);
			if (this.setupSessions.get(session.id) === session) {
				this.setupSessions.delete(session.id);
			}
		}, SETUP_RETENTION_MS);
		this.setupCleanupTimers.add(timer);
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
				const raw = args[0] && typeof args[0] === 'object' ? args[0] as IParadisClaudeStateRequest : undefined;
				const request = raw ? { refresh: raw.refresh === true, passive: raw.passive === true } : undefined;
				return this.service.getState(request) as Promise<T>;
			}
			case 'startLogin': return Promise.resolve(this.service.startLogin(typeof args[0] === 'string' ? args[0] : undefined)) as Promise<T>;
			case 'getSetupState': return Promise.resolve(this.service.getSetupState(String(args[0]))) as Promise<T>;
			case 'cancelSetup': return Promise.resolve(this.service.cancelSetup(String(args[0]))) as Promise<T>;
			case 'registerLiveAccount': return this.service.registerLiveAccount() as Promise<T>;
			case 'removeAccount': return this.service.removeAccount(String(args[0])) as Promise<T>;
			case 'switchAccount': return this.service.switchAccount(String(args[0])) as Promise<T>;
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}
