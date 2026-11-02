/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisChangelogViewRelease, ParadisChangelogView } from '../../electron-browser/paradisChangelogView.js';

suite('ParadisChangelogView', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function release(version: number, installed: boolean): IParadisChangelogViewRelease {
		return { version, label: `paracode-${version}`, date: `2026-11-0${version - 177}`, installed, sections: [{ category: '新機能', items: [`item ${version}`] }] };
	}

	function create(selected: number[]) {
		const doc = mainWindow.document;
		const containers = { nav: doc.createElement('nav'), content: doc.createElement('div'), header: doc.createElement('div') };
		const view = store.add(new ParadisChangelogView(containers, { releases: [release(180, false), release(179, true), release(178, true)], installedVersion: 179 }, {
			initialLastReadVersion: 179,
			onSelectRelease: version => selected.push(version),
			onCheckForUpdate: () => { },
		}));
		return { view, containers };
	}

	// 左のナビは「利用可能な更新」「インストール済み」の見出しの下にバージョンを並べ、日付は月と日だけにする
	test('lists the versions under the available and installed captions in the left nav', () => {
		const { containers } = create([]);
		const nav = [...containers.nav.children].map(child => child.classList.contains('phub-nav-caption')
			? `# ${child.textContent}`
			: `${child.classList.contains('active') ? '*' : ' '} ${child.querySelector('.phub-nav-label')?.textContent} ${child.querySelector('.phub-nav-chip')?.textContent}${child.querySelector('.para-cl-dot') ? ' (unread)' : ''}`);
		assert.deepStrictEqual(nav, [
			'# 利用可能な更新',
			'* paracode-180 11-03 (unread)',
			'# インストール済み',
			'  paracode-179 11-02',
			'  paracode-178 11-01',
		]);
	});

	test('shows the chosen version and marks it read, and opens a version passed by name', () => {
		const selected: number[] = [];
		const { view, containers } = create(selected);
		view.reveal('paracode-178');
		const heading = containers.content.querySelector('.para-cl-ver-label')?.textContent;
		view.reveal('180');
		assert.deepStrictEqual({
			heading,
			now: containers.content.querySelector('.para-cl-ver-label')?.textContent,
			banner: (containers.content.querySelector('.para-cl-banner') as HTMLElement).style.display,
			selected,
			dots: containers.nav.querySelectorAll('.para-cl-dot').length,
		}, { heading: 'paracode-178', now: 'paracode-180', banner: '', selected: [180], dots: 0 });
	});
});
