/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import type { WebContents } from 'electron';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisSetExtensionPageHold } from '../../../../../platform/browserView/common/paradisExtensionPageHold.js';
import { IParadisAddExtensionResult } from '../../common/paradisBrowserExtensions.js';
import { PARADIS_CHROME_WEB_STORE_ORIGIN, PARADIS_WEB_STORE_CHANNEL, PARADIS_WEB_STORE_QUERY, IParadisWebStoreReply } from '../../common/paradisBrowserExtensionWebStore.js';
import { IParadisWebStoreBridgeHost, IParadisWebStoreInstalled, ParadisWebStoreBridge } from '../../electron-main/paradisBrowserExtensionWebStoreBridge.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER = 'b'.repeat(32);
const STORE = `${PARADIS_CHROME_WEB_STORE_ORIGIN}/detail/name/${ID}`;
const MANIFEST = JSON.stringify({ manifest_version: 3, name: 'Store Ext', version: '1.0' });

/** 偽の WebContents（受け手を覚え、ストアのページへの知らせを記録する）。 */
function fakeContents(id: number, url: string) {
	const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
	const sent: unknown[] = [];
	let input: ((event: unknown, input: { type: string }) => void) | undefined;
	const mainFrame = { url, parent: null, frameTreeNodeId: id * 10, send: (_channel: string, payload: unknown) => sent.push(payload), isDestroyed: () => false };
	const contents = {
		id,
		mainFrame,
		isDestroyed: () => false,
		ipc: {
			on: (channel: string, listener: (event: unknown) => void) => handlers.set(`on:${channel}`, listener),
			handle: (channel: string, listener: (event: unknown, request: unknown) => unknown) => handlers.set(`handle:${channel}`, listener),
		},
		on: (event: string, listener: (event: unknown, input: { type: string }) => void) => { if (event === 'input-event') { input = listener; } },
	} as unknown as WebContents;
	return {
		contents,
		mainFrame,
		sent,
		click: () => input?.({}, { type: 'mouseDown' }),
		query: (frame: unknown = mainFrame) => { const event = { senderFrame: frame, returnValue: undefined as unknown }; handlers.get(`on:${PARADIS_WEB_STORE_QUERY}`)?.(event); return event.returnValue; },
		call: (method: string, args: unknown[], frame: unknown = mainFrame) => handlers.get(`handle:${PARADIS_WEB_STORE_CHANNEL}`)?.({ senderFrame: frame }, { method, args }) as Promise<IParadisWebStoreReply>,
	};
}

suite('ParadisWebStoreBridge', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(places: Map<WebContents, string>) {
		let now = 1_000;
		const enabled: IParadisWebStoreInstalled[] = [];
		const installs: string[] = [];
		const removed: string[] = [];
		let installResult: (id: string) => IParadisAddExtensionResult = id => ({ ok: true, extension: { id, name: 'Store Ext', version: '1.0', manifestVersion: 3, source: 'webstore', sourcePath: '/x', path: '/x', installedAt: 1, touchesPages: false } });
		let confirm = true;
		const all: WebContents[] = [];
		const host: IParadisWebStoreBridgeHost = {
			placeOf: contents => places.get(contents),
			listEnabled: () => enabled,
			install: async (id, place, label) => {
				installs.push(`${id}@${place}:${label}`);
				const result = installResult(id);
				if (result.ok) {
					enabled.push({ id, name: 'Store Ext', version: '1.0', source: 'webstore' });
				}
				return result;
			},
			removeFrom: async id => { removed.push(id); enabled.splice(enabled.findIndex(entry => entry.id === id), 1); },
			confirmRemove: async () => confirm,
			allContents: () => all,
		};
		const bridge = new ParadisWebStoreBridge(host, () => now);
		return {
			bridge, installs, removed, enabled, all,
			advance: (ms: number) => { now += ms; },
			setInstallResult: (next: typeof installResult) => { installResult = next; },
			setConfirm: (value: boolean) => { confirm = value; },
		};
	}

	test('answers only the store\'s top frame in a user tab with extensions, never a look-alike, an iframe or a shared tab', async () => {
		const store = fakeContents(1, STORE);
		const fake = fakeContents(2, 'https://chromewebstore.google.com.evil.example/detail/x');
		const agentOrNoExtensions = fakeContents(3, STORE);
		const shared = fakeContents(4, STORE);
		const places = new Map<WebContents, string>([[store.contents, 'default'], [fake.contents, 'default'], [shared.contents, 'default']]);
		const { bridge, installs } = setup(places);
		for (const entry of [store, fake, agentOrNoExtensions, shared]) {
			bridge.attach(entry.contents);
			entry.click();
		}
		paradisSetExtensionPageHold(shared.contents, true);
		try {
			// ストアのページの中の、別の origin の iframe（と、ストアの origin の iframe）
			const iframe = { url: 'https://ads.example/frame', parent: store.mainFrame, frameTreeNodeId: 99 };
			const storeIframe = { url: STORE, parent: store.mainFrame, frameTreeNodeId: 98 };
			const begin = (entry: ReturnType<typeof fakeContents>, frame?: unknown) => entry.call('beginInstallWithManifest3', [{ id: ID, manifest: MANIFEST }], frame);
			assert.deepStrictEqual({
				query: [store.query(), fake.query(), agentOrNoExtensions.query(), shared.query(), store.query(iframe), store.query(storeIframe)],
				fake: await begin(fake),
				noExtensions: await begin(agentOrNoExtensions),
				shared: await begin(shared),
				iframe: await begin(store, iframe),
				storeIframe: await begin(store, storeIframe),
				installs,
			}, {
				query: [true, false, false, false, false, false],
				fake: { error: 'Not allowed' }, noExtensions: { error: 'Not allowed' }, shared: { error: 'Not allowed' }, iframe: { error: 'Not allowed' }, storeIframe: { error: 'Not allowed' },
				installs: [],
			});
		} finally {
			paradisSetExtensionPageHold(shared.contents, false);
		}
	});

	test('installs only within a real input on the tab, through main, and pairs begin with complete', async () => {
		const store = fakeContents(1, STORE);
		const otherStoreTab = fakeContents(2, STORE);
		const otherPlace = fakeContents(3, STORE);
		const { bridge, installs, all, advance, setInstallResult } = setup(new Map([[store.contents, 'default'], [otherStoreTab.contents, 'default'], [otherPlace.contents, 'profile:0123456789ab']]));
		all.push(store.contents, otherStoreTab.contents, otherPlace.contents);
		bridge.attach(store.contents);
		const begin = (id = ID) => store.call('beginInstallWithManifest3', [{ id, manifest: MANIFEST }]);
		// ページの JS がボタンを押したことにして呼んでも、そのタブへの本物の入力が無ければ入れない
		const scripted = await begin();
		const statusBefore = await store.call('getExtensionStatus', [ID]);
		store.click();
		advance(6_000);
		const late = await begin();
		store.click();
		setInstallResult(() => ({ ok: false, reason: 'cancelled' }));
		const cancelled = await begin();
		setInstallResult(id => ({ ok: true, extension: { id, name: 'Store Ext', version: '1.0', manifestVersion: 3, source: 'webstore', sourcePath: '/x', path: '/x', installedAt: 1, touchesPages: false } }));
		const unmatched = await store.call('completeInstall', [ID]);
		const begun = await begin();
		const completed = await store.call('completeInstall', [ID]);
		const again = await store.call('completeInstall', [ID]);
		await new Promise(resolve => setTimeout(resolve, 5));
		assert.deepStrictEqual({
			scripted, statusBefore, late, cancelled, unmatched, begun, completed, again,
			installs,
			statusAfter: await store.call('getExtensionStatus', [ID]),
			mv2: await store.call('beginInstallWithManifest3', [{ id: OTHER, manifest: JSON.stringify({ manifest_version: 2, name: 'Old', version: '1' }) }]),
			// 知らせはその場所のストアのタブにだけ
			sent: [store.sent.length, otherStoreTab.sent, otherPlace.sent],
		}, {
			scripted: { value: 'unknown_error', error: 'This function must be called during a user gesture' },
			statusBefore: { value: 'installable' },
			late: { value: 'unknown_error', error: 'This function must be called during a user gesture' },
			cancelled: { value: 'user_cancelled', error: 'User cancelled install' },
			unmatched: { error: `${ID} does not match a previous call to beginInstallWithManifest3` },
			begun: { value: '' },
			completed: {},
			again: { error: `${ID} does not match a previous call to beginInstallWithManifest3` },
			installs: [`${ID}@default:既定（通常のタブ・ワークスペースのタブ）`, `${ID}@default:既定（通常のタブ・ワークスペースのタブ）`],
			statusAfter: { value: 'enabled' },
			mv2: { value: 'manifest_error', error: 'Manifest version 2 is no longer supported' },
			sent: [1, [{ event: 'onInstalled', args: [{ id: ID, name: 'Store Ext', shortName: 'Store Ext', version: '1.0', enabled: true, mayDisable: true, isApp: false, type: 'extension', installType: 'normal' }] }], []],
		});
	});

	test('removes only within a real input and after main asks, shows only store extensions, and never turns extensions on or off for the page', async () => {
		const store = fakeContents(1, STORE);
		const { bridge, enabled, removed, setConfirm } = setup(new Map([[store.contents, 'default']]));
		bridge.attach(store.contents);
		const THIRD = 'c'.repeat(32);
		enabled.push({ id: ID, name: 'Store Ext', version: '1.0', source: 'webstore' }, { id: THIRD, name: 'Other Store Ext', version: '2', source: 'webstore' }, { id: OTHER, name: 'Dev', version: '1', source: 'unpacked' });
		const scripted = await store.call('management.uninstall', [ID]);
		store.click();
		setConfirm(false);
		const declined = await store.call('management.uninstall', [ID]);
		store.click();
		setConfirm(true);
		const accepted = await store.call('management.uninstall', [ID]);
		assert.deepStrictEqual({
			scripted, declined, accepted, removed,
			// フォルダから入れたもの（その人だけの id）は見せない
			all: await store.call('management.getAll', []),
			devStatus: await store.call('getExtensionStatus', [OTHER]),
			enable: await store.call('management.setEnabled', [THIRD, true]),
			disable: await store.call('management.setEnabled', [THIRD, false]),
		}, {
			scripted: { error: 'This function must be called during a user gesture' },
			declined: { error: `Extension ${ID} uninstall canceled by user.` },
			accepted: {},
			removed: [ID],
			all: { value: [{ id: THIRD, name: 'Other Store Ext', shortName: 'Other Store Ext', version: '2', enabled: true, mayDisable: true, isApp: false, type: 'extension', installType: 'normal' }] },
			devStatus: { value: 'installable' },
			enable: {},
			disable: { error: 'Turn extensions on or off in the Para Code extension manager' },
		});
	});
});
