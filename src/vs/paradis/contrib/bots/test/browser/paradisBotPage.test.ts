/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationChangeEvent, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IParadisDialogService } from '../../../confirmDialog/browser/paradisDialogService.js';
import { IParadisHumanAskEntry, IParadisHumanAskService, ParadisHumanAskAnswer, paradisHumanAskCounts } from '../../../humanAsk/common/paradisHumanAsk.js';
import { IParadisInboxClampSize } from '../../../notificationInbox/browser/paradisNotificationInboxAskCard.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { IParadisBotPaneResolver, ParadisBotPage } from '../../browser/paradisBotPage.js';
import { IParadisBotItem } from '../../common/paradisBotItems.js';
import { IParadisBotSummary, IParadisBotsService, PARADIS_BOTS_ENABLED_SETTING } from '../../common/paradisBotsApi.js';

function bot(id: string, name: string, patch: Partial<IParadisBotSummary> = {}): IParadisBotSummary {
	return {
		id, name, folder: id, agent: 'claude', paused: false, pinned: false, faceColor: 'blue', faceShape: 'drop', createdAt: 1, updatedAt: 1,
		needsYou: 0, openItems: 0, openSuggestions: 0, activity: 'idle', lastActivityAt: 1,
		...patch,
	};
}

const now = Date.now();
/** 項目 #42 の問い（台帳の 1 件。鍵は `bot:<項目の uid>.<問いの記録の番号>`）。 */
const ASK: IParadisHumanAskEntry = {
	key: 'bot:u42.3', owner: 'bots', source: 'bot', id: 'u42.3', kind: 'question', from: { title: 'リリース係', detail: '#42 Safari でログインが切れる' },
	questions: [{ id: 'q1', text: '全員を一度ログアウトさせますか?', options: [{ id: 'o1', label: '一度ログアウトさせる' }, { id: 'o2', label: '今のセッションを残す', recommended: true }], allowText: false }],
	actions: [], canSkip: true, askedAt: 1, state: 'waiting',
};

const ITEMS: IParadisBotItem[] = [
	{ uid: 'u42', number: 42, botId: 'release', title: 'Safari でログインが切れる', status: 'needs_you', ask: { eventId: 3, questions: [{ prompt: '全員を一度ログアウトさせますか?', options: [{ label: '一度ログアウトさせる' }, { label: '今のセッションを残す' }], recommended: 1 }] }, links: [], events: [{ id: 1, kind: 'made', actor: 'bot', at: now }], lastEventId: 3, lastActivityAt: now, createdAt: now, updatedAt: now },
	{ uid: 'u43', number: 43, botId: 'release', title: '変更履歴をまとめる', status: 'working', links: [], events: [], lastEventId: 0, lastActivityAt: now - 1000, createdAt: now, updatedAt: now },
];

suite('Paradis bots page overlay', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(items: IParadisBotItem[] = ITEMS, entries: IParadisHumanAskEntry[] = [ASK], measureClamp?: (element: HTMLElement) => IParadisInboxClampSize | undefined) {
		const disposables = store.add(new DisposableStore());
		const instantiation = disposables.add(new TestInstantiationService());
		const configuration = new TestConfigurationService({ [PARADIS_BOTS_ENABLED_SETTING]: true });
		instantiation.stub(IConfigurationService, configuration);
		const bots = [bot('release', 'リリース係', { needsYou: 1 })];
		const answered: { key: string; answer: ParadisHumanAskAnswer }[] = [];
		const statuses: string[] = [];
		const confirms: string[] = [];
		const botsChanged = disposables.add(new Emitter<void>());
		instantiation.stub(IParadisBotsService, {
			get snapshot() { return { revision: 1, readOnly: false, bots }; },
			onDidChange: botsChanged.event,
			onDidRequestStop: Event.None,
			listItems: async () => items,
			ownerSetStatus: async (uid: string, to: string) => { statuses.push(`${uid}:${to}`); return { ok: true, value: items[0] }; },
		} as Partial<IParadisBotsService> as IParadisBotsService);
		instantiation.stub(IParadisHumanAskService, {
			onDidChange: Event.None,
			get snapshot() { return { entries, counts: paradisHumanAskCounts(entries), revision: 1 }; },
			answer: async (key: string, answer: ParadisHumanAskAnswer) => { answered.push({ key, answer }); return { ok: true }; },
		} as Partial<IParadisHumanAskService> as IParadisHumanAskService);
		instantiation.stub(IParadisDialogService, { confirm: async (options: { message: string }) => { confirms.push(options.message); return { confirmed: true }; } } as Partial<IParadisDialogService> as IParadisDialogService);
		instantiation.stub(IContextMenuService, {});
		instantiation.stub(IOpenerService, {});
		instantiation.stub(INotificationService, new TestNotificationService());
		instantiation.stub(IHoverService, NullHoverService);
		// ペイン 1 だけが Bot のペイン。`ended` でペインが終わったことにする
		const changed = disposables.add(new Emitter<void>());
		const panes = new Map<number, string>([[1, 'release']]);
		const resolver: IParadisBotPaneResolver = { onDidChange: changed.event, botFor: async instanceId => panes.get(instanceId) };
		const container = document.createElement('div');
		const page = disposables.add(instantiation.createInstance(ParadisBotPage, container, resolver, measureClamp));
		return { container, page, configuration, panes, changed, answered, disposables, bots, botsChanged, statuses, confirms };
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

	test('項目のタブで一覧と受信箱と同じ問いのカードを出し、出た直後の押下は効かせず、答えは「聞く・答える」の台帳へ送る', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { container, page, answered } = setup();
		page.setInstance(1);
		await settle();
		(container.getElementsByClassName('paradis-bot-page-tab')[1] as HTMLElement).click();
		await settle();
		const rows = Array.from(container.getElementsByClassName('paradis-bot-page-row')).map(row => row.textContent);
		(container.getElementsByClassName('paradis-bot-page-row')[0] as HTMLElement).click();
		await settle();
		const buttons = () => Array.from(container.querySelectorAll<HTMLElement>('.paradis-bot-page-ask .pnip-ask-buttons .paradis-button'));
		const labels = buttons().map(button => button.textContent);
		// 出た直後の押下は効かない（受信箱と同じ 0.6 秒の守り）
		buttons()[1].click();
		await settle();
		const whileGuarded = answered.length;
		await new Promise(resolve => setTimeout(resolve, 600));
		buttons()[1].click();
		await settle();
		assert.deepStrictEqual([state(container), rows.length, labels, whileGuarded, answered], [
			{ strip: true, panel: true, active: true, items: true },
			2,
			['一度ログアウトさせる', '今のセッションを残す（おすすめ）', '飛ばす'],
			0,
			[{ key: 'bot:u42.3', answer: { type: 'answers', answers: [{ questionId: 'q1', optionIds: ['o2'] }] } }],
		]);
	}));

	test('問いの中身がカードの枠から溢れたら、行の中で答えさせず受信箱と同じモーダルで答える', async () => {
		const permission: IParadisHumanAskEntry = { ...ASK, kind: 'permission', questions: [], preface: 'Bash: npm test\n'.repeat(12), actions: [{ id: 'yes', label: '許可' }, { id: 'no', label: '拒否' }] };
		const { container, page, answered, disposables } = setup(ITEMS, [permission], () => ({ shown: 96, full: 200 }));
		document.body.appendChild(container);
		disposables.add(toDisposable(() => container.remove()));
		page.setInstance(1);
		await settle();
		(container.getElementsByClassName('paradis-bot-page-tab')[1] as HTMLElement).click();
		await settle();
		(container.getElementsByClassName('paradis-bot-page-row')[0] as HTMLElement).click();
		await settle();
		const labels = Array.from(container.querySelectorAll('.paradis-bot-page-ask .pnip-ask-buttons .paradis-button')).map(button => button.textContent);
		(container.querySelector('.paradis-bot-page-ask .pnip-ask-buttons .paradis-button') as HTMLElement).click();
		await settle();
		const dialogs = document.body.getElementsByClassName('paradis-inbox-ask-dialog').length;
		assert.deepStrictEqual({ labels, dialogs, answered }, { labels: ['中身を確かめて答える', '飛ばす'], dialogs: 1, answered: [] });
	});

	test('変換中に面が外れても、次に開いた項目の面を描く', async () => {
		const { container, page } = setup();
		page.setInstance(1);
		await settle();
		const tab = (index: number) => (container.getElementsByClassName('paradis-bot-page-tab')[index] as HTMLElement).click();
		tab(1);
		await settle();
		(container.getElementsByClassName('paradis-bot-page-row')[1] as HTMLElement).click();
		await settle();
		// 変換を始めたまま会話のタブへ移る（compositionend は届かない）
		(container.querySelector('.paradis-bot-page-comment textarea') as HTMLElement).dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
		tab(0);
		tab(1);
		await settle();
		assert.deepStrictEqual(container.querySelectorAll('.paradis-bot-page-comment textarea').length, 1);
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

	test('書きかけのコメントは、別の Bot が変わっても値とフォーカスが残る（中身の変わらない描き直しはしない）', async () => {
		const { container, page, bots, botsChanged, disposables } = setup();
		document.body.appendChild(container);
		disposables.add(toDisposable(() => container.remove()));
		page.setInstance(1);
		await settle();
		(container.getElementsByClassName('paradis-bot-page-tab')[1] as HTMLElement).click();
		await settle();
		(container.getElementsByClassName('paradis-bot-page-row')[1] as HTMLElement).click();
		await settle();
		const text = container.querySelector('.paradis-bot-page-comment textarea') as HTMLTextAreaElement;
		text.focus();
		text.value = '書きかけ';
		text.dispatchEvent(new InputEvent('input'));
		bots.push(bot('other', '別の係'));
		botsChanged.fire();
		await settle();
		const after = container.querySelector('.paradis-bot-page-comment textarea') as HTMLTextAreaElement;
		assert.deepStrictEqual({ same: after === text, value: after.value, focused: document.activeElement === after }, { same: true, value: '書きかけ', focused: true });
	});

	test('「完了にする」は確かめてから閉じ、閉じた項目には「戻す」を出す', async () => {
		const closed: IParadisBotItem = { ...ITEMS[1], uid: 'u44', number: 44, status: 'done', closedAt: now };
		const { container, page, statuses, confirms } = setup([ITEMS[1], closed]);
		page.setInstance(1);
		await settle();
		(container.getElementsByClassName('paradis-bot-page-tab')[1] as HTMLElement).click();
		await settle();
		(container.getElementsByClassName('paradis-bot-page-row')[0] as HTMLElement).click();
		await settle();
		const labels = () => Array.from(container.querySelectorAll('.paradis-bot-page-item-actions .paradis-button')).map(button => button.textContent);
		const open = labels();
		(container.querySelector('.paradis-bot-page-item-actions .paradis-button') as HTMLElement).click();
		await settle();
		(container.querySelector('.paradis-bot-page-back') as HTMLElement).click();
		await settle();
		(container.querySelector('details.paradis-bot-page-fold .paradis-bot-page-row') as HTMLElement).click();
		await settle();
		const closedLabels = labels();
		(container.querySelector('.paradis-bot-page-item-actions .paradis-button') as HTMLElement).click();
		await settle();
		assert.deepStrictEqual({ open, confirms, closedLabels, statuses }, {
			open: ['完了にする...', '後回し...', '取りやめる...'],
			confirms: ['項目 #43 を完了にしますか?'],
			closedLabels: ['戻す'],
			statuses: ['u43:done', 'u44:working'],
		});
	});
});
