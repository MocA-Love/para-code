/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { screen, WebContentsView, webContents } from 'electron';
// PARA-PATCH: MutableDisposable/toDisposable for the deferred focus hand-back below
import { Disposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { IBrowserViewAudience, IBrowserViewBounds, IBrowserViewDevToolsStateEvent, IBrowserViewFocusEvent, IBrowserViewKeyDownEvent, IBrowserViewState, IBrowserViewNavigationEvent, IBrowserViewLoadingEvent, IBrowserViewLoadError, IBrowserViewTitleChangeEvent, IBrowserViewFaviconChangeEvent, IBrowserViewCaptureScreenshotOptions, IBrowserViewFindInPageOptions, IBrowserViewFindInPageResult, IBrowserViewVisibilityEvent, browserViewIsolatedWorldId, browserZoomFactors, browserZoomDefaultIndex, IBrowserViewOwner, IBrowserViewEditorOpenOptions, IBrowserViewPermissionRequestEvent, equalsBrowserViewAudience, isBrowserViewAssociatedResourceNavigation, matchesBrowserViewAudience, IBrowserViewHost, BrowserViewPresentation, getBrowserViewPopupAction } from '../common/browserView.js';
import { BrowserViewEmulator } from './browserViewEmulator.js';
import { paraBrowserViewZoomShrink, paraSetBrowserViewUserZoom } from './paraBrowserViewZoom.js'; // PARA-PATCH: per-tab browser zoom (paraBrowserViewZoom.ts)
import { BrowserViewInspector } from './browserViewInspector.js';
import { IWindowsMainService } from '../../windows/electron-main/windows.js';
import { ICodeWindow, LoadReason } from '../../window/electron-main/window.js';
import { IAuxiliaryWindowsMainService } from '../../auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { BrowserViewDebugger } from './browserViewDebugger.js';
import { ILogService } from '../../log/common/log.js';
import { BrowserSession } from './browserSession.js';
import { IBrowserHistoryItemHandle } from '../common/browserHistory.js';
import { ISerializedBrowserPermissionsSnapshot, PermissionCategory } from '../common/browserPermissions.js';
import { IAuxiliaryWindow } from '../../auxiliaryWindow/electron-main/auxiliaryWindow.js';
import { SCAN_CODE_STR_TO_EVENT_KEY_CODE } from '../../../base/common/keyCodes.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { logBrowserOpen } from '../common/browserViewTelemetry.js';
import { URI } from '../../../base/common/uri.js';
// PARA-PATCH: import the fork's screenshot policy helpers (route selection, pixel-budget guard, bounded scale, retry/restore) for the hardened capture pipeline (Para Browser MCP screenshot hardening)
import { BrowserViewScreenshotCoordinator, browserViewAssertScreenshotPixelBudget, browserViewCalculateBoundedCaptureScale, browserViewEffectiveCaptureBeyondDevicePixelRatio, browserViewScreenshotRoute, browserViewThrowIfScreenshotAborted, captureBrowserViewScreenshotWithPolicy, captureBrowserViewWithRetry, type BrowserViewScreenshotRoute } from '../common/paraBrowserViewScreenshot.js';
// PARA-PATCH: import the fork's automation key isolation, which keeps injected keystrokes apart from user input (Para Browser MCP automation input isolation)
import { ParaBrowserViewAutomationKeys } from './paraBrowserViewAutomationKeys.js';
// PARA-PATCH: import the fork's screenshot capture helpers (Para Browser MCP screenshot hardening)
import { ParaBrowserViewScreenshotCapture } from './paraBrowserViewScreenshotCapture.js';
// PARA-PATCH: import the fork's load watchdog, which fails loads that stall before the response ever begins instead of spinning forever (Para Code)
import { paraInstallBrowserViewLoadWatchdog } from './paraBrowserViewLoadWatchdog.js';
// PARA-PATCH: import the fork's capture nudge for shown views in undrawn windows (Para Browser MCP frame keepalive)
import { ParaBrowserViewCaptureNudge } from './paraBrowserViewFrameNudge.js';
// PARA-PATCH: import the fork's focus-request marker, so focus diagnostics can tell a Para Code focus from one the page took (Para Code browser focus diagnostics)
import { paraNoteBrowserViewFocusRequest } from './paraBrowserViewFocusRequest.js';
// PARA-PATCH: import the fork's genuine Chrome identity, which gives every tab the UA and Client Hints of Google Chrome (Para Code)
import { paradisAttachChromeIdentity } from '../../../paradis/contrib/browserUserAgent/electron-main/paradisChromeIdentity.js';
import { paradisDeniesExtensionWindowOpen } from '../common/paradisExtensionPageHold.js'; // PARA-PATCH: block window.open of extension pages from agent-held tabs

enum NewPageLocation {
	Foreground = 'foreground',
	Background = 'background',
	NewWindow = 'newWindow'
}

/**
 * Represents a single browser view instance with its WebContentsView and all associated logic.
 * This class encapsulates all operations and events for a single browser view.
 */
export class BrowserView extends Disposable {
	private readonly _view: WebContentsView;
	private readonly _faviconRequestCache = new Map<string, Promise<string>>();
	presentation = BrowserViewPresentation.Listed;

	private _lastScreenshot: VSBuffer | undefined = undefined;
	private _lastFavicon: string | undefined = undefined;
	private _lastError: IBrowserViewLoadError | undefined = undefined;
	private _lastUserGestureTimestamp: number = -Infinity;
	private _browserZoomIndex: number = browserZoomDefaultIndex;

	private _currentHistoryHandle: IBrowserHistoryItemHandle | undefined;
	private _explicitNavigationPending = false;
	/**
	 * Active index in the webContents navigation history list.
	 * Used to tell whether a navigation appended a new entry or replaced the current one in place.
	 */
	private _lastCommittedEntryIndex = -1;

	readonly debugger: BrowserViewDebugger;
	readonly emulator: BrowserViewEmulator;
	readonly inspector: BrowserViewInspector;

	private _ownerWindow: ICodeWindow;
	private _owner: IBrowserViewOwner;
	private _currentWindow: ICodeWindow | IAuxiliaryWindow | undefined;
	private _isDisposed = false;
	private _audiences: readonly IBrowserViewAudience[] = [];

	private _wantsVisibility = false;
	// PARA-PATCH: at most one deferred focus hand-back per view (setVisible is called repeatedly; registering a disposable per call would pile them up on the view)
	private readonly _paradisPendingFocusHandBack = this._register(new MutableDisposable());
	private _hasBeenLaidOut = false;

	private static readonly MAX_CONSOLE_LOG_ENTRIES = 1000;
	private readonly _consoleLogs: string[] = [];
	// PARA-PATCH: state for the hardened screenshot pipeline and automation-key isolation - serialize captures, and the per-view automation key state in paraBrowserViewAutomationKeys.ts (Para Browser MCP screenshot + automation input hardening)
	private readonly _screenshotCoordinator = new BrowserViewScreenshotCoordinator();
	// PARA-PATCH: the capture helpers of the hardened screenshot pipeline (paraBrowserViewScreenshotCapture.ts) and the automation key state (paraBrowserViewAutomationKeys.ts). Both are created in the constructor because they need the injected logService (define-class-fields-check)
	private readonly _paraScreenshot: ParaBrowserViewScreenshotCapture;
	private readonly _paraAutomationKeys: ParaBrowserViewAutomationKeys;

	/**
	 * Resize a full-page screenshot so its largest dimension never exceeds this many pixels. A very tall
	 * or wide page would otherwise request an enormous bitmap, which is costly to allocate/encode and
	 * can stress the browser process. We downscale via `scale` (rather than cropping) so the whole page
	 * still fits in the result.
	 */
	private static readonly MAX_FULL_PAGE_SCREENSHOT_DIMENSION = 2576;

	private readonly _onDidNavigate = this._register(new Emitter<IBrowserViewNavigationEvent>());
	readonly onDidNavigate: Event<IBrowserViewNavigationEvent> = this._onDidNavigate.event;

	private readonly _onDidChangeLoadingState = this._register(new Emitter<IBrowserViewLoadingEvent>());
	readonly onDidChangeLoadingState: Event<IBrowserViewLoadingEvent> = this._onDidChangeLoadingState.event;

	private readonly _onDidChangeFocus = this._register(new Emitter<IBrowserViewFocusEvent>());
	readonly onDidChangeFocus: Event<IBrowserViewFocusEvent> = this._onDidChangeFocus.event;

	private readonly _onDidChangeVisibility = this._register(new Emitter<IBrowserViewVisibilityEvent>());
	readonly onDidChangeVisibility: Event<IBrowserViewVisibilityEvent> = this._onDidChangeVisibility.event;

	private readonly _onDidChangeDevToolsState = this._register(new Emitter<IBrowserViewDevToolsStateEvent>());
	readonly onDidChangeDevToolsState: Event<IBrowserViewDevToolsStateEvent> = this._onDidChangeDevToolsState.event;

	private readonly _onDidKeyCommand = this._register(new Emitter<IBrowserViewKeyDownEvent>());
	readonly onDidKeyCommand: Event<IBrowserViewKeyDownEvent> = this._onDidKeyCommand.event;

	private readonly _onDidChangeTitle = this._register(new Emitter<IBrowserViewTitleChangeEvent>());
	readonly onDidChangeTitle: Event<IBrowserViewTitleChangeEvent> = this._onDidChangeTitle.event;

	private readonly _onDidChangeFavicon = this._register(new Emitter<IBrowserViewFaviconChangeEvent>());
	readonly onDidChangeFavicon: Event<IBrowserViewFaviconChangeEvent> = this._onDidChangeFavicon.event;

	private readonly _onDidChangeOwner = this._register(new Emitter<IBrowserViewOwner>());
	readonly onDidChangeOwner: Event<IBrowserViewOwner> = this._onDidChangeOwner.event;

	private readonly _onDidFindInPage = this._register(new Emitter<IBrowserViewFindInPageResult>());
	readonly onDidFindInPage: Event<IBrowserViewFindInPageResult> = this._onDidFindInPage.event;

	private readonly _onDidClose = this._register(new Emitter<void>());
	readonly onDidClose: Event<void> = this._onDidClose.event;


	private readonly _onDidRequestPermission = this._register(new Emitter<IBrowserViewPermissionRequestEvent>());
	readonly onDidRequestPermission: Event<IBrowserViewPermissionRequestEvent> = this._onDidRequestPermission.event;

	private readonly _onDidChangePermissions = this._register(new Emitter<ISerializedBrowserPermissionsSnapshot>());
	readonly onDidChangePermissions: Event<ISerializedBrowserPermissionsSnapshot> = this._onDidChangePermissions.event;

	private readonly _onDidChangeAudiences = this._register(new Emitter<IBrowserViewAudience[]>());
	readonly onDidChangeAudiences: Event<IBrowserViewAudience[]> = this._onDidChangeAudiences.event;

	private readonly _onDidRequestOpenExternal = this._register(new Emitter<string>());
	readonly onDidRequestOpenExternal: Event<string> = this._onDidRequestOpenExternal.event;

	constructor(
		public readonly id: string,
		public readonly host: IBrowserViewHost,
		owner: IBrowserViewOwner,
		public readonly associatedResource: URI | undefined,
		public readonly session: BrowserSession,
		private readonly _createChildView: (owner: IBrowserViewOwner, url: string, electronOptions: Electron.WebContentsViewConstructorOptions | undefined, editorOptions: IBrowserViewEditorOpenOptions) => BrowserView,
		openContextMenu: (view: BrowserView, params: Electron.ContextMenuParams) => void,
		options: Electron.WebContentsViewConstructorOptions | undefined,
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@IAuxiliaryWindowsMainService private readonly auxiliaryWindowsMainService: IAuxiliaryWindowsMainService,
		@ILogService private readonly logService: ILogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
	) {
		super();
		// PARA-PATCH: create the screenshot and automation key helpers here, after the injected logService is assigned (see the fields above)
		this._paraScreenshot = new ParaBrowserViewScreenshotCapture({
			webContents: () => this._view.webContents,
			hostWindow: () => this._hostWindow,
			emulatedDeviceScaleFactor: () => this.emulator.device?.deviceScaleFactor,
			sendCommand: (method, params) => this.debugger.sendCommand(method, params),
			waitForNextPaint: () => this._waitForNextPaint(),
			reapplyEmulation: () => this.emulator.paraReapplyEmulation(),
		}, this.logService);
		this._paraAutomationKeys = this._register(new ParaBrowserViewAutomationKeys(() => this.webContents, () => this._isDisposed, this.logService));
		this._owner = owner;

		const webPreferences: Electron.WebPreferences = {
			...options?.webPreferences,

			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,

			// NOTE: When `sandbox` is enabled, `nodeIntegrationInSubFrames` doesn't actually enable node integration or prevent sandboxing.
			//       It allows preload scripts to run in subframes, which is important for our features like keyboard shortcut forwarding.
			nodeIntegrationInSubFrames: true,

			webviewTag: false,
			session: this.session.electronSession,

			focusOnNavigation: false
		};

		this._view = new WebContentsView({
			webPreferences,
			// Passing an `undefined` webContents triggers an error in Electron.
			...(options?.webContents ? { webContents: options.webContents } : {})
		});

		// Use a default size of 1024x768.
		// Important: The bounds here must be on-screen, otherwise some OSes (like macOS) may not actually start rendering.
		//            We just have to be careful to not show the view until a layout has happened in the correct location.
		this._view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
		this._view.setBackgroundColor('#FFFFFF');

		this._ownerWindow = this.windowsMainService.getWindowById(host.windowId)!;
		if (!this._ownerWindow) {
			throw new Error(`Window with ID ${host.windowId} not found`);
		}
		this._register(this._ownerWindow.onDidClose(() => this.dispose()));
		this._register(this._ownerWindow.onWillLoad((e) => {
			if (e.reason === LoadReason.LOAD) {
				this.dispose(); // Dispose when switching workspaces.
			} else if (e.reason === LoadReason.RELOAD) {
				this.setVisible(false); // Hide when reloading.
			}
		}));

		this._view.setVisible(false);
		this._ownerWindow.win?.contentView.addChildView(this._view);

		this._view.webContents.setWindowOpenHandler((details) => {
			const { action, consumeUserGesture } = getBrowserViewPopupAction(this.presentation, details.url, this.hasRecentUserGesture());
			if (action !== 'integrated') {
				if (consumeUserGesture) {
					this._lastUserGestureTimestamp = -Infinity;
				}
				if (action === 'external') {
					this._onDidRequestOpenExternal.fire(details.url);
				}
				return { action: 'deny' };
			}
			if (paradisDeniesExtensionWindowOpen(this._view.webContents, details.url)) { return { action: 'deny' }; } // PARA-PATCH: a tab an agent holds may not open a browser extension page (vs/paradis/contrib/agentBrowser/electron-main/paradisExtensionNavigationGuard.ts)
			const location = (() => {
				switch (details.disposition) {
					case 'background-tab': return NewPageLocation.Background;
					case 'foreground-tab': return NewPageLocation.Foreground;
					case 'new-window': return NewPageLocation.NewWindow;
					default: return undefined;
				}
			})();

			if (!location || !this.consumePopupPermission(location)) {
				// Eventually we may want to surface this. For now, just silently block it.
				return { action: 'deny' };
			}

			return {
				action: 'allow',
				createWindow: (options) => {
					logBrowserOpen(this.telemetryService, (() => {
						switch (location) {
							case NewPageLocation.NewWindow: return 'browserLinkNewWindow';
							case NewPageLocation.Background: return 'browserLinkBackground';
							case NewPageLocation.Foreground: return 'browserLinkForeground';
						}
					})());

					const childView = this._createChildView(this.owner, details.url, options, {
						pinned: true,
						background: location === NewPageLocation.Background,
						parentViewId: id,
						auxiliaryWindow: location === NewPageLocation.NewWindow
							? { x: options.x, y: options.y, width: options.width, height: options.height }
							: undefined,
					});

					// Return the webContents so Electron can complete the window.open() call
					return childView.webContents;
				},

				// We want the standard browser behavior as opposed to Electron's default of closing the new window when the parent is closed
				outlivesOpener: true
			};
		});

		this._view.webContents.on('context-menu', (_event, params) => {
			openContextMenu(this, params);
		});

		this._view.webContents.on('destroyed', () => {
			this.dispose();
		});

		this.debugger = new BrowserViewDebugger(this);
		// PARA-PATCH: drop stale automation key expectations when the debugger detaches so recovery starts clean (Para Browser MCP automation input isolation)
		this._register(this.debugger.onDidDetach(() => this._paraAutomationKeys.clearAutomationKeyExpectations()));
		this.emulator = this._register(new BrowserViewEmulator(this, this.logService));
		this._register(paradisAttachChromeIdentity(this)); // PARA-PATCH: present the UA and Client Hints of Google Chrome over CDP (Para Code genuine Chrome identity)
		this.inspector = this._register(new BrowserViewInspector(this));

		this._register(this.session.permissions.onDidRequestPermission(e => {
			if (e.webContents === this.webContents && !this._isDisposed) {
				e.claim();
				this._onDidRequestPermission.fire(e.request);
			}
		}));
		this._register(this.session.permissions.onDidRequestDevice(e => {
			if (e.webContents === this.webContents && !this._isDisposed) {
				e.claim();
				this._onDidRequestPermission.fire({
					origin: e.origin,
					category: PermissionCategory.Devices,
					device: {
						requestId: e.requestId,
						deviceType: e.deviceType,
						devices: e.devices,
					},
				});
			}
		}));
		this._register(this.session.permissions.onDidChange(() => {
			this._onDidChangePermissions.fire(this.session.permissions.serialize());
		}));

		this.setupEventListeners();
	}

	private setupEventListeners(): void {
		const webContents = this._view.webContents;

		// DevTools state events
		webContents.on('devtools-opened', () => {
			this._onDidChangeDevToolsState.fire({ isDevToolsOpen: true });
		});

		webContents.on('devtools-closed', () => {
			this._onDidChangeDevToolsState.fire({ isDevToolsOpen: false });
		});

		// Favicon events
		webContents.on('page-favicon-updated', async (_event, favicons) => {
			// try each url in order until one works
			for (const url of favicons) {
				if (!this._faviconRequestCache.has(url)) {
					this._faviconRequestCache.set(url, (async () => {
						if (url.startsWith('data:image/')) {
							return url;
						}
						const response = await webContents.session.fetch(url, {
							cache: 'force-cache'
						});
						if (!response.ok) {
							throw new Error(`Failed to fetch favicon: ${response.status} ${response.statusText}`);
						}
						const type = await response.headers.get('content-type');
						if (!type?.startsWith('image/')) {
							throw new Error(`Favicon is not an image: ${type}`);
						}
						const buffer = await response.arrayBuffer();

						return `data:${type};base64,${Buffer.from(buffer).toString('base64')}`;
					})());
				}

				try {
					this._lastFavicon = await this._faviconRequestCache.get(url)!;
					this._onDidChangeFavicon.fire({ favicon: this._lastFavicon });
					this._currentHistoryHandle?.update({ favicon: this._lastFavicon });
					// On success, stop searching
					return;
				} catch (e) {
					// On failure, just try the next one
				}
			}

			// If we searched all favicons and none worked, clear the favicon
			if (this._lastFavicon) {
				this._lastFavicon = undefined;
				this._onDidChangeFavicon.fire({ favicon: this._lastFavicon });
				this._currentHistoryHandle?.update({ favicon: null });
			}
		});
		webContents.on('will-navigate', (event) => {
			if (this._redirectPinnedNavigation(event.url)) {
				event.preventDefault();
				return;
			}
			// URL.parse (vs `new URL`) tolerates about:/blob:/empty strings without throwing.
			const host = URL.parse(event.url)?.host;
			const currHost = URL.parse(this.webContents.getURL())?.host;
			if (host !== currHost) {
				this._lastFavicon = undefined;
			}
		});
		webContents.on('will-redirect', event => {
			if (this._redirectPinnedNavigation(event.url)) {
				event.preventDefault();
			}
		});

		// Title events
		webContents.on('page-title-updated', (_event, title) => {
			this._onDidChangeTitle.fire({ title });
			this._currentHistoryHandle?.update({ title });
		});

		const fireNavigationEvent = (url: string) => {
			this._onDidNavigate.fire({
				url,
				title: webContents.getTitle(),
				canGoBack: webContents.navigationHistory.canGoBack(),
				canGoForward: webContents.navigationHistory.canGoForward(),
				certificateError: this.session.trust.getCertificateError(url)
			});
			this._recordNavigation(url);
		};

		const fireLoadingEvent = (loading: boolean) => {
			this._onDidChangeLoadingState.fire({ loading, error: this._lastError });
		};

		// Loading state events
		webContents.on('did-start-loading', () => {
			this._lastError = undefined;

			// Don't fire loading events for e.g. same-document navigations
			if (webContents.isLoadingMainFrame()) {
				fireLoadingEvent(true);
			}
		});
		webContents.on('did-stop-loading', () => fireLoadingEvent(false));
		webContents.on('did-fail-load', (e, errorCode, errorDescription, validatedURL, isMainFrame) => {
			if (isMainFrame) {
				// Ignore ERR_ABORTED (-3) which is the expected error when user stops a page load.
				if (errorCode === -3) {
					fireLoadingEvent(false);
					return;
				}

				this._lastError = {
					url: validatedURL,
					errorCode,
					errorDescription,
					// -200 - -220 are the range of certificate errors in Chromium.
					certificateError: errorCode <= -200 && errorCode >= -220 ? this.session.trust.getCertificateError(validatedURL) : undefined
				};

				fireLoadingEvent(false);
				this._onDidNavigate.fire({
					url: validatedURL,
					title: '',
					canGoBack: webContents.navigationHistory.canGoBack(),
					canGoForward: webContents.navigationHistory.canGoForward(),
					certificateError: this.session.trust.getCertificateError(validatedURL)
				});
			}
		});
		webContents.on('did-finish-load', () => fireLoadingEvent(false));
		// PARA-PATCH: a server (or a wedged remote agent tunnel) that accepts the connection and then never responds makes Chromium wait forever without emitting `did-fail-load`, leaving the view spinning with no error. Ask whether to keep waiting, and fail stopped loads into the normal error path (Para Code)
		this._register(paraInstallBrowserViewLoadWatchdog(webContents, this.logService, error => {
			this._lastError = error;
			fireLoadingEvent(false);
		}, { viewId: this.id, context: () => ({ remoteAuthority: this._ownerWindow.remoteAuthority, tunnelProxy: this.session.remote.proxy !== undefined, agentOwner: this.owner.type === 'agent' }) }));
		// PARA-PATCH: navigation discards the preload's isolated state, so clear any pending automation key expectations; same-document navigations keep it (Para Browser MCP automation input isolation)
		webContents.on('did-start-navigation', details => this._paraAutomationKeys.onDidStartNavigation(details));

		this.session.trust.installCertErrorHandler(webContents);

		webContents.on('login', (event, _details, authInfo, callback) => {
			// Automatically supply proxy auth credentials for the tunnel proxy.
			if (this.session.remote.proxy) {
				const { username, password } = this.session.remote.proxy.credentials;
				const proxyPort = this.session.remote.proxy.port;
				if (authInfo.isProxy && authInfo.host === '127.0.0.1' && authInfo.port === proxyPort) {
					event.preventDefault();
					callback(username, password);
				}
			}
		});

		webContents.on('render-process-gone', (_event, details) => {
			this._lastError = {
				url: webContents.getURL(),
				errorCode: details.exitCode,
				errorDescription: `Render process gone: ${details.reason}`
			};

			fireLoadingEvent(false);
		});

		// Navigation events (when URL actually changes)
		webContents.on('did-navigate', (_, url) => fireNavigationEvent(url));
		webContents.on('did-navigate-in-page', (_, url, isMainFrame) => {
			// Ignore subframe (iframe) navigations: they must not rewrite the
			// main frame's URL bar or its history entry.
			if (isMainFrame) {
				fireNavigationEvent(url);
			}
		});

		webContents.on('did-navigate', () => {
			// Chromium resets the zoom factor to its per-origin default (100%) when
			// navigating to a new document. Re-apply our stored zoom to override it.
			this._consoleLogs.length = 0; // Clear console logs on navigation since they are per-page
			paraSetBrowserViewUserZoom(this._view.webContents, browserZoomFactors[this._browserZoomIndex]); // PARA-PATCH: keep this tab's zoom to itself and combine it with a shrunk fixed size (paraBrowserViewZoom.ts)

			// Enable pinch-to-zoom
			void this._view.webContents.setVisualZoomLevelLimits(1, 3).catch(error => {
				this.logService.error('Failed to set visual zoom level limits for browser view webContents.', error);
			});
		});

		webContents.on('select-bluetooth-device', (event, devices, callback) => {
			event.preventDefault();
			this.session.permissions.beginBluetoothRequest(this.webContents, devices, callback);
		});

		// Focus events
		webContents.on('focus', () => {
			// PARA-PATCH: real user focus rotates the input authority and invalidates any pending automation key so injected input can never masquerade as user input (Para Browser MCP automation input isolation)
			this._paraAutomationKeys.onFocus();
			this._onDidChangeFocus.fire({ focused: true });
		});

		webContents.on('blur', () => {
			// PARA-PATCH: rotate the input authority on blur so a stale authority can never authorize a later automation key (Para Browser MCP automation input isolation)
			this._paraAutomationKeys.onBlur();
			this._onDidChangeFocus.fire({ focused: false });
		});

		const onCommandKeydown = (_event: unknown, keyEvent: IBrowserViewKeyDownEvent) => {
			this._onDidKeyCommand.fire(keyEvent);
		};

		// PARA-PATCH: handle preload acks for automation key register/activate and preload-consumed notifications (logic in paraBrowserViewAutomationKeys.ts) (Para Browser MCP automation input isolation)
		webContents.on('ipc-message', (event, channel, ...args) => this._paraAutomationKeys.handleIpcMessage(event, channel, args[0]));

		// Forward key down events that weren't handled by the page to the workbench for shortcut handling.
		webContents.ipc.on('vscode:browserView:keydown', onCommandKeydown);
		webContents.on('devtools-opened', () => {
			// Avoid double-registration if the webContents is reused.
			webContents.devToolsWebContents?.ipc.off('vscode:browserView:keydown', onCommandKeydown);
			webContents.devToolsWebContents?.ipc.on('vscode:browserView:keydown', onCommandKeydown);
		});

		// If the page won't be able to handle events, forward key down events directly.
		webContents.on('before-input-event', (event, input) => {
			// PARA-PATCH: swallow inputs matching an active automation expectation before the direct-forward path so injected keys are not delivered as workbench key commands (Para Browser MCP automation input isolation)
			if (this._paraAutomationKeys.consumeBeforeInputEvent(input)) {
				return;
			}
			if (input.type !== 'keyDown') {
				return;
			}

			const pageIsAvailable = this._view.getVisible()
				&& !webContents.isCrashed()
				&& !this.debugger.isPaused;
			if (pageIsAvailable) {
				return;
			}

			// This logic should mirror that in preload-browserView.ts.
			if (!(input.control || input.alt || input.meta) && input.key.length === 1) {
				return;
			}

			event.preventDefault();

			const eventKeyCode = SCAN_CODE_STR_TO_EVENT_KEY_CODE[input.code] || 0;
			this._onDidKeyCommand.fire({
				key: input.key,
				keyCode: eventKeyCode,
				code: input.code,
				// PARA-PATCH: include the key location so automation key signatures can be matched on the workbench side (Para Browser MCP automation input isolation)
				location: input.location,
				ctrlKey: input.control,
				shiftKey: input.shift,
				altKey: input.alt,
				metaKey: input.meta,
				repeat: input.isAutoRepeat
			});
		});

		// Track user gestures for popup blocking logic.
		// Roughly based on https://html.spec.whatwg.org/multipage/interaction.html#tracking-user-activation.
		webContents.on('input-event', (_event, input) => {
			switch (input.type) {
				case 'rawKeyDown':
				case 'keyDown':
				case 'mouseDown':
				case 'pointerDown':
				case 'pointerUp':
				case 'touchEnd':
					this._lastUserGestureTimestamp = Date.now();
			}
		});

		// For now, always prevent sites from blocking unload.
		// In the future we may want to show a dialog to ask the user,
		// with heavy restrictions regarding interaction and repeated prompts.
		webContents.on('will-prevent-unload', (e) => {
			e.preventDefault();
		});

		// Find in page events
		webContents.on('found-in-page', (_event, result) => {
			this._onDidFindInPage.fire({
				activeMatchOrdinal: result.activeMatchOrdinal,
				matches: result.matches,
				selectionArea: result.selectionArea,
				finalUpdate: result.finalUpdate
			});
		});

		// Capture console messages for sharing with chat
		this._view.webContents.on('console-message', (event) => {
			this._consoleLogs.push(`[${event.level}] ${event.message}`);
			if (this._consoleLogs.length > BrowserView.MAX_CONSOLE_LOG_ENTRIES) {
				this._consoleLogs.splice(0, this._consoleLogs.length - BrowserView.MAX_CONSOLE_LOG_ENTRIES);
			}
		});
	}

	// PARA-PATCH: automation key isolation API, delegated to the fork's paraBrowserViewAutomationKeys.ts (Para Browser MCP automation input isolation)
	captureAutomationInputFocusAuthority(): object | undefined {
		return this._paraAutomationKeys.captureAutomationInputFocusAuthority();
	}

	prepareAutomationKeyInput(...args: Parameters<ParaBrowserViewAutomationKeys['prepareAutomationKeyInput']>): ReturnType<ParaBrowserViewAutomationKeys['prepareAutomationKeyInput']> {
		return this._paraAutomationKeys.prepareAutomationKeyInput(...args);
	}

	// PARA-PATCH: let a hidden agent-bound view (or a shown one in a minimized / background window) be drawn once so viz does not stall its BeginFrames; see ParaBrowserViewCaptureNudge.nudgeView in paraBrowserViewFrameNudge.ts (Para Browser MCP hidden-view frame keepalive)
	nudgeHiddenFrame(): boolean {
		return this._paraCaptureNudge.nudgeView(this._view, !this._isDisposed && this._hasBeenLaidOut, this._currentWindow?.win ?? undefined);
	}

	// PARA-PATCH: per-view capture nudge state for nudgeHiddenFrame() above (Para Browser MCP frame keepalive)
	private readonly _paraCaptureNudge = new ParaBrowserViewCaptureNudge();

	private consumePopupPermission(location: NewPageLocation): boolean {
		switch (location) {
			case NewPageLocation.Foreground:
			case NewPageLocation.Background:
				return true;
			case NewPageLocation.NewWindow:
				return this.consumeUserGesture();
		}
	}

	private consumeUserGesture(): boolean {
		// Each user gesture allows one popup window within 1 second.
		if (this.hasRecentUserGesture()) {
			this._lastUserGestureTimestamp = -Infinity;
			return true;
		}
		return false;
	}

	private hasRecentUserGesture(): boolean {
		return this._lastUserGestureTimestamp > Date.now() - 1000;
	}

	/**
	 * Record a committed navigation in the session's history.
	 */
	private _recordNavigation(url: string): void {
		const webContents = this._view.webContents;
		const activeIndex = webContents.navigationHistory.getActiveIndex();

		if (!isTrackableHistoryUrl(url)) {
			this._currentHistoryHandle = undefined;
			this._lastCommittedEntryIndex = activeIndex;
			return;
		}

		// A commit that leaves the active index unchanged replaced the current
		// entry in place; refine the existing history item rather than appending
		// a duplicate.
		const handle = this._currentHistoryHandle;
		if (handle && activeIndex === this._lastCommittedEntryIndex) {
			handle.update({ url, title: webContents.getTitle() });
			return;
		}
		this._lastCommittedEntryIndex = activeIndex;

		const userInitiated = this._explicitNavigationPending;
		this._explicitNavigationPending = false;
		this._currentHistoryHandle = this.session.history.add(
			url,
			webContents.getTitle(),
			this._lastFavicon,
			userInitiated,
		);
	}

	get owner(): IBrowserViewOwner {
		return this._owner;
	}

	setOwner(owner: IBrowserViewOwner): void {
		this._owner = owner;
		this._onDidChangeOwner.fire(owner);
	}

	get webContents(): Electron.WebContents {
		return this._view.webContents;
	}

	/**
	 * Get the current state of this browser view
	 */
	getState(): IBrowserViewState {
		const webContents = this._view.webContents;
		const url = webContents.getURL();

		return {
			url,
			title: webContents.getTitle(),
			canGoBack: webContents.navigationHistory.canGoBack(),
			canGoForward: webContents.navigationHistory.canGoForward(),
			loading: webContents.isLoading(),
			focused: webContents.isFocused(),
			visible: this._view.getVisible(),
			isDevToolsOpen: webContents.isDevToolsOpened(),
			lastScreenshot: this._lastScreenshot,
			lastFavicon: this._lastFavicon,
			lastError: this._lastError,
			certificateError: this.session.trust.getCertificateError(url),
			session: this.session.options,
			sandboxSessionId: this.session.sandboxSessionId,
			storageKeys: { ...this.session.history.storageKeys, ...this.session.permissions.storageKeys },
			permissions: this.session.permissions.serialize(),
			browserZoomIndex: this._browserZoomIndex,
			elementSelectionState: this.inspector.elementSelectionState,
			isAreaSelectionActive: this.inspector.isAreaSelectionActive,
			device: this.emulator.device,
			audiences: [...this._audiences]
		};
	}

	get audiences(): readonly IBrowserViewAudience[] {
		return this._audiences;
	}

	setAudience(audience: IBrowserViewAudience, enabled: boolean): void {
		if (enabled) {
			if (!this._audiences.some(candidate => equalsBrowserViewAudience(candidate, audience))) {
				this._audiences = [...this._audiences, audience];
				this._onDidChangeAudiences.fire([...this._audiences]);
			}
		} else {
			const audiences = this._audiences.filter(candidate => !matchesBrowserViewAudience(candidate, audience));
			if (audiences.length !== this._audiences.length) {
				this._audiences = audiences;
				this._onDidChangeAudiences.fire([...this._audiences]);
			}
		}
	}

	setAudiences(audiences: readonly IBrowserViewAudience[]): void {
		if (audiences.length === this._audiences.length && audiences.every(audience => this._audiences.some(candidate => equalsBrowserViewAudience(candidate, audience)))) {
			return;
		}

		this._audiences = [...audiences];
		this._onDidChangeAudiences.fire([...this._audiences]);
	}

	/**
	 * Toggle developer tools for this browser view.
	 */
	toggleDevTools(): void {
		this._view.webContents.toggleDevTools();
	}

	/**
	 * Update the layout bounds of this view
	 */
	layout(bounds: IBrowserViewBounds): void {
		if (this._currentWindow?.win?.id !== bounds.windowId) {
			const newWindow = this._windowById(bounds.windowId);
			if (newWindow) {
				this._currentWindow?.win?.contentView.removeChildView(this._view);
				this._currentWindow = newWindow;
				newWindow.win?.contentView.addChildView(this._view);
			}
		}

		this._view.setBorderRadius(Math.round(bounds.cornerRadius * bounds.zoomFactor));

		if (bounds.emulation) {
			this.emulator.applyScreenEmulation(bounds.width, bounds.height, bounds.emulation.scale, bounds.zoomFactor);
		}

		this._view.setBounds({
			x: Math.round(bounds.x * bounds.zoomFactor),
			y: Math.round(bounds.y * bounds.zoomFactor),
			width: Math.round(bounds.width * bounds.zoomFactor),
			height: Math.round(bounds.height * bounds.zoomFactor)
		});

		this._hasBeenLaidOut = true;
		if (this._wantsVisibility && !this._view.getVisible()) {
			this._view.setVisible(true);
		}
	}

	setBrowserZoomIndex(zoomIndex: number): void {
		this._browserZoomIndex = Math.max(0, Math.min(zoomIndex, browserZoomFactors.length - 1));
		const browserZoomFactor = browserZoomFactors[this._browserZoomIndex];
		paraSetBrowserViewUserZoom(this._view.webContents, browserZoomFactor); // PARA-PATCH: see paraBrowserViewZoom.ts
	}

	/**
	 * Set the visibility of this view
	 */
	setVisible(visible: boolean): void {
		if (this._wantsVisibility === visible) {
			return;
		}

		// PARA-PATCH: a deferred hand-back is pointless once we are shown again (Para Code)
		if (visible) {
			this._paradisPendingFocusHandBack.clear();
		}

		// If the view is focused, pass focus back to the window when hiding
		if (!visible && this._view.webContents.isFocused()) {
			// PARA-PATCH: defer the hand-back while the window is in the background (Para Code: hiding also happens off-screen — switching spaces parks the leaving space's views — and focusing the window from there drags the whole app in front of whatever the user is actually using. Focus still has to leave the view we are hiding, so hand it back the next time that window comes forward, and only if nothing else claimed focus by then)
			const window = this._currentWindow?.win;
			if (window?.isFocused()) {
				window.webContents.focus();
			} else if (window && !window.isDestroyed()) {
				const handOverFocus = () => {
					if (window.isDestroyed() || this._view.webContents.isDestroyed()) {
						return;
					}
					// The window may have come forward because the user clicked another view in
					// it. Taking focus then would pull it off whatever they just clicked.
					const focused = webContents.getFocusedWebContents?.();
					if (focused && focused !== this._view.webContents) {
						return;
					}
					window.webContents.focus();
				};
				window.once('focus', handOverFocus);
				this._paradisPendingFocusHandBack.value = toDisposable(() => {
					if (!window.isDestroyed()) {
						window.off('focus', handOverFocus);
					}
				});
			}
		}

		if (this._hasBeenLaidOut || !visible) {
			this._view.setVisible(visible);
		}

		this._wantsVisibility = visible;
		this._onDidChangeVisibility.fire({ visible });
	}

	/**
	 * Get captured console logs.
	 */
	getConsoleLogs(): string {
		return this._consoleLogs.join('\n');
	}

	/**
	 * Load a URL in this view
	 */
	async loadURL(url: string): Promise<void> {
		if (this._redirectPinnedNavigation(url)) {
			return;
		}
		this._explicitNavigationPending = true;
		// Wait for the tunnel proxy (if any) to be applied so the navigation
		// and the requests it triggers flow through the proxy.
		await this.session.remote.whenReady;
		await this._view.webContents.loadURL(url);
	}

	private _redirectPinnedNavigation(url: string): boolean {
		if (!this.associatedResource || isBrowserViewAssociatedResourceNavigation(this.associatedResource, url)) {
			return false;
		}

		logBrowserOpen(this.telemetryService, 'browserLinkForeground');
		this._createChildView(this.owner, url, undefined, {
			pinned: true,
			parentViewId: this.id
		});
		return true;
	}

	/**
	 * Get the current URL
	 */
	getURL(): string {
		return this._view.webContents.getURL();
	}

	/**
	 * Navigate back in history
	 */
	goBack(): void {
		if (this._view.webContents.navigationHistory.canGoBack()) {
			this._view.webContents.navigationHistory.goBack();
		}
	}

	/**
	 * Navigate forward in history
	 */
	goForward(): void {
		if (this._view.webContents.navigationHistory.canGoForward()) {
			this._view.webContents.navigationHistory.goForward();
		}
	}

	/**
	 * Reload the current page
	 */
	reload(hard?: boolean): void {
		if (hard) {
			this._view.webContents.reloadIgnoringCache();
		} else {
			this._view.webContents.reload();
		}
	}

	/**
	 * Check if the view can navigate back
	 */
	canGoBack(): boolean {
		return this._view.webContents.navigationHistory.canGoBack();
	}

	/**
	 * Check if the view can navigate forward
	 */
	canGoForward(): boolean {
		return this._view.webContents.navigationHistory.canGoForward();
	}

	/**
	 * Capture a screenshot of this view
	 */
	// PARA-PATCH: route the capture through the serialized screenshot policy (coordinator + timing/trace + failure classification) instead of the inline capturePage path (Para Browser MCP screenshot hardening)
	async captureScreenshot(options?: IBrowserViewCaptureScreenshotOptions): Promise<VSBuffer> {
		const route = browserViewScreenshotRoute(options);
		const startedAt = Date.now();
		this.logService.trace(`[BrowserView] screenshot start route=${route}`);
		try {
			const result = await captureBrowserViewScreenshotWithPolicy(this._screenshotCoordinator, options, {
				isVisible: () => this._view.getVisible(),
				setPrivateVisible: visible => this._view.setVisible(visible),
				waitForNextPaint: () => this._waitForNextPaint(),
				capture: (currentRoute, signal) => this._captureScreenshot(options, currentRoute, signal),
			});
			this.logService.trace(`[BrowserView] screenshot complete route=${route} durationMs=${Date.now() - startedAt}`);
			return result;
		} catch (error) {
			const reason = error instanceof Error && error.message.includes('timed out') ? 'timeout'
				: error instanceof Error && error.message.includes('still in progress') ? 'in-progress'
					: error instanceof Error ? error.name : 'unknown';
			this.logService.warn(`[BrowserView] screenshot failed route=${route} durationMs=${Date.now() - startedAt} reason=${reason}`);
			throw error;
		}
	}

	// PARA-PATCH: per-route capture body (full-page / document-rect / screen-rect) with abort checks, pixel-budget guards and validated retry-until-valid encoding (Para Browser MCP screenshot hardening)
	private async _captureScreenshot(options: IBrowserViewCaptureScreenshotOptions | undefined, route: BrowserViewScreenshotRoute, signal: AbortSignal): Promise<VSBuffer> {
		browserViewThrowIfScreenshotAborted(signal);
		const quality = options?.quality ?? 80;
		const format = options?.format ?? 'jpeg';

		if (route === 'full-page') {
			return this._captureFullPageScreenshot(format, quality, signal);
		}

		if (route === 'document-rect' && options?.pageRect) {
			const zoomFactor = this._view.webContents.getZoomFactor();
			const visualViewportScale = await this.inspector.getVisualViewportScale();
			browserViewThrowIfScreenshotAborted(signal);
			const emulationScale = this.emulator.emulatedScaleFactor;
			browserViewAssertScreenshotPixelBudget({
				width: options.pageRect.width,
				height: options.pageRect.height,
				devicePixelRatio: this._paraScreenshot.captureBeyondViewportDevicePixelRatio(),
				zoomFactor,
				visualViewportScale,
				emulationScale,
			});
			return this._paraScreenshot.captureDocumentRectScreenshot(options.pageRect, format, quality, signal, route);
		}

		let screenRect = options?.screenRect;
		if (options?.pageRect) {
			const zoomFactor = this._view.webContents.getZoomFactor();
			// The visual viewport scale accounts for pinch-to-zoom magnification, which is separate from the regular zoom factor.
			const visualViewportScale = await this.inspector.getVisualViewportScale();
			browserViewThrowIfScreenshotAborted(signal);
			const emulationScale = this.emulator.emulatedScaleFactor;
			screenRect = {
				x: options.pageRect.x * visualViewportScale * zoomFactor * emulationScale,
				y: options.pageRect.y * visualViewportScale * zoomFactor * emulationScale,
				width: options.pageRect.width * visualViewportScale * zoomFactor * emulationScale,
				height: options.pageRect.height * visualViewportScale * zoomFactor * emulationScale
			};
		}
		const surfaceRect = screenRect ?? this._view.getBounds();
		// capturePage copies the existing compositor surface. Its bitmap allocation follows the
		// host display scale; an emulated deviceScaleFactor changes page rasterization, not this surface size.
		browserViewAssertScreenshotPixelBudget({
			width: surfaceRect.width,
			height: surfaceRect.height,
			devicePixelRatio: this._paraScreenshot.devicePixelRatio(),
		});
		const candidate = await captureBrowserViewWithRetry(
			async (captureSignal, attempt) => {
				const image = await this._view.webContents.capturePage(screenRect, { stayHidden: true });
				browserViewThrowIfScreenshotAborted(captureSignal);
				return this._paraScreenshot.validateAndEncodeScreenshot(image, format, quality, route, attempt);
			},
			current => current.valid,
			() => this._waitForNextPaint(),
			5,
			{ signal, onRetry: event => this.logService.trace(`[BrowserView] screenshot retry route=${route} attempt=${event.attempt} reason=${event.reason}`) },
		);
		if (!candidate.valid) {
			throw new Error('BrowserView screenshot validation exhausted without a valid image.');
		}
		const screenshot = VSBuffer.wrap(candidate.encoded);
		// Only update _lastScreenshot if capturing the full view
		if (!screenRect) {
			this._lastScreenshot = screenshot;
		}
		return screenshot;
	}

	// Capture a screenshot of the full scrollable document (beyond the viewport) via CDP.
	// PARA-PATCH: rewrite full-page capture to add abort checks, emulation-aware pixel budgeting/scaling and validated retry-until-valid encoding (Para Browser MCP screenshot hardening)
	private async _captureFullPageScreenshot(format: 'jpeg' | 'png', quality: number, signal: AbortSignal): Promise<VSBuffer> {
		browserViewThrowIfScreenshotAborted(signal);
		const metrics = await this.debugger.sendCommand('Page.getLayoutMetrics') as { cssContentSize?: { width: number; height: number } };
		browserViewThrowIfScreenshotAborted(signal);
		// Size in CSS pixels
		const size = metrics.cssContentSize;
		if (!size) {
			throw new Error('Page.getLayoutMetrics did not return a cssContentSize');
		}
		const zoomFactor = this._view.webContents.getZoomFactor();
		const visualViewportScale = await this.inspector.getVisualViewportScale();
		browserViewThrowIfScreenshotAborted(signal);
		const emulationScale = this.emulator.emulatedScaleFactor;
		const clipWidth = size.width * zoomFactor;
		const clipHeight = size.height * zoomFactor;
		// CDP renders the screenshot at device pixels, so the output bitmap dimensions are roughly
		// `clip.width * scale * devicePixelRatio`. Divide by DPR here so `MAX_FULL_PAGE_SCREENSHOT_DIMENSION`
		// is an upper bound on the final image pixel size (not just the CSS-pixel clip size).
		// We read the DPR from the display hosting the view's window (rather than evaluating
		// `window.devicePixelRatio` in the page) so this works without a renderer round-trip and
		// while the page is paused at a breakpoint. Fall back to the primary display if no host
		// window can be resolved (e.g. during teardown).
		const hostWindow = this._hostWindow;
		const display = hostWindow ? screen.getDisplayMatching(hostWindow.getBounds()) : screen.getPrimaryDisplay();
		const devicePixelRatio = browserViewEffectiveCaptureBeyondDevicePixelRatio(display.scaleFactor, this.emulator.device?.deviceScaleFactor) / paraBrowserViewZoomShrink(this._view.webContents); // PARA-PATCH: a page shrunk by zoom keeps its full devicePixelRatio (paraBrowserViewZoom.ts)
		const scale = browserViewCalculateBoundedCaptureScale({
			width: size.width,
			height: size.height,
			devicePixelRatio,
			zoomFactor,
			visualViewportScale,
			emulationScale,
		}, BrowserView.MAX_FULL_PAGE_SCREENSHOT_DIMENSION);
		browserViewAssertScreenshotPixelBudget({
			width: size.width,
			height: size.height,
			devicePixelRatio,
			zoomFactor,
			visualViewportScale,
			emulationScale,
			captureScale: scale,
		}, BrowserView.MAX_FULL_PAGE_SCREENSHOT_DIMENSION, BrowserView.MAX_FULL_PAGE_SCREENSHOT_DIMENSION ** 2);
		const route: BrowserViewScreenshotRoute = 'full-page';
		const candidate = await captureBrowserViewWithRetry(
			async (captureSignal, attempt) => {
				const image = await this._paraScreenshot.captureBeyondViewportImage({
					format,
					...(format === 'jpeg' ? { quality } : {}),
					captureBeyondViewport: true,
					// In theory, `clip` defaults to the full area when not explicitly passed, but in practice it doesn't work when
					// the zoom level isn't 100, because it doesn't multiply the width and height by zoomFactor like we do here.
					// Setting the clip explicitly, we can multiply by zoomFactor and thus work around this Chromium bug.
					// Note that even with this workaround, we often see that the page isn't fully captured and might repeat
					// visual content from the top at the bottom, instead of showing the bottom of the page.
					// - Another sidenote: Currently the scrollbar width isn't accounted for. If a scrollbar exists, we should add the
					//   vertical scrollbar's width and horizontal scrollbar's height to the clip dimensions, since the image is currently
					//   clipped by that amount (this also happens when no clip parameter is provided; ideally it should be fixed upstream
					//   in Chromium).
					clip: { x: 0, y: 0, width: clipWidth, height: clipHeight, scale }
				}, captureSignal);
				browserViewThrowIfScreenshotAborted(captureSignal);
				return this._paraScreenshot.validateAndEncodeScreenshot(image, format, quality, route, attempt);
			},
			current => current.valid,
			() => this._waitForNextPaint(),
			5,
			{ signal, onRetry: event => this.logService.trace(`[BrowserView] screenshot retry route=${route} attempt=${event.attempt} reason=${event.reason}`) },
		);
		if (!candidate.valid) {
			throw new Error('BrowserView screenshot validation exhausted without a valid image.');
		}
		return VSBuffer.wrap(candidate.encoded);
	}

	private async _waitForNextPaint(): Promise<void> {
		const WAIT_TIMEOUT_MS = 100;
		try {
			await Promise.race([
				this.debugger.sendCommand('Runtime.evaluate', {
					expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
					awaitPromise: true
				}),
				new Promise<void>(resolve => setTimeout(resolve, WAIT_TIMEOUT_MS))
			]);
		} catch {
			// `Runtime.evaluate` can throw if the page navigates while we're waiting;
			// just proceed in that case.
		}
	}

	/**
	 * Focus this view
	 */
	// PARA-PATCH: optional `paraOrigin` says which workbench path asked (Para Code browser focus diagnostics)
	async focus(force?: boolean, paraOrigin?: string): Promise<void> {
		// By default, only focus the view if its window is already focused.
		if (!force && !this._currentWindow?.win?.isFocused()) {
			return;
		}
		paraNoteBrowserViewFocusRequest(this, paraOrigin); // PARA-PATCH: mark the request before the focus it causes (Para Code browser focus diagnostics)
		this._view.webContents.focus();
	}

	/**
	 * Find text in the page
	 */
	async findInPage(text: string, options?: IBrowserViewFindInPageOptions): Promise<void> {
		this._view.webContents.findInPage(text, {
			matchCase: options?.matchCase ?? false,
			forward: options?.forward ?? true,

			// `findNext` is not very clearly named. From Electron docs: `Whether to begin a new text finding session with this request`.
			// It needs to be set to `true` if we want a new search to be performed, such as when the text changes.
			// We name it `recompute` in our internal options to better reflect its purpose / behavior.
			findNext: options?.recompute ?? false
		});
	}

	/**
	 * Stop finding in page
	 */
	async stopFindInPage(keepSelection?: boolean): Promise<void> {
		this._view.webContents.stopFindInPage(keepSelection ? 'keepSelection' : 'clearSelection');
	}

	/**
	 * Get the currently selected text in the browser view.
	 * Returns immediately with empty string if the page is still loading.
	 */
	async getSelectedText(): Promise<string> {
		// we don't want to wait for the page to finish loading, which executeJavaScript normally does.
		if (this._view.webContents.isLoading()) {
			return '';
		}
		try {
			// Uses our preloaded contextBridge-exposed API.
			return await this._view.webContents.executeJavaScriptInIsolatedWorld(browserViewIsolatedWorldId, [{ code: 'window.browserViewAPI?.getSelectedText?.() ?? ""' }]);
		} catch {
			return '';
		}
	}

	/**
	 * Clear all storage data for this browser view's session
	 */
	async clearStorage(): Promise<void> {
		await this.session.clearData();
	}

	/**
	 * Answer an in-progress hardware-device chooser. Pass the chosen device id,
	 * or `null` to cancel the chooser.
	 */
	selectDevice(requestId: string, deviceId: string | null): void {
		this.session.permissions.resolveDevice(requestId, deviceId);
	}

	/**
	 * Trust a certificate for a given host and reload the page.
	 */
	async trustCertificate(host: string, fingerprint: string): Promise<void> {
		await this.session.trust.trustCertificate(host, fingerprint);
		this._view.webContents.reload();
	}

	/**
	 * Revoke trust for a previously trusted certificate and close the view.
	 */
	async untrustCertificate(host: string, fingerprint: string): Promise<void> {
		await this.session.trust.untrustCertificate(host, fingerprint);
		this.dispose();
	}

	/**
	 * Get the underlying WebContentsView
	 */
	getWebContentsView(): WebContentsView {
		return this._view;
	}

	/**
	 * Get the hosting Electron window for this view, if any.
	 * This can be an auxiliary window, depending on where the view is currently hosted.
	 */
	getElectronWindow(): Electron.BrowserWindow | undefined {
		return this._currentWindow?.win ?? undefined;
	}

	/**
	 * The Electron window that currently hosts this view, if any. Before `layout()` is first
	 * called this is the owner window; after that it's whichever window the view was last moved
	 * to. Returns `undefined` if no host window can be resolved (e.g. during teardown).
	 */
	private get _hostWindow(): Electron.BrowserWindow | undefined {
		return this._currentWindow?.win ?? this._ownerWindow.win ?? undefined;
	}

	override dispose(): void {
		if (this._isDisposed) {
			return;
		}
		this._isDisposed = true;
		// PARA-PATCH: clear pending automation key expectations on disposal so no preload ack or timer outlives the view (Para Browser MCP automation input isolation)
		this._paraAutomationKeys.clearAutomationKeyExpectations();

		// Dispose debugger. This detaches debug sessions first.
		this.debugger.dispose();

		// Remove from parent window (guard against already-destroyed window)
		const currentWin = this._currentWindow?.win;
		if (currentWin && !currentWin.isDestroyed()) {
			currentWin.contentView.removeChildView(this._view);
		}

		// Fire close event BEFORE disposing emitters. This signals the view has been destroyed.
		this._onDidClose.fire();

		// Electron clears the view's webContents before emitting destroyed.
		const webContents = this._view.webContents;
		if (webContents && !webContents.isDestroyed()) {
			webContents.close({ waitForBeforeUnload: false });
		}

		super.dispose();
	}

	private _windowById(windowId: number | undefined): ICodeWindow | IAuxiliaryWindow | undefined {
		return this._codeWindowById(windowId) ?? this._auxiliaryWindowById(windowId);
	}

	private _codeWindowById(windowId: number | undefined): ICodeWindow | undefined {
		if (typeof windowId !== 'number') {
			return undefined;
		}

		return this.windowsMainService.getWindowById(windowId);
	}

	private _auxiliaryWindowById(windowId: number | undefined): IAuxiliaryWindow | undefined {
		if (typeof windowId !== 'number') {
			return undefined;
		}

		const contents = webContents.fromId(windowId);
		if (!contents) {
			return undefined;
		}

		return this.auxiliaryWindowsMainService.getWindowByWebContents(contents);
	}
}

/** True iff this URL should be recorded in browser history. */
function isTrackableHistoryUrl(url: string): boolean {
	if (!url) {
		return false;
	}
	// Cheap scheme filter avoids URL parsing on the hot path.
	const colon = url.indexOf(':');
	if (colon <= 0) {
		return false;
	}
	const scheme = url.substring(0, colon).toLowerCase();
	return scheme === 'http' || scheme === 'https' || scheme === 'file';
}
