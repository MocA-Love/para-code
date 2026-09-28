// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as LegacyFileSystem from 'expo-file-system/legacy';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { ConnectionLogBook, type ConnectionLogStorage } from './connectionLog.js';
import type { DiagnosticNetworkState } from './connectionDiagnostics.js';

/**
 * 接続の記録（W2-22）のファイル。操作の outbox と同じアプリ sandbox（documentDirectory）に PC ごとに置く。
 * 中身は伏せ字にした出来事の JSON（`connectionLog.ts`）。
 */
const BASE = LegacyFileSystem.documentDirectory
	? `${LegacyFileSystem.documentDirectory}connection-log.v1`
	: undefined;

function pathFor(pcId: string): string | undefined {
	return BASE === undefined ? undefined : `${BASE}.${pcId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

const storage: ConnectionLogStorage = {
	async read(pcId) {
		const path = pathFor(pcId);
		if (path === undefined) {
			return null;
		}
		const info = await LegacyFileSystem.getInfoAsync(path);
		return info.exists ? LegacyFileSystem.readAsStringAsync(path) : null;
	},
	async write(pcId, text) {
		const path = pathFor(pcId);
		if (path !== undefined) {
			await LegacyFileSystem.writeAsStringAsync(path, text, { encoding: LegacyFileSystem.EncodingType.UTF8 });
		}
	},
	async remove(pcId) {
		const path = pathFor(pcId);
		if (path !== undefined) {
			await LegacyFileSystem.deleteAsync(path, { idempotent: true });
		}
	},
};

/** アプリ全体で1つの記録。 */
export const connectionLog = new ConnectionLogBook(storage);

/**
 * いまの回線の状態（診断用）。expo-network のネイティブ部品が無いビルドでは undefined
 * （`networkRevival.ts` と同じく JS を import せず optional に引く）。
 */
export async function readNetworkState(): Promise<DiagnosticNetworkState | undefined> {
	try {
		const module = requireOptionalNativeModule<{ getNetworkStateAsync(): Promise<DiagnosticNetworkState> }>('ExpoNetwork');
		return module !== null ? await module.getNetworkStateAsync() : undefined;
	} catch {
		return undefined;
	}
}
