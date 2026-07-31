/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisHostCpuSample, ParadisHostResourceSampler, paradisComputeCpuPercent, paradisReadCpuSample, paradisReadDiskVolumes,
} from '../../node/paradisHostResources.js';

function sample(idle: number, total: number, at = 0): IParadisHostCpuSample {
	return { idle, total, at, cores: 8 };
}

suite('ParadisHostResources', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('computes CPU percent from the busy share of the delta', () => {
		assert.deepStrictEqual([
			// 1000ms 進んで 750ms が idle → 25% 使用
			paradisComputeCpuPercent(sample(1_000, 2_000), sample(1_750, 3_000)),
			// まったく進んでいない（同じサンプル）→ 算出不能
			paradisComputeCpuPercent(sample(1_000, 2_000), sample(1_000, 2_000)),
			// 巻き戻っている（サスペンド復帰等）→ 算出不能
			paradisComputeCpuPercent(sample(1_000, 2_000), sample(900, 1_500)),
			// idle が total より速く進む異常値でも負にはしない
			paradisComputeCpuPercent(sample(1_000, 2_000), sample(2_500, 3_000)),
			// 差分が小さすぎる（8コアで合計399ms＝1コアあたり50ms未満）→ 比率が暴れるので出さない
			paradisComputeCpuPercent(sample(1_000, 2_000), sample(1_200, 2_399)),
			// 同じ差分でも下限を超えていれば出す
			paradisComputeCpuPercent(sample(1_000, 2_000), sample(1_200, 2_400)),
		], [25, undefined, undefined, 0, undefined, 50]);
	});

	test('reads a usable live sample', () => {
		const live = paradisReadCpuSample(42);
		assert.deepStrictEqual([
			live.at,
			live.cores > 0,
			live.total > 0,
			live.idle >= 0 && live.idle <= live.total,
		], [42, true, true, true]);
	});

	test('skips unreadable paths and collapses paths that share a device', async () => {
		// 同じボリューム上の2パス＋存在しないパス。前者は1件にまとまり、後者は黙って捨てられる。
		const volumes = await paradisReadDiskVolumes([
			process.cwd(),
			process.cwd(),
			'/paradis-nonexistent-path-for-test',
		]);
		assert.deepStrictEqual([
			volumes.length,
			volumes[0]?.total > 0,
			volumes[0]?.free >= 0,
			// 表示名はパスそのもの（パス末尾だとアカウント名1行になってしまうため）
			volumes[0]?.label,
		], [1, true, true, process.cwd()]);
	});

	test('falls back to a short two-point measurement when there is no previous sample', async () => {
		const delays: number[] = [];
		let clock = 0;
		const sampler = new ParadisHostResourceSampler(
			() => clock,
			async ms => { delays.push(ms); clock += ms; },
		);

		const first = await sampler.read([process.cwd()]);
		// 2回目は前回サンプルが新しいので待たない
		clock += 10_000;
		const second = await sampler.read([process.cwd()]);
		// 前回サンプルが古すぎる場合は測り直す
		clock += 10 * 60_000;
		await sampler.read([process.cwd()]);

		assert.deepStrictEqual([
			delays.length,
			delays[0] > 0,
			first.cores > 0,
			first.memory.total > 0,
			first.memory.used <= first.memory.total,
			second.disks.length,
		], [2, true, true, true, true, 1]);
	});
});
