/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationChangeEvent, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IParadisConfirmation, IParadisDialogService } from '../../../confirmDialog/browser/paradisDialogService.js';
import { IParadisHumanAskService, ParadisHumanAskAnswer } from '../../../humanAsk/common/paradisHumanAsk.js';
import { IParadisBotPaneResolver, ParadisBotPage } from '../../browser/paradisBotPage.js';
import { IParadisBotItem } from '../../common/paradisBotItems.js';
import { IParadisBotSummary, IParadisBotsService, PARADIS_BOTS_ENABLED_SETTING } from '../../common/paradisBotsApi.js';

function bot(id: string, name: string, patch: Partial<IParadisBotSummary> = {}): IParadisBotSummary {
	return {
		id, name, folder: id, agent: 'claude', paused: false, pinned: false, faceColor: 'blue', faceShape: 'drop', createdAt: 1, updatedAt: 1,
		needsYou: 0, openItems: 0, activity: 'idle', lastActivityAt: 1,
		...patch,
	};
}

const now = Date.now();
const ITEMS: IParadisBotItem[] = [
	{ uid: 'u42', number: 42, botId: 'release', title: 'Safari でログインが切れる', status: 'needs_you', ask: { eventId: 3, questions: [{ prompt: '全員を一度ログアウトさせますか?', options: [{ label: '一度ログアウトさせる' }, { label: '今のセッションを残す' }], recommended: 1 }] }, links: [], events: [{ id: 1, kind: 'made', actor: 'bot', at: now }], lastEventId: 3, lastActivityAt: now, createdAt: now, updatedAt: now },
	{ uid: 'u43', number: 43, botId: 'release', title: '変更履歴をまとめる', status: 'working', links: [], events: [], lastEventId: 0, lastActivityAt: now - 1000, createdAt: now, updatedAt: now },
];

suite('Paradis bots page overlay', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const disposables = store.add(new DisposableStore());
		const instantiation = disposables.add(new TestInstantiationService());
		const configuration = new TestConfigurationService({ [PARADIS_BOTS_ENABLED_SETTING]: true });
		instantiation.stub(IConfigurationService, configuration);
		const bots = [bot('release', 'リリース係', { needsYou: 1 })];
		const answered: { key: string; answer: ParadisHumanAskAnswer }[] = [];
		const calls: string[] = [];
		const confirms: IParadisConfirmation[] = [];
		const files = new Map<string, string>([['SOUL.md', '# リリース係\n'], ['MEMORY.md', '# Memory\n']]);
		instantiation.stub(IParadisBotsService, {
			get snapshot() { return { revision: 1, readOnly: false, bots }; },
			onDidChange: Event.None,
			onDidRequestStop: Event.None,
			listItems: async () => ITEMS,
			readHomeFile: async (_bot: string, path: string) => ({ ok: true, value: files.get(path) }),
			writeHomeFile: async (_bot: string, path: string, text: string) => { calls.push(`write ${path}: ${text}`); files.set(path, text); return { ok: true, value: undefined }; },
			updateBot: async (_bot: string, patch: object) => { calls.push(`update ${JSON.stringify(patch)}`); return { ok: true, value: bots[0] }; },
		} as unknown as IParadisBotsService);
		instantiation.stub(IParadisHumanAskService, {
			onDidChange: Event.None,
			answer: async (key: string, answer: ParadisHumanAskAnswer) => { answered.push({ key, answer }); return { ok: true }; },
		} as Partial<IParadisHumanAskService> as IParadisHumanAskService);
		instantiation.stub(IParadisDialogService, { confirm: async (confirmation: IParadisConfirmation) => { confirms.push(confirmation); return { confirmed: true }; } } as unknown as IParadisDialogService);
		instantiation.stub(IContextViewService, {});
		instantiation.stub(IContextMenuService, {});
		instantiation.stub(IOpenerService, {});
		instantiation.stub(INotificationService, new TestNotificationService());
		// ペイン 1 だけが Bot のペイン。`ended` でペインが終わったことにする
		const changed = disposables.add(new Emitter<void>());
		const panes = new Map<number, string>([[1, 'release']]);
		const resolver: IParadisBotPaneResolver = { onDidChange: changed.event, botFor: async instanceId => panes.get(instanceId) };
		const container = document.createElement('div');
		const page = disposables.add(instantiation.createInstance(ParadisBotPage, container, resolver));
		return { container, page, configuration, panes, changed, answered, disposables, calls, confirms, files };
	}

	const settle = () => new Promise(resolve => setTimeout(resolve, 0));

	function state(container: HTMLElement, page?: ParadisBotPage) {
		const strip = container.getElementsByClassName('paradis-bot-page-strip')[0] as HTMLElement | undefined;
		const panel = container.getElementsByClassName('paradis-bot-page-panel')[0] as HTMLElement | undefined;
		return {
			strip: strip ? !strip.hidden : false,
			panel: panel ? !panel.hidden : false,
			active: container.classList.contains('paradis-bot-page-active'),
			items: container.classList.contains('paradis-bot-page-items'),
			...(page ? { inset: page.topInset() } : {}),
		};
	}

	test('Bot のペインだけに帯を出し、ペインが替わる・終わる・設定を切るたびに外す', async () => {
		const { container, page, configuration, panes, changed } = setup();
		const seen = [];
		page.setInstance(1);
		await settle();
		seen.push(state(container, page));
		page.setInstance(2);
		await settle();
		seen.push(state(container, page));
		page.setInstance(1);
		await settle();
		panes.delete(1);
		changed.fire();
		await settle();
		seen.push(state(container, page));
		panes.set(1, 'release');
		changed.fire();
		await settle();
		configuration.setUserConfiguration(PARADIS_BOTS_ENABLED_SETTING, false);
		configuration.onDidChangeConfigurationEmitter.fire({ affectsConfiguration: (key: string) => key === PARADIS_BOTS_ENABLED_SETTING } as unknown as IConfigurationChangeEvent);
		await settle();
		seen.push(state(container, page));
		const off = { strip: false, panel: false, active: false, items: false, inset: 0 };
		assert.deepStrictEqual(seen, [{ strip: true, panel: false, active: true, items: false, inset: 40 }, off, off, off]);
	});

	test('項目のタブで一覧と問いのカードを出し、答えは「聞く・答える」の台帳へ送る', async () => {
		const { container, page, answered } = setup();
		page.setInstance(1);
		await settle();
		(container.getElementsByClassName('paradis-bot-page-tab')[1] as HTMLElement).click();
		await settle();
		const rows = Array.from(container.getElementsByClassName('paradis-bot-page-row')).map(row => row.textContent);
		(container.getElementsByClassName('paradis-bot-page-row')[0] as HTMLElement).click();
		await settle();
		const options = Array.from(container.getElementsByClassName('paradis-bot-page-ask-option')).map(option => option.textContent);
		(container.getElementsByClassName('paradis-bot-page-ask-option')[1] as HTMLElement).click();
		(container.querySelector('.paradis-bot-page-ask-actions .paradis-button-primary') as HTMLElement).click();
		await settle();
		assert.deepStrictEqual([state(container), rows.length, options, answered], [
			{ strip: true, panel: true, active: true, items: true },
			2,
			['一度ログアウトさせる', '今のセッションを残すおすすめ'],
			[{ key: 'bot:u42.3', answer: { type: 'answers', answers: [{ questionId: 'q1', optionIds: ['o2'] }] } }],
		]);
	});

	test('タブを閉じたら帯・面・印を残さない', async () => {
		const { container, page, disposables } = setup();
		page.setInstance(1);
		await settle();
		(container.getElementsByClassName('paradis-bot-page-tab')[1] as HTMLElement).click();
		await settle();
		disposables.dispose();
		assert.deepStrictEqual([container.childElementCount, container.className], [0, '']);
	});

	function tab(container: HTMLElement, index: number): void {
		(container.getElementsByClassName('paradis-bot-page-tab')[index] as HTMLElement).click();
	}

	function primary(container: HTMLElement): HTMLElement {
		return container.querySelector('.paradis-bot-settings-foot .paradis-button-primary') as HTMLElement;
	}

	test('設定: 名前だけなら確かめずに当て、役割を変えるときは管理の道具と同じ本文で確かめてから書く', async () => {
		const { container, page, calls, confirms } = setup();
		page.setInstance(1);
		await settle();
		tab(container, 3);
		await settle();
		await settle();
		const name = container.querySelector('.paradis-bot-settings-value input') as HTMLInputElement;
		name.value = '出荷係';
		name.dispatchEvent(new mainWindow.Event('input'));
		primary(container).click();
		await settle();
		const role = container.querySelector('.paradis-bot-settings-role textarea') as HTMLTextAreaElement;
		role.value = '# 新しい役割\n';
		role.dispatchEvent(new mainWindow.Event('input'));
		primary(container).click();
		await settle();
		await settle();
		assert.deepStrictEqual([calls, confirms.map(confirmation => [confirmation.primaryButton, String(confirmation.detail).includes('依頼'), String(confirmation.detail).includes('# 新しい役割')])], [
			['update {"name":"出荷係"}', 'write SOUL.md: # 新しい役割\n'],
			[['変える', false, true]],
		]);
	});

	test('ファイル: 開いた後に書き換わった記憶は上書きしない', async () => {
		const { container, page, calls, files } = setup();
		page.setInstance(1);
		await settle();
		tab(container, 2);
		await settle();
		(container.getElementsByClassName('paradis-bot-page-row')[1] as HTMLElement).click();
		await settle();
		await settle();
		const editor = container.querySelector('.paradis-bot-files-editor textarea') as HTMLTextAreaElement;
		editor.value = '# Memory\n- 自分の編集\n';
		editor.dispatchEvent(new mainWindow.Event('input'));
		files.set('MEMORY.md', '# Memory\n- Bot が足した行\n');
		primary(container).click();
		await settle();
		await settle();
		assert.deepStrictEqual([calls, files.get('MEMORY.md')], [[], '# Memory\n- Bot が足した行\n']);
	});
});
