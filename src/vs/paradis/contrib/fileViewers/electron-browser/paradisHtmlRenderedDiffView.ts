/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// HTML の差分の「プレビュー差分」。バー・切り替え・↑↓・拡大は Markdown のプレビュー差分と同じ部品
// （paradisMarkdownRenderedDiffView）を使い、描く所だけを替える。
//
// 両側の HTML を解析してスクリプトを止め、要素の木を突き合わせて印を付け（browser/paradisHtmlRenderedDiff）、外枠の
// 中の sandbox の iframe に入れる（common/paradisHtmlRenderedDiffFrame）。ページのスクリプトはワークスペースを信頼して
// いても動かさない（資料のコメントの外枠で、信頼していないワークスペースのページに付けるものと同じ sandbox）。
// 相対パスの CSS・画像は、HTML のビューアと同じ配信サーバから、今の作業ツリーのものを読む（古い側も同じ。バーに
// 断り書きを出す）。配信サーバを使えないとき・要素が多すぎるときは、テキスト差分のままにする。

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { escape } from '../../../../base/common/strings.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IRemoteAuthorityResolverService } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ITunnelService } from '../../../../platform/tunnel/common/tunnel.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IOverlayWebview } from '../../../../workbench/contrib/webview/browser/webview.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { buildParadisHtmlRenderedDiffPages, PARADIS_HTML_RENDERED_DIFF_ANCHOR_ATTRIBUTE } from '../browser/paradisHtmlRenderedDiff.js';
import { IParadisRenderedDiffHost, IParadisRenderedDiffInput, ParadisFileDiffViewMode, ParadisMarkdownRenderedDiffView } from '../browser/paradisMarkdownRenderedDiffView.js';
import { ParadisRenderedDiffLayout, PARADIS_RENDERED_DIFF_CHANGE_ATTRIBUTE } from '../browser/paradisRenderedDiffDom.js';
import { paradisPreviewLinkTarget, paradisPreviewMountTarget, paradisPreviewUrl } from '../common/paradisHtmlPreview.js';
import { IParadisHtmlRenderedDiffKey, paradisHtmlRenderedDiffFrameDocument, paradisReadHtmlRenderedDiffMessage } from '../common/paradisHtmlRenderedDiffFrame.js';
import { paradisHtmlFrameDefaultStyle, paradisHtmlViewerHeadStyle } from '../common/paradisHtmlViewerDefaultStyles.js';
import { PARADIS_WEBVIEW_HOST_MESSAGE_CHECK } from '../common/paradisWebviewHostMessage.js';
import { IParadisPreviewLocation, ParadisRemotePreviewMounter, paradisMountLocalPreview } from './paradisHtmlPreviewClient.js';

/** HTML の差分を開いたときの表示の設定。 */
export const PARADIS_HTML_DIFF_VIEW_SETTING = 'paradis.htmlViewer.diffView';
const LAST_MODE_STORAGE_KEY = 'paradis.htmlViewer.diffView.lastMode';

export class ParadisHtmlRenderedDiffView extends ParadisMarkdownRenderedDiffView {

	/** SSH 先のフォルダーを載せる係（部品と寿命を共にし、転送もここで閉じる）。 */
	private readonly _remoteMounter: ParadisRemotePreviewMounter;
	/** 外枠からのメッセージに付く印（webview を作るたびに替える）。 */
	private _token = generateUuid();
	/** いま描いている文書の配信先（押したリンクをファイルへ戻すため）。 */
	private _linkBase: { readonly url: string; readonly root: URI } | undefined;

	constructor(
		host: IParadisRenderedDiffHost,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IStorageService storageService: IStorageService,
		@IFileService fileService: IFileService,
		@IExtensionService extensionService: IExtensionService,
		@ILanguageService languageService: ILanguageService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IOpenerService private readonly _opener: IOpenerService,
		@IThemeService themeService: IThemeService,
		@ISharedProcessService private readonly _sharedProcessService: ISharedProcessService,
		@IRemoteAgentService private readonly _remoteAgentService: IRemoteAgentService,
		@IRemoteAuthorityResolverService remoteAuthorityResolverService: IRemoteAuthorityResolverService,
		@ITunnelService tunnelService: ITunnelService,
	) {
		super(host, instantiationService, configurationService, storageService, fileService, extensionService, languageService, _workspace, _opener, themeService);
		this._remoteMounter = this._register(new ParadisRemotePreviewMounter(_remoteAgentService, remoteAuthorityResolverService, tunnelService));
	}

	protected override get diffViewSetting(): string {
		return PARADIS_HTML_DIFF_VIEW_SETTING;
	}

	protected override get lastModeStorageKey(): string {
		return LAST_MODE_STORAGE_KEY;
	}

	/** HTML はコードとして直すことが多いので、既定はテキスト差分。 */
	protected override get fallbackMode(): ParadisFileDiffViewMode {
		return 'text';
	}

	protected override onWebviewCreated(webview: IOverlayWebview, store: DisposableStore): void {
		this._token = generateUuid();
		store.add(webview.onMessage(({ message }) => {
			const parsed = paradisReadHtmlRenderedDiffMessage(message, this._token);
			if (parsed?.type === 'link') {
				const target = paradisPreviewLinkTarget(parsed.href, this._linkBase);
				if (target) {
					this._opener.open(target.uri, { fromUserGesture: true, allowContributedOpeners: true }).catch(onUnexpectedError);
				}
			} else if (parsed?.type === 'key') {
				forwardKey(parsed.event, webview);
			}
		}));
	}

	protected override async renderDocument(input: IParadisRenderedDiffInput, layout: ParadisRenderedDiffLayout, token: CancellationToken): Promise<{ readonly html: string; readonly changes: number; readonly note: string } | string> {
		// 古い側（git: など）も、相対パスの CSS・画像は今の作業ツリーの同じファイルのフォルダーから読む
		const base = this.workingTreeResource(input.modified);
		let baseUrl: string;
		try {
			baseUrl = await this._mount(base);
		} catch (error) {
			if (isCancellationError(error)) {
				throw error;
			}
			reportParadisDiagnosticError('owned', 'file-viewers', 'html-rendered-diff-preview-server', error);
			return localize('paradis.htmlRenderedDiff.noServer', "この HTML はプレビュー差分で表示できないため、テキスト差分で表示しています");
		}
		if (token.isCancellationRequested) {
			return { html: '', changes: 0, note: '' };
		}
		const headHtml = `${paradisHtmlFrameDefaultStyle()}<base href="${escape(baseUrl).replace(/"/g, '&quot;')}">${paradisHtmlViewerHeadStyle(1)}`;
		const originalText = input.originalModel.getValue();
		const modifiedText = input.modifiedModel.getValue();
		const pages = buildParadisHtmlRenderedDiffPages(originalText, modifiedText, layout, headHtml, token);
		if (!pages) {
			return localize('paradis.renderedDiff.tooLarge', "大きいのでテキスト差分で表示しています");
		}
		const notes: string[] = [];
		if (pages.changes === 0 && pages.styleChanges === 0 && originalText !== modifiedText) {
			notes.push(localize('paradis.htmlRenderedDiff.noVisibleChanges', "文字と要素に違いはありません"));
		}
		if (pages.styleChanges > 0) {
			notes.push(localize('paradis.htmlRenderedDiff.styleChanges', "CSS の変更 {0} 件には色を付けていません", pages.styleChanges));
		}
		if (pages.stoppedScripts > 0) {
			notes.push(localize('paradis.htmlRenderedDiff.scriptsStopped', "スクリプトは止めています"));
		}
		// 古い側（と、両側とも git: のときは新しい側も）の CSS・画像は、ディスクの上の今のファイルのもの
		if (base !== input.modified) {
			notes.push(localize('paradis.htmlRenderedDiff.allFromWorkingTree', "CSS・画像は今の作業ツリーのものです"));
		} else if (this.workingTreeResource(input.original) !== input.original) {
			notes.push(localize('paradis.htmlRenderedDiff.workingTreeResources', "変更前の CSS・画像は今の作業ツリーのものです"));
		}
		const html = paradisHtmlRenderedDiffFrameDocument({
			originalHtml: pages.originalHtml,
			modifiedHtml: pages.modifiedHtml,
			labels: {
				original: localize('paradis.renderedDiff.originalCaption', "変更前"),
				modified: localize('paradis.renderedDiff.modifiedCaption', "変更後"),
			},
			notes,
			token: this._token,
			zoom: this.zoomFactor,
			fromHost: PARADIS_WEBVIEW_HOST_MESSAGE_CHECK,
			changeAttribute: PARADIS_RENDERED_DIFF_CHANGE_ATTRIBUTE,
			anchorAttribute: PARADIS_HTML_RENDERED_DIFF_ANCHOR_ATTRIBUTE,
		});
		// 断り書きはページの上の 1 行に出す（バーの上では幅が足りず切れる）
		return { html, changes: pages.changes, note: '' };
	}

	/** 文書のフォルダーを配信サーバに載せ、`<base>` の URL を返す。 */
	private async _mount(resource: URI): Promise<string> {
		const remote = resource.scheme === Schemas.vscodeRemote;
		if (resource.scheme !== Schemas.file && !(remote && this._remoteAgentService.getConnection())) {
			throw new Error(`Para Code HTML rendered diff cannot serve ${resource.scheme}: resources`);
		}
		const { root, suffix } = paradisPreviewMountTarget(resource, this._workspace.getWorkspaceFolder(resource)?.uri);
		const located: IParadisPreviewLocation = remote
			? await this._remoteMounter.mount(root)
			: await paradisMountLocalPreview(this._sharedProcessService, root);
		this._linkBase = { url: paradisPreviewUrl(located.mount, located.port), root };
		return paradisPreviewUrl(located.mount, located.port, suffix);
	}
}

/**
 * 外枠の中のページで押したキーを、webview の基盤と同じ形でワークベンチへ渡す（webviewElement.ts の handleKeyEvent）。
 * 基盤は入れ子の iframe のキーを拾わないので、渡さないとページを押した後にショートカットが効かない。
 */
function forwardKey(event: IParadisHtmlRenderedDiffKey, webview: IOverlayWebview): void {
	if (!webview.isFocused) {
		return;
	}
	const targetWindow = dom.getWindow(webview.container);
	const emulated = new KeyboardEvent(event.type, event);
	Object.defineProperty(emulated, 'target', { get: () => webview.container });
	targetWindow.dispatchEvent(emulated);
}
