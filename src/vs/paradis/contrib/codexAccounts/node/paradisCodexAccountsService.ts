/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Codex のアカウント（ホーム）まわりの shared process 側の実体。
//
// 切替（選択は全ウィンドウ共通）:
//   - 選択は userData 配下の JSON に1つだけ持ち、変わったら全ウィンドウへ通知する。renderer は
//     それを受けて、新しく開くターミナルへ `CODEX_HOME` を渡す（paradisCodexLaunchHomeService.ts）
//   - 選んだホームが消えたり（使用量パネルからの削除）、ログアウトしたりしたら既定のホームへ戻す。
//     ホームディレクトリを監視して、`.codex*` が増減したら見直して全ウィンドウへ通知する
//   - 切り替えたら、切替元と切替先の2ホームの間だけ会話ログをハードリンクし合う
//     （paradisCodexSessionLinker.ts）。設定でやめられる
//
// リセットクレジット:
//   - 読み取り: ホームの auth.json のアクセストークンで ChatGPT のバックエンドを直接読む（使用量と
//     同じやり方。app-server は起こさない。トークンの更新は limitsMonitor が codex 自身にやらせる）
//   - 消費: `CODEX_HOME=<ホーム> codex app-server` の `account/rateLimitResetCredit/consume`。
//     二重消費は台帳（paradisCodexResetCreditLedger.ts）で防ぐ。消費は shared process の中で1本ずつ
//     直列に流すので、複数ウィンドウから同時に押しても provider へ出る要求は1つになる

import * as fs from 'fs';
import * as os from 'os';
import { disposableTimeout, RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { delimiter, dirname, isAbsolute, join } from '../../../../base/common/path.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisCodexHomes } from '../../agentBrowser/node/paradisAgentHome.js';
import {
	IParadisCodexAccountSelection,
	IParadisCodexAccountsState,
	IParadisCodexHome,
	IParadisCodexSessionLinkSummary,
	IParadisCodexResetConsumeRequest,
	IParadisCodexResetConsumeResult,
	IParadisCodexResetCreditOffer,
	IParadisCodexResetCredits,
	paradisCodexResetOfferRevision,
	paradisCodexResetOutcome,
	paradisMapCodexBackendResetCredits
} from '../common/paradisCodexAccounts.js';
import { IParadisCodexAppServerRpc, ParadisCodexAppServerRpcFactory, paradisIsCodexAuthError, paradisStartCodexAppServerRpc } from '../../../node/paradisCodexAppServerRpc.js';
import { ParadisCodexResetCreditLedger } from './paradisCodexResetCreditLedger.js';
import { paradisLinkCodexSessions } from './paradisCodexSessionLinker.js';

/** 読み取り結果を使い回す時間。パネルは30秒ごとに描き直すので、そのたびに読まない。 */
const RESET_CREDITS_CACHE_MS = 3 * 60_000;
const READ_TIMEOUT_MS = 20_000;
/** 消費は provider まで往復するので長め。 */
const CONSUME_TIMEOUT_MS = 45_000;
/** リセットクレジットの残りを読むバックエンドの URL（Orca と同じ。使用量の wham/usage の隣）。 */
const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
/**
 * 起動してから会話ログのリンクを1回走らせるまでの待ち。前回の切替以降に切替元・切替先で増えた会話を
 * 拾うため。起動直後の混雑を避けて少し遅らせる。
 */
const STARTUP_LINK_DELAY_MS = 60_000;
/** ホームディレクトリの変化をまとめる待ち（`.codex-N` の作成・削除は一連の操作で何度も通知が来る）。 */
const HOME_WATCH_DEBOUNCE_MS = 1_000;

export interface IParadisCodexAccountsServiceOptions {
	readonly logService: ILogService;
	/** 台帳などを置くディレクトリ（shared process では userData 配下）。 */
	readonly stateDirectory: string;
	/** codex を探すときの環境（ログインシェルの PATH を含むもの）。 */
	readonly resolveEnv: () => Promise<NodeJS.ProcessEnv>;
	/** 切替のときに会話ログをリンクするか（設定 paradis.codexAccounts.shareConversations）。既定は true。 */
	readonly shareConversations?: () => boolean;
	/** テスト用の差し替え口。指定すると、ホームの一覧はこのディレクトリを基準に作る。 */
	readonly homeDirectory?: string;
	/** テスト用。`homeDirectory` と一緒に、設定で足したホームを渡す。 */
	readonly configuredHomes?: readonly string[];
	readonly startRpc?: ParadisCodexAppServerRpcFactory;
	readonly resolveCodexCommand?: (env: NodeJS.ProcessEnv) => Promise<string>;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	/** テストで起動時のリンクとホームの監視を止める。 */
	readonly skipBackgroundWork?: boolean;
}

interface ICachedOffer {
	readonly offer: IParadisCodexResetCreditOffer;
	readonly accountId: string | undefined;
}

interface IStoredSelection extends IParadisCodexAccountSelection {
	/** 直前に選んでいたホーム（既定のホームなら undefined）。起動時のリンクの相手に使う。 */
	readonly previousHomePath?: string;
}

interface ICodexAuth {
	readonly accessToken?: string;
	readonly accountId?: string;
	readonly email?: string;
}

/** PATH（とよくある置き場所）から codex を探す。Para Code のペイン用ランチャーでも動く（非対話は素通し）。 */
export async function paradisResolveCodexCommand(env: NodeJS.ProcessEnv): Promise<string> {
	const isWindows = process.platform === 'win32';
	const names = isWindows ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex'];
	const home = os.homedir();
	const directories = [
		...(env.PATH ?? env.Path ?? '').split(delimiter).filter(entry => entry.length > 0 && isAbsolute(entry)),
		...(isWindows
			? [join(home, 'AppData', 'Roaming', 'npm')]
			: [join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), join(home, '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']),
	];
	for (const directory of directories) {
		for (const name of names) {
			const candidate = join(directory, name);
			try {
				await fs.promises.access(candidate, isWindows ? fs.constants.F_OK : fs.constants.X_OK);
				return candidate;
			} catch {
				// 次へ
			}
		}
	}
	throw new Error('codex not found');
}

export class ParadisCodexAccountsService extends Disposable {

	private readonly ledger: ParadisCodexResetCreditLedger;
	private readonly offers = new Map<string, ICachedOffer>();
	private readonly inflightReads = new Map<string, Promise<ICachedOffer>>();
	/** 同じ鍵の連打には同じ Promise を返す。 */
	private readonly inflightConsumes = new Map<string, Promise<IParadisCodexResetConsumeResult>>();
	/** 消費は全ホームを通して1本ずつ流す。 */
	private consumeQueue: Promise<unknown> = Promise.resolve();
	private readonly now: () => number;
	private readonly startRpc: ParadisCodexAppServerRpcFactory;
	private readonly resolveCodexCommand: (env: NodeJS.ProcessEnv) => Promise<string>;
	private readonly fetchImpl: typeof fetch;

	private readonly selectionPath: string;
	private readonly linkLedgerPath: string;
	private selection: IStoredSelection = { revision: 0 };
	private selectionLoad: Promise<void> | undefined;
	/** 選択の読み書き（選ぶ・見直す）は1本ずつ流す。同時に選ぶと同じ revision が2回出るため。 */
	private selectionQueue: Promise<unknown> = Promise.resolve();
	private lastStateKey: string | undefined;
	private linking: Promise<IParadisCodexSessionLinkSummary> = Promise.resolve({ linked: 0, skippedExisting: 0, skippedRemoved: 0, skippedUnsupported: 0, failed: 0 });
	private disposed = false;

	private readonly _onDidChangeState = this._register(new Emitter<IParadisCodexAccountsState>());
	/** 選択かホームの一覧が変わった（どのウィンドウから変えても、全ウィンドウへ届く）。 */
	readonly onDidChangeState: Event<IParadisCodexAccountsState> = this._onDidChangeState.event;

	constructor(protected readonly options: IParadisCodexAccountsServiceOptions) {
		super();
		this.now = options.now ?? Date.now;
		this.startRpc = options.startRpc ?? paradisStartCodexAppServerRpc;
		this.resolveCodexCommand = options.resolveCodexCommand ?? paradisResolveCodexCommand;
		this.fetchImpl = options.fetch ?? fetch;
		this.ledger = new ParadisCodexResetCreditLedger(join(options.stateDirectory, 'codex-reset-credit-ledger.json'), this.now);
		this.selectionPath = join(options.stateDirectory, 'codex-account-selection.json');
		this.linkLedgerPath = join(options.stateDirectory, 'codex-session-links.json');
		if (!options.skipBackgroundWork) {
			this._register(disposableTimeout(() => {
				void this.loadSelection().then(() => {
					if (this.selection.homePath !== undefined) {
						this.linkBetween(this.selection.previousHomePath, this.selection.homePath);
					}
				});
			}, STARTUP_LINK_DELAY_MS));
			this.watchHomeDirectory();
		}
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}

	// ---------- ホーム ----------

	/** Para Code が扱う Codex ホーム（既定のホームを先頭に、ログイン済みのアカウント用ホーム）。 */
	protected knownHomes(): readonly string[] {
		return this.options.homeDirectory !== undefined
			? paradisCodexHomes({ homeDirectory: this.options.homeDirectory, configured: this.options.configuredHomes })
			: paradisCodexHomes();
	}

	/** 一覧にあり、ログイン済み（auth.json がある）ホームか。任意のパスで codex を起動しないための関所。 */
	protected async isKnownSignedInHome(homePath: string): Promise<boolean> {
		return typeof homePath === 'string' && isAbsolute(homePath) && this.knownHomes().includes(homePath) && await this.fileExists(join(homePath, 'auth.json'));
	}

	/** auth.json（読むだけ）。 */
	protected async readAuth(homePath: string): Promise<ICodexAuth> {
		try {
			const auth = JSON.parse(await fs.promises.readFile(join(homePath, 'auth.json'), 'utf8')) as { tokens?: { access_token?: unknown; account_id?: unknown; id_token?: unknown } };
			const accountId = auth.tokens?.account_id;
			const accessToken = auth.tokens?.access_token;
			return {
				accessToken: typeof accessToken === 'string' && accessToken.length > 0 ? accessToken : undefined,
				accountId: typeof accountId === 'string' && accountId.trim().length > 0 ? accountId.trim() : undefined,
				email: emailFromIdToken(auth.tokens?.id_token),
			};
		} catch {
			return {};
		}
	}

	private watchHomeDirectory(): void {
		const scheduler = this._register(new RunOnceScheduler(() => void this.revalidate(), HOME_WATCH_DEBOUNCE_MS));
		try {
			const watcher = fs.watch(os.homedir(), { persistent: false }, (_event, fileName) => {
				// ホーム直下は履歴ファイルなどで頻繁に変わる。Codex のホームに関わる名前だけ拾う。
				if (fileName === null || fileName.toString().startsWith('.codex')) {
					scheduler.schedule();
				}
			});
			watcher.on('error', error => this.options.logService.warn('[ParadisCodexAccounts] home directory watcher failed', error));
			this._register(toDisposable(() => watcher.close()));
		} catch (error) {
			this.options.logService.warn('[ParadisCodexAccounts] could not watch the home directory', error);
		}
	}

	// ---------- 切替 ----------

	private loadSelection(): Promise<void> {
		if (!this.selectionLoad) {
			this.selectionLoad = (async () => {
				try {
					const parsed = JSON.parse(await fs.promises.readFile(this.selectionPath, 'utf8')) as { version?: unknown; homePath?: unknown; previousHomePath?: unknown; revision?: unknown; changedAt?: unknown };
					if (parsed.version === 1 && typeof parsed.revision === 'number' && Number.isSafeInteger(parsed.revision)) {
						this.selection = {
							homePath: typeof parsed.homePath === 'string' && isAbsolute(parsed.homePath) ? parsed.homePath : undefined,
							previousHomePath: typeof parsed.previousHomePath === 'string' && isAbsolute(parsed.previousHomePath) ? parsed.previousHomePath : undefined,
							revision: parsed.revision,
							changedAt: typeof parsed.changedAt === 'number' ? parsed.changedAt : undefined,
						};
					}
				} catch {
					// 無い・壊れている → 既定のホーム
				}
			})();
		}
		return this.selectionLoad;
	}

	private serializeSelection<T>(run: () => Promise<T>): Promise<T> {
		const next = this.selectionQueue.then(run);
		this.selectionQueue = next.catch(() => { });
		return next;
	}

	/** アカウント用ホームの一覧（既定のホームを先頭に、ログイン済みのものだけ）と選択。 */
	getState(): Promise<IParadisCodexAccountsState> {
		return this.serializeSelection(async () => {
			await this.resetMissingSelection();
			return this.buildState();
		});
	}

	/** ホームの増減を反映する。選択が消えていたら既定へ戻し、変わっていれば全ウィンドウへ知らせる。 */
	revalidate(): Promise<void> {
		return this.serializeSelection(async () => {
			await this.resetMissingSelection();
			const state = await this.buildState();
			const key = JSON.stringify(state);
			if (this.lastStateKey !== undefined && key !== this.lastStateKey) {
				this._onDidChangeState.fire(state);
			}
			this.lastStateKey = key;
		});
	}

	/**
	 * 新しく開くターミナルで使う Codex のホームを選ぶ。undefined か既定のホームを渡すと既定へ戻す。
	 * 一覧に無い・ログインしていないホームは受け付けない（任意のパスを CODEX_HOME にさせない）。
	 */
	selectHome(homePath: string | undefined): Promise<IParadisCodexAccountsState> {
		return this.serializeSelection(async () => {
			await this.loadSelection();
			const primary = this.knownHomes()[0];
			let next: string | undefined;
			if (homePath === undefined || homePath === primary) {
				next = undefined;
			} else if (await this.isKnownSignedInHome(homePath)) {
				next = homePath;
			} else {
				throw new Error('not a signed-in Codex home');
			}
			const previous = this.selection.homePath;
			if (next === previous) {
				return this.buildState();
			}
			await this.writeSelection({ homePath: next, previousHomePath: previous, revision: this.selection.revision + 1, changedAt: this.now() });
			// 切り替えた先で過去の会話を開けるよう、切替元と切替先の間でだけ会話ログをリンクし合う。
			this.linkBetween(previous, next);
			return this.fireState();
		});
	}

	/** 選んだホームが一覧から消えていたら（削除・ログアウト）、既定のホームへ戻す。 */
	private async resetMissingSelection(): Promise<void> {
		await this.loadSelection();
		const selected = this.selection.homePath;
		if (selected !== undefined && !await this.isKnownSignedInHome(selected)) {
			this.options.logService.info('[ParadisCodexAccounts] the selected Codex home is gone; falling back to the default home');
			await this.writeSelection({ homePath: undefined, revision: this.selection.revision + 1, changedAt: this.now() });
			await this.fireState();
		}
	}

	private async fireState(): Promise<IParadisCodexAccountsState> {
		const state = await this.buildState();
		this.lastStateKey = JSON.stringify(state);
		this._onDidChangeState.fire(state);
		return state;
	}

	private async buildState(): Promise<IParadisCodexAccountsState> {
		const [primary, ...others] = this.knownHomes();
		const homes: IParadisCodexHome[] = [];
		for (const homePath of [primary, ...others]) {
			const signedIn = await this.fileExists(join(homePath, 'auth.json'));
			if (homePath !== primary && !signedIn) {
				continue;
			}
			homes.push({
				homePath,
				label: this.homeLabel(homePath),
				isDefault: homePath === primary,
				signedIn,
				email: signedIn ? (await this.readAuth(homePath)).email : undefined,
			});
		}
		return { homes, selection: { homePath: this.selection.homePath, revision: this.selection.revision, changedAt: this.selection.changedAt } };
	}

	private async writeSelection(selection: IStoredSelection): Promise<void> {
		await fs.promises.mkdir(dirname(this.selectionPath), { recursive: true, mode: 0o700 });
		const temporaryPath = `${this.selectionPath}.${process.pid}.${this.now()}.tmp`;
		await fs.promises.writeFile(temporaryPath, JSON.stringify({ version: 1, ...selection }), { encoding: 'utf8', mode: 0o600 });
		await fs.promises.rename(temporaryPath, this.selectionPath);
		this.selection = selection;
	}

	/**
	 * 2つのホームの間で会話ログをハードリンクし合う（undefined は既定のホーム）。前のものが終わって
	 * から1本ずつ流す。設定でオフなら何もしない。
	 *
	 * 全アカウントへ広げないのは、仕事用のホームの会話を別の組織のアカウントで再開すると、会話の内容が
	 * そのアカウントへ送られるため。実際に行き来したホームの間にだけ留める。
	 */
	private linkBetween(first: string | undefined, second: string | undefined): void {
		if (this.options.shareConversations?.() === false) {
			return;
		}
		this.linking = this.linking.then(async () => {
			const primary = this.knownHomes()[0];
			const homes = [...new Set([first ?? primary, second ?? primary])];
			const signedIn: string[] = [];
			for (const homePath of homes) {
				if (await this.isKnownSignedInHome(homePath)) {
					signedIn.push(homePath);
				}
			}
			const summary = await paradisLinkCodexSessions(signedIn, { ledgerPath: this.linkLedgerPath, shouldStop: () => this.disposed });
			this.options.logService.info(`[ParadisCodexAccounts] linked Codex sessions between ${signedIn.length} homes: ${summary.linked} linked, ${summary.skippedExisting} existing, ${summary.skippedRemoved} removed by the user, ${summary.skippedUnsupported} unsupported, ${summary.failed} failed`);
			return summary;
		}).catch(error => {
			this.options.logService.warn('[ParadisCodexAccounts] failed to link Codex sessions', error);
			return { linked: 0, skippedExisting: 0, skippedRemoved: 0, skippedUnsupported: 0, failed: 1 };
		});
	}

	/** 走っているリンクが終わるのを待つ（テスト用）。 */
	whenLinked(): Promise<IParadisCodexSessionLinkSummary> {
		return this.linking;
	}

	private homeLabel(homePath: string): string {
		const home = this.options.homeDirectory ?? os.homedir();
		return homePath === home || homePath.startsWith(home + '/') || homePath.startsWith(home + '\\') ? `~${homePath.slice(home.length)}` : homePath;
	}

	private async fileExists(filePath: string): Promise<boolean> {
		try {
			await fs.promises.access(filePath, fs.constants.F_OK);
			return true;
		} catch {
			return false;
		}
	}

	// ---------- リセットクレジット: 読み取り ----------

	async readResetCredits(homePath: string, bypassCache: boolean): Promise<IParadisCodexResetCreditOffer> {
		await this.ledger.load();
		if (!await this.isKnownSignedInHome(homePath)) {
			return { homePath, error: 'auth', fetchedAt: this.now() };
		}
		const cached = this.offers.get(homePath);
		if (!bypassCache && cached && this.now() - cached.offer.fetchedAt < RESET_CREDITS_CACHE_MS) {
			return this.withPendingFlag(cached.offer, cached.accountId);
		}
		let inflight = this.inflightReads.get(homePath);
		if (!inflight) {
			inflight = this.fetchResetCredits(homePath).finally(() => this.inflightReads.delete(homePath));
			this.inflightReads.set(homePath, inflight);
		}
		const fetched = await inflight;
		return this.withPendingFlag(fetched.offer, fetched.accountId);
	}

	private withPendingFlag(offer: IParadisCodexResetCreditOffer, accountId: string | undefined): IParadisCodexResetCreditOffer {
		const pendingUnknown = this.ledger.pendingKeyForAccount(accountScopeOf(offer.homePath, accountId)) !== undefined;
		return pendingUnknown ? { ...offer, pendingUnknown } : offer;
	}

	private async fetchResetCredits(homePath: string): Promise<ICachedOffer> {
		const fetchedAt = this.now();
		const auth = await this.readAuth(homePath);
		let result: ICachedOffer;
		if (!auth.accessToken) {
			result = { offer: { homePath, error: 'auth', fetchedAt }, accountId: auth.accountId };
		} else {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
			try {
				const headers: Record<string, string> = {
					'Authorization': `Bearer ${auth.accessToken}`,
					'Accept': 'application/json',
					'User-Agent': 'ParaCode-CodexAccounts',
				};
				if (auth.accountId) {
					headers['ChatGPT-Account-Id'] = auth.accountId;
				}
				const response = await this.fetchImpl(RESET_CREDITS_URL, { method: 'GET', headers, signal: controller.signal });
				if (response.status === 401 || response.status === 403) {
					// トークンの更新は使用量の取得（limitsMonitor）が codex 自身にさせる。次の読み取りで直る。
					result = { offer: { homePath, error: 'auth', fetchedAt }, accountId: auth.accountId };
				} else if (!response.ok) {
					result = { offer: { homePath, error: 'unavailable', fetchedAt }, accountId: auth.accountId };
				} else {
					const credits = paradisMapCodexBackendResetCredits(await response.json());
					const offerRevision = credits && credits.availableCount > 0 ? paradisCodexResetOfferRevision(auth.accountId, credits, fetchedAt) : undefined;
					result = { offer: { homePath, credits, offerRevision, fetchedAt }, accountId: auth.accountId };
				}
			} catch (error) {
				this.options.logService.warn(`[ParadisCodexAccounts] failed to read reset credits: ${error instanceof Error ? error.message : error}`);
				result = { offer: { homePath, error: 'unavailable', fetchedAt }, accountId: auth.accountId };
			} finally {
				clearTimeout(timer);
			}
		}
		// 失敗もキャッシュする（パネルを描き直すたびに読み直さない）。
		this.offers.set(homePath, result);
		return result;
	}

	/**
	 * 手元にあるリセットクレジットの読み取り結果だけを返す（読みに行かない）。
	 * モバイルへの使用量に添える任意項目用。
	 */
	peekResetCredits(): Record<string, IParadisCodexResetCredits> {
		const result: Record<string, IParadisCodexResetCredits> = {};
		for (const [homePath, cached] of this.offers) {
			if (cached.offer.credits && this.now() - cached.offer.fetchedAt < RESET_CREDITS_CACHE_MS) {
				result[homePath] = cached.offer.credits;
			}
		}
		return result;
	}

	// ---------- リセットクレジット: 消費 ----------

	consumeResetCredit(request: IParadisCodexResetConsumeRequest): Promise<IParadisCodexResetConsumeResult> {
		if (!request || typeof request.homePath !== 'string' || typeof request.offerRevision !== 'string' || typeof request.idempotencyKey !== 'string'
			|| request.idempotencyKey.trim().length === 0 || request.idempotencyKey.length > 200) {
			return Promise.reject(new Error('invalid reset-credit request'));
		}
		const existing = this.inflightConsumes.get(request.idempotencyKey);
		if (existing) {
			return existing;
		}
		const run = this.consumeQueue.then(() => this.doConsume(request));
		this.consumeQueue = run.catch(() => { });
		this.inflightConsumes.set(request.idempotencyKey, run);
		void run.finally(() => this.inflightConsumes.delete(request.idempotencyKey)).catch(() => { });
		return run;
	}

	private async doConsume(request: IParadisCodexResetConsumeRequest): Promise<IParadisCodexResetConsumeResult> {
		await this.ledger.load();
		if (this.ledger.error) {
			return { kind: 'rejected', reason: 'ledgerUnavailable' };
		}
		const { homePath } = request;
		if (!await this.isKnownSignedInHome(homePath)) {
			return { kind: 'rejected', reason: 'unknownHome' };
		}
		const settled = this.ledger.get(request.idempotencyKey);
		if (settled?.state === 'settled' && settled.outcome) {
			return { kind: 'consumed', outcome: settled.outcome };
		}

		const cached = this.offers.get(homePath);
		const accountId = cached?.accountId ?? (await this.readAuth(homePath)).accountId;
		const accountScope = accountScopeOf(homePath, accountId);
		let key: string;
		let offerScope: string;
		const pendingKey = this.ledger.pendingKeyForAccount(accountScope);
		if (pendingKey !== undefined) {
			// 前回の要求の結果が分からない。新しい鍵で出すと2枚目が減りうるので、同じ鍵で再送する
			// （provider 側で1回にまとめられる）。
			const pending = this.ledger.get(pendingKey)!;
			key = pending.key;
			offerScope = pending.offerScope;
		} else {
			if (!cached || cached.offer.offerRevision === undefined || cached.offer.offerRevision !== request.offerRevision) {
				return { kind: 'rejected', reason: 'offerChanged' };
			}
			offerScope = `${accountScope}\n${request.offerRevision}`;
			const claimed = this.ledger.claimedKeyForOffer(offerScope);
			if (claimed !== undefined && claimed !== request.idempotencyKey) {
				return { kind: 'rejected', reason: 'alreadyAttempted' };
			}
			key = request.idempotencyKey;
		}

		// app-server を先に起こす。起動に失敗したら要求は出ていないので、台帳には何も書かない。
		const response = await this.withRpc(homePath, async rpc => {
			// 書けなければここで例外になり、provider へは出さない。
			await this.ledger.markProviderPending(key, offerScope, accountScope);
			try {
				return await rpc.request('account/rateLimitResetCredit/consume', { idempotencyKey: key }, CONSUME_TIMEOUT_MS) as { outcome?: unknown } | undefined;
			} catch (error) {
				if (paradisIsCodexAuthError(error)) {
					// 認証が無い・切れていると app-server は provider へ出す前に断る。使われていないので
					// 「結果不明」から外す（残すと、ログインし直した後も同じ鍵の再送から抜けられない）。
					await this.ledger.release(key);
				}
				// それ以外は結果が分からない。providerPending のまま残し、次の操作で同じ鍵を再送させる。
				throw error;
			}
		});
		const outcome = paradisCodexResetOutcome(response?.outcome);
		if (outcome === undefined) {
			// 結果が読めない。providerPending のまま残し、次の操作で同じ鍵を再送させる。
			throw new Error('unknown reset-credit outcome');
		}
		await this.ledger.markSettled(key, outcome);
		// 残数・枠が変わったので、次の表示で読み直す。
		this.offers.delete(homePath);
		return { kind: 'consumed', outcome };
	}

	private async withRpc<T>(homePath: string, run: (rpc: IParadisCodexAppServerRpc) => Promise<T>): Promise<T> {
		const env = { ...await this.options.resolveEnv(), CODEX_HOME: homePath };
		const command = await this.resolveCodexCommand(env);
		const rpc = await this.startRpc(command, env, this.options.logService, 'para-code-codex-accounts');
		try {
			return await run(rpc);
		} finally {
			rpc.dispose();
		}
	}
}

/**
 * 消費の範囲。同じ ChatGPT アカウントで2つのホームにログインしていても1つの範囲にするため、
 * account_id が分かるときはそれだけで決める（ホームごとにすると、片方の「結果不明」を無視して
 * もう片方から新しい鍵で消費できてしまう）。
 */
function accountScopeOf(homePath: string, accountId: string | undefined): string {
	return accountId !== undefined ? JSON.stringify(['account', accountId]) : JSON.stringify(['home', homePath]);
}

/** id_token（JWT）の payload からメールアドレスを読む（表示用。署名は検証しない）。 */
function emailFromIdToken(idToken: unknown): string | undefined {
	if (typeof idToken !== 'string') {
		return undefined;
	}
	try {
		const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
		if (typeof payload.email === 'string') {
			return payload.email;
		}
		const profile = payload['https://api.openai.com/profile'] as Record<string, unknown> | undefined;
		return typeof profile?.email === 'string' ? profile.email : undefined;
	} catch {
		return undefined;
	}
}
