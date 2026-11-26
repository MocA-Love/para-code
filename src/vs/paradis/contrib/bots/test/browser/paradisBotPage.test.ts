/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
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
import { ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisAgentChatService } from '../../../agentChat/browser/paradisAgentChatService.js';
import { IParadisBotPaneResolver, ParadisBotPage } from '../../browser/paradisBotPage.js';
import { IParadisBotPatrolPort } from '../../browser/paradisBotPatrol.js';
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
const ITEMS: IParadisBotItem[] = [
	{ uid: 'u42', number: 42, botId: 'release', title: 'Safari でログインが切れる', status: 'needs_you', ask: { eventId: 3, questions: [{ prompt: '全員を一度ログアウトさせますか?', options: [{ label: '一度ログアウトさせる' }, { label: '今のセッションを残す' }], recommended: 1 }] }, links: [], events: [{ id: 1, kind: 'made', actor: 'bot', at: now }], lastEventId: 3, lastActivityAt: now, createdAt: now, updatedAt: now },
	{ uid: 'u43', number: 43, botId: 'release', title: '変更履歴をまとめる', status: 'working', links: [], events: [], lastEventId: 0, lastActivityAt: now - 1000, createdAt: now, updatedAt: now },
];

suite('Paradis bots page overlay', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(patrol?: IParadisBotPatrolPort) {
		let header: { status: string; attention: boolean; busy: boolean; model: string; agent: undefined; agentName: string } | undefined;
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
			listSuggestions: async () => [{ id: 's1', botId: 'release', title: 'PR #1108 のレビューの指摘 2 件に返事が無い', request: '#1108 の指摘を読んで、直すか理由を返すか決めて', run: 'r', state: 'open', createdAt: 1 }],
			startSuggestion: async (id: string) => { calls.push(`start ${id}`); return { ok: true, value: { id, botId: 'release', title: 't', request: '#1108 の指摘を読んで、直すか理由を返すか決めて', run: 'r', state: 'started', createdAt: 1 } }; },
			dismissSuggestion: async (id: string) => { calls.push(`dismiss ${id}`); return { ok: true, value: {} }; },
			undoMemoryTidy: async () => { calls.push('undo'); return { ok: true, value: { restored: ['MEMORY.md'], added: [], takenAt: 1 } }; },
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
		let draftTaken = false;
		const headerChanged = disposables.add(new Emitter<number>());
		const headerCalls: string[] = [];
		const chatActive = new Set<number>();
		const chatActiveChanged = disposables.add(new Emitter<number>());
		let holds = 0;
		instantiation.stub(IParadisAgentChatService, {
			insertDraft: (id: number, text: string) => { calls.push(`draft ${id} ${text}`); return draftTaken ? 'inserted' : false; },
			onDidChangeHeader: headerChanged.event,
			headerState: () => header,
			isChatActive: (id: number) => chatActive.has(id),
			onDidChangeChatActive: chatActiveChanged.event,
			setHeaderHidden: (id: number) => {
				const hold = ++holds;
				headerCalls.push(`hide ${id} #${hold}`);
				return toDisposable(() => headerCalls.push(`unhide ${id} #${hold}`));
			},
			showTerminal: (id: number) => headerCalls.push(`terminal ${id}`),
		} as unknown as IParadisAgentChatService);
		instantiation.stub(ITerminalService, { getInstanceFromId: (id: number) => id === 1 ? { isDisposed: false, sendText: async (text: string, execute: boolean, paste: boolean) => { calls.push(`send ${text} ${execute} ${paste}`); } } : undefined } as unknown as ITerminalService);
		instantiation.stub(IContextMenuService, {});
		instantiation.stub(IOpenerService, {});
		instantiation.stub(INotificationService, new TestNotificationService());
		// ペイン 1 だけが Bot のペイン。`ended` でペインが終わったことにする
		const changed = disposables.add(new Emitter<void>());
		const panes = new Map<number, string>([[1, 'release']]);
		const resolver: IParadisBotPaneResolver = { onDidChange: changed.event, botFor: async instanceId => panes.get(instanceId) };
		const container = document.createElement('div');
		const page = disposables.add(instantiation.createInstance(ParadisBotPage, container, resolver, patrol));
		return { container, page, configuration, panes, changed, answered, disposables, calls, confirms, files, chatShown: () => { draftTaken = true; }, headerCalls, setHeader: (value: typeof header) => { header = value; headerChanged.fire(1); }, setChatActive: (id: number, active: boolean) => { if (active) { chatActive.add(id); } else { chatActive.delete(id); } chatActiveChanged.fire(id); } };
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

	test('提案: 「始める」はチャット表示の入力欄へ下書きを入れ（無ければターミナルへ貼り付け）、会話へ戻す。「見送る」は台帳へ知らせる', async () => {
		const { container, page, calls, chatShown } = setup();
		page.setInstance(1);
		await settle();
		tab(container, 1);
		await settle();
		const titles = Array.from(container.getElementsByClassName('paradis-bot-page-suggestion-title')).map(title => title.textContent);
		(container.querySelector('.paradis-bot-page-suggestion .paradis-button-secondary') as HTMLElement).click();
		await settle();
		(container.querySelector('.paradis-bot-page-suggestion .paradis-button-primary') as HTMLElement).click();
		await settle();
		await settle();
		chatShown();
		tab(container, 1);
		await settle();
		(container.querySelector('.paradis-bot-page-suggestion .paradis-button-primary') as HTMLElement).click();
		await settle();
		await settle();
		const selected = Array.from(container.getElementsByClassName('paradis-bot-page-tab')).map(element => element.getAttribute('aria-selected'));
		assert.deepStrictEqual([titles, calls, selected], [
			['PR #1108 のレビューの指摘 2 件に返事が無い'],
			['dismiss s1', 'start s1', 'draft 1 #1108 の指摘を読んで、直すか理由を返すか決めて', 'send #1108 の指摘を読んで、直すか理由を返すか決めて false true', 'start s1', 'draft 1 #1108 の指摘を読んで、直すか理由を返すか決めて'],
			['true', 'false', 'false', 'false'],
		]);
	});

	test('ファイル: 記憶の整理を確かめてから取り消す', async () => {
		const { container, page, calls, confirms } = setup();
		page.setInstance(1);
		await settle();
		tab(container, 2);
		await settle();
		(container.getElementsByClassName('paradis-bot-page-row')[1] as HTMLElement).click();
		await settle();
		await settle();
		(container.querySelector('.paradis-bot-settings-foot .paradis-button-secondary') as HTMLElement).click();
		await settle();
		await settle();
		assert.deepStrictEqual([calls, confirms.map(confirmation => [confirmation.primaryButton, confirmation.destructive])], [['undo'], [['取り消す', true]]]);
	});

	test('見回り: ホームの「定期実行」の節と、設定のタブの欄から保存・今すぐ見回る', async () => {
		const patrolCalls: string[] = [];
		const port: IParadisBotPatrolPort = {
			onDidChange: Event.None,
			get: async () => ({ definitionId: 'd', enabled: true, schedule: { everyHours: 4, fromHour: 8, toHour: 20, weekdaysOnly: true }, cron: '0 8-20/4 * * 1-5', lookFor: '返事の無い指摘', gate: 'paused' }),
			set: async (botId, input) => { patrolCalls.push(`set ${botId} ${JSON.stringify(input)}`); return { ok: true }; },
			runNow: async botId => { patrolCalls.push(`run ${botId}`); return { ok: true }; },
		};
		const { container, page } = setup(port);
		page.setInstance(1);
		await settle();
		(container.getElementsByClassName('paradis-bot-page-tab')[1] as HTMLElement).click();
		await settle();
		await settle();
		const home = Array.from(container.getElementsByClassName('paradis-bot-patrol-line')).map(line => line.textContent);
		const homeButtons = Array.from(container.querySelectorAll('.paradis-bot-patrol .monaco-button')).map(button => button.textContent);
		(container.querySelectorAll('.paradis-bot-patrol .monaco-button')[0] as HTMLElement).click();
		await settle();
		(container.querySelectorAll('.paradis-bot-patrol .monaco-button')[1] as HTMLElement).click();
		await settle();
		await settle();
		const sections = Array.from(container.getElementsByClassName('paradis-bot-page-section')).map(section => section.textContent);
		const save = Array.from(container.querySelectorAll('.monaco-button')).find(button => button.textContent === '見回りを保存') as HTMLElement;
		save.click();
		await settle();
		await settle();
		assert.deepStrictEqual({ home, homeButtons, sections: sections.slice(-1), patrolCalls }, {
			home: ['一時停止中のため見回りません'],
			homeButtons: ['今すぐ見回る', '変える...'],
			sections: ['見回り'],
			patrolCalls: ['run release', 'set release {"schedule":{"everyHours":4,"fromHour":8,"toHour":20,"weekdaysOnly":true},"lookFor":"返事の無い指摘","enabled":true}'],
		});
	});

	test('チャット表示を見ている間だけ、見出しの状態とモデルを帯に出して見出しを畳む（会話が替われば畳み直し、離れたら戻す）', async () => {
		const { container, page, headerCalls, setHeader, setChatActive } = setup();
		const strip = () => ({
			status: container.getElementsByClassName('paradis-bot-page-status')[0]?.textContent,
			attention: container.getElementsByClassName('paradis-bot-page-status')[0]?.classList.contains('attention'),
			model: (container.getElementsByClassName('paradis-bot-page-model')[0] as HTMLElement | undefined)?.hidden ? '' : container.getElementsByClassName('paradis-bot-page-model')[0]?.textContent,
			terminal: !(container.getElementsByClassName('paradis-bot-page-terminal')[0] as HTMLElement).hidden,
		});
		page.setInstance(1);
		await settle();
		setHeader({ status: '許可を待っています', attention: true, busy: false, model: 'claude-opus-4-5 · high', agent: undefined, agentName: 'Claude Code' });
		const terminalView = strip();
		setChatActive(1, true);
		const chatView = strip();
		// 会話が替わった（チャット表示の側が畳みを戻した）ときも、見出しの知らせで畳み直す
		setHeader({ status: '入力を待っています', attention: false, busy: false, model: 'claude-opus-4-5 · high', agent: undefined, agentName: 'Claude Code' });
		(container.getElementsByClassName('paradis-bot-page-terminal')[0] as HTMLElement).click();
		setChatActive(1, false);
		const backToTerminal = strip();
		setChatActive(1, true);
		page.setInstance(2);
		await settle();
		page.dispose();
		assert.deepStrictEqual({ terminalView, chatView, backToTerminal, calls: headerCalls }, {
			terminalView: { status: '1 件があなたの番', attention: false, model: '', terminal: false },
			chatView: { status: '許可を待っています', attention: true, model: 'claude-opus-4-5 · high', terminal: true },
			backToTerminal: { status: '1 件があなたの番', attention: false, model: '', terminal: false },
			calls: ['hide 1 #1', 'hide 1 #2', 'unhide 1 #1', 'terminal 1', 'unhide 1 #2', 'hide 1 #3', 'unhide 1 #3'],
		});
	});
});
