/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_VIEWER_SERVICE_WORKER_GRACE_MS } from '../../common/paradisViewerRecovery.js';

/**
 * `webview/browser/pre/index.html` の PARA-PATCH ブロック（service worker の制御待ち）を、
 * ファイルからソースを読み出して直接動かす。
 *
 * ここが壊れると Markdown / HTML / 画像のプレビューが「例外も出さずに白紙のまま固まる」という、
 * 最も気づきにくい壊れ方をする（実際に何度も再発している）。index.html は webview の中でしか
 * 動かないので通常のユニットテストでは触れられないが、この待ち処理は navigator.serviceWorker の
 * 形だけに依存しているので、偽の navigator を渡せば挙動そのものを検証できる。
 */

/** このテストのレイヤーでは `path` を import できないため、区切りは '/' に正規化して扱う。 */
function findRepositoryFile(relativePath: string): string | undefined {
	let directory = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/');
	if (!directory.endsWith('/')) {
		directory += '/';
	}
	for (let depth = 0; depth < 12; depth++) {
		const candidate = `${directory}${relativePath}`;
		if (existsSync(candidate)) {
			return candidate;
		}
		const parent = directory.slice(0, directory.lastIndexOf('/', directory.length - 2) + 1);
		if (parent.length === 0 || parent === directory) {
			return undefined;
		}
		directory = parent;
	}
	return undefined;
}

interface IFakeServiceWorkerContainer {
	controller: object | null;
	addEventListener(type: string, listener: () => void): void;
	removeEventListener(type: string, listener: () => void): void;
	register(path: string, options: object): Promise<object>;
}

interface IControlHarness {
	readonly waitForControl: (registration: object, swPath: string) => Promise<void>;
	readonly serviceWorker: IFakeServiceWorkerContainer;
	readonly signals: string[];
	takeControl(withEvent: boolean): void;
}

/** index.html からブロックを切り出し、偽の navigator / hostMessaging を注入して組み立てる。 */
function createHarness(source: string, initialController: object | null = null): IControlHarness {
	const listeners = new Set<() => void>();
	const signals: string[] = [];
	const serviceWorker: IFakeServiceWorkerContainer = {
		controller: initialController,
		addEventListener: (_type, listener) => { listeners.add(listener); },
		removeEventListener: (_type, listener) => { listeners.delete(listener); },
		register: async () => ({ active: {}, installing: null, waiting: null }),
	};
	const hostMessaging = { postMessage: (_channel: string, data: { code: string }) => { signals.push(data.code); } };
	const factory = new Function('navigator', 'hostMessaging', 'console', `${source}\nreturn paraWaitForServiceWorkerControl;`);
	return {
		waitForControl: factory({ serviceWorker }, hostMessaging, console),
		serviceWorker,
		signals,
		takeControl(withEvent: boolean): void {
			serviceWorker.controller = { state: 'activated' };
			if (withEvent) {
				for (const listener of [...listeners]) {
					listener();
				}
			}
		},
	};
}

suite('ParadisWebviewServiceWorkerControl', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the viewer waits out the worst-case service worker wait before calling a webview blank', function () {
		const indexHtmlPath = findRepositoryFile('src/vs/workbench/contrib/webview/browser/pre/index.html');
		if (indexHtmlPath === undefined) {
			this.skip();
		}

		const html = readFileSync(indexHtmlPath!, 'utf8');
		const timeoutMs = Number(/const PARA_SW_CONTROL_TIMEOUT_MS = (\d+);/.exec(html)?.[1]);
		// index.html は「待つ → 登録し直す → もう一度待つ」の2周なので、最悪はこの2倍＋登録のオーバーヘッド。
		// ここがホスト側の猶予を上回ると、webview が自力で復帰しかけているところを作り直してしまう。
		assert.ok(
			Number.isFinite(timeoutMs) && timeoutMs * 2 <= PARADIS_VIEWER_SERVICE_WORKER_GRACE_MS,
			`the viewer grace period (${PARADIS_VIEWER_SERVICE_WORKER_GRACE_MS}ms) must cover two service worker waits of ${timeoutMs}ms`,
		);
	});

	test('never waits forever: control is picked up, recovered by re-registering, or reported as fatal', async function () {
		const indexHtmlPath = findRepositoryFile('src/vs/workbench/contrib/webview/browser/pre/index.html');
		if (indexHtmlPath === undefined) {
			// リポジトリ外（配布物など）から実行された場合は検証対象が無い。
			this.skip();
		}

		const html = readFileSync(indexHtmlPath!, 'utf8');
		const blockStart = html.indexOf('const PARA_SW_CONTROL_TIMEOUT_MS');
		// 終端マーカーはブロックより後ろから探す。upstream が同じマーカーを前方に足しても取り違えない。
		const blockEnd = html.indexOf('/** @type {Promise<void>} */', blockStart);
		assert.ok(blockStart >= 0 && blockEnd > blockStart, 'the PARA-PATCH service worker block is still in index.html');
		// 待ち時間だけ縮める。判断のしかたはそのまま検証する。
		const source = html.slice(blockStart, blockEnd)
			.replace(/const PARA_SW_CONTROL_TIMEOUT_MS = \d+;/, 'const PARA_SW_CONTROL_TIMEOUT_MS = 120;')
			.replace(/const PARA_SW_CONTROL_POLL_MS = \d+;/, 'const PARA_SW_CONTROL_POLL_MS = 10;');

		const stillRegistered = { active: {}, installing: null, waiting: null, unregister: async () => true };

		// 1. controllerchange が飛ぶ通常経路。
		const withEvent = createHarness(source);
		const withEventDone = withEvent.waitForControl(stillRegistered, 'sw.js');
		setTimeout(() => withEvent.takeControl(true), 20);
		await withEventDone;

		// 2. イベントを取り逃しても、制御が付いていればポーリングで拾って先へ進む。
		const missedEvent = createHarness(source);
		const missedEventDone = missedEvent.waitForControl(stillRegistered, 'sw.js');
		setTimeout(() => missedEvent.takeControl(false), 20);
		await missedEventDone;

		// 3. 制御が来ないまま時間切れ → 登録し直して復帰する。
		const recovered = createHarness(source);
		await recovered.waitForControl({
			active: {}, installing: null, waiting: null,
			unregister: async () => { setTimeout(() => recovered.takeControl(true), 20); return true; },
		}, 'sw.js');

		// 4. 登録し直しても制御されない場合は、黙って白紙にせず例外にする（host 側が fatal-error として扱う）。
		const failed = createHarness(source);
		const failure = await failed.waitForControl(stillRegistered, 'sw.js').then(() => undefined, (error: Error) => error.message);

		// 5. 更新直後は「古い worker がまだ制御している」状態で呼ばれる。ここで制御の有無だけを見て
		//    先へ進むと、新しい worker が引き継ぐ前に古い worker が古いリソースを返す（upstream が
		//    この待ちで防いでいたケース）。新しい worker が来なければ待ち切って失敗させる。
		const staleController = createHarness(source, { state: 'activated' });
		const staleFailure = await staleController.waitForControl(stillRegistered, 'sw.js').then(() => undefined, (error: Error) => error.message);

		// 6. 同じ状況でも、新しい worker が引き継げばそのまま進む。
		const replacedController = createHarness(source, { state: 'activated' });
		const replacedDone = replacedController.waitForControl(stillRegistered, 'sw.js');
		setTimeout(() => replacedController.takeControl(true), 20);
		await replacedDone;

		assert.deepStrictEqual({
			withEvent: withEvent.signals,
			missedEvent: missedEvent.signals,
			recovered: recovered.signals,
			failed: failed.signals,
			failureIsReported: failure?.includes('did not take control of this webview') ?? false,
			staleControllerIsNotAccepted: staleFailure?.includes('did not take control of this webview') ?? false,
			replacedController: replacedController.signals,
		}, {
			withEvent: [],
			missedEvent: [],
			recovered: ['sw-control-timeout', 'sw-control-recovered'],
			failed: ['sw-control-timeout'],
			failureIsReported: true,
			staleControllerIsNotAccepted: true,
			replacedController: [],
		});
	});
});
