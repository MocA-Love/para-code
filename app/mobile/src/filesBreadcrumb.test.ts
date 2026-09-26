// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { breadcrumbItems } from './filesBreadcrumb.js';

describe('breadcrumbItems', () => {
	test('根ではスペース名だけが並び、それが現在地になる', () => {
		expect(breadcrumbItems('repo', '')).toEqual([{ label: 'repo', target: '', current: true }]);
	});

	test('途中の階層はそれぞれの深さへの行き先を持つ', () => {
		expect(breadcrumbItems('repo', 'src/components/ui')).toEqual([
			{ label: 'repo', target: '', current: false },
			{ label: 'src', target: 'src', current: false },
			{ label: 'components', target: 'src/components', current: false },
			{ label: 'ui', target: 'src/components/ui', current: true },
		]);
	});

	test('空の区切りは無視する', () => {
		expect(breadcrumbItems('repo', '/src//lib/').map(item => item.target)).toEqual(['', 'src', 'src/lib']);
	});

	test('スペース名が無いときは「ルート」と出す', () => {
		expect(breadcrumbItems(undefined, 'src')[0]?.label).toBe('ルート');
		expect(breadcrumbItems('', 'src')[0]?.label).toBe('ルート');
	});
});
