// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as LegacyFileSystem from 'expo-file-system/legacy';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

/**
 * 使用量の「最後に取れた値」のファイル（出どころごとに1つ。中身は `usageCache.ts` が通知鍵で封緘した base64url）。
 *
 * 置き場所は `cacheDirectory`（iCloud のバックアップに入らない。OS が容量のために消すことはあるが、消えても
 * 「前回の値が無い」になるだけ）。ファイル名は `<pcId>~<出どころの鍵の sha256 の先頭>` で、PC の解除のときに
 * その PC のファイルをまとめて消せるようにしている（pcId は base64url なので `~` を含まない）。
 *
 * appState から PC の解除を知らせる口（{@link forgetUsagePc}）もここに置く。appState は使用量のストアを import しない
 * （使用量のストアが appState を import するので、輪にしない）。
 */

const DIRECTORY = LegacyFileSystem.cacheDirectory ? `${LegacyFileSystem.cacheDirectory}usage-cache.v2/` : undefined;
/** 前の版（封緘していない 1 ファイル）。見つけたら消す。 */
const LEGACY_FILE = LegacyFileSystem.documentDirectory ? `${LegacyFileSystem.documentDirectory}usage-cache.v1.json` : undefined;

function safePcId(pcId: string): string {
	return pcId.replace(/[^A-Za-z0-9_-]/g, '_');
}

function fileName(pcId: string, sourceKey: string): string {
	return `${safePcId(pcId)}~${bytesToHex(sha256(new TextEncoder().encode(sourceKey))).slice(0, 32)}`;
}

let directoryReady: Promise<void> | undefined;

function ensureDirectory(): Promise<void> {
	if (DIRECTORY === undefined) {
		return Promise.resolve();
	}
	directoryReady ??= (async () => {
		const info = await LegacyFileSystem.getInfoAsync(DIRECTORY);
		if (!info.exists) {
			await LegacyFileSystem.makeDirectoryAsync(DIRECTORY, { intermediates: true });
		}
		if (LEGACY_FILE !== undefined) {
			await LegacyFileSystem.deleteAsync(LEGACY_FILE, { idempotent: true }).catch(() => undefined);
		}
	})().catch(error => {
		directoryReady = undefined;
		throw error;
	});
	return directoryReady;
}

/** その PC の控えのファイルの名前と中身（封緘したまま）を全部読む。 */
export async function readUsageCacheFiles(pcId: string): Promise<{ readonly name: string; readonly content: string }[]> {
	if (DIRECTORY === undefined) {
		return [];
	}
	await ensureDirectory();
	const prefix = `${safePcId(pcId)}~`;
	const names = (await LegacyFileSystem.readDirectoryAsync(DIRECTORY)).filter(name => name.startsWith(prefix));
	const files = await Promise.all(names.map(async name => {
		const content = await LegacyFileSystem.readAsStringAsync(`${DIRECTORY}${name}`).catch(() => undefined);
		return content !== undefined ? { name, content } : undefined;
	}));
	return files.filter((file): file is { name: string; content: string } => file !== undefined);
}

/** 読んだファイルを名前で消す（開けなかったものを片付ける）。 */
export async function removeUsageCacheFileNamed(name: string): Promise<void> {
	if (DIRECTORY !== undefined && !name.includes('/')) {
		await LegacyFileSystem.deleteAsync(`${DIRECTORY}${name}`, { idempotent: true });
	}
}

export async function writeUsageCacheFile(pcId: string, sourceKey: string, sealed: string): Promise<void> {
	if (DIRECTORY === undefined) {
		return;
	}
	await ensureDirectory();
	await LegacyFileSystem.writeAsStringAsync(`${DIRECTORY}${fileName(pcId, sourceKey)}`, sealed, { encoding: LegacyFileSystem.EncodingType.UTF8 });
}

export async function removeUsageCacheFile(pcId: string, sourceKey: string): Promise<void> {
	if (DIRECTORY !== undefined) {
		await LegacyFileSystem.deleteAsync(`${DIRECTORY}${fileName(pcId, sourceKey)}`, { idempotent: true });
	}
}

const forgetListeners = new Set<(pcId: string) => void>();

/** PC の解除を受け取る（使用量のストアがメモリの値を捨てるため）。 */
export function onUsagePcForgotten(listener: (pcId: string) => void): () => void {
	forgetListeners.add(listener);
	return () => forgetListeners.delete(listener);
}

/**
 * PC を解除したときに、その PC（と、その PC から繋いだ SSH の接続先）の控えをメモリとファイルから消す
 * （appState の `removePc` から呼ぶ）。
 */
export async function forgetUsagePc(pcId: string): Promise<void> {
	for (const listener of forgetListeners) {
		listener(pcId);
	}
	if (DIRECTORY === undefined) {
		return;
	}
	const info = await LegacyFileSystem.getInfoAsync(DIRECTORY);
	if (!info.exists) {
		return;
	}
	const prefix = `${safePcId(pcId)}~`;
	const names = (await LegacyFileSystem.readDirectoryAsync(DIRECTORY)).filter(name => name.startsWith(prefix));
	await Promise.all(names.map(name => LegacyFileSystem.deleteAsync(`${DIRECTORY}${name}`, { idempotent: true })));
}
