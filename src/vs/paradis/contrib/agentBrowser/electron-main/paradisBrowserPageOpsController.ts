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
// - 上書きは「タブ（webContents）1枚」に掛ける。CDP の Network / Fetch はこのタブに付けた専用の
//   CDP セッションで有効にするので、同じ保存領域の他のタブ・他のペインのタブには届かない。
//   セッションを外せば Chromium がすべて元に戻す（止めていたリクエストも流れる）。
// - 1枚のタブに上書きを掛けられるのは1つのペインだけ（持ち主）。別のペインは断られる。
// - 持ち主の共有が入れ替わった（shared process が世代を進めた）・エージェントがタブを手放した・
//   タブが閉じた、のどれでも外す。
// - HTTP 認証の資格情報はこのプロセスのメモリにだけ置く。ログにも応答にも出さない。
// - 上書きを掛けている間はそのタブのキャッシュを使わない（作った応答や書き換えた要求の結果が、
//   共有の HTTP キャッシュに残って利用者の他のタブへ出ないように）。

import { raceTimeout } from '../../../../base/common/async.js';
import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import type { CDPEvent, ICDPConnection } from '../../../../platform/browserView/common/cdp/types.js';
import {
	IParadisHighlightRect,
	IParadisHttpCredentials,
	IParadisPageOverridesRequest,
	IParadisPageOverridesResult,
	IParadisPageOverridesSummary,
	IParadisPdfOptions,
	IParadisRequestRule,
	paradisApplyHeaderRule,
	paradisBuildRedirectHeaders,
	paradisBuildRespondHeaders,
	paradisMatchUrlPattern,
} from '../common/paradisBrowserPageOps.js';

/** Electron の `login` イベントの認証の情報のうち、使うもの。 */
export interface IParadisLoginAuthInfo {
	readonly isProxy: boolean;
	readonly host: string;
	readonly port: number;
	readonly realm: string;
}

export type ParadisLoginListener = (event: { preventDefault(): void }, details: { readonly url: string }, authInfo: IParadisLoginAuthInfo, callback: (username?: string, password?: string) => void) => void;

/**
 * このコントローラが使うタブ（BrowserView）の部分。Electron の具象型ではなく構造で受け、
 * テストから偽物を渡せるようにしてある。
 */
export interface IParadisPageOpsTarget {
	readonly webContents: {
		isDestroyed(): boolean;
		getURL(): string;
		getTitle(): string;
		once(event: 'destroyed', listener: () => void): unknown;
		removeListener(event: 'destroyed', listener: () => void): unknown;
		on(event: 'login', listener: ParadisLoginListener): unknown;
		removeListener(event: 'login', listener: ParadisLoginListener): unknown;
		printToPDF(options: object): Promise<Uint8Array>;
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

interface IViewState {
	readonly ownerKey: string;
	generation: number;
	extraHeaders: Readonly<Record<string, string>>;
	credentials: IParadisHttpCredentials | undefined;
	rules: readonly IParadisRequestRule[];
	ruleMatches: number[];
	session: ICDPConnection | undefined;
	networkEnabled: boolean;
	fetchEnabled: boolean;
	loginListener: ParadisLoginListener | undefined;
	readonly authAnswers: Map<string, { count: number; firstAt: number }>;
	readonly sessionStore: DisposableStore;
	readonly destroyedListener: () => void;
	/** 同じタブへの操作を1つずつ行うための鎖。 */
	queue: Promise<unknown>;
	disposed: boolean;
}

interface IHighlightState {
	readonly session: ICDPConnection;
	readonly timer: ReturnType<typeof setTimeout>;
}

export class ParadisBrowserPageOpsController {

	private readonly states = new Map<IParadisPageOpsTarget, IViewState>();
	private readonly ownerWatermarks = new Map<string, number>();
	private readonly highlights = new Map<IParadisPageOpsTarget, IHighlightState>();

	constructor(private readonly now: () => number = Date.now) { }

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

	/** 上書きを置き換える。値の無い項目はそのまま、`null` は外す。 */
	apply(target: IParadisPageOpsTarget, ownerKey: string, generation: number, request: IParadisPageOverridesRequest): Promise<IParadisPageOverridesResult> {
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
			state = this.createState(target, ownerKey, generation);
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
	}

	/** タブの上書きとハイライトをすべて外す（エージェントが手放した・タブが閉じた）。 */
	releaseTarget(target: IParadisPageOpsTarget): void {
		this.clear(target);
		this.clearHighlight(target);
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

	/** ハイライトを出す（`rect` が無ければ消す）。前のハイライトは消す。 */
	async highlight(target: IParadisPageOpsTarget, rect: IParadisHighlightRect | undefined, durationMs: number): Promise<void> {
		this.clearHighlight(target);
		if (!rect || target.webContents.isDestroyed()) {
			return;
		}
		const session = await target.debugger.attach();
		try {
			await session.sendCommand('DOM.enable');
			await session.sendCommand('Overlay.enable');
			await session.sendCommand('Overlay.highlightRect', {
				x: Math.round(rect.x),
				y: Math.round(rect.y),
				width: Math.round(rect.width),
				height: Math.round(rect.height),
				color: { r: 9, g: 105, b: 218, a: 0.18 },
				outlineColor: { r: 9, g: 105, b: 218, a: 1 },
			});
		} catch (error) {
			session.dispose();
			throw error;
		}
		// 重なった呼び出しで先に別のハイライトが入っていたら、それを消してこちらを残す。
		this.clearHighlight(target);
		// セッションを外すと Chromium がハイライトも消す。
		const timer = setTimeout(() => this.clearHighlight(target), durationMs);
		this.highlights.set(target, { session, timer });
	}

	private clearHighlight(target: IParadisPageOpsTarget): void {
		const highlight = this.highlights.get(target);
		if (!highlight) {
			return;
		}
		this.highlights.delete(target);
		clearTimeout(highlight.timer);
		try {
			highlight.session.dispose();
		} catch {
			// タブが既に閉じている。
		}
	}

	private createState(target: IParadisPageOpsTarget, ownerKey: string, generation: number): IViewState {
		const destroyedListener = () => this.releaseTarget(target);
		const state: IViewState = {
			ownerKey,
			generation,
			extraHeaders: {},
			credentials: undefined,
			rules: [],
			ruleMatches: [],
			session: undefined,
			networkEnabled: false,
			fetchEnabled: false,
			loginListener: undefined,
			authAnswers: new Map(),
			sessionStore: new DisposableStore(),
			destroyedListener,
			queue: Promise.resolve(),
			disposed: false,
		};
		target.webContents.once('destroyed', destroyedListener);
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
		if (request.extraHeaders !== undefined) {
			state.extraHeaders = request.extraHeaders ?? {};
		}
		if (request.rules !== undefined) {
			state.rules = request.rules ?? [];
			state.ruleMatches = state.rules.map(() => 0);
		}
		if (request.credentials !== undefined) {
			state.credentials = request.credentials ?? undefined;
			state.authAnswers.clear();
		}
		this.syncLoginListener(target, state);
		try {
			await this.syncSession(target, state);
		} catch {
			// 途中で失敗したら、中途半端に効いている状態を残さない。
			this.clear(target);
			return { ok: false, reason: 'failed', message: 'The browser tab did not accept the change. The overrides of this tab were removed; try again.' };
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
		return Object.keys(state.extraHeaders).length > 0 || state.rules.length > 0 || state.credentials !== undefined;
	}

	/** Network / Fetch をいまの上書きに合わせる。どちらも要らなくなったらセッションごと外す。 */
	private async syncSession(target: IParadisPageOpsTarget, state: IViewState): Promise<void> {
		const needsHeaders = Object.keys(state.extraHeaders).length > 0;
		const needsRules = state.rules.length > 0;
		if (!needsHeaders && !needsRules) {
			this.dropSession(state);
			return;
		}
		const session = await this.ensureSession(target, state);
		if (!state.networkEnabled) {
			await session.sendCommand('Network.enable', { maxTotalBufferSize: NETWORK_BUFFER_BYTES, maxResourceBufferSize: NETWORK_BUFFER_BYTES });
			// 上書きしている間はキャッシュを読み書きしない（このタブだけ。セッションを外せば戻る）。
			await session.sendCommand('Network.setCacheDisabled', { cacheDisabled: true });
			state.networkEnabled = true;
		}
		await session.sendCommand('Network.setExtraHTTPHeaders', { headers: { ...state.extraHeaders } });
		if (needsRules) {
			await session.sendCommand('Fetch.enable', {
				patterns: state.rules.map(rule => ({ urlPattern: rule.urlPattern, requestStage: 'Request' })),
			});
			state.fetchEnabled = true;
		} else if (state.fetchEnabled) {
			await session.sendCommand('Fetch.disable');
			state.fetchEnabled = false;
		}
	}

	private async ensureSession(target: IParadisPageOpsTarget, state: IViewState): Promise<ICDPConnection> {
		if (state.session) {
			return state.session;
		}
		const session = await target.debugger.attach();
		if (state.disposed) {
			session.dispose();
			throw new Error('The overrides were removed while attaching.');
		}
		state.session = session;
		state.sessionStore.add(session.onEvent(event => this.onEvent(state, session, event)));
		state.sessionStore.add(session.onClose(() => {
			if (state.session !== session) {
				return;
			}
			// タブの debugger が外れた（タブが閉じた・別の理由で切れた）。上書きはもう効いていないので、
			// 効いているように見せ続けない。
			state.session = undefined;
			state.networkEnabled = false;
			state.fetchEnabled = false;
			if (!state.disposed && (Object.keys(state.extraHeaders).length > 0 || state.rules.length > 0)) {
				this.clear(target);
			}
		}));
		state.sessionStore.add(toDisposable(() => session.dispose()));
		return session;
	}

	private dropSession(state: IViewState): void {
		const session = state.session;
		state.session = undefined;
		state.networkEnabled = false;
		state.fetchEnabled = false;
		state.sessionStore.clear();
		if (session) {
			try {
				session.dispose();
			} catch {
				// タブが既に閉じている。
			}
		}
	}

	private onEvent(state: IViewState, session: ICDPConnection, event: CDPEvent): void {
		if (event.method !== 'Fetch.requestPaused') {
			return;
		}
		const params = event.params as { requestId?: unknown; request?: { url?: unknown; headers?: unknown } } | undefined;
		const requestId = params?.requestId;
		if (typeof requestId !== 'string') {
			return;
		}
		const url = typeof params?.request?.url === 'string' ? params.request.url : '';
		const index = state.rules.findIndex(rule => paradisMatchUrlPattern(rule.urlPattern, url));
		const rule = index >= 0 ? state.rules[index] : undefined;
		const send = (method: string, commandParams: object) => session.sendCommand(method, { requestId, ...commandParams }).catch(() => {
			// 決められなかったリクエストを止めたままにしない。
			return session.sendCommand('Fetch.continueRequest', { requestId }).catch(() => undefined);
		});
		if (!rule || state.disposed) {
			void send('Fetch.continueRequest', {});
			return;
		}
		state.ruleMatches[index] = (state.ruleMatches[index] ?? 0) + 1;
		switch (rule.action) {
			case 'block':
				void send('Fetch.failRequest', { errorReason: 'BlockedByClient' });
				return;
			case 'set_headers': {
				const original = params?.request?.headers && typeof params.request.headers === 'object' ? params.request.headers as Record<string, string> : {};
				void send('Fetch.continueRequest', { headers: paradisApplyHeaderRule(original, rule) });
				return;
			}
			case 'redirect':
				void send('Fetch.fulfillRequest', { responseCode: 307, responseHeaders: paradisBuildRedirectHeaders(rule), body: '' });
				return;
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

	private clear(target: IParadisPageOpsTarget): void {
		const state = this.states.get(target);
		if (!state) {
			return;
		}
		this.states.delete(target);
		state.disposed = true;
		state.credentials = undefined;
		state.authAnswers.clear();
		try {
			if (state.loginListener) {
				target.webContents.removeListener('login', state.loginListener);
			}
			target.webContents.removeListener('destroyed', state.destroyedListener);
		} catch {
			// タブが既に閉じている。
		}
		state.loginListener = undefined;
		this.dropSession(state);
		state.sessionStore.dispose();
	}

	private summarize(state: IViewState): IParadisPageOverridesSummary {
		return {
			extraHeaderNames: Object.keys(state.extraHeaders),
			...(state.credentials ? { credentialsOrigin: state.credentials.origin } : {}),
			rules: state.rules.map((rule, index) => ({ urlPattern: rule.urlPattern, action: rule.action, matched: state.ruleMatches[index] ?? 0 })),
		};
	}
}
