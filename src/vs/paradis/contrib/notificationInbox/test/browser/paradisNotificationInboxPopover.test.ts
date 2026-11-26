/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ParadisNotificationInboxPopover, paradisInboxPopoverPlacement } from '../../browser/paradisNotificationInboxPopover.js';
import { EMPTY_PARADIS_INBOX_SNAPSHOT, IParadisInboxEntry, IParadisInboxSnapshot, IParadisNotificationInboxService } from '../../common/paradisNotificationInbox.js';
import { IParadisHumanAskEntry, IParadisHumanAskService, ParadisHumanAskAnswer, ParadisHumanAskClientResult, paradisHumanAskCounts } from '../../../humanAsk/common/paradisHumanAsk.js';
import { ParadisInboxAskDialog } from '../../browser/paradisNotificationInboxAskDialog.js';

function entry(id: string, extra: Partial<IParadisInboxEntry>): IParadisInboxEntry {
	return { id, kind: 'review', paneKey: `pane-${id}`, instanceId: 1, windowId: 1, space: 'para-code', delivery: 'notified', at: Date.now(), read: false, live: true, ...extra };
}

function ask(id: string, extra: Partial<IParadisHumanAskEntry>): IParadisHumanAskEntry {
	return { key: `pane:${id}`, owner: 'panes', source: 'pane', id, kind: 'question', from: { title: 'api', detail: 'main ／ Codex' }, questions: [], actions: [], canSkip: false, askedAt: Date.now(), state: 'waiting', paneKey: `pane-${id}`, windowId: 1, ...extra };
}

const ALLOW_DENY = [{ id: 'yes', label: '許可' }, { id: 'no', label: '拒否' }];

/** 台帳のウィンドウ側の窓口の代わり。答えは記録し、決めた結果を返す。 */
function humanAsk(entries: IParadisHumanAskEntry[], result: ParadisHumanAskClientResult = { ok: true }) {
	const onDidChange = new Emitter<void>();
	const answers: { key: string; answer: ParadisHumanAskAnswer }[] = [];
	let current = entries;
	const service: IParadisHumanAskService = {
		_serviceBrand: undefined,
		onDidChange: onDidChange.event,
		get snapshot() { return { entries: current, counts: paradisHumanAskCounts(current), revision: 1 }; },
		answer: async (key, answer) => { answers.push({ key, answer }); return result; },
	};
	return { service, answers, set: (next: IParadisHumanAskEntry[]) => { current = next; onDidChange.fire(); }, dispose: () => onDidChange.dispose() };
}

/** カードの見える中身（時刻は環境で変わるので比べない）。 */
function cards(container: HTMLElement) {
	const text = (card: Element, className: string) => (card.getElementsByClassName(className)[0] as HTMLElement | undefined)?.textContent ?? undefined;
	return ([...container.getElementsByClassName('pnip-ask')] as HTMLElement[]).map(card => ({
		title: text(card, 'pnip-space'),
		kind: text(card, 'pnip-kind'),
		body: text(card, 'pnip-ask-command') ?? text(card, 'pnip-ask-question') ?? text(card, 'pnip-ask-settled'),
		dangers: [...card.querySelectorAll('.pnip-ask-dangers .paradis-chip')].map(chip => chip.textContent),
		buttons: [...card.querySelectorAll<HTMLElement>('[data-ask-control]')].map(button => `${button.dataset.askControl}=${button.textContent}`),
		note: text(card, 'pnip-ask-note'),
	}));
}

suite('Paradis notification inbox popover', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function open(entries: IParadisHumanAskEntry[], result?: ParadisHumanAskClientResult) {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		store.add({ dispose: () => container.remove() });
		const ledger = store.add(humanAsk(entries, result));
		const calls: string[] = [];
		const clock = { now: 10_000 };
		const inboxService = {
			onDidChange: Event.None,
			snapshot: EMPTY_PARADIS_INBOX_SNAPSHOT,
			revealPane: async (pane: { paneKey: string }) => { calls.push(`reveal:${pane.paneKey}`); },
		} as unknown as IParadisNotificationInboxService;
		const popover = store.add(new ParadisNotificationInboxPopover(
			{ anchor: undefined, onClose: () => calls.push('close'), onOpenAsk: (key, focusText) => calls.push(`dialog:${key}${focusText ? ':text' : ''}`), now: () => clock.now },
			{ activeContainer: container } as unknown as ILayoutService,
			inboxService,
			{} as IContextMenuService,
			new TestConfigurationService(),
			{} as ICommandService,
			NullHoverService,
			ledger.service,
		));
		const press = (key: string, control: string) => container.querySelector<HTMLElement>(`[data-ask-key="${key}"] [data-ask-control="${control}"]`)?.click();
		return { container, ledger, calls, clock, popover, press };
	}

	test('your turn: one card per waiting ask, with buttons only for what can be answered here', async () => {
		const t = open([
			ask('1', { questions: [{ id: '0', text: 'どちらにしますか?', options: [{ id: '0', label: '残す', recommended: true }, { id: '1', label: 'ログアウトさせる' }], allowText: true }] }),
			ask('2', { kind: 'permission', preface: 'Bash: npm run typecheck-client', actions: ALLOW_DENY }),
			ask('3', { kind: 'permission', preface: 'Bash: rm -rf build', actions: ALLOW_DENY }),
			ask('4', { questions: [{ id: '0', text: '1 つ目', options: [], allowText: true }, { id: '1', text: '2 つ目', options: [], allowText: true }] }),
			ask('5', { kind: 'permission', preface: 'MCP: para-browser.take_screenshot' }),
			// ほかの 1 件に寄せたもの・開く前に回答済みになったものは出さない
			ask('6', { kind: 'permission', actions: ALLOW_DENY, foldedInto: 'board:x' }),
			ask('7', { state: 'answered', resolution: { at: 1, surface: 'mobile', summary: '残す' } }),
		]);
		const tabs = [...t.container.querySelectorAll('.pnip-tabs button')].map(button => `${button.textContent}${button.getAttribute('aria-pressed') === 'true' ? '*' : ''}`);
		const rendered = cards(t.container);

		// 問い 1 つは押してすぐ送る。許可も 1 押しで送る。大きい問い・危険な許可はモーダルを開くだけで、何も送らない
		t.press('pane:1', 'option:1');
		t.press('pane:2', 'action:yes');
		t.press('pane:3', 'open');
		t.press('pane:4', 'open');
		t.press('pane:1', 'write');
		t.press('pane:5', 'reveal');
		await Promise.resolve();
		assert.deepStrictEqual({ tabs, rendered, answers: t.ledger.answers, calls: t.calls }, {
			tabs: ['あなたの番 5*', '通知'],
			rendered: [
				{ title: 'api', kind: '質問', body: 'どちらにしますか?', dangers: [], buttons: ['option:0=残す（おすすめ）', 'option:1=ログアウトさせる', 'write=自分で書く', 'reveal=ペインへ移動'], note: undefined },
				{ title: 'api', kind: '許可', body: 'Bash: npm run typecheck-client', dangers: [], buttons: ['action:yes=許可', 'action:no=拒否', 'reveal=ペインへ移動'], note: undefined },
				// 危険な操作を含む許可は、行の中に「許可」を出さない
				{ title: 'api', kind: '許可', body: 'Bash: rm -rf build', dangers: ['削除を含む'], buttons: ['open=中身を確かめて答える', 'reveal=ペインへ移動'], note: undefined },
				{ title: 'api', kind: '質問', body: '1 つ目（ほか 1 問）', dangers: [], buttons: ['open=開いて答える', 'reveal=ペインへ移動'], note: undefined },
				{ title: 'api', kind: '許可', body: 'MCP: para-browser.take_screenshot', dangers: [], buttons: ['reveal=ペインへ移動'], note: 'この種類はペインで答えます' },
			],
			answers: [
				{ key: 'pane:1', answer: { type: 'answers', answers: [{ questionId: '0', optionIds: ['1'] }] } },
				{ key: 'pane:2', answer: { type: 'action', actionId: 'yes' } },
			],
			calls: ['dialog:pane:3', 'dialog:pane:4', 'dialog:pane:1:text', 'close', 'reveal:pane-5'],
		});
		t.popover.dispose();
	});

	test('your turn: an ask answered elsewhere keeps its row without buttons, and a row that just moved cannot be pressed', async () => {
		const first = ask('1', { kind: 'permission', preface: 'Bash: npm test', actions: ALLOW_DENY });
		const second = ask('2', { kind: 'permission', preface: 'Bash: npm run build', actions: ALLOW_DENY });
		const t = open([first, second]);
		// スマホで 1 件目に答えた: ボタンを外して答えを出す。ターミナルで 2 件目に答えた（取り下げ）: 答えたとは言い切らない
		t.ledger.set([
			{ ...first, state: 'answered', resolution: { at: 2, surface: 'mobile', summary: '許可' } },
			{ ...second, state: 'withdrawn', resolution: { at: 2 } },
		]);
		const settled = cards(t.container).map(card => ({ body: card.body, buttons: card.buttons }));

		// 新しい許可が上に入って行が動いた直後の「許可」は送らない。少し経てば送れる
		const third = ask('3', { kind: 'permission', preface: 'Bash: git push', actions: ALLOW_DENY });
		const fourth = ask('4', { kind: 'permission', preface: 'Bash: npm publish', actions: ALLOW_DENY });
		t.ledger.set([third]);
		t.clock.now += 5_000;
		t.ledger.set([fourth, third]);
		t.press('pane:3', 'action:yes');
		const duringGuard = t.ledger.answers.length;
		t.clock.now += 1_000;
		t.press('pane:3', 'action:no');
		await Promise.resolve();
		assert.deepStrictEqual({ settled, duringGuard, answers: t.ledger.answers }, {
			settled: [
				{ body: 'スマホで回答済み: 「許可」', buttons: [] },
				{ body: 'ほかの場所で対応済みか、対象外になりました', buttons: [] },
			],
			duringGuard: 0,
			answers: [{ key: 'pane:3', answer: { type: 'action', actionId: 'no' } }],
		});
		t.popover.dispose();
	});

	test('your turn: a refused answer and an undelivered answer are shown on the card', async () => {
		const entry = ask('1', { kind: 'permission', preface: 'Bash: npm test', actions: ALLOW_DENY });
		const t = open([entry], { ok: false, reason: 'busy' });
		t.press('pane:1', 'action:yes');
		await new Promise(resolve => setTimeout(resolve, 0));
		const refused = cards(t.container)[0].note;
		t.ledger.set([{ ...entry, failedAt: 5 }]);
		// 断られた理由は、次に押すまで残す
		t.clock.now += 1_000;
		t.press('pane:1', 'action:no');
		const sending = cards(t.container)[0].note;
		assert.deepStrictEqual({ refused, sending }, { refused: 'ほかの場所からの回答を届けています', sending: '回答を届けています…' });
		await new Promise(resolve => setTimeout(resolve, 0));
		t.popover.dispose();
	});

	test('your turn dialog: several questions are chosen first and sent together, and a dangerous permission starts on cancel', async () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		store.add({ dispose: () => container.remove() });
		const two = ask('1', {
			questions: [
				{ id: '0', text: 'Windows も出しますか?', options: [{ id: '0', label: '出す' }, { id: '1', label: '今回は出さない' }], allowText: false },
				{ id: '1', text: 'ほかに入れたいものは?', options: [], allowText: true },
			],
		});
		const danger = ask('2', { kind: 'permission', preface: 'Bash: sudo rm -rf /tmp/build', actions: ALLOW_DENY });
		const ledger = store.add(humanAsk([two, danger]));
		const closed: string[] = [];
		const foot = () => [...container.querySelectorAll<HTMLElement>('.pniad-foot .paradis-button')].map(button => `${button.textContent}${button.classList.contains('disabled') ? ' (disabled)' : ''}`);

		const dialog = store.add(new ParadisInboxAskDialog({ container, key: two.key, onClose: () => closed.push('questions') }, ledger.service));
		const before = { foot: foot(), status: container.querySelector('.pniad-status')?.textContent };
		// 選んだだけでは送らない
		container.querySelectorAll<HTMLElement>('.pniad-option')[1].click();
		const afterPick = { answers: ledger.answers.length, foot: foot() };
		const input = container.querySelector<HTMLInputElement>('.pniad-text input')!;
		input.value = 'なし';
		input.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
		const ready = foot();
		container.querySelector<HTMLElement>('.pniad-foot-submit')!.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		dialog.dispose();

		const permission = store.add(new ParadisInboxAskDialog({ container, key: danger.key, onClose: () => closed.push('permission') }, ledger.service));
		const permissionView = {
			dangers: [...container.querySelectorAll('.pniad-dangers .paradis-chip')].map(chip => chip.textContent),
			detail: container.querySelector('.pniad-detail')?.textContent,
			foot: foot(),
			focused: mainWindow.document.activeElement?.textContent,
		};
		// 開いている間にスマホで答えられた: ボタンを外し、閉じるだけにする
		ledger.set([two, { ...danger, state: 'answered', resolution: { at: 3, surface: 'mobile', summary: '拒否' } }]);
		const settled = { text: container.querySelector('.pniad-settled')?.textContent, foot: foot() };
		permission.dispose();

		assert.deepStrictEqual({ before, afterPick, ready, answers: ledger.answers, closed, permissionView, settled }, {
			before: { foot: ['やめる', '回答する (disabled)'], status: '0 / 2 を選びました。全部に答えると送れます' },
			afterPick: { answers: 0, foot: ['やめる', '回答する (disabled)'] },
			ready: ['やめる', '回答する'],
			answers: [{ key: 'pane:1', answer: { type: 'answers', answers: [{ questionId: '0', optionIds: ['1'] }, { questionId: '1', text: 'なし' }] } }],
			closed: ['questions'],
			permissionView: { dangers: ['削除を含む', '管理者権限'], detail: 'Bash: sudo rm -rf /tmp/build', foot: ['やめる', '許可', '拒否'], focused: 'やめる' },
			settled: { text: 'スマホで回答済み: 「拒否」', foot: ['閉じる'] },
		});
	});

	test('dialog: a button the board confirms asks the same confirmation before it sends', async () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		store.add({ dispose: () => container.remove() });
		const stalled = ask('1', {
			source: 'board', key: 'board:L:t1:stalled:1', kind: 'stalled', preface: 'board_complete_step の報告がないまま止まりました',
			actions: [{ id: 'nudge', label: '報告を促す' }, { id: 'complete', label: '完了扱いにする', confirm: { title: '#7 を完了にしますか', body: 'PR はマージしません。ボード上で完了として扱い、作業場所を返します。', ok: '完了にする' } }],
		});
		const ledger = store.add(humanAsk([stalled]));
		const dialog = store.add(new ParadisInboxAskDialog({ container, key: stalled.key, onClose: () => { } }, ledger.service));
		const view = () => ({
			status: [...container.querySelectorAll('.pniad-status > *')].map(part => part.textContent),
			foot: [...container.querySelectorAll<HTMLElement>('.pniad-foot .paradis-button')].map(button => button.textContent),
		});
		const press = (label: string) => [...container.querySelectorAll<HTMLElement>('.pniad-foot .paradis-button')].find(button => button.textContent === label)?.click();
		const before = view();
		// 「完了扱いにする」は送らずに確認を出す。「やめる」でボタンの一覧へ戻る
		press('完了扱いにする');
		const confirming = { ...view(), answers: ledger.answers.length };
		press('やめる');
		const back = view();
		press('完了扱いにする');
		press('完了にする');
		await new Promise(resolve => setTimeout(resolve, 0));
		dialog.dispose();
		assert.deepStrictEqual({ before, confirming, back, answers: ledger.answers }, {
			before: { status: [], foot: ['やめる', '報告を促す', '完了扱いにする'] },
			confirming: { status: ['#7 を完了にしますか', 'PR はマージしません。ボード上で完了として扱い、作業場所を返します。'], foot: ['やめる', '完了にする'], answers: 0 },
			back: { status: [], foot: ['やめる', '報告を促す', '完了扱いにする'] },
			answers: [{ key: 'board:L:t1:stalled:1', answer: { type: 'action', actionId: 'complete' } }],
		});
	});

	test('fits the popover into narrow windows instead of running off the right edge', () => {
		assert.deepStrictEqual([
			// 広いウィンドウ: ベルの右端にそろえる・ベルが無ければ右上
			paradisInboxPopoverPlacement(1200, 900),
			paradisInboxPopoverPlacement(1200, undefined),
			// ズームした最小幅のウィンドウ（CSS で 333px）: 両端の余白を残して縮める
			paradisInboxPopoverPlacement(333, 300),
			paradisInboxPopoverPlacement(333, undefined),
		], [
			{ left: 440, width: 460 },
			{ left: 732, width: 460 },
			{ left: 8, width: 317 },
			{ left: 8, width: 317 },
		]);
	});

	test('lists entries with their state and routes clicks to the pane or to read', () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		store.add({ dispose: () => container.remove() });

		const snapshot: IParadisInboxSnapshot = {
			entries: [
				entry('2', { kind: 'permission', tab: 'claude', message: 'Bash: npm test -- auth' }),
				entry('1', { kind: 'review', worktree: 'fix-login', read: true, live: false }),
			],
			attentionPaneCount: 1,
			unreadCount: 1,
			revision: 3,
		};
		const calls: string[] = [];
		const inboxService = {
			onDidChange: Event.None,
			snapshot,
			reveal: async (target: IParadisInboxEntry) => { calls.push(`reveal:${target.id}`); },
			markRead: async (ids: readonly string[]) => { calls.push(`read:${ids.join(',')}`); },
			markAllRead: async () => { calls.push('readAll'); },
		} as unknown as IParadisNotificationInboxService;

		const popover = store.add(new ParadisNotificationInboxPopover(
			{ anchor: undefined, onClose: () => calls.push('close') },
			{ activeContainer: container } as unknown as ILayoutService,
			inboxService,
			{} as IContextMenuService,
			new TestConfigurationService(),
			{} as ICommandService,
			NullHoverService,
			humanAsk([]).service,
		));

		const rows = [...container.getElementsByClassName('pnip-row')] as HTMLElement[];
		// 時刻（「now」など）は環境の言語で変わるので比べない。
		const text = (row: HTMLElement, className: string) => (row.getElementsByClassName(className)[0] as HTMLElement | undefined)?.textContent;
		const rendered = rows.map(row => ({
			classes: [...row.classList].filter(name => name !== 'pnip-row' && name !== 'paradis-focus-subtle').sort(),
			kind: text(row, 'pnip-kind'),
			space: text(row, 'pnip-space'),
			detail: text(row, 'pnip-detail'),
			message: text(row, 'pnip-message') ?? text(row, 'pnip-note'),
			ariaLabel: row.getAttribute('aria-label'),
			role: row.getAttribute('role'),
			tabIndex: row.tabIndex,
		}));
		const listRole = container.getElementsByClassName('pnip-notifications')[0].getAttribute('role');
		rows[0].click();
		rows[1].click();

		assert.deepStrictEqual({ listRole, rendered, calls }, {
			// Tab は一覧で 1 回だけ止まる（今の行だけ tabIndex = 0）
			listRole: 'listbox',
			rendered: [
				{ classes: ['unread'], kind: '許可待ち', space: 'para-code', detail: 'claude', message: 'Bash: npm test -- auth', ariaLabel: '未読 許可待ち para-code ／ claude Bash: npm test -- auth', role: 'option', tabIndex: 0 },
				// 「完了」は札にせず時刻の横に出す
				{ classes: ['closed'], kind: undefined, space: 'para-code', detail: 'fix-login', message: 'このペインは閉じています', ariaLabel: '既読 完了 para-code (fix-login) このペインは閉じています', role: 'option', tabIndex: -1 },
			],
			calls: ['close', 'reveal:2', 'read:1'],
		});
		popover.dispose();
	});
});
