/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の接続先（REH）で、その接続先の Claude Code がいまログインしているアカウントの使用量を読む。
// SSH のウィンドウの使用量パネルは、手元のアカウントではなくこれだけを出す。
//
// 読み取り専用にしてある:
//  - 読むのは Claude Code の認証情報のファイル（`~/.claude/.credentials.json`）と身元（`~/.claude.json` の
//    oauthAccount）だけ。REH の環境に `CLAUDE_CONFIG_DIR`（絶対パス）があればその下の
//    `.credentials.json` と `.claude.json` を読む。シェルの設定でだけ付けている `CLAUDE_CONFIG_DIR` は REH に
//    届かないことがあり、そのときは既定の場所を見る
//  - トークンの更新もファイルへの書き込みもしない。アクセストークンが切れていれば、接続先の Claude Code が
//    更新するのを待つ（手元の使用中のアカウントと同じ扱い）。リフレッシュトークンは使い捨てなので、
//    ここで更新すると接続先で動いている Claude Code のトークンが無効になる
//  - 使用量 API は REH のプロセスから呼ぶ。手元へ返すのは使用率・リセット時刻・メールアドレスなどの
//    身元だけで、トークンは接続先から出さない
//  - macOS の接続先ではログインがキーチェーンにあり、SSH 越しには読めないので「読めない」と返す
//
// 接続先でアカウントの切り替え（paradisClaudeAccounts.server.ts）が動いているときは、そちらが同じログインの
// 使用量を取っているので、ここでは取りに行かずにその結果から「いまのログイン」のカードだけを返す
// （{@link paradisSetClaudeHostStateSource}。同じログインを2か所で取ると API の回数を倍使う）。
//
// 取得の間隔は手元と同じ適応型（{@link paradisClaudePlanAfterFetch}）。予定の取得は持たず、ウィンドウに
// 聞かれたときに予定時刻を過ぎていれば取りに行く（誰も見ていなければ API を呼ばない）。同じ接続先に
// 複数のウィンドウが繋いでいても、このプロセスの1か所が回数を数える。

import { createHash } from 'crypto';
import * as path from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IParadisClaudeAccountsState, IParadisClaudeStateRequest, PARADIS_CLAUDE_HOST_ACCOUNT_ID, paradisClaudeActiveLoginState } from '../common/paradisClaudeAccounts.js';
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
	paradisParseClaudeOAuthBlob
} from '../common/paradisClaudeUsage.js';
import { IParadisLimitsAccount, ParadisLimitsAccountStatus, ParadisLimitsUnavailableReason } from '../common/paradisLimitsMonitor.js';
import { ParadisClaudeLiveAuth } from './paradisClaudeLiveAuth.js';
import { IParadisClaudeOAuthClient, ParadisClaudeUsageFetchResult } from './paradisClaudeOAuthClient.js';

/** アクセストークンが切れていたとき、接続先の Claude Code が更新するのを待つ間隔（手元の使用中と同じ）。 */
const WAIT_FOR_REFRESH_S = 300;
/** 403 など、すぐには直らない失敗の待ち時間の下限（手元と同じ）。 */
const FORBIDDEN_RETRY_S = 600;
/** 取っている間にログインが変わったとき、取り直すまでの秒数（手元と同じ）。 */
const LOGIN_CHANGED_RETRY_S = 60;

export interface IParadisClaudeHostUsageOptions {
	readonly homedir: string;
	readonly platform: NodeJS.Platform;
	/** REH のプロセスの環境の `CLAUDE_CONFIG_DIR`。絶対パスのときだけ使う。 */
	readonly configDir?: string;
	readonly oauth: IParadisClaudeOAuthClient;
	readonly logService: ILogService;
	readonly now?: () => number;
	readonly random?: () => number;
}

/** 接続先のいまのログイン。 */
interface IParadisClaudeHostLogin {
	/** credentials JSON。ファイルが無ければ undefined。 */
	readonly credentials?: string;
	readonly identity?: IParadisClaudeIdentity;
}

interface IParadisClaudeHostUsageState {
	status: ParadisLimitsAccountStatus;
	unavailableReason?: ParadisLimitsUnavailableReason;
	statusDetail?: string;
	windows?: IParadisClaudeUsageWindows;
	fetchedAt?: number;
	intervalS?: number;
	/** 次に API を呼んでよい時刻（epoch ms）。 */
	nextPollAt: number;
	last429At?: number;
	/** 「最近 429 を受けた」を数える起点。成功しても消さない。 */
	recent429Anchor?: number;
	backoffUntil?: number;
	failures: number;
	/** 直近 1 時間に API を呼んだ時刻。 */
	fetchTimes: number[];
	/** 最後に見たアクセストークンの指紋（トークンそのものは持たない）。 */
	tokenKey?: string;
	/** 最後に見た身元。変わったら前のアカウントの値を捨てる。 */
	identityKey?: string;
}

function paradisTokenKey(accessToken: string | undefined): string | undefined {
	return accessToken === undefined ? undefined : createHash('sha256').update(accessToken).digest('hex').slice(0, 16);
}

function paradisIdentityKey(identity: IParadisClaudeIdentity | undefined): string | undefined {
	if (!identity) {
		return undefined;
	}
	return `${identity.accountUuid ?? ''}\u0000${identity.email?.toLowerCase() ?? ''}\u0000${identity.organizationUuid ?? ''}`;
}

/** 接続先のアカウントの状態（このプロセスで切り替えが動いているときだけ）。 */
let hostStateSource: ((request: IParadisClaudeStateRequest | undefined) => Promise<IParadisClaudeAccountsState>) | undefined;

/**
 * このプロセス（REH）で Claude のアカウントの切り替えが動いているとき、その状態を渡す。以後
 * {@link ParadisClaudeHostUsage} は自分では取りに行かず、その状態から「いまのログイン」を返す。
 */
export function paradisSetClaudeHostStateSource(source: (request: IParadisClaudeStateRequest | undefined) => Promise<IParadisClaudeAccountsState>): IDisposable {
	hostStateSource = source;
	return toDisposable(() => {
		if (hostStateSource === source) {
			hostStateSource = undefined;
		}
	});
}

export class ParadisClaudeHostUsage {

	private readonly liveAuth: ParadisClaudeLiveAuth;
	private readonly configDir: string | undefined;
	private readonly configLabel: string;
	private readonly platform: NodeJS.Platform;
	private readonly oauth: IParadisClaudeOAuthClient;
	private readonly logService: ILogService;
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly state: IParadisClaudeHostUsageState = { status: 'unavailable', unavailableReason: 'not_fetched', nextPollAt: 0, failures: 0, fetchTimes: [] };
	private identity: IParadisClaudeIdentity | undefined;
	/** 同時に来た問い合わせ（複数のウィンドウ）は1本にまとめる。 */
	private inflight: Promise<IParadisClaudeAccountsState> | undefined;

	constructor(options: IParadisClaudeHostUsageOptions) {
		this.configDir = options.configDir && path.isAbsolute(options.configDir) ? options.configDir : undefined;
		this.configLabel = this.configDir ?? '~/.claude';
		this.platform = options.platform;
		this.oauth = options.oauth;
		this.logService = options.logService;
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
		// キーチェーンは渡さない（SSH 越しには読めない）。使うのは読み取りのメソッドだけ。身元（`.claude.json`）は
		// 更新時刻と大きさが変わらなければ読み直さない（数 MB になることがある）。
		this.liveAuth = new ParadisClaudeLiveAuth({ homedir: options.homedir, configDir: this.configDir, platform: options.platform, keychain: undefined, userName: undefined, now: this.now });
	}

	async getState(request: IParadisClaudeStateRequest | undefined): Promise<IParadisClaudeAccountsState> {
		const source = hostStateSource;
		if (source) {
			return paradisClaudeActiveLoginState(await source(request), this.configLabel);
		}
		const running = this.inflight;
		if (running) {
			if (!request?.refresh || request.passive) {
				return running;
			}
			// 手動の更新は、走っている問い合わせの後にもう一度見る（まとめると、その更新が捨てられる）。
			// 180 秒より新しい結果があれば API は呼ばない。
			await running.catch(() => undefined);
			return this.getState(request);
		}
		const evaluation = this.evaluate(request).finally(() => {
			if (this.inflight === evaluation) {
				this.inflight = undefined;
			}
		});
		this.inflight = evaluation;
		return evaluation;
	}

	private async readLogin(fresh = false): Promise<IParadisClaudeHostLogin> {
		const [live, identity] = await Promise.all([this.liveAuth.readCredentials(), this.liveAuth.readIdentity(fresh)]);
		return { credentials: live.value, identity };
	}

	private async evaluate(request: IParadisClaudeStateRequest | undefined): Promise<IParadisClaudeAccountsState> {
		const state = this.state;
		let login: IParadisClaudeHostLogin;
		try {
			login = await this.readLogin();
		} catch (error) {
			this.logService.warn(`[ParadisClaudeHostUsage] could not read the Claude login on this host: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`);
			this.setStatus('error', undefined, 'could not read the Claude credentials on this host');
			return this.buildState();
		}

		const identityKey = paradisIdentityKey(login.identity);
		if (state.identityKey !== undefined && identityKey !== undefined && identityKey !== state.identityKey) {
			// 接続先で別のアカウントにログインし直した。前のアカウントの値は出さず、失敗と 429 の待ちも
			// 引き継がない（API の回数の上限はアカウントごとに数えられる）。
			state.windows = undefined;
			state.fetchedAt = undefined;
			state.intervalS = undefined;
			state.status = 'unavailable';
			state.unavailableReason = 'not_fetched';
			state.statusDetail = undefined;
			state.nextPollAt = 0;
			state.failures = 0;
			state.backoffUntil = undefined;
			state.last429At = undefined;
			state.recent429Anchor = undefined;
			state.fetchTimes = [];
		}
		if (identityKey !== undefined) {
			state.identityKey = identityKey;
		}
		this.identity = login.identity;

		const oauth = paradisParseClaudeOAuthBlob(login.credentials);
		const accessToken = paradisClaudeAccessToken(login.credentials);
		const tokenKey = paradisTokenKey(accessToken);
		const tokenChanged = tokenKey !== state.tokenKey;
		state.tokenKey = tokenKey;

		if (!login.credentials) {
			if (this.platform === 'darwin' && login.identity) {
				// 身元はあるのにファイルが無い: macOS の Claude Code はログインをキーチェーンに置く。
				this.setStatus('unavailable', 'keychain_unavailable', 'credentials are kept in the macOS keychain');
			} else {
				this.setStatus('no_credentials');
			}
			return this.buildState();
		}
		if (!oauth || !accessToken) {
			// サブスクリプションでログインしていない（または Claude Code が更新を断られてトークンを空にした）。
			this.setStatus('no_credentials');
			return this.buildState();
		}
		const now = this.now();
		const inBackoff = state.backoffUntil !== undefined && now < state.backoffUntil;
		if (typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt) && now >= oauth.expiresAt) {
			// 切れている。更新は接続先の Claude Code に任せ、こちらは待つだけ（API も呼ばない）。
			this.setStatus('refreshing');
			state.nextPollAt = now + WAIT_FOR_REFRESH_S * 1000;
			return this.buildState();
		}
		if (tokenChanged && state.status !== 'ok' && !inBackoff) {
			// 待っていた（切れていた・ログインしていなかった）トークンが新しくなった。すぐ取りに行く。
			state.nextPollAt = now;
		}
		// 手動の更新でも、180 秒以内の結果は取り直さない（API の回数を守る）。429 で待っている間も同じ。
		if (request?.refresh && (state.fetchedAt === undefined || now - state.fetchedAt > PARADIS_CLAUDE_SERVE_TTL_S * 1000) && !inBackoff) {
			state.nextPollAt = now;
		}
		if (request?.passive || now < state.nextPollAt || inBackoff) {
			return this.buildState();
		}
		await this.fetch(accessToken, identityKey);
		return this.buildState();
	}

	private async fetch(accessToken: string, identityKey: string | undefined): Promise<void> {
		const state = this.state;
		this.noteFetch();
		let result: ParadisClaudeUsageFetchResult;
		try {
			result = await this.oauth.fetchUsage(accessToken);
		} catch (error) {
			this.logService.warn(`[ParadisClaudeHostUsage] usage fetch failed unexpectedly: ${(error as Error).message}`);
			this.recordFailure(undefined, false, 'unexpected failure');
			return;
		}
		if (result.kind === 'ok') {
			// 取っている間に接続先で別のアカウントにログインし直していたら、結果を捨てて少し置いて取り直す。
			let after: IParadisClaudeHostLogin | undefined;
			try {
				after = await this.readLogin(true);
			} catch {
				after = undefined;
			}
			if (paradisIdentityKey(after?.identity) !== identityKey) {
				state.nextPollAt = this.now() + LOGIN_CHANGED_RETRY_S * 1000;
				return;
			}
		}
		const now = this.now();
		switch (result.kind) {
			case 'ok': {
				const anchor = state.recent429Anchor;
				const plan = paradisClaudePlanAfterFetch({
					previousIntervalS: state.intervalS,
					previousUsage: state.windows,
					newUsage: result.usage,
					isActive: true,
					recent429: anchor !== undefined && now - anchor < PARADIS_CLAUDE_RECENT_429_WINDOW_S * 1000,
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
					this.recordFailure(result.retryAfterS, true, 'usage API rate limited');
				} else if (result.status === 401) {
					// 期限より前に失効していた。更新は接続先の Claude Code に任せる。
					this.setStatus('refreshing');
					state.nextPollAt = now + WAIT_FOR_REFRESH_S * 1000;
				} else if (result.status === 403) {
					this.recordFailure(FORBIDDEN_RETRY_S, false, 'usage API returned 403');
				} else {
					this.recordFailure(undefined, false, `usage API returned ${result.status}`);
				}
				return;
			case 'network':
				this.recordFailure(undefined, false, 'could not reach the usage API');
				return;
		}
	}

	/** API を呼んだ時刻を控え、1 時間より古いものを捨てる。 */
	private noteFetch(): void {
		const now = this.now();
		this.state.fetchTimes = this.state.fetchTimes.filter(time => now - time < 3600_000);
		this.state.fetchTimes.push(now);
	}

	/** 取得に失敗した。前に取れた値があればそれを見せ続ける（手元の recordFailure と同じ）。 */
	private recordFailure(retryAfterS: number | undefined, rateLimited: boolean, detail: string): void {
		const state = this.state;
		const now = this.now();
		state.failures++;
		if (rateLimited) {
			state.last429At = now;
		}
		state.backoffUntil = now + paradisClaudeFailureBackoffS(state.failures, retryAfterS, rateLimited) * 1000;
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

	/** 使用量を出せない状態にする。予定時刻は変えない（API を呼んだ回数と 429 の待ちは引き継ぐ）。 */
	private setStatus(status: ParadisLimitsAccountStatus, unavailableReason?: ParadisLimitsUnavailableReason, statusDetail?: string): void {
		const state = this.state;
		state.status = status;
		state.unavailableReason = unavailableReason;
		state.statusDetail = statusDetail;
		state.windows = undefined;
		state.fetchedAt = undefined;
	}

	private buildState(): IParadisClaudeAccountsState {
		const state = this.state;
		const account: IParadisLimitsAccount = {
			provider: 'claude',
			id: PARADIS_CLAUDE_HOST_ACCOUNT_ID,
			email: this.identity?.email,
			organizationName: this.identity?.organizationName,
			homeLabel: this.configLabel,
			status: state.status,
			unavailableReason: state.unavailableReason,
			statusDetail: state.statusDetail,
			fiveHour: state.windows?.fiveHour,
			sevenDay: state.windows?.sevenDay,
			scoped: state.windows?.scoped,
			fetchedAt: state.fetchedAt,
		};
		return { claude: { accounts: [account] }, oldestFetchedAt: state.fetchedAt, switching: false };
	}
}
