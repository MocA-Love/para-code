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
import { paradisBuildCancelPickScript } from '../../common/paradisDesignModePageScript.js';
import { IParadisDesignModeTarget, ParadisDesignModeMainService } from '../../electron-main/paradisDesignModeMain.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function fakeTarget(run: (worldId: number, code: string, userGesture: boolean | undefined) => Promise<unknown>, destroyed = false): IParadisDesignModeTarget {
	return {
		webContents: {
			isDestroyed: () => destroyed,
			executeJavaScriptInIsolatedWorld: (worldId, scripts, userGesture) => run(worldId, scripts[0].code, userGesture),
		},
	};
}

/** 選択スクリプトに埋め込まれた nonce（main が呼び出しごとに作る値）を取り出す。 */
function nonceOf(code: string): string | undefined {
	return /__paradisDesign[.]pick[(]"(?<nonce>[^"]+)"[)]/.exec(code)?.groups?.nonce;
}

suite('ParadisDesignModeMainService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let directory: string;

	setup(() => {
		directory = join(tmpdir(), `paradis-design-mode-test-${generateUuid()}`, 'images');
	});

	teardown(async () => {
		await fs.rm(join(directory, '..'), { recursive: true, force: true });
	});

	test('専用の isolated world でユーザー操作を付けずに選ばせ、返ってきた値を検証してから返す', async () => {
		const worlds: number[] = [];
		const gestures: (boolean | undefined)[] = [];
		const service = store.add(new ParadisDesignModeMainService(() => fakeTarget(async (worldId, code, userGesture) => {
			worlds.push(worldId);
			gestures.push(userGesture);
			return { nonce: nonceOf(code), element: { tagName: 'DIV', selector: 'div#a', url: 'https://example.com/?q=1', attributes: { onclick: 'x' } } };
		}), directory));
		const result = await service.pickElement('window:1', 'view-1', []);
		assert.deepStrictEqual({
			worlds,
			gestures,
			kind: result.kind,
			tagName: result.kind === 'picked' ? result.element.tagName : undefined,
			url: result.kind === 'picked' ? result.element.url : undefined,
			attributes: result.kind === 'picked' ? result.element.attributes : undefined,
		}, { worlds: [PARADIS_DESIGN_MODE_WORLD_ID], gestures: [false], kind: 'picked', tagName: 'div', url: 'https://example.com/', attributes: {} });
	});

	test('ページの遷移・取り消し・破棄済みのビュー・nonce の合わない結果は取り消しとして返す', async () => {
		const rejected = store.add(new ParadisDesignModeMainService(() => fakeTarget(async () => { throw new Error('Script failed to execute'); }), directory));
		const cancelled = store.add(new ParadisDesignModeMainService(() => fakeTarget(async (_worldId, code) => ({ nonce: nonceOf(code), cancelled: true })), directory));
		const destroyed = store.add(new ParadisDesignModeMainService(() => fakeTarget(async (_worldId, code) => ({ nonce: nonceOf(code), element: { tagName: 'a', selector: 'a' } }), true), directory));
		const missing = store.add(new ParadisDesignModeMainService(() => undefined, directory));
		// 前から置かれていた偽の仕掛けが、nonce を知らずに結果を返してきた場合
		const forged = store.add(new ParadisDesignModeMainService(() => fakeTarget(async () => ({ nonce: 'guess', element: { tagName: 'a', selector: 'a' } })), directory));
		assert.deepStrictEqual(await Promise.all([
			rejected.pickElement('w', 'v', []),
			cancelled.pickElement('w', 'v', []),
			destroyed.pickElement('w', 'v', []),
			missing.pickElement('w', 'v', []),
			forged.pickElement('w', 'v', []),
		]), [{ kind: 'cancelled' }, { kind: 'cancelled' }, { kind: 'cancelled' }, { kind: 'cancelled' }, { kind: 'cancelled' }]);
	});

	test('再読み込みしたウィンドウは、自分が始めた選択だけを取り消す', async () => {
		const cancels: string[] = [];
		const resolvers = new Map<string, (value: unknown) => void>();
		const service = store.add(new ParadisDesignModeMainService(viewId => fakeTarget(async (_worldId, code) => {
			if (code === paradisBuildCancelPickScript()) {
				cancels.push(viewId);
				resolvers.get(viewId)?.({ cancelled: true });
				return undefined;
			}
			return new Promise(resolve => resolvers.set(viewId, resolve));
		}), directory));
		const first = service.pickElement('window:1', 'view-a', []);
		const second = service.pickElement('window:2', 'view-b', []);
		await service.resetPicks('window:1');
		resolvers.get('view-b')?.({ cancelled: true });
		assert.deepStrictEqual({ cancels, results: await Promise.all([first, second]) }, {
			cancels: ['view-a'],
			results: [{ kind: 'cancelled' }, { kind: 'cancelled' }],
		});
	});

	test('PNG を所有者だけが読める場所へ保存し、古い画像を掃除する', async () => {
		let now = 1_000_000_000_000;
		const service = store.add(new ParadisDesignModeMainService(() => undefined, directory, () => now));
		const first = await service.saveImage(VSBuffer.wrap(PNG));
		now += 25 * 60 * 60 * 1000;
		const second = await service.saveImage(VSBuffer.wrap(PNG));
		// 保存のたびに走る掃除は待たずに投げるので、ここでは終わりを待てるよう明示的に呼ぶ
		await service.cleanup();
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

	test('保存が無くても、掃除を呼べば古い画像だけを消す', async () => {
		await fs.mkdir(directory, { recursive: true });
		const now = 1_000_000_000_000;
		const old = `design-${now - 25 * 60 * 60 * 1000}-${generateUuid()}.png`;
		const fresh = `design-${now - 60 * 1000}-${generateUuid()}.png`;
		for (const name of [old, fresh, 'keep-me.png']) {
			await fs.writeFile(join(directory, name), PNG);
		}
		const service = store.add(new ParadisDesignModeMainService(() => undefined, directory, () => now));
		await service.cleanup();
		assert.deepStrictEqual((await fs.readdir(directory)).sort(), [fresh, 'keep-me.png'].sort());
	});

	test('PNG でないもの・大きすぎるものは保存しない', async () => {
		const service = store.add(new ParadisDesignModeMainService(() => undefined, directory));
		await assert.rejects(() => service.saveImage(VSBuffer.wrap(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))));
		await assert.rejects(() => service.saveImage(VSBuffer.alloc(0)));
		const huge = new Uint8Array(20 * 1024 * 1024 + 1);
		huge.set(PNG);
		await assert.rejects(() => service.saveImage(VSBuffer.wrap(huge)));
	});
});
