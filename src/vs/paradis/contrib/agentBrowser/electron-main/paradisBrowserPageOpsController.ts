/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP の追加のブラウザ操作のうち、タブそのものに掛けるもの（追加ヘッダ・HTTP 認証・
// リクエストのルール）と、PDF・ハイライトを electron-main で行う。
//
// 決め事:
// - ネットワークの上書きを掛けるのは、呼んだペインだけが使う保存領域のタブだけ（判定は呼び出し側の
//   paradisCdpTargetService.ts と renderer）。HTTP 認証のキャッシュと HTTP キャッシュは保存領域単位なので、
//   共有の保存領域に掛けるとほかのタブ・ほかのペインへ残るため。
// - 上書きは「タブ（webContents）1枚」に付けた専用の CDP セッションで有効にするので、同じ保存領域の
//   他のタブには届かない。
// - 外すときは、有効にしたもの（Fetch・Network・キャッシュの無効化・Service Worker の迂回・ハイライト）を
//   自分で戻す。upstream の BrowserViewDebugger はセッションの `Target.detachFromTarget` に失敗して
//   （空の session id）セッションを残すので、「セッションを外せば元に戻る」を頼りにしない。専用の
//   セッションはタブが閉じるまで使い回し（エージェントが手放しても残す）、タブ1枚につき1つまでにする。
// - 1枚のタブに上書きを掛けられるのは1つのペインだけ（持ち主）。別のペインは断られる。
// - 持ち主の共有が入れ替わった（shared process が世代を進めた）・エージェントがタブを手放した・
//   タブが閉じた・プロファイルに別のタブが開かれた、のどれでも外す。外すときは、掛けた時点の保存領域の
//   認証のキャッシュと HTTP キャッシュも消す（閉じたタブでも）。
// - HTTP 認証の資格情報はこのプロセスのメモリにだけ置く。ログにも応答にも出さない。
// - 追加ヘッダは相手の origin を見て付ける（既定は掛けた時点のトップフレームの origin だけ）。
// - 上書きを掛けている間はそのタブのキャッシュと Service Worker を通さない（ルールとヘッダが
//   すり抜けないように）。
// - 遷移・再読み込みの後も動くスクリプト（add_init_script）も同じ専用のセッションで置く。どのタブにも
//   置ける（q.html Q240）が、持ち主の共有が入れ替わる・エージェントがタブを手放す・タブが閉じる、の
//   どれでも外す。複数のペインが同じタブに置ける（一覧と削除は自分の分だけ）。

import { raceTimeout } from '../../../../base/common/async.js';
import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import type { CDPEvent, ICDPConnection } from '../../../../platform/browserView/common/cdp/types.js';
import {
	IParadisHighlightRect,
	IParadisExtraHeaders,
	IParadisInitScriptInfo,
	IParadisInitScriptRequest,
	IParadisInitScriptsResult,
	IParadisHttpCredentials,
	IParadisPageOverridesRequest,
	IParadisPageOverridesResult,
	IParadisPageOverridesSummary,
	IParadisPdfOptions,
	IParadisRequestRule,
	paradisApplyExtraHeaders,
	paradisApplyHeaderRule,
	paradisBuildRedirectHeaders,
	paradisBuildRespondHeaders,
	paradisMatchUrlPattern,
	PARADIS_INIT_SCRIPT_MAX_PER_TAB,
} from '../common/paradisBrowserPageOps.js';

/** Electron の `login` イベントの認証の情報のうち、使うもの。 */
export interface IParadisLoginAuthInfo {
	readonly isProxy: boolean;
	readonly host: string;
	readonly port: number;
	readonly realm: string;
}

export type ParadisLoginListener = (event: { preventDefault(): void }, details: { readonly url: string }, authInfo: IParadisLoginAuthInfo, callback: (username?: string, password?: string) => void) => void;

/** タブの保存領域（Electron の session）のうち、上書きを外すときに使うもの。 */
export interface IParadisPageOpsStorage {
	/** HTTP 認証のキャッシュを消す（答えた資格情報を、保存領域のほかのタブに使わせない）。 */
	clearAuthCache(): Promise<void>;
	/** HTTP キャッシュを消す（書き換えた要求への応答を、上書きを外した後に出さない）。 */
	clearCache(): Promise<void>;
}

/**
 * このコントローラが使うタブ（BrowserView）の部分。Electron の具象型ではなく構造で受け、
 * テストから偽物を渡せるようにしてある。
 */
export interface IParadisPageOpsTarget {
	readonly webContents: {
		isDestroyed(): boolean;
		getURL(): string;
		getTitle(): string;
		getZoomFactor(): number;
		once(event: 'destroyed', listener: () => void): unknown;
		removeListener(event: 'destroyed', listener: () => void): unknown;
		on(event: 'login', listener: ParadisLoginListener): unknown;
		removeListener(event: 'login', listener: ParadisLoginListener): unknown;
		printToPDF(options: object): Promise<Uint8Array>;
		readonly session: IParadisPageOpsStorage;
	};
	readonly debugger: {
		attach(): Promise<ICDPConnection>;
	};
}

/** 同じ相手の認証の求めに答える回数（間違ったパスワードで回り続けないため）。 */
const MAX_AUTH_ANSWERS_PER_REALM = 2;
const AUTH_ANSWER_WINDOW_MS = 60_000;
/** 持ち主ごとの世代の高水位を覚えておく数。 */
const MAX_OWNER_WATERMARKS = 4096;
/** PDF を作るのを待つ上限。 */
const PDF_TIMEOUT_MS = 60_000;
/** 上書きに使うセッションの Network のバッファ（本文を読むことは無いので小さくする）。 */
const NETWORK_BUFFER_BYTES = 1024 * 1024;

/** ネットワークの上書きを外すときに送る、有効にしたものを戻すコマンド（順番どおり）。 */
const NETWORK_TEARDOWN_COMMANDS: readonly (readonly [string, object])[] = [
	['Fetch.disable', {}],
	['Network.setExtraHTTPHeaders', { headers: {} }],
	['Network.setCacheDisabled', { cacheDisabled: false }],
	['Network.setBypassServiceWorker', { bypass: false }],
	['Network.disable', {}],
];

/** ハイライトを消すとき・セッションを手放すときに送るコマンド。 */
const HIGHLIGHT_HIDE_COMMAND: readonly [string, object] = ['Overlay.hideHighlight', {}];
const OVERLAY_TEARDOWN_COMMANDS: readonly (readonly [string, object])[] = [
	['Overlay.hideHighlight', {}],
	['Overlay.disable', {}],
	['DOM.disable', {}],
];

/**
 * タブ1枚に付けた、このコントローラ専用の CDP セッション。上書きとハイライトで共用し、タブが閉じるまで
 * 使い回す（エージェントが手放しても残し、次の共有でも使う）。タブ1枚につき最大1つ。外すときは有効にしたものを自分で戻す（`Target.detachFromTarget` が失敗して
 * セッションが残っても、止めたままの要求やハイライトが残らないように）。
 */
interface ITargetSession {
	readonly session: ICDPConnection;
	readonly store: DisposableStore;
	networkEnabled: boolean;
	fetchEnabled: boolean;
	overlayEnabled: boolean;
	/** add_init_script のために Page を有効にした。 */
	pageEnabled: boolean;
}

/** タブに置いたスクリプト（add_init_script）。 */
interface IInitScript {
	readonly info: IParadisInitScriptInfo;
	readonly ownerKey: string;
	readonly generation: number;
	/** `Page.addScriptToEvaluateOnNewDocument` が返した識別子。 */
	readonly identifier: string;
	/** 置いたセッション（セッションが替わったら、もう効いていない）。 */
	readonly session: ICDPConnection;
}

interface IViewState {
	readonly ownerKey: string;
	generation: number;
	/** 上書きを掛けた時点の保存領域。タブが閉じた後も、認証とキャッシュを消すのに使う。 */
	readonly storage: IParadisPageOpsStorage;
	/** 保存領域がプロファイル（ほかのタブが後から開かれうる）。 */
	readonly sharedProfile: boolean;
	extraHeaders: IParadisExtraHeaders | undefined;
	credentials: IParadisHttpCredentials | undefined;
	rules: readonly IParadisRequestRule[];
	ruleMatches: number[];
	/** ヘッダかルールを一度でも掛けた（外すときに HTTP キャッシュを消す）。 */
	touchedCache: boolean;
	loginListener: ParadisLoginListener | undefined;
	readonly authAnswers: Map<string, { count: number; firstAt: number }>;
	/** 同じタブへの操作を1つずつ行うための鎖。 */
	queue: Promise<unknown>;
	disposed: boolean;
}

interface IHighlightState {
	readonly timer: ReturnType<typeof setTimeout>;
}

/** http(s) の URL なら origin、それ以外（about:blank など）は undefined。 */
function paradisHttpOrigin(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
	} catch {
		return undefined;
	}
}

export class ParadisBrowserPageOpsController {

	private readonly states = new Map<IParadisPageOpsTarget, IViewState>();
	private readonly ownerWatermarks = new Map<string, number>();
	private readonly highlights = new Map<IParadisPageOpsTarget, IHighlightState>();
	private readonly targetSessions = new Map<IParadisPageOpsTarget, ITargetSession>();
	private readonly pendingSessions = new Map<IParadisPageOpsTarget, Promise<ITargetSession>>();
	private readonly destroyedListeners = new Map<IParadisPageOpsTarget, () => void>();
	private readonly initScripts = new Map<IParadisPageOpsTarget, IInitScript[]>();
	private nextInitScriptId = 1;

	constructor(
		private readonly now: () => number = Date.now,
		/** 外すときに戻せなかったもの（ログに出す）。閉じたタブへのものは呼ばない。 */
		private readonly onTeardownFailure: (step: string, error: unknown) => void = () => { },
		/** タブに置かれたスクリプトの本数が変わった（ワークベンチにバナーを出すため）。 */
		private readonly onDidChangeInitScripts: (target: IParadisPageOpsTarget, count: number) => void = () => { },
	) { }

	/** 台帳を書き換え、本数が変わったら知らせる。 */
	private setInitScripts(target: IParadisPageOpsTarget, scripts: IInitScript[] | undefined): void {
		const before = this.initScripts.get(target)?.length ?? 0;
		if (scripts !== undefined && scripts.length > 0) {
			this.initScripts.set(target, scripts);
		} else {
			this.initScripts.delete(target);
		}
		const after = scripts?.length ?? 0;
		if (before !== after) {
			this.onDidChangeInitScripts(target, after);
		}
	}

	/** スクリプトが置かれているタブと本数（ワークベンチが開いたときの初めの状態）。 */
	initScriptCounts(): [IParadisPageOpsTarget, number][] {
		return [...this.initScripts].map(([target, scripts]) => [target, scripts.length]);
	}

	/** 利用者が外した。どのペインのものもすべて外す。外した数を返す。 */
	removeAllInitScripts(target: IParadisPageOpsTarget): Promise<number> {
		return this.removeScripts(target, () => true);
	}

	/** タブに掛かっている上書きの要約。持ち主でなければ上書きの中身は見せない。 */
	summary(target: IParadisPageOpsTarget, ownerKey: string): IParadisPageOverridesResult {
		const state = this.states.get(target);
		if (!state) {
			return { ok: true, summary: { extraHeaderNames: [], rules: [] } };
		}
		if (state.ownerKey !== ownerKey) {
			return { ok: false, reason: 'ownedByAnotherPane' };
		}
		return { ok: true, summary: this.summarize(state) };
	}

	/**
	 * 上書きを置き換える。値の無い項目はそのまま、`null` は外す。`sharedProfile` はタブの保存領域が
	 * プロファイル（同じ保存領域のタブが後から開かれうる）であること。
	 */
	apply(target: IParadisPageOpsTarget, ownerKey: string, generation: number, request: IParadisPageOverridesRequest, sharedProfile = false): Promise<IParadisPageOverridesResult> {
		if ((this.ownerWatermarks.get(ownerKey) ?? 0) > generation) {
			return Promise.resolve({ ok: false, reason: 'stale' });
		}
		let state = this.states.get(target);
		if (state && state.ownerKey !== ownerKey) {
			return Promise.resolve({ ok: false, reason: 'ownedByAnotherPane' });
		}
		if (target.webContents.isDestroyed()) {
			return Promise.resolve({ ok: false, reason: 'unavailable' });
		}
		if (!state) {
			state = this.createState(target, ownerKey, generation, sharedProfile);
		}
		const current = state;
		current.generation = Math.max(current.generation, generation);
		const run = current.queue.then(() => this.applyNow(target, current, request));
		current.queue = run.catch(() => undefined);
		return run;
	}

	/**
	 * 持ち主（ペイン）の共有が入れ替わった。`generation` より前に掛けたものを外し、それより前の世代の
	 * 要求は以後受け付けない。
	 */
	releaseOwner(ownerKey: string, generation: number): void {
		const previous = this.ownerWatermarks.get(ownerKey) ?? 0;
		if (generation > previous) {
			this.ownerWatermarks.delete(ownerKey);
			this.ownerWatermarks.set(ownerKey, generation);
			while (this.ownerWatermarks.size > MAX_OWNER_WATERMARKS) {
				const oldest = this.ownerWatermarks.keys().next().value;
				if (oldest === undefined) {
					break;
				}
				this.ownerWatermarks.delete(oldest);
			}
		}
		for (const [target, state] of [...this.states]) {
			if (state.ownerKey === ownerKey && state.generation < generation) {
				this.clear(target);
			}
		}
		for (const target of [...this.initScripts.keys()]) {
			void this.removeScripts(target, script => script.ownerKey === ownerKey && script.generation < generation);
		}
	}

	/**
	 * 同じ保存領域に別のタブが開かれた。プロファイルのタブに掛けた上書きは、そのプロファイルを
	 * そのペインだけが使っている間だけのものなので外す（利用者や別のペインがプロファイルを使い始めた）。
	 */
	onTabOpenedInStorage(storage: IParadisPageOpsStorage, opened: IParadisPageOpsTarget): void {
		for (const [target, state] of [...this.states]) {
			if (target !== opened && state.sharedProfile && state.storage === storage) {
				this.clear(target);
			}
		}
	}

	/**
	 * タブの上書きとハイライトをすべて外す（エージェントが手放した）。専用のセッションは、有効にしたものを
	 * 戻したうえでタブが閉じるまで残し、次にまた共有されたときに使い回す。セッションを外そうとしても
	 * upstream の不具合（空の session id の `Target.detachFromTarget`）で外れずに残るので、手放すたびに
	 * 付け直すと、共有と解除を繰り返したタブにセッションが増え続けるため。
	 */
	releaseTarget(target: IParadisPageOpsTarget): void {
		this.clear(target);
		this.clearHighlight(target);
		const entry = this.targetSessions.get(target);
		if (entry) {
			void this.teardown(target, entry);
		}
		this.setInitScripts(target, undefined);
	}

	/** タブが閉じた。上書きとハイライトを外し、専用のセッションを手放す（タブと一緒に消える）。 */
	private disposeTarget(target: IParadisPageOpsTarget): void {
		this.clear(target);
		this.clearHighlight(target);
		const entry = this.targetSessions.get(target);
		this.targetSessions.delete(target);
		this.pendingSessions.delete(target);
		const destroyedListener = this.destroyedListeners.get(target);
		this.destroyedListeners.delete(target);
		if (destroyedListener) {
			try {
				target.webContents.removeListener('destroyed', destroyedListener);
			} catch {
				// タブが既に閉じている。
			}
		}
		if (entry) {
			void this.teardownAndDispose(target, entry);
		}
		this.setInitScripts(target, undefined);
	}

	/** いま上書きを掛けているタブの数（テスト用）。 */
	get activeTargetCount(): number {
		return this.states.size;
	}

	/** タブを PDF にする。 */
	async printToPdf(target: IParadisPageOpsTarget, options: IParadisPdfOptions): Promise<Uint8Array> {
		const pdf = await raceTimeout(target.webContents.printToPDF({
			landscape: options.landscape,
			printBackground: options.printBackground,
			pageSize: options.paperFormat,
			scale: options.scale,
			...(options.pageRanges.length > 0 ? { pageRanges: options.pageRanges } : {}),
		}), PDF_TIMEOUT_MS);
		if (!pdf) {
			throw new Error('The page did not finish printing to PDF in time.');
		}
		return pdf;
	}

	/** ハイライトを出す（`rect` が無ければ消す）。前のハイライトは消す。`rect` はページの CSS ピクセル。 */
	async highlight(target: IParadisPageOpsTarget, rect: IParadisHighlightRect | undefined, durationMs: number): Promise<void> {
		this.clearHighlight(target);
		if (!rect || target.webContents.isDestroyed()) {
			return;
		}
		const entry = await this.ensureTargetSession(target);
		if (!entry.overlayEnabled) {
			await entry.session.sendCommand('DOM.enable');
			await entry.session.sendCommand('Overlay.enable');
			entry.overlayEnabled = true;
		}
		// Overlay.highlightRect はページの拡大率を掛ける前の座標で受けるので、CSS ピクセルに倍率を掛ける。
		let zoom = 1;
		try {
			const factor = target.webContents.getZoomFactor();
			zoom = Number.isFinite(factor) && factor > 0 ? factor : 1;
		} catch {
			zoom = 1;
		}
		await entry.session.sendCommand('Overlay.highlightRect', {
			x: Math.round(rect.x * zoom),
			y: Math.round(rect.y * zoom),
			width: Math.round(rect.width * zoom),
			height: Math.round(rect.height * zoom),
			color: { r: 9, g: 105, b: 218, a: 0.18 },
			outlineColor: { r: 9, g: 105, b: 218, a: 1 },
		});
		// 重なった呼び出しの時間切れが、こちらのハイライトを消さないよう付け替える。
		const previous = this.highlights.get(target);
		if (previous) {
			clearTimeout(previous.timer);
		}
		const timer = setTimeout(() => this.clearHighlight(target), durationMs);
		this.highlights.set(target, { timer });
	}

	/**
	 * 遷移・再読み込みの後も動くスクリプトを置く（`Page.addScriptToEvaluateOnNewDocument`）。持ち主の
	 * 共有が入れ替わった後に届いた要求は断る。
	 */
	async addInitScript(target: IParadisPageOpsTarget, ownerKey: string, generation: number, request: IParadisInitScriptRequest): Promise<IParadisInitScriptsResult> {
		const isStale = () => (this.ownerWatermarks.get(ownerKey) ?? 0) > generation;
		if (isStale()) {
			return { ok: false, reason: 'stale' };
		}
		if (target.webContents.isDestroyed()) {
			return { ok: false, reason: 'unavailable' };
		}
		if (this.ownScripts(target, ownerKey).length >= PARADIS_INIT_SCRIPT_MAX_PER_TAB) {
			return { ok: false, reason: 'invalid', message: `This tab already has ${PARADIS_INIT_SCRIPT_MAX_PER_TAB} scripts of yours. Remove one with remove_init_script first.` };
		}
		let entry: ITargetSession;
		let identifier: unknown;
		try {
			entry = await this.ensureTargetSession(target);
			if (!entry.pageEnabled) {
				entry.pageEnabled = true;
				await entry.session.sendCommand('Page.enable');
			}
			const response = await entry.session.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: request.source, ...(request.runNow ? { runImmediately: true } : {}) }) as { identifier?: unknown } | undefined;
			identifier = response?.identifier;
		} catch (error) {
			return { ok: false, reason: 'failed', message: error instanceof Error ? error.message.slice(0, 300) : undefined };
		}
		if (typeof identifier !== 'string') {
			return { ok: false, reason: 'failed', message: 'The browser did not accept the script.' };
		}
		if (isStale() || this.targetSessions.get(target) !== entry || target.webContents.isDestroyed()) {
			// 置いている間に共有が入れ替わった・タブを手放した。置いたものを残さない。
			void this.sendTeardown(target, entry.session, [['Page.removeScriptToEvaluateOnNewDocument', { identifier }]]);
			return { ok: false, reason: 'stale' };
		}
		const info: IParadisInitScriptInfo = Object.freeze({ id: `s${this.nextInitScriptId++}`, label: request.label, chars: request.source.length, addedAt: this.now() });
		this.setInitScripts(target, [...(this.initScripts.get(target) ?? []), { info, ownerKey, generation, identifier, session: entry.session }]);
		return { ...this.describeScripts(target, ownerKey), added: info };
	}

	/** 持ち主が置いたスクリプトを外す（`id` が無ければすべて）。 */
	async removeInitScripts(target: IParadisPageOpsTarget, ownerKey: string, id: string | undefined): Promise<IParadisInitScriptsResult> {
		const own = this.ownScripts(target, ownerKey);
		if (id !== undefined && !own.some(script => script.info.id === id)) {
			return { ok: false, reason: 'invalid', message: `This tab has no script "${id}" of yours. Call list_init_scripts to see the ids.` };
		}
		const removed = await this.removeScripts(target, script => script.ownerKey === ownerKey && (id === undefined || script.info.id === id));
		return { ...this.describeScripts(target, ownerKey), removed };
	}

	/** 持ち主がタブに置いているスクリプトの一覧。 */
	listInitScripts(target: IParadisPageOpsTarget, ownerKey: string): IParadisInitScriptsResult {
		return this.describeScripts(target, ownerKey);
	}

	private ownScripts(target: IParadisPageOpsTarget, ownerKey: string): IInitScript[] {
		return (this.initScripts.get(target) ?? []).filter(script => script.ownerKey === ownerKey);
	}

	private describeScripts(target: IParadisPageOpsTarget, ownerKey: string): Extract<IParadisInitScriptsResult, { ok: true }> {
		const all = this.initScripts.get(target) ?? [];
		return { ok: true, scripts: all.filter(script => script.ownerKey === ownerKey).map(script => script.info), otherPanes: all.filter(script => script.ownerKey !== ownerKey).length };
	}

	/** 当てはまるスクリプトを台帳から外し、ブラウザからも外す。外した数を返す。 */
	private async removeScripts(target: IParadisPageOpsTarget, predicate: (script: IInitScript) => boolean): Promise<number> {
		const scripts = this.initScripts.get(target);
		if (!scripts) {
			return 0;
		}
		const removing = scripts.filter(predicate);
		if (removing.length === 0) {
			return 0;
		}
		const kept = scripts.filter(script => !predicate(script));
		this.setInitScripts(target, kept);
		const entry = this.targetSessions.get(target);
		if (entry) {
			const commands: (readonly [string, object])[] = removing
				.filter(script => script.session === entry.session)
				.map(script => ['Page.removeScriptToEvaluateOnNewDocument', { identifier: script.identifier }] as const);
			if (kept.length === 0 && entry.pageEnabled) {
				entry.pageEnabled = false;
				commands.push(['Page.disable', {}]);
			}
			await this.sendTeardown(target, entry.session, commands);
		}
		return removing.length;
	}

	/** ハイライトを消す（`clear: true`・時間切れ・次のハイライト・タブを手放す）。 */
	private clearHighlight(target: IParadisPageOpsTarget): void {
		const highlight = this.highlights.get(target);
		if (!highlight) {
			return;
		}
		this.highlights.delete(target);
		clearTimeout(highlight.timer);
		const entry = this.targetSessions.get(target);
		if (entry && entry.overlayEnabled) {
			void this.sendTeardown(target, entry.session, [HIGHLIGHT_HIDE_COMMAND]);
		}
	}

	/** このタブの専用のセッション。無ければ付ける（同時に呼ばれても1つだけ）。 */
	private ensureTargetSession(target: IParadisPageOpsTarget): Promise<ITargetSession> {
		const existing = this.targetSessions.get(target);
		if (existing) {
			return Promise.resolve(existing);
		}
		const pending = this.pendingSessions.get(target);
		if (pending) {
			return pending;
		}
		let created: Promise<ITargetSession> | undefined = undefined;
		created = (async () => {
			const session = await target.debugger.attach();
			if (this.pendingSessions.get(target) !== created || target.webContents.isDestroyed()) {
				session.dispose();
				throw new Error('The tab was released while attaching.');
			}
			const entry: ITargetSession = { session, store: new DisposableStore(), networkEnabled: false, fetchEnabled: false, overlayEnabled: false, pageEnabled: false };
			entry.store.add(session.onEvent(event => this.onEvent(target, session, event)));
			entry.store.add(session.onClose(() => {
				if (this.targetSessions.get(target) !== entry) {
					return;
				}
				// タブの debugger が外れた（タブが閉じた・別の理由で切れた）。上書きはもう効いていないので、
				// 効いているように見せ続けない。
				this.targetSessions.delete(target);
				entry.store.dispose();
				const state = this.states.get(target);
				if (state && (state.extraHeaders !== undefined || state.rules.length > 0)) {
					this.clear(target);
				}
				this.highlights.delete(target);
				// セッションと一緒にスクリプトも消えた。
				this.setInitScripts(target, undefined);
			}));
			this.targetSessions.set(target, entry);
			this.pendingSessions.delete(target);
			if (!this.destroyedListeners.has(target)) {
				const destroyedListener = () => this.disposeTarget(target);
				this.destroyedListeners.set(target, destroyedListener);
				target.webContents.once('destroyed', destroyedListener);
			}
			return entry;
		})();
		const pendingSession = created;
		this.pendingSessions.set(target, pendingSession);
		pendingSession.catch(() => {
			if (this.pendingSessions.get(target) === pendingSession) {
				this.pendingSessions.delete(target);
			}
		});
		return pendingSession;
	}

	/** 戻すコマンドを順に送る。失敗はログに出す（閉じたタブへのものは出さない）。 */
	private async sendTeardown(target: IParadisPageOpsTarget, session: ICDPConnection, commands: readonly (readonly [string, object])[]): Promise<void> {
		for (const [method, params] of commands) {
			try {
				await session.sendCommand(method, params);
			} catch (error) {
				let destroyed = true;
				try {
					destroyed = target.webContents.isDestroyed();
				} catch {
					destroyed = true;
				}
				if (!destroyed) {
					this.onTeardownFailure(method, error);
				}
			}
		}
	}

	/** 有効にしたもの（ネットワークの上書きとハイライト）をすべて戻す。セッションは残す。 */
	private async teardown(target: IParadisPageOpsTarget, entry: ITargetSession): Promise<void> {
		// 置いたスクリプトは識別子ごとに外す（どのペインのものも）。
		const scripts = (this.initScripts.get(target) ?? []).filter(script => script.session === entry.session).map(script => script.identifier);
		this.setInitScripts(target, undefined);
		const commands = [
			...(entry.networkEnabled || entry.fetchEnabled ? NETWORK_TEARDOWN_COMMANDS : []),
			...(entry.overlayEnabled ? OVERLAY_TEARDOWN_COMMANDS : []),
			...scripts.map(identifier => ['Page.removeScriptToEvaluateOnNewDocument', { identifier }] as const),
			...(entry.pageEnabled ? [['Page.disable', {}] as const] : []),
		];
		entry.networkEnabled = false;
		entry.fetchEnabled = false;
		entry.overlayEnabled = false;
		entry.pageEnabled = false;
		await this.sendTeardown(target, entry.session, commands);
	}

	private async teardownAndDispose(target: IParadisPageOpsTarget, entry: ITargetSession): Promise<void> {
		await this.teardown(target, entry);
		entry.store.dispose();
		try {
			entry.session.dispose();
		} catch {
			// タブが既に閉じている。
		}
	}

	private createState(target: IParadisPageOpsTarget, ownerKey: string, generation: number, sharedProfile: boolean): IViewState {
		const state: IViewState = {
			ownerKey,
			generation,
			storage: target.webContents.session,
			sharedProfile,
			extraHeaders: undefined,
			credentials: undefined,
			rules: [],
			ruleMatches: [],
			touchedCache: false,
			loginListener: undefined,
			authAnswers: new Map(),
			queue: Promise.resolve(),
			disposed: false,
		};
		if (!this.destroyedListeners.has(target)) {
			const destroyedListener = () => this.disposeTarget(target);
			this.destroyedListeners.set(target, destroyedListener);
			target.webContents.once('destroyed', destroyedListener);
		}
		this.states.set(target, state);
		return state;
	}

	private async applyNow(target: IParadisPageOpsTarget, state: IViewState, request: IParadisPageOverridesRequest): Promise<IParadisPageOverridesResult> {
		if (state.disposed || this.states.get(target) !== state) {
			return { ok: false, reason: 'stale' };
		}
		if (target.webContents.isDestroyed()) {
			this.clear(target);
			return { ok: false, reason: 'unavailable' };
		}
		const hadNetworkOverrides = state.extraHeaders !== undefined || state.rules.length > 0;
		if (request.extraHeaders !== undefined) {
			const extra = request.extraHeaders;
			if (extra === null || Object.keys(extra.headers).length === 0) {
				state.extraHeaders = undefined;
			} else if (extra.origins.length > 0) {
				state.extraHeaders = extra;
			} else {
				// 相手を指定しなければ、掛けた時点のトップフレームの origin だけに付ける。
				const origin = paradisHttpOrigin(target.webContents.getURL());
				if (origin === undefined) {
					if (!this.hasAnything(state)) {
						this.clear(target);
					}
					return { ok: false, reason: 'invalid', message: 'The shared page is not an http(s) page yet, so there is no origin to send the headers to. Navigate first, or pass "origins".' };
				}
				state.extraHeaders = { headers: extra.headers, origins: [origin] };
			}
		}
		if (request.rules !== undefined) {
			state.rules = request.rules ?? [];
			state.ruleMatches = state.rules.map(() => 0);
		}
		if (request.credentials !== undefined) {
			const hadCredentials = state.credentials !== undefined;
			state.credentials = request.credentials ?? undefined;
			state.authAnswers.clear();
			if (hadCredentials) {
				// 前に答えた資格情報が保存領域の認証のキャッシュに残らないようにする。
				await this.clearStorage(state.storage, 'auth');
			}
		}
		state.touchedCache ||= state.extraHeaders !== undefined || state.rules.length > 0;
		this.syncLoginListener(target, state);
		try {
			await this.syncNetwork(target, state);
		} catch {
			// 途中で失敗したら、中途半端に効いている状態を残さない。
			this.clear(target);
			return { ok: false, reason: 'failed', message: 'The browser tab did not accept the change. The overrides of this tab were removed; try again.' };
		}
		// 何も残らないときは、この後の clear が消す。
		if (hadNetworkOverrides && this.hasAnything(state) && (request.extraHeaders !== undefined || request.rules !== undefined)) {
			// 前のヘッダ・ルールで書き換えた要求への応答を、キャッシュから出さない。
			await this.clearStorage(state.storage, 'cache');
		}
		if (state.disposed) {
			return { ok: false, reason: 'unavailable' };
		}
		if (!this.hasAnything(state)) {
			this.clear(target);
			return { ok: true, summary: { extraHeaderNames: [], rules: [] } };
		}
		return { ok: true, summary: this.summarize(state) };
	}

	private hasAnything(state: IViewState): boolean {
		return state.extraHeaders !== undefined || state.rules.length > 0 || state.credentials !== undefined;
	}

	/** Network / Fetch をいまの上書きに合わせる。どちらも要らなくなったら、有効にしたものを戻す。 */
	private async syncNetwork(target: IParadisPageOpsTarget, state: IViewState): Promise<void> {
		const needsHeaders = state.extraHeaders !== undefined;
		const needsRules = state.rules.length > 0;
		if (!needsHeaders && !needsRules) {
			await this.resetNetwork(target);
			return;
		}
		const entry = await this.ensureTargetSession(target);
		if (state.disposed) {
			return;
		}
		if (!entry.networkEnabled) {
			entry.networkEnabled = true;
			await entry.session.sendCommand('Network.enable', { maxTotalBufferSize: NETWORK_BUFFER_BYTES, maxResourceBufferSize: NETWORK_BUFFER_BYTES });
			// 上書きしている間は、キャッシュの応答（Fetch を通らない）と Service Worker の応答（ページの
			// セッションの Fetch を通らない）でルールとヘッダがすり抜けないようにする。どちらもこのタブだけ。
			await entry.session.sendCommand('Network.setCacheDisabled', { cacheDisabled: true });
			await entry.session.sendCommand('Network.setBypassServiceWorker', { bypass: true });
		}
		// 追加ヘッダは相手の origin を見て付けるので、Network.setExtraHTTPHeaders（全部の要求に付く）は
		// 使わず、Fetch で止めた要求ごとに足す。追加ヘッダがあればすべての要求を止める。
		entry.fetchEnabled = true;
		await entry.session.sendCommand('Fetch.enable', {
			patterns: needsHeaders
				? [{ urlPattern: '*', requestStage: 'Request' }]
				: state.rules.map(rule => ({ urlPattern: rule.urlPattern, requestStage: 'Request' })),
		});
	}

	/** このタブで有効にしたネットワークの上書きを戻す（セッションは次の上書きとハイライトのために残す）。 */
	private async resetNetwork(target: IParadisPageOpsTarget): Promise<void> {
		const entry = this.targetSessions.get(target);
		if (!entry || (!entry.networkEnabled && !entry.fetchEnabled)) {
			return;
		}
		entry.networkEnabled = false;
		entry.fetchEnabled = false;
		await this.sendTeardown(target, entry.session, NETWORK_TEARDOWN_COMMANDS);
	}

	private onEvent(target: IParadisPageOpsTarget, session: ICDPConnection, event: CDPEvent): void {
		if (event.method !== 'Fetch.requestPaused') {
			return;
		}
		const params = event.params as { requestId?: unknown; request?: { url?: unknown; headers?: unknown } } | undefined;
		const requestId = params?.requestId;
		if (typeof requestId !== 'string') {
			return;
		}
		const send = (method: string, commandParams: object) => session.sendCommand(method, { requestId, ...commandParams }).catch(() => {
			// 決められなかったリクエストを止めたままにしない。
			return session.sendCommand('Fetch.continueRequest', { requestId }).catch(() => undefined);
		});
		const state = this.states.get(target);
		if (!state || state.disposed) {
			// 外している途中に止まった要求は、そのまま流す。
			void send('Fetch.continueRequest', {});
			return;
		}
		const url = typeof params?.request?.url === 'string' ? params.request.url : '';
		const original = params?.request?.headers && typeof params.request.headers === 'object' ? params.request.headers as Record<string, string> : {};
		const index = state.rules.findIndex(rule => paradisMatchUrlPattern(rule.urlPattern, url));
		const rule = index >= 0 ? state.rules[index] : undefined;
		const withExtraHeaders = (headers: Record<string, string>) => state.extraHeaders ? paradisApplyExtraHeaders(headers, url, state.extraHeaders) : undefined;
		if (!rule) {
			const headers = withExtraHeaders(original);
			void send('Fetch.continueRequest', headers ? { headers } : {});
			return;
		}
		state.ruleMatches[index] = (state.ruleMatches[index] ?? 0) + 1;
		switch (rule.action) {
			case 'block':
				void send('Fetch.failRequest', { errorReason: 'BlockedByClient' });
				return;
			case 'set_headers': {
				// 追加ヘッダを足した後にルールを当てる（ルールの指定が勝つ）。
				const withExtra = withExtraHeaders(original);
				const base = withExtra ? Object.fromEntries(withExtra.map(header => [header.name, header.value])) : original;
				void send('Fetch.continueRequest', { headers: paradisApplyHeaderRule(base, rule) });
				return;
			}
			case 'redirect': {
				const requestOrigin = Object.entries(original).find(([name]) => name.toLowerCase() === 'origin')?.[1];
				void send('Fetch.fulfillRequest', { responseCode: 307, responseHeaders: paradisBuildRedirectHeaders(rule, requestOrigin), body: '' });
				return;
			}
			case 'respond':
				void send('Fetch.fulfillRequest', {
					responseCode: rule.status ?? 200,
					responseHeaders: paradisBuildRespondHeaders(rule),
					body: encodeBase64(VSBuffer.fromString(rule.body ?? '')),
				});
				return;
		}
	}

	/** HTTP 認証の求めに答える listener を、資格情報の有無に合わせて付け外しする。 */
	private syncLoginListener(target: IParadisPageOpsTarget, state: IViewState): void {
		if (state.credentials && !state.loginListener) {
			const listener: ParadisLoginListener = (event, details, authInfo, callback) => this.onLogin(state, event, details, authInfo, callback);
			state.loginListener = listener;
			target.webContents.on('login', listener);
		} else if (!state.credentials && state.loginListener) {
			target.webContents.removeListener('login', state.loginListener);
			state.loginListener = undefined;
		}
	}

	private onLogin(state: IViewState, event: { preventDefault(): void }, details: { readonly url: string }, authInfo: IParadisLoginAuthInfo, callback: (username?: string, password?: string) => void): void {
		const credentials = state.credentials;
		if (!credentials || state.disposed || authInfo.isProxy) {
			return;
		}
		let origin: URL;
		try {
			origin = new URL(credentials.origin);
			if (new URL(details.url).origin !== credentials.origin) {
				return;
			}
		} catch {
			return;
		}
		const expectedPort = origin.port ? Number(origin.port) : origin.protocol === 'https:' ? 443 : 80;
		if (authInfo.host.toLowerCase() !== origin.hostname.toLowerCase().replace(/^\[|\]$/g, '') || authInfo.port !== expectedPort) {
			return;
		}
		const key = `${authInfo.realm}\n${authInfo.host}:${authInfo.port}`;
		const now = this.now();
		const answered = state.authAnswers.get(key);
		if (answered && now - answered.firstAt < AUTH_ANSWER_WINDOW_MS && answered.count >= MAX_AUTH_ANSWERS_PER_REALM) {
			// 間違ったパスワードで答え続けない。何もしなければ Chromium は認証を取り消す。
			return;
		}
		if (!answered || now - answered.firstAt >= AUTH_ANSWER_WINDOW_MS) {
			state.authAnswers.set(key, { count: 1, firstAt: now });
		} else {
			answered.count++;
		}
		event.preventDefault();
		callback(credentials.username, credentials.password);
	}

	/**
	 * タブの上書きを外す。有効にしたネットワークの上書きを戻し、答えた資格情報と書き換えた応答が
	 * 保存領域に残らないよう、認証のキャッシュと HTTP キャッシュを消す（閉じたタブでも、掛けた時点の
	 * 保存領域に対して消す）。
	 */
	private clear(target: IParadisPageOpsTarget): void {
		const state = this.states.get(target);
		if (!state) {
			return;
		}
		this.states.delete(target);
		state.disposed = true;
		if (state.credentials !== undefined) {
			void this.clearStorage(state.storage, 'auth');
		}
		if (state.touchedCache) {
			void this.clearStorage(state.storage, 'cache');
		}
		state.credentials = undefined;
		state.authAnswers.clear();
		try {
			if (state.loginListener) {
				target.webContents.removeListener('login', state.loginListener);
			}
		} catch {
			// タブが既に閉じている。
		}
		state.loginListener = undefined;
		void this.resetNetwork(target);
	}

	private async clearStorage(storage: IParadisPageOpsStorage, what: 'auth' | 'cache'): Promise<void> {
		try {
			await (what === 'auth' ? storage.clearAuthCache() : storage.clearCache());
		} catch (error) {
			this.onTeardownFailure(what === 'auth' ? 'clearAuthCache' : 'clearCache', error);
		}
	}

	private summarize(state: IViewState): IParadisPageOverridesSummary {
		return {
			extraHeaderNames: state.extraHeaders ? Object.keys(state.extraHeaders.headers) : [],
			...(state.extraHeaders ? { extraHeaderOrigins: state.extraHeaders.origins } : {}),
			...(state.credentials ? { credentialsOrigin: state.credentials.origin } : {}),
			rules: state.rules.map((rule, index) => ({ urlPattern: rule.urlPattern, action: rule.action, matched: state.ruleMatches[index] ?? 0 })),
		};
	}
}
