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
//   - 使う操作は持たない（見せるだけ）。以前の版が置いた台帳（codex-reset-credit-ledger.json）は読まない

import * as fs from 'fs';
import * as os from 'os';
import { disposableTimeout, IntervalTimer } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { isAbsolute, join } from '../../../../base/common/path.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { onDidChangeParadisCodexHomes, paradisCodexHomes, paradisIsCodexConfigHome, paradisSetAdoptedCodexHomes } from '../../agentBrowser/node/paradisAgentHome.js';
import {
	IParadisCodexAccountSelection,
	IParadisCodexAccountsState,
	IParadisCodexHome,
	IParadisCodexSessionLinkSummary,
	IParadisCodexResetCreditOffer,
	IParadisCodexResetCredits,
	paradisCodexLaunchHomeFor,
	paradisMapCodexBackendResetCredits
} from '../common/paradisCodexAccounts.js';
import { paradisWriteFileAtomic } from '../../../node/paradisWriteFileAtomic.js';
import { paradisLinkCodexSessions } from './paradisCodexSessionLinker.js';

/** 読み取り結果を使い回す時間。パネルは30秒ごとに描き直すので、そのたびに読まない。 */
const RESET_CREDITS_CACHE_MS = 3 * 60_000;
const READ_TIMEOUT_MS = 20_000;
/** リセットクレジットの残りを読むバックエンドの URL（Orca と同じ。使用量の wham/usage の隣）。 */
const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
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
}

interface IStoredSelection extends IParadisCodexAccountSelection {
	/** 直前に選んでいたホーム（既定のホームなら undefined）。起動時のリンクの相手に使う。 */
	readonly previousHomePath?: string;
	/**
	 * 一度でも選んだホーム。手で作った名前のホームには、選ぶまで hook・MCP の設定を書かない
	 * （paradisAgentHome.ts の paradisCodexConfigHomes）。
	 */
	readonly adoptedHomePaths?: readonly string[];
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

	private readonly offers = new Map<string, ICachedOffer>();
	private readonly inflightReads = new Map<string, Promise<ICachedOffer>>();
	private readonly now: () => number;
	private readonly fetchImpl: typeof fetch;

	private readonly selectionPath: string;
	private readonly launchHomePath: string;
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
		this.selectionPath = join(options.stateDirectory, 'codex-account-selection.json');
		this.launchHomePath = join(options.stateDirectory, 'codex-launch-home');
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
			const parsed = JSON.parse(await fs.promises.readFile(this.selectionPath, 'utf8')) as { version?: unknown; homePath?: unknown; previousHomePath?: unknown; revision?: unknown; changedAt?: unknown; adoptedHomePaths?: unknown };
			if (parsed.version === 1 && typeof parsed.revision === 'number' && Number.isSafeInteger(parsed.revision)) {
				next = {
					homePath: typeof parsed.homePath === 'string' && isAbsolute(parsed.homePath) ? parsed.homePath : undefined,
					previousHomePath: typeof parsed.previousHomePath === 'string' && isAbsolute(parsed.previousHomePath) ? parsed.previousHomePath : undefined,
					revision: parsed.revision,
					changedAt: typeof parsed.changedAt === 'number' ? parsed.changedAt : undefined,
					adoptedHomePaths: Array.isArray(parsed.adoptedHomePaths) ? parsed.adoptedHomePaths.filter((entry): entry is string => typeof entry === 'string' && isAbsolute(entry)).slice(0, 100) : undefined,
				};
			}
		} catch {
			// 無い・壊れている → 既定のホーム
		}
		if (first) {
			if (next) {
				this.selection = next;
			}
			this.applyAdoptedHomes();
			return;
		}
		// 別のプロセスが書き換えた。そちらの revision はこちらの配ったものより小さいことがあり、
		// ウィンドウは古い revision を捨てるので、こちらの続きの番号で配り直す。
		const revision = Math.max(next?.revision ?? 0, this.selection.revision + 1);
		// 古い版は選んだことのあるホームを残さないので、こちらで覚えていたものと合わせる。
		const adoptedHomePaths = [...new Set([...(this.selection.adoptedHomePaths ?? []), ...(next?.adoptedHomePaths ?? [])])];
		this.selection = next ? { ...next, revision, adoptedHomePaths } : { revision, adoptedHomePaths };
		this.applyAdoptedHomes();
	}

	/** 一度でも選んだホームを、hook・MCP の設定を書く先（paradisCodexConfigHomes）へ知らせる。 */
	private applyAdoptedHomes(): void {
		if (this.options.homeDirectory === undefined) {
			paradisSetAdoptedCodexHomes(this.adoptedHomes());
		}
	}

	/**
	 * 設定を書いてよい、選んだことのあるホーム。今選んでいるホームも含める（選んだホームを覚える前の版で
	 * 選んだまま更新したときも、そのホームへ書く）。
	 */
	private adoptedHomes(): readonly string[] {
		const adopted = this.selection.adoptedHomePaths ?? [];
		const selected = this.selection.homePath;
		return selected !== undefined && !adopted.includes(selected) ? [...adopted, selected] : adopted;
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
			const state = await this.syncLaunchHomeFile(await this.buildState());
			// 呼んだウィンドウはこの内容を持ったので、次の見直しで同じ内容を配り直さない。
			this.lastStateKey = JSON.stringify(state);
			return state;
		});
	}

	/** ホームの増減を反映する。選択が消えていたら既定へ戻し、変わっていれば全ウィンドウへ知らせる。 */
	revalidate(): Promise<void> {
		return this.serializeSelection(async () => {
			await this.resetMissingSelection();
			const state = await this.syncLaunchHomeFile(await this.buildState());
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
				return this.syncLaunchHomeFile(await this.buildState());
			}
			// 手で作った名前のホームにも、選んだ時点から hook・MCP の設定を書く。
			const adoptedHomePaths = next !== undefined && !(this.selection.adoptedHomePaths ?? []).includes(next) ? [...(this.selection.adoptedHomePaths ?? []), next] : this.selection.adoptedHomePaths;
			await this.writeSelection({ homePath: next, previousHomePath: previous, revision: this.selection.revision + 1, changedAt: this.now(), adoptedHomePaths });
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
		const state = await this.syncLaunchHomeFile(await this.buildState());
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
				configurable: this.options.homeDirectory !== undefined
					? paradisIsCodexConfigHome(homePath, { homeDirectory: this.options.homeDirectory, configured: this.options.configuredHomes, adopted: this.adoptedHomes() })
					: paradisIsCodexConfigHome(homePath),
			});
		}
		return { homes, selection: { homePath: this.selection.homePath, revision: this.selection.revision, changedAt: this.selection.changedAt } };
	}

	/**
	 * ランチャーが読むファイル（{@link IParadisCodexAccountsState.launchHomeFile}）を今の選択に合わせ、書けていれば
	 * そのパスを状態に添える。中身は選んだホーム（ログイン済みのもの）か、選んでいなければ既定のホーム。
	 */
	private async syncLaunchHomeFile(state: IParadisCodexAccountsState): Promise<IParadisCodexAccountsState> {
		const launchHome = paradisCodexLaunchHomeFor(state) ?? state.homes.find(home => home.isDefault)?.homePath;
		if (launchHome === undefined) {
			return state;
		}
		// 消された・古い版が書き換えたときにも直るよう、覚えた値ではなくファイルの中身と比べる。
		const written = await fs.promises.readFile(this.launchHomePath, 'utf8').catch(() => undefined);
		if (written !== launchHome) {
			try {
				await paradisWriteFileAtomic(this.launchHomePath, launchHome, { newFileMode: 0o600, createParentMode: 0o700, fallbackToInPlace: false });
			} catch (error) {
				this.options.logService.warn('[ParadisCodexAccounts] could not write the Codex launch home for the terminal launcher', error);
				return state;
			}
		}
		return { ...state, launchHomeFile: this.launchHomePath };
	}

	private async writeSelection(next: IStoredSelection): Promise<void> {
		const selection: IStoredSelection = { ...next, adoptedHomePaths: next.adoptedHomePaths ?? this.selection.adoptedHomePaths };
		await paradisWriteFileAtomic(this.selectionPath, JSON.stringify({ version: 1, ...selection }), { newFileMode: 0o600, createParentMode: 0o700, fallbackToInPlace: false });
		this.selection = selection;
		this.applyAdoptedHomes();
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
		if (!await this.isKnownSignedInHome(homePath)) {
			return { homePath, error: 'auth', fetchedAt: this.now() };
		}
		const cached = this.offers.get(homePath);
		if (!bypassCache && cached && this.now() - cached.offer.fetchedAt < RESET_CREDITS_CACHE_MS) {
			return cached.offer;
		}
		let inflight = this.inflightReads.get(homePath);
		if (!inflight) {
			const promise = this.fetchResetCredits(homePath).finally(() => {
				if (this.inflightReads.get(homePath) === promise) {
					this.inflightReads.delete(homePath);
				}
			});
			this.inflightReads.set(homePath, inflight = promise);
		}
		return (await inflight).offer;
	}

	private async fetchResetCredits(homePath: string): Promise<ICachedOffer> {
		const fetchedAt = this.now();
		const auth = await this.readAuth(homePath);
		let result: ICachedOffer;
		if (!auth.accessToken) {
			result = { offer: { homePath, error: 'auth', fetchedAt } };
		} else {
			try {
				const response = await this.fetchImpl(RESET_CREDITS_URL, { method: 'GET', headers: codexBackendHeaders(auth.accessToken, auth.accountId), redirect: 'error', signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
				if (response.status === 401 || response.status === 403) {
					// トークンの更新は使用量の取得（limitsMonitor）が codex 自身にさせる。次の読み取りで直る。
					result = { offer: { homePath, error: 'auth', fetchedAt } };
				} else if (!response.ok) {
					result = { offer: { homePath, error: 'unavailable', fetchedAt } };
				} else {
					result = { offer: { homePath, credits: paradisMapCodexBackendResetCredits(await response.json()), fetchedAt } };
				}
			} catch (error) {
				this.options.logService.warn(`[ParadisCodexAccounts] failed to read reset credits: ${error instanceof Error ? error.message : error}`);
				result = { offer: { homePath, error: 'unavailable', fetchedAt } };
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
