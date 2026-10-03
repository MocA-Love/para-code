/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import 'mocha';
import * as assert from 'assert';
import { IParadisParkedRepository, PARADIS_DEFAULT_PARK_LIMIT, ParadisParkedRefreshGate, ParadisRepositoryParkingLot, paradisResolveParkLimit } from '../paradisRepositoryPark';

/** 呼ばれた回数だけ数える待避エントリ。 */
function createEntry(root: string, log: string[], rootRealPath?: string): IParadisParkedRepository {
	return {
		root,
		rootRealPath,
		unpark: () => log.push(`unpark:${root}`),
		dispose: () => log.push(`dispose:${root}`),
	};
}

const silentLogger = { trace: () => { } };

suite('ParadisRepositoryParkingLot', () => {

	test('evicts the oldest entry once the limit is exceeded, disposing it exactly once', () => {
		const log: string[] = [];
		const lot = new ParadisRepositoryParkingLot(silentLogger, 2);

		lot.park(createEntry('/a', log));
		lot.park(createEntry('/b', log));
		lot.park(createEntry('/c', log));
		const afterPark = [...log];

		assert.deepStrictEqual({
			afterPark,
			unparkedA: lot.unparkForRoot('/a'),
			unparkedB: lot.unparkForRoot('/b'),
		}, {
			afterPark: ['dispose:/a'],
			unparkedA: false,
			unparkedB: true,
		});
	});

	test('replacing the same root disposes the previous entry rather than keeping both', () => {
		const log: string[] = [];
		const lot = new ParadisRepositoryParkingLot(silentLogger, 4);

		lot.park(createEntry('/a', log));
		lot.park(createEntry('/a', log));
		const afterPark = [...log];

		assert.deepStrictEqual({
			afterPark,
			unparked: lot.unparkForRoot('/a'),
			// 復帰は1回だけ。二重に保持していれば2回目も true になる。
			unparkedAgain: lot.unparkForRoot('/a'),
		}, {
			afterPark: ['dispose:/a'],
			unparked: true,
			unparkedAgain: false,
		});
	});

	test('unparkForFolder matches the folder itself, its repositories and its parent repository', () => {
		const log: string[] = [];
		const lot = new ParadisRepositoryParkingLot(silentLogger, 8);

		lot.park(createEntry('/w/repo', log));          // フォルダそのもの
		lot.park(createEntry('/w/repo/nested', log));   // フォルダ配下のリポジトリ
		lot.park(createEntry('/w', log));               // フォルダを含む親リポジトリ
		lot.park(createEntry('/w/other', log));         // 無関係

		const count = lot.unparkForFolder('/w/repo');

		assert.deepStrictEqual({ count, log }, {
			count: 3,
			log: ['unpark:/w/repo', 'unpark:/w/repo/nested', 'unpark:/w'],
		});
	});

	test('matches a symlinked root through rootRealPath', () => {
		const log: string[] = [];
		const lot = new ParadisRepositoryParkingLot(silentLogger, 4);

		lot.park(createEntry('/tmp/work', log, '/private/tmp/work'));

		assert.deepStrictEqual({
			byRealPath: lot.unparkForRoot('/private/tmp/work'),
			log,
		}, {
			byRealPath: true,
			log: ['unpark:/tmp/work'],
		});
	});

	test('unparkForRoot never returns a repository that merely contains the path', () => {
		const log: string[] = [];
		const lot = new ParadisRepositoryParkingLot(silentLogger, 4);

		lot.park(createEntry('/repo', log));

		assert.deepStrictEqual({
			descendant: lot.unparkForRoot('/repo/nested'),
			log,
		}, {
			descendant: false,
			log: [],
		});
	});

	test('disposeMatching drops only the entries the predicate selects', () => {
		const log: string[] = [];
		const lot = new ParadisRepositoryParkingLot(silentLogger, 4);

		lot.park(createEntry('/keep', log));
		lot.park(createEntry('/drop', log));

		lot.disposeMatching(root => root === '/drop');
		const afterDispose = [...log];

		assert.deepStrictEqual({
			afterDispose,
			keepStillParked: lot.unparkForRoot('/keep'),
			dropStillParked: lot.unparkForRoot('/drop'),
		}, {
			afterDispose: ['dispose:/drop'],
			keepStillParked: true,
			dropStillParked: false,
		});
	});

	test('clear disposes every parked entry once', () => {
		const log: string[] = [];
		const lot = new ParadisRepositoryParkingLot(silentLogger, 4);

		lot.park(createEntry('/a', log));
		lot.park(createEntry('/b', log));
		lot.clear();
		lot.clear();

		assert.deepStrictEqual(log, ['dispose:/a', 'dispose:/b']);
	});

	test('an entry that disposes itself through forget is not disposed twice by eviction', () => {
		const log: string[] = [];
		const lot = new ParadisRepositoryParkingLot(silentLogger, 1);

		// 実機の `dispose` は自分自身を待避所から取り除く（model.ts の OpenRepository.dispose）。
		// 追い出し側は先に map から消してから dispose を呼ぶので、その forget は no-op になる。
		const selfRemoving = (root: string): IParadisParkedRepository => ({
			root,
			unpark: () => log.push(`unpark:${root}`),
			dispose: () => {
				log.push(`dispose:${root}`);
				lot.forget(root);
			},
		});

		lot.park(selfRemoving('/a'));
		lot.park(selfRemoving('/b'));
		const afterPark = [...log];

		assert.deepStrictEqual({ afterPark, bStillParked: lot.unparkForRoot('/b') }, {
			afterPark: ['dispose:/a'],
			bStillParked: true,
		});
	});
});

suite('ParadisRepositoryParkingLot limit', () => {

	test('defaults to 16 and resolves the setting (0 means unlimited, invalid values fall back)', () => {
		assert.deepStrictEqual({
			defaultLimit: new ParadisRepositoryParkingLot(silentLogger).currentLimit,
			exported: PARADIS_DEFAULT_PARK_LIMIT,
			undefinedSetting: paradisResolveParkLimit(undefined),
			configured: paradisResolveParkLimit(6),
			fractional: paradisResolveParkLimit(6.9),
			unlimited: paradisResolveParkLimit(0),
			negative: paradisResolveParkLimit(-1),
			notANumber: paradisResolveParkLimit('8'),
		}, {
			defaultLimit: 16,
			exported: 16,
			undefinedSetting: 16,
			configured: 6,
			fractional: 6,
			unlimited: Number.POSITIVE_INFINITY,
			negative: 16,
			notANumber: 16,
		});
	});

	test('keeps 16 repositories by default and evicts the 17th oldest', () => {
		const log: string[] = [];
		const lot = new ParadisRepositoryParkingLot(silentLogger);
		for (let i = 0; i < 17; i++) {
			lot.park(createEntry(`/repo/${i}`, log));
		}
		assert.deepStrictEqual({ size: lot.size, log }, { size: 16, log: ['dispose:/repo/0'] });
	});

	test('never evicts when unlimited', () => {
		const log: string[] = [];
		const lot = new ParadisRepositoryParkingLot(silentLogger, paradisResolveParkLimit(0));
		for (let i = 0; i < 40; i++) {
			lot.park(createEntry(`/repo/${i}`, log));
		}
		assert.deepStrictEqual({ size: lot.size, log }, { size: 40, log: [] });
	});

	test('evicts the oldest at once when the limit is lowered, and keeps the rest when raised', () => {
		const log: string[] = [];
		const lot = new ParadisRepositoryParkingLot(silentLogger, 5);
		for (let i = 0; i < 5; i++) {
			lot.park(createEntry(`/repo/${i}`, log));
		}
		lot.setLimit(2);
		const afterLowering = { size: lot.size, log: [...log] };
		lot.setLimit(paradisResolveParkLimit(0));
		lot.park(createEntry('/repo/5', log));
		assert.deepStrictEqual({ afterLowering, size: lot.size, log }, {
			afterLowering: { size: 2, log: ['dispose:/repo/0', 'dispose:/repo/1', 'dispose:/repo/2'] },
			size: 3,
			log: ['dispose:/repo/0', 'dispose:/repo/1', 'dispose:/repo/2'],
		});
	});
});

suite('ParadisParkedRefreshGate', () => {

	test('holds back configuration refreshes while parked and lets the unpark status() settle them', () => {
		const gate = new ParadisParkedRefreshGate();
		const refreshes: string[] = [];
		const whileActive = gate.request(true, () => refreshes.push('active'));
		const whileParked = [gate.request(false, () => refreshes.push('parked-1')), gate.request(false, () => refreshes.push('parked-2'))];
		const deferredBeforeUnpark = gate.deferred;
		gate.settledByUnpark();
		assert.deepStrictEqual({ whileActive, whileParked, deferredBeforeUnpark, deferredAfterUnpark: gate.deferred, refreshes }, {
			whileActive: false,
			whileParked: [true, true],
			deferredBeforeUnpark: true,
			deferredAfterUnpark: false,
			// 待避中の要求では一度も作り直さない (別スペースの変更をリソースグループへ戻さない)。
			refreshes: ['active'],
		});
	});
});
