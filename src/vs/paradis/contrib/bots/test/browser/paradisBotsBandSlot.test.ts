/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationChangeEvent, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { InMemoryStorageService, IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IParadisDialogService } from '../../../confirmDialog/browser/paradisDialogService.js';
import { ParadisBotsBandSlot } from '../../browser/paradisBotsBand.js';
import { IParadisBotGroup } from '../../common/paradisBotGroups.js';
import { IParadisBotGroupsService, IParadisBotGroupsSnapshot } from '../../common/paradisBotGroupsApi.js';
import { IParadisBotSummary, IParadisBotsService, IParadisBotsSnapshot, PARADIS_BOTS_ENABLED_SETTING } from '../../common/paradisBotsApi.js';
import { PARADIS_BOTS_BAND_STORAGE_KEY } from '../../common/paradisBotsBandModel.js';
import { ParadisBotCreateDialog } from '../../browser/paradisBotCreateDialog.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';

function bot(id: string, name: string, patch: Partial<IParadisBotSummary> = {}): IParadisBotSummary {
	return {
		id, name, folder: id, agent: 'claude', paused: false, pinned: false, faceColor: 'blue', faceShape: 'drop', createdAt: 1, updatedAt: 1,
		needsYou: 0, openItems: 0, openSuggestions: 0, activity: 'stopped', lastActivityAt: 1,
		...patch,
	};
}

suite('Paradis bots band slot', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(enabled: boolean, bandState?: string, groups: readonly IParadisBotGroup[] = [], records: IParadisBotGroupsSnapshot['records'] = []): { container: HTMLElement; configuration: TestConfigurationService; slot: ParadisBotsBandSlot; snapshotReads: () => number } {
		const disposables = store.add(new DisposableStore());
		const instantiation = disposables.add(new TestInstantiationService());
		const configuration = new TestConfigurationService({ [PARADIS_BOTS_ENABLED_SETTING]: enabled });
		instantiation.stub(IConfigurationService, configuration);
		const storage = disposables.add(new InMemoryStorageService());
		if (bandState) {
			storage.store(PARADIS_BOTS_BAND_STORAGE_KEY, bandState, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		instantiation.stub(IStorageService, storage);
		let reads = 0;
		const snapshot: IParadisBotsSnapshot = {
			revision: 1, readOnly: false, bots: [
				bot('a', 'リリース係', { needsYou: 2 }),
				bot('b', 'レビュー係', { pinned: true, needsYou: 1 }),
				bot('c', '翻訳係', { paused: true }),
			],
		};
		instantiation.stub(IParadisBotsService, {
			get snapshot() { reads++; return snapshot; },
			onDidChange: Event.None,
			onDidRequestStop: Event.None,
		} as Partial<IParadisBotsService> as IParadisBotsService);
		instantiation.stub(IParadisBotGroupsService, {
			snapshot: { revision: 1, readOnly: false, groups, records },
			onDidChange: Event.None,
		} as Partial<IParadisBotGroupsService> as IParadisBotGroupsService);
		instantiation.stub(ICommandService, {});
		instantiation.stub(IContextMenuService, {});
		instantiation.stub(IHoverService, NullHoverService);
		instantiation.stub(IQuickInputService, {});
		instantiation.stub(IParadisDialogService, {});
		instantiation.stub(INotificationService, new TestNotificationService());
		const container = document.createElement('div');
		const slot = disposables.add(instantiation.createInstance(ParadisBotsBandSlot, container));
		return { container, configuration, slot, snapshotReads: () => reads };
	}

	function rows(container: HTMLElement): string[] {
		return Array.from(container.getElementsByClassName('paradis-bots-row')).map(row => row.getAttribute('aria-label') ?? '');
	}

	test('設定がオフなら帯を出さず、Bot のサービスにも触れない', () => {
		const { container, slot, snapshotReads } = setup(false);
		assert.deepStrictEqual([container.childElementCount, slot.shown, slot.layout(800), snapshotReads()], [0, false, false, 0]);
	});

	test('オンなら帯を出し、設定をオフにすると外す', () => {
		const { container, configuration, slot } = setup(true);
		const before = [slot.shown, container.getElementsByClassName('paradis-bots-band').length, rows(container).length, container.getElementsByClassName('paradis-bots-band-badge')[0]?.textContent];
		configuration.setUserConfiguration(PARADIS_BOTS_ENABLED_SETTING, false);
		configuration.onDidChangeConfigurationEmitter.fire({ affectsConfiguration: (key: string) => key === PARADIS_BOTS_ENABLED_SETTING } as unknown as IConfigurationChangeEvent);
		assert.deepStrictEqual([before, [slot.shown, container.childElementCount]], [[true, 1, 3, '3'], [false, 0]]);
	});

	test('帯を閉じているとピン留めの行だけ残る', () => {
		const { container } = setup(true, '{"open":false}');
		assert.deepStrictEqual(rows(container), ['レビュー係、1 件があなたの番']);
	});

	test('開いているとグループの見出しと行を Bot の後に出し、閉じると出さない（消した Bot はメンバーに数えない）', () => {
		const group: IParadisBotGroup = { id: 'g1', name: 'リリース班', members: ['a', 'b', 'gone'], replyMode: 'mentioned', createdAt: 1, updatedAt: 1 };
		const open = setup(true, '{"open":true}', [group]);
		const closed = setup(true, '{"open":false}', [group]);
		assert.deepStrictEqual([
			rows(open.container).slice(3),
			Array.from(open.container.getElementsByClassName('paradis-bots-band-section')).map(element => element.textContent),
			rows(closed.container),
		], [
			['グループ リリース班、リリース係・レビュー係'],
			['グループ'],
			['レビュー係、1 件があなたの番'],
		]);
	});

	test('受け箱の未読を Bot の行に出す（ピン留めの行も）。読んだ伝言・抜けたグループの伝言は数えない', () => {
		const group: IParadisBotGroup = { id: 'g1', name: '班', members: ['a', 'b'], replyMode: 'mentioned', createdAt: 1, updatedAt: 1 };
		const record = (id: number, to: string, readAt?: number) => ({ id, groupId: 'g1', kind: 'told' as const, from: to === 'a' ? 'b' : 'a', to: [to], text: 't', at: 1, ...(readAt !== undefined ? { readAt } : {}) });
		const records = [record(1, 'b'), record(2, 'b'), record(3, 'b', 5), record(4, 'a'), { ...record(5, 'b'), groupId: 'gone' }];
		const unread = (container: HTMLElement) => Array.from(container.getElementsByClassName('paradis-bots-row')).map(row => row.getElementsByClassName('paradis-bots-row-unread')[0]?.textContent ?? '');
		assert.deepStrictEqual([unread(setup(true, '{"open":true}', [group], records).container), unread(setup(true, '{"open":false}', [group], records).container)], [['1', '2', '', ''], ['2']]);
	});

	test('作成のモーダルは、開いている間に設定をオフにすると閉じる', () => {
		const disposables = store.add(new DisposableStore());
		const instantiation = disposables.add(new TestInstantiationService());
		const configuration = new TestConfigurationService({ [PARADIS_BOTS_ENABLED_SETTING]: true });
		instantiation.stub(IConfigurationService, configuration);
		const host = document.createElement('div');
		instantiation.stub(ILayoutService, { activeContainer: host } as Partial<ILayoutService> as ILayoutService);
		instantiation.stub(IParadisBotsService, { snapshot: { revision: 1, readOnly: false, bots: [] }, onDidChange: Event.None } as Partial<IParadisBotsService> as IParadisBotsService);
		instantiation.stub(IHoverService, NullHoverService);
		instantiation.stub(IContextViewService, {});
		disposables.add(instantiation.createInstance(ParadisBotCreateDialog, undefined, () => { }, false));
		const open = host.childElementCount;
		configuration.setUserConfiguration(PARADIS_BOTS_ENABLED_SETTING, false);
		configuration.onDidChangeConfigurationEmitter.fire({ affectsConfiguration: (key: string) => key === PARADIS_BOTS_ENABLED_SETTING } as unknown as IConfigurationChangeEvent);
		assert.deepStrictEqual([open, host.childElementCount], [1, 0]);
	});

	test('テンプレートの一覧（入れ子の箱）で Esc を押すと一覧だけを閉じ、作成のモーダルは残る。もう一度押すと作成のモーダルを閉じる', () => {
		const disposables = store.add(new DisposableStore());
		const instantiation = disposables.add(new TestInstantiationService());
		instantiation.stub(IConfigurationService, new TestConfigurationService({ [PARADIS_BOTS_ENABLED_SETTING]: true }));
		const host = document.createElement('div');
		mainWindow.document.body.appendChild(host);
		disposables.add({ dispose: () => host.remove() });
		instantiation.stub(ILayoutService, { activeContainer: host } as Partial<ILayoutService> as ILayoutService);
		instantiation.stub(IParadisBotsService, { snapshot: { revision: 1, readOnly: false, bots: [] }, onDidChange: Event.None } as Partial<IParadisBotsService> as IParadisBotsService);
		instantiation.stub(IHoverService, NullHoverService);
		instantiation.stub(IContextViewService, {});
		instantiation.stub(INotificationService, new TestNotificationService());
		disposables.add(instantiation.createInstance(ParadisBotCreateDialog, undefined, () => { }, true));
		const escape = () => mainWindow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
		const open = host.childElementCount;
		escape();
		const afterFirst = host.childElementCount;
		escape();
		assert.deepStrictEqual([open, afterFirst, host.childElementCount], [2, 1, 0]);
	});
});
