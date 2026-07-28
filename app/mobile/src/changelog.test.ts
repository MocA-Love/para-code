// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MOBILE_CHANGELOG, compareVersions, pendingReleases, type MobileRelease } from './changelog.js';

/**
 * 更新履歴の運用を機械的に縛るテスト。
 * 「実装したら changelog に書く」はルール（CLAUDE.md）だけだと書き忘れが素通りするため、
 * app.json とのバージョン一致だけはここで落とす。
 */
describe('mobile changelog', () => {
	test('先頭バージョンが app.json の version と一致する', () => {
		const appJson = JSON.parse(readFileSync(fileURLToPath(new URL('../app.json', import.meta.url)), 'utf8')) as { expo: { version: string } };
		expect(MOBILE_CHANGELOG[0]?.version).toBe(appJson.expo.version);
	});

	test('新しい順に並び、バージョンが重複しない', () => {
		const versions = MOBILE_CHANGELOG.map(release => release.version);
		expect(versions).toStrictEqual([...versions].sort((a, b) => compareVersions(b, a)));
		expect(new Set(versions).size).toBe(versions.length);
	});

	test('日付の形式と、項目に見出しがあること', () => {
		for (const release of MOBILE_CHANGELOG) {
			expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			for (const item of release.items) {
				expect(item.title.length).toBeGreaterThan(0);
				expect(item.icon.length).toBeGreaterThan(0);
			}
		}
	});
});

describe('pendingReleases', () => {
	const releases: MobileRelease[] = [
		{ version: '0.3.0', date: '2026-08-01', items: [{ icon: 'a', title: 'C' }] },
		{ version: '0.2.1', date: '2026-07-30', items: [] },
		{ version: '0.2.0', date: '2026-07-28', items: [{ icon: 'a', title: 'B' }] },
		{ version: '0.1.0', date: '2026-07-01', items: [{ icon: 'a', title: 'A' }] },
	];

	test('新規インストール（既読なし）では何も出さない', () => {
		expect(pendingReleases('0.3.0', undefined, releases)).toStrictEqual([]);
	});

	test('同じバージョンでは出さない', () => {
		expect(pendingReleases('0.3.0', '0.3.0', releases)).toStrictEqual([]);
	});

	test('飛ばした版をまとめ、items が空の版と手元に無い先の版は除く', () => {
		expect(pendingReleases('0.2.1', '0.1.0', releases).map(release => release.version)).toStrictEqual(['0.2.0']);
		expect(pendingReleases('0.3.0', '0.1.0', releases).map(release => release.version)).toStrictEqual(['0.3.0', '0.2.0']);
	});
});
