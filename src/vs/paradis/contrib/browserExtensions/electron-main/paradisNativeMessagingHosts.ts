/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/main/browser/extensions/browser-extension-native-host-locations.ts, src/main/browser/extensions/browser-extension-native-host-lookup.ts, src/main/browser/extensions/browser-extension-native-host-errors.ts, src/main/browser/extensions/browser-extension-native-host-framing.ts

// ネイティブメッセージング（P6）のホストを探すところと、やりとりの形（4 バイトの長さ + UTF-8 の JSON）。
//
// ホストの manifest（`<名前>.json`）を探す場所は、設計書の D5（A）のとおり、Para Code の専用のフォルダを先に、次に Chrome・
// Chromium の場所、ほかの Chromium 系のブラウザの場所（1Password・Bitwarden のアプリは Para Code を知らず、Chrome などにだけ
// 登録するため）。manifest は Chrome と同じく確かめ、allowed_origins の固定の一覧（ワイルドカードは不可）に呼び出し元の
// 拡張機能が無ければ断る（起動する前に）。ホストの実行ファイルは絶対パス（Windows だけ manifest のフォルダからの相対も可）で、
// ファイルであること。1 つの場所の壊れた・古い・断る manifest は、次の場所へ進む（アプリはブラウザごとに 1 つずつ書くため）。

import { promises as fs } from 'fs';
import { endianness, homedir } from 'os';
import { posix, win32 } from '../../../../base/common/path.js';

/** Chrome の runtime.lastError の文（native_message_host.cc）。 */
export const PARADIS_NATIVE_HOST_ERRORS = {
	invalidName: 'Invalid native messaging host name specified.',
	notFound: 'Specified native messaging host not found.',
	forbidden: 'Access to the specified native messaging host is forbidden.',
	failedToStart: 'Failed to start native messaging host.',
	exited: 'Native host has exited.',
	io: 'Error when communicating with the native messaging host.',
} as const;

/** manifest を探す場所（フォルダ、または Windows のレジストリのキー。キーの既定の値が manifest のパス）。 */
export type ParadisNativeHostSource =
	| { readonly kind: 'folder'; readonly folder: string }
	| { readonly kind: 'registry'; readonly root: 'HKCU' | 'HKLM'; readonly key: string };

/** Para Code の専用のフォルダの名前（userData の下）。利用者が Para Code のためだけにホストを登録・上書きできる。 */
export const PARADIS_NATIVE_MESSAGING_HOSTS_FOLDER = 'NativeMessagingHosts';

const MAC_OTHER_BROWSERS = ['BraveSoftware/Brave-Browser', 'Microsoft Edge', 'Vivaldi', 'Arc/User Data', 'net.imput.helium', 'com.operasoftware.Opera'];
const LINUX_OTHER_BROWSERS = ['BraveSoftware/Brave-Browser', 'microsoft-edge', 'vivaldi', 'net.imput.helium', 'opera'];
const WINDOWS_BROWSERS = ['Google\\Chrome', 'Chromium', 'Microsoft\\Edge', 'BraveSoftware\\Brave-Browser'];

/** manifest を探す場所（順番どおり）。 */
export function paradisNativeHostSources(environment: { readonly platform: NodeJS.Platform; readonly homeDir: string; readonly userDataDir: string; readonly xdgConfigHome?: string }): ParadisNativeHostSource[] {
	const path = environment.platform === 'win32' ? win32 : posix;
	const own: ParadisNativeHostSource = { kind: 'folder', folder: path.join(environment.userDataDir, PARADIS_NATIVE_MESSAGING_HOSTS_FOLDER) };
	const folders = (list: readonly string[]): ParadisNativeHostSource[] => list.map(folder => ({ kind: 'folder', folder }));
	if (environment.platform === 'darwin') {
		const support = posix.join(environment.homeDir, 'Library/Application Support');
		const hosts = (base: string) => posix.join(base, 'NativeMessagingHosts');
		return [own, ...folders([
			hosts(posix.join(support, 'Google/Chrome')),
			hosts(posix.join(support, 'Chromium')),
			'/Library/Google/Chrome/NativeMessagingHosts',
			'/Library/Application Support/Chromium/NativeMessagingHosts',
			...MAC_OTHER_BROWSERS.map(browser => hosts(posix.join(support, browser))),
		])];
	}
	if (environment.platform === 'win32') {
		const sources: ParadisNativeHostSource[] = [own];
		for (const vendor of WINDOWS_BROWSERS) {
			// HKCU\Software は 32 ビットと 64 ビットで共通。HKLM は Chrome と同じく 32 ビットの見え方を先に
			sources.push(
				{ kind: 'registry', root: 'HKCU', key: `Software\\${vendor}\\NativeMessagingHosts` },
				{ kind: 'registry', root: 'HKLM', key: `SOFTWARE\\WOW6432Node\\${vendor}\\NativeMessagingHosts` },
				{ kind: 'registry', root: 'HKLM', key: `SOFTWARE\\${vendor}\\NativeMessagingHosts` },
			);
		}
		return sources;
	}
	const config = environment.xdgConfigHome && posix.isAbsolute(environment.xdgConfigHome) ? environment.xdgConfigHome : posix.join(environment.homeDir, '.config');
	const hosts = (browser: string) => posix.join(config, browser, 'NativeMessagingHosts');
	return [own, ...folders([
		hosts('google-chrome'),
		hosts('chromium'),
		'/etc/opt/chrome/native-messaging-hosts',
		'/etc/chromium/native-messaging-hosts',
		...LINUX_OTHER_BROWSERS.map(hosts),
	])];
}

/** Chrome のホストの名前の決まり（NativeMessagingHostManifest::IsValidName）。 */
export function paradisIsValidNativeHostName(name: unknown): name is string {
	return typeof name === 'string' && name.length <= 256 && /^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(name);
}

/** 読んだ manifest。 */
export interface IParadisNativeHostManifest {
	readonly name: string;
	readonly path: string;
	readonly allowedOrigins: readonly { readonly host: string; readonly path: RegExp }[];
}

function originPattern(entry: unknown): { host: string; path: RegExp } | undefined {
	if (typeof entry !== 'string') {
		return undefined;
	}
	const match = /^chrome-extension:\/\/(?<host>[^/]*)(?<path>\/.*)$/.exec(entry);
	const host = match?.groups?.host.toLowerCase() ?? '';
	// Chrome は拡張機能の固定の一覧を求める（拡張機能にかかるパターンは不可）
	if (!match?.groups || host === '' || host.includes('*')) {
		return undefined;
	}
	const glob = match.groups.path.split('').map(char => char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[\\^$.+()[\]{}|]/g, '\\$&')).join('');
	return { host, path: new RegExp(`^${glob}$`) };
}

/** Chrome と同じく manifest を確かめる（1 つでもおかしな項目があれば、そのファイルは使わない）。 */
export function paradisParseNativeHostManifest(text: string): IParadisNativeHostManifest | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return undefined;
	}
	const { name, description, type, path, allowed_origins: origins } = parsed as Record<string, unknown>;
	if (!paradisIsValidNativeHostName(name) || typeof description !== 'string' || description === '' || type !== 'stdio' || typeof path !== 'string' || path === '' || path.includes('\0') || !Array.isArray(origins)) {
		return undefined;
	}
	const allowedOrigins = origins.map(originPattern);
	if (allowedOrigins.some(pattern => pattern === undefined)) {
		return undefined;
	}
	return { name, path, allowedOrigins: allowedOrigins.filter((pattern): pattern is { host: string; path: RegExp } => pattern !== undefined) };
}

/** その拡張機能がこのホストを使ってよいか（allowed_origins の固定の一覧に `chrome-extension://<id>/` がある）。 */
export function paradisNativeHostAllows(manifest: IParadisNativeHostManifest, extensionId: string): boolean {
	return manifest.allowedOrigins.some(pattern => pattern.host === extensionId && pattern.path.test('/'));
}

/** 探すのに要るもの（テストでは偽物）。 */
export interface IParadisNativeHostLookup {
	readonly platform: NodeJS.Platform;
	readonly sources: readonly ParadisNativeHostSource[];
	/** 無い・読めない・大きすぎるときは undefined。 */
	readFile(path: string): Promise<string | undefined>;
	isFile(path: string): Promise<boolean>;
	/** レジストリのキーの既定の値（無ければ undefined）。 */
	readRegistryDefault(root: 'HKCU' | 'HKLM', key: string): Promise<string | undefined>;
}

/** 起動してよいホスト、または Chrome の断りの文。 */
export type ParadisNativeHostResolution = { readonly ok: true; readonly program: string; readonly manifestPath: string } | { readonly ok: false; readonly error: string };

/**
 * その拡張機能が起動してよいホストを探す。Chrome は 1 つの段で 1 つの場所しか読まないが、Para Code はいくつもの場所を読むので、
 * 壊れた・古い・断る manifest は次の場所へ進む。断る manifest があって、ほかに使えるものが無ければ「forbidden」。
 */
export async function paradisResolveNativeHost(name: unknown, extensionId: string, lookup: IParadisNativeHostLookup, warn: (message: string) => void = () => { }): Promise<ParadisNativeHostResolution> {
	if (!paradisIsValidNativeHostName(name)) {
		return { ok: false, error: PARADIS_NATIVE_HOST_ERRORS.invalidName };
	}
	const path = lookup.platform === 'win32' ? win32 : posix;
	let forbidden = false;
	for (const source of lookup.sources) {
		const manifestPath = source.kind === 'folder' ? path.join(source.folder, `${name}.json`) : await lookup.readRegistryDefault(source.root, `${source.key}\\${name}`);
		if (!manifestPath || !path.isAbsolute(manifestPath)) {
			continue;
		}
		const text = await lookup.readFile(manifestPath);
		const manifest = text === undefined ? undefined : paradisParseNativeHostManifest(text);
		if (!manifest || manifest.name !== name) {
			if (text !== undefined) {
				warn(`ignoring an invalid native messaging host manifest ${manifestPath}`);
			}
			continue;
		}
		// 起動する前に、呼び出し元の拡張機能が allowed_origins にあるかを確かめる
		if (!paradisNativeHostAllows(manifest, extensionId)) {
			forbidden = true;
			continue;
		}
		// Chrome は manifest のフォルダからの相対のパスを Windows でだけ認める
		const program = path.isAbsolute(manifest.path) ? path.normalize(manifest.path) : lookup.platform === 'win32' ? win32.join(win32.dirname(manifestPath), manifest.path) : undefined;
		if (program && await lookup.isFile(program)) {
			return { ok: true, program, manifestPath };
		}
	}
	return { ok: false, error: forbidden ? PARADIS_NATIVE_HOST_ERRORS.forbidden : PARADIS_NATIVE_HOST_ERRORS.notFound };
}

/** Windows のレジストリの値の %NAME% を環境変数で置き換える（REG_EXPAND_SZ。無い名前はそのまま）。 */
export function paradisExpandWindowsEnvironment(value: string, environment: NodeJS.ProcessEnv): string {
	const upper = new Map(Object.entries(environment).map(([key, entry]) => [key.toUpperCase(), entry]));
	return value.replace(/%(?<name>[^%]+)%/g, (whole, name: string) => upper.get(name.toUpperCase()) ?? whole);
}

const MAX_MANIFEST_BYTES = 1024 * 1024;

/** このパソコンで探すのに要るもの。 */
export function paradisDefaultNativeHostLookup(userDataDir: string): IParadisNativeHostLookup {
	return {
		platform: process.platform,
		sources: paradisNativeHostSources({ platform: process.platform, homeDir: homedir(), userDataDir, xdgConfigHome: process.env.XDG_CONFIG_HOME }),
		readFile: async path => {
			try {
				if ((await fs.stat(path)).size > MAX_MANIFEST_BYTES) {
					return undefined;
				}
				return await fs.readFile(path, 'utf8');
			} catch {
				return undefined;
			}
		},
		isFile: async path => {
			try {
				return (await fs.stat(path)).isFile();
			} catch {
				return false;
			}
		},
		readRegistryDefault: async (root, key) => {
			if (process.platform !== 'win32') {
				return undefined;
			}
			try {
				// npm のパッケージは main では動的に読む（配布版の main の束が外に残し、静的に読むと起動前に止まるため）
				const registry = await import('@vscode/windows-registry');
				const value = registry.GetStringRegKey(root === 'HKCU' ? 'HKEY_CURRENT_USER' : 'HKEY_LOCAL_MACHINE', key, '');
				return typeof value === 'string' && value.length > 0 ? paradisExpandWindowsEnvironment(value, process.env) : undefined;
			} catch {
				return undefined;
			}
		},
	};
}

// --- やりとりの形 ---

/** 長さの欄（4 バイト、マシンのバイト順）。 */
export const PARADIS_NATIVE_HEADER_BYTES = 4;
/** ホストから拡張機能へは 1 MB まで（Chrome の kMaximumNativeMessageSize）。 */
export const PARADIS_MAX_NATIVE_HOST_MESSAGE_BYTES = 1024 * 1024;

const littleEndian = endianness() === 'LE';

/** 1 つのメッセージを送る形にする。 */
export function paradisEncodeNativeMessage(json: string): Buffer {
	const body = Buffer.from(json, 'utf8');
	const frame = Buffer.allocUnsafe(PARADIS_NATIVE_HEADER_BYTES + body.length);
	if (littleEndian) {
		frame.writeUInt32LE(body.length, 0);
	} else {
		frame.writeUInt32BE(body.length, 0);
	}
	body.copy(frame, PARADIS_NATIVE_HEADER_BYTES);
	return frame;
}

/**
 * ホストの標準出力を、メッセージごとに組み立てる。`onMessage` には JSON として読めることを確かめた文字を渡す。大きすぎる・
 * JSON でないメッセージは `onError` を 1 回呼んで止まる。
 */
export function paradisCreateNativeMessageReader(onMessage: (json: string) => void, onError: (reason: string) => void): { push(chunk: Buffer): boolean } {
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	let failed = false;
	const fail = (reason: string): false => {
		failed = true;
		pending = [];
		pendingBytes = 0;
		onError(reason);
		return false;
	};
	const readSize = () => {
		const head = pending[0].length >= PARADIS_NATIVE_HEADER_BYTES ? pending[0] : Buffer.concat(pending, PARADIS_NATIVE_HEADER_BYTES);
		return littleEndian ? head.readUInt32LE(0) : head.readUInt32BE(0);
	};
	return {
		push: chunk => {
			if (failed) {
				return false;
			}
			pending.push(chunk);
			pendingBytes += chunk.length;
			while (pendingBytes >= PARADIS_NATIVE_HEADER_BYTES) {
				const size = readSize();
				if (size > PARADIS_MAX_NATIVE_HOST_MESSAGE_BYTES) {
					return fail(`message of ${size} bytes is over the 1 MB limit`);
				}
				if (pendingBytes < PARADIS_NATIVE_HEADER_BYTES + size) {
					if (pending.length > 1) {
						pending = [Buffer.concat(pending, pendingBytes)];
					}
					return true;
				}
				// 1 MB のメッセージは何回にも分かれて届く。毎回つなぐと二乗の手間になるので、揃ってからつなぐ
				const buffered = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
				const json = buffered.toString('utf8', PARADIS_NATIVE_HEADER_BYTES, PARADIS_NATIVE_HEADER_BYTES + size);
				const rest = buffered.subarray(PARADIS_NATIVE_HEADER_BYTES + size);
				pending = rest.length > 0 ? [rest] : [];
				pendingBytes = rest.length;
				try {
					JSON.parse(json);
				} catch {
					return fail('message is not valid JSON');
				}
				onMessage(json);
			}
			return true;
		},
	};
}
