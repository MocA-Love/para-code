/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
/* eslint-disable local/code-no-unexternalized-strings */

import { deepStrictEqual, ok, strictEqual } from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
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
import { TestEditorGroupView, TestLayoutService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { ParadisHtmlFileEditor } from '../../electron-browser/paradisHtmlFileEditor.js';
import { ParadisHtmlFileInput } from '../../electron-browser/paradisHtmlFileInput.js';

class TestParadisHtmlFileEditor extends ParadisHtmlFileEditor {

	get scriptsAllowed(): boolean {
		return this.allowScripts;
	}

	serviceWorkerDisabledFor(resource: URI): boolean {
		return this.disableServiceWorkerFor(resource);
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
			sharedProcessService,
			createWorkspaceContextService(workspaceFolder),
			remote.agent ?? createRemoteAgentService(),
			createRemoteAuthorityResolverService(),
			remote.tunnel ?? createTunnelService(),
		));
	}

	function createProductionEditor(webviewService: IWebviewService, textFileService: ITextFileService, fileService: IFileService): ParadisHtmlFileEditor {
		return disposables.add(new ParadisHtmlFileEditor(
			new TestEditorGroupView(1),
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
			createSharedProcessService(),
			createWorkspaceContextService(undefined),
			createRemoteAgentService(),
			createRemoteAuthorityResolverService(),
			createTunnelService(),
		));
	}

	test('public setInput applies script and resource policy before setting rendered HTML', async () => {
		const resource = URI.file('/workspace/site/index.html');
		const source = '<main><img src="./assets/logo.png"></main>';
		let renderedHtml: string | undefined;
		let contentOptionsAtSetHtml: { allowScripts: boolean | undefined; localResourceRoots: string[] | undefined } | undefined;
		const webview = {
			contentOptions: {},
			onFatalError: Event.None,
			setHtml: (html: string) => {
				renderedHtml = html;
				contentOptionsAtSetHtml = {
					allowScripts: webview.contentOptions.allowScripts,
					localResourceRoots: webview.contentOptions.localResourceRoots?.map(root => root.toString()),
				};
			},
			focus: () => { },
			dispose: () => { },
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
		const editor = createProductionEditor(webviewService, textFileService, fileService);
		const input = disposables.add(new ParadisHtmlFileInput(resource, textFileService, workingCopyService));

		await editor.setInput(input, undefined, Object.create(null), CancellationToken.None);

		deepStrictEqual(contentOptionsAtSetHtml, {
			allowScripts: true,
			localResourceRoots: ['file:///workspace/site'],
		});
		ok(renderedHtml);
		const document = new DOMParser().parseFromString(renderedHtml, 'text/html');
		strictEqual(document.querySelector('base')?.getAttribute('href'), PREVIEW_BASE);
		strictEqual(document.querySelector('img')?.getAttribute('src'), './assets/logo.png');
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
			const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
			const externalScript = document.querySelector('script[src]');

			strictEqual(editor.scriptsAllowed, true);
			strictEqual(csp?.getAttribute('content'), "default-src 'none'; script-src https://trusted.example");
			strictEqual(externalScript?.getAttribute('src'), 'https://trusted.example/app.js');
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
				createSharedProcessService(directory => { mounted = directory; return Promise.resolve(PREVIEW_MOUNT); }),
				workspace, createRemoteAgentService(), createRemoteAuthorityResolverService(), createTunnelService()));

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
