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
import { INotificationHandle, INotificationService, NotificationMessage } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IParadisConfirmation, IParadisDialogService } from '../../../confirmDialog/browser/paradisDialogService.js';
import { IParadisHumanAskEntry, IParadisHumanAskService, ParadisHumanAskAnswer, paradisHumanAskCounts } from '../../../humanAsk/common/paradisHumanAsk.js';
import { IParadisInboxClampSize } from '../../../notificationInbox/browser/paradisNotificationInboxAskCard.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { InMemoryStorageService, IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisAgentChatPersona, IParadisAgentChatService } from '../../../agentChat/browser/paradisAgentChatService.js';
import { IParadisAgentChatGuide } from '../../../agentChat/common/paradisAgentChat.js';
import { IParadisBotPaneResolver, ParadisBotPage } from '../../browser/paradisBotPage.js';
import { IParadisBotPatrolPort } from '../../browser/paradisBotPatrol.js';
import { paradisRequestBotPageTab } from '../../browser/paradisBotPageTabRequest.js';
import { IParadisBotGroupsService } from '../../common/paradisBotGroupsApi.js';
import { IParadisBotItem } from '../../common/paradisBotItems.js';
import { IParadisBotSummary, IParadisBotsService, PARADIS_BOTS_ENABLED_SETTING } from '../../common/paradisBotsApi.js';
import { PARADIS_BOT_VIEWS_STORAGE_KEY } from '../../common/paradisBotPageModel.js';
import { PARADIS_BOT_GREETING_PROMPT } from '../../common/paradisBotTools.js';

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

const SNAPSHOT_AT = new Date(2026, 10, 27, 21, 4).getTime();
const OLDER_AT = new Date(2026, 10, 27, 20, 4).getTime();

const ITEMS: IParadisBotItem[] = [
	{ uid: 'u42', number: 42, botId: 'release', title: 'Safari でログインが切れる', status: 'needs_you', ask: { eventId: 3, questions: [{ prompt: '全員を一度ログアウトさせますか?', options: [{ label: '一度ログアウトさせる' }, { label: '今のセッションを残す' }], recommended: 1 }] }, links: [], events: [{ id: 1, kind: 'made', actor: 'bot', at: now }], lastEventId: 3, lastActivityAt: now, createdAt: now, updatedAt: now },
	{ uid: 'u43', number: 43, botId: 'release', title: '変更履歴をまとめる', status: 'working', links: [], events: [], lastEventId: 0, lastActivityAt: now - 1000, createdAt: now, updatedAt: now },
];

suite('Paradis bots page overlay', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(items: IParadisBotItem[] = ITEMS, entries: IParadisHumanAskEntry[] = [ASK], measureClamp?: (element: HTMLElement) => IParadisInboxClampSize | undefined, patrol?: IParadisBotPatrolPort, storage?: IStorageService) {
		let header: { status: string; attention: boolean; busy: boolean; model: string; agent: undefined; agentName: string } | undefined;
		const disposables = store.add(new DisposableStore());
		const instantiation = disposables.add(new TestInstantiationService());
		const configuration = new TestConfigurationService({ [PARADIS_BOTS_ENABLED_SETTING]: true });
		instantiation.stub(IConfigurationService, configuration);
		const bots = [bot('release', 'リリース係', { needsYou: 1 })];
		const answered: { key: string; answer: ParadisHumanAskAnswer }[] = [];
		const failAnswer = { value: false };
		const sendFails = { value: false };
		const snapshotGone = { value: false };
		const updateFails = { value: false };
		const calls: string[] = [];
		const confirms: IParadisConfirmation[] = [];
		const files = new Map<string, string>([['SOUL.md', '# リリース係\n'], ['MEMORY.md', '# Memory\n']]);
		const statuses: string[] = [];
		const botsChanged = disposables.add(new Emitter<void>());
		instantiation.stub(IParadisBotsService, {
			get snapshot() { return { revision: 1, readOnly: false, bots }; },
			onDidChange: botsChanged.event,
			onDidRequestStop: Event.None,
			listItems: async () => items,
			listSuggestions: async () => [{ id: 's1', botId: 'release', title: 'PR #1108 のレビューの指摘 2 件に返事が無い', request: '#1108 の指摘を読んで、直すか理由を返すか決めて', run: 'r', state: 'open', createdAt: 1 }],
			startSuggestion: async (id: string) => { calls.push(`start ${id}`); return { ok: true, value: { id, botId: 'release', title: 't', request: '#1108 の指摘を読んで、直すか理由を返すか決めて', run: 'r', state: 'started', createdAt: 1 } }; },
			markSuggestionStarted: async (id: string) => { calls.push(`started ${id}`); return { ok: true, value: { id, botId: 'release', title: 't', request: 'r', run: 'r', state: 'started', createdAt: 1 } }; },
			dismissSuggestion: async (id: string) => { calls.push(`dismiss ${id}`); return { ok: true, value: {} }; },
			undoMemoryTidy: async (_bot: string, takenAt: number) => {
				calls.push(`undo ${takenAt === SNAPSHOT_AT ? 'newest' : 'older'}`);
				return snapshotGone.value ? { ok: false, code: 'not_found', message: 'gone' } : { ok: true, value: { restored: ['MEMORY.md'], added: ['memory/new.md'], takenAt, skipped: ['SOUL.md'] } };
			},
			listMemorySnapshots: async () => {
				return { ok: true, value: [{ takenAt: SNAPSHOT_AT, files: 200, total: 206, partial: true, kind: 'auto' }, { takenAt: OLDER_AT, files: 3, total: 3, partial: false, kind: 'manual' }] };
			},
			ownerSetStatus: async (uid: string, to: string) => { statuses.push(`${uid}:${to}`); return { ok: true, value: items[0] }; },
			readHomeFile: async (_bot: string, path: string) => ({ ok: true, value: files.get(path) }),
			writeHomeFile: async (_bot: string, path: string, text: string) => { calls.push(`write ${path}: ${text}`); files.set(path, text); return { ok: true, value: undefined }; },
			updateBot: async (_bot: string, patch: object) => { calls.push(`update ${JSON.stringify(patch)}`); return updateFails.value ? { ok: false, code: 'io', message: 'disk full' } : { ok: true, value: bots[0] }; },
		} as unknown as IParadisBotsService);
		instantiation.stub(IParadisHumanAskService, {
			onDidChange: Event.None,
			get snapshot() { return { entries, counts: paradisHumanAskCounts(entries), revision: 1 }; },
			answer: async (key: string, answer: ParadisHumanAskAnswer) => {
				answered.push({ key, answer });
				if (failAnswer.value) {
					throw new Error('the ledger is gone');
				}
				return { ok: true };
			},
		} as Partial<IParadisHumanAskService> as IParadisHumanAskService);
		instantiation.stub(IParadisDialogService, { confirm: async (confirmation: IParadisConfirmation) => { confirms.push(confirmation); return { confirmed: true }; } } as unknown as IParadisDialogService);
		instantiation.stub(IContextViewService, {});
		let draftTaken = false;
		const headerChanged = disposables.add(new Emitter<number>());
		const headerCalls: string[] = [];
		const chatActive = new Set<number>();
		const chatActiveChanged = disposables.add(new Emitter<number>());
		let holds = 0;
		const pinned = new Set<number>();
		const chatCalls: string[] = [];
		const guides = new Map<number, IParadisAgentChatGuide | undefined>();
		const personas = new Map<number, IParadisAgentChatPersona | undefined>();
		instantiation.stub(IParadisAgentChatService, {
			pinChatMode: (id: number, moveFocus: boolean, show?: boolean) => { pinned.add(id); chatCalls.push(`pin ${id} ${moveFocus}${show === false ? ' (terminal)' : ''}`); },
			isChatPinned: (id: number) => pinned.has(id),
			isChatMode: (id: number) => chatActive.has(id),
			setChatGuide: (id: number, guide: IParadisAgentChatGuide | undefined) => guides.set(id, guide),
			setChatPersona: (id: number, persona: IParadisAgentChatPersona | undefined) => { personas.set(id, persona); },
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
			sendMessageToPane: async (id: number, text: string) => { calls.push(`message ${id} ${text}`); return undefined; },
		} as unknown as IParadisAgentChatService);
		// 受け箱: リリース係宛ての未読 2 通と既読 1 通
		const groupsChanged = disposables.add(new Emitter<void>());
		const inboxRecord = (id: number, readAt?: number) => ({ id, groupId: 'g1', kind: 'told' as const, from: 'review', to: ['release'], text: 't', at: 1, ...(readAt !== undefined ? { readAt } : {}) });
		const groupsSnapshot = { revision: 1, readOnly: false, groups: [{ id: 'g1', name: '班', members: ['release', 'review'], replyMode: 'mentioned' as const, createdAt: 1, updatedAt: 1 }], records: [inboxRecord(1), inboxRecord(2), inboxRecord(3, 9)] };
		instantiation.stub(IParadisBotGroupsService, {
			get snapshot() { return groupsSnapshot; },
			onDidChange: groupsChanged.event,
		} as Partial<IParadisBotGroupsService> as IParadisBotGroupsService);
		instantiation.stub(ITerminalService, {
			getInstanceFromId: (id: number) => id === 1 ? {
				isDisposed: false, sendText: async (text: string, execute: boolean, paste: boolean) => {
					calls.push(`send ${text} ${execute} ${paste}`);
					if (sendFails.value) {
						throw new Error('the terminal is gone');
					}
				}
			} : undefined
		} as unknown as ITerminalService);
		instantiation.stub(IContextMenuService, {});
		instantiation.stub(IOpenerService, {});
		const warnings: string[] = [];
		instantiation.stub(INotificationService, new class extends TestNotificationService {
			override warn(message: NotificationMessage): INotificationHandle {
				warnings.push(String(message));
				return super.warn(message);
			}
		}());
		instantiation.stub(IHoverService, NullHoverService);
		// ペイン 1 だけが Bot のペイン。`ended` でペインが終わったことにする
		const changed = disposables.add(new Emitter<void>());
		const panes = new Map<number, string>([[1, 'release']]);
		const patrolPanes = new Set<number>();
		// -1 を入れると、見回りのペインかの引き当てに失敗したことにする
		const isPatrolPane = async (instanceId: number) => {
			if (patrolPanes.has(-1)) {
				throw new Error('the bots service is gone');
			}
			return patrolPanes.has(instanceId);
		};
		const resolver: IParadisBotPaneResolver = { onDidChange: changed.event, botFor: async instanceId => panes.get(instanceId), isPatrolPane };
		instantiation.stub(IStorageService, storage ?? disposables.add(new InMemoryStorageService()));
		const container = document.createElement('div');
		const page = disposables.add(instantiation.createInstance(ParadisBotPage, container, resolver, patrol, measureClamp));
		return { groupsSnapshot, groupsChanged, container, page, configuration, panes, patrolPanes, changed, answered, disposables, snapshotGone, updateFails, sendFails, warnings, failAnswer, calls, confirms, files, bots, botsChanged, statuses, chatShown: () => { draftTaken = true; }, headerCalls, chatCalls, guides, personas, setHeader: (value: typeof header) => { header = value; headerChanged.fire(1); }, setChatActive: (id: number, active: boolean) => { if (active) { chatActive.add(id); } else { chatActive.delete(id); } chatActiveChanged.fire(id); } };
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

	test('受け箱の未読を見出しに出し、待機中なら「読ませる」で受け箱を見るよう Bot に送る。作業中は押せない。帯の印から開くと会話のタブ', async () => {
		const { container, page, calls, bots, botsChanged, groupsSnapshot, groupsChanged } = setup();
		page.setInstance(1);
		await settle();
		const button = () => container.getElementsByClassName('paradis-bot-page-inbox')[0] as HTMLButtonElement;
		const look = () => [button().hidden, button().disabled, button().textContent];
		const idle = look();
		(container.getElementsByClassName('paradis-bot-page-tab')[1] as HTMLElement).click();
		button().click();
		await settle();
		const selectedAfterAsk = (container.getElementsByClassName('paradis-bot-page-tab selected')[0] as HTMLElement).textContent;
		bots[0] = { ...bots[0], activity: 'working' };
		botsChanged.fire();
		const working = look();
		groupsSnapshot.records = [];
		groupsChanged.fire();
		const empty = button().hidden;
		// 帯の受け箱の印から開いた（ほかのタブを見ていても会話を出す）
		(container.getElementsByClassName('paradis-bot-page-tab')[2] as HTMLElement).click();
		paradisRequestBotPageTab('release', 'chat');
		const selectedAfterRequest = (container.getElementsByClassName('paradis-bot-page-tab selected')[0] as HTMLElement).textContent;
		assert.deepStrictEqual({ idle, selectedAfterAsk, sent: calls.filter(call => call.startsWith('message')), working, empty, selectedAfterRequest }, {
			idle: [false, false, '受け箱に 2 通あります。読ませる'],
			selectedAfterAsk: '会話',
			sent: ['message 1 受け箱（bot_inbox）を見て、ほかの Bot から届いた伝言に対応してください。'],
			working: [false, true, '受け箱に 2 通'],
			empty: true,
			selectedAfterRequest: '会話',
		});
	});

	test('見回りのペインでは「読ませる」を押せない（見回りは受け箱を既読にしないので、会話のペインにだけ送る）', async () => {
		const { container, page, calls, patrolPanes } = setup();
		patrolPanes.add(1);
		page.setInstance(1);
		await settle();
		const button = container.getElementsByClassName('paradis-bot-page-inbox')[0] as HTMLButtonElement;
		button.click();
		await settle();
		assert.deepStrictEqual([button.hidden, button.disabled, button.textContent, calls.filter(call => call.startsWith('message'))], [false, true, '受け箱に 2 通', []]);
	});

	test('見回りのペインかを引けなくても、帯は出し続ける（会話のペインとみなす）', async () => {
		const { container, page, patrolPanes } = setup();
		patrolPanes.add(-1);
		page.setInstance(1);
		await settle();
		const button = container.getElementsByClassName('paradis-bot-page-inbox')[0] as HTMLButtonElement;
		assert.deepStrictEqual([state(container).strip, button.disabled], [true, false]);
	});

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

	test('設定: GitHub の見張りはオンにするときだけ確かめてから当てる', async () => {
		const { container, page, calls, confirms } = setup();
		page.setInstance(1);
		await settle();
		tab(container, 3);
		await settle();
		const switches = () => [...container.querySelectorAll('.paradis-bot-settings [role="switch"]')] as HTMLElement[];
		switches()[2].click();
		await settle();
		await settle();
		assert.deepStrictEqual([calls, confirms.map(confirmation => [confirmation.primaryButton, String(confirmation.detail).includes('5 分ごとに gh で GitHub を確かめます')])], [
			['update {"watchGithub":true}'],
			[['見張らせる', true]],
		]);
	});

	test('設定: 変えられなかったらスイッチを台帳の値へ戻して理由を出す', async () => {
		const { container, page, calls, warnings, updateFails } = setup();
		updateFails.value = true;
		page.setInstance(1);
		await settle();
		tab(container, 3);
		await settle();
		const switches = () => [...container.querySelectorAll('.paradis-bot-settings [role="switch"]')] as HTMLElement[];
		switches()[1].click();
		await settle();
		await settle();
		assert.deepStrictEqual([calls, warnings, switches().map(element => element.getAttribute('aria-checked'))], [
			['update {"pinned":true}'],
			['Bot を変えられませんでした: disk full'],
			['true', 'false', 'false'],
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

	test('提案: 「始める」は文を取り、チャット表示の入力欄へ下書きを入れ（無ければターミナルへ貼り付け）、入れられたら「始めた」にして会話へ戻す。「見送る」は台帳へ知らせる', async () => {
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
			['dismiss s1', 'start s1', 'draft 1 #1108 の指摘を読んで、直すか理由を返すか決めて', 'send #1108 の指摘を読んで、直すか理由を返すか決めて false true', 'started s1', 'start s1', 'draft 1 #1108 の指摘を読んで、直すか理由を返すか決めて', 'started s1'],
			['true', 'false', 'false', 'false'],
		]);
	});

	test('ファイル: 記憶の写しを時刻・件数・整理の前・一部だけで並べ、どの行からも確かめてその写しに戻し、結果と書き戻せなかったファイルを一覧の下に出す。消えた写しは知らせる', async () => {
		const { container, page, calls, confirms, warnings, snapshotGone } = setup();
		page.setInstance(1);
		await settle();
		tab(container, 2);
		await settle();
		(container.getElementsByClassName('paradis-bot-page-row')[1] as HTMLElement).click();
		await settle();
		await settle();
		const title = container.querySelector('.paradis-bot-snapshots .paradis-bot-page-section')?.textContent;
		const rows = Array.from(container.getElementsByClassName('paradis-bot-snapshots-row')).map(row => [
			row.getElementsByClassName('paradis-bot-snapshots-count')[0].textContent,
			Array.from(row.getElementsByClassName('paradis-chip')).map(chip => chip.textContent),
			row.getElementsByClassName('paradis-button').length,
		]);
		const undo = (index: number) => (container.getElementsByClassName('paradis-bot-snapshots-row')[index].getElementsByClassName('paradis-button')[0] as HTMLElement).click();
		undo(1);
		await settle();
		await settle();
		await settle();
		const result = Array.from(container.querySelectorAll('.paradis-bot-snapshots-result > *')).map(line => [line.textContent, line.classList.contains('attention')]);
		snapshotGone.value = true;
		undo(0);
		await settle();
		await settle();
		await settle();
		assert.deepStrictEqual({
			title,
			rows,
			calls,
			confirm: confirms.map(confirmation => [confirmation.primaryButton, String(confirmation.detail).includes(new Date(OLDER_AT).toLocaleString()), String(confirmation.detail).includes(new Date(SNAPSHOT_AT).toLocaleString())]),
			result,
			warnings,
		}, {
			title: '記憶の写し',
			rows: [['206 件中 200 件だけ写しました', ['一部だけ'], 1], ['3 件', ['整理の前'], 1]],
			calls: ['undo older', 'undo newest'],
			confirm: [['取り消す', true, false], ['取り消す', false, true]],
			result: [
				[`${new Date(OLDER_AT).toLocaleString()} の写しに戻しました（1 件）。`, false],
				['整理でできたファイルは消さずに残しています: memory/new.md', false],
				['取り消せなかったファイルがあります（記憶のファイルではないので書き戻していません）: SOUL.md', true],
			],
			warnings: [`${new Date(SNAPSHOT_AT).toLocaleString()} の写しはもうありません（古い写しから消えていきます）。写しの一覧を読み直しました。`],
		});
	});

	test('見回り: ホームの「定期実行」の節と、設定のタブの欄から保存・今すぐ見回る。保存を断られたら書きかけを残して理由を出す', async () => {
		const patrolCalls: string[] = [];
		let saveFails = false;
		const port: IParadisBotPatrolPort = {
			onDidChange: Event.None,
			get: async () => ({ definitionId: 'd', enabled: true, schedule: { everyHours: 4, fromHour: 8, toHour: 20, weekdaysOnly: true }, cron: '0 8-20/4 * * 1-5', lookFor: '返事の無い指摘', gate: 'ok' }),
			set: async (botId, input) => { patrolCalls.push(`set ${botId} ${JSON.stringify(input)}`); return saveFails ? { ok: false, error: '定期実行は 20 件までです' } : { ok: true }; },
			runNow: async botId => { patrolCalls.push(`run ${botId}`); return { ok: true }; },
		};
		const { container, page, warnings } = setup(ITEMS, [ASK], undefined, port);
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
		const save = () => (Array.from(container.querySelectorAll('.monaco-button')).find(button => button.textContent === '見回りを保存') as HTMLElement).click();
		const lookForInput = () => container.querySelector('.paradis-bot-patrol-settings input[aria-label="探すもの"]') as HTMLInputElement;
		save();
		await settle();
		await settle();
		// 断られた保存: 書いた「探すもの」が残り、理由が出る
		saveFails = true;
		lookForInput().value = 'CI の落ちたチェック';
		lookForInput().dispatchEvent(new InputEvent('input'));
		save();
		await settle();
		await settle();
		const kept = lookForInput().value;
		assert.deepStrictEqual({ home, homeButtons, sections: sections.slice(-1), patrolCalls, kept, warned: warnings.slice(-1) }, {
			kept: 'CI の落ちたチェック',
			warned: ['見回りを保存できませんでした: 定期実行は 20 件までです'],
			home: ['平日 8〜20 時・4 時間ごと'],
			homeButtons: ['今すぐ見回る', '変える...'],
			sections: ['見回り'],
			patrolCalls: [
				'run release',
				'set release {"schedule":"0 8-20/4 * * 1-5","lookFor":"返事の無い指摘","enabled":true}',
				'set release {"schedule":"0 8-20/4 * * 1-5","lookFor":"CI の落ちたチェック","enabled":true}',
			],
		});
	});

	test('チャット表示を見ている間だけ、見出しの状態とモデルを帯に出して見出しを畳む（会話が替われば畳み直し、離れたら戻す）', async () => {
		const { container, page, headerCalls, setHeader, setChatActive, changed } = setup();
		const strip = () => ({
			status: container.getElementsByClassName('paradis-bot-page-status')[0]?.textContent,
			attention: container.getElementsByClassName('paradis-bot-page-status')[0]?.classList.contains('attention'),
			model: (container.getElementsByClassName('paradis-bot-page-model')[0] as HTMLElement | undefined)?.hidden ? '' : container.getElementsByClassName('paradis-bot-page-model')[0]?.textContent,
			view: !(container.getElementsByClassName('paradis-bot-page-view')[0] as HTMLElement).hidden,
		});
		page.setInstance(1);
		await settle();
		setHeader({ status: '許可を待っています', attention: true, busy: false, model: 'claude-opus-4-5 · high', agent: undefined, agentName: 'Claude Code' });
		const terminalView = strip();
		setChatActive(1, true);
		const chatView = strip();
		// 切り替えは項目のタブでも出したまま
		(container.getElementsByClassName('paradis-bot-page-tab')[1] as HTMLElement).click();
		const itemsTab = strip().view;
		(container.getElementsByClassName('paradis-bot-page-tab')[0] as HTMLElement).click();
		// 切り替えはタブ列の左（帯が収まらない幅では右端から切れるため）
		const beforeTabs = (container.getElementsByClassName('paradis-bot-page-view')[0] as HTMLElement).nextElementSibling?.classList.contains('paradis-bot-page-tabs');
		// 会話が替わった（チャット表示の側が畳みを戻した）ときも、見出しの知らせで畳み直す
		setHeader({ status: '入力を待っています', attention: false, busy: false, model: 'claude-opus-4-5 · high', agent: undefined, agentName: 'Claude Code' });
		// 見出しの値が変わらなくても、ペインのトークンが替われば Bot の照らし直しで畳み直す
		changed.fire();
		await settle();
		(container.getElementsByClassName('paradis-bot-page-view-option')[1] as HTMLElement).click();
		setChatActive(1, false);
		const backToTerminal = strip();
		setChatActive(1, true);
		page.setInstance(2);
		await settle();
		page.dispose();
		assert.deepStrictEqual({ terminalView, chatView, itemsTab, beforeTabs, backToTerminal, calls: headerCalls }, {
			itemsTab: true,
			beforeTabs: true,
			terminalView: { status: '1 件があなたの番', attention: false, model: '', view: true },
			chatView: { status: '許可を待っています', attention: true, model: 'claude-opus-4-5 · high', view: true },
			backToTerminal: { status: '1 件があなたの番', attention: false, model: '', view: true },
			calls: ['hide 1 #1', 'hide 1 #2', 'unhide 1 #1', 'hide 1 #3', 'unhide 1 #2', 'terminal 1', 'unhide 1 #3', 'hide 1 #4', 'unhide 1 #4'],
		});
	});

	test('Bot の会話のペインはいつもチャット表示にし（ペインごとに 1 回）、会話が見つかるまで止まっている理由の案内を出す。見出しの 2 つのボタンで切り替え、押されている側が今の表示。見回りのペインは控えない', async () => {
		const { container, page, chatCalls, headerCalls, guides, bots, botsChanged, setChatActive, patrolPanes, panes, changed } = setup();
		const option = (index: number) => container.getElementsByClassName('paradis-bot-page-view-option')[index] as HTMLButtonElement;
		const look = () => [(container.getElementsByClassName('paradis-bot-page-view')[0] as HTMLElement).hidden, ...[0, 1].filter(index => option(index).getAttribute('aria-checked') === 'true').map(index => option(index).getAttribute('aria-label'))];
		page.setInstance(1);
		await settle();
		const waking = guides.get(1);
		// 照らし直しでもう一度控え直さない（利用者がターミナルを開いた後に、勝手にチャットへ戻さない）
		changed.fire();
		await settle();
		setChatActive(1, true);
		const chatButton = look();
		option(1).click();
		setChatActive(1, false);
		const terminalButton = look();
		option(0).click();
		bots[0] = { ...bots[0], halt: { kind: 'needsUser' } };
		botsChanged.fire();
		const needsUser = guides.get(1);
		bots[0] = { ...bots[0], halt: { kind: 'notFound' } };
		botsChanged.fire();
		const notFound = guides.get(1)?.band?.title;
		// 見回りのペインは控えず、案内も出さない
		panes.set(2, 'release');
		patrolPanes.add(2);
		page.setInstance(2);
		await settle();
		// Bot のペインでなくなったら案内を消す
		page.setInstance(1);
		await settle();
		panes.delete(1);
		changed.fire();
		await settle();
		assert.deepStrictEqual({ waking, chatButton, terminalButton, needsUser, notFound, patrolGuide: guides.get(2), cleared: guides.get(1), calls: chatCalls, terminal: headerCalls.filter(call => call.startsWith('terminal')) }, {
			waking: { notice: '起こしています…', sendable: true },
			chatButton: [false, '吹き出し'],
			terminalButton: [false, 'ターミナル'],
			terminal: ['terminal 1'],
			needsUser: { notice: 'まだ会話はありません', band: { title: 'ターミナルで操作が要ります', detail: '初回設定・ログイン・許可の画面で止まっています' } },
			notFound: 'Claude Code が見つかりません',
			patrolGuide: undefined,
			cleared: undefined,
			calls: ['pin 1 true', 'pin 1 true'],
		});
	});

	test('選んだ表示は Bot ごとに覚え、開き直し（再起動）でもその表示で控える。帯の「ターミナルを開く」や切り替えのキーで替えても覚える', async () => {
		const storage = store.add(new InMemoryStorageService());
		const first = setup(undefined, undefined, undefined, undefined, storage);
		first.page.setInstance(1);
		await settle();
		first.setChatActive(1, true);
		// 「ターミナルで操作が要ります」の帯のボタン（チャット表示の側がターミナルへ切り替える）
		first.setChatActive(1, false);
		const afterBand = storage.get(PARADIS_BOT_VIEWS_STORAGE_KEY, StorageScope.APPLICATION);
		first.page.dispose();
		// 再起動の後: ターミナルのまま控える（吹き出しへ切り替えない）
		const second = setup(undefined, undefined, undefined, undefined, storage);
		second.page.setInstance(1);
		await settle();
		const checked = () => [...second.container.getElementsByClassName('paradis-bot-page-view-option')].filter(option => option.getAttribute('aria-checked') === 'true').map(option => option.getAttribute('aria-label'));
		const restored = checked();
		// 項目のタブから「吹き出し」を押すと、会話のタブへ移して吹き出しにする
		(second.container.getElementsByClassName('paradis-bot-page-tab')[1] as HTMLElement).click();
		(second.container.getElementsByClassName('paradis-bot-page-view-option')[0] as HTMLElement).click();
		const tab = (second.container.getElementsByClassName('paradis-bot-page-tab')[0] as HTMLElement).getAttribute('aria-selected');
		second.setChatActive(1, true);
		const afterChat = storage.get(PARADIS_BOT_VIEWS_STORAGE_KEY, StorageScope.APPLICATION);
		const chatNow = checked();
		second.page.dispose();
		// ほかの Bot の分（もういない Bot）は書き直すときに消える
		storage.store(PARADIS_BOT_VIEWS_STORAGE_KEY, '{"gone":"terminal"}', StorageScope.APPLICATION, StorageTarget.MACHINE);
		const third = setup(undefined, undefined, undefined, undefined, storage);
		third.page.setInstance(1);
		await settle();
		(third.container.getElementsByClassName('paradis-bot-page-view-option')[1] as HTMLElement).click();
		const pruned = storage.get(PARADIS_BOT_VIEWS_STORAGE_KEY, StorageScope.APPLICATION);
		third.page.dispose();
		assert.deepStrictEqual({ afterBand, restored, tab, afterChat, chatNow, pruned, first: first.chatCalls, second: second.chatCalls }, {
			afterBand: '{"release":"terminal"}',
			restored: ['ターミナル'],
			tab: 'true',
			afterChat: undefined,
			chatNow: ['吹き出し'],
			pruned: '{"release":"terminal"}',
			first: ['pin 1 true'],
			second: ['pin 1 true (terminal)', 'pin 1 true'],
		});
	});

	test('Bot の会話のペインの吹き出しの顔はその Bot の顔（様子が変われば渡し直す）。作った直後の挨拶の頼みは印にし、利用者の文はそのまま。見回りのペインには渡さない', async () => {
		const { page, personas, bots, botsChanged, patrolPanes, panes } = setup();
		const face = (persona: IParadisAgentChatPersona | undefined) => {
			if (persona === undefined) {
				return undefined;
			}
			const parent = document.createElement('div');
			persona.renderFace(parent);
			const element = parent.firstElementChild as HTMLElement;
			return `${element.className} ${element.dataset.color} ${element.dataset.state}`;
		};
		bots[0] = { ...bots[0], needsYou: 0 };
		page.setInstance(1);
		await settle();
		const idle = personas.get(1);
		bots[0] = { ...bots[0], activity: 'working' };
		botsChanged.fire();
		const working = personas.get(1);
		panes.set(2, 'release');
		patrolPanes.add(2);
		page.setInstance(2);
		await settle();
		assert.deepStrictEqual({
			idle: face(idle),
			working: face(working),
			greeting: idle?.promptLabel(`${PARADIS_BOT_GREETING_PROMPT}\n`),
			user: idle?.promptLabel('こんにちは'),
			patrol: personas.get(2),
		}, {
			idle: 'paradis-bot-face blue idle',
			working: 'paradis-bot-face blue work',
			greeting: 'Bot を作ったので、自己紹介を頼みました',
			user: undefined,
			patrol: undefined,
		});
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
		assert.deepStrictEqual({ open, confirms: confirms.map(confirmation => confirmation.message), closedLabels, statuses }, {
			open: ['完了にする...', '後回し...', '取りやめる...'],
			confirms: ['項目 #43 を完了にしますか?'],
			closedLabels: ['戻す'],
			statuses: ['u43:done', 'u44:working'],
		});
	});

	test('設定: 入力中の名前は、別の Bot が変わっても作り直さず、この Bot の名前がほかで変わっても上書きせずに知らせる', async () => {
		const { container, page, bots, botsChanged, disposables } = setup();
		document.body.appendChild(container);
		disposables.add(toDisposable(() => container.remove()));
		page.setInstance(1);
		await settle();
		tab(container, 3);
		await settle();
		await settle();
		const name = container.querySelector('.paradis-bot-settings-value input') as HTMLInputElement;
		name.focus();
		name.value = '出荷係';
		name.dispatchEvent(new mainWindow.Event('input'));
		name.setSelectionRange(1, 2);
		bots.push(bot('other', '別の係'));
		botsChanged.fire();
		await settle();
		const afterOther = { same: container.querySelector('.paradis-bot-settings-value input') === name, notice: container.getElementsByClassName('paradis-bot-settings-elsewhere').length };
		bots[0] = { ...bots[0], name: '台帳で変えた名前', pinned: true };
		botsChanged.fire();
		await settle();
		const input = container.querySelector('.paradis-bot-settings-value input') as HTMLInputElement;
		assert.deepStrictEqual({
			afterOther,
			value: input.value,
			focused: document.activeElement === input,
			selection: [input.selectionStart, input.selectionEnd],
			notice: container.getElementsByClassName('paradis-bot-settings-elsewhere')[0]?.textContent,
		}, {
			afterOther: { same: true, notice: 0 },
			value: '出荷係',
			focused: true,
			selection: [1, 2],
			notice: '書きかけの間に、ほかの場所で名前が変わりました。保存すると、この画面の値で上書きします。',
		});
	});

	test('問いを一覧から開き直したときも守りを張り直し、台帳へ届かなかった答えは「送っている最中」を戻して理由を出す', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { container, page, answered, failAnswer } = setup();
		page.setInstance(1);
		await settle();
		(container.getElementsByClassName('paradis-bot-page-tab')[1] as HTMLElement).click();
		await settle();
		const open = async () => {
			(container.getElementsByClassName('paradis-bot-page-row')[0] as HTMLElement).click();
			await settle();
		};
		const buttons = () => Array.from(container.querySelectorAll<HTMLElement>('.paradis-bot-page-ask .pnip-ask-buttons .paradis-button'));
		await open();
		await new Promise(resolve => setTimeout(resolve, 600));
		(container.querySelector('.paradis-bot-page-back') as HTMLElement).click();
		await settle();
		await open();
		// 開き直した直後の押下は効かない
		buttons()[1].click();
		await settle();
		const whileGuarded = answered.length;
		await new Promise(resolve => setTimeout(resolve, 600));
		failAnswer.value = true;
		buttons()[1].click();
		await settle();
		await settle();
		assert.deepStrictEqual({
			whileGuarded,
			sent: answered.length,
			note: container.querySelector('.paradis-bot-page-ask .pnip-ask-note')?.textContent,
			enabled: buttons().map(button => !button.classList.contains('disabled') && button.getAttribute('aria-disabled') !== 'true'),
		}, {
			whileGuarded: 0,
			sent: 1,
			note: '回答を送れませんでした。少し待ってからもう一度試してください',
			enabled: [true, true, true],
		});
	}));

	test('ファイル: 開いた後に Bot が書き足したら、差分を見せて「読み直す」「上書きする」を選ばせ、タブを開き直したときも読み直す', async () => {
		const { container, page, calls, files } = setup();
		page.setInstance(1);
		await settle();
		const openMemory = async () => {
			tab(container, 2);
			await settle();
			(container.getElementsByClassName('paradis-bot-page-row')[1] as HTMLElement).click();
			await settle();
			await settle();
		};
		const editor = () => container.querySelector('.paradis-bot-files-editor textarea') as HTMLTextAreaElement;
		const type = (value: string) => {
			editor().value = value;
			editor().dispatchEvent(new mainWindow.Event('input'));
		};
		const button = (label: string) => Array.from(container.querySelectorAll<HTMLElement>('.paradis-bot-files-conflict .paradis-button')).find(element => element.textContent === label)!;
		const diff = () => Array.from(container.getElementsByClassName('paradis-bot-files-diff-line')).map(line => line.textContent);
		await openMemory();
		// 書きかけの無いまま Bot が書き足し、タブを開き直した: 新しい中身になる
		files.set('MEMORY.md', '# Memory\n- 一つ目\n');
		tab(container, 3);
		await settle();
		await openMemory();
		const refreshed = editor().value;
		// 書きかけの間に Bot が書き足した: 保存は書かずに差分を出す
		type('# Memory\n- 一つ目\n- 自分の編集\n');
		files.set('MEMORY.md', '# Memory\n- 一つ目\n- Bot が足した行\n');
		primary(container).click();
		await settle();
		await settle();
		const shown = diff();
		button('読み直す（書きかけを捨てる）').click();
		await settle();
		const reloaded = editor().value;
		// もう一度書きかけ、タブを開き直したら差分を出し、上書きを選ぶと書く
		type('# Memory\n- 上書きする\n');
		files.set('MEMORY.md', '# Memory\n- また Bot\n');
		tab(container, 3);
		await settle();
		await openMemory();
		const again = diff();
		button('上書きする').click();
		await settle();
		await settle();
		assert.deepStrictEqual({ refreshed, shown, reloaded, again, calls, conflicts: container.getElementsByClassName('paradis-bot-files-conflict').length }, {
			refreshed: '# Memory\n- 一つ目\n',
			shown: ['+ - Bot が足した行'],
			reloaded: '# Memory\n- 一つ目\n- Bot が足した行\n',
			again: ['- - 一つ目', '- - Bot が足した行', '+ - また Bot'],
			calls: ['write MEMORY.md: # Memory\n- 上書きする\n'],
			conflicts: 0,
		});
	});

	test('設定: 役割が上限を超えたら黙って切り詰めず、保存を断って何文字多いかを出す', async () => {
		const { container, page } = setup();
		page.setInstance(1);
		await settle();
		tab(container, 3);
		await settle();
		await settle();
		const role = container.querySelector('.paradis-bot-settings-role textarea') as HTMLTextAreaElement;
		role.value = 'x'.repeat(4005);
		role.dispatchEvent(new mainWindow.Event('input'));
		const errors = Array.from(container.getElementsByClassName('paradis-bot-settings-error')).map(error => error.textContent).filter(text => !!text);
		assert.deepStrictEqual({ errors, saveEnabled: !primary(container).classList.contains('disabled') && primary(container).getAttribute('aria-disabled') !== 'true' }, {
			errors: ['役割が 5 文字多すぎます（4000 文字まで）。'],
			saveEnabled: false,
		});
	});

	test('提案: 入力欄にもターミナルにも入れられなければ「始めた」にせず、一覧に残すと知らせる', async () => {
		const { container, page, calls, sendFails, warnings } = setup();
		sendFails.value = true;
		page.setInstance(1);
		await settle();
		tab(container, 1);
		await settle();
		(container.querySelector('.paradis-bot-page-suggestion .paradis-button-primary') as HTMLElement).click();
		await settle();
		await settle();
		assert.deepStrictEqual({ started: calls.filter(call => call.startsWith('started')), warnings }, {
			started: [],
			warnings: ['提案の依頼を会話の入力欄へ入れられませんでした。提案は一覧に残しています。'],
		});
	});

	test('提案: 文を取る間に別のペインへ替わったら、どこにも入れず「始めた」にしない', async () => {
		const { container, page, calls } = setup();
		page.setInstance(1);
		await settle();
		tab(container, 1);
		await settle();
		(container.querySelector('.paradis-bot-page-suggestion .paradis-button-primary') as HTMLElement).click();
		page.setInstance(2);
		await settle();
		await settle();
		assert.deepStrictEqual(calls.filter(call => !call.startsWith('start ')), []);
	});

	test('ファイル: 保存していない記憶の書きかけがあれば、写しに戻す確認の文に捨てることを出す', async () => {
		const { container, page, confirms } = setup();
		page.setInstance(1);
		await settle();
		tab(container, 2);
		await settle();
		(container.getElementsByClassName('paradis-bot-page-row')[1] as HTMLElement).click();
		await settle();
		await settle();
		const editor = container.querySelector('.paradis-bot-files-editor textarea') as HTMLTextAreaElement;
		editor.value = '# Memory\n- 書きかけ\n';
		editor.dispatchEvent(new mainWindow.Event('input'));
		(container.getElementsByClassName('paradis-bot-snapshots-row')[1].getElementsByClassName('paradis-button')[0] as HTMLElement).click();
		await settle();
		assert.deepStrictEqual(confirms.map(confirmation => [String(confirmation.detail).includes(new Date(OLDER_AT).toLocaleString()), String(confirmation.detail).includes('保存していない MEMORY.md の書きかけは捨てます。')]), [[true, true]]);
	});
});
