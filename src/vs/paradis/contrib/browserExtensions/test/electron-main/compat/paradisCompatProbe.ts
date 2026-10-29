/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの Chrome 拡張機能（試験的）の互換性の自動確認（設計書の 10-1）。Electron の main として動かし、
// 拡張機能の管理（paradisBrowserExtensionsMain）をそのまま使って、次を拡張機能ごとに記録する:
//  - Chrome ウェブストアから入れられるか（ストアの署名の確かめを含む）と、Electron に読み込めるか
//  - service worker が動き出すか、worker の console に出たエラー
//  - 手元の試験用のページ（ログインの欄・JSON を含む）で、content script の文脈ができるか
//  - ポップアップ（action.default_popup）とオプションのページが開くか、そこでのエラー、宣言した権限の chrome.* があるか
//  - DevTools のページを持つか（パネルが出るかは手で見る）
// 外と話すのは、一覧の拡張機能をストアから落とすときだけ（試験用のページは 127.0.0.1）。
//
// 使い方（リポジトリの直下で、`npm run build-fast -- --client-only` で out を作った後に）。Electron の入り口にするため、
// 一時のフォルダに package.json（{"type":"module","main":"main.mjs"}）と、out のこのファイルを import する main.mjs を置く:
//   echo '{"type":"module","main":"main.mjs"}' > /tmp/compat-app/package.json
//   echo "import '$PWD/out/vs/paradis/contrib/browserExtensions/test/electron-main/compat/paradisCompatProbe.js';" > /tmp/compat-app/main.mjs
//   HOME=/tmp/compat-home PARADIS_COMPAT_RUN=1 PARADIS_COMPAT_RESULT=/tmp/compat.json \
//     xvfb-run -a -s "-screen 0 1400x1000x24" .build/electron/<Electron の実行ファイル> --no-sandbox /tmp/compat-app
//   node --experimental-strip-types src/vs/paradis/contrib/browserExtensions/test/electron-main/compat/paradisCompatReport.ts /tmp/compat.json browser-extensions-compat.html
// HOME は一時のフォルダに替えて動かす（userData は PARADIS_COMPAT_ROOT の下に作る）。PARADIS_COMPAT_IDS=<id>,<id> で一部だけ試せる。
// PARADIS_COMPAT_RUN=1 のときだけ動く（ほかから読まれても何もしない）。

import { app, BrowserWindow, protocol, session, type WebContents } from 'electron';
import { promises as fs } from 'fs';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { join } from '../../../../../../base/common/path.js';
import { BrowserViewStorageScope } from '../../../../../../platform/browserView/common/browserView.js';
import { IParadisAddExtensionResult } from '../../../common/paradisBrowserExtensions.js';
import { IParadisBrowserExtensionTabsOptions, ParadisBrowserExtensionsManager, ParadisExtensionSession } from '../../../electron-main/paradisBrowserExtensionsMain.js';
import { paradisListenForBrowserExtensionWindowQueries } from '../../../electron-main/paradisBrowserExtensionWindows.js';

/** 1 つの拡張機能の結果（paradisCompatReport.ts が読む）。 */
export interface IParadisCompatResult {
	category: string;
	label: string;
	id: string;
	install?: string;
	installMs?: number;
	name?: string;
	version?: string;
	manifestVersion?: number;
	permissions?: string[];
	loaded?: boolean;
	loadError?: string;
	pagesWithoutApis?: readonly string[];
	worker?: string;
	contentScript?: string;
	contentScriptForTestPage?: boolean;
	urlOverrides?: string[];
	injected?: number;
	devtoolsPage?: boolean;
	sidePanel?: boolean;
	popup?: string;
	options?: string;
	popupElements?: number;
	optionsElements?: number;
	popupErrors?: string[];
	optionsErrors?: string[];
	missingApis?: string[];
	missingApisFrom?: string;
	workerErrors?: string[];
}

type Manifest = Record<string, unknown> & {
	manifest_version?: number;
	permissions?: unknown[];
	optional_permissions?: unknown[];
	background?: { service_worker?: string };
	content_scripts?: { matches?: unknown }[];
	chrome_url_overrides?: Record<string, string>;
	action?: { default_popup?: string };
	browser_action?: { default_popup?: string };
	options_ui?: { page?: string };
	options_page?: string;
	devtools_page?: unknown;
	side_panel?: { default_path?: unknown };
};

/** 設計書の 10-1 の 31 個（区分、名前、ストアの id、自動で見ること）。 */
export const PARADIS_COMPAT_EXTENSIONS: readonly (readonly [string, string, string])[] = [
	['パスワード管理', '1Password', 'aeblfdkhhhdcdjpifhhbdiojplfjncoa'],
	['パスワード管理', 'Bitwarden', 'nngceckbapebfimnlniiiahkandclblb'],
	['パスワード管理', 'Dashlane', 'fdjamakpfbbddfjaooikfcpapjohcfmg'],
	['パスワード管理', 'Keeper', 'bfogiafebfohielmmehodmfbbebbbpei'],
	['パスワード管理', 'NordPass', 'eiaeiblijfjekdanodkjadfinkhbfgcd'],
	['パスワード管理', 'Proton Pass', 'ghmbeldphafepmbegfdlkpapadhbakde'],
	['開発', 'React Developer Tools', 'fmkadmapgofadopljbjfkapdkoienihi'],
	['開発', 'Redux DevTools', 'lmhkpmbekcpmknklioeibfkpmmfibljd'],
	['開発', 'Vue.js devtools', 'nhdogjmejiglipccpnnnanhbledajbpd'],
	['開発', 'Angular DevTools', 'ienfalfjdbdpebioblfackkekamfmbnh'],
	['開発', 'Svelte DevTools', 'kfidecgcdjjfpeckbblhmfkhmlgecoff'],
	['開発', 'Lighthouse', 'blipmdconlkpinefehnmjammfjpmpbjk'],
	['開発', 'Wappalyzer', 'gppongmhjkpfnbhagpmjfkannfbllamg'],
	// 設計書の案の JSON Viewer（gbmdgpbipfallnflgajpaliibnhdgobh）は、2026-10-30 にストアに無かったので、同じ用途の JSON Formatter で見る
	['開発', 'JSON Formatter', 'bcjindcccaagfpapjjmafapmmgkkhgoa'],
	['見た目・読みやすさ', 'Dark Reader', 'eimadpbcbfnmbkopoojfekhnkhdbieeh'],
	['見た目・読みやすさ', 'Stylus', 'clngdbkpkpeebahjckkjfobafhncgmne'],
	['見た目・読みやすさ', 'Refined GitHub', 'hlepfoohegkhhmjieoechaddaejaokhf'],
	['見た目・読みやすさ', 'OctoTree', 'bkhaagjahfmjljalopjnoealnfndnagc'],
	// Mercury Reader は 2026-10-30 にストアに無かった（公開が終わっている）。入れられないことを記録する
	['見た目・読みやすさ', 'Mercury Reader', 'oknpjjbmpnndlpmnhmekjpocelpnlfdi'],
	['翻訳・文章', 'Google 翻訳', 'aapbdbdomjkkjkaonfhkkikfgjllcleb'],
	['翻訳・文章', 'DeepL', 'cofdbpoegempjloogbagkncekinflcnj'],
	['翻訳・文章', 'Grammarly', 'kbfnbcaeplbcioakkpcpgfkobkghlhen'],
	['翻訳・文章', 'LanguageTool', 'oldceeleldhonbafppcapldpdifcinji'],
	['広告・プライバシー', 'uBlock Origin Lite', 'ddkjiahejlhfcafbddmgiahcphecmpfh'],
	['広告・プライバシー', 'AdGuard', 'bgnkhhnnamicmpeenaelnjfhikgbkllg'],
	['広告・プライバシー', 'Privacy Badger', 'pkehgijcmpdhfbdbbnkijodmdjhbjlgp'],
	['広告・プライバシー', 'Ghostery', 'mlomiejdfkolichcflejclcbmpeaniij'],
	['Orca で不可だったもの', 'Tampermonkey', 'dhdgffkkebhmkfjojejmpbldmpobfkfo'],
	['Orca で不可だったもの', 'Loom', 'liecbddmkiiihnedobmlmillhodjkdmb'],
	['Orca で不可だったもの', 'Momentum', 'laookkfknpbbblfpciffpaejjkokdgca'],
	['その他', 'Google Keep', 'lpcaedmchfhocbbapmcbpinfpgnhiddi'],
];

/** 権限 → それで使えるはずの chrome の名前空間（権限だけのもの・名前空間の無いものは書かない）。 */
const PERMISSION_NAMESPACES: Record<string, string | undefined> = {
	storage: 'storage', unlimitedStorage: undefined, tabs: 'tabs', activeTab: undefined, contextMenus: 'contextMenus', menus: 'contextMenus', notifications: 'notifications',
	alarms: 'alarms', scripting: 'scripting', webNavigation: 'webNavigation', webRequest: 'webRequest', webRequestBlocking: 'webRequest', webRequestAuthProvider: 'webRequest',
	declarativeNetRequest: 'declarativeNetRequest', declarativeNetRequestWithHostAccess: 'declarativeNetRequest', declarativeNetRequestFeedback: 'declarativeNetRequest',
	cookies: 'cookies', downloads: 'downloads', management: 'management', idle: 'idle', offscreen: 'offscreen', sidePanel: 'sidePanel', identity: 'identity', privacy: 'privacy',
	proxy: 'proxy', history: 'history', bookmarks: 'bookmarks', tabGroups: 'tabGroups', userScripts: 'userScripts', fontSettings: 'fontSettings', search: 'search', topSites: 'topSites',
	sessions: 'sessions', debugger: 'debugger', tts: 'tts', ttsEngine: 'ttsEngine', contentSettings: 'contentSettings', browsingData: 'browsingData', permissions: 'permissions',
	nativeMessaging: 'runtime.connectNative', commands: 'commands', windows: 'windows', gcm: 'gcm', power: 'power', readingList: 'readingList', webAuthenticationProxy: 'webAuthenticationProxy',
	'system.display': 'system.display', 'system.cpu': 'system.cpu', 'system.memory': 'system.memory', 'system.storage': 'system.storage', tabCapture: 'tabCapture', desktopCapture: 'desktopCapture',
	pageCapture: 'pageCapture', geolocation: undefined, clipboardRead: undefined, clipboardWrite: undefined, background: undefined, favicon: undefined, contextualIdentities: undefined,
};

/** Para Code が詰め物（paradisBrowserExtensionShim.ts）で足す名前空間（manifest.json の文書では数えない）。 */
const SHIM_NAMESPACES = new Set(['storage', 'tabs', 'windows', 'webNavigation', 'contextMenus', 'commands', 'notifications', 'permissions', 'downloads', 'cookies', 'management', 'identity', 'debugger', 'privacy', 'fontSettings', 'runtime.connectNative']);

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Para Code extension compatibility page</title></head><body>
<h1>Sign in</h1><form action="/signin" method="post"><label>Email <input type="email" name="email" autocomplete="username"></label>
<label>Password <input type="password" name="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>
<article><h2>Article</h2><p>${'Para Code checks browser extensions on this page. '.repeat(40)}</p><textarea name="note">This is a sentence to check.</textarea></article>
<a href="/data.json">data</a></body></html>`;

function wait(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function run(resultPath: string, root: string): Promise<void> {
	paradisListenForBrowserExtensionWindowQueries();
	const http = await import('http');
	await fs.rm(root, { recursive: true, force: true });
	const server = http.createServer((request, response) => {
		if (request.url === '/data.json') {
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify({ name: 'Para Code', items: [1, 2, 3], nested: { ok: true } }));
			return;
		}
		response.setHeader('content-type', 'text/html; charset=utf-8');
		response.end(PAGE);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
	const ses = session.fromPartition('persist:paradis-compat');
	const tab = new BrowserWindow({ show: true, width: 1200, height: 860, webPreferences: { session: ses, sandbox: true } });
	interface IView { id: string; webContents: WebContents; windowId: number; isAgentTab(): boolean; isVisible(): boolean; onDidClose: Event<void>; onDidChangeVisibility: Event<boolean> }
	const created = new Emitter<{ view: IView; existing: boolean }>();
	const opened: BrowserWindow[] = [];
	const views: IView[] = [{ id: 'compat', webContents: tab.webContents, windowId: tab.id, isAgentTab: () => false, isVisible: () => true, onDidClose: Event.None, onDidChangeVisibility: Event.None }];
	const environmentObject = {
		listViews: () => views, onDidCreateView: created.event, listWindows: () => [tab], lastActiveWindowId: () => tab.id,
		// 拡張機能がタブを開いたら、見えない窓で開いてタブとして数える（試験用。開いた窓は拡張機能ごとに閉じる）
		createTab: async (url: string) => {
			const extra = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { session: ses, sandbox: true } });
			const view = { id: `compat-${views.length}`, webContents: extra.webContents, windowId: tab.id, isAgentTab: () => false, isVisible: () => false, onDidClose: Event.None, onDidChangeVisibility: Event.None };
			views.push(view);
			created.fire({ view, existing: false });
			opened.push(extra);
			void extra.loadURL(url ?? 'about:blank').catch(() => { });
			return view;
		}, closeTab: async () => { }, activateTab: () => { },
		onDidFocusWindow: Event.fromNodeEventEmitter(app, 'browser-window-focus', (_event: unknown, window: BrowserWindow) => window.id),
	};
	const environment = environmentObject as unknown as IParadisBrowserExtensionTabsOptions['environment'];
	const quiet = { warn: () => { } };
	const manager = new ParadisBrowserExtensionsManager(join(root, 'manager'), () => true, quiet, () => undefined, { environment, createPopout: () => { throw new Error('not in the compatibility check'); } }, { askInstall: async () => true, askRemove: async () => true });
	await manager.attach(ses as unknown as ParadisExtensionSession, { id: 'global', storageScope: BrowserViewStorageScope.Global });
	created.fire({ view: views[0], existing: true });
	// worker の console（拡張機能ごとに分ける）
	const workerConsole = new Map<string, string[]>();
	(ses.serviceWorkers as unknown as { on(event: 'console-message', listener: (event: unknown, details: { sourceUrl?: string; level: unknown; message: unknown }) => void): void }).on('console-message', (_event, details) => {
		const match = /^chrome-extension:\/\/(?<id>[a-p]{32})\//.exec(details.sourceUrl ?? '');
		if (match?.groups && ((details.level as unknown) === 3 || (details.level as unknown) === 'error')) {
			const list = workerConsole.get(match.groups.id) ?? [];
			list.push(String(details.message).slice(0, 300));
			workerConsole.set(match.groups.id, list);
		}
	});
	// content script の文脈（isolated world の名前と origin）
	// 何も読み込んでいない窓では Runtime.enable が答えないので、先に試験用のページを開く
	await tab.loadURL(pageUrl);
	const dbg = tab.webContents.debugger;
	dbg.attach('1.3');
	let contexts: { origin: string; name: string; type?: string }[] = [];
	dbg.on('message', (_event, method, params) => {
		if (method === 'Runtime.executionContextCreated') {
			contexts.push({ origin: params.context.origin, name: params.context.name, type: params.context.auxData?.type });
		}
	});
	await dbg.sendCommand('Runtime.enable');
	console.log(`[compat] ready: Electron ${process.versions.electron}, test page ${pageUrl}`);

	const only = process.env.PARADIS_COMPAT_IDS ? new Set(process.env.PARADIS_COMPAT_IDS.split(',')) : undefined;
	const results: IParadisCompatResult[] = [];
	for (const [category, label, id] of PARADIS_COMPAT_EXTENSIONS) {
		if (only && !only.has(id)) {
			continue;
		}
		const result: IParadisCompatResult = { category, label, id };
		results.push(result);
		const started = Date.now();
		console.log(`[compat] ${label}: installing`);
		const added: IParadisAddExtensionResult = await manager.addFromWebStore(id, 'default', 'compat').catch(error => ({ ok: false, reason: 'failed', detail: String(error) }));
		result.install = added.ok ? 'ok' : `${added.reason}${added.detail ? `: ${added.detail}` : ''}`;
		result.installMs = Date.now() - started;
		if (!added.ok) {
			continue;
		}
		result.name = added.extension.name;
		result.version = added.extension.version;
		const manifest: Manifest = JSON.parse(await fs.readFile(join(added.extension.path, 'paracode-original-manifest.json'), 'utf8').catch(() => fs.readFile(join(added.extension.path, 'manifest.json'), 'utf8')));
		result.manifestVersion = manifest.manifest_version;
		result.permissions = [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? []).map(permission => `${String(permission)}?`)].filter((permission): permission is string => typeof permission === 'string' && !permission.includes('://') && permission !== '<all_urls>');
		const permissions = result.permissions;
		await wait(1500);
		const state = (await manager.getState()).extensions.find(extension => extension.id === id);
		result.loaded = Boolean(ses.extensions.getExtension(id));
		result.loadError = state?.loadError;
		result.pagesWithoutApis = state?.pagesWithoutApis;
		// service worker
		if (manifest.background?.service_worker) {
			let running = false;
			for (let attempt = 0; attempt < 10 && !running; attempt++) {
				running = Object.values(ses.serviceWorkers.getAllRunning()).some(worker => worker.scope === `chrome-extension://${id}/`);
				if (!running) {
					await ses.serviceWorkers.startWorkerForScope(`chrome-extension://${id}/`).then(() => { running = true; }, () => wait(500));
				}
			}
			result.worker = running ? 'running' : 'not running';
		} else {
			result.worker = manifest.background ? 'background page (MV2)' : 'none';
		}
		// content script
		const declaresContentScripts = Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0;
		// 試験用のページ（http://127.0.0.1）に当たる content script があるか（GitHub だけのものなどは、ここでは動かないのが正しい）
		const matches = (manifest.content_scripts ?? []).flatMap(entry => Array.isArray(entry?.matches) ? entry.matches as unknown[] : []);
		result.contentScriptForTestPage = matches.some(pattern => typeof pattern === 'string' && ['<all_urls>', '*://*/*', 'http://*/*', 'http://127.0.0.1/*', '*://127.0.0.1/*'].includes(pattern));
		result.urlOverrides = Object.keys(manifest.chrome_url_overrides ?? {});
		contexts = [];
		await tab.loadURL(pageUrl).catch(() => { });
		await wait(4000);
		const ownContexts = contexts.filter(context => context.origin === `chrome-extension://${id}`);
		result.contentScript = declaresContentScripts ? (ownContexts.length > 0 ? 'ran' : 'did not run') : 'none';
		result.injected = await tab.webContents.executeJavaScript(`[...document.querySelectorAll('body > *:not(h1):not(form):not(article):not(a)'), ...document.querySelectorAll('[class*="${label.split(' ')[0].toLowerCase()}" i]')].length`).catch(() => undefined);
		// ポップアップ・オプションのページ・API
		const popupPath = manifest.action?.default_popup ?? manifest.browser_action?.default_popup;
		const optionsPath = manifest.options_ui?.page ?? manifest.options_page;
		result.devtoolsPage = typeof manifest.devtools_page === 'string';
		result.sidePanel = typeof manifest.side_panel?.default_path === 'string';
		for (const [kind, path] of [['popup', popupPath], ['options', optionsPath]] as const) {
			if (typeof path !== 'string') {
				result[kind] = 'none';
				continue;
			}
			const page = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { session: ses, sandbox: true } });
			const errors: string[] = [];
			// Electron 43: 1 つ目の引数（event）が level（'error' など）と message を持つ
			page.webContents.on('console-message', event => {
				const details = event as unknown as { level?: unknown; message?: unknown };
				if (details.level === 'error') {
					errors.push(String(details.message).slice(0, 300));
				}
			});
			let failed: string | undefined;
			page.webContents.on('did-fail-load', (_event, code, description) => { failed = `${code} ${description}`; });
			let crashed = false;
			page.webContents.on('render-process-gone', () => { crashed = true; });
			await page.loadURL(`chrome-extension://${id}/${path.replace(/^\/+/, '')}`).catch(error => { failed ??= String(error); });
			await wait(3000);
			const view: { elements: number; text: number; missing: string[] } | undefined = crashed || page.isDestroyed() ? undefined : await page.webContents.executeJavaScript(`(() => {
				const missing = ${JSON.stringify(permissions.map(permission => permission.replace(/\?$/, '')).map(permission => PERMISSION_NAMESPACES[permission]).filter(Boolean))}
					.filter((name, index, all) => all.indexOf(name) === index)
					.filter(name => name.split('.').reduce((target, key) => target && target[key], globalThis.chrome) === undefined);
				return { elements: document.querySelectorAll('body *').length, text: (document.body && document.body.innerText || '').trim().length, missing };
			})()`).catch(() => undefined);
			result[kind] = failed ? `failed (${failed})` : crashed ? 'crashed' : view ? (view.elements > 0 ? 'rendered' : 'empty') : 'unreadable';
			if (kind === 'popup') {
				result.popupElements = view?.elements;
				result.popupErrors = errors.slice(0, 5);
			} else {
				result.optionsElements = view?.elements;
				result.optionsErrors = errors.slice(0, 5);
			}
			if (view && !result.missingApis) {
				result.missingApis = view.missing;
			}
			page.destroy();
		}
		if (!result.missingApis) {
			// ポップアップもオプションのページも読めなかった: 拡張機能の origin の文書（manifest.json）で、Electron が元から持つ API を見る。
			// そこには詰め物が入らないので、Para Code が詰め物で足す名前空間は数えない
			const page = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true } });
			await page.loadURL(`chrome-extension://${id}/manifest.json`).catch(() => { });
			const wanted = permissions.map(permission => PERMISSION_NAMESPACES[permission.replace(/\?$/, '')]).filter((name): name is string => name !== undefined && !SHIM_NAMESPACES.has(name));
			result.missingApis = await page.webContents.executeJavaScript(`${JSON.stringify([...new Set(wanted)])}.filter(name => name.split('.').reduce((target, key) => target && target[key], globalThis.chrome) === undefined)`).catch(() => undefined);
			result.missingApisFrom = 'manifest.json';
			page.destroy();
		}
		result.workerErrors = (workerConsole.get(id) ?? []).slice(0, 5);
		await manager.remove(id);
		for (const extra of opened.splice(0)) {
			if (!extra.isDestroyed()) {
				extra.destroy();
			}
		}
		views.splice(1);
		await fs.writeFile(resultPath, JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, checkedAt: new Date().toISOString(), results }, undefined, '\t'));
		console.log(`[compat] ${label}: install=${result.install} worker=${result.worker} content=${result.contentScript} popup=${result.popup} missing=${(result.missingApis ?? []).join(',')}`);
	}
	await fs.writeFile(resultPath, JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, checkedAt: new Date().toISOString(), results }, undefined, '\t'));
	manager.dispose();
	server.close();
	app.quit();
}

if (process.env.PARADIS_COMPAT_RUN === '1') {
	const root = process.env.PARADIS_COMPAT_ROOT ?? join(tmpdir(), 'paradis-browser-extensions-compat');
	app.on('window-all-closed', () => { });
	protocol.registerSchemesAsPrivileged([{ scheme: 'paracode-extension-api', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, allowServiceWorkers: true } }]);
	app.setPath('userData', join(root, 'user-data'));
	// FileAccess が out の中のファイル（ストアのページの preload）を探す根（このファイルは out/vs/paradis/contrib/browserExtensions/test/electron-main/compat）
	(globalThis as { _VSCODE_FILE_ROOT?: string })._VSCODE_FILE_ROOT = fileURLToPath(new URL('../../../../../../../', import.meta.url));
	void app.whenReady().then(() => run(process.env.PARADIS_COMPAT_RESULT ?? join(tmpdir(), 'paradis-browser-extensions-compat.json'), root));
}
