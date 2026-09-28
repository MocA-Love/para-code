// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as LegacyFileSystem from 'expo-file-system/legacy';
import { LastKnownPcWriter, type LastKnownPcStorage } from './lastKnownPcs.js';

/**
 * 「前回の一覧」（W2-25）のファイル。操作の outbox と同じアプリ sandbox（documentDirectory）に
 * PC ごとに置く。中身は `lastKnownPcs.ts` が通知鍵で封緘した base64url で、ここは読み書きだけ。
 */
const BASE = LegacyFileSystem.documentDirectory
	? `${LegacyFileSystem.documentDirectory}last-known-pc.v1`
	: undefined;

function pathFor(pcId: string): string | undefined {
	if (BASE === undefined) {
		return undefined;
	}
	// deviceId は base64url なので `-` / `_` を含む。ファイル名に使えない文字は置き換える（outbox と同じ）。
	return `${BASE}.${pcId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

export const lastKnownPcStorage: LastKnownPcStorage = {
	async read(pcId) {
		const path = pathFor(pcId);
		if (path === undefined) {
			return null;
		}
		const info = await LegacyFileSystem.getInfoAsync(path);
		return info.exists ? LegacyFileSystem.readAsStringAsync(path) : null;
	},
	async write(pcId, sealed) {
		const path = pathFor(pcId);
		if (path === undefined) {
			return;
		}
		// 書きかけで落ちても、次の読み込みでは封緘が開けず「前回の一覧は無い」になるだけ。
		await LegacyFileSystem.writeAsStringAsync(path, sealed, { encoding: LegacyFileSystem.EncodingType.UTF8 });
	},
	async remove(pcId) {
		const path = pathFor(pcId);
		if (path !== undefined) {
			await LegacyFileSystem.deleteAsync(path, { idempotent: true });
		}
	},
};

export const lastKnownPcWriter = new LastKnownPcWriter(lastKnownPcStorage);
