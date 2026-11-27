/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot グループの部屋（案 B）。グループを開くと、この短いエディタの下にメンバーの Bot のターミナルが横に並ぶ。
// 部屋には、名前・返事をする Bot の決め方・メンバーの変更、上の 1 行の入力欄（「@名前」「@全員」で名指しして送る）、
// グループの記録（あなたが送った・Bot が聞いた・伝えた）、このグループの項目（あなたの番と進行中）を出す。
// 返事はそれぞれのターミナルにそのまま出るので、ここには写さない（写すのは部屋のページ＝案 A）。
//
// タブは復元しない（シリアライザを登録しない）。設定をオフにした後やグループを消した後に、空の部屋が戻らないように。

import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ParadisButton } from '../../../browser/paradisButton.js';
import { ParadisInputField } from '../../../browser/paradisInputField.js';
import { ParadisSegmented } from '../../../browser/paradisSegmented.js';
import { IParadisBotItem } from '../common/paradisBotItems.js';
import { paradisBotItemGroups } from '../common/paradisBotPageModel.js';
import { paradisBotGroupMentionProblem, paradisBotGroupRecordHead, paradisBotGroupRecordMark, paradisBotGroupSendSummary } from '../common/paradisBotGroupRoomModel.js';
import { IParadisBotGroup, paradisBotGroupMembers, paradisResolveBotGroupMentions, ParadisBotGroupReplyMode } from '../common/paradisBotGroups.js';
import { IParadisBotGroupsService } from '../common/paradisBotGroupsApi.js';
import { IParadisBotsService, IParadisBotSummary, PARADIS_BOTS_ENABLED_SETTING } from '../common/paradisBotsApi.js';
import { PARADIS_BOTS_OPEN_COMMAND, paradisBotFace } from '../common/paradisBotsBandModel.js';
import { ParadisBotGroupDialog } from './paradisBotGroupDialog.js';
import { renderParadisBotFace } from './paradisBotFace.js';

export const PARADIS_BOT_GROUP_EDITOR_ID = 'paradis.editor.botGroup';
export const PARADIS_BOT_GROUP_INPUT_TYPE_ID = 'paradis.input.botGroup';

/** 部屋に出す記録の数（新しい方から）。 */
const ROOM_RECORDS = 30;

/** 部屋の入力欄から Bot のペインへ送る口（実体はウィンドウの側。送る口はチャット表示と同じ）。 */
export const IParadisBotGroupSender = createDecorator<IParadisBotGroupSender>('paradisBotGroupSender');

export interface IParadisBotGroupSender {
	readonly _serviceBrand: undefined;
	/** このウィンドウでの Bot のペインの居場所（今のスペース・別のスペース・無い）。 */
	whereIs(botId: string): Promise<'here' | 'elsewhere' | 'none'>;
	/** 送れたら undefined、送れなければ理由の文。 */
	send(botId: string, text: string): Promise<string | undefined>;
}

function clock(time: number): string {
	const date = new Date(time);
	return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export class ParadisBotGroupEditorInput extends EditorInput {

	static readonly ID = PARADIS_BOT_GROUP_INPUT_TYPE_ID;

	private static readonly inputs = new Map<string, ParadisBotGroupEditorInput>();

	/** グループごとに 1 つ（同じグループの部屋を 2 つ開かない）。 */
	static getOrCreate(instantiationService: IInstantiationService, groupId: string): ParadisBotGroupEditorInput {
		let input = ParadisBotGroupEditorInput.inputs.get(groupId);
		if (input === undefined || input.isDisposed()) {
			input = instantiationService.createInstance(ParadisBotGroupEditorInput, groupId);
			ParadisBotGroupEditorInput.inputs.set(groupId, input);
		}
		return input;
	}

	readonly resource: URI;

	constructor(
		readonly groupId: string,
		@IParadisBotGroupsService private readonly groupsService: IParadisBotGroupsService,
	) {
		super();
		this.resource = URI.from({ scheme: 'paradis-bot-group', path: `/${groupId}` });
		this._register(this.groupsService.onDidChange(() => this._onDidChangeLabel.fire()));
	}

	override get typeId(): string {
		return ParadisBotGroupEditorInput.ID;
	}

	override get editorId(): string {
		return PARADIS_BOT_GROUP_EDITOR_ID;
	}

	override getName(): string {
		return this.groupsService.snapshot.groups.find(group => group.id === this.groupId)?.name ?? localize('paradis.botGroups.editorName', "Bot グループ");
	}

	override getIcon(): ThemeIcon {
		return Codicon.commentDiscussion;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || (other instanceof ParadisBotGroupEditorInput && other.groupId === this.groupId);
	}

	override dispose(): void {
		if (ParadisBotGroupEditorInput.inputs.get(this.groupId) === this) {
			ParadisBotGroupEditorInput.inputs.delete(this.groupId);
		}
		super.dispose();
	}
}

export class ParadisBotGroupEditor extends EditorPane {

	static readonly ID = PARADIS_BOT_GROUP_EDITOR_ID;

	private root!: HTMLElement;
	private faces!: HTMLElement;
	private title!: HTMLElement;
	private replyMode!: ParadisSegmented<ParadisBotGroupReplyMode>;
	private composer!: ParadisInputField;
	private sendButton!: ParadisButton;
	private status!: HTMLElement;
	/** 並べられなかったメンバー（別のスペースで動作中・起動していない）。 */
	private where!: HTMLElement;
	private whereRequest = 0;
	private records!: HTMLElement;
	private items!: HTMLElement;
	/** 項目の行のリスナー（項目を描き直すたびに捨てる。記録の描き直しでは捨てない）。 */
	private readonly itemDisposables = this._register(new DisposableStore());
	private sending = false;
	/** 項目の取り直しの番号（古い結果で上書きしない）。 */
	private itemsRequest = 0;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IParadisBotGroupsService private readonly groupsService: IParadisBotGroupsService,
		@IParadisBotsService private readonly botsService: IParadisBotsService,
		@IParadisBotGroupSender private readonly sender: IParadisBotGroupSender,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(PARADIS_BOT_GROUP_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	private get groupInput(): ParadisBotGroupEditorInput | undefined {
		return this.input instanceof ParadisBotGroupEditorInput ? this.input : undefined;
	}

	private get botGroup(): IParadisBotGroup | undefined {
		const id = this.groupInput?.groupId;
		return id !== undefined ? this.groupsService.snapshot.groups.find(group => group.id === id) : undefined;
	}

	private get members(): IParadisBotSummary[] {
		const group = this.botGroup;
		const bots = this.botsService.snapshot.bots;
		return group !== undefined ? paradisBotGroupMembers(group, new Set(bots.map(bot => bot.id))).map(id => bots.find(bot => bot.id === id)!) : [];
	}

	private nameOf(botId: string): string {
		return this.botsService.snapshot.bots.find(bot => bot.id === botId)?.name ?? localize('paradis.botGroups.removedBot', "（削除した Bot）");
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = dom.append(parent, dom.$('.paradis-bot-group-room'));

		const head = dom.append(this.root, dom.$('.pbgr-head'));
		this.faces = dom.append(head, dom.$('.pbgr-faces'));
		this.title = dom.append(head, dom.$('span.pbgr-title'));
		dom.append(head, dom.$('span.pbgr-grow'));
		const replyLabel = localize('paradis.botGroups.replyMode', "返事をする Bot:");
		dom.append(head, dom.$('span.pbgr-label')).textContent = replyLabel;
		this.replyMode = this._register(new ParadisSegmented<ParadisBotGroupReplyMode>(head, {
			items: [
				{ value: 'mentioned', label: localize('paradis.botGroups.replyMentioned', "名指しのときだけ") },
				{ value: 'all', label: localize('paradis.botGroups.replyAll', "全員") },
			],
			value: 'mentioned',
			ariaLabel: replyLabel,
		}));
		this._register(this.replyMode.onDidChange(mode => {
			const group = this.botGroup;
			if (group !== undefined) {
				void this.groupsService.updateGroup(group.id, { replyMode: mode });
			}
		}));
		const members = this._register(new ParadisButton(head, { kind: 'secondary', label: localize('paradis.botGroups.members', "メンバーを変える...") }));
		this._register(members.onDidClick(() => {
			const group = this.botGroup;
			if (group !== undefined) {
				this.instantiationService.createInstance(ParadisBotGroupDialog, members.element, group, () => undefined);
			}
		}));

		const composerRow = dom.append(this.root, dom.$('.pbgr-composer'));
		this.composer = this._register(new ParadisInputField(composerRow, { ariaLabel: localize('paradis.botGroups.composer', "グループに送る"), small: true }));
		this._register(dom.addDisposableListener(this.composer.inputElement, dom.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			// 日本語の変換を確定する Enter では送らない
			if (event.equals(KeyCode.Enter) && !e.isComposing) {
				dom.EventHelper.stop(e, true);
				void this.send();
			}
		}));
		this.sendButton = this._register(new ParadisButton(composerRow, { kind: 'primary', label: localize('paradis.botGroups.send', "送る") }));
		this._register(this.sendButton.onDidClick(() => void this.send()));

		const statusRow = dom.append(this.root, dom.$('.pbgr-status-row'));
		this.status = dom.append(statusRow, dom.$('span.pbgr-status'));
		this.status.setAttribute('role', 'status');
		this.where = dom.append(statusRow, dom.$('span.pbgr-where'));

		const body = dom.append(this.root, dom.$('.pbgr-body'));
		const recordsColumn = dom.append(body, dom.$('.pbgr-column'));
		dom.append(recordsColumn, dom.$('.pbgr-column-title')).textContent = localize('paradis.botGroups.records', "記録");
		this.records = dom.append(recordsColumn, dom.$('.pbgr-records'));
		this.records.setAttribute('role', 'list');
		this.records.setAttribute('aria-label', localize('paradis.botGroups.records', "記録"));
		const itemsColumn = dom.append(body, dom.$('.pbgr-column'));
		dom.append(itemsColumn, dom.$('.pbgr-column-title')).textContent = localize('paradis.botGroups.items', "このグループの項目");
		this.items = dom.append(itemsColumn, dom.$('.pbgr-items'));
		this.items.setAttribute('role', 'list');
		this.items.setAttribute('aria-label', localize('paradis.botGroups.items', "このグループの項目"));

		this._register(this.groupsService.onDidChange(() => this.render()));
		this._register(this.botsService.onDidChange(() => {
			this.render();
			void this.renderItems();
			void this.renderWhere();
		}));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.status.textContent = '';
		this.render();
		await Promise.all([this.renderItems(), this.renderWhere()]);
	}

	private async renderWhere(): Promise<void> {
		const request = ++this.whereRequest;
		const members = this.members;
		const places = await Promise.all(members.map(async bot => ({ bot, where: bot.paused ? 'paused' as const : await this.sender.whereIs(bot.id) })));
		if (request !== this.whereRequest || !this.where) {
			return;
		}
		const names = (kind: string) => places.filter(place => place.where === kind).map(place => place.bot.name).join('・');
		const notes = [
			names('elsewhere') && localize('paradis.botGroups.elsewhere', "別のスペースで動作中: {0}", names('elsewhere')),
			names('none') && localize('paradis.botGroups.notStarted', "起動していません: {0}", names('none')),
			names('paused') && localize('paradis.botGroups.pausedNote', "停止中: {0}", names('paused')),
		];
		this.where.textContent = notes.filter(note => !!note).join('　');
	}

	override focus(): void {
		super.focus();
		this.composer?.focus();
	}

	override layout(): void {
		// 中身は CSS の flex と grid で収まる
	}

	private render(): void {
		if (!this.root) {
			return;
		}
		const group = this.botGroup;
		const members = this.members;
		this.root.classList.toggle('missing', group === undefined);
		dom.clearNode(this.faces);
		for (const bot of members) {
			renderParadisBotFace(this.faces, paradisBotFace(bot));
		}
		this.title.textContent = group?.name ?? localize('paradis.botGroups.gone', "このグループは削除されました");
		this.replyMode.value = group?.replyMode ?? 'mentioned';
		const names = members.map(bot => `@${bot.name}`).join(' ');
		this.composer.inputElement.placeholder = localize('paradis.botGroups.placeholder', "グループに送る。{0} @全員", names);
		const enabled = group !== undefined && this.configurationService.getValue(PARADIS_BOTS_ENABLED_SETTING) === true;
		this.composer.enabled = enabled;
		this.sendButton.enabled = enabled && !this.sending;
		this.renderRecords(group);
	}

	private renderRecords(group: IParadisBotGroup | undefined): void {
		dom.clearNode(this.records);
		const records = group !== undefined ? this.groupsService.snapshot.records.filter(record => record.groupId === group.id).slice(-ROOM_RECORDS) : [];
		if (records.length === 0) {
			dom.append(this.records, dom.$('.pbgr-empty')).textContent = localize('paradis.botGroups.noRecords', "まだ記録はありません。送った文と、Bot 同士の質問・伝言がここに残ります");
			return;
		}
		for (const record of records) {
			const row = dom.append(this.records, dom.$('.pbgr-record'));
			row.setAttribute('role', 'listitem');
			row.dataset.kind = record.kind;
			dom.append(row, dom.$('span.pbgr-time')).textContent = clock(record.at);
			dom.append(row, dom.$('span.pbgr-who')).textContent = paradisBotGroupRecordHead(record, id => this.nameOf(id));
			const mark = paradisBotGroupRecordMark(record);
			if (mark !== undefined) {
				const chip = dom.append(row, dom.$('span.pbgr-undelivered'));
				chip.textContent = mark;
				chip.classList.toggle('read', record.undelivered === undefined && record.readAt !== undefined);
				chip.classList.toggle('unread', record.undelivered === undefined && record.readAt === undefined);
			}
			const text = dom.append(row, dom.$('span.pbgr-text'));
			text.textContent = record.text;
			text.title = record.text;
		}
		this.records.scrollTop = this.records.scrollHeight;
	}

	private async renderItems(): Promise<void> {
		const request = ++this.itemsRequest;
		const members = this.members;
		const ids = new Set(members.map(bot => bot.id));
		const items = ids.size > 0 ? (await this.botsService.listItems({ open: true })).filter(item => ids.has(item.botId)) : [];
		if (request !== this.itemsRequest || !this.items) {
			return;
		}
		this.itemDisposables.clear();
		dom.clearNode(this.items);
		const groups = paradisBotItemGroups(items, Date.now());
		const shown = [...groups.you, ...groups.working];
		if (shown.length === 0) {
			dom.append(this.items, dom.$('.pbgr-empty')).textContent = localize('paradis.botGroups.noItems', "あなたの番と進行中の項目はありません");
			return;
		}
		for (const item of shown) {
			this.renderItem(item, groups.you.includes(item), members.find(bot => bot.id === item.botId));
		}
	}

	private renderItem(item: IParadisBotItem, yours: boolean, bot: IParadisBotSummary | undefined): void {
		const row = dom.append(this.items, dom.$('.pbgr-item.paradis-focus-ring-inset'));
		row.setAttribute('role', 'listitem');
		row.tabIndex = 0;
		row.classList.toggle('yours', yours);
		if (bot !== undefined) {
			renderParadisBotFace(row, paradisBotFace(bot));
		}
		dom.append(row, dom.$('span.pbgr-item-number')).textContent = `#${item.number}`;
		const title = dom.append(row, dom.$('span.pbgr-item-title'));
		title.textContent = item.title;
		title.title = item.title;
		if (yours) {
			dom.append(row, dom.$('span.pbgr-item-tag')).textContent = localize('paradis.botGroups.yourTurn', "あなたの番");
		}
		// 項目は Bot のページで読む（その Bot を開く）
		const open = () => void this.commandService.executeCommand(PARADIS_BOTS_OPEN_COMMAND, item.botId);
		this.itemDisposables.add(dom.addDisposableListener(row, dom.EventType.CLICK, open));
		this.itemDisposables.add(dom.addDisposableListener(row, dom.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				dom.EventHelper.stop(e, true);
				open();
			}
		}));
	}

	private async send(): Promise<void> {
		const group = this.botGroup;
		if (group === undefined || this.sending || this.configurationService.getValue(PARADIS_BOTS_ENABLED_SETTING) !== true) {
			return;
		}
		const text = this.composer.value;
		const members = this.members;
		const resolved = paradisResolveBotGroupMentions(text, members, group.replyMode);
		const problem = paradisBotGroupMentionProblem(resolved);
		if (problem !== undefined || !resolved.ok) {
			this.setStatus(problem ?? '', true);
			return;
		}
		this.sending = true;
		this.render();
		const sent: string[] = [];
		const failed: { name: string; reason: string }[] = [];
		try {
			// 1 人ずつ順に送る（同じ文をまとめて打鍵すると、TUI の取りこぼしを見分けられない）
			for (const botId of resolved.targets) {
				const reason = members.find(bot => bot.id === botId)?.paused ? localize('paradis.botGroups.paused', "停止中") : await this.sender.send(botId, text.trim());
				if (reason === undefined) {
					sent.push(botId);
				} else {
					failed.push({ name: this.nameOf(botId), reason });
				}
			}
			if (sent.length > 0) {
				// 記録は実際に届いた Bot だけ
				await this.groupsService.recordSent(group.id, sent, text.trim());
			}
		} finally {
			this.sending = false;
		}
		if (failed.length === 0) {
			this.composer.value = '';
		}
		this.setStatus(paradisBotGroupSendSummary(sent.map(id => this.nameOf(id)), failed), failed.length > 0);
		this.render();
	}

	private setStatus(text: string, error: boolean): void {
		this.status.textContent = text;
		this.status.classList.toggle('error', error);
		// 幅が足りないときは切れるので、全文はホバーで読めるようにする
		this.status.title = text;
	}
}
