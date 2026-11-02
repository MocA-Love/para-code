/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ファイルビューア（Markdown/HTML・PDF・Word・Word 差分）が overlay webview を持つための部品。どのエディタでも同じ
// 定型の処理（origin の貸し出し、service worker の要否が変わったときの作り直し、claim・release・配置、同梱ライブラリの
// 置き場の解決と文書の配信の失敗、閉じたときに中身を捨てること、基盤の致命エラーの報告）をここに集める。
// エディタはこれを持つ（継承しない。エディタごとに基底クラスと DI の並びが違うため）。
//
// 白紙の検知（内容が届かないまま時間切れになったら作り直し、最後は Raw へ倒す）は、Raw のある Markdown/HTML の基底
// （paradisRenderedFileEditor.ts）だけが持つ。PDF には Raw が無いので倒し先が無く、ここでは入れない。基盤の致命エラーは
// Sentry へ送るので、実際に起きていると分かったら、作り直しを 1 回だけ行う形を考える。

import * as dom from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { FileChangeType, IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { CodeWindow } from '../../../../base/browser/window.js';
import { IOverlayWebview, IWebviewService, WebviewContentPurpose } from '../../../../workbench/contrib/webview/browser/webview.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { ParadisWebviewOriginPool } from './paradisWebviewOriginPool.js';
import { canReuseParadisShownDocument, type IParadisShownDocument } from '../common/paradisViewerShownDocument.js';

/** {@link ParadisOverlayWebviewPane} の作り方。 */
export interface IParadisOverlayWebviewPaneOptions {
	/** origin を借りる種類（エディタの ID）。同時に開いた他のビューアとは別の origin になる。 */
	readonly originKey: string;
	readonly enableFindWidget: boolean;
	/** webview の中でスクリプトを動かすか（作るときに読む）。 */
	readonly allowScripts: boolean | (() => boolean);
	/**
	 * 同梱ライブラリの置き場（ローカルの配信サーバの URL）を決める。webview は答えが出るまで作らない
	 * （service worker の要否は生成時にしか渡せないため）。置き場の要らないビューアは渡さない。
	 */
	readonly resolveLibBase?: () => Promise<string | undefined>;
	/** webview を作った直後。購読は `store` に足すこと（webview を作り直すたびに捨てられる）。 */
	readonly onDidCreate?: (webview: IOverlayWebview, store: DisposableStore) => void;
	/** webview を捨てた直後（エディタの側で、その webview に結び付いた記録を捨てる）。 */
	readonly onDidDispose?: () => void;
	/**
	 * webview 基盤の致命エラー（service worker の登録の失敗など）を Sentry へ送るときのビューアの種類。
	 * 自分で受けて立て直すビューア（Markdown/HTML の基底）は渡さない。
	 */
	readonly reportFatalErrorAs?: string;
}

/**
 * ファイルビューアが持つ overlay webview。`TShown` は、タブを離れて戻ったときに描き直さないための記録
 * （{@link IParadisShownDocument}。ビューアごとの欄を足してよい）。記録を捨てる時点（webview を捨てた・閉じた・
 * 描き終わりを確かめる前に離れた）と、同じ webview かの判定はここが持つ。
 */
export class ParadisOverlayWebviewPane<TShown extends IParadisShownDocument<IOverlayWebview> = IParadisShownDocument<IOverlayWebview>> extends Disposable {

	private readonly _originPool: ParadisWebviewOriginPool;
	private readonly _webviewStore = this._register(new MutableDisposable<DisposableStore>());
	private _webview: IOverlayWebview | undefined;
	private _claimed = false;
	private _serviceWorkerDisabled = false;
	private _libBase: Promise<string | undefined> | undefined;
	private _libBaseResolved: boolean;
	private _resolvedLibBase: string | undefined;
	private _documentServeFailed = false;
	/** いま webview に書いてある文書のリソース（閉じたタブの中身を捨てるかの判断に使う）。 */
	private _displayedResource: URI | undefined;
	private _shown: TShown | undefined;

	constructor(
		/** claim・release の持ち主（エディタ）。 */
		private readonly _owner: object,
		private readonly _options: IParadisOverlayWebviewPaneOptions,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IStorageService storageService: IStorageService,
	) {
		super();
		this._originPool = ParadisWebviewOriginPool.getShared(storageService);
		this._libBaseResolved = !_options.resolveLibBase;
	}

	/** いまの webview（まだ作っていなければ `undefined`）。 */
	get webview(): IOverlayWebview | undefined {
		return this._webview;
	}

	/** このエディタが webview を claim しているか。 */
	get claimed(): boolean {
		return this._claimed;
	}

	/** いまの webview を作ったときに service worker を切ったか。 */
	get serviceWorkerDisabled(): boolean {
		return this._serviceWorkerDisabled;
	}

	/** 同梱ライブラリの置き場の答えが出たか。 */
	get libBaseResolved(): boolean {
		return this._libBaseResolved;
	}

	/** 同梱ライブラリの置き場（載せられなかった・まだ決まっていなければ `undefined`）。 */
	get libBase(): string | undefined {
		return this._resolvedLibBase;
	}

	/**
	 * 文書だけ載せられなかったことがあるか。
	 *
	 * ライブラリは載ったが文書の mount だけ失敗すると、「service worker を切った webview に、
	 * service worker でしか解決できない URL を渡す」状態になり、ライブラリすら読めなくなる。
	 * **真偽値を毎回計算し直すと配置の側（文書 URL を知らない）と食い違って作り直しが
	 * 往復する**ので、一度失敗したらラッチして以後はサーバを使わない。
	 */
	get documentServeFailed(): boolean {
		return this._documentServeFailed;
	}

	markDocumentServeFailed(): void {
		this._documentServeFailed = true;
	}

	/** webview にいま残っている文書の記録（タブへ戻ったときに描き直さないため）。 */
	get shown(): TShown | undefined {
		return this._shown;
	}

	set shown(value: TShown | undefined) {
		this._shown = value;
	}

	/** 記録の中身が `keys` と同じで、描き終わりを確かめてあり、いまの webview に描いたものか。 */
	canReuseShown(resource: URI, keys: readonly unknown[]): boolean {
		return canReuseParadisShownDocument(this._shown, resource, this._webview, keys);
	}

	/** `webview` に描いた記録があれば、描き終わりを確かめたことにする。 */
	confirmShown(webview: IOverlayWebview): void {
		if (this._shown && this._shown.webview === webview) {
			this._shown = { ...this._shown, confirmed: true };
		}
	}

	/** 描き終わりを確かめる前に離れたら、記録を捨てる（戻ったときに描き直す。白紙のまま残さない）。 */
	forgetUnconfirmedShown(): void {
		if (this._shown && !this._shown.confirmed) {
			this._shown = undefined;
		}
	}

	/** 同梱ライブラリの置き場を決める。**ペインにつき一度だけ**決める（アプリの中にあるので入力に依らない）。 */
	async resolveLibBase(): Promise<string | undefined> {
		if (!this._options.resolveLibBase) {
			return undefined;
		}
		this._libBase ??= this._options.resolveLibBase();
		const libBase = await this._libBase;
		this._resolvedLibBase = libBase;
		this._libBaseResolved = true;
		return libBase;
	}

	/**
	 * webview を返す（無ければ作る）。service worker の要否が今の webview と違えば作り直す（生成時の
	 * オプションなので、後から変えられない）。
	 */
	ensure(disableServiceWorker: boolean, localResourceRoots: readonly URI[]): IOverlayWebview {
		if (this._webview && this._serviceWorkerDisabled !== disableServiceWorker) {
			this.disposeWebview();
		}
		if (this._webview) {
			return this._webview;
		}
		const store = new DisposableStore();
		this._webviewStore.value = store;
		this._serviceWorkerDisabled = disableServiceWorker;
		// origin を渡さないと webview ごとに新しい service worker 登録が増え、二度と消えない。
		const originLease = store.add(this._originPool.acquire(this._options.originKey));
		const webview = store.add(this._webviewService.createWebviewOverlay({
			origin: originLease.origin,
			title: undefined,
			options: {
				purpose: WebviewContentPurpose.CustomEditor,
				enableFindWidget: this._options.enableFindWidget,
				tryRestoreScrollPosition: true,
				// 非表示になるたびに service worker 登録からやり直すと、白紙で止まる窓が毎回でき直す
				// （「Rendered だけ間欠的に白紙になる」フィールド報告の主因）。生かしたまま隠すことでその窓を無くす。
				retainContextWhenHidden: true,
				disableServiceWorker,
			},
			contentOptions: {
				allowScripts: typeof this._options.allowScripts === 'function' ? this._options.allowScripts() : this._options.allowScripts,
				localResourceRoots: [...localResourceRoots],
			},
			extension: undefined,
		}));
		this._webview = webview;
		const viewer = this._options.reportFatalErrorAs;
		if (viewer) {
			// リソースのパスは含めない（ビューアの種類だけで足りる）。
			store.add(webview.onFatalError(e => reportParadisDiagnosticError('owned', 'file-viewers', 'webview-fatal-error', new Error(e.message), { safe_viewer: viewer })));
		}
		this._options.onDidCreate?.(webview, store);
		return webview;
	}

	/** claim を解いてから webview 本体と購読を捨てる。次の {@link ensure} で作り直される。 */
	disposeWebview(): void {
		this.release();
		this._webview = undefined;
		this._displayedResource = undefined;
		// 作り直した webview には前の中身が無い。
		this._shown = undefined;
		this._webviewStore.clear();
		this._options.onDidDispose?.();
	}

	/** claim していれば解く（webview は残す）。 */
	release(): void {
		if (this._webview && this._claimed) {
			this._webview.release(this._owner);
		}
		this._claimed = false;
	}

	/**
	 * 表示するなら claim して `container` に重ね、しないなら release する。同梱ライブラリの置き場がまだ決まって
	 * いなければ決めに行き、決まったら `onLibBaseResolved` を呼ぶ（呼び出し側がもう一度配置する）。
	 *
	 * @returns 今回 claim したか（claim で下地が作り直され内容が失われ得るので、`true` なら描き直す）。表示しない・
	 * まだ置けないときは `undefined`。
	 */
	place(show: boolean, targetWindow: CodeWindow, container: HTMLElement, webviewOptions: () => { readonly disableServiceWorker: boolean; readonly localResourceRoots: readonly URI[] }, onLibBaseResolved: () => void): boolean | undefined {
		if (!show) {
			this.release();
			return undefined;
		}
		if (!this._webview && !this._libBaseResolved) {
			// 配信先が決まる前に作ると service worker の要否を間違える。**ここで自分で解決を蹴ること。**
			// 描画側に任せると、描画は claim 済みでないと走らないので、初回は誰も蹴らずに白紙のまま止まる。
			void this.resolveLibBase().then(onLibBaseResolved);
			return undefined;
		}
		const { disableServiceWorker, localResourceRoots } = webviewOptions();
		const webview = this.ensure(disableServiceWorker, localResourceRoots);
		const justClaimed = !this._claimed;
		if (justClaimed) {
			webview.claim(this._owner, targetWindow, undefined);
			this._claimed = true;
		}
		dom.setParentFlowTo(webview.container, container);
		webview.setAnchorElement(container, this._layoutService.getContainer(targetWindow, Parts.EDITOR_PART));
		return justClaimed;
	}

	/** `resource` の文書の HTML を webview へ書く（書いた文書を覚えておく）。 */
	setDocumentHtml(webview: IOverlayWebview, resource: URI, html: string): void {
		webview.setHtml(html);
		this._displayedResource = resource;
	}

	/** webview の中身を空にする。 */
	clearContent(): void {
		this._webview?.setHtml('');
		this._displayedResource = undefined;
	}

	/**
	 * タブを閉じた。そのタブの文書の記録を捨て、いま書いてある文書がそれなら中身も空にする（閉じたタブのために
	 * 残していた描画結果を捨てる）。
	 */
	clearContentFor(resource: URI | undefined): void {
		if (!resource) {
			return;
		}
		if (this._shown && isEqual(this._shown.resource, resource)) {
			this._shown = undefined;
		}
		if (this._displayedResource && isEqual(this._displayedResource, resource)) {
			this.clearContent();
		}
	}
}

/**
 * ビューアが表示しているファイルの変更を見張る。変更の通知が続いても `delay` ms に 1 回だけ `onChange` を呼ぶ
 * （`deleted` は、その間に削除の通知があったか）。watcher を作れなければ何もしない（表示は続けられる）。
 */
export function watchParadisViewerResource(fileService: IFileService, resource: URI, onChange: (deleted: boolean) => void, delay = 50): IDisposable {
	const store = new DisposableStore();
	try {
		const watcher = store.add(fileService.createWatcher(resource, { recursive: false, excludes: [] }));
		let deleted = false;
		const scheduler = store.add(new RunOnceScheduler(() => {
			const wasDeleted = deleted;
			deleted = false;
			onChange(wasDeleted);
		}, delay));
		store.add(watcher.onDidChange(e => {
			if (!e.contains(resource)) {
				return;
			}
			deleted ||= e.contains(resource, FileChangeType.DELETED);
			if (!scheduler.isScheduled()) {
				scheduler.schedule();
			}
		}));
	} catch {
		// watcher が作れなくても表示は継続できる。
	}
	return store;
}

