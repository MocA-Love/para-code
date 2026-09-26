/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { IChannelClient } from '../../../../../base/parts/ipc/common/ipc.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IPtyHostConnection, IPtyHostStarter } from '../../../../../platform/terminal/node/ptyHost.js';
import { ParadisScopedEnvPtyHostStarter } from '../../electron-main/paradisScopedEnvPtyHostStarter.js';

const UNUSED_CLIENT: IChannelClient = { getChannel: () => { throw new Error('not used in this test'); } };

/** `ElectronPtyHostStarter` と同じく、`start()` の中で環境を写し取る偽物。 */
class RecordingStarter extends Disposable implements IPtyHostStarter {
	readonly seen: (string | undefined)[] = [];
	disposed = false;
	constructor(private readonly env: { [key: string]: string | undefined }, private readonly exitEmitter: Emitter<{ code: number; signal: string }>) {
		super();
	}
	start(): IPtyHostConnection {
		this.seen.push(this.env.PARADIS_PTY_HOST_STATE_DIR);
		return { client: UNUSED_CLIENT, store: new DisposableStore(), onDidProcessExit: this.exitEmitter.event };
	}
	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}
}

suite('ParadisScopedEnvPtyHostStarter', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('pty ホストを起こす瞬間だけ置き場所を見せ、main の環境には残さない（起こし直しでも同じ）', () => {
		const env: { [key: string]: string | undefined } = { PATH: '/usr/bin' };
		const exit = store.add(new Emitter<{ code: number; signal: string }>());
		const inner = new RecordingStarter(env, exit);
		const starter = store.add(new ParadisScopedEnvPtyHostStarter(inner, { PARADIS_PTY_HOST_STATE_DIR: '/state' }, env));

		store.add(starter.start().store);
		const afterFirst = { ...env };
		store.add(starter.start().store);
		starter.dispose();

		assert.deepStrictEqual({ seen: inner.seen, afterFirst, afterSecond: env, innerDisposed: inner.disposed }, {
			seen: ['/state', '/state'],
			afterFirst: { PATH: '/usr/bin' },
			afterSecond: { PATH: '/usr/bin' },
			innerDisposed: true,
		});
	});

	test('もともと入っていた値は起こした後に元へ戻す', () => {
		const env: { [key: string]: string | undefined } = { PARADIS_PTY_HOST_STATE_DIR: '/inherited' };
		const exit = store.add(new Emitter<{ code: number; signal: string }>());
		const inner = new RecordingStarter(env, exit);
		const starter = store.add(new ParadisScopedEnvPtyHostStarter(inner, { PARADIS_PTY_HOST_STATE_DIR: '/state' }, env));

		store.add(starter.start().store);

		assert.deepStrictEqual({ seen: inner.seen, env }, {
			seen: ['/state'],
			env: { PARADIS_PTY_HOST_STATE_DIR: '/inherited' },
		});
	});
});
