/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Codex のアカウント（ホーム）まわりの shared process 側の実体。
//
// 切替（全ウィンドウ共通、q.html Q07）:
//   - 選択は userData 配下の JSON に1つだけ持ち、変わったら全ウィンドウへ通知する。renderer は
//     それを受けて、新しく開くターミナルへ `CODEX_HOME` を渡す（paradisCodexLaunchHomeService.ts）
//   - 切り替えたら、会話ログをアカウント用ホームどうしでハードリンクし合う（paradisCodexSessionLinker.ts）
//
// リセットクレジット:
//   - 読み取り: `CODEX_HOME=<ホーム> codex app-server` の `account/rateLimits/read` の
//     `rateLimitResetCredits`。パネルを開いたときだけ読み、数分はキャッシュを返す
//   - 消費: 同じ app-server の `account/rateLimitResetCredit/consume`。二重消費は台帳
//     （paradisCodexResetCreditLedger.ts）で防ぐ。消費は shared process の中で1本ずつ直列に流す
//     ので、複数ウィンドウから同時に押しても provider へ出る要求は1つになる

import * as fs from 'fs';
import * as os from 'os';
import { disposableTimeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { delimiter, dirname, isAbsolute, join, resolve } from '../../../../base/common/path.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisCodexHomes, paradisRegisterCodexHome } from '../../agentBrowser/node/paradisAgentHome.js';
import {
	IParadisCodexAccountSelection,
	IParadisCodexAccountsState,
	IParadisCodexHome,
	IParadisCodexSessionLinkSummary,
	IParadisCodexResetConsumeRequest,
	IParadisCodexResetConsumeResult,
	IParadisCodexResetCreditOffer,
	paradisCodexResetOfferRevision,
	paradisCodexResetOutcome,
	paradisMapCodexResetCredits
} from '../common/paradisCodexAccounts.js';
import { IParadisCodexAppServerRpc, ParadisCodexAppServerRpcFactory, paradisIsCodexAuthError, paradisStartCodexAppServerRpc } from './paradisCodexAppServerRpc.js';
import { ParadisCodexResetCreditLedger } from './paradisCodexResetCreditLedger.js';
import { paradisLinkCodexSessions } from './paradisCodexSessionLinker.js';

/** 読み取り結果を使い回す時間。パネルは30秒ごとに描き直すので、そのたびに app-server を起こさない。 */
const RESET_CREDITS_CACHE_MS = 3 * 60_000;
const READ_TIMEOUT_MS = 20_000;
/** 消費は provider まで往復するので長め。 */
const CONSUME_TIMEOUT_MS = 45_000;
/**
 * 起動してから会話ログのリンクを1回走らせるまでの待ち。前回の切替以降に別のホームで増えた会話を
 * 拾うため。起動直後の混雑を避けて少し遅らせる。
 */
const STARTUP_LINK_DELAY_MS = 60_000;

export interface IParadisCodexAccountsServiceOptions {
	readonly logService: ILogService;
	/** 台帳などを置くディレクトリ（shared process では userData 配下）。 */
	readonly stateDirectory: string;
	/** codex を探すときの環境（ログインシェルの PATH を含むもの）。 */
	readonly resolveEnv: () => Promise<NodeJS.ProcessEnv>;
	/** 設定で足した Codex ホーム（paradis.limitsMonitor.codexHomes）。 */
	readonly extraHomes?: () => readonly string[];
	/** テスト用の差し替え口。 */
	readonly homeDirectory?: string;
	readonly startRpc?: ParadisCodexAppServerRpcFactory;
	readonly resolveCodexCommand?: (env: NodeJS.ProcessEnv) => Promise<string>;
	readonly now?: () => number;
	/** テストで起動時のリンクを止める。 */
	readonly skipStartupLink?: boolean;
}

interface ICachedOffer {
	readonly offer: IParadisCodexResetCreditOffer;
	readonly accountId: string | undefined;
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

	private readonly selectionPath: string;
	private selection: IParadisCodexAccountSelection = { revision: 0 };
	private selectionLoad: Promise<void> | undefined;
	private selectionWrite: Promise<unknown> = Promise.resolve();
	private linking: Promise<IParadisCodexSessionLinkSummary> | undefined;
	private disposed = false;

	private readonly _onDidChangeState = this._register(new Emitter<IParadisCodexAccountsState>());
	/** 選択が変わった（どのウィンドウから変えても、全ウィンドウへ届く）。 */
	readonly onDidChangeState: Event<IParadisCodexAccountsState> = this._onDidChangeState.event;

	constructor(protected readonly options: IParadisCodexAccountsServiceOptions) {
		super();
		this.now = options.now ?? Date.now;
		this.startRpc = options.startRpc ?? paradisStartCodexAppServerRpc;
		this.resolveCodexCommand = options.resolveCodexCommand ?? paradisResolveCodexCommand;
		this.ledger = new ParadisCodexResetCreditLedger(join(options.stateDirectory, 'codex-reset-credit-ledger.json'), this.now);
		this.selectionPath = join(options.stateDirectory, 'codex-account-selection.json');
		if (!options.skipStartupLink) {
			this._register(disposableTimeout(() => {
				void this.loadSelection().then(() => {
					if (this.selection.homePath !== undefined) {
						void this.linkSessions();
					}
				});
			}, STARTUP_LINK_DELAY_MS));
		}
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}

	// ---------- 切替 ----------

	private loadSelection(): Promise<void> {
		if (!this.selectionLoad) {
			this.selectionLoad = (async () => {
				try {
					const parsed = JSON.parse(await fs.promises.readFile(this.selectionPath, 'utf8')) as { version?: unknown; homePath?: unknown; revision?: unknown; changedAt?: unknown };
					if (parsed.version === 1 && typeof parsed.revision === 'number' && Number.isSafeInteger(parsed.revision)) {
						this.selection = {
							homePath: typeof parsed.homePath === 'string' && isAbsolute(parsed.homePath) ? parsed.homePath : undefined,
							revision: parsed.revision,
							changedAt: typeof parsed.changedAt === 'number' ? parsed.changedAt : undefined,
						};
						this.registerSelectedHome(this.selection.homePath);
					}
				} catch {
					// 無い・壊れている → 既定のホーム
				}
			})();
		}
		return this.selectionLoad;
	}

	/** アカウント用ホームの一覧（既定のホームを先頭に、ログイン済みのものだけ）と選択。 */
	async getState(): Promise<IParadisCodexAccountsState> {
		await this.loadSelection();
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
				email: signedIn ? await this.readEmail(homePath) : undefined,
			});
		}
		return { homes, selection: this.selection };
	}

	/**
	 * 新しく開くターミナルで使う Codex のホームを選ぶ。undefined か既定のホームを渡すと既定へ戻す。
	 * 一覧に無い・ログインしていないホームは受け付けない（任意のパスを CODEX_HOME にさせない）。
	 */
	async selectHome(homePath: string | undefined): Promise<IParadisCodexAccountsState> {
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
		if (next !== this.selection.homePath) {
			const selection: IParadisCodexAccountSelection = { homePath: next, revision: this.selection.revision + 1, changedAt: this.now() };
			await this.writeSelection(selection);
			this.selection = selection;
			this.registerSelectedHome(next);
			const state = await this.getState();
			this._onDidChangeState.fire(state);
			// 切り替えた先で過去の会話を開けるよう、裏で会話ログをリンクし合う。
			void this.linkSessions();
			return state;
		}
		return this.getState();
	}

	private async writeSelection(selection: IParadisCodexAccountSelection): Promise<void> {
		const run = this.selectionWrite.then(async () => {
			await fs.promises.mkdir(dirname(this.selectionPath), { recursive: true });
			const temporaryPath = `${this.selectionPath}.${process.pid}.${this.now()}.tmp`;
			await fs.promises.writeFile(temporaryPath, JSON.stringify({ version: 1, ...selection }), { encoding: 'utf8', mode: 0o600 });
			await fs.promises.rename(temporaryPath, this.selectionPath);
		});
		this.selectionWrite = run.catch(() => { });
		return run;
	}

	/** ログイン済みのアカウント用ホームどうしで会話ログをハードリンクし合う。同時には1本だけ。 */
	linkSessions(): Promise<IParadisCodexSessionLinkSummary> {
		if (!this.linking) {
			this.linking = (async () => {
				const homes: string[] = [];
				for (const homePath of this.knownHomes()) {
					if (await this.fileExists(join(homePath, 'auth.json'))) {
						homes.push(homePath);
					}
				}
				const summary = await paradisLinkCodexSessions(homes, { shouldStop: () => this.disposed });
				this.options.logService.info(`[ParadisCodexAccounts] linked Codex sessions across ${homes.length} homes: ${summary.linked} linked, ${summary.skippedExisting} existing, ${summary.skippedUnsupported} unsupported, ${summary.failed} failed`);
				return summary;
			})().finally(() => {
				this.linking = undefined;
			});
		}
		return this.linking;
	}

	/**
	 * 設定で足した場所（~/.codex* 以外）のホームを選んだとき、transcript の許可 root などにも
	 * 入るよう一覧へ加える。
	 */
	private registerSelectedHome(homePath: string | undefined): void {
		if (homePath !== undefined && this.options.homeDirectory === undefined) {
			paradisRegisterCodexHome(homePath);
		}
	}

	private homeLabel(homePath: string): string {
		const home = this.options.homeDirectory ?? os.homedir();
		return homePath === home || homePath.startsWith(home + '/') || homePath.startsWith(home + '\\') ? `~${homePath.slice(home.length)}` : homePath;
	}

	/** id_token（JWT）の payload からメールアドレスを読む（表示用。署名は検証しない）。 */
	private async readEmail(homePath: string): Promise<string | undefined> {
		try {
			const auth = JSON.parse(await fs.promises.readFile(join(homePath, 'auth.json'), 'utf8')) as { tokens?: { id_token?: unknown } };
			const idToken = auth.tokens?.id_token;
			if (typeof idToken !== 'string') {
				return undefined;
			}
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

	private async fileExists(filePath: string): Promise<boolean> {
		try {
			await fs.promises.access(filePath, fs.constants.F_OK);
			return true;
		} catch {
			return false;
		}
	}

	// ---------- ホーム ----------

	/** Para Code が扱う Codex ホームの一覧（既定のホームを先頭に、設定で足したものを後ろに）。 */
	protected knownHomes(): string[] {
		const homes = new Set<string>(paradisCodexHomes(this.options.homeDirectory));
		const home = this.options.homeDirectory ?? os.homedir();
		for (const extra of this.options.extraHomes?.() ?? []) {
			if (typeof extra !== 'string' || extra.trim().length === 0) {
				continue;
			}
			const expanded = extra.startsWith('~') ? join(home, extra.slice(1)) : extra;
			if (isAbsolute(expanded)) {
				homes.add(resolve(expanded));
			}
		}
		return [...homes];
	}

	/** 一覧にあり、ログイン済み（auth.json がある）ホームか。任意のパスで codex を起動しないための関所。 */
	protected async isKnownSignedInHome(homePath: string): Promise<boolean> {
		if (typeof homePath !== 'string' || !isAbsolute(homePath) || !this.knownHomes().includes(homePath)) {
			return false;
		}
		try {
			await fs.promises.access(join(homePath, 'auth.json'), fs.constants.F_OK);
			return true;
		} catch {
			return false;
		}
	}

	/** auth.json の account_id（読むだけ）。無ければ undefined。 */
	protected async readAccountId(homePath: string): Promise<string | undefined> {
		try {
			const auth = JSON.parse(await fs.promises.readFile(join(homePath, 'auth.json'), 'utf8')) as { tokens?: { account_id?: unknown } };
			const accountId = auth.tokens?.account_id;
			return typeof accountId === 'string' && accountId.trim().length > 0 ? accountId.trim() : undefined;
		} catch {
			return undefined;
		}
	}

	private async withRpc<T>(homePath: string, run: (rpc: IParadisCodexAppServerRpc) => Promise<T>): Promise<T> {
		const env = { ...await this.options.resolveEnv(), CODEX_HOME: homePath };
		const command = await this.resolveCodexCommand(env);
		const rpc = await this.startRpc(command, env, this.options.logService);
		try {
			return await run(rpc);
		} finally {
			rpc.dispose();
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
		let result: ICachedOffer;
		try {
			const response = await this.withRpc(homePath, rpc => rpc.request('account/rateLimits/read', {}, READ_TIMEOUT_MS)) as { rateLimitResetCredits?: unknown; accountId?: unknown } | undefined;
			const accountId = typeof response?.accountId === 'string' && response.accountId.length > 0 ? response.accountId : await this.readAccountId(homePath);
			const credits = paradisMapCodexResetCredits(response?.rateLimitResetCredits);
			const offerRevision = credits && credits.availableCount > 0 ? paradisCodexResetOfferRevision(accountId, credits, fetchedAt) : undefined;
			result = { offer: { homePath, credits, offerRevision, fetchedAt }, accountId };
		} catch (error) {
			this.options.logService.warn(`[ParadisCodexAccounts] failed to read reset credits: ${error instanceof Error ? error.message : error}`);
			// 失敗もキャッシュする（パネルを描き直すたびに app-server を起こし直さない）。
			result = { offer: { homePath, error: paradisIsCodexAuthError(error) ? 'auth' : 'unavailable', fetchedAt }, accountId: await this.readAccountId(homePath) };
		}
		this.offers.set(homePath, result);
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
		const accountId = cached?.accountId ?? await this.readAccountId(homePath);
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

		// 書けなければここで例外になり、provider へは出さない。
		await this.ledger.markProviderPending(key, offerScope, accountScope);
		const response = await this.withRpc(homePath, rpc => rpc.request('account/rateLimitResetCredit/consume', { idempotencyKey: key }, CONSUME_TIMEOUT_MS)) as { outcome?: unknown } | undefined;
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
}

function accountScopeOf(homePath: string, accountId: string | undefined): string {
	return JSON.stringify([homePath, accountId ?? null]);
}
