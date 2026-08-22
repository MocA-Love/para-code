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
import { paradisDecodeLayout, paradisEncodeLayout } from '../../node/paradisTerminalLayout.js';

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
});
