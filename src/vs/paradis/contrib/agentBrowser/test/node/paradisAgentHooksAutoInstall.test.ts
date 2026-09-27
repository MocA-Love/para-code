/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisAgentHooksInstaller, ParadisAgentHooksAutoInstall } from '../../node/paradisAgentHooksAutoInstall.js';

suite('ParadisAgentHooksAutoInstall', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(initiallyEnabled: boolean) {
		let enabled = initiallyEnabled;
		const events: string[] = [];
		const changed = store.add(new Emitter<void>());
		// 設置ごとに「start が返る」と「走っている書き込みが終わる（whenIdle）」を別々に進められるようにする。
		// 作られる前に終わらせる指示が来ることがあるので、先に用意しておく
		const installs = [0, 1].map(() => ({ started: new DeferredPromise<void>(), idle: new DeferredPromise<void>() }));
		const createInstaller = (): IParadisAgentHooksInstaller => {
			const id = events.filter(event => event.startsWith('install')).length + 1;
			events.push(`install#${id}`);
			const { started, idle } = installs[id - 1];
			return {
				start: () => started.p,
				whenIdle: () => idle.p.then(() => { events.push(`idle#${id}`); }),
				dispose: () => { events.push(`stop#${id}`); },
			};
		};
		const autoInstall = store.add(new ParadisAgentHooksAutoInstall({
			isEnabled: () => enabled,
			onDidChangeEnabled: changed.event,
			createInstaller,
			removeHooks: async () => { events.push('remove'); },
			logService: new NullLogService(),
		}));
		return {
			autoInstall,
			events,
			set(value: boolean) { enabled = value; changed.fire(); },
			finishStart(id: number) { void installs[id - 1].started.complete(); },
			finishIdle(id: number) { void installs[id - 1].idle.complete(); },
		};
	}

	test('起動時にオフなら、設置も取り外しもしない（別の Para Code の hook を壊さない）', async () => {
		const { autoInstall, events, set } = setup(false);
		set(false);
		await autoInstall.whenIdle();
		assert.deepStrictEqual(events, []);
	});

	test('オフへの切り替えは、始めている設置（start）が返るまで取り外しへ進まない', async () => {
		const { autoInstall, events, set, finishStart, finishIdle } = setup(true);
		set(false);
		await timeout(0);
		const beforeStartReturned = [...events];
		finishStart(1);
		finishIdle(1);
		await autoInstall.whenIdle();
		assert.deepStrictEqual({ beforeStartReturned, events }, {
			beforeStartReturned: ['install#1'],
			events: ['install#1', 'stop#1', 'idle#1', 'remove'],
		});
	});

	test('設置を止めたあと、走っている書き込み（whenIdle）が終わるのを待ってから取り外す。オンに戻せば置き直す', async () => {
		const { autoInstall, events, set, finishStart, finishIdle } = setup(true);
		finishStart(1);
		await autoInstall.whenIdle();
		set(false);
		await timeout(0);
		// start は返っているが書き込みがまだ走っている。ここで取り外すと後から書き戻される
		const whileWriting = [...events];
		finishIdle(1);
		await autoInstall.whenIdle();
		set(true);
		finishStart(2);
		await autoInstall.whenIdle();
		assert.deepStrictEqual({ whileWriting, events }, {
			whileWriting: ['install#1', 'stop#1'],
			events: ['install#1', 'stop#1', 'idle#1', 'remove', 'install#2'],
		});
	});

	test('起動時にオフで、あとからオンにしたら設置を始める', async () => {
		const { autoInstall, events, set, finishStart } = setup(false);
		set(true);
		finishStart(1);
		await autoInstall.whenIdle();
		assert.deepStrictEqual(events, ['install#1']);
	});
});
