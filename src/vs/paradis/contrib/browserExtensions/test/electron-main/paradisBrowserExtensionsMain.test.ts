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
	paradisCopyExtensionFiles,
	paradisPlanExtensionCopy,
	paradisPredictExtensionId,
} from '../../electron-main/paradisBrowserExtensionsMain.js';

const PROFILE_ID = '0123456789ab';

/** 読み込んだ拡張機能と、消した保存データを覚えておく偽の Electron セッション。 */
class FakeSession implements ParadisExtensionSession {
	readonly loaded = new Map<string, string>();
	/** 起きた順の記録（`clear:<origin>` / `load:<id>`）。 */
	readonly events: string[] = [];
	/** 実物の id の代わりに返す id（食い違ったときの確認用）。 */
	idOverride: string | undefined;
	/** 立てると clearStorageData が失敗する。 */
	failClear = false;
	readonly clearStorageData: ParadisExtensionSession['clearStorageData'] = async options => {
		this.events.push(`clear:${options?.origin}`);
		if (this.failClear) {
			throw new Error('clear failed');
		}
	};
	readonly extensions: ParadisExtensionSession['extensions'] = {
		loadExtension: async (path: string) => {
			const id = this.idOverride ?? paradisPredictExtensionId(path, undefined);
			this.loaded.set(id, path);
			this.events.push(`load:${id}`);
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

	test('removes an extension, its copy and its saved data, now in open sessions and later in the others', async () => {
		const manager = new ParadisBrowserExtensionsManager(root, () => true, silentLog);
		const storagePath = join(root, 'default');
		const profilePath = join(root, 'profile');
		const session = new FakeSession(storagePath);
		await manager.attach(session, owner(BrowserViewStorageScope.Global));
		await writeExtension(join(root, 'source'), { manifest_version: 2, name: 'Sample', version: '1.0' });
		const added = await manager.addUnpacked(join(root, 'source'), PARADIS_DEFAULT_EXTENSION_PROFILE);
		assert.ok(added.ok);
		const id = added.extension.id;
		const savedData = join(storagePath, 'Local Extension Settings', id);
		const profileSavedData = join(profilePath, 'Local Extension Settings', id);
		await fs.mkdir(savedData, { recursive: true });
		await fs.mkdir(profileSavedData, { recursive: true });

		await manager.remove(id);
		const exists = (path: string) => fs.stat(path).then(() => true, () => false);
		assert.deepStrictEqual({
			loaded: session.ids(),
			events: session.events,
			copyExists: await exists(added.extension.path),
			savedDataExists: await exists(savedData),
			state: (await manager.getState()).extensions,
		}, { loaded: [], events: [`load:${id}`, `clear:chrome-extension://${id}`], copyExists: false, savedDataExists: false, state: [] });
		manager.dispose();

		// 次の起動: chrome.storage は Chromium が開いたままだったので、どのセッションも読み込む前にもう一度消す。
		// 消し終えた保存先は、その次からは消さない
		const restarted = new ParadisBrowserExtensionsManager(root, () => true, silentLog);
		const nextDefault = new FakeSession(storagePath);
		const nextProfile = new FakeSession(profilePath);
		await restarted.attach(nextDefault, owner(BrowserViewStorageScope.Global));
		await restarted.attach(nextProfile, owner(BrowserViewStorageScope.Profile, `profile:${PROFILE_ID}`));
		const againDefault = new FakeSession(storagePath);
		await restarted.attach(againDefault, owner(BrowserViewStorageScope.Global));
		assert.deepStrictEqual({ defaultEvents: nextDefault.events, profileEvents: nextProfile.events, againEvents: againDefault.events, profileSavedDataExists: await exists(profileSavedData) }, {
			defaultEvents: [`clear:chrome-extension://${id}`],
			profileEvents: [`clear:chrome-extension://${id}`],
			againEvents: [],
			profileSavedDataExists: false,
		});
		restarted.dispose();
	});

	test('refuses a reinstall until restart and clears old data before loading it again', async () => {
		const manager = new ParadisBrowserExtensionsManager(root, () => true, silentLog);
		await writeExtension(join(root, 'source'), { manifest_version: 3, name: 'Sample', version: '1.0' });
		const added = await manager.addUnpacked(join(root, 'source'), PARADIS_DEFAULT_EXTENSION_PROFILE);
		assert.ok(added.ok);
		await manager.remove(added.extension.id);
		const sameRun = await manager.addUnpacked(join(root, 'source'), PARADIS_DEFAULT_EXTENSION_PROFILE);
		manager.dispose();

		// 再起動の後に、まだ開いていなかったセッションがあるうちに入れ直す
		const restarted = new ParadisBrowserExtensionsManager(root, () => true, silentLog);
		const again = await restarted.addUnpacked(join(root, 'source'), PARADIS_DEFAULT_EXTENSION_PROFILE);
		const session = new FakeSession(join(root, 'default'));
		await restarted.attach(session, owner(BrowserViewStorageScope.Global));
		const id = added.extension.id;
		assert.deepStrictEqual({ sameRun, againOk: again.ok, events: session.events }, {
			sameRun: { ok: false, reason: 'restartNeeded' },
			againOk: true,
			events: [`clear:chrome-extension://${id}`, `load:${id}`],
		});
		restarted.dispose();
	});

	test('reports and unloads an extension whose loaded id differs from the predicted one', async () => {
		const manager = new ParadisBrowserExtensionsManager(root, () => true, silentLog);
		const session = new FakeSession(join(root, 'default'));
		session.idOverride = 'p'.repeat(32);
		await manager.attach(session, owner(BrowserViewStorageScope.Global));
		await writeExtension(join(root, 'source'), { manifest_version: 3, name: 'Sample', version: '1.0' });
		const added = await manager.addUnpacked(join(root, 'source'), PARADIS_DEFAULT_EXTENSION_PROFILE);
		assert.ok(added.ok);
		assert.deepStrictEqual({ loaded: session.ids(), loadError: (await manager.getState()).extensions[0].loadError }, {
			loaded: [],
			loadError: `unexpected extension id ${'p'.repeat(32)}`,
		});
		manager.dispose();
	});

	test('drops the previous copy when the same key is added from another folder', async () => {
		const manager = new ParadisBrowserExtensionsManager(root, () => true, silentLog);
		const key = Buffer.from('same-key').toString('base64');
		await writeExtension(join(root, 'one'), { manifest_version: 3, name: 'One', version: '1.0', key });
		await writeExtension(join(root, 'two'), { manifest_version: 3, name: 'Two', version: '2.0', key });
		const first = await manager.addUnpacked(join(root, 'one'), PARADIS_DEFAULT_EXTENSION_PROFILE);
		const second = await manager.addUnpacked(join(root, 'two'), PARADIS_DEFAULT_EXTENSION_PROFILE);
		assert.ok(first.ok && second.ok);
		const exists = (path: string) => fs.stat(path).then(() => true, () => false);
		assert.deepStrictEqual({
			sameId: first.extension.id === second.extension.id,
			firstCopy: await exists(first.extension.path),
			secondCopy: await exists(second.extension.path),
			names: (await manager.getState()).extensions.map(extension => extension.name),
		}, { sameId: true, firstCopy: false, secondCopy: true, names: ['Two'] });
		manager.dispose();
	});

	test('copies links that stay inside the folder as files and refuses links that leave it', async () => {
		const manager = new ParadisBrowserExtensionsManager(root, () => true, silentLog);
		await fs.writeFile(join(root, 'secret.txt'), 'outside');
		const inside = join(root, 'inside');
		await writeExtension(inside, { manifest_version: 3, name: 'Inside', version: '1.0' });
		await fs.mkdir(join(inside, 'lib'));
		await fs.writeFile(join(inside, 'lib', 'real.js'), '// real');
		await fs.symlink('lib/real.js', join(inside, 'alias.js'));
		await fs.symlink('lib', join(inside, 'libalias'));
		await fs.symlink('.', join(inside, 'lib', 'loop'));
		await fs.mkdir(join(inside, '.git'));
		await fs.writeFile(join(inside, '.git', 'HEAD'), 'ref');
		const outsideAbsolute = join(root, 'outside-absolute');
		await writeExtension(outsideAbsolute, { manifest_version: 3, name: 'Abs', version: '1.0' });
		await fs.symlink(join(root, 'secret.txt'), join(outsideAbsolute, 'abs.txt'));
		const outsideRelative = join(root, 'outside-relative');
		await writeExtension(outsideRelative, { manifest_version: 3, name: 'Rel', version: '1.0' });
		await fs.mkdir(join(outsideRelative, 'sub'));
		await fs.symlink('../../secret.txt', join(outsideRelative, 'sub', 'rel.txt'));

		const added = await manager.addUnpacked(inside, PARADIS_DEFAULT_EXTENSION_PROFILE);
		assert.ok(added.ok);
		const alias = await fs.lstat(join(added.extension.path, 'alias.js'));
		const aliasFolder = await fs.lstat(join(added.extension.path, 'libalias'));
		assert.deepStrictEqual({
			aliasIsLink: alias.isSymbolicLink(),
			aliasText: await fs.readFile(join(added.extension.path, 'alias.js'), 'utf8'),
			aliasFolderIsLink: aliasFolder.isSymbolicLink(),
			aliasFolderText: await fs.readFile(join(added.extension.path, 'libalias', 'real.js'), 'utf8'),
			gitCopied: await fs.stat(join(added.extension.path, '.git')).then(() => true, () => false),
			absolute: await manager.addUnpacked(outsideAbsolute, PARADIS_DEFAULT_EXTENSION_PROFILE),
			relative: await manager.addUnpacked(outsideRelative, PARADIS_DEFAULT_EXTENSION_PROFILE),
		}, {
			aliasIsLink: false,
			aliasText: '// real',
			aliasFolderIsLink: false,
			aliasFolderText: '// real',
			gitCopied: false,
			absolute: { ok: false, reason: 'linkOutside', detail: 'abs.txt' },
			relative: { ok: false, reason: 'linkOutside', detail: 'sub/rel.txt' },
		});
		manager.dispose();
	});

	test('refuses folders over the file count or size limit', async () => {
		const folder = join(root, 'big');
		await writeExtension(folder, { manifest_version: 3, name: 'Big', version: '1.0' });
		await fs.writeFile(join(folder, 'blob.bin'), Buffer.alloc(2048));
		const real = await fs.realpath(folder);
		assert.deepStrictEqual([
			(await paradisPlanExtensionCopy(real, { files: 2, bytes: 1_000_000 })),
			(await paradisPlanExtensionCopy(real, { files: 100, bytes: 1024 })),
			(await paradisPlanExtensionCopy(real, { files: 100, bytes: 1_000_000 })).ok,
		], [
			{ ok: false, reason: 'tooLarge', detail: 'files' },
			{ ok: false, reason: 'tooLarge', detail: 'bytes' },
			true,
		]);
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

	test('records only the storage paths it could clear, and blocks a reinstall from the start of removal', async () => {
		const manager = new ParadisBrowserExtensionsManager(root, () => true, silentLog);
		const failing = new FakeSession(join(root, 'failing'));
		failing.failClear = true;
		await manager.attach(failing, owner(BrowserViewStorageScope.Global));
		await writeExtension(join(root, 'source'), { manifest_version: 3, name: 'Sample', version: '1.0' });
		const added = await manager.addUnpacked(join(root, 'source'), PARADIS_DEFAULT_EXTENSION_PROFILE);
		assert.ok(added.ok);
		const id = added.extension.id;
		// 削除を待たずに入れ直そうとしても断る
		const removing = manager.remove(id);
		const during = await manager.addUnpacked(join(root, 'source'), PARADIS_DEFAULT_EXTENSION_PROFILE);
		await removing;
		manager.dispose();

		// 次の起動: 前に消せなかった保存先は、もう一度消す
		const restarted = new ParadisBrowserExtensionsManager(root, () => true, silentLog);
		const next = new FakeSession(join(root, 'failing'));
		await restarted.attach(next, owner(BrowserViewStorageScope.Global));
		assert.deepStrictEqual({ during, nextEvents: next.events }, {
			during: { ok: false, reason: 'restartNeeded' },
			nextEvents: [`clear:chrome-extension://${id}`],
		});
		restarted.dispose();
	});

	test('lists the extensions loaded in a view for the share confirmation', async () => {
		const session = new FakeSession(join(root, 'default'));
		const manager = new ParadisBrowserExtensionsManager(root, () => true, silentLog, viewId => viewId === 'view-1' ? session : undefined);
		await manager.attach(session, owner(BrowserViewStorageScope.Global));
		await writeExtension(join(root, 'filler'), { manifest_version: 3, name: 'Filler', version: '1.0', content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'] }] });
		await writeExtension(join(root, 'theme'), { manifest_version: 3, name: 'Theme', version: '1.0' });
		const filler = await manager.addUnpacked(join(root, 'filler'), PARADIS_DEFAULT_EXTENSION_PROFILE);
		const theme = await manager.addUnpacked(join(root, 'theme'), `profile:${PROFILE_ID}`);
		assert.ok(filler.ok && theme.ok);
		assert.deepStrictEqual({
			view: await manager.getShareExtensions('view-1', PARADIS_DEFAULT_EXTENSION_PROFILE),
			// main にまだ無いビューは、そのタブのプロファイルで有効にしてあるもので答える
			notOpenYet: await manager.getShareExtensions('view-2', `profile:${PROFILE_ID}`),
			agentTab: await manager.getShareExtensions('view-2', undefined),
		}, {
			view: { active: true, extensions: [{ id: filler.extension.id, name: 'Filler', touchesPages: true }] },
			notOpenYet: { active: true, extensions: [{ id: theme.extension.id, name: 'Theme', touchesPages: false }] },
			agentTab: { active: true, extensions: [] },
		});
		manager.dispose();
		const inactive = new ParadisBrowserExtensionsManager(root, () => false, silentLog, () => session);
		assert.deepStrictEqual(await inactive.getShareExtensions('view-1', PARADIS_DEFAULT_EXTENSION_PROFILE), { active: false, extensions: [] });
		inactive.dispose();
	});

	test('refuses hard links and names that would collide on a case-insensitive disk', async () => {
		const manager = new ParadisBrowserExtensionsManager(root, () => true, silentLog);
		const hard = join(root, 'hard');
		await writeExtension(hard, { manifest_version: 3, name: 'Hard', version: '1.0' });
		await fs.writeFile(join(root, 'outside.txt'), 'outside');
		await fs.link(join(root, 'outside.txt'), join(hard, 'linked.txt'));
		const clash = join(root, 'clash');
		await writeExtension(clash, { manifest_version: 3, name: 'Clash', version: '1.0' });
		await fs.writeFile(join(clash, 'Readme.txt'), 'a');
		await fs.writeFile(join(clash, 'README.txt'), 'b');
		const unicode = join(root, 'unicode');
		await writeExtension(unicode, { manifest_version: 3, name: 'Unicode', version: '1.0' });
		await fs.writeFile(join(unicode, 'caf\u00e9.txt'), 'a');
		await fs.writeFile(join(unicode, 'cafe\u0301.txt'), 'b');
		const results = [
			await manager.addUnpacked(hard, PARADIS_DEFAULT_EXTENSION_PROFILE),
			await manager.addUnpacked(clash, PARADIS_DEFAULT_EXTENSION_PROFILE),
			await manager.addUnpacked(unicode, PARADIS_DEFAULT_EXTENSION_PROFILE),
		].map(result => result.ok ? 'ok' : result.reason);
		assert.deepStrictEqual(results, ['hardLink', 'nameClash', 'nameClash']);
		manager.dispose();
	});

	test('refuses a file swapped between checking and copying', async () => {
		const folder = join(root, 'swap');
		await writeExtension(folder, { manifest_version: 3, name: 'Swap', version: '1.0' });
		const real = await fs.realpath(folder);
		const plan = await paradisPlanExtensionCopy(real);
		assert.ok(plan.ok);
		// 調べた後に、同じ名前の別のファイルへ差し替える
		await fs.writeFile(join(root, 'other.js'), '// other');
		await fs.rename(join(root, 'other.js'), join(real, 'content.js'));
		const target = join(root, 'target');
		await fs.mkdir(target);
		assert.deepStrictEqual(await paradisCopyExtensionFiles(plan.items, target), { ok: false, reason: 'changed', detail: 'content.js' });
	});

	test('cleans up copies left half-done by a crash on the next start', async () => {
		const leftover = join(root, 'unpacked', '0123456789abcdef.tmp-abc');
		const kept = join(root, 'unpacked', '0123456789abcdef');
		await fs.mkdir(leftover, { recursive: true });
		await fs.mkdir(kept, { recursive: true });
		const manager = new ParadisBrowserExtensionsManager(root, () => true, silentLog);
		await manager.getState();
		const exists = (path: string) => fs.stat(path).then(() => true, () => false);
		assert.deepStrictEqual({ leftover: await exists(leftover), kept: await exists(kept) }, { leftover: false, kept: true });
		manager.dispose();
	});
});
