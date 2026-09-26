/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
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
		// 設置は作られる前に「終わらせる」指示が来ることがあるので、先に用意しておく
		const installs = [new DeferredPromise<void>(), new DeferredPromise<void>()];
		const createInstaller = (): IParadisAgentHooksInstaller => {
			const id = events.filter(event => event.startsWith('install')).length + 1;
			events.push(`install#${id}`);
			const idle = installs[id - 1];
			return {
				start: async () => { await idle.p; },
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
			finishInstall(id: number) { void installs[id - 1].complete(); },
		};
	}

	test('起動時にオフなら、設置も取り外しもしない（別の Para Code の hook を壊さない）', async () => {
		const { autoInstall, events, set } = setup(false);
		set(false);
		await autoInstall.whenIdle();
		assert.deepStrictEqual(events, []);
	});

	test('オフに切り替わったその時だけ、走っている設置を待ってから取り外す。オンに戻せば置き直す', async () => {
		const { autoInstall, events, set, finishInstall } = setup(true);
		set(false);
		// 設置が終わる前に取り外しへ進んではいけない（後から書き戻されるため）
		await Promise.resolve();
		const beforeInstallFinished = [...events];
		finishInstall(1);
		await autoInstall.whenIdle();
		set(true);
		finishInstall(2);
		await autoInstall.whenIdle();
		assert.deepStrictEqual({ beforeInstallFinished, events }, {
			beforeInstallFinished: ['install#1'],
			events: ['install#1', 'stop#1', 'idle#1', 'remove', 'install#2'],
		});
	});

	test('起動時にオフで、あとからオンにしたら設置を始める', async () => {
		const { autoInstall, events, set, finishInstall } = setup(false);
		set(true);
		finishInstall(1);
		await autoInstall.whenIdle();
		assert.deepStrictEqual(events, ['install#1']);
	});
});
