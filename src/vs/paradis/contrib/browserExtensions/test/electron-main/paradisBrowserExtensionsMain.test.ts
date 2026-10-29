/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import type { Extension } from 'electron';
import { Emitter } from '../../../../../base/common/event.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BrowserViewStorageScope } from '../../../../../platform/browserView/common/browserView.js';
import { PARADIS_DEFAULT_EXTENSION_PROFILE } from '../../common/paradisBrowserExtensions.js';
import {
	IParadisExtensionSessionOwner,
	ParadisBrowserExtensionsManager,
	ParadisExtensionSession,
	paradisExtensionProfileForSession,
	paradisPredictExtensionId,
} from '../../electron-main/paradisBrowserExtensionsMain.js';

const PROFILE_ID = '0123456789ab';

/** 読み込んだ拡張機能を覚えておく偽の Electron セッション。 */
class FakeSession implements ParadisExtensionSession {
	readonly loaded = new Map<string, string>();
	readonly extensions: ParadisExtensionSession['extensions'] = {
		loadExtension: async (path: string) => {
			const id = paradisPredictExtensionId(path, undefined);
			this.loaded.set(id, path);
			return { id, manifest: {}, name: id, path, url: `chrome-extension://${id}/`, version: '1' } satisfies Extension;
		},
		removeExtension: (id: string) => {
			this.loaded.delete(id);
		},
		getExtension: (id: string) => {
			const path = this.loaded.get(id);
			return path === undefined ? null : { id, manifest: {}, name: id, path, url: `chrome-extension://${id}/`, version: '1' } satisfies Extension;
		},
	};
	constructor(readonly storagePath: string) { }
	ids(): string[] {
		return [...this.loaded.keys()];
	}
}

function owner(storageScope: BrowserViewStorageScope, id = 'global', remote?: IParadisExtensionSessionOwner['remote']): IParadisExtensionSessionOwner {
	return { id, storageScope, remote };
}

async function writeExtension(folder: string, manifest: object): Promise<void> {
	await fs.mkdir(folder, { recursive: true });
	await fs.writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest));
	await fs.writeFile(join(folder, 'content.js'), '// content');
}

const silentLog = { warn: () => { } };

suite('ParadisBrowserExtensionsMain', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'paradis-browser-extensions-'));
	});
	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test('maps sessions to extension profiles and leaves agent and ephemeral tabs out', () => {
		assert.deepStrictEqual([
			paradisExtensionProfileForSession(owner(BrowserViewStorageScope.Global)),
			paradisExtensionProfileForSession(owner(BrowserViewStorageScope.Workspace, 'workspace:1')),
			paradisExtensionProfileForSession(owner(BrowserViewStorageScope.Profile, `profile:${PROFILE_ID}`)),
			paradisExtensionProfileForSession(owner(BrowserViewStorageScope.Profile, 'profile:broken')),
			paradisExtensionProfileForSession(owner(BrowserViewStorageScope.Agent, 'agent:1')),
			paradisExtensionProfileForSession(owner(BrowserViewStorageScope.Ephemeral, 'ephemeral:1')),
		], [PARADIS_DEFAULT_EXTENSION_PROFILE, PARADIS_DEFAULT_EXTENSION_PROFILE, `profile:${PROFILE_ID}`, undefined, undefined, undefined]);
	});

	test('predicts Chromium extension ids from a key or a path', () => {
		// 公開鍵の例は Chromium の id_util_unittest.cc（GenerateId("test") → "jpignaibiiemhngfjkcpokkamffknabf"）と同じ方式で確かめる
		assert.strictEqual(paradisPredictExtensionId('/unused', Buffer.from('test').toString('base64')), 'jpignaibiiemhngfjkcpokkamffknabf');
		assert.match(paradisPredictExtensionId('/Users/example/ext', undefined, 'darwin'), /^[a-p]{32}$/);
		assert.strictEqual(paradisPredictExtensionId('c:\\ext', undefined, 'win32'), paradisPredictExtensionId('C:\\ext', undefined, 'win32'));
	});

	test('does nothing while the experimental setting is off', async () => {
		const manager = new ParadisBrowserExtensionsManager(root, () => false, silentLog);
		const session = new FakeSession(join(root, 'session'));
		await manager.attach(session, owner(BrowserViewStorageScope.Global));
		await writeExtension(join(root, 'source'), { manifest_version: 3, name: 'Sample', version: '1.0' });
		const result = await manager.addUnpacked(join(root, 'source'), PARADIS_DEFAULT_EXTENSION_PROFILE);
		assert.deepStrictEqual({ result, loaded: session.ids(), state: await manager.getState() }, {
			result: { ok: false, reason: 'inactive' },
			loaded: [],
			state: { active: false, setting: false, extensions: [] },
		});
		manager.dispose();
	});

	test('adds an unpacked extension for one profile, persists it and loads it only there', async () => {
		const manager = new ParadisBrowserExtensionsManager(root, () => true, silentLog);
		const defaultSession = new FakeSession(join(root, 'default'));
		const profileSession = new FakeSession(join(root, 'profile'));
		const agentSession = new FakeSession(join(root, 'agent'));
		await manager.attach(defaultSession, owner(BrowserViewStorageScope.Global));
		await manager.attach(profileSession, owner(BrowserViewStorageScope.Profile, `profile:${PROFILE_ID}`));
		await manager.attach(agentSession, owner(BrowserViewStorageScope.Agent, 'agent:1'));

		const source = join(root, 'source');
		await writeExtension(source, { manifest_version: 3, name: '__MSG_appName__', version: '1.2.3', default_locale: 'en' });
		await fs.mkdir(join(source, '_locales', 'en'), { recursive: true });
		await fs.writeFile(join(source, '_locales', 'en', 'messages.json'), JSON.stringify({ appName: { message: 'Sample Extension' } }));

		const result = await manager.addUnpacked(source, PARADIS_DEFAULT_EXTENSION_PROFILE);
		assert.ok(result.ok);
		const id = result.extension.id;
		assert.ok((await fs.stat(join(result.extension.path, 'content.js'))).isFile());
		assert.deepStrictEqual({ defaultLoaded: defaultSession.ids(), profileLoaded: profileSession.ids(), agentLoaded: agentSession.ids() }, { defaultLoaded: [id], profileLoaded: [], agentLoaded: [] });

		await manager.setEnabled(id, `profile:${PROFILE_ID}`, true);
		await manager.setEnabled(id, PARADIS_DEFAULT_EXTENSION_PROFILE, false);
		const state = await manager.getState();
		assert.deepStrictEqual({
			defaultLoaded: defaultSession.ids(),
			profileLoaded: profileSession.ids(),
			name: state.extensions[0].name,
			version: state.extensions[0].version,
			enabledIn: state.extensions[0].enabledIn,
		}, { defaultLoaded: [], profileLoaded: [id], name: 'Sample Extension', version: '1.2.3', enabledIn: [`profile:${PROFILE_ID}`] });
		manager.dispose();

		// 次の起動でも台帳から読み込む
		const restarted = new ParadisBrowserExtensionsManager(root, () => true, silentLog);
		const nextProfileSession = new FakeSession(join(root, 'profile'));
		await restarted.attach(nextProfileSession, owner(BrowserViewStorageScope.Profile, `profile:${PROFILE_ID}`));
		assert.deepStrictEqual(nextProfileSession.ids(), [id]);
		restarted.dispose();
	});

	test('keeps extensions out of a workspace session while it tunnels to an SSH host', async () => {
		const manager = new ParadisBrowserExtensionsManager(root, () => true, silentLog);
		await writeExtension(join(root, 'source'), { manifest_version: 3, name: 'Sample', version: '1.0' });
		const added = await manager.addUnpacked(join(root, 'source'), PARADIS_DEFAULT_EXTENSION_PROFILE);
		assert.ok(added.ok);

		const onDidStart = new Emitter<void>();
		const onDidStop = new Emitter<void>();
		const remote = { isRemote: true, onDidStart: onDidStart.event, onDidStop: onDidStop.event };
		const session = new FakeSession(join(root, 'workspace'));
		await manager.attach(session, owner(BrowserViewStorageScope.Workspace, 'workspace:1', remote));
		const whileRemote = session.ids();

		remote.isRemote = false;
		onDidStop.fire();
		await new Promise(resolve => setTimeout(resolve, 0));
		const afterStop = session.ids();

		remote.isRemote = true;
		onDidStart.fire();
		assert.deepStrictEqual({ whileRemote, afterStop, afterStart: session.ids() }, { whileRemote: [], afterStop: [added.extension.id], afterStart: [] });
		onDidStart.dispose();
		onDidStop.dispose();
		manager.dispose();
	});

	test('removes an extension, its copy and, on the next start, its saved data', async () => {
		const manager = new ParadisBrowserExtensionsManager(root, () => true, silentLog);
		const storagePath = join(root, 'default');
		const session = new FakeSession(storagePath);
		await manager.attach(session, owner(BrowserViewStorageScope.Global));
		await writeExtension(join(root, 'source'), { manifest_version: 2, name: 'Sample', version: '1.0' });
		const added = await manager.addUnpacked(join(root, 'source'), PARADIS_DEFAULT_EXTENSION_PROFILE);
		assert.ok(added.ok);
		const id = added.extension.id;
		const savedData = join(storagePath, 'Local Extension Settings', id);
		await fs.mkdir(savedData, { recursive: true });

		await manager.remove(id);
		const copyExists = await fs.stat(added.extension.path).then(() => true, () => false);
		assert.deepStrictEqual({ loaded: session.ids(), copyExists, state: (await manager.getState()).extensions }, { loaded: [], copyExists: false, state: [] });
		manager.dispose();

		const restarted = new ParadisBrowserExtensionsManager(root, () => true, silentLog);
		await restarted.attach(new FakeSession(storagePath), owner(BrowserViewStorageScope.Global));
		assert.strictEqual(await fs.stat(savedData).then(() => true, () => false), false);
		restarted.dispose();
	});

	test('explains folders that are not extensions', async () => {
		const manager = new ParadisBrowserExtensionsManager(root, () => true, silentLog);
		await fs.mkdir(join(root, 'empty'));
		await writeExtension(join(root, 'bad'), { manifest_version: 1, name: 'Old', version: '1.0' });
		assert.deepStrictEqual([
			await manager.addUnpacked(join(root, 'missing'), PARADIS_DEFAULT_EXTENSION_PROFILE),
			await manager.addUnpacked(join(root, 'empty'), PARADIS_DEFAULT_EXTENSION_PROFILE),
			await manager.addUnpacked(join(root, 'bad'), PARADIS_DEFAULT_EXTENSION_PROFILE),
			await manager.addUnpacked(join(root, 'bad'), 'profile:nothex'),
		], [
			{ ok: false, reason: 'notFolder' },
			{ ok: false, reason: 'noManifest' },
			{ ok: false, reason: 'invalidManifest', detail: 'manifestVersion' },
			{ ok: false, reason: 'notFolder' },
		]);
		manager.dispose();
	});
});
