// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 表の作り直しを版で 1 回にする（起きるたびに CREATE TABLE と ALTER TABLE を流さない）。
 * 版の無い古い DO は一度だけ全部流して版を書き、版のある DO は表に触らない。
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DeviceDO } from '../src/deviceDO.js';

function schemaState(sql: SqlStorage): { version: unknown; index: number; columns: string[] } {
	const version = sql.exec(`SELECT value FROM meta WHERE key = 'schemaVersion'`).toArray()[0]?.value;
	const index = sql.exec(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'push_requests_at'`).toArray()[0]!.n as number;
	const columns = sql.exec('PRAGMA table_info(mobiles)').toArray().map(row => row.name as string);
	return { version, index, columns };
}

describe('DeviceDO schema', () => {
	it('migrates a DO without a schema version once and leaves a migrated DO alone', async () => {
		const stub = env.DEVICES.get(env.DEVICES.newUniqueId());
		const result = await runInDurableObject(stub, (_instance, state) => {
			const fresh = schemaState(state.storage.sql);
			// 版を書く前の DO（索引も無い）に戻して、作り直す
			state.storage.sql.exec(`DELETE FROM meta WHERE key = 'schemaVersion'`);
			state.storage.sql.exec('DROP INDEX push_requests_at');
			new DeviceDO(state, env);
			const migrated = schemaState(state.storage.sql);
			// 版のある DO では索引を消しても作り直さない（表に触らない）
			state.storage.sql.exec('DROP INDEX push_requests_at');
			new DeviceDO(state, env);
			const untouched = schemaState(state.storage.sql);
			return { fresh, migrated, untouched };
		});
		const columns = ['mobileId', 'name', 'tokenHash', 'createdAt', 'apnsToken', 'apnsEnv', 'lastSeenAt'];
		expect(result).toEqual({
			fresh: { version: 1, index: 1, columns },
			migrated: { version: 1, index: 1, columns },
			untouched: { version: 1, index: 0, columns },
		});
	});
});
