/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの Client Hints を Google Chrome と同じ値にする electron-main 側の本体。
//
// Electron には brands を変える公開 API が無い（`webContents.setUserAgent` は Chromium の既定の metadata を
// 付けるだけ）。そこで 2 つの経路で揃える:
//  1. 各タブ（BrowserView）の CDP で `Emulation.setUserAgentOverride` に Chrome の metadata を渡す。
//     `navigator.userAgentData`（brands・getHighEntropyValues）と、ページ・同じプロセスの iframe・
//     そこから作る Worker のリクエストの `Sec-CH-UA` 系がこれで変わる。別プロセスの iframe（OOPIF）には
//     自動で付く子のセッションへ同じものを送る。
//  2. セッションの `webRequest.onBeforeSendHeaders` で、brands を表すヘッダーを書き換える。Service Worker は
//     CDP の上書きが届かず、Electron のアプリ全体の UA（`Electron/` 入り）で通信するので、User-Agent もここで直す
//     （Service Worker の中の `navigator.userAgent` / `navigator.userAgentData` は Electron のまま。残課題）。
//
// brands 以外（platformVersion・architecture など）は CDP が必須にしているので、Electron の本来の値を
// Para Code のウィンドウで一度だけ読んで使う（推測の値で埋めると本物の Chrome とずれる）。

import electron, { type Session, type WebContents } from 'electron';
import { raceTimeout } from '../../../../base/common/async.js';
import type { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IParadisNativeClientHints, IParadisUserAgentMetadata, PARADIS_NATIVE_CLIENT_HINT_NAMES, paradisChromeUserAgentMetadata, paradisReadNativeClientHints, paradisRewriteClientHintHeaders } from '../common/paradisChromeClientHints.js';

/** 本来の Client Hints を読むときに使う isolated world。upstream の preload（999）とは別の番号。 */
const NATIVE_HINTS_WORLD_ID = 1437;
const NATIVE_HINTS_TIMEOUT_MS = 5_000;

interface IParadisChromeIdentitySession {
	/** Chrome の値に揃えるか（`paradis.browser.userAgent.includeParaCodeToken` が false のとき true）。 */
	readonly isEnabled: () => boolean;
	/** {@link isEnabled} が変わったかもしれない（設定が変わった）。セッションの UA を直した後に届く。 */
	readonly onDidChangeEnabled: Event<unknown>;
	/** 端末のエミュレーションで UA を選んでいるタブ。1 つでもある間は Service Worker の UA を直さない。 */
	readonly emulatingViews: Set<object>;
}

/** セッションごとの状態。 */
const sessionStates = new WeakMap<object, IParadisChromeIdentitySession>();

let nativeHintsPromise: Promise<IParadisNativeClientHints | undefined> | undefined;

/**
 * Electron 本来の Client Hints（brands 以外）を、Para Code のウィンドウの isolated world で読む。
 * ウィンドウには UA の上書きが無いので、その PC の本来の値が返る。成功した値はプロセスの寿命の間使い回す。
 */
function readNativeClientHints(): Promise<IParadisNativeClientHints | undefined> {
	nativeHintsPromise ??= (async () => {
		const code = `navigator.userAgentData ? navigator.userAgentData.getHighEntropyValues(${JSON.stringify(PARADIS_NATIVE_CLIENT_HINT_NAMES)}) : undefined`;
		let candidates: WebContents[];
		try {
			candidates = electron.webContents.getAllWebContents();
		} catch {
			return undefined;
		}
		for (const candidate of candidates) {
			if (candidate.isDestroyed() || candidate.getType() !== 'window') {
				continue;
			}
			try {
				const hints = paradisReadNativeClientHints(await raceTimeout(candidate.executeJavaScriptInIsolatedWorld(NATIVE_HINTS_WORLD_ID, [{ code }]), NATIVE_HINTS_TIMEOUT_MS));
				if (hints) {
					return hints;
				}
			} catch {
				// 読み込み中・破棄中のウィンドウは飛ばす
			}
		}
		return fallbackNativeClientHints();
	})().then(hints => {
		if (!hints) {
			nativeHintsPromise = undefined; // 次のタブでもう一度試す
		}
		return hints;
	});
	return nativeHintsPromise;
}

/**
 * ウィンドウから読めなかったときの値。Chromium と同じ計算ができる macOS と Linux だけ返す
 * （Windows の platformVersion は UniversalApiContract の版で、ここからは求められない）。
 */
function fallbackNativeClientHints(): IParadisNativeClientHints | undefined {
	const architecture = process.arch === 'arm64' || process.arch === 'arm' ? 'arm' : 'x86';
	const common = { architecture, model: '', mobile: false, bitness: process.arch === 'ia32' || process.arch === 'arm' ? '32' : '64', wow64: false, formFactors: ['Desktop'] };
	if (process.platform === 'darwin') {
		const [major = '0', minor = '0', bugfix = '0'] = process.getSystemVersion().split('.');
		return { platform: 'macOS', platformVersion: `${major}.${minor}.${bugfix}`, ...common };
	}
	if (process.platform === 'linux') {
		return { platform: 'Linux', platformVersion: '', ...common };
	}
	return undefined;
}

/**
 * セッションのリクエストヘッダーの brands を Chrome の値に書き換える。`isEnabled` が false の間は何もしない。
 * 同じセッションに 2 回呼んでも 1 回だけ登録する。
 */
export function paradisInstallChromeClientHintHeaders(session: Pick<Session, 'getUserAgent' | 'webRequest'>, isEnabled: () => boolean, onDidChangeEnabled: Event<unknown>, chromeVersion = process.versions.chrome, prefetchNativeHints = true): void {
	if (sessionStates.has(session)) {
		return;
	}
	const state: IParadisChromeIdentitySession = { isEnabled, onDidChangeEnabled, emulatingViews: new Set() };
	sessionStates.set(session, state);
	if (prefetchNativeHints) {
		void readNativeClientHints(); // 最初のタブを開く前に読み始めておく
	}
	session.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
		// 端末のエミュレーション中は、どのタブのものか分からない Service Worker の UA を直さない（スマホの UA を
		// 選んだタブの Service Worker がデスクトップの Chrome を名乗らないように）
		const requestHeaders = isEnabled() ? paradisRewriteClientHintHeaders(details.requestHeaders, session.getUserAgent(), chromeVersion, state.emulatingViews.size === 0) : undefined;
		callback(requestHeaders ? { requestHeaders } : {});
	});
}

/** {@link paradisAttachChromeIdentity} が使う BrowserView の部分。 */
export interface IParadisChromeIdentityView {
	readonly webContents: WebContents;
	readonly debugger: {
		readonly knownTargets: ReadonlyMap<string, { readonly type: string }>;
		readonly onSessionCreated: Event<{ readonly session: { readonly sessionId: string; readonly targetId: string; readonly onClose: Event<void> } }>;
		readonly onDidDetach: Event<void>;
		sendCommandRaw(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
	};
	readonly emulator: {
		readonly device: { readonly userAgent?: string } | undefined;
		readonly onDidChange: Event<unknown>;
	};
}

/** テストで差し替える部分。 */
export interface IParadisChromeIdentityOptions {
	readonly readNativeHints?: () => Promise<IParadisNativeClientHints | undefined>;
	readonly chromeVersion?: string;
}

/**
 * タブの CDP で、UA と Client Hints を Chrome の値に上書きする。
 * - 端末のエミュレーションで UA を選んでいる間は上書きを外し、upstream の `webContents.setUserAgent` の UA に任せる
 * - 「Para Code と名乗る」設定のときは上書きを外し、タブの UA をセッションの UA（`ParaCode/` 入り）にする。
 *   設定を切り替えると、開いているタブにもすぐ当て直す
 * - 送る前に読む値（本来の Client Hints）を待つ間に状態が変わったら、古い送信は捨てる（世代番号）
 */
export function paradisAttachChromeIdentity(view: IParadisChromeIdentityView, options: IParadisChromeIdentityOptions = {}): IDisposable {
	const readNativeHints = options.readNativeHints ?? readNativeClientHints;
	const chromeVersion = options.chromeVersion ?? process.versions.chrome;
	const session = view.webContents.session;
	const state = sessionStates.get(session);
	if (!state) {
		return Disposable.None;
	}
	const store = new DisposableStore();
	/** 別プロセスの iframe の子セッション。値はそのセッションが閉じたときの購読。 */
	const iframeSessions = store.add(new DisposableMap<string>());
	let disposed = false;
	let generation = 0;
	let reapply: ReturnType<typeof setTimeout> | undefined;
	store.add(toDisposable(() => {
		disposed = true;
		clearTimeout(reapply);
		state.emulatingViews.delete(view);
	}));

	const currentParams = async (): Promise<{ userAgent: string; userAgentMetadata?: IParadisUserAgentMetadata } | undefined> => {
		if (view.emulator.device?.userAgent || !state.isEnabled()) {
			return { userAgent: '' };
		}
		const native = await readNativeHints().catch(() => undefined);
		const userAgentMetadata = native && paradisChromeUserAgentMetadata(chromeVersion, native);
		return userAgentMetadata ? { userAgent: session.getUserAgent(), userAgentMetadata } : undefined;
	};
	const send = async (sessionIds: readonly (string | undefined)[], sendGeneration: number) => {
		const params = await currentParams();
		for (const sessionId of sessionIds) {
			if (!params || disposed || sendGeneration !== generation || view.webContents.isDestroyed()) {
				return;
			}
			try {
				await view.debugger.sendCommandRaw('Emulation.setUserAgentOverride', params, sessionId);
			} catch {
				// 遷移や破棄の途中で失敗する。次の遷移・接続し直しで付け直す
			}
		}
	};
	const applyAll = () => void send([undefined, ...iframeSessions.keys()], ++generation);
	const noteDevice = () => {
		if (view.emulator.device?.userAgent) {
			state.emulatingViews.add(view);
		} else {
			state.emulatingViews.delete(view);
		}
	};

	store.add(view.debugger.onSessionCreated(({ session: child }) => {
		if (view.debugger.knownTargets.get(child.targetId)?.type !== 'iframe') {
			return;
		}
		iframeSessions.set(child.sessionId, child.onClose(() => iframeSessions.deleteAndDispose(child.sessionId)));
		void send([child.sessionId], generation);
	}));
	store.add(view.emulator.onDidChange(() => {
		noteDevice();
		applyAll();
	}));
	store.add(state.onDidChangeEnabled(() => {
		if (disposed || view.webContents.isDestroyed()) {
			return;
		}
		if (!view.emulator.device?.userAgent) {
			// 上書きを外したときに見える、タブ自身の UA もセッションの今の UA にそろえる
			view.webContents.setUserAgent(session.getUserAgent());
		}
		applyAll();
	}));
	store.add(view.debugger.onDidDetach(() => {
		iframeSessions.clearAndDisposeAll();
		// 切れたときは付けた上書きも消えている。同じ処理の中で付け直すと切断の後始末と競るので、後で付け直す
		clearTimeout(reapply);
		reapply = setTimeout(applyAll, 0);
	}));
	noteDevice();
	if (state.isEnabled()) {
		applyAll();
	}
	return store;
}
