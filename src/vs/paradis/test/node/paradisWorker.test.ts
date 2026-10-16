/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// fork の worker の共通の入口（paradisWorkerBootstrap.ts）と、worker の中での asar の解決。
// 本物の不具合はパッケージ版でしか起きない（開発ビルドには node_modules がある）ので、ここでは
// `node_modules.asar` を模した一時ディレクトリで、登録の有無だけで解決できるかが変わることを確かめる。

import assert from 'assert';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { Worker } from 'worker_threads';
import { FileAccess } from '../../../base/common/network.js';
import { join } from '../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { createParadisWorker } from '../../node/paradisWorker.js';
import { PARADIS_WORKER_ENTRY_KEY, startParadisWorkerEntry } from '../../node/paradisWorkerAsarResolution.js';

/** worker が最初に返したメッセージか、起動の失敗（error イベント）を返す。 */
function firstReply(worker: Worker): Promise<unknown> {
	return new Promise(resolve => {
		worker.once('message', message => resolve(message));
		worker.once('error', error => resolve({ error: (error as NodeJS.ErrnoException).code ?? error.message }));
	}).finally(() => worker.terminate());
}

suite('Paradis worker bootstrap', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;

	setup(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'paradis-worker-')));
	});

	teardown(() => {
		rmSync(root, { recursive: true, force: true });
	});

	/** Electron の renderer で動くテスト（scripts/test.sh）では Worker を作れない。Node で動くテスト（npm run test-node）で確かめる。 */
	async function skipWithoutWorkers(context: Mocha.Context): Promise<void> {
		try {
			await new Worker('', { eval: true }).terminate();
		} catch {
			context.skip();
		}
	}

	test('registers the resolution before importing the entry, and refuses to start without an entry', async () => {
		const calls: string[] = [];
		await startParadisWorkerEntry({ [PARADIS_WORKER_ENTRY_KEY]: 'file:///entry.js' }, () => calls.push('register'), async url => { calls.push(`load ${url}`); });
		const missing = await startParadisWorkerEntry({}, () => calls.push('register without entry'), async () => { calls.push('load without entry'); }).then(() => 'started', error => error.message);
		assert.deepStrictEqual({ calls, missing }, {
			calls: ['register', 'load file:///entry.js'],
			missing: 'Para Code worker started without an entry module',
		});
	});

	test('createParadisWorker runs the entry through the common bootstrap', async function () {
		await skipWithoutWorkers(this);
		const entry = join(root, 'entry.mjs');
		writeFileSync(entry, `import { parentPort, workerData } from 'node:worker_threads';\nparentPort.postMessage(workerData);\n`);
		const reply = await firstReply(createParadisWorker(entry));
		assert.deepStrictEqual(reply, { [PARADIS_WORKER_ENTRY_KEY]: pathToFileURL(entry).href });
	});

	test('a worker resolves packages from node_modules.asar only after registering the resolution', async function () {
		await skipWithoutWorkers(this);
		// appRoot/node_modules.asar/<package> と appRoot/out/<entry> の並びはパッケージ版と同じ。
		const packageRoot = join(root, 'node_modules.asar', 'paradis-fake-package');
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'paradis-fake-package', type: 'module', exports: './index.js' }));
		writeFileSync(join(packageRoot, 'index.js'), `export const origin = 'archive';\n`);
		mkdirSync(join(root, 'out'));
		const entry = join(root, 'out', 'entry.mjs');
		writeFileSync(entry, `export { origin } from 'paradis-fake-package';\n`);

		// 一時ディレクトリの node_modules.asar は本物の asar ではないので、Electron の asar 対応を外す。
		const source = `
			const { parentPort, workerData } = require('worker_threads');
			process.noAsar = true;
			(async () => {
				if (workerData.register) {
					const { registerParadisWorkerAsarResolution } = await import(workerData.resolution);
					registerParadisWorkerAsarResolution(workerData.appRoot, { ELECTRON_RUN_AS_NODE: '1' }, process.versions);
				}
				try {
					parentPort.postMessage((await import(workerData.entry)).origin);
				} catch (error) {
					parentPort.postMessage(error.code);
				}
			})();
		`;
		const run = (register: boolean) => firstReply(new Worker(source, {
			eval: true,
			workerData: { register, appRoot: root, entry: pathToFileURL(entry).href, resolution: FileAccess.asFileUri('vs/paradis/node/paradisWorkerAsarResolution.js').toString(true) },
		}));
		assert.deepStrictEqual({ without: await run(false), with: await run(true) }, { without: 'ERR_MODULE_NOT_FOUND', with: 'archive' });
	});
});
