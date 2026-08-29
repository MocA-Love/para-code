/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Delayer } from '../../../../base/common/async.js';
// PARA-PATCH: used by the find fallback below.
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Schemas } from '../../../../base/common/network.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IRemoteAuthorityResolverService } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { ITunnelService } from '../../../../platform/tunnel/common/tunnel.js';
import { FindInFrameOptions, IWebviewManagerService } from '../../../../platform/webview/common/webviewManagerService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { WebviewThemeDataProvider } from '../browser/themeing.js';
import { WebviewInitInfo } from '../browser/webview.js';
import { WebviewElement } from '../browser/webviewElement.js';
import { WindowIgnoreMenuShortcutsManager } from './windowIgnoreMenuShortcutsManager.js';

/**
 * Webview backed by an iframe but that uses Electron APIs to power the webview.
 */
export class ElectronWebviewElement extends WebviewElement {

	// PARA-PATCH: `WebFrameMain.findInFrame` only exists in the Electron build Microsoft ships. On stock
	// Electron the main-process call is a no-op, so every webview find (this viewer, the extension
	// editor, extension webview panels) silently finds nothing. Whether the API exists is a property of
	// the running Electron build, so once any webview learns it is missing, all of them switch to the
	// browser find path (`window.find` inside the webview) that the base class implements.
	private static _findInFrameUnsupported = false;

	// PARA-PATCH: a find and an update can be in flight at the same time (Enter pressed right after the
	// debounced update fired). Only the first answer re-runs the search, so the fallback does not skip a
	// match by searching twice.
	private _findFellBack = false;

	private readonly _webviewKeyboardHandler: WindowIgnoreMenuShortcutsManager;

	private _findStarted: boolean = false;
	private _cachedHtmlContent: string | undefined;

	private readonly _webviewMainService: IWebviewManagerService;
	private readonly _iframeDelayer = this._register(new Delayer<void>(200));

	protected override get platform() { return 'electron'; }

	constructor(
		initInfo: WebviewInitInfo,
		webviewThemeDataProvider: WebviewThemeDataProvider,
		@IContextMenuService contextMenuService: IContextMenuService,
		@ITunnelService tunnelService: ITunnelService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IRemoteAuthorityResolverService remoteAuthorityResolverService: IRemoteAuthorityResolverService,
		@ILogService logService: ILogService,
		@IConfigurationService configurationService: IConfigurationService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@INotificationService notificationService: INotificationService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IAccessibilityService accessibilityService: IAccessibilityService,
	) {
		super(initInfo, webviewThemeDataProvider,
			configurationService, contextMenuService, notificationService, environmentService,
			logService, remoteAuthorityResolverService, tunnelService, accessibilityService, instantiationService);

		this._webviewKeyboardHandler = new WindowIgnoreMenuShortcutsManager(configurationService, mainProcessService, _nativeHostService);

		this._webviewMainService = ProxyChannel.toService<IWebviewManagerService>(mainProcessService.getChannel('webview'));

		if (initInfo.options.enableFindWidget) {
			this._register(this.onDidHtmlChange((newContent) => {
				if (this._findStarted && this._cachedHtmlContent !== newContent) {
					this.stopFind(false);
					this._cachedHtmlContent = newContent;
				}
			}));

			this._register(this._webviewMainService.onFoundInFrame((result) => {
				this._hasFindResult.fire(result.matches > 0);
			}));
		}
	}

	override dispose(): void {
		// Make sure keyboard handler knows it closed (#71800)
		this._webviewKeyboardHandler.didBlur();

		super.dispose();
	}

	protected override webviewContentEndpoint(iframeId: string): string {
		return `${Schemas.vscodeWebview}://${iframeId}`;
	}

	/**
	 * Webviews expose a stateful find API.
	 * Successive calls to find will move forward or backward through onFindResults
	 * depending on the supplied options.
	 *
	 * @param value The string to search for. Empty strings are ignored.
	 */
	public override find(value: string, previous: boolean): void {
		if (!this.element) {
			return;
		}

		// PARA-PATCH: no Electron find support in this build, so let the base class search the webview.
		if (ElectronWebviewElement._findInFrameUnsupported) {
			super.find(value, previous);
			return;
		}

		if (!this._findStarted) {
			this.updateFind(value);
		} else {
			// continuing the find, so set findNext to false
			const options: FindInFrameOptions = { forward: !previous, findNext: false, matchCase: false };
			this._webviewMainService.findInFrame({ windowId: this._nativeHostService.windowId }, this.id, value, options).then(found => {
				// PARA-PATCH: the call that discovers the missing API also has to run the find itself.
				if (!found && this._fallBackToWebviewFind()) {
					super.find(value, previous);
				}
			}, onUnexpectedError);
		}
	}

	public override updateFind(value: string) {
		if (!value || !this.element) {
			return;
		}

		// PARA-PATCH: see find().
		if (ElectronWebviewElement._findInFrameUnsupported) {
			super.updateFind(value);
			return;
		}

		// FindNext must be true for a first request
		const options: FindInFrameOptions = {
			forward: true,
			findNext: true,
			matchCase: false
		};

		this._iframeDelayer.trigger(() => {
			this._findStarted = true;
			this._webviewMainService.findInFrame({ windowId: this._nativeHostService.windowId }, this.id, value, options).then(found => {
				// PARA-PATCH: see find().
				if (!found && this._fallBackToWebviewFind()) {
					super.updateFind(value);
				}
			}, onUnexpectedError);
		});
	}

	public override stopFind(keepSelection?: boolean): void {
		if (!this.element) {
			return;
		}
		this._iframeDelayer.cancel();
		this._findStarted = false;

		// PARA-PATCH: see find(). The base class fires `onDidStopFind` itself.
		if (ElectronWebviewElement._findInFrameUnsupported) {
			super.stopFind(keepSelection);
			return;
		}

		this._webviewMainService.stopFindInFrame({ windowId: this._nativeHostService.windowId }, this.id, {
			keepSelection
		}).then(stopped => {
			// PARA-PATCH: see find(). `onDidStopFind` was already fired below; the base class fires it
			// again here, which only re-disables the find widget buttons and happens once per webview.
			if (!stopped && this._fallBackToWebviewFind()) {
				super.stopFind(keepSelection);
			}
		}, onUnexpectedError);
		this._onDidStopFind.fire();
	}

	/**
	 * PARA-PATCH: remember that this Electron build cannot search webviews. Returns whether this is the
	 * first answer for this webview, i.e. whether the caller still has to run the search itself.
	 *
	 * `_findStarted` stays `false` from here on: it only gates the Electron path, so the "content
	 * changed, drop the running find" reset above no longer fires. That matches the web build, which
	 * has no such reset either.
	 */
	private _fallBackToWebviewFind(): boolean {
		ElectronWebviewElement._findInFrameUnsupported = true;
		this._findStarted = false;
		if (this._findFellBack) {
			return false;
		}
		this._findFellBack = true;
		return true;
	}

	protected override handleFocusChange(isFocused: boolean): void {
		super.handleFocusChange(isFocused);
		if (isFocused) {
			this._webviewKeyboardHandler.didFocus();
		} else {
			this._webviewKeyboardHandler.didBlur();
		}
	}
}
