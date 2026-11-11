/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 本物の worker を短いしきい値で動かす。配布版と同じ文字列の worker を使うので、開発版の
// Node でも配布版の Electron でも同じ経路を通る（Node の組み込みしか使わないため）。

import * as assert from 'assert';
import { existsSync, readFileSync, watch, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisMainHangRecovery, ParadisMainHangWatchdog, paradisMainHangExtra, paradisTakeMainHangMarker } from '../../node/paradisMainHangWatchdog.js';

function blockFor(ms: number): void {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		// 本体を固める
	}
}

/**
 * 置き場所のファイルが変わるたびに確かめ、条件を満たしたら解決する。CI の負荷で worker の起動や
 * 書き込みが遅れても、決まった時間で打ち切らずに済むようにする（待ちの上限はテストの timeout）。
 */
function whenFiles(dir: string, condition: () => boolean): Promise<void> {
	return new Promise<void>(resolve => {
		const watcher = watch(dir, () => {
			if (condition()) {
				watcher.close();
				resolve();
			}
		});
		if (condition()) {
			watcher.close();
			resolve();
		}
	});
}

/** 印が読める形で置かれているか。消さずに読む（`paradisTakeMainHangMarker` は読むと消す）。 */
function markerReadable(markerPath: string): boolean {
	try {
		JSON.parse(readFileSync(markerPath, 'utf8'));
		return true;
	} catch {
		return false;
	}
}

suite('ParadisMainHangWatchdog', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let dir: string;

	setup(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), 'paradis-hang-'));
	});

	teardown(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	function start(markerPath: string, recoveries: IParadisMainHangRecovery[], heartbeatMs: number = 20, recovered?: DeferredPromise<void>): ParadisMainHangWatchdog {
		return store.add(new ParadisMainHangWatchdog({
			markerPath,
			hangMs: 200,
			heartbeatMs,
			pollMs: 20,
			sleepGapMs: 5_000,
			markerUpdateMs: 50,
			maxPauseMs: 400,
			onRecovered: recovery => {
				recoveries.push(recovery);
				recovered?.complete();
			},
		}));
	}

	test('a blocked main thread is reported once it comes back, with the heap it had, and the marker is removed', async function () {
		this.timeout(10_000);
		const markerPath = join(dir, 'hang.json');
		const recoveries: IParadisMainHangRecovery[] = [];
		const recovered = new DeferredPromise<void>();
		const watchdog = start(markerPath, recoveries, undefined, recovered);
		await watchdog.whenStarted;
		await timeout(100);
		blockFor(600);
		await recovered.p;
		// 二度知らせないことも確かめる。
		await timeout(100);
		assert.deepStrictEqual({
			count: recoveries.length,
			longEnough: (recoveries[0]?.blockedMs ?? 0) >= 400,
			heapKnown: (recoveries[0]?.heapUsed ?? 0) > 0,
			markerLeft: existsSync(markerPath),
		}, { count: 1, longEnough: true, heapKnown: true, markerLeft: false });
	});

	test('a hang that never ends leaves a marker for the next start, which reads and removes it', async function () {
		this.timeout(10_000);
		const markerPath = join(dir, 'hang.json');
		const recoveries: IParadisMainHangRecovery[] = [];
		// 心拍を事実上止める（本体を固めずに「戻ってこない」を作る）。
		const watchdog = start(markerPath, recoveries, 60_000);
		await watchdog.whenStarted;
		await whenFiles(dir, () => markerReadable(markerPath));
		const marker = await paradisTakeMainHangMarker(markerPath);
		// 止める合図で worker が印を消す（閉じるときの main は生きているので、固まりは続いていない）。
		// 読んだ後に worker が書き足すことがあるので、消えるのを待つ。
		watchdog.dispose();
		await whenFiles(dir, () => !existsSync(markerPath));
		assert.deepStrictEqual({
			version: marker?.version,
			blockedAtLeastHang: (marker?.blockedMs ?? 0) >= 200,
			heapKnown: (marker?.heapUsed ?? 0) > 0,
			removed: !existsSync(markerPath),
			recoveries: recoveries.length,
		}, { version: 1, blockedAtLeastHang: true, heapKnown: true, removed: true, recoveries: 0 });
	});

	test('while the machine is asleep nothing is counted', async function () {
		this.timeout(10_000);
		const markerPath = join(dir, 'hang.json');
		const recoveries: IParadisMainHangRecovery[] = [];
		const watchdog = start(markerPath, recoveries);
		await timeout(100);
		watchdog.pause();
		blockFor(500);
		await timeout(100);
		watchdog.resume();
		await timeout(200);
		assert.deepStrictEqual({ recoveries: recoveries.length, marker: existsSync(markerPath) }, { recoveries: 0, marker: false });
	});

	test('a missed resume does not leave the watchdog paused forever', async function () {
		this.timeout(10_000);
		const markerPath = join(dir, 'hang.json');
		const recoveries: IParadisMainHangRecovery[] = [];
		const recovered = new DeferredPromise<void>();
		const watchdog = start(markerPath, recoveries, undefined, recovered);
		await watchdog.whenStarted;
		watchdog.pause();
		// resume は来ない。心拍が続くうちに数え直しへ戻る。
		await timeout(600);
		blockFor(600);
		await recovered.p;
		await timeout(100);
		assert.deepStrictEqual(recoveries.length, 1);
	});

	test('an unreadable or foreign marker is dropped', async () => {
		const markerPath = join(dir, 'hang.json');
		await fs.writeFile(markerPath, '{"version":2}');
		assert.deepStrictEqual({ marker: await paradisTakeMainHangMarker(markerPath), removed: !existsSync(markerPath), missing: await paradisTakeMainHangMarker(markerPath) }, { marker: undefined, removed: true, missing: undefined });
	});

	test('the Sentry extra carries rounded numbers only', () => {
		assert.deepStrictEqual(paradisMainHangExtra({ blockedMs: 12_345.6, heapUsed: 3 * 1024 * 1024, rss: 10 * 1024 * 1024, uptimeMs: 90_000 }), {
			safe_blocked_ms: 12_346,
			safe_heap_used_mb: 3,
			safe_rss_mb: 10,
			safe_uptime_min: 2,
		});
	});
});
