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

	// 統合のモーダルを開き直したときに戻すため、選んでいるバージョンを reveal に渡せる形で返す
	test('reports the chosen version in the form reveal takes', () => {
		const { view } = create([]);
		const initial = view.viewState.version;
		view.reveal('paracode-178');
		assert.deepStrictEqual({ initial, chosen: view.viewState }, { initial: '180', chosen: { version: '178', scrollTop: 0 } });
	});

	// 取れなかったときは札を残し、前回の取得分を出しているならその時刻を添える（paradis-19-13）
	test('keeps the status chip when the fetch fails, with the time of the cached copy', () => {
		const { view, containers } = create([]);
		const chip = containers.header.querySelector('.para-cl-status') as HTMLElement;
		const fetchedAt = new Date(2026, 10, 12, 14, 5).getTime();
		const time = new Date(fetchedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
		view.setRemoteState({ kind: 'error' });
		const withoutCache = { shown: chip.style.display, text: chip.textContent };
		view.setRemoteState({ kind: 'error', cachedFetchedAt: fetchedAt });
		assert.deepStrictEqual({ withoutCache, withCache: chip.textContent }, {
			withoutCache: { shown: '', text: 'サーバーに接続できませんでした' },
			withCache: `サーバーに接続できませんでした · 前回 ${time} の取得分を表示中`,
		});
	});

	// 未読の点は空なので、未読であることを項目の読み上げの名前に入れ、読んだら外す（paradis-19-12）
	test('names an unread version for screen readers and drops the name once read', () => {
		const { view, containers } = create([]);
		const item = containers.nav.querySelector('.phub-nav-item') as HTMLElement;
		const before = { label: item.getAttribute('aria-label'), dotHidden: item.querySelector('.para-cl-dot')?.getAttribute('aria-hidden') };
		view.reveal('178');
		view.reveal('180');
		assert.deepStrictEqual({ before, after: item.getAttribute('aria-label') }, {
			before: { label: 'paracode-180、未読、2026-11-03', dotHidden: 'true' },
			after: null,
		});
	});
});
