/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { createHash } from 'crypto';
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

/**
 * 準備全体（登録 → 更新 → 制御待ち → 立て直し）を偽の navigator で動かすためのハーネス。
 * `createHarness` が制御待ちだけを取り出すのに対し、こちらは「登録が決着しない」ような
 * 手前の止まり方を再現する。
 */
function createSetupHarness(source: string, behavior: {
	register: () => Promise<object>;
	initialController?: object | null;
	/**
	 * 登録の前に台帳へ既に居る registration。省略時は「まっさらな origin」＝ 無し。
	 * 登録が止まったあとの後始末は、その時点で居残っている registration を返す既定の挙動で再現する。
	 */
	existingRegistration?: object;
	/** 登録が決着した時点で controller が付く（実機では worker が claim した瞬間に相当）。 */
	controllerAfterRegister?: object;
	/** 登録を試みたあとに台帳へ居残っている registration。既定は「版を持たない残骸」。 */
	leftoverRegistration?: object;
}) {
	const signals: string[] = [];
	let registerAttempts = 0;
	const serviceWorker = {
		controller: behavior.initialController ?? null,
		addEventListener: () => { },
		removeEventListener: () => { },
		register: () => {
			registerAttempts++;
			return behavior.register().then(registration => {
				if (behavior.controllerAfterRegister) {
					serviceWorker.controller = behavior.controllerAfterRegister;
				}
				return registration;
			});
		},
		// 実機と同じ順序にする: 最初の問い合わせでは指定された既存分だけを返し、登録を試みたあとは
		// 「決着しなかった登録が残っている」状態を返す。
		getRegistration: async () => registerAttempts === 0
			? behavior.existingRegistration
			: (behavior.leftoverRegistration ?? { unregister: async () => true }),
	};
	const hostMessaging = { postMessage: (_channel: string, data: { code: string }) => { signals.push(data.code); } };
	// 立て直しの経緯は console に残す作りなので、テスト出力を汚さないよう捨てる。
	const quietConsole = { error: () => { }, debug: () => { }, log: () => { } };
	const factory = new Function('navigator', 'hostMessaging', 'console', `${source}\nreturn paraEstablishServiceWorker;`);
	return {
		establish: factory({ serviceWorker }, hostMessaging, quietConsole) as (swPath: string) => Promise<boolean>,
		signals,
	};
}

suite('ParadisWebviewServiceWorkerControl', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * index.html の CSP は、同じファイルに埋め込まれたインラインスクリプトの sha256 を許可リストに
	 * 持つ（`script-src 'sha256-…' 'self'` の 'self' は外部スクリプト用で、インラインは通さない）。
	 *
	 * この fork はそのスクリプトを PARA-PATCH で書き換えているため、ハッシュを更新し忘れると
	 * **全 webview のスクリプトが CSP で黙って落とされる**。例外も出ず、webview は真っ白のまま
	 * 固まるだけなので、実際に paracode-80 で混入した。ここで機械的に突き合わせる。
	 */
	test('the CSP hash in index.html matches the inline script it ships', function () {
		const indexHtmlPath = findRepositoryFile('src/vs/workbench/contrib/webview/browser/pre/index.html');
		if (indexHtmlPath === undefined) {
			this.skip();
		}

		// 改行を LF に寄せる。`.gitattributes` の `text=auto` により Windows のチェックアウトは CRLF に
		// なるが、HTML パーサは入力ストリームの前処理で CRLF を LF に潰してからスクリプトを取り出す
		// ため、ブラウザが実際にハッシュ化するのは常に LF 版。生バイトのまま数えると Windows でだけ落ちる。
		const html = readFileSync(indexHtmlPath!, 'utf8').replace(/\r\n/g, '\n');
		const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);
		const declared = /script-src '(sha256-[^']+)'/.exec(html)?.[1];
		// ハッシュは1つしか宣言していないので、インラインスクリプトが増えた時点で前提が崩れる。
		assert.strictEqual(scripts.length, 1, 'index.html still ships exactly one inline script');
		assert.ok(declared, 'index.html still declares an inline script hash in its Content-Security-Policy');
		assert.strictEqual(
			`sha256-${createHash('sha256').update(scripts[0], 'utf8').digest('base64')}`,
			declared,
			'the Content-Security-Policy hash in index.html must be recomputed whenever its inline script changes',
		);
	});

	test('the viewer waits out the worst-case service worker wait before calling a webview blank', function () {
		const indexHtmlPath = findRepositoryFile('src/vs/workbench/contrib/webview/browser/pre/index.html');
		if (indexHtmlPath === undefined) {
			this.skip();
		}

		const html = readFileSync(indexHtmlPath!, 'utf8');
		const controlTimeoutMs = Number(/const PARA_SW_CONTROL_TIMEOUT_MS = (\d+);/.exec(html)?.[1]);
		const budgetMs = Number(/const PARA_SW_SETUP_BUDGET_MS = (\d+);/.exec(html)?.[1]);
		// webview 側は準備全体をこの予算で打ち切り、超えたら service worker 無しで描画へ進む。
		// つまり「白紙のまま待たされる」上限は予算そのもの。ホスト側の猶予がこれを下回ると、
		// webview が自力で描画へ倒れる前に作り直してしまい、復帰の芽を潰す。
		assert.ok(
			Number.isFinite(budgetMs) && budgetMs <= PARADIS_VIEWER_SERVICE_WORKER_GRACE_MS,
			`the viewer grace period (${PARADIS_VIEWER_SERVICE_WORKER_GRACE_MS}ms) must cover the webview's service worker setup budget of ${budgetMs}ms`,
		);
		// 予算は制御待ち2周（待つ → 登録し直す → もう一度待つ）を収められる必要がある。
		// 下回ると、復帰処理が最後まで走りきる前に必ず予算切れになる。
		assert.ok(
			Number.isFinite(controlTimeoutMs) && controlTimeoutMs * 2 <= budgetMs,
			`the setup budget (${budgetMs}ms) must cover two service worker control waits of ${controlTimeoutMs}ms`,
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

	/**
	 * `navigator.serviceWorker.register()` が resolve も reject もしないまま止まることが実機である。
	 * 制御待ちの立て直し（上のテスト）は登録が決着した後にしか動けないので、この止まり方には届かない。
	 * 登録が決着しないときでも **必ず有限時間で描画へ進む**（例外を投げず、service worker 無しに倒れる）
	 * ことがこの fork の要。ここが崩れると webview は何も出さないまま固まる。
	 */
	test('the recovery path fits inside the setup budget instead of being cut off by it', function () {
		const indexHtmlPath = findRepositoryFile('src/vs/workbench/contrib/webview/browser/pre/index.html');
		if (indexHtmlPath === undefined) {
			this.skip();
		}
		const html = readFileSync(indexHtmlPath!, 'utf8');
		const read = (name: string): number => {
			const match = new RegExp(`const ${name} = (\\d+);`).exec(html);
			assert.ok(match, `${name} is still declared in index.html`);
			return Number.parseInt(match![1], 10);
		};
		const probe = read('PARA_SW_PROBE_TIMEOUT_MS');
		const register = read('PARA_SW_REGISTER_TIMEOUT_MS');
		const budget = read('PARA_SW_SETUP_BUDGET_MS');

		// 止まった登録を立て直す最悪経路: 事前の版なし判定 → 登録(期限切れ) → 後始末2回 → 登録し直し。
		// これが予算を超えていると、唯一の救済経路が必ず途中で打ち切られる（実際に起きていた）。
		const confirm = read('PARA_SW_VERSIONLESS_CONFIRM_MS');
		// discard(getRegistration + 確認待ち + getRegistration + unregister) → 登録(期限切れ)
		//   → 後始末(getRegistration + unregister) → 登録し直し
		const worstCaseRecovery = (probe + confirm + probe + probe) + register + (probe + probe) + register;
		assert.ok(
			worstCaseRecovery <= budget,
			`the recovery path (${worstCaseRecovery}ms) must fit inside PARA_SW_SETUP_BUDGET_MS (${budget}ms)`);
	});

	test('a registration that never settles still lets rendering proceed', async function () {
		const indexHtmlPath = findRepositoryFile('src/vs/workbench/contrib/webview/browser/pre/index.html');
		if (indexHtmlPath === undefined) {
			this.skip();
		}

		const html = readFileSync(indexHtmlPath!, 'utf8');
		const blockStart = html.indexOf('const PARA_SW_CONTROL_TIMEOUT_MS');
		const blockEnd = html.indexOf('/** @type {Promise<void>} */', blockStart);
		assert.ok(blockStart >= 0 && blockEnd > blockStart, 'the PARA-PATCH service worker block is still in index.html');
		// 待ち時間だけ縮める。判断のしかたはそのまま検証する。
		const source = html.slice(blockStart, blockEnd)
			.replace(/const PARA_SW_CONTROL_TIMEOUT_MS = \d+;/, 'const PARA_SW_CONTROL_TIMEOUT_MS = 120;')
			.replace(/const PARA_SW_CONTROL_POLL_MS = \d+;/, 'const PARA_SW_CONTROL_POLL_MS = 10;')
			.replace(/const PARA_SW_REGISTER_TIMEOUT_MS = \d+;/, 'const PARA_SW_REGISTER_TIMEOUT_MS = 120;')
			.replace(/const PARA_SW_PROBE_TIMEOUT_MS = \d+;/, 'const PARA_SW_PROBE_TIMEOUT_MS = 60;')
			.replace(/const PARA_SW_VERSIONLESS_CONFIRM_MS = \d+;/, 'const PARA_SW_VERSIONLESS_CONFIRM_MS = 10;');

		const settled = { active: {}, installing: null, waiting: null, update() { return Promise.resolve(this); } };

		// 1. 登録が最後まで決着しない: 立て直しても駄目なら service worker を諦めて描画へ進む。
		const neverSettles = createSetupHarness(source, { register: () => new Promise(() => { }) });
		const neverSettlesResult = await neverSettles.establish('sw.js');

		// 2. 一度止まっても、入れ直して決着すれば service worker ありのまま進む。
		let attempts = 0;
		const recovers = createSetupHarness(source, {
			register: () => { attempts++; return attempts === 1 ? new Promise(() => { }) : Promise.resolve(settled); },
			initialController: { state: 'activated' },
		});
		const recoversResult = await recovers.establish('sw.js');

		// 3. 普通に決着する場合は余計な信号を出さない。
		const healthy = createSetupHarness(source, {
			register: async () => settled,
			initialController: { state: 'activated' },
		});
		const healthyResult = await healthy.establish('sw.js');

		// 4. はっきり断られた場合は握り潰さない。原因が環境設定にあるので、黙って service worker 無しへ
		//    倒すと直し方が分からなくなる（Web のサードパーティ Cookie 案内はこの経路に載っている）。
		const denied = createSetupHarness(source, {
			register: () => Promise.reject(new Error('user denied permission to use Service Worker')),
		});
		const deniedError = await denied.establish('sw.js').then(() => undefined, (error: Error) => error.message);

		// 5. 版を1つも持たない registration が居座っているケース（実機で計測した壊れ方）。
		//    そのまま登録しても直らず、期限切れを待つ分だけ白紙が延びるので、登録の前に捨てる。
		let versionlessUnregistered = false;
		const versionless = createSetupHarness(source, {
			register: async () => settled,
			// 壊れた registration が居るときは controller が付いていない。付いていれば active な
			// worker が居る証拠なので、そもそも捨てる判定に入らない（ショートサーキット）。
			controllerAfterRegister: { state: 'activated' },
			existingRegistration: {
				installing: null, waiting: null, active: null,
				unregister: async () => { versionlessUnregistered = true; return true; },
			},
		});
		const versionlessResult = await versionless.establish('sw.js');

		// 6. 版を持つ registration は使用中なので、間違っても捨ててはいけない。
		let healthyExistingUnregistered = false;
		const keepsHealthy = createSetupHarness(source, {
			register: async () => settled,
			controllerAfterRegister: { state: 'activated' },
			existingRegistration: {
				installing: null, waiting: null, active: {},
				unregister: async () => { healthyExistingUnregistered = true; return true; },
			},
		});
		const keepsHealthyResult = await keepsHealthy.establish('sw.js');

		// 7. 登録が詰まったあとの後始末は、台帳に居るのが「使われている registration」なら消してはいけない。
		//    この scope は兄弟 webview と共有されるので、消すと相手の worker を奪う。
		//    自分の詰まった登録がこの形になることは無い（register() は installing を立てて解決するため、
		//    版を持つレコードは必ず他者のもの）。
		let siblingUnregistered = false;
		const keepsSibling = createSetupHarness(source, {
			register: () => new Promise(() => { }),
			leftoverRegistration: {
				installing: null, waiting: null, active: {},
				unregister: async () => { siblingUnregistered = true; return true; },
			},
		});
		const keepsSiblingResult = await keepsSibling.establish('sw.js');

		assert.deepStrictEqual({
			neverSettles: { usedServiceWorker: neverSettlesResult, signals: neverSettles.signals },
			recovers: { usedServiceWorker: recoversResult, signals: recovers.signals },
			healthy: { usedServiceWorker: healthyResult, signals: healthy.signals },
			denied: { surfacedReason: deniedError?.includes('user denied permission') ?? false, signals: denied.signals },
			versionless: { usedServiceWorker: versionlessResult, signals: versionless.signals, discarded: versionlessUnregistered },
			keepsHealthy: { usedServiceWorker: keepsHealthyResult, signals: keepsHealthy.signals, discarded: healthyExistingUnregistered },
			keepsSibling: { usedServiceWorker: keepsSiblingResult, signals: keepsSibling.signals, unregistered: siblingUnregistered },
		}, {
			neverSettles: { usedServiceWorker: false, signals: ['sw-register-timeout', 'sw-unavailable'] },
			recovers: { usedServiceWorker: true, signals: ['sw-register-timeout', 'sw-register-recovered'] },
			healthy: { usedServiceWorker: true, signals: [] },
			denied: { surfacedReason: true, signals: [] },
			versionless: { usedServiceWorker: true, signals: ['sw-versionless-registration-discarded'], discarded: true },
			keepsHealthy: { usedServiceWorker: true, signals: [], discarded: false },
			keepsSibling: { usedServiceWorker: false, signals: ['sw-register-timeout', 'sw-unavailable'], unregistered: false },
		});
	});
});
