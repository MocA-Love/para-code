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
// ズームは Superset 同様に倍率 1.2^level（範囲 -3〜+5）で、CSS zoom を webview 内に適用する。

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Schemas } from '../../../../base/common/network.js';
import { escape } from '../../../../base/common/strings.js';
import { dirname, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ITextFileService } from '../../../../workbench/services/textfile/common/textfiles.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IRemoteAuthorityResolverService } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { ITunnelService } from '../../../../platform/tunnel/common/tunnel.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IOverlayWebview, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { asWebviewUri } from '../../../../workbench/contrib/webview/common/webview.js';
import { ParadisRenderedFileEditor } from '../browser/paradisRenderedFileEditor.js';
import { PARADIS_HTML_EDITOR_ID } from '../browser/paradisFileViewers.js';
import { IParadisPreviewLocation, ParadisRemotePreviewMounter, paradisMountLocalPreview } from './paradisHtmlPreviewClient.js';
import { paradisPreviewUrl } from '../common/paradisHtmlPreview.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';

/**
 * 属性値に埋める前のエスケープ。`toString(true)`(skipEncoding) は `"` 等をそのまま残すため、
 * `"` を含むフォルダー名で `<base href>` の属性を突き破る任意マークアップ注入を防ぐ。
 */
function escapeAttribute(value: string): string {
	return escape(value).replace(/"/g, '&quot;');
}

const ZOOM_MIN = -3;
const ZOOM_MAX = 5;
const ZOOM_BASE = 1.2;

export class ParadisHtmlFileEditor extends ParadisRenderedFileEditor {

	static readonly ID = PARADIS_HTML_EDITOR_ID;

	private _zoomLevel = 0;
	/** ローカルサーバを立てられなかった。以後はこのペインでは使わない。 */
	private _previewServerUnavailable = false;
	/** SSH 先のフォルダーを載せる係（ペインと寿命を共にし、転送もここで閉じる）。 */
	private readonly _remoteMounter: ParadisRemotePreviewMounter;
	private _zoomOutButton: HTMLButtonElement | undefined;
	private _zoomInButton: HTMLButtonElement | undefined;
	private _percentButton: HTMLButtonElement | undefined;

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
		@ISharedProcessService private readonly _sharedProcessService: ISharedProcessService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IRemoteAgentService private readonly _remoteAgentService: IRemoteAgentService,
		@IRemoteAuthorityResolverService private readonly _remoteAuthorityResolverService: IRemoteAuthorityResolverService,
		@ITunnelService private readonly _tunnelService: ITunnelService,
	) {
		super(PARADIS_HTML_EDITOR_ID, group, telemetryService, themeService, storageService, webviewService, textFileService, fileService, textModelService, instantiationService, layoutService, configurationService, notificationService);
		this._remoteMounter = this._register(new ParadisRemotePreviewMounter(this._remoteAgentService, this._remoteAuthorityResolverService, this._tunnelService));
	}

	protected override get allowScripts(): boolean {
		return true;
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
		this._zoomOutButton = this._createIconButton(toolbar, Codicon.zoomOut, localize('paradis.html.zoomOut', "Zoom Out"));
		this._register(dom.addDisposableListener(this._zoomOutButton, dom.EventType.CLICK, () => this._applyZoom(this._zoomLevel - 1)));

		this._percentButton = dom.append(toolbar, dom.$('button.paradis-html-zoom-percent')) as HTMLButtonElement;
		this._percentButton.title = localize('paradis.html.resetZoom', "Reset Zoom");
		this._register(dom.addDisposableListener(this._percentButton, dom.EventType.CLICK, () => this._applyZoom(0)));

		this._zoomInButton = this._createIconButton(toolbar, Codicon.zoomIn, localize('paradis.html.zoomIn', "Zoom In"));
		this._register(dom.addDisposableListener(this._zoomInButton, dom.EventType.CLICK, () => this._applyZoom(this._zoomLevel + 1)));

		const refreshButton = this._createIconButton(toolbar, Codicon.refresh, localize('paradis.html.refresh', "Reload"));
		this._register(dom.addDisposableListener(refreshButton, dom.EventType.CLICK, () => this.webview?.reload()));

		this._updateZoomUI();
	}

	/**
	 * 相対リソースの解決先。末尾は必ず `/`。
	 *
	 * ローカルファイルはローカルサーバ、それ以外（リモート等）は webview のリソース URL。
	 */
	private async _resolveBaseHref(resource: URI): Promise<string> {
		if (this._canServeFromPreviewServer(resource)) {
			try {
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
				const root = descends ? candidate! : documentDirectory;
				const suffix = descends && relative ? relative.split('/') : [];

				const located = await this._mountPreview(root);
				return escapeAttribute(paradisPreviewUrl(located.mount, located.port, suffix));
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
		return escapeAttribute(`${asWebviewUri(dirname(resource), remoteInfo).toString(true)}/`);
	}

	/** 手元か SSH 先か、フォルダーの scheme で配信先を選ぶ。 */
	private _mountPreview(root: URI): Promise<IParadisPreviewLocation> {
		if (root.scheme === Schemas.vscodeRemote) {
			return this._remoteMounter.mount(root);
		}
		return paradisMountLocalPreview(this._sharedProcessService, root);
	}

	private _createIconButton(parent: HTMLElement, icon: ThemeIcon, title: string): HTMLButtonElement {
		const button = dom.append(parent, dom.$('button.paradis-html-zoom-button')) as HTMLButtonElement;
		button.title = title;
		dom.append(button, dom.$(`span${ThemeIcon.asCSSSelector(icon)}`));
		return button;
	}

	private get _zoomFactor(): number {
		return ZOOM_BASE ** this._zoomLevel;
	}

	private _applyZoom(level: number): void {
		const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
		if (clamped === this._zoomLevel) {
			this._updateZoomUI();
			return;
		}
		this._zoomLevel = clamped;
		void this.webview?.postMessage({ __paradisZoom: this._zoomFactor });
		this._updateZoomUI();
	}

	private _updateZoomUI(): void {
		if (this._percentButton) {
			this._percentButton.textContent = `${Math.round(this._zoomFactor * 100)}%`;
		}
		if (this._zoomOutButton) {
			this._zoomOutButton.disabled = this._zoomLevel <= ZOOM_MIN;
		}
		if (this._zoomInButton) {
			this._zoomInButton.disabled = this._zoomLevel >= ZOOM_MAX;
		}
	}

	protected override async renderDocument(text: string, resource: URI, _webview: IOverlayWebview): Promise<string> {
		const baseHref = await this._resolveBaseHref(resource);

		// <base> で相対リソースの解決先を決め（ローカルサーバ、またはリモート用の webview リソース URL）、
		// 初期ズームを CSS zoom で焼き込む。
		// 背景色: webview の body は既定で透明のため、背景無指定の HTML はエディタ背景（＋ウィンドウ透過）が
		// 透けて読めなくなる。ブラウザ既定と同じ白を html に敷く。著者が背景を指定していればそちらが勝つ。
		const headInjection = `<base href="${baseHref}"><style>html{zoom:${this._zoomFactor};background-color:#ffffff;}</style>`;
		// ライブなズーム変更（ボタン操作）を postMessage で受け取り、スクロール位置を保ったまま反映する。
		const zoomScript = `<script>(function(){try{window.addEventListener('message',function(e){var d=e.data;if(d&&typeof d.__paradisZoom==='number'){document.documentElement.style.zoom=String(d.__paradisZoom);}});}catch(err){}})();</script>`;

		let html = text;
		if (/<head[^>]*>/i.test(html)) {
			html = html.replace(/<head[^>]*>/i, match => `${match}${headInjection}`);
		} else if (/<html[^>]*>/i.test(html)) {
			html = html.replace(/<html[^>]*>/i, match => `${match}<head>${headInjection}</head>`);
		} else {
			html = `<head>${headInjection}</head>${html}`;
		}

		// 末尾に足す。`</body>` を探して差し込むと、**ページ自身のスクリプトの中にある文字列**の
		// `</body>` に当たることがあり、注入した `</script>` がそのスクリプトを途中で終わらせて
		// 以降が全部本文として表示される（paracode-121 で実際に起きた）。閉じタグの後ろに置いても
		// パーサーが body の中へ入れてくれるので、探さないのが正しい。
		return `${html}${zoomScript}`;
	}
}
