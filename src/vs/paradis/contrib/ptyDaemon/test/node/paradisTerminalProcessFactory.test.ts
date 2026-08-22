/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 差し替え口の判断を固定する。
//
// **待つ場所を間違えると、常駐を初めて有効にした起動が必ず壊れる。** pty ホストのチャネルが
// 登録される前に待つと、窓から来た要求は `ChannelServer` に溜まり、**1秒で「Unknown channel」
// として失敗する**。常駐を起こすのには10秒かかり得る。だから待つのはターミナルを作るときだけ、
// という形をここで見張る。

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IShellLaunchConfig, ITerminalProcessOptions } from '../../../../../platform/terminal/common/terminal.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAwaitPtyDaemon, paradisCreateTerminalProcess, paradisUsePtyDaemon } from '../../node/paradisTerminalProcessFactory.js';
import { ParadisDaemonTerminalProcess } from '../../node/paradisDaemonTerminalProcess.js';

const OPTIONS: ITerminalProcessOptions = {
	shellIntegration: { enabled: false, suggestEnabled: false, nonce: '' },
	windowsUseConptyDll: false,
	environmentVariableCollections: undefined,
	workspaceFolder: undefined,
	isScreenReaderOptimized: false,
};

const SHELL: IShellLaunchConfig = { executable: '/bin/sh', args: [], env: {} };

function create(store: DisposableStore) {
	return paradisCreateTerminalProcess(
		SHELL, '/', 80, 24, {}, {}, OPTIONS, new NullLogService(), { quality: 'stable' } as IProductService,
	).then(process => store.add(process));
}

suite('ParadisTerminalProcessFactory', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => {
		paradisAwaitPtyDaemon(undefined);
	});

	/**
	 * 常駐を預け、テストの終わりに必ず戻す。
	 *
	 * `teardown` ではなく store に載せるのは、リーク検査がこの store を畳んでから数えるため。
	 * `teardown` は検査より後に走るので間に合わない。
	 */
	function useDaemon(): Emitter<void> {
		const gone = store.add(new Emitter<void>());
		// 配る人がここを購読するので、イベントの口は本物にしておく。
		const host = {
			onDidChangeData: store.add(new Emitter<never>()).event,
			onDidChangeTitle: store.add(new Emitter<never>()).event,
			onDidExit: store.add(new Emitter<never>()).event,
		} as never;
		paradisUsePtyDaemon({ host, client: { onDidDispose: gone.event } as never, viewer: 'viewer' });
		store.add(toDisposable(() => paradisUsePtyDaemon(undefined)));
		return gone;
	}

	test('常駐へ繋ぎ終わるまでターミナルを作らない。**起動そのものは待たせない**', async () => {
		const joining = new DeferredPromise<void>();
		paradisAwaitPtyDaemon(joining.p);

		const disposables = store.add(new DisposableStore());
		const pending = create(disposables);
		let settledEarly = false;
		void pending.then(() => { settledEarly = true; });
		await Promise.resolve();

		// まだ繋ぎ終わっていない。ここで作ってしまうと、常駐に置くはずのターミナルが
		// このプロセスの中に生まれ、閉じた時点で消える。
		const beforeJoin = settledEarly;

		joining.complete();
		await pending;

		assert.deepStrictEqual({ beforeJoin, madeAfterJoin: settledEarly }, { beforeJoin: false, madeAfterJoin: true });
	});

	test('繋がっていれば常駐に持たせ、繋がっていなければ今までどおり自分で持つ', async () => {
		const withoutDaemon = store.add(new DisposableStore());
		const inApp = await create(withoutDaemon);

		// 接続の生死は本物の口で持たせる（常駐が落ちたら手放す、を実装が見ているため）。
		useDaemon();
		const withDaemon = store.add(new DisposableStore());
		const inDaemon = await create(withDaemon);

		assert.deepStrictEqual(
			{ inApp: inApp instanceof ParadisDaemonTerminalProcess, inDaemon: inDaemon instanceof ParadisDaemonTerminalProcess },
			{ inApp: false, inDaemon: true },
		);
	});

	test('常駐が落ちたら手放す。以後のターミナルは今までどおり自分で持つ', async () => {
		const gone = useDaemon();

		const before = store.add(new DisposableStore());
		const whileUp = await create(before);

		// 常駐が落ちた。掴んだままだと、以後に作るターミナルが全部そこへ行こうとして失敗し続ける。
		gone.fire();

		const after = store.add(new DisposableStore());
		const whileDown = await create(after);

		assert.deepStrictEqual(
			{ whileUp: whileUp instanceof ParadisDaemonTerminalProcess, whileDown: whileDown instanceof ParadisDaemonTerminalProcess },
			{ whileUp: true, whileDown: false },
		);
	});

	test('引き取り先が無いのに引き取れと言われたら、黙って起こさずに投げる', async () => {
		const disposables = store.add(new DisposableStore());
		let threw = false;
		try {
			await paradisCreateTerminalProcess(
				SHELL, '/', 80, 24, {}, {}, OPTIONS, new NullLogService(), { quality: 'stable' } as IProductService,
				undefined,
				{ handle: 1, pid: 2, title: 'zsh', exited: undefined },
			).then(process => disposables.add(process));
		} catch {
			threw = true;
		}

		// 新しく起こすと、残っているプロセスは行方不明のまま二重に増える。
		assert.deepStrictEqual({ threw }, { threw: true });
	});
});
