/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
/* eslint-disable local/code-no-unexternalized-strings */

import { deepStrictEqual, ok, strictEqual } from 'assert';
import { NullOpenerService } from '../../../../../platform/opener/test/common/nullOpenerService.js';
import { timeout } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IRemoteAuthorityResolverService } from '../../../../../platform/remote/common/remoteAuthorityResolver.js';
import { ITunnelService } from '../../../../../platform/tunnel/common/tunnel.js';
import { IRemoteAgentService } from '../../../../../workbench/services/remote/common/remoteAgentService.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { IOverlayWebview, IWebviewService } from '../../../../../workbench/contrib/webview/browser/webview.js';
import { ITextFileService } from '../../../../../workbench/services/textfile/common/textfiles.js';
import { IWorkingCopyService } from '../../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { TestEditorGroupsService, TestEditorGroupView, TestLayoutService, TestTextResourceConfigurationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IEditorPane } from '../../../../../workbench/common/editor.js';
import { TestStorageService, TestWorkspaceTrustManagementService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { ILifecycleService, LifecyclePhase } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import { ParadisHtmlFileEditor, paradisHtmlOutsideWorkspaceCsp, paradisInjectHtmlHead, paradisInsertAtDocumentStart } from '../../electron-browser/paradisHtmlFileEditor.js';
import { ParadisHtmlFileInput } from '../../electron-browser/paradisHtmlFileInput.js';
import { notifyParadisWebviewSignal, ParadisWebviewSignalCode } from '../../../sentry/common/paradisWebviewSignals.js';

class TestParadisHtmlFileEditor extends ParadisHtmlFileEditor {

	get scriptsAllowed(): boolean {
		return this.allowScripts;
	}

	serviceWorkerDisabledFor(resource: URI): boolean {
		return this.disableServiceWorkerFor(resource);
	}

	rerenderRequests = 0;

	zoomTo(level: number): void {
		this.applyZoom(level);
	}

	protected override requestRerender(): void {
		this.rerenderRequests++;
		super.requestRerender();
	}

	render(text: string, resource: URI): Promise<string> {
		return Promise.resolve(this.renderDocument(text, resource, Object.create(null) as IOverlayWebview));
	}
}

/** ローカルサーバに載せたことにして、決め打ちの base URL を返す shared process。 */
const PREVIEW_MOUNT = { port: 56789, token: '0123456789abcdef0123456789abcdef' };
const PREVIEW_BASE = `http://127.0.0.1:${PREVIEW_MOUNT.port}/${PREVIEW_MOUNT.token}/`;

function createSharedProcessService(mount: (directory: string) => Promise<unknown> = () => Promise.resolve(PREVIEW_MOUNT)): ISharedProcessService {
	return {
		getChannel: () => ({
			call: (_command: string, args: unknown) => mount(String((args as string[])[0])),
			listen: () => { throw new Error('not used'); },
		}),
	} as unknown as ISharedProcessService;
}

/** ウィンドウの復元の段階だけを持つ lifecycle service。既定は復元が済んだ後。 */
function createLifecycleService(phase: LifecyclePhase = LifecyclePhase.Restored, whenRestored: Promise<void> = Promise.resolve()): ILifecycleService {
	return { phase, when: () => whenRestored } as unknown as ILifecycleService;
}

/** SSH 接続の有無を差し替えられる remote agent service。 */
function createRemoteAgentService(remoteAuthority?: string, mount?: (directory: string) => Promise<unknown>): IRemoteAgentService {
	return {
		getConnection: () => remoteAuthority
			? { remoteAuthority, getChannel: () => ({ call: (_c: string, args: unknown) => mount!(String((args as string[])[0])), listen: () => { throw new Error('not used'); } }) }
			: null,
	} as unknown as IRemoteAgentService;
}

function createRemoteAuthorityResolverService(): IRemoteAuthorityResolverService {
	return { resolveAuthority: async () => ({ authority: { authority: 'ssh-remote+box', connectTo: {}, connectionToken: undefined } }) } as unknown as IRemoteAuthorityResolverService;
}

/** ポート転送。`localPort` を渡すとそこへ転送できたことにする。 */
function createTunnelService(localPort?: number): ITunnelService & { closeTunnel(port: number): void; opened: number; localHosts: (string | undefined)[] } {
	const closed = new Emitter<{ port: number }>();
	const service = {
		opened: 0,
		localHosts: [] as (string | undefined)[],
		onTunnelClosed: closed.event,
		closeTunnel: (port: number) => closed.fire({ port }),
		openTunnel: async (_provider: unknown, _remoteHost: string, _remotePort: number, localHost?: string) => {
			service.opened++;
			service.localHosts.push(localHost);
			return localPort === undefined
				? 'tunnels are unavailable in this test'
				: { tunnelRemotePort: 1, tunnelRemoteHost: '127.0.0.1', tunnelLocalPort: localPort, localAddress: `127.0.0.1:${localPort}`, privacy: 'private', dispose: async () => { } };
		},
	};
	return service as unknown as ITunnelService & { closeTunnel(port: number): void; opened: number; localHosts: (string | undefined)[] };
}

/** ワークスペースフォルダーを1つだけ持つ context service。 */
function createWorkspaceContextService(folder: URI | undefined): IWorkspaceContextService {
	return {
		getWorkspaceFolder: (resource: URI) => folder && resource.path.startsWith(`${folder.path}/`) ? { uri: folder } : null,
	} as unknown as IWorkspaceContextService;
}

suite('ParadisHtmlFileEditor', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createGenerationEditor(
		sharedProcessService: ISharedProcessService = createSharedProcessService(),
		workspaceFolder: URI | undefined = undefined,
		remote: { agent?: IRemoteAgentService; tunnel?: ITunnelService } = {},
	): TestParadisHtmlFileEditor {
		return disposables.add(new TestParadisHtmlFileEditor(
			new TestEditorGroupView(1),
			NullTelemetryService,
			new TestThemeService(),
			disposables.add(new TestStorageService()),
			Object.create(null) as IWebviewService,
			Object.create(null) as ITextFileService,
			Object.create(null) as IFileService,
			Object.create(null) as ITextModelService,
			disposables.add(new TestInstantiationService()),
			new TestLayoutService(),
			new TestConfigurationService(),
			new TestNotificationService(),
			new TestTextResourceConfigurationService(),
			Object.create(null) as IEditorService,
			new TestEditorGroupsService(),
			sharedProcessService,
			createWorkspaceContextService(workspaceFolder),
			remote.agent ?? createRemoteAgentService(),
			createRemoteAuthorityResolverService(),
			remote.tunnel ?? createTunnelService(),
			disposables.add(new TestWorkspaceTrustManagementService()),
			createLifecycleService(),
			NullOpenerService,
		));
	}

	function createProductionEditor(webviewService: IWebviewService, textFileService: ITextFileService, fileService: IFileService, trusted = true, sharedProcessService = createSharedProcessService(), lifecycleService = createLifecycleService(), group = new TestEditorGroupView(1)): TestParadisHtmlFileEditor {
		return disposables.add(new TestParadisHtmlFileEditor(
			group,
			NullTelemetryService,
			new TestThemeService(),
			disposables.add(new TestStorageService()),
			webviewService,
			textFileService,
			fileService,
			Object.create(null) as ITextModelService,
			disposables.add(new TestInstantiationService()),
			new TestLayoutService(),
			new TestConfigurationService(),
			new TestNotificationService(),
			new TestTextResourceConfigurationService(),
			Object.create(null) as IEditorService,
			new TestEditorGroupsService(),
			sharedProcessService,
			createWorkspaceContextService(undefined),
			createRemoteAgentService(),
			createRemoteAuthorityResolverService(),
			createTunnelService(),
			disposables.add(new TestWorkspaceTrustManagementService(trusted)),
			lifecycleService,
			NullOpenerService,
		));
	}

	async function renderThroughSetInput(trusted: boolean): Promise<{ contentOptions: { allowScripts: boolean | undefined; localResourceRoots: string[] | undefined } | undefined; html: string | undefined; editor: TestParadisHtmlFileEditor }> {
		const resource = URI.file('/workspace/site/index.html');
		const source = '<main><img src="./assets/logo.png"></main>';
		let renderedHtml: string | undefined;
		let contentOptionsAtSetHtml: { allowScripts: boolean | undefined; localResourceRoots: string[] | undefined } | undefined;
		const webview = {
			contentOptions: {},
			onFatalError: Event.None,
			onDidScroll: Event.None,
			onDidClickLink: Event.None,
			setHtml: (html: string) => {
				renderedHtml = html;
				contentOptionsAtSetHtml = {
					allowScripts: webview.contentOptions.allowScripts,
					localResourceRoots: webview.contentOptions.localResourceRoots?.map(root => root.toString()),
				};
			},
			focus: () => { },
			dispose: () => { },
			postMessage: async () => true,
		} as unknown as IOverlayWebview;
		const webviewService = {
			createWebviewOverlay: () => webview,
		} as unknown as IWebviewService;
		const textFileService = {
			read: () => Promise.resolve({ value: source }),
		} as unknown as ITextFileService;
		const fileService = {
			createWatcher: () => { throw new Error('watching is unavailable in this test'); },
			onDidWatchError: Event.None,
		} as unknown as IFileService;
		const workingCopyService = { onDidChangeDirty: Event.None } as unknown as IWorkingCopyService;
		const editor = createProductionEditor(webviewService, textFileService, fileService, trusted);
		const input = disposables.add(new ParadisHtmlFileInput(resource, textFileService, workingCopyService));

		await editor.setInput(input, undefined, Object.create(null), CancellationToken.None);
		return { contentOptions: contentOptionsAtSetHtml, html: renderedHtml, editor };
	}

	test('while the window is restoring, setInput does not wait for the preview server, and the page is drawn when it answers', async () => {
		let answerMount: (value: unknown) => void = () => { };
		const mount = new Promise(resolve => { answerMount = resolve; });
		let renderedHtml: string | undefined;
		let drawn: (html: string) => void = () => { };
		const whenDrawn = new Promise<string>(resolve => { drawn = resolve; });
		const webview = {
			contentOptions: {},
			onFatalError: Event.None,
			onDidScroll: Event.None,
			onDidClickLink: Event.None,
			setHtml: (html: string) => { renderedHtml = html; drawn(html); },
			focus: () => { },
			dispose: () => { },
			postMessage: async () => true,
		} as unknown as IOverlayWebview;
		const textFileService = { read: () => Promise.resolve({ value: '<main>x</main>' }) } as unknown as ITextFileService;
		const fileService = {
			createWatcher: () => { throw new Error('watching is unavailable in this test'); },
			onDidWatchError: Event.None,
		} as unknown as IFileService;
		const workingCopyService = { onDidChangeDirty: Event.None } as unknown as IWorkingCopyService;
		const restoring = createProductionEditor({ createWebviewOverlay: () => webview } as unknown as IWebviewService, textFileService, fileService, true, createSharedProcessService(() => mount), createLifecycleService(LifecyclePhase.Ready));
		const input = disposables.add(new ParadisHtmlFileInput(URI.file('/workspace/site/index.html'), textFileService, workingCopyService));

		await restoring.setInput(input, undefined, Object.create(null), CancellationToken.None);
		const beforeAnswer = renderedHtml;
		answerMount(PREVIEW_MOUNT);
		const html = await whenDrawn;
		deepStrictEqual({
			beforeAnswer,
			base: new DOMParser().parseFromString(html, 'text/html').querySelector('base')?.getAttribute('href'),
		}, {
			beforeAnswer: undefined,
			base: PREVIEW_BASE,
		});
	});

	test('while the window is restoring, the page is still drawn after the editor cancels the setInput token once setInput returns', async () => {
		// editorPanes は setInput が返ると、その進み具合の operation を止めて token を取り消す。待たずに返した描画は
		// その token に縛られず、最後まで描かなければならない。
		let answerMount: (value: unknown) => void = () => { };
		const mount = new Promise(resolve => { answerMount = resolve; });
		let drawn: (html: string) => void = () => { };
		const whenDrawn = new Promise<string>(resolve => { drawn = resolve; });
		const webview = {
			contentOptions: {},
			onFatalError: Event.None,
			onDidScroll: Event.None,
			onDidClickLink: Event.None,
			setHtml: (html: string) => { if (html) { drawn(html); } },
			focus: () => { },
			dispose: () => { },
			postMessage: async () => true,
		} as unknown as IOverlayWebview;
		const textFileService = { read: () => Promise.resolve({ value: '<main>x</main>' }) } as unknown as ITextFileService;
		const fileService = {
			createWatcher: () => { throw new Error('watching is unavailable in this test'); },
			onDidWatchError: Event.None,
		} as unknown as IFileService;
		const workingCopyService = { onDidChangeDirty: Event.None } as unknown as IWorkingCopyService;
		const restoring = createProductionEditor({ createWebviewOverlay: () => webview } as unknown as IWebviewService, textFileService, fileService, true, createSharedProcessService(() => mount), createLifecycleService(LifecyclePhase.Ready));
		const input = disposables.add(new ParadisHtmlFileInput(URI.file('/workspace/site/index.html'), textFileService, workingCopyService));
		const operation = new CancellationTokenSource();

		await restoring.setInput(input, undefined, Object.create(null), operation.token);
		operation.dispose(true);
		answerMount(PREVIEW_MOUNT);
		const html = await whenDrawn;
		strictEqual(new DOMParser().parseFromString(html, 'text/html').querySelector('base')?.getAttribute('href'), PREVIEW_BASE);
	});

	test('when the drawing that setInput did not wait for fails, the editor is opened again after the window is restored to show the error', async () => {
		let restored: () => void = () => { };
		const whenRestored = new Promise<void>(resolve => { restored = resolve; });
		let reopened: (options: unknown) => void = () => { };
		const whenReopened = new Promise<unknown>(resolve => { reopened = resolve; });
		const group = new TestEditorGroupView(1);
		group.contains = () => true;
		group.openEditor = (_editor, options) => { reopened(options); return Promise.resolve(undefined as unknown as IEditorPane); };
		const textFileService = { read: () => Promise.reject(new Error('cannot read')) } as unknown as ITextFileService;
		const fileService = {
			createWatcher: () => { throw new Error('watching is unavailable in this test'); },
			onDidWatchError: Event.None,
		} as unknown as IFileService;
		const workingCopyService = { onDidChangeDirty: Event.None } as unknown as IWorkingCopyService;
		const editor = createProductionEditor(Object.create(null) as IWebviewService, textFileService, fileService, true, createSharedProcessService(), createLifecycleService(LifecyclePhase.Ready, whenRestored), group);
		const input = disposables.add(new ParadisHtmlFileInput(URI.file('/workspace/site/missing.html'), textFileService, workingCopyService));

		await editor.setInput(input, undefined, Object.create(null), CancellationToken.None);
		restored();
		const options = await whenReopened as { forceReload?: boolean; preserveFocus?: boolean };
		deepStrictEqual({ forceReload: options.forceReload, preserveFocus: options.preserveFocus }, { forceReload: true, preserveFocus: true });
	});

	test('public setInput applies script and resource policy before setting rendered HTML', async () => {
		const { contentOptions, html } = await renderThroughSetInput(true);
		deepStrictEqual(contentOptions, {
			allowScripts: true,
			localResourceRoots: ['file:///workspace/site'],
		});
		ok(html);
		const document = new DOMParser().parseFromString(html, 'text/html');
		strictEqual(document.querySelector('base')?.getAttribute('href'), PREVIEW_BASE);
		strictEqual(document.querySelector('img')?.getAttribute('src'), './assets/logo.png');
	});

	test('does not run the page scripts in an untrusted workspace, and zooms by rendering again', async () => {
		const untrusted = await renderThroughSetInput(false);
		untrusted.editor.zoomTo(1);
		const trusted = await renderThroughSetInput(true);
		trusted.editor.zoomTo(1);
		// スクリプトが動かないとページの中で倍率を変えられないので、倍率を CSS に焼き込んで描き直す
		deepStrictEqual({
			contentOptions: untrusted.contentOptions,
			rerenders: [untrusted.editor.rerenderRequests, trusted.editor.rerenderRequests],
			zoomBakedIn: (await untrusted.editor.render('<p>x</p>', URI.file('/workspace/site/index.html'))).includes('html{zoom:1.2;'),
		}, {
			contentOptions: { allowScripts: false, localResourceRoots: ['file:///workspace/site'] },
			rerenders: [1, 0],
			zoomBakedIn: true,
		});
	});

	test('keeps the page when coming back to the same file, and restores the scroll position for another one', async () => {
		const first = URI.file('/workspace/site/index.html');
		const second = URI.file('/workspace/site/other.html');
		const scroll = disposables.add(new Emitter<{ scrollYPercentage: number }>());
		const writes: { file: string; restoreTo: number | undefined; initialScrollProgress: number }[] = [];
		const webview = {
			origin: 'scroll-test-origin',
			contentOptions: {},
			initialScrollProgress: 0,
			onFatalError: Event.None,
			onDidScroll: scroll.event,
			onDidClickLink: Event.None,
			setHtml: (html: string) => {
				writes.push({
					file: html.includes('other') ? 'other' : html ? 'index' : '',
					restoreTo: /var p=([\d.]+);/.exec(html) ? Number(/var p=([\d.]+);/.exec(html)![1]) : undefined,
					initialScrollProgress: webview.initialScrollProgress,
				});
			},
			focus: () => { },
			dispose: () => { },
			release: () => { },
			postMessage: async () => true,
		} as unknown as IOverlayWebview & { initialScrollProgress: number };
		const textFileService = {
			read: (resource: URI) => Promise.resolve({ value: resource.path.endsWith('other.html') ? '<p>other</p>' : '<p>index</p>' }),
		} as unknown as ITextFileService;
		const fileService = {
			createWatcher: () => { throw new Error('watching is unavailable in this test'); },
			onDidWatchError: Event.None,
		} as unknown as IFileService;
		const workingCopyService = { onDidChangeDirty: Event.None } as unknown as IWorkingCopyService;
		const editor = createProductionEditor({ createWebviewOverlay: () => webview } as unknown as IWebviewService, textFileService, fileService);
		const firstInput = disposables.add(new ParadisHtmlFileInput(first, textFileService, workingCopyService));
		const secondInput = disposables.add(new ParadisHtmlFileInput(second, textFileService, workingCopyService));
		const context = Object.create(null);

		await editor.setInput(firstInput, undefined, context, CancellationToken.None);
		// webview が書き込みを終えた（白紙ではない）と知らせてくる。
		notifyParadisWebviewSignal({ origin: 'scroll-test-origin', code: ParadisWebviewSignalCode.ContentApplied });
		scroll.fire({ scrollYPercentage: 0.25 });
		// 別の種類のエディタへ切り替えて戻る（ペインは clearInput される）。
		editor.clearInput();
		await editor.setInput(firstInput, undefined, context, CancellationToken.None);
		// 同じペインで別の HTML を開き、元のファイルへ戻る。
		editor.clearInput();
		await editor.setInput(secondInput, undefined, context, CancellationToken.None);
		editor.clearInput();
		await editor.setInput(firstInput, undefined, context, CancellationToken.None);

		deepStrictEqual(writes, [
			{ file: 'index', restoreTo: 0, initialScrollProgress: 0 },
			{ file: '', restoreTo: undefined, initialScrollProgress: 0 },
			{ file: 'other', restoreTo: 0, initialScrollProgress: 0 },
			{ file: '', restoreTo: undefined, initialScrollProgress: 0 },
			{ file: 'index', restoreTo: 0.25, initialScrollProgress: 0.25 },
		]);
	});

	test('draws a saved file of the next input again even while a re-render of the previous input never returns', async () => {
		const first = URI.file('/workspace/site/index.html');
		const second = URI.file('/workspace/site/other.html');
		const pages: string[] = [];
		const webview = {
			contentOptions: {},
			onFatalError: Event.None,
			onDidScroll: Event.None,
			onDidClickLink: Event.None,
			setHtml: (html: string) => {
				const page = /<p>([^<]*)<\/p>/.exec(html)?.[1];
				if (page) {
					pages.push(page);
				}
			},
			focus: () => { },
			dispose: () => { },
			claim: () => { },
			release: () => { },
			setAnchorElement: () => { },
			container: document.createElement('div'),
			postMessage: async () => true,
		} as unknown as IOverlayWebview;
		let firstReads = 0;
		let secondVersion = 1;
		const textFileService = {
			read: (resource: URI) => {
				if (resource.path.endsWith('other.html')) {
					return Promise.resolve({ value: `<p>other v${secondVersion}</p>` });
				}
				// 2 回目からの読み（描き直し）は返らない（接続先の読みが詰まった）
				return ++firstReads === 1 ? Promise.resolve({ value: '<p>index</p>' }) : new Promise<never>(() => { });
			},
		} as unknown as ITextFileService;
		const changes = disposables.add(new Emitter<URI>());
		const fileService = {
			createWatcher: (resource: URI) => ({
				onDidChange: (listener: (event: { contains(uri: URI): boolean }) => void) => changes.event(changed => {
					if (changed.toString() === resource.toString()) {
						listener({ contains: uri => uri.toString() === resource.toString() });
					}
				}),
				dispose: () => { },
			}),
			onDidWatchError: Event.None,
		} as unknown as IFileService;
		const workingCopyService = { onDidChangeDirty: Event.None } as unknown as IWorkingCopyService;
		const editor = createProductionEditor({ createWebviewOverlay: () => webview } as unknown as IWebviewService, textFileService, fileService);
		const firstInput = disposables.add(new ParadisHtmlFileInput(first, textFileService, workingCopyService));
		const secondInput = disposables.add(new ParadisHtmlFileInput(second, textFileService, workingCopyService));
		const context = Object.create(null);
		editor.create(document.createElement('div'));

		await editor.setInput(firstInput, undefined, context, CancellationToken.None);
		// 見えるようになると描き直す。この描き直しは返らないまま残る
		editor.setVisible(true);
		await timeout(0);
		const stuckReads = firstReads;
		await editor.setInput(secondInput, undefined, context, CancellationToken.None);
		secondVersion = 2;
		changes.fire(second);
		await timeout(300);

		deepStrictEqual({ stuckReads, pages }, { stuckReads: 2, pages: ['index', 'other v1', 'other v2'] });
	});

	test('sends the page again when it was left before the webview confirmed showing it', async () => {
		const first = URI.file('/workspace/site/index.html');
		const scroll = disposables.add(new Emitter<{ scrollYPercentage: number }>());
		const writes: { file: string; restoreTo: number | undefined; initialScrollProgress: number }[] = [];
		const webview = {
			origin: 'scroll-test-origin',
			contentOptions: {},
			initialScrollProgress: 0,
			onFatalError: Event.None,
			onDidScroll: scroll.event,
			onDidClickLink: Event.None,
			setHtml: (html: string) => {
				writes.push({
					file: html.includes('other') ? 'other' : html ? 'index' : '',
					restoreTo: /var p=([\d.]+);/.exec(html) ? Number(/var p=([\d.]+);/.exec(html)![1]) : undefined,
					initialScrollProgress: webview.initialScrollProgress,
				});
			},
			focus: () => { },
			dispose: () => { },
			release: () => { },
			postMessage: async () => true,
		} as unknown as IOverlayWebview & { initialScrollProgress: number };
		const textFileService = {
			read: (resource: URI) => Promise.resolve({ value: resource.path.endsWith('other.html') ? '<p>other</p>' : '<p>index</p>' }),
		} as unknown as ITextFileService;
		const fileService = {
			createWatcher: () => { throw new Error('watching is unavailable in this test'); },
			onDidWatchError: Event.None,
		} as unknown as IFileService;
		const workingCopyService = { onDidChangeDirty: Event.None } as unknown as IWorkingCopyService;
		const editor = createProductionEditor({ createWebviewOverlay: () => webview } as unknown as IWebviewService, textFileService, fileService);
		const firstInput = disposables.add(new ParadisHtmlFileInput(first, textFileService, workingCopyService));
		const context = Object.create(null);

		await editor.setInput(firstInput, undefined, context, CancellationToken.None);
		// 書き込みの完了を知らせてくる前に別の種類のエディタへ切り替えて戻る。
		editor.clearInput();
		await editor.setInput(firstInput, undefined, context, CancellationToken.None);

		deepStrictEqual(writes.map(write => write.file), ['index', 'index']);
	});

	suite('renderDocument generation contract', () => {

		test('preserves the author CSP and external script URL', async () => {
			const editor = createGenerationEditor();
			const source = `<!DOCTYPE html>
<html>
<head>
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src https://trusted.example">
	<script src="https://trusted.example/app.js"></script>
</head>
<body></body>
</html>`;

			const document = new DOMParser().parseFromString(await editor.render(source, URI.file('/workspace/site/index.html')), 'text/html');
			const csp = [...document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')].map(meta => meta.getAttribute('content'));
			const externalScript = document.querySelector('script[src]');

			strictEqual(editor.scriptsAllowed, true);
			// ワークスペースの外の文書なので、先頭に connect-src の CSP が足される。著者の CSP はそのまま残る（両方が効く）。
			deepStrictEqual(csp, [`connect-src http://127.0.0.1:${PREVIEW_MOUNT.port}`, "default-src 'none'; script-src https://trusted.example"]);
			strictEqual(externalScript?.getAttribute('src'), 'https://trusted.example/app.js');
		});

		test('limits connect-src to the preview server only for a document outside the workspace', async () => {
			const source = '<!DOCTYPE html><html><head><title>t</title></head><body><script>fetch("./other.pdf")</script></body></html>';
			const cspOf = async (editor: TestParadisHtmlFileEditor) => {
				const document = new DOMParser().parseFromString(await editor.render(source, URI.file('/workspace/site/index.html')), 'text/html');
				return [...document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')].map(meta => meta.getAttribute('content'));
			};

			deepStrictEqual([
				await cspOf(createGenerationEditor()),
				await cspOf(createGenerationEditor(createSharedProcessService(), URI.file('/workspace'))),
				await cspOf(createGenerationEditor(createSharedProcessService(() => Promise.reject(new Error('shared process is gone'))))),
			], [
				[`connect-src http://127.0.0.1:${PREVIEW_MOUNT.port}`],
				[],
				['connect-src https://*.vscode-resource.vscode-cdn.net'],
			]);
		});

		test('resolves relative document assets through the local preview server', async () => {
			// ワークスペースフォルダーごと載せるので、`../` の参照も URL のトークンの内側に収まる。
			let mounted: string | undefined;
			const editor = createGenerationEditor(
				createSharedProcessService(directory => { mounted = directory; return Promise.resolve(PREVIEW_MOUNT); }),
				URI.file('/workspace'));
			const source = '<main><img id="logo" src="./assets/logo.png"><a id="guide" href="../guide.html">Guide</a></main>';

			const document = new DOMParser().parseFromString(await editor.render(source, URI.file('/workspace/site/index.html')), 'text/html');
			strictEqual(mounted, URI.file('/workspace').fsPath);
			const base = document.querySelector('base');
			const image = document.querySelector<HTMLImageElement>('#logo');
			const link = document.querySelector<HTMLAnchorElement>('#guide');

			ok(base);
			ok(image);
			ok(link);
			strictEqual(base.getAttribute('href'), `${PREVIEW_BASE}site/`);
			strictEqual(new URL(image.getAttribute('src')!, base.href).toString(), `${PREVIEW_BASE}site/assets/logo.png`);
			strictEqual(new URL(link.getAttribute('href')!, base.href).toString(), `${PREVIEW_BASE}guide.html`);
		});

		test('mounts the document folder when its place inside the workspace only leads upwards', async () => {
			// 属していると判定されるのに `../` で上へ抜ける相対パスしか出ない状況
			// （フォルダーの照合が大文字小文字を無視する環境で起きる）。
			let mounted: string | undefined;
			const workspace = {
				getWorkspaceFolder: () => ({ uri: URI.file('/Workspace') }),
			} as unknown as IWorkspaceContextService;
			const editor = disposables.add(new TestParadisHtmlFileEditor(
				new TestEditorGroupView(1), NullTelemetryService, new TestThemeService(),
				disposables.add(new TestStorageService()),
				Object.create(null) as IWebviewService, Object.create(null) as ITextFileService,
				Object.create(null) as IFileService, Object.create(null) as ITextModelService,
				disposables.add(new TestInstantiationService()), new TestLayoutService(),
				new TestConfigurationService(), new TestNotificationService(),
				new TestTextResourceConfigurationService(), Object.create(null) as IEditorService, new TestEditorGroupsService(),
				createSharedProcessService(directory => { mounted = directory; return Promise.resolve(PREVIEW_MOUNT); }),
				workspace, createRemoteAgentService(), createRemoteAuthorityResolverService(), createTunnelService(),
				disposables.add(new TestWorkspaceTrustManagementService()), createLifecycleService(), NullOpenerService));

			const document = new DOMParser().parseFromString(
				await editor.render('<img src="a.png">', URI.file('/workspace/site/index.html')), 'text/html');

			// ワークスペースの先頭ではなく、ファイルのフォルダーが載る。
			strictEqual(mounted, URI.file('/workspace/site').fsPath);
			strictEqual(document.querySelector('base')?.getAttribute('href'), PREVIEW_BASE);
		});

		test('appends the zoom hook instead of splicing it into the first closing body tag', async () => {
			const editor = createGenerationEditor();
			// ページ自身のスクリプトの中に `</body>` という文字列があるページ。閉じタグを探して
			// 差し込むと、注入した `</script>` がこのスクリプトを途中で終わらせてしまう。
			const ownScript = 'const raw = ["</body>", "</html>"];';
			const source = `<html><head></head><body><script>${ownScript}</script></body></html>`;

			const html = await editor.render(source, URI.file('/workspace/site/index.html'));

			ok(html.includes(ownScript), html);
			ok(html.indexOf('__paradisZoom') > html.indexOf('</html>'), html);
			strictEqual(html.trimEnd().endsWith('</script>'), true);
		});

		test('serves a remote document through the forwarded port', async () => {
			// SSH 先はリモートに載せ、手元へ転送したポートで見る。リモート側にはそのマシンの
			// パス（`fsPath` ではなく `path`）を渡すこと。
			let mounted: string | undefined;
			const agent = createRemoteAgentService('ssh-remote+box', directory => { mounted = directory; return Promise.resolve(PREVIEW_MOUNT); });
			const editor = createGenerationEditor(createSharedProcessService(), undefined, { agent, tunnel: createTunnelService(45678) });
			const remote = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+box', path: '/home/user/site/index.html' });

			strictEqual(editor.serviceWorkerDisabledFor(remote), true);
			const document = new DOMParser().parseFromString(await editor.render('<img src="a.png">', remote), 'text/html');

			strictEqual(mounted, '/home/user/site');
			strictEqual(document.querySelector('base')?.getAttribute('href'), `http://127.0.0.1:45678/${PREVIEW_MOUNT.token}/`);
		});

		test('forwards to the loopback address only', async () => {
			// 手元側の bind 先を省くと、`remote.localPortHost` の設定次第で 0.0.0.0 に開き、
			// SSH 先のフォルダーが LAN から読めてしまう。
			const tunnel = createTunnelService(45678);
			const agent = createRemoteAgentService('ssh-remote+box', () => Promise.resolve(PREVIEW_MOUNT));
			const editor = createGenerationEditor(createSharedProcessService(), undefined, { agent, tunnel });
			const remote = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+box', path: '/home/user/site/index.html' });

			await editor.render('<img src="a.png">', remote);

			deepStrictEqual(tunnel.localHosts, ['127.0.0.1']);
		});

		test('forwards again after the user stops the forwarded port', async () => {
			// Ports ビューから転送を止められる。止められたものを持ち続けると、死んだポートを
			// 指したまま二度と張り直さない。
			const tunnel = createTunnelService(45678);
			const agent = createRemoteAgentService('ssh-remote+box', () => Promise.resolve(PREVIEW_MOUNT));
			const editor = createGenerationEditor(createSharedProcessService(), undefined, { agent, tunnel });
			const remote = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+box', path: '/home/user/site/index.html' });

			await editor.render('<img src="a.png">', remote);
			await editor.render('<img src="a.png">', remote);
			strictEqual(tunnel.opened, 1);

			tunnel.closeTunnel(PREVIEW_MOUNT.port);
			await editor.render('<img src="a.png">', remote);

			strictEqual(tunnel.opened, 2);
		});

		test('keeps the webview resource url when the remote port cannot be forwarded', async () => {
			const agent = createRemoteAgentService('ssh-remote+box', () => Promise.resolve(PREVIEW_MOUNT));
			const editor = createGenerationEditor(createSharedProcessService(), undefined, { agent, tunnel: createTunnelService(undefined) });
			const remote = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+box', path: '/home/user/site/index.html' });

			const document = new DOMParser().parseFromString(await editor.render('<img src="a.png">', remote), 'text/html');
			const href = document.querySelector('base')?.getAttribute('href');

			ok(href?.startsWith('https://'), String(href));
			ok(href?.includes('vscode-resource'), String(href));
			ok(href?.endsWith('/home/user/site/'), String(href));
			// 次の描画からは service worker のある webview へ作り直させる。
			strictEqual(editor.serviceWorkerDisabledFor(remote), false);
		});

		test('keeps the webview resource url when there is no remote connection', async () => {
			const editor = createGenerationEditor();
			const remote = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+box', path: '/home/user/site/index.html' });

			strictEqual(editor.serviceWorkerDisabledFor(remote), false);
			const document = new DOMParser().parseFromString(await editor.render('<img src="a.png">', remote), 'text/html');
			ok(document.querySelector('base')?.getAttribute('href')?.includes('vscode-resource'));
		});

		test('falls back to the service worker once the local server cannot be reached', async () => {
			const editor = createGenerationEditor(createSharedProcessService(() => Promise.reject(new Error('shared process is gone'))));
			const resource = URI.file('/workspace/site/index.html');

			strictEqual(editor.serviceWorkerDisabledFor(resource), true);
			const document = new DOMParser().parseFromString(await editor.render('<img src="a.png">', resource), 'text/html');

			strictEqual(document.querySelector('base')?.getAttribute('href'), 'https://file+.vscode-resource.vscode-cdn.net/workspace/site/');
			// 次に描くときは service worker のある webview へ作り直させる。
			strictEqual(editor.serviceWorkerDisabledFor(resource), false);
		});
	});
});

suite('paradisInsertAtDocumentStart', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('puts the CSP before any script, even when a comment or a script comes before the real <head>', () => {
		const csp = paradisHtmlOutsideWorkspaceCsp('http://127.0.0.1:56789/0123456789abcdef0123456789abcdef/');
		const pages = [
			'<!DOCTYPE html><!-- <head> --><html><head><script>fetch("x")</script></head></html>',
			'<script>fetch("x")</script><html><head></head></html>',
			'<!-- note --><!doctype html><html><head></head><body><script>1</script></body></html>',
		];
		deepStrictEqual(pages.map(page => {
			const html = paradisInsertAtDocumentStart(paradisInjectHtmlHead(page, '<base href="b/">'), csp);
			const document = new DOMParser().parseFromString(html, 'text/html');
			const first = document.querySelector('meta[http-equiv="Content-Security-Policy"], script');
			return { first: first?.tagName, csp: first?.getAttribute('content'), mode: document.compatMode };
		}), [
			{ first: 'META', csp: 'connect-src http://127.0.0.1:56789', mode: 'CSS1Compat' },
			{ first: 'META', csp: 'connect-src http://127.0.0.1:56789', mode: 'BackCompat' },
			{ first: 'META', csp: 'connect-src http://127.0.0.1:56789', mode: 'CSS1Compat' },
		]);
	});
});

suite('paradisInjectHtmlHead', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('puts the injection into a new <head> after <html> when the page omits <head> but has <header>', () => {
		deepStrictEqual([
			paradisInjectHtmlHead('<html lang="ja"><link rel="stylesheet" href="style.css"><body><header class="top">x</header></body></html>', '<base href="b/">'),
			paradisInjectHtmlHead('<header>x</header>', '<base href="b/">'),
			paradisInjectHtmlHead('<html><head data-x="1"><title>t</title></head><body><header>x</header></body></html>', '<base href="b/">'),
		], [
			'<html lang="ja"><head><base href="b/"></head><link rel="stylesheet" href="style.css"><body><header class="top">x</header></body></html>',
			'<head><base href="b/"></head><header>x</header>',
			'<html><head data-x="1"><base href="b/"><title>t</title></head><body><header>x</header></body></html>',
		]);
	});
});
