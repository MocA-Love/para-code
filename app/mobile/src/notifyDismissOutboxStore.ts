// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as LegacyFileSystem from 'expo-file-system/legacy';

/**
 * 片付けの預かりと同期の印（`notifyDismissOutbox.ts`）のファイル。操作の outbox と同じアプリ sandbox
 * （documentDirectory）に PC ごとに置く。中身は通知 ID と台帳の番号だけなので封緘しない。
 * 書きかけで落ちても、次の読み込みで「預かりなし・番号 0 から同期」になるだけ。
 */
const BASE = LegacyFileSystem.documentDirectory
	? `${LegacyFileSystem.documentDirectory}notify-dismiss.v1`
	: undefined;

function pathFor(pcId: string): string | undefined {
	if (BASE === undefined) {
		return undefined;
	}
	// deviceId は base64url なので `-` / `_` を含む。ファイル名に使えない文字は置き換える（outbox と同じ）。
	return `${BASE}.${pcId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

export const notifyDismissOutboxStorage = {
	async read(pcId: string): Promise<string | null> {
		const path = pathFor(pcId);
		if (path === undefined) {
			return null;
		}
		const info = await LegacyFileSystem.getInfoAsync(path);
		return info.exists ? LegacyFileSystem.readAsStringAsync(path) : null;
	},
	async write(pcId: string, content: string): Promise<void> {
		const path = pathFor(pcId);
		if (path === undefined) {
			return;
		}
		await LegacyFileSystem.writeAsStringAsync(path, content, { encoding: LegacyFileSystem.EncodingType.UTF8 });
	},
	async remove(pcId: string): Promise<void> {
		const path = pathFor(pcId);
		if (path !== undefined) {
			await LegacyFileSystem.deleteAsync(path, { idempotent: true });
		}
	},
};
