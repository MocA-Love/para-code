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
//     使用量パネルからの追加・削除はすぐ、それ以外（手で消した等）は30秒ごとの見直しで全ウィンドウへ通知する
//   - 切り替えたら、切替元と切替先の2ホームの間だけ会話ログをハードリンクし合う
//     （paradisCodexSessionLinker.ts）。設定でやめられる
//   - SSH の接続先（REH）でも同じものが動き、接続先のホームについて選択を持つ
//     （paradisCodexAccounts.server.ts）。Para Code を更新した直後は、同じ接続先に古い版の REH が
//     しばらく残り、同じ選択のファイルを読み書きする。なので選択はファイルの印が変わるたびに読み直す
//
// リセットクレジット:
//   - 読み取り: ホームの auth.json のアクセストークンで ChatGPT のバックエンドを直接読む（使用量と
//     同じやり方。app-server は起こさない。トークンの更新は limitsMonitor が codex 自身にやらせる）
//   - 消費: Orca と同じく、バックエンドへ直接 `POST …/wham/rate-limit-reset-credits/consume` し、
//     本文に `redeem_request_id`（冪等の鍵）を付ける。二重消費は台帳（paradisCodexResetCreditLedger.ts）で
//     防ぐ。結果が分からない要求は、同じ `redeem_request_id` で再送する。消費は shared process の中で
//     1本ずつ直列に流すので、複数ウィンドウから同時に押しても provider へ出る要求は1つになる

import * as fs from 'fs';
import * as os from 'os';
import { disposableTimeout, IntervalTimer } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { isAbsolute, join } from '../../../../base/common/path.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { onDidChangeParadisCodexHomes, paradisCodexHomes } from '../../agentBrowser/node/paradisAgentHome.js';
import {
	IParadisCodexAccountSelection,
	IParadisCodexAccountsState,
	IParadisCodexHome,
	IParadisCodexSessionLinkSummary,
	IParadisCodexResetConsumeRequest,
	IParadisCodexResetConsumeResult,
	IParadisCodexResetCreditOffer,
	IParadisCodexResetCredits,
	ParadisCodexResetOutcome,
	paradisCodexResetOfferRevision,
	paradisMapCodexBackendResetCredits
} from '../common/paradisCodexAccounts.js';
import { paradisWriteFileAtomic } from '../../../node/paradisWriteFileAtomic.js';
import { ParadisCodexResetCreditLedger } from './paradisCodexResetCreditLedger.js';
import { paradisLinkCodexSessions } from './paradisCodexSessionLinker.js';

/** 読み取り結果を使い回す時間。パネルは30秒ごとに描き直すので、そのたびに読まない。 */
const RESET_CREDITS_CACHE_MS = 3 * 60_000;
const READ_TIMEOUT_MS = 20_000;
/** 消費は provider まで往復するので長め（Orca と同じ 30 秒）。 */
const CONSUME_TIMEOUT_MS = 30_000;
/** リセットクレジットの残りを読むバックエンドの URL（Orca と同じ。使用量の wham/usage の隣）。 */
const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
/** リセットクレジットを使うバックエンドの URL（Orca の codex-reset-credit-client.ts と同じ）。 */
const RESET_CREDITS_CONSUME_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume';

/** バックエンドの消費の結果の `code` を画面の outcome にする（Orca と同じ対応）。知らない値は undefined。 */
function outcomeOfBackendCode(code: unknown): ParadisCodexResetOutcome | undefined {
	switch (code) {
		case 'reset': return 'reset';
		case 'nothing_to_reset': return 'nothingToReset';
		case 'no_credit': return 'noCredit';
		case 'already_redeemed': return 'alreadyRedeemed';
		default: return undefined;
	}
}

/**
 * 消費の要求が HTTP のエラーで返ったときの台帳の扱い。
 * - release: 使われていないと分かる。記録を外す（初めて出した鍵が 401・403 で断られたときだけ）
 * - failed: 結果が確定した失敗（初めて出した鍵が、ほかの 4xx で断られたとき）
 * - pending: 使われたか分からない。結果不明のまま残し、同じ `redeem_request_id` で再送する
 *
 * 再送（`resend`）はどの応答でも pending。再送への応答から分かるのは再送そのものの扱いだけで、最初の
 * 要求（5xx・時間切れ・通信断で結果不明になったもの）が使われたかは分からないため。記録を外すと、次の
 * 操作が新しい鍵になり、2枚目が減りうる。429 は初めての鍵でも pending（ゲートウェイで断ったとは限らない）。
 * 409（同じ鍵を処理中の可能性）と 408・5xx も pending。
 */
export function paradisCodexResetHttpFailureOutcome(status: number, resend: boolean): 'release' | 'failed' | 'pending' {
	if (resend || status === 408 || status === 409 || status === 429 || status >= 500 || status < 400) {
		return 'pending';
	}
	return status === 401 || status === 403 ? 'release' : 'failed';
}

/** バックエンドが消費の要求を断った（HTTP のエラー）。扱いは {@link paradisCodexResetHttpFailureOutcome}。 */
class ParadisCodexResetHttpError extends Error {
	constructor(readonly status: number) {
		super(`Codex reset failed: HTTP ${status}`);
	}
}
/**
 * 起動してから会話ログのリンクを1回走らせるまでの待ち。前回の切替以降に切替元・切替先で増えた会話を
 * 拾うため。起動直後の混雑を避けて少し遅らせる。
 */
const STARTUP_LINK_DELAY_MS = 60_000;
/**
 * ホームの増減を見直す間隔。ホームディレクトリを監視しない（macOS ではホーム配下の全変更を受けうる）
 * かわりに、安い見直し（ホーム直下の一覧と auth.json の有無）をこの間隔で回す。使用量パネルからの
 * 追加・削除は paradisNotifyCodexHomesChanged ですぐ届く。
 */
const HOME_RECHECK_INTERVAL_MS = 30_000;

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

/** ファイルの印（inode・大きさ・更新時刻）。無い・読めなければ undefined。 */
async function fileStamp(filePath: string): Promise<string | undefined> {
	try {
		const stat = await fs.promises.stat(filePath);
		return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
	} catch {
		return undefined;
	}
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
	private readonly fetchImpl: typeof fetch;

	private readonly selectionPath: string;
	private readonly linkLedgerPath: string;
	private selection: IStoredSelection = { revision: 0 };
	/** 選択のファイルの読み直し（前のものが終わってから1本ずつ）。 */
	private selectionLoad: Promise<void> = Promise.resolve();
	/** 最後に読んだ・書いた選択のファイルの印（無ければ undefined）。変わったら読み直す。 */
	private selectionStamp: string | undefined;
	/** 選択のファイルを一度でも読んだか。 */
	private selectionLoaded = false;
	/** 選択の読み書き（選ぶ・見直す）は1本ずつ流す。同時に選ぶと同じ revision が2回出るため。 */
	private selectionQueue: Promise<unknown> = Promise.resolve();
	private lastStateKey: string | undefined;
	private linking: Promise<IParadisCodexSessionLinkSummary> = Promise.resolve({ linked: 0, skippedExisting: 0, skippedRemoved: 0, skippedOtherOrigin: 0, skippedUnsupported: 0, failed: 0 });
	private disposed = false;

	private readonly _onDidChangeState = this._register(new Emitter<IParadisCodexAccountsState>());
	/** 選択かホームの一覧が変わった（どのウィンドウから変えても、全ウィンドウへ届く）。 */
	readonly onDidChangeState: Event<IParadisCodexAccountsState> = this._onDidChangeState.event;

	constructor(protected readonly options: IParadisCodexAccountsServiceOptions) {
		super();
		this.now = options.now ?? Date.now;
		this.fetchImpl = options.fetch ?? fetch;
		this.ledger = new ParadisCodexResetCreditLedger(join(options.stateDirectory, 'codex-reset-credit-ledger.json'), this.now);
		this.selectionPath = join(options.stateDirectory, 'codex-account-selection.json');
		this.linkLedgerPath = join(options.stateDirectory, 'codex-session-links.json');
		if (!options.skipBackgroundWork) {
			this._register(disposableTimeout(() => {
				// 選ぶ・見直すと同じ列に並べる（書き込みの途中の印を「別のプロセスの変更」と取り違えない）
				void this.serializeSelection(() => this.loadSelection()).then(() => {
					if (this.selection.homePath !== undefined) {
						this.linkBetween(this.selection.previousHomePath, this.selection.homePath);
					}
				});
			}, STARTUP_LINK_DELAY_MS));
			this._register(onDidChangeParadisCodexHomes(() => void this.revalidate()));
			const recheck = this._register(new IntervalTimer());
			recheck.cancelAndSet(() => void this.revalidate(), HOME_RECHECK_INTERVAL_MS);
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

	// ---------- 切替 ----------

	/**
	 * 選択のファイルを、前に読んだ・書いたときから変わっていれば読み直す。自分以外（同じ接続先に残った
	 * 古い版の REH）が書き換えることがあるので、一度読んだら終わりにしない。
	 */
	private loadSelection(): Promise<void> {
		const run = this.selectionLoad.then(() => this.reloadSelectionIfChanged());
		this.selectionLoad = run.catch(() => undefined);
		return run;
	}

	private async reloadSelectionIfChanged(): Promise<void> {
		const stamp = await fileStamp(this.selectionPath);
		if (this.selectionLoaded && stamp === this.selectionStamp) {
			return;
		}
		const first = !this.selectionLoaded;
		this.selectionLoaded = true;
		this.selectionStamp = stamp;
		let next: IStoredSelection | undefined;
		try {
			const parsed = JSON.parse(await fs.promises.readFile(this.selectionPath, 'utf8')) as { version?: unknown; homePath?: unknown; previousHomePath?: unknown; revision?: unknown; changedAt?: unknown };
			if (parsed.version === 1 && typeof parsed.revision === 'number' && Number.isSafeInteger(parsed.revision)) {
				next = {
					homePath: typeof parsed.homePath === 'string' && isAbsolute(parsed.homePath) ? parsed.homePath : undefined,
					previousHomePath: typeof parsed.previousHomePath === 'string' && isAbsolute(parsed.previousHomePath) ? parsed.previousHomePath : undefined,
					revision: parsed.revision,
					changedAt: typeof parsed.changedAt === 'number' ? parsed.changedAt : undefined,
				};
			}
		} catch {
			// 無い・壊れている → 既定のホーム
		}
		if (first) {
			if (next) {
				this.selection = next;
			}
			return;
		}
		// 別のプロセスが書き換えた。そちらの revision はこちらの配ったものより小さいことがあり、
		// ウィンドウは古い revision を捨てるので、こちらの続きの番号で配り直す。
		const revision = Math.max(next?.revision ?? 0, this.selection.revision + 1);
		this.selection = next ? { ...next, revision } : { revision };
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
			const state = await this.buildState();
			// 呼んだウィンドウはこの内容を持ったので、次の見直しで同じ内容を配り直さない。
			this.lastStateKey = JSON.stringify(state);
			return state;
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
		await paradisWriteFileAtomic(this.selectionPath, JSON.stringify({ version: 1, ...selection }), { newFileMode: 0o600, createParentMode: 0o700, fallbackToInPlace: false });
		this.selection = selection;
		// 自分で書いたものを、次の読み直しで「別のプロセスが書き換えた」と取り違えない。
		this.selectionStamp = await fileStamp(this.selectionPath);
		this.selectionLoaded = true;
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
			const summary = await paradisLinkCodexSessions(signedIn, { ledgerPath: this.linkLedgerPath, observeHomes: this.knownHomes(), shouldStop: () => this.disposed });
			if (summary.ledgerUnavailable) {
				this.options.logService.warn('[ParadisCodexAccounts] the Codex session link ledger was unreadable; moved it aside and skipped linking');
			}
			this.options.logService.info(`[ParadisCodexAccounts] linked Codex sessions between ${signedIn.length} homes: ${summary.linked} linked, ${summary.skippedExisting} existing, ${summary.skippedRemoved} removed by the user, ${summary.skippedOtherOrigin} from other homes, ${summary.skippedUnsupported} unsupported, ${summary.failed} failed`);
			return summary;
		}).catch(error => {
			this.options.logService.warn('[ParadisCodexAccounts] failed to link Codex sessions', error);
			return { linked: 0, skippedExisting: 0, skippedRemoved: 0, skippedOtherOrigin: 0, skippedUnsupported: 0, failed: 1 };
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
				const response = await this.fetchImpl(RESET_CREDITS_URL, { method: 'GET', headers: codexBackendHeaders(auth.accessToken, auth.accountId), redirect: 'error', signal: controller.signal });
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
		// 確認した後にそのホームで別のアカウントへログインし直していたら、確認した内容とは別のアカウントを
		// 消費することになる。今の auth.json を読み直し、食い違えば断る。
		const accountId = (await this.readAuth(homePath)).accountId;
		if (cached && cached.accountId !== undefined && accountId !== undefined && cached.accountId !== accountId) {
			this.offers.delete(homePath);
			return { kind: 'rejected', reason: 'offerChanged' };
		}
		const accountScope = accountScopeOf(homePath, accountId);
		let key: string;
		let offerScope: string;
		const pendingKey = this.ledger.pendingKeyForAccount(accountScope);
		// 結果が分からない前回の要求の再送か。再送への応答から分かるのは「その再送が使われたか」だけで、
		// 最初の要求が使われたかは分からない。
		const resend = pendingKey !== undefined;
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

		const auth = await this.readAuth(homePath);
		if (!auth.accessToken) {
			// 要求は出ていないので、台帳には何も書かない。
			this.offers.delete(homePath);
			throw new Error('Codex not signed in');
		}
		// 書けなければここで例外になり、provider へは出さない。
		await this.ledger.markProviderPending(key, offerScope, accountScope);
		let code: unknown;
		try {
			code = await this.postConsume(auth.accessToken, auth.accountId, key);
		} catch (error) {
			if (error instanceof ParadisCodexResetHttpError) {
				const outcome = paradisCodexResetHttpFailureOutcome(error.status, resend);
				if (outcome === 'release') {
					// 初めて出した鍵が認証で断られた（使う前に断られている）。「結果不明」から外す
					// （残すと、ログインし直した後も同じ鍵の再送から抜けられない）。
					await this.ledger.release(key);
				} else if (outcome === 'failed') {
					// 初めて出した鍵が断られた（結果が確定した失敗）。結果不明にはせず、同じ提示への2回目は断る。
					// 読み直した新しい提示なら押せる。
					await this.ledger.markFailed(key);
				}
				// それ以外は providerPending のまま残し、同じ鍵で再送させる。
				this.offers.delete(homePath);
			}
			// 通信の失敗・時間切れも結果が分からない。providerPending のまま残し、次の操作で同じ鍵を再送させる。
			throw error;
		}
		const outcome = outcomeOfBackendCode(code);
		if (outcome === undefined) {
			// 結果が読めない。providerPending のまま残し、次の操作で同じ鍵を再送させる。
			throw new Error('unknown reset-credit outcome');
		}
		await this.ledger.markSettled(key, outcome);
		// 残数・枠が変わったので、次の表示で読み直す。
		this.offers.delete(homePath);
		return { kind: 'consumed', outcome };
	}

	/** バックエンドへ消費を送り、応答の `code` を返す。断られたら {@link ParadisCodexResetHttpError}。 */
	private async postConsume(accessToken: string, accountId: string | undefined, redeemRequestId: string): Promise<unknown> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), CONSUME_TIMEOUT_MS);
		try {
			const response = await this.fetchImpl(RESET_CREDITS_CONSUME_URL, {
				method: 'POST',
				headers: { ...codexBackendHeaders(accessToken, accountId), 'Content-Type': 'application/json' },
				// トークンと冪等の鍵を chatgpt.com の外へ転送させない
				redirect: 'error',
				body: JSON.stringify({ redeem_request_id: redeemRequestId }),
				signal: controller.signal,
			});
			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);
				throw new ParadisCodexResetHttpError(response.status);
			}
			const payload = await response.json() as { code?: unknown } | null;
			return payload?.code;
		} finally {
			clearTimeout(timer);
		}
	}
}

/**
 * ChatGPT のバックエンドへの要求の見出し。Orca（`main/rate-limits/codex-backend-auth.ts` の
 * `getCodexBackendAuthHeaders`）と同じ値にする（バックエンドがこれらを見て断ることがありうるため）。
 */
function codexBackendHeaders(accessToken: string, accountId: string | undefined): Record<string, string> {
	return {
		'Authorization': `Bearer ${accessToken}`,
		'User-Agent': 'codex-cli',
		'OpenAI-Beta': 'codex-1',
		'originator': 'Codex Desktop',
		...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
	};
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
