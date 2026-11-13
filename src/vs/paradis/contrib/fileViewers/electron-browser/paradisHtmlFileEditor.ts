/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// HTML レンダリングビューア（Superset apps/desktop の HtmlPreviewWebview 相当）。
// ローカル HTML を webview に読み込み、スクリプト実行を許可する。
//
// 相対リソースの解決:
// ローカルファイル（file:）のときは、そのフォルダーを 127.0.0.1 だけに開いたローカルサーバへ載せ、
// `<base href>` をそこへ向ける（paradisHtmlPreviewServer）。ブラウザで開いたときと同じ解決になるので、
// 相対パスの読み込みだけでなく **実行時の `fetch` や動的 import までそのまま動く**。あわせて webview の
// service worker を切れるので、起動が 60 秒待たされて白紙になる経路（詳細は paradisHtmlPreviewServer の
// 冒頭）を通らなくなる。
// SSH 先（vscode-remote:）のファイルは、同じサーバを**リモート側にも立てて**ポート転送で手元へ
// 出す。転送が張れない環境では従来どおり webview のリソース URL ＋ service worker へ戻す。
// ズームは Markdown と共通（browser/paradisViewerZoom.ts）。
//
// 信頼していないワークスペース（制限モード）ではスクリプトを動かさない。配信サーバはワークスペースの
// フォルダーごと載せるので、スクリプトが動くと、クローンしただけのリポジトリの HTML が `.env` などを
// fetch して外へ送れてしまう。信頼したワークスペースでは従来どおり動かす（タスクや拡張機能と同じ線引き）。
//
// ワークスペースの外の HTML（~/Downloads に落としたものなど）は、文書のフォルダーを丸ごと載せるので、
// 同じフォルダーの別のファイルを fetch で読めてしまう。ブラウザで file:// を開いたときより広いので、
// `connect-src` を配信元だけに絞り、読んだ中身を fetch・XHR・WebSocket・sendBeacon で外へ送れないようにする
// （{@link paradisHtmlOutsideWorkspaceCsp}）。

import { Schemas } from '../../../../base/common/network.js';
import { escape } from '../../../../base/common/strings.js';
import { dirname, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { ITextResourceConfigurationService } from '../../../../editor/common/services/textResourceConfiguration.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ITextFileService } from '../../../../workbench/services/textfile/common/textfiles.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IRemoteAuthorityResolverService } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { ITunnelService } from '../../../../platform/tunnel/common/tunnel.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { ILifecycleService, LifecyclePhase } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IOverlayWebview, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { asWebviewUri } from '../../../../workbench/contrib/webview/common/webview.js';
import { ParadisRenderedFileEditor } from '../browser/paradisRenderedFileEditor.js';
import { createParadisViewerReloadButton, ParadisViewerZoomControls, paradisViewerZoomMessage, paradisViewerZoomScript } from '../browser/paradisViewerZoom.js';
import { PARADIS_HTML_EDITOR_ID } from '../browser/paradisFileViewers.js';
import { IParadisPreviewLocation, ParadisRemotePreviewMounter, paradisMountLocalPreview } from './paradisHtmlPreviewClient.js';
import { IParadisPreviewMountOptions, paradisPreviewLinkTarget, paradisPreviewUrl } from '../common/paradisHtmlPreview.js';
import { paradisHtmlViewerCanvasScript, paradisHtmlViewerHeadStyle } from '../common/paradisHtmlViewerDefaultStyles.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { ParadisViewerOpenKind } from '../common/paradisViewerOpenTiming.js';

/**
 * 属性値に埋める前のエスケープ。`toString(true)`(skipEncoding) は `"` 等をそのまま残すため、
 * `"` を含むフォルダー名で `<base href>` の属性を突き破る任意マークアップ注入を防ぐ。
 */
function escapeAttribute(value: string): string {
	return escape(value).replace(/"/g, '&quot;');
}

export class ParadisHtmlFileEditor extends ParadisRenderedFileEditor {

	static readonly ID = PARADIS_HTML_EDITOR_ID;

	private readonly _zoom: ParadisViewerZoomControls;
	/** いま描いている文書の `<base>`（配っている URL と、そのフォルダー）。押したリンクをファイルへ戻すため。 */
	private _linkBase: { readonly url: string; readonly root: URI } | undefined;
	/** ローカルサーバを立てられなかった。以後はこのペインでは使わない。 */
	private _previewServerUnavailable = false;
	/** SSH 先のフォルダーを載せる係（ペインと寿命を共にし、転送もここで閉じる）。 */
	private readonly _remoteMounter: ParadisRemotePreviewMounter;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService webviewService: IWebviewService,
		@ITextFileService textFileService: ITextFileService,
		@IFileService fileService: IFileService,
		@ITextModelService textModelService: ITextModelService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IConfigurationService configurationService: IConfigurationService,
		@INotificationService notificationService: INotificationService,
		@ITextResourceConfigurationService textResourceConfigurationService: ITextResourceConfigurationService,
		@IEditorService editorService: IEditorService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@ISharedProcessService private readonly _sharedProcessService: ISharedProcessService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IRemoteAgentService private readonly _remoteAgentService: IRemoteAgentService,
		@IRemoteAuthorityResolverService private readonly _remoteAuthorityResolverService: IRemoteAuthorityResolverService,
		@ITunnelService private readonly _tunnelService: ITunnelService,
		@IWorkspaceTrustManagementService private readonly _workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
		@IOpenerService private readonly _openerService: IOpenerService,
	) {
		super(PARADIS_HTML_EDITOR_ID, group, telemetryService, themeService, storageService, webviewService, textFileService, fileService, textModelService, instantiationService, layoutService, configurationService, notificationService, textResourceConfigurationService, editorService, editorGroupService);
		this._zoom = this._register(new ParadisViewerZoomControls(() => this._onDidChangeZoom()));
		this._remoteMounter = this._register(new ParadisRemotePreviewMounter(this._remoteAgentService, this._remoteAuthorityResolverService, this._tunnelService));
		// 信頼の状態が変わったら、スクリプトの可否を反映するため描き直す。
		this._register(this._workspaceTrustManagementService.onDidChangeTrust(() => this.requestRerender()));
	}

	/** 信頼していないワークスペースではスクリプトを動かさない（冒頭の説明を参照）。 */
	protected override get allowScripts(): boolean {
		return this._workspaceTrustManagementService.isWorkspaceTrusted();
	}

	protected override get openTimingKind(): ParadisViewerOpenKind {
		return 'html';
	}

	// webview 基盤はページ内のアンカー以外のリンクを知らせるだけで自分では開かない（Markdown と同じ）。表示している
	// フォルダーの中のファイルはエディタで開き、外は http(s)・mailto だけを開く（file: や配信サーバの URL は開かない）
	protected override onWebviewCreated(webview: IOverlayWebview, store: DisposableStore): void {
		store.add(webview.onDidClickLink(link => {
			const target = paradisPreviewLinkTarget(link, this._linkBase);
			if (target) {
				this._openerService.open(target.uri, { fromUserGesture: true, allowContributedOpeners: true }).catch(onUnexpectedError);
			}
		}));
	}

	/**
	 * ウィンドウの復元中（Restored の前）は、最初の描画を待たずに `setInput` を返す。
	 *
	 * 描画は shared process のプレビューサーバへの mount を待つ。shared process への接続は Restored か
	 * ウィンドウを開いてから 2 秒のどちらかまで始まらず（sharedProcessService.ts）、Restored は表示中の
	 * エディタの復元（この `setInput`）を最大 2 秒待つ（workbench.ts）。互いに待って 2 秒のタイマーで
	 * 解けるので、起動時に HTML のタブがあるとウィンドウ全体の Restored が遅れていた。復元が済んだ後に
	 * 開くときは今までどおり待つ（開けなかったときの扱いを変えない）。
	 */
	protected override get awaitsInitialRender(): boolean {
		return this._lifecycleService.phase >= LifecyclePhase.Restored;
	}

	/** 復元が済んでから開き直す（その時は待つので、失敗は今までどおり「開けなかった」表示になる）。 */
	protected override onInitialRenderFailedInBackground(input: EditorInput, options: IEditorOptions | undefined): void {
		this._lifecycleService.when(LifecyclePhase.Restored).then(() => super.onInitialRenderFailedInBackground(input, options));
	}

	/**
	 * ローカルファイルはローカルサーバから配れるので service worker は要らない。
	 *
	 * サーバを立てられなかったときは次の描画から従来どおり service worker で解決する
	 * （基底クラスが判断の変化を見て webview を作り直す）。
	 */
	protected override disableServiceWorkerFor(resource: URI): boolean {
		return this._canServeFromPreviewServer(resource);
	}

	/** このリソースを配信サーバから出せるか（手元のファイル、または SSH 先のファイル）。 */
	private _canServeFromPreviewServer(resource: URI): boolean {
		if (this._previewServerUnavailable) {
			return false;
		}
		return resource.scheme === Schemas.file
			|| (resource.scheme === Schemas.vscodeRemote && !!this._remoteAgentService.getConnection());
	}

	protected override onCreateToolbar(toolbar: HTMLElement): void {
		this._zoom.createButtons(toolbar);

		// ページを読み込み直す（スクリプトの再実行、CSS・画像の取り直し）
		this._register(createParadisViewerReloadButton(toolbar, () => this.webview?.reload()));
	}

	/**
	 * 相対リソースの解決先（エスケープ前の URL）。末尾は必ず `/`。
	 *
	 * ローカルファイルはローカルサーバ、それ以外（リモート等）は webview のリソース URL。
	 * `outsideWorkspace` は、ワークスペースの中に素直に下れず文書のフォルダーを載せたこと。
	 */
	private async _resolveBase(resource: URI): Promise<{ readonly url: string; readonly outsideWorkspace: boolean }> {
		// 載せるのは、そのファイルが属するワークスペースフォルダー（無ければファイルのフォルダー）。
		// ページの中の `../assets/style.css` のような参照はごく普通なので、フォルダー1つだけを
		// 載せると URL のトークンより上へ出てしまい読めなくなる。
		const documentDirectory = dirname(resource);
		const folder = this._workspaceContextService.getWorkspaceFolder(resource)?.uri;
		// フォルダーの中での位置が「素直に下る道」で出せないときは、そのフォルダーを
		// 載せてはいけない。`getWorkspaceFolder` は大文字小文字を無視して照合する環境が
		// あるのに対し `relativePath` は区別するため、**属していると判定されたのに
		// `../` で上へ抜ける相対パスが返る**ことが起こり得る。そのまま base に足すと
		// URL のトークンより外を指してページの読み込みが全部落ちる。
		const candidate = folder && folder.scheme === resource.scheme ? folder : undefined;
		const relative = candidate ? relativePath(candidate, documentDirectory) : undefined;
		const descends = relative !== undefined && !relative.startsWith('..');
		// ワークスペースの中に素直に下れないものは、文書のフォルダーを載せる「外の文書」として扱う。
		const outsideWorkspace = !descends;
		if (this._canServeFromPreviewServer(resource)) {
			try {
				const root = descends ? candidate! : documentDirectory;
				const suffix = descends && relative ? relative.split('/') : [];

				// 外の文書は、ページが iframe で開く子のフレームにも同じ `connect-src` を付けるよう、配信サーバーに頼む
				const located = await this._mountPreview(root, outsideWorkspace ? { connectSelfOnly: true } : undefined);
				this._linkBase = { url: paradisPreviewUrl(located.mount, located.port), root };
				return { url: paradisPreviewUrl(located.mount, located.port, suffix), outsideWorkspace };
			} catch (error) {
				// shared process が落ちている、SSH のポート転送が張れない等。
				this._previewServerUnavailable = true;
				reportParadisDiagnosticError('owned', 'file-viewers', 'html-preview-server', error);
				// **自分で描き直しを蹴ること。** この回は「service worker を切った webview に、
				// service worker でしか解決できない URL を渡す」状態になり、画像も CSS も
				// スクリプトも全部読めない。setHtml は成功するので白紙検知も鳴らず、
				// ユーザーがタブを切り替えるまで壊れた表示が残ってしまう。
				queueMicrotask(() => this.requestRerender());
			}
		}
		const remoteInfo = resource.scheme === Schemas.vscodeRemote ? { isRemote: true, authority: resource.authority } : undefined;
		const url = `${asWebviewUri(dirname(resource), remoteInfo).toString(true)}/`;
		this._linkBase = { url, root: dirname(resource) };
		return { url, outsideWorkspace };
	}

	/** 手元か SSH 先か、フォルダーの scheme で配信先を選ぶ。 */
	private _mountPreview(root: URI, options?: IParadisPreviewMountOptions): Promise<IParadisPreviewLocation> {
		if (root.scheme === Schemas.vscodeRemote) {
			return this._remoteMounter.mount(root, options);
		}
		return paradisMountLocalPreview(this._sharedProcessService, root, options);
	}

	protected applyZoom(level: number): void {
		this._zoom.setLevel(level);
	}

	private _onDidChangeZoom(): void {
		if (this.allowScripts) {
			void this.webview?.postMessage(paradisViewerZoomMessage(this._zoom.factor));
		} else {
			// スクリプトを動かさないとき（制限モード）はページの中で倍率を変えられないので、新しい倍率を
			// CSS に焼き込んで描き直す。
			this.requestRerender();
		}
	}

	protected override async renderDocument(text: string, resource: URI, _webview: IOverlayWebview): Promise<string> {
		const base = await this._resolveBase(resource);
		const baseHref = escapeAttribute(base.url);

		// <base> で相対リソースの解決先を決め（ローカルサーバ、またはリモート用の webview リソース URL）、
		// 初期ズームを CSS zoom で焼き込む。
		// 背景色: webview の body は既定で透明のため、背景無指定の HTML はエディタ背景（＋ウィンドウ透過）が
		// 透けて読めなくなる。ブラウザ既定と同じ白を html に敷く。著者が背景を指定していればそちらが勝つ。
		// 文字・リンク・コードの色も、白地に合わせて標準のブラウザの既定に戻す（ページが色を決めていればそちらが勝つ）。
		// ページが body にだけ背景を付けているときは、読み込んだ後に白を外して body の背景を画面全体に広げる。
		const headInjection = `<base href="${baseHref}">${paradisHtmlViewerHeadStyle(this._zoom.factor)}`;
		// ライブなズーム変更（ボタン操作）を postMessage で受け取り、スクロール位置を保ったまま反映する。
		const zoomScript = paradisViewerZoomScript();

		const injected = paradisInjectHtmlHead(text, headInjection);
		// 外の文書の CSP は、ページのどのスクリプトよりも前に置く（{@link paradisInsertAtDocumentStart}）。
		const html = base.outsideWorkspace ? paradisInsertAtDocumentStart(injected, paradisHtmlOutsideWorkspaceCsp(base.url)) : injected;

		// 末尾に足す。`</body>` を探して差し込むと、**ページ自身のスクリプトの中にある文字列**の
		// `</body>` に当たることがあり、注入した `</script>` がそのスクリプトを途中で終わらせて
		// 以降が全部本文として表示される（paracode-121 で実際に起きた）。閉じタグの後ろに置いても
		// パーサーが body の中へ入れてくれるので、探さないのが正しい。
		// スクロール位置の復元と検索結果の色のスクリプトも同じ理由で末尾に足す。スクリプトを動かさない
		// とき（制限モード）は入れても動かないので入れない（webview を作り直した直後の初回表示だけは
		// webview 自身がスクロール位置を戻す）。
		const pageScripts = this.allowScripts ? this.viewerPageScripts(resource) + paradisHtmlViewerCanvasScript() : '';
		return `${html}${zoomScript}${pageScripts}`;
	}
}

/** webview のリソース URL（service worker で解決する経路）。手元・SSH 先でホスト名の前半が変わる。 */
const PARADIS_WEBVIEW_RESOURCE_HOST_SUFFIX = '.vscode-resource.vscode-cdn.net';

/**
 * ワークスペースの外の HTML に当てる CSP の meta 要素。`connect-src` を、文書を配っている所（`baseUrl` の origin）だけに絞る。
 *
 * 同じフォルダーの別のファイルを fetch で読むこと自体は止めない（ページの `fetch('./data.json')` を動かすため）。
 * 止めるのは、読んだものを fetch・XHR・WebSocket・EventSource・sendBeacon で外へ送ること。画像の読み込みや
 * フォームの送信は `connect-src` の外なので、この CSP では止まらない。
 * `data:` と `blob:` も許す（埋め込みの wasm や `fetch(dataUrl)` を動かすため）。どちらも手元の URL なので外へは送れない。
 *
 * webview のリソース URL のホスト名には CSP のホストに書けない `+` が入るので、その経路ではホストの前半を `*` にする
 * （そこから読めるのも webview の localResourceRoots＝文書のフォルダーだけ）。
 */
export function paradisHtmlOutsideWorkspaceCsp(baseUrl: string): string {
	const url = new URL(baseUrl);
	const source = url.hostname.endsWith(PARADIS_WEBVIEW_RESOURCE_HOST_SUFFIX)
		? `${url.protocol}//*${PARADIS_WEBVIEW_RESOURCE_HOST_SUFFIX}`
		: url.origin;
	return `<meta http-equiv="Content-Security-Policy" content="connect-src ${escapeAttribute(source)} data: blob:">`;
}

/** 文書の先頭の BOM・空白・コメントと `<!DOCTYPE>`。これより前に要素を置くと quirks mode になる。 */
const PARADIS_HTML_DOCUMENT_PROLOGUE = /^\uFEFF?(?:\s|<!--[\s\S]*?-->)*(?:<!doctype(?=[\s>])[^>]*>)?/i;

/**
 * `injection` を文書の一番前（先頭の `<!DOCTYPE>` の直後）に置く。
 *
 * `<head>` の開きタグを探して差し込むと、`<!-- <head> -->` のようなコメントや、`<head>` より前の `<script>` が
 * CSP より先に読まれる。ここに置けば、パーサーは最初に head を作ってこの要素を入れるので、ページのどの
 * スクリプトよりも前になる（後に来る著者の `<html>`・`<head>` の開きタグは仕様どおり 1 つにまとめられる）。
 */
export function paradisInsertAtDocumentStart(html: string, injection: string): string {
	const prologue = PARADIS_HTML_DOCUMENT_PROLOGUE.exec(html)?.[0] ?? '';
	return `${prologue}${injection}${html.slice(prologue.length)}`;
}

/** `<head>` の開きタグ。タグ名の直後を空白か `>` に限り、`<header>` に当たらないようにする。 */
const PARADIS_HTML_HEAD_OPEN_TAG = /<head(?=[\s>])[^>]*>/i;
const PARADIS_HTML_HTML_OPEN_TAG = /<html(?=[\s>])[^>]*>/i;

/**
 * 著者の HTML の `<head>` の先頭に `headInjection` を差し込む。`<head>` が無ければ `<html>` の直後に、
 * どちらも無ければ先頭に `<head>` を作って入れる（HTML5 では `<head>` の省略が正当）。
 */
export function paradisInjectHtmlHead(html: string, headInjection: string): string {
	if (PARADIS_HTML_HEAD_OPEN_TAG.test(html)) {
		return html.replace(PARADIS_HTML_HEAD_OPEN_TAG, match => `${match}${headInjection}`);
	}
	if (PARADIS_HTML_HTML_OPEN_TAG.test(html)) {
		return html.replace(PARADIS_HTML_HTML_OPEN_TAG, match => `${match}<head>${headInjection}</head>`);
	}
	return `<head>${headInjection}</head>${html}`;
}
