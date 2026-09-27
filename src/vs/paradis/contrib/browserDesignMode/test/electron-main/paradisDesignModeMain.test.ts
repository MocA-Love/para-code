/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_DESIGN_MODE_WORLD_ID } from '../../common/paradisDesignMode.js';
import { IParadisDesignModeTarget, ParadisDesignModeMainService } from '../../electron-main/paradisDesignModeMain.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function fakeTarget(run: (worldId: number, code: string) => Promise<unknown>, destroyed = false): IParadisDesignModeTarget {
	return {
		webContents: {
			isDestroyed: () => destroyed,
			executeJavaScriptInIsolatedWorld: (worldId, scripts) => run(worldId, scripts[0].code),
		},
	};
}

suite('ParadisDesignModeMainService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let directory: string;

	setup(() => {
		directory = join(tmpdir(), `paradis-design-mode-test-${generateUuid()}`, 'images');
	});

	teardown(async () => {
		await fs.rm(join(directory, '..'), { recursive: true, force: true });
	});

	test('専用の isolated world で選ばせ、返ってきた値を検証してから返す', async () => {
		const worlds: number[] = [];
		const service = new ParadisDesignModeMainService(() => fakeTarget(async worldId => {
			worlds.push(worldId);
			return { element: { tagName: 'DIV', selector: 'div#a', url: 'https://example.com/?q=1', attributes: { onclick: 'x' } } };
		}), directory);
		const result = await service.pickElement('view-1');
		assert.deepStrictEqual({
			worlds,
			kind: result.kind,
			tagName: result.kind === 'picked' ? result.element.tagName : undefined,
			url: result.kind === 'picked' ? result.element.url : undefined,
			attributes: result.kind === 'picked' ? result.element.attributes : undefined,
		}, { worlds: [PARADIS_DESIGN_MODE_WORLD_ID], kind: 'picked', tagName: 'div', url: 'https://example.com/', attributes: {} });
	});

	test('ページの遷移・取り消し・破棄済みのビューは取り消しとして返す', async () => {
		const rejected = new ParadisDesignModeMainService(() => fakeTarget(async () => { throw new Error('Script failed to execute'); }), directory);
		const cancelled = new ParadisDesignModeMainService(() => fakeTarget(async () => ({ cancelled: true })), directory);
		const destroyed = new ParadisDesignModeMainService(() => fakeTarget(async () => ({ element: { tagName: 'a', selector: 'a' } }), true), directory);
		const missing = new ParadisDesignModeMainService(() => undefined, directory);
		assert.deepStrictEqual(await Promise.all([
			rejected.pickElement('v'),
			cancelled.pickElement('v'),
			destroyed.pickElement('v'),
			missing.pickElement('v'),
		]), [{ kind: 'cancelled' }, { kind: 'cancelled' }, { kind: 'cancelled' }, { kind: 'cancelled' }]);
	});

	test('PNG を所有者だけが読める場所へ保存し、古い画像を掃除する', async () => {
		let now = 1_000_000_000_000;
		const service = new ParadisDesignModeMainService(() => undefined, directory, () => now);
		const first = await service.saveImage(VSBuffer.wrap(PNG));
		now += 25 * 60 * 60 * 1000;
		const second = await service.saveImage(VSBuffer.wrap(PNG));
		// 掃除は待たずに走るので、終わるまで少し待つ
		for (let attempt = 0; attempt < 50 && (await fs.readdir(directory)).length > 1; attempt++) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		const names = await fs.readdir(directory);
		const fileMode = (await fs.stat(second)).mode & 0o777;
		const directoryMode = (await fs.stat(directory)).mode & 0o777;
		assert.deepStrictEqual({
			names,
			content: [...await fs.readFile(second)],
			fileMode: isWindows ? 0o600 : fileMode,
			directoryMode: isWindows ? 0o700 : directoryMode,
			firstRemoved: !names.includes(first.slice(directory.length + 1)),
		}, {
			names: [second.slice(directory.length + 1)],
			content: [...PNG],
			fileMode: 0o600,
			directoryMode: 0o700,
			firstRemoved: true,
		});
	});

	test('PNG でないもの・大きすぎるものは保存しない', async () => {
		const service = new ParadisDesignModeMainService(() => undefined, directory);
		await assert.rejects(() => service.saveImage(VSBuffer.wrap(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))));
		await assert.rejects(() => service.saveImage(VSBuffer.alloc(0)));
		const huge = new Uint8Array(20 * 1024 * 1024 + 1);
		huge.set(PNG);
		await assert.rejects(() => service.saveImage(VSBuffer.wrap(huge)));
	});
});
