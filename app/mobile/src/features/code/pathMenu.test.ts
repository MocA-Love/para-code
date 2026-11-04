// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import type { ContextMenuAction, ContextMenuOps, ContextMenuSpec } from '../../components/contextMenuModel.js';
import { buildCommitFileMenu, buildCommitMenu, buildDiffLineMenu, buildFileMenu, buildScmFileMenu, buildToolFileMenu } from './pathMenu.js';

/** 記録するだけの道具。 */
function recorder(canCopy = true): { ops: ContextMenuOps; log: string[] } {
	const log: string[] = [];
	return {
		log,
		ops: {
			canCopy,
			copy: (text, toast) => log.push(`copy ${text} / ${toast}`),
			copyLater: (load, toast) => { void load().then(text => log.push(`copy later ${text} / ${toast}`)); },
			share: text => log.push(`share ${text}`),
		},
	};
}

/** 比べやすい形（処理は省き、押せない・区切りだけ残す）。 */
function shape(menu: ContextMenuSpec): unknown {
	const row = (action: ContextMenuAction): unknown => ({
		id: action.id,
		title: action.title,
		...(action.subtitle !== undefined ? { subtitle: action.subtitle } : {}),
		...(action.disabled === true ? { disabled: true } : {}),
		...(action.startsSection === true ? { section: true } : {}),
	});
	return { title: menu.title, actions: menu.actions.map(row) };
}

function select(menu: ContextMenuSpec, id: string): void {
	menu.actions.find(action => action.id === id)?.onSelect?.();
}

describe('pathMenu', () => {
	it('builds the file row menu with name, relative path, open and share', () => {
		const { ops, log } = recorder();
		const opened: string[] = [];
		const menu = buildFileMenu({ path: 'app/mobile/src/store.ts', dir: false }, { ...ops, open: () => opened.push('open') });
		expect(shape(menu)).toEqual({
			title: 'app/mobile/src/store.ts',
			actions: [
				{ id: 'copy-name', title: '名前をコピー', subtitle: 'store.ts' },
				{ id: 'copy-relative', title: '相対パスをコピー', subtitle: 'app/mobile/src/store.ts' },
				{ id: 'open', title: 'ファイルを開く', section: true },
				{ id: 'share', title: '共有…' },
			],
		});
		select(menu, 'copy-relative');
		select(menu, 'open');
		select(menu, 'share');
		expect([...log, ...opened]).toEqual(['copy app/mobile/src/store.ts / 相対パスをコピーしました', 'share app/mobile/src/store.ts', 'open']);
	});

	it('greys out copy items with the reason when the build has no clipboard', () => {
		const { ops } = recorder(false);
		expect(shape(buildFileMenu({ path: 'src', dir: true }, ops))).toEqual({
			title: 'src',
			actions: [
				{ id: 'copy-name', title: '名前をコピー', subtitle: 'このビルドではコピーできません', disabled: true },
				{ id: 'copy-relative', title: '相対パスをコピー', subtitle: 'このビルドではコピーできません', disabled: true },
				{ id: 'share', title: '共有…', section: true },
			],
		});
	});

	it('offers diff and the right stage direction on source control rows', () => {
		const { ops } = recorder();
		const toggled: string[] = [];
		const menu = buildScmFileMenu({ path: 'a/b.ts', staged: true }, { ...ops, openDiff: () => toggled.push('diff'), toggleStage: () => toggled.push('unstage') });
		expect((shape(menu) as { actions: { id: string }[] }).actions.map(action => action.id)).toEqual(['copy-name', 'copy-relative', 'diff', 'unstage', 'share']);
		select(menu, 'unstage');
		expect(toggled).toEqual(['unstage']);
	});

	it('copies the full and short hash and the subject of a commit', () => {
		const { ops, log } = recorder();
		const menu = buildCommitMenu({ hash: '8b7534719fa0123456789abcdef0123456789abcd', subject: 'para: fix' }, ops);
		expect(shape(menu)).toEqual({
			title: 'para: fix',
			actions: [
				{ id: 'copy-hash', title: 'ハッシュをコピー', subtitle: '8b7534719fa…' },
				{ id: 'copy-short-hash', title: '短いハッシュをコピー', subtitle: '8b75347' },
				{ id: 'copy-subject', title: '件名をコピー' },
			],
		});
		select(menu, 'copy-hash');
		expect(log).toEqual(['copy 8b7534719fa0123456789abcdef0123456789abcd / ハッシュをコピーしました']);
	});

	it('puts the note first on a diff line and skips path:line when the line has no new number', () => {
		const { ops } = recorder();
		expect(shape(buildDiffLineMenu({ path: 'a.ts', line: 42, text: 'x' }, { ...ops, writeNote: () => undefined }))).toEqual({
			title: undefined,
			actions: [
				{ id: 'note', title: 'この行にメモを書く' },
				{ id: 'copy-line', title: 'この行をコピー', section: true },
				{ id: 'copy-location', title: 'パス:行番号をコピー', subtitle: 'a.ts:42' },
			],
		});
		expect((shape(buildDiffLineMenu({ path: 'a.ts', line: undefined, text: 'x' }, ops)) as { actions: { id: string }[] }).actions.map(action => action.id)).toEqual(['copy-line']);
	});

	it('calls the tool file path a path, not a relative path, and reads Windows names', () => {
		const { ops } = recorder();
		expect(shape(buildToolFileMenu({ path: 'C:\\work\\app.ts' }, { ...ops, open: () => undefined }))).toEqual({
			title: 'C:\\work\\app.ts',
			actions: [
				{ id: 'copy-name', title: '名前をコピー', subtitle: 'app.ts' },
				{ id: 'copy-path', title: 'パスをコピー', subtitle: 'C:\\work\\app.ts' },
				{ id: 'open', title: 'ファイルを開く', section: true },
			],
		});
	});

	it('asks the PC for the absolute path only when the item is chosen, and explains why it is greyed out', async () => {
		const { ops, log } = recorder();
		let asked = 0;
		const available = buildCommitFileMenu({ path: 'src/a.ts', absolute: { kind: 'available', hint: '接続先 example-host のパス', load: async () => { asked++; return '/home/example/src/a.ts'; } } }, ops);
		const absolute = (menu: ContextMenuSpec) => shape({ actions: menu.actions.filter(action => action.id === 'copy-absolute') });
		expect({
			available: absolute(available),
			unsupported: absolute(buildCommitFileMenu({ path: 'src/a.ts', absolute: { kind: 'unsupported' } }, ops)),
			offline: absolute(buildCommitFileMenu({ path: 'src/a.ts', absolute: { kind: 'offline' } }, ops)),
			asked,
		}).toEqual({
			available: { title: undefined, actions: [{ id: 'copy-absolute', title: '絶対パスをコピー', subtitle: '接続先 example-host のパス' }] },
			unsupported: { title: undefined, actions: [{ id: 'copy-absolute', title: '絶対パスをコピー', subtitle: 'PC の Para Code を更新すると使えます', disabled: true }] },
			offline: { title: undefined, actions: [{ id: 'copy-absolute', title: '絶対パスをコピー', subtitle: 'PC につながると使えます', disabled: true }] },
			asked: 0,
		});
		select(available, 'copy-absolute');
		await Promise.resolve();
		await Promise.resolve();
		expect({ asked, log }).toEqual({ asked: 1, log: ['copy later /home/example/src/a.ts / 絶対パスをコピーしました'] });
	});
});
