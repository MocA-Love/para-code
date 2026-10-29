/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/main/browser/extensions/browser-extension-crx-fixture.ts, src/main/browser/extensions/browser-extension-crx.test.ts

import * as assert from 'assert';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'crypto';
import { promises as fs, readFileSync } from 'fs';
import { tmpdir } from 'os';
import type { Extension } from 'electron';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BrowserViewStorageScope } from '../../../../../platform/browserView/common/browserView.js';
import { PARADIS_DEFAULT_EXTENSION_PROFILE, paradisParseExtensionsLedger, paradisSerializeExtensionsLedger } from '../../common/paradisBrowserExtensions.js';
import { paradisParseWebStoreInput, paradisSummarizeExtensionAccess } from '../../common/paradisBrowserExtensionWebStore.js';
import { paradisExtensionIdFromHash, paradisVerifyCrx3 } from '../../electron-main/paradisBrowserExtensionCrx.js';
import { ParadisBrowserExtensionsManager, ParadisExtensionSession, paradisPredictExtensionId } from '../../electron-main/paradisBrowserExtensionsMain.js';
import { IParadisInstallPrompt, IParadisWebStoreResponse, paradisDownloadWebStoreCrx, paradisExtractCrxArchive, paradisIsSafeArchiveEntryName, paradisWebStoreCrxUrl } from '../../electron-main/paradisBrowserExtensionWebStore.js';
import { IParadisNativeHostLookup, paradisNativeHostSources, paradisOwnFolderNativeHostLookup } from '../../electron-main/paradisNativeMessagingHosts.js';

// --- CRX3 を作る（テストの鍵で署名する） ---

interface ITestKey {
	readonly algorithm: 'rsa' | 'ecdsa';
	readonly privateKey: KeyObject;
	readonly publicKeyDer: Buffer;
}

function generateKey(algorithm: ITestKey['algorithm']): ITestKey {
	const pair = algorithm === 'rsa' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	return { algorithm, privateKey: pair.privateKey, publicKeyDer: pair.publicKey.export({ type: 'spki', format: 'der' }) };
}

function varint(value: number): Buffer {
	const bytes: number[] = [];
	let rest = value;
	while (rest >= 0x80) {
		bytes.push((rest % 0x80) | 0x80);
		rest = Math.floor(rest / 0x80);
	}
	bytes.push(rest);
	return Buffer.from(bytes);
}

function field(number: number, bytes: Buffer): Buffer {
	return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}

function uint32(value: number): Buffer {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32LE(value);
	return buffer;
}

function idOf(key: ITestKey): string {
	return paradisExtensionIdFromHash(createHash('sha256').update(key.publicKeyDer).digest());
}

function hashOf(key: ITestKey): string {
	return createHash('sha256').update(key.publicKeyDer).digest('hex');
}

function buildCrx(options: { readonly archive: Buffer; readonly developer: ITestKey; readonly signers: readonly ITestKey[]; readonly tagFor?: (key: ITestKey) => number; readonly extraHeader?: Buffer; readonly signedArchive?: Buffer }): Buffer {
	const crxId = createHash('sha256').update(options.developer.publicKeyDer).digest().subarray(0, 16);
	const signedHeaderData = field(1, crxId);
	const signedData = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), uint32(signedHeaderData.length), signedHeaderData, options.signedArchive ?? options.archive]);
	const proofs = options.signers.map(key => field(options.tagFor?.(key) ?? (key.algorithm === 'rsa' ? 2 : 3), Buffer.concat([field(1, key.publicKeyDer), field(2, sign('sha256', signedData, key.privateKey))])));
	const header = Buffer.concat([...proofs, field(10000, signedHeaderData), ...(options.extraHeader ? [options.extraHeader] : [])]);
	return Buffer.concat([Buffer.from('Cr24', 'latin1'), uint32(3), uint32(header.length), header, options.archive]);
}

async function zipOf(entries: readonly { readonly name: string; readonly data: string; readonly mode?: number }[]): Promise<Buffer> {
	const yazlModule = await import('yazl') as typeof import('yazl') & { readonly default?: typeof import('yazl') };
	const yazl = yazlModule.default ?? yazlModule;
	const zip = new yazl.ZipFile();
	for (const entry of entries) {
		zip.addBuffer(Buffer.from(entry.data), entry.name, entry.mode !== undefined ? { mode: entry.mode } : {});
	}
	zip.end();
	const chunks: Buffer[] = [];
	for await (const chunk of zip.outputStream) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

const developer = generateKey('rsa');
const publisher = generateKey('rsa');
const other = generateKey('ecdsa');
const ID = idOf(developer);

function outcome(run: () => unknown): string {
	try {
		run();
		return 'ok';
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

suite('ParadisBrowserExtensionWebStore', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads store links and ids, and nothing else', () => {
		assert.deepStrictEqual([
			paradisParseWebStoreInput(`https://chromewebstore.google.com/detail/bitwarden/${ID}`),
			paradisParseWebStoreInput(`chromewebstore.google.com/detail/${ID}?hl=ja`),
			paradisParseWebStoreInput(`https://chrome.google.com/webstore/detail/name/${ID}`),
			paradisParseWebStoreInput(` ${ID.toUpperCase()} `),
			paradisParseWebStoreInput(`https://chromewebstore.google.com.evil.example/detail/${ID}`),
			paradisParseWebStoreInput(`http://chromewebstore.google.com/detail/${ID}`),
			paradisParseWebStoreInput(`https://user@chromewebstore.google.com/detail/${ID}`),
			paradisParseWebStoreInput('https://chromewebstore.google.com/category/extensions'),
		], [ID, ID, ID, ID, undefined, undefined, undefined, undefined]);
	});

	test('summarizes what an extension can do from its manifest', () => {
		assert.deepStrictEqual(paradisSummarizeExtensionAccess({ permissions: ['storage', 'tabs', 'https://a.example/*', 'storage'], host_permissions: ['<all_urls>'], content_scripts: [{ matches: ['https://b.example/*'] }, { matches: 'bad' }] }), {
			permissions: ['storage', 'tabs'],
			hostPermissions: ['<all_urls>', 'https://a.example/*', 'https://b.example/*'],
		});
	});

	test('verifies a CRX3 like Chromium: every signature, its own key, the store key, no zip marks in the header', () => {
		const archive = Buffer.from('PK\x03\x04 archive bytes', 'latin1');
		const good = buildCrx({ archive, developer, signers: [developer, publisher] });
		const check = (crx: Buffer, requirePublisherProof = true, expectedExtensionId = ID) => outcome(() => paradisVerifyCrx3(crx, { expectedExtensionId, requirePublisherProof, publisherKeyHash: hashOf(publisher) }));
		const verified = paradisVerifyCrx3(good, { expectedExtensionId: ID, requirePublisherProof: true, publisherKeyHash: hashOf(publisher) });
		assert.deepStrictEqual({
			id: verified.extensionId,
			key: verified.publicKey.equals(developer.publicKeyDer),
			archive: verified.archive.equals(archive),
			// 本物のストアの鍵（既定）では、テストの発行者の署名は通らない
			realStoreKey: outcome(() => paradisVerifyCrx3(good, { expectedExtensionId: ID, requirePublisherProof: true })),
			developerOnly: check(buildCrx({ archive, developer, signers: [developer] })),
			developerOnlyAllowed: check(buildCrx({ archive, developer, signers: [developer] }), false),
			notOwnKey: check(buildCrx({ archive, developer, signers: [publisher] })),
			otherId: check(good, true, idOf(other)),
			tampered: check(buildCrx({ archive, developer, signers: [developer, publisher], signedArchive: Buffer.from('other') })),
			keyTagMismatch: check(buildCrx({ archive, developer, signers: [developer, publisher, other], tagFor: key => key === other ? 2 : 2 })),
			ecdsaSigner: check(buildCrx({ archive, developer, signers: [developer, publisher, other] })),
			zipMarkInHeader: check(buildCrx({ archive, developer, signers: [developer, publisher], extraHeader: field(99, Buffer.from('PK\x05\x06', 'latin1')) })),
			notCrx: check(Buffer.from('PK\x03\x04 not a crx file')),
			crx2: check(Buffer.concat([Buffer.from('Cr24', 'latin1'), uint32(2), uint32(0), Buffer.from('x')])),
		}, {
			id: ID, key: true, archive: true,
			realStoreKey: 'CRX is not signed by the Chrome Web Store',
			developerOnly: 'CRX is not signed by the Chrome Web Store',
			developerOnlyAllowed: 'ok',
			notOwnKey: 'CRX is not signed by its own key',
			otherId: 'CRX belongs to a different extension',
			tampered: 'CRX signature does not verify',
			keyTagMismatch: 'CRX signature key does not match its algorithm',
			ecdsaSigner: 'ok',
			zipMarkInHeader: 'Malformed CRX header',
			notCrx: 'Not a CRX file',
			crx2: 'Only CRX3 packages are supported',
		});
	});

	test('downloads only over https from Google hosts, checking every redirect', async () => {
		const crx = buildCrx({ archive: Buffer.from('zip'), developer, signers: [developer, publisher] });
		const visited: string[] = [];
		const fetcherFor = (routes: Record<string, { status: number; location?: string; body?: Buffer }>) => async (url: string): Promise<IParadisWebStoreResponse> => {
			visited.push(new URL(url).host);
			const route = routes[new URL(url).host] ?? { status: 404 };
			return { status: route.status, location: route.location, read: async max => { if ((route.body?.length ?? 0) > max) { throw new Error('too large'); } return route.body ?? Buffer.alloc(0); }, cancel: () => { } };
		};
		const download = (routes: Record<string, { status: number; location?: string; body?: Buffer }>, url?: string) => paradisDownloadWebStoreCrx(ID, fetcherFor(routes), { url, publisherKeyHash: hashOf(publisher) }).then(verified => verified.extensionId, (error: Error) => error.message);
		const result = {
			followed: await download({ 'clients2.google.com': { status: 302, location: 'https://clients2.googleusercontent.com/crx/blobs/x' }, 'clients2.googleusercontent.com': { status: 200, body: crx } }),
			awayFromGoogle: await download({ 'clients2.google.com': { status: 302, location: 'https://evil.example/x.crx' } }),
			lookAlike: await download({ 'clients2.google.com': { status: 302, location: 'https://google.com.evil.example/x.crx' } }),
			plainHttp: await download({ 'clients2.google.com': { status: 302, location: 'http://clients2.googleusercontent.com/x' } }),
			startOutside: await download({}, 'https://evil.example/x.crx'),
			failed: await download({ 'clients2.google.com': { status: 500 } }),
			// 本文が届かないまま止まった通信は打ち切る（読むのをやめて閉じる）
			stalled: await paradisDownloadWebStoreCrx(ID, async () => ({ status: 200, read: () => new Promise<Buffer>(() => { }), cancel: () => visited.push('cancelled') }), { timeoutMs: 20 }).then(() => 'ok', (error: Error) => error.message),
		};
		assert.deepStrictEqual({ result, cancelledStalled: visited.includes('cancelled'), url: new URL(paradisWebStoreCrxUrl(ID, '140.0.0.0')).searchParams.get('x') }, {
			result: {
				followed: ID,
				awayFromGoogle: 'The extension download was redirected away from Google',
				lookAlike: 'The extension download was redirected away from Google',
				plainHttp: 'The extension download was redirected away from Google',
				startOutside: 'The extension download address is not a Chrome Web Store address',
				failed: 'The Chrome Web Store download failed (500)',
				stalled: 'The Chrome Web Store download timed out',
			},
			cancelledStalled: true,
			url: `id=${ID}&installsource=ondemand&uc=`,
		});
	});

	test('unpacks a verified archive and refuses names outside the folder, links and duplicates', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-crx-'));
		try {
			const unpack = async (name: string, entries: readonly { readonly name: string; readonly data: string; readonly mode?: number }[]) => paradisExtractCrxArchive(await zipOf(entries), join(root, name)).then(() => 'ok', (error: Error) => error.message);
			const result = {
				good: await unpack('good', [{ name: 'manifest.json', data: '{}' }, { name: 'js/bg.js', data: 'x' }]),
				noManifest: await unpack('none', [{ name: 'bg.js', data: 'x' }]),
				link: await unpack('link', [{ name: 'manifest.json', data: '{}' }, { name: 'evil', data: '/etc/passwd', mode: 0o120777 }]),
			};
			assert.deepStrictEqual({
				result,
				written: (await fs.readFile(join(root, 'good', 'js', 'bg.js'), 'utf8')),
				names: ['a/b.js', '../x', '/abs', 'C:/x', 'a\\b', 'a/./b', 'a//b'].map(paradisIsSafeArchiveEntryName),
			}, {
				result: { good: 'ok', noManifest: 'The extension package has no manifest', link: 'The extension package has a symbolic link: "evil"' },
				written: 'x',
				names: [true, false, false, false, false, false, false],
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('keeps store rows readable by older versions, which read them as folder extensions', () => {
		const row = { id: ID, name: 'E', version: '1.0', manifestVersion: 3, source: 'webstore' as const, sourcePath: '/x', path: '/x', installedAt: 1, touchesPages: false };
		const saved = JSON.parse(JSON.stringify(paradisSerializeExtensionsLedger({ version: 1, extensions: [row], enabled: { default: [ID] }, removed: [], pinned: {} }))) as { extensions: { source: string; webstore?: boolean }[] };
		const reread = paradisParseExtensionsLedger(saved);
		// 古い版は webstore の印を読まずに書き直す
		const rewrittenByOld = paradisParseExtensionsLedger({ ...saved, extensions: saved.extensions.map(({ webstore: _, ...rest }) => rest) });
		assert.deepStrictEqual({ onDisk: [saved.extensions[0].source, saved.extensions[0].webstore], reread: reread.extensions[0].source, enabled: reread.enabled, afterOld: rewrittenByOld.extensions[0].source }, {
			onDisk: ['unpacked', true], reread: 'webstore', enabled: { default: [ID] }, afterOld: 'unpacked',
		});
	});

	test('lets a folder extension use only hosts in Para Code\'s own folder', () => {
		const sources = paradisNativeHostSources({ platform: 'linux', homeDir: '/home/example', userDataDir: '/home/example/.config/Para Code' });
		const lookup: IParadisNativeHostLookup = { platform: 'linux', sources, readFile: async () => undefined, isFile: async () => false, readRegistryDefault: async () => undefined };
		assert.deepStrictEqual(paradisOwnFolderNativeHostLookup(lookup).sources, [{ kind: 'folder', folder: '/home/example/.config/Para Code/NativeMessagingHosts', own: true }]);
	});
});

/** 読み込んだ拡張機能を覚える偽のセッション。 */
function fakeSession(storagePath: string) {
	const loaded = new Map<string, string>();
	const describe = (id: string, path: string) => ({ id, manifest: {}, name: id, path, url: `chrome-extension://${id}/`, version: '1' }) satisfies Extension;
	const session: ParadisExtensionSession = {
		storagePath,
		clearStorageData: async () => { },
		protocol: { handle: () => { }, unhandle: () => { } } as unknown as ParadisExtensionSession['protocol'],
		serviceWorkers: { startWorkerForScope: async () => { throw new Error('no worker'); }, getWorkerFromVersionID: () => undefined, on: () => undefined, removeListener: () => undefined } as unknown as ParadisExtensionSession['serviceWorkers'],
		extensions: {
			on: () => undefined,
			removeListener: () => undefined,
			loadExtension: async (path: string) => {
				const key = (JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as { key?: string }).key;
				const id = paradisPredictExtensionId(path, key);
				loaded.set(id, path);
				return describe(id, path);
			},
			removeExtension: (id: string) => { loaded.delete(id); },
			getAllExtensions: () => [...loaded].map(([id, path]) => describe(id, path)),
			getExtension: (id: string) => loaded.has(id) ? describe(id, loaded.get(id)!) : null,
		} as unknown as ParadisExtensionSession['extensions'],
	};
	return { session, loaded };
}

suite('ParadisBrowserExtensionWebStore install', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'paradis-webstore-'));
	});
	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test('downloads, verifies and asks before adding, and talks to the store only when asked to add', async () => {
		const archive = await zipOf([{ name: 'manifest.json', data: JSON.stringify({ manifest_version: 3, name: 'Store Ext', version: '2.1', permissions: ['storage', 'nativeMessaging'], host_permissions: ['https://example.com/*'] }) }, { name: 'bg.js', data: '//' }]);
		const crx = buildCrx({ archive, developer, signers: [developer, publisher] });
		const fetched: string[] = [];
		const prompts: IParadisInstallPrompt[] = [];
		let answer = false;
		const manager = new ParadisBrowserExtensionsManager(join(root, 'mgr'), () => true, { warn: () => { } }, undefined, undefined, {
			askInstall: async prompt => { prompts.push(prompt); return answer; },
			fetcher: async url => { fetched.push(new URL(url).host); return { status: 200, read: async () => crx, cancel: () => { } }; },
			publisherKeyHash: hashOf(publisher),
		});
		try {
			const { session, loaded } = fakeSession(join(root, 'storage'));
			await manager.attach(session, { id: 'global', storageScope: BrowserViewStorageScope.Global });
			await manager.getState();
			const fetchedBeforeAdd = fetched.length;
			const declined = await manager.addFromWebStore(`https://chromewebstore.google.com/detail/store-ext/${ID}`, PARADIS_DEFAULT_EXTENSION_PROFILE, '既定');
			const leftAfterDecline = await fs.readdir(join(root, 'mgr', 'webstore')).catch(() => []);
			answer = true;
			const added = await manager.addFromWebStore(ID, PARADIS_DEFAULT_EXTENSION_PROFILE, '既定');
			const again = await manager.addFromWebStore(ID, PARADIS_DEFAULT_EXTENSION_PROFILE, '既定');
			const copiedManifest = JSON.parse(await fs.readFile(join(root, 'mgr', 'webstore', ID, 'manifest.json'), 'utf8')) as { key?: string };
			const ledger = JSON.parse(await fs.readFile(join(root, 'mgr', 'ledger.json'), 'utf8')) as { extensions: { source: string; webstore?: boolean }[] };
			const state = await manager.getState();
			// key を写したフォルダ（同じ id）はフォルダからは足せない
			const sameIdFolder = join(root, 'copied-store-folder');
			await fs.mkdir(sameIdFolder);
			await fs.writeFile(join(sameIdFolder, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Copied', version: '2.1', key: developer.publicKeyDer.toString('base64') }));
			const copiedFromFolder = await manager.addUnpacked(sameIdFolder, PARADIS_DEFAULT_EXTENSION_PROFILE);
			assert.deepStrictEqual({
				fetchedBeforeAdd,
				declined,
				leftAfterDecline,
				added: added.ok ? { id: added.extension.id, source: added.extension.source, version: added.extension.version } : added,
				again,
				prompt: prompts[0],
				key: copiedManifest.key === developer.publicKeyDer.toString('base64'),
				onDisk: [ledger.extensions[0].source, ledger.extensions[0].webstore],
				listed: state.extensions.map(extension => [extension.id, extension.source, extension.enabledIn]),
				loaded: [...loaded.keys()],
				copiedFromFolder,
			}, {
				fetchedBeforeAdd: 0,
				declined: { ok: false, reason: 'cancelled' },
				leftAfterDecline: [],
				added: { id: ID, source: 'webstore', version: '2.1' },
				again: { ok: false, reason: 'alreadyAdded', detail: 'Store Ext' },
				prompt: { extensionName: 'Store Ext', version: '2.1', access: { permissions: ['nativeMessaging', 'storage'], hostPermissions: ['https://example.com/*'] }, profileLabel: '既定' },
				key: true,
				onDisk: ['unpacked', true],
				listed: [[ID, 'webstore', [PARADIS_DEFAULT_EXTENSION_PROFILE]]],
				loaded: [ID],
				copiedFromFolder: { ok: false, reason: 'sameIdWebStore' },
			});
		} finally {
			manager.dispose();
		}
	});

	test('refuses a store install over a folder extension of the same id, and a package that fails the store signature', async () => {
		const archive = await zipOf([{ name: 'manifest.json', data: JSON.stringify({ manifest_version: 3, name: 'Store Ext', version: '1.0' }) }]);
		const unsigned = buildCrx({ archive, developer, signers: [developer] });
		const asked: string[] = [];
		const manager = new ParadisBrowserExtensionsManager(join(root, 'mgr'), () => true, { warn: () => { } }, undefined, undefined, {
			askInstall: async prompt => { asked.push(prompt.extensionName); return true; },
			fetcher: async () => ({ status: 200, read: async () => unsigned, cancel: () => { } }),
			publisherKeyHash: hashOf(publisher),
		});
		try {
			const notSigned = await manager.addFromWebStore(ID, PARADIS_DEFAULT_EXTENSION_PROFILE, '既定');
			const folder = join(root, 'dev');
			await fs.mkdir(folder);
			await fs.writeFile(join(folder, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Dev Copy', version: '1.0', key: developer.publicKeyDer.toString('base64') }));
			const fromFolder = await manager.addUnpacked(folder, PARADIS_DEFAULT_EXTENSION_PROFILE);
			const overFolder = await manager.addFromWebStore(ID, PARADIS_DEFAULT_EXTENSION_PROFILE, '既定');
			const badInput = await manager.addFromWebStore('https://example.com/', PARADIS_DEFAULT_EXTENSION_PROFILE, '既定');
			assert.deepStrictEqual({ notSigned, fromFolder: fromFolder.ok && fromFolder.extension.source, overFolder, badInput, asked }, {
				notSigned: { ok: false, reason: 'webStoreFailed', detail: 'CRX is not signed by the Chrome Web Store' },
				fromFolder: 'unpacked',
				overFolder: { ok: false, reason: 'sameIdUnpacked', detail: 'Dev Copy' },
				badInput: { ok: false, reason: 'invalidInput' },
				asked: [],
			});
		} finally {
			manager.dispose();
		}
	});
});
