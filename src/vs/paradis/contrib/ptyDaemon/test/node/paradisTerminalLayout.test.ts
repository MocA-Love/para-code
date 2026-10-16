/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 配置の預け方と戻し方。
//
// **ここが噛み合わないと、引き取りが成功しても画面には何も出ない。** 窓は配置を見てどの
// ターミナルへ繋ぐかを決めるので、番号が当たらなければ誰も繋ぎに来ない。走っているプロセスは
// あるのに出てくる経路が無い、という一番たちの悪い形になる。

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISetTerminalLayoutInfoArgs } from '../../../../../platform/terminal/common/terminalProcess.js';
import { paradisDecodeLayout, paradisEncodeLayout, paradisLayoutToRemember, paradisMergeForeignLayout } from '../../node/paradisTerminalLayout.js';

function layout(ids: number[], background: number[] = []): ISetTerminalLayoutInfoArgs {
	return {
		workspaceId: 'ws-1',
		tabs: [{
			isActive: true,
			activePersistentProcessId: ids[0],
			terminals: ids.map(id => ({ relativeSize: 1 / ids.length, terminal: id })),
		}],
		background,
	};
}

suite('ParadisTerminalLayout', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('番号は持ち越さない。預けるときに handle へ、戻すときに新しい番号へ', () => {
		// 前の世代: 番号 1,2 が handle 10,11 を持っていた。
		const stored = paradisEncodeLayout(layout([1, 2], [2]), id => ({ 1: 10, 2: 11 })[id]);

		// 新しい世代: 同じ handle が番号 7,8 に振り直された。
		const restored = paradisDecodeLayout(stored, handle => ({ 10: 7, 11: 8 })[handle]);

		assert.deepStrictEqual(
			{
				// 預けたものに前の番号が残っていないこと。残っていると次の起動で何も指さない。
				// 部分一致で見ると `"terminal":10` にも当たるので、読んで比べる。
				storedHandles: (JSON.parse(stored) as ISetTerminalLayoutInfoArgs).tabs[0].terminals.map(terminal => terminal.terminal),
				terminals: restored?.tabs[0].terminals.map(terminal => terminal.terminal),
				active: restored?.tabs[0].activePersistentProcessId,
				background: restored?.background,
			},
			{ storedHandles: [10, 11], terminals: [7, 8], active: 7, background: [8] },
		);
	});

	test('引き取れなかったものは配置から落とす。存在しない番号を指さない', () => {
		const stored = paradisEncodeLayout(layout([1, 2]), id => ({ 1: 10, 2: 11 })[id]);

		// 2本目は引き取れなかった（常駐から消えていた等）。
		const restored = paradisDecodeLayout(stored, handle => ({ 10: 7 })[handle]);

		assert.deepStrictEqual(
			{ terminals: restored?.tabs[0].terminals.map(terminal => terminal.terminal) },
			{ terminals: [7] },
		);
	});

	test('1本も引き取れなければ配置は戻さない。空のタブを並べない', () => {
		const stored = paradisEncodeLayout(layout([1]), id => ({ 1: 10 })[id]);

		assert.deepStrictEqual({ restored: paradisDecodeLayout(stored, () => undefined) }, { restored: undefined });
	});

	test('読めない配置で引き取り全体を落とさない', () => {
		// 配置は作り直せるが、走っているプロセスは作り直せない。
		assert.deepStrictEqual(
			{ garbage: paradisDecodeLayout('not json', () => 1), wrongShape: paradisDecodeLayout('{"tabs":42}', () => 1) },
			{ garbage: undefined, wrongShape: undefined },
		);
	});

	test('常駐に載っていないターミナルは預けない', () => {
		// 常駐の外に居るもの（接続先の端末など）を混ぜると、戻したときに当たらない番号になる。
		const stored = paradisEncodeLayout(layout([1, 2]), id => (id === 1 ? 10 : undefined));

		assert.deepStrictEqual(
			{ handles: (JSON.parse(stored) as ISetTerminalLayoutInfoArgs).tabs[0].terminals.map(terminal => terminal.terminal) },
			{ handles: [10] },
		);
	});

	test('start() 前で handle が分からないだけなら、預けた配置を空で消さない', () => {
		const known = (id: number) => (id === 1 ? 10 : undefined);
		assert.deepStrictEqual({
			// どれも handle がまだ無い: 送らない（前に預けた配置を残す）
			notStarted: paradisLayoutToRemember(layout([2, 3]), known),
			// ターミナルが1本も無い: 忘れさせる合図
			none: paradisLayoutToRemember({ workspaceId: 'ws-1', tabs: [], background: [] }, known),
			// 1本でも分かれば、分かるものだけ預ける
			partial: (JSON.parse(paradisLayoutToRemember(layout([1, 2]), known)!) as ISetTerminalLayoutInfoArgs).tabs[0].terminals.map(terminal => terminal.terminal),
		}, { notStarted: undefined, none: '', partial: [10] });
	});
	test('別の pty ホストがまだ見ている端末のタブは、窓の配置で上書きせずに後ろへ残す', () => {
		// 起動時に常駐が持っていた配置（更新前の版の窓が書いたもの）: handle 20,21 のタブと、背面の 22。
		const foreignRaw = JSON.stringify({
			workspaceId: 'ws-1',
			tabs: [{ isActive: true, activePersistentProcessId: 20, terminals: [{ relativeSize: 0.5, terminal: 20 }, { relativeSize: 0.5, terminal: 21 }] }],
			background: [22],
		} satisfies ISetTerminalLayoutInfoArgs);
		// 更新後の版の窓は、自分が起こした handle 30 だけの配置を書こうとする。
		const own = paradisEncodeLayout(layout([3]), id => ({ 3: 30 })[id]);
		// 21 はもう引き取って窓の配置に入っている、という場合も混ぜる。
		const ownWith21 = paradisEncodeLayout(layout([3, 4]), id => ({ 3: 30, 4: 21 })[id]);

		const merged = JSON.parse(paradisMergeForeignLayout('ws-1', own, foreignRaw, new Set([20, 21, 22]))) as ISetTerminalLayoutInfoArgs;
		const mergedWith21 = JSON.parse(paradisMergeForeignLayout('ws-1', ownWith21, foreignRaw, new Set([20, 21, 22]))) as ISetTerminalLayoutInfoArgs;
		const forget = JSON.parse(paradisMergeForeignLayout('ws-1', '', foreignRaw, new Set([22]))) as ISetTerminalLayoutInfoArgs;

		assert.deepStrictEqual({
			tabs: merged.tabs.map(tab => ({ isActive: tab.isActive, terminals: tab.terminals.map(terminal => terminal.terminal) })),
			background: merged.background,
			// 窓が持っている 21 は二重に足さない。
			with21: mergedWith21.tabs.map(tab => tab.terminals.map(terminal => terminal.terminal)),
			// 窓が「忘れて」と言っても、まだ見られている端末の分は残す。
			forget: { tabs: forget.tabs.length, background: forget.background },
			// 別の相手が見ている端末が無ければ、窓の配置をそのまま書く。
			untouched: paradisMergeForeignLayout('ws-1', own, foreignRaw, new Set()) === own,
		}, {
			tabs: [{ isActive: true, terminals: [30] }, { isActive: false, terminals: [20, 21] }],
			background: [22],
			with21: [[30, 21], [20]],
			forget: { tabs: 0, background: [22] },
			untouched: true,
		});
	});
});
