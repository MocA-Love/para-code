/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 横断ジャンプ（G-05）: 要対応のエージェント（全スペース）・今のスペースの開いているタブ・スペースを
// 1 つのクイックピックで選んで移る。Orca の Cmd+J（Linux・Windows は Ctrl+Shift+J）に当たるが、
// 既定のキーは付けない（Linux・Windows の Ctrl+Shift+J はチャット表示の切り替えが使っている。
// 利用者がキー割り当てで付ける）。
//
// 中央のパレットの作り直し（Q609・Q610、mock/ui/palette-ideas.html の案 11）:
//  - 入力の段の下に種類のタブ（すべて・エージェント・タブ・スペース・コマンド）。Tab・Shift+Tab で回し、接頭辞
//    （`a `・`t `・`s `）を打ってもその種類に替わる。「コマンド」と `>` はコマンドパレットへ切り替え、コマンド
//    パレットでも同じタブを出して Tab で戻れるようにする。`?` と右端のボタンはヘルプ。
//  - 行の頭は状態の点、区切りは件数（要対応があれば「要対応 N」）、スペースはリポジトリごとの見出しの下に字下げ。
//  - 入力が空のときは先頭に「最近・ピン」と「操作」（新しいスペース・ターミナル・エージェントの起動など）。
//  - 一致が無いときは、作る・コマンドで探す・ファイル名で探す・中身を探すの 4 つを出す。
//  - 選んだ行とホバーの行の右に 2 次操作のボタン（タブは横に開く・閉じる、エージェントは止める、最近の行はピン）。
//    キーは Ctrl+Enter（本家の quickInput.accept の Ctrl 付き Enter をそのまま受け、keyMods を見る）と、入力が空の
//    ときの Ctrl+Backspace（入力中は本家どおり単語の削除）。
// 行は本家のクイックピックの行のまま作る（点は iconClass、種類の印は id、2 次操作は buttons）。DOM を足すのは
// 種類のタブとヒントの段だけで、器を使い回す本家に合わせて開いている間だけ足す。
//
// エージェントへの移動は OS 通知のクリックと同じ paradisRevealNotifiedPane を使う（別スペースなら
// 切り替え、切り替えが割り込まれたら開かない、補助ウィンドウのペインはそのウィンドウを前へ）。

import { status } from '../../../../base/browser/ui/aria/aria.js';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { decodeKeybinding } from '../../../../base/common/keybindings.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { OS } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { getIconClasses } from '../../../../editor/common/services/getIconClasses.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { InputFocusedContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputButton, IQuickInputService, IQuickPick, IQuickPickItem, IQuickPickSeparator, QuickInputType } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { EditorResourceAccessor, EditorsOrder, IEditorIdentifier, SideBySideEditor } from '../../../../workbench/common/editor.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalCommandId } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { IEditorService, SIDE_GROUP } from '../../../../workbench/services/editor/common/editorService.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IParadisAgentLiveEntry, IParadisAgentLiveWindowService, ParadisAgentLiveStatus } from '../../agentLiveWindow/common/paradisAgentLiveWindow.js';
import { IParadisAgentModelCatalogService } from '../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import { paradisRevealNotifiedPane } from '../../notifications/electron-browser/paradisNotificationReveal.js';
import { paradisEnsureQuickInputHint, paradisFindQuickInputWidget, paradisIsCenteredQuickInput } from '../../quickInputPosition/browser/paradisQuickInputLook.js';
import { paradisNormalizeLaunchChoice, paradisParseStoredLaunchChoices, paradisRestoreLaunchChoice, paradisTabLauncherAgents, paradisTabLauncherRoot } from '../../tabLauncher/common/paradisTabLauncher.js';
import { IParadisAgentStatusStore, IParadisSpaceEntry, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisListSpaces } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { PARADIS_AGENT_LAUNCH_OPTIONS_STORAGE_KEY } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';
import { paradisLaunchAgentInWorkspace } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import { ParadisPaletteKindsBar, paradisPaletteKindLabel } from '../browser/paradisPaletteKinds.js';
import {
	IParadisPaletteRecent,
	paradisCyclePaletteKind,
	paradisFormatCrossJumpAgo,
	paradisGroupPaletteSpaces,
	paradisPaletteActionsToShow,
	paradisPaletteMatches,
	paradisPaletteRecentsToShow,
	paradisParsePalettePrefix,
	paradisParsePaletteRecents,
	paradisPrunePaletteRecents,
	ParadisPaletteKind,
	paradisRecordPaletteRecent,
	paradisSortCrossJumpAgents,
	paradisSplitPaletteRecents,
	paradisTogglePalettePin,
} from '../common/paradisCrossJump.js';

/** 横断ジャンプのコマンド。キーは付けない（利用者がキー割り当てで付ける）。引数 `{ kind }` で開く種類を選べる。 */
export const PARADIS_CROSS_JUMP_COMMAND_ID = 'paradis.crossJump.open';
/** 種類のタブを右・左へ回す（Tab・Shift+Tab）。 */
const NEXT_KIND_COMMAND_ID = 'paradis.palette.nextKind';
const PREVIOUS_KIND_COMMAND_ID = 'paradis.palette.previousKind';
/** 選んでいる行の 2 次操作（閉じる・止める）。入力が空のときの Ctrl+Backspace。 */
const SECONDARY_ACTION_COMMAND_ID = 'paradis.palette.secondaryAction';

/** ワークツリースペースの作成（ダイアログ）。登録元の contribution を import すると登録の副作用が走るので ID だけ持つ。 */
const CREATE_WORKTREE_COMMAND_ID = 'paradis.workspaceSwitch.createWorktree';

/** 横断ジャンプのクイックピックが開いている間 true（IQuickInput.contextKey で本家が立てる）。 */
const CROSS_JUMP_CONTEXT_KEY = 'paradisInCrossJump';
/** コマンドパレットが開いている間 true（本家の quickAccess.contribution.ts が付ける contextKey）。 */
const COMMANDS_PICKER_CONTEXT_KEY = 'inCommandsPicker';
/**
 * 種類のタブを器に出している間 true（中央に出した横断ジャンプとコマンドパレットだけ）。Tab・Shift+Tab はこれと
 * 入力欄にフォーカスがあるときだけ取り、行のボタンなどにフォーカスがあるときは本家の Tab のままにする。
 */
const ParadisPaletteKindsVisibleContext = new RawContextKey<boolean>('paradisPaletteKindsVisible', false, localize('paradis.palette.kindsVisible', "中央のパレットに種類のタブを出しているかどうか"));
/** 横断ジャンプの入力が空の間 true。Ctrl+Backspace を入力中の単語の削除とぶつけないために使う。 */
const ParadisCrossJumpInputEmptyContext = new RawContextKey<boolean>('paradisCrossJumpInputEmpty', false, localize('paradis.crossJump.inputEmpty', "横断ジャンプの入力欄が空かどうか"));

/**
 * 最近移った先・ピンの保存キー（fork 自前）。最近・ピンは窓の作業に紐づくので窓（ワークスペース）ごとに持つ。刈り込みの
 * 生死の判定はこの窓のスペースとエージェントだけで行うので、窓の間で共有すると別の窓で生きている先を消してしまう。
 * 以前はプロファイル（全窓共有）に持っていたので、その記録は初回にこの窓が知っている分だけ移す。
 */
const RECENT_STORAGE_KEY = 'paradis.palette.recent';
/** 行の id の頭。CSS（paradisPalette.css）は「paradis-palette/space/」で字下げ、「paradis-palette/」で 2 次操作の見た目を決める。 */
const ID_PREFIX = 'paradis-palette/';

const STATUS_LABELS: Record<ParadisAgentLiveStatus, string> = {
	permission: localize('paradis.crossJump.status.permission', "許可待ち"),
	question: localize('paradis.crossJump.status.question', "質問中"),
	working: localize('paradis.crossJump.status.working', "実行中"),
	review: localize('paradis.crossJump.status.review', "完了"),
	idle: localize('paradis.crossJump.status.idle', "待機"),
};

function isAttention(status: ParadisAgentLiveStatus | undefined): boolean {
	return status === 'permission' || status === 'question';
}

/** 状態の点の class（行の iconClass）。状態が無い行も点の幅だけ空けて名前を揃える。 */
function dotClass(status: ParadisAgentLiveStatus | undefined): string {
	const tone = isAttention(status) ? 'attention' : status === 'working' || status === 'review' || status === 'idle' ? status : 'none';
	return `paradis-palette-dot paradis-palette-dot-${tone}`;
}

type ParadisCrossJumpItem = IQuickPickItem & (
	| { readonly kind: 'agent'; readonly entry: IParadisAgentLiveEntry }
	| { readonly kind: 'editor'; readonly identifier: IEditorIdentifier; readonly key: string | undefined }
	| { readonly kind: 'space'; readonly stateKey: string }
	| { readonly kind: 'create'; readonly repositoryId: string; readonly name: string }
	| { readonly kind: 'action'; readonly run: () => Promise<unknown> }
	| { readonly kind: 'switch'; readonly value: string }
);

type ParadisCrossJumpPickItem = ParadisCrossJumpItem | IQuickPickSeparator;

interface IParadisPaletteAction {
	readonly id: string;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly commandId?: string;
	readonly run: () => Promise<unknown>;
}

/** 横断ジャンプのいま開いている 1 回分。Tab・Ctrl+Backspace のキー割り当てはここへ渡す。 */
let activeSession: ParadisCrossJumpSession | undefined;

class ParadisCrossJumpSession extends Disposable {

	private readonly picker: IQuickPick<ParadisCrossJumpItem, { useSeparators: true }>;
	private readonly inputEmpty: IContextKey<boolean>;
	private kindsBar: ParadisPaletteKindsBar | undefined;
	private kind: ParadisPaletteKind;
	private recents: IParadisPaletteRecent[] = [];
	private readonly kindsVisible: IContextKey<boolean>;
	/** 横断ジャンプからほかのクイックアクセス（コマンドパレットなど）へ切り替えて閉じたとき true。 */
	private switching = false;

	private readonly now = Date.now();
	private readonly activeStateKey: string | undefined;
	private readonly spaces: IParadisSpaceEntry[];
	private readonly agents: IParadisAgentLiveEntry[];
	private agentItems: ParadisCrossJumpItem[] = [];
	private editorItems: ParadisCrossJumpItem[] = [];
	private readonly spaceItems: ParadisCrossJumpItem[];
	private readonly repositoryNames = new Map<string, string>();
	private readonly actions: IParadisPaletteAction[];
	private readonly createRepositoryId: string | undefined;

	constructor(
		initialKind: ParadisPaletteKind,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IEditorService private readonly editorService: IEditorService,
		@ICommandService private readonly commandService: ICommandService,
		@IHostService private readonly hostService: IHostService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@IParadisAgentStatusStore private readonly agentStatusStore: IParadisAgentStatusStore,
		@IParadisAgentLiveWindowService private readonly agentLiveWindowService: IParadisAgentLiveWindowService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IStorageService private readonly storageService: IStorageService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IParadisAgentModelCatalogService private readonly modelCatalogService: IParadisAgentModelCatalogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this.kind = initialKind === 'command' ? 'all' : initialKind;
		this.inputEmpty = ParadisCrossJumpInputEmptyContext.bindTo(contextKeyService);
		this._register({ dispose: () => this.inputEmpty.reset() });

		this.activeStateKey = this.workspaceSwitchService.activeStateKey;
		this.spaces = paradisListSpaces(this.workspaceSwitchService.repositories, this.worktreeService);
		for (const repository of this.workspaceSwitchService.repositories) {
			this.repositoryNames.set(repository.id, repository.name);
		}
		this.agents = paradisSortCrossJumpAgents(this.agentLiveWindowService.entries);
		this.agentItems = this.agents.map(entry => this.agentItem(entry));
		this.editorItems = this.collectEditorItems();
		this.spaceItems = this.spaces.map(space => this.spaceItem(space));
		// 作成の行の行き先は今のスペースのリポジトリ（スペースの外なら先頭のリポジトリ）。
		this.createRepositoryId = this.spaces.find(space => space.space === this.activeStateKey)?.repositoryId ?? this.workspaceSwitchService.repositories[0]?.id;
		this.actions = this.collectActions();
		const liveTokens = new Set(this.agents.map(entry => entry.token));
		const liveSpaces = new Set(this.spaces.map(space => space.space));
		let recents = paradisParsePaletteRecents(this.storageService.get(RECENT_STORAGE_KEY, StorageScope.WORKSPACE));
		const shared = this.storageService.get(RECENT_STORAGE_KEY, StorageScope.PROFILE);
		if (shared !== undefined) {
			// 共有の記録から、この窓が知っている先（スペース・エージェント・開いているタブ）だけを窓の記録へ移す
			const openEditors = new Set(this.editorItems.map(item => item.kind === 'editor' ? item.key : undefined));
			const { moved, rest } = paradisSplitPaletteRecents(paradisParsePaletteRecents(shared), entry => entry.kind === 'agent' ? liveTokens.has(entry.key) : entry.kind === 'space' ? liveSpaces.has(entry.key) : openEditors.has(entry.key));
			recents = [...recents, ...moved.filter(entry => !recents.some(existing => existing.kind === entry.kind && existing.key === entry.key))];
			if (rest.length) {
				this.storageService.store(RECENT_STORAGE_KEY, JSON.stringify(rest), StorageScope.PROFILE, StorageTarget.MACHINE);
			} else {
				this.storageService.remove(RECENT_STORAGE_KEY, StorageScope.PROFILE);
			}
		}
		// 終わったエージェント（ペイントークンは使い回されない）と消えたスペースの記録は、ピンでも捨てる
		this.recents = paradisPrunePaletteRecents(recents, entry => entry.kind === 'agent' ? !liveTokens.has(entry.key) : entry.kind === 'space' ? !liveSpaces.has(entry.key) : false);
		this.storeRecents(this.recents);
		this.kindsVisible = ParadisPaletteKindsVisibleContext.bindTo(contextKeyService);

		this.picker = this._register(this.quickInputService.createQuickPick<ParadisCrossJumpItem>({ useSeparators: true }));
		this.picker.placeholder = localize('paradis.crossJump.placeholder', "エージェント・タブ・スペースを検索");
		this.picker.contextKey = CROSS_JUMP_CONTEXT_KEY;
		this.picker.matchOnDescription = true;
		// 並びと見出しを保つ（本家の既定は打った文字との一致の順に並べ替えて見出しを消す）
		this.picker.sortByLabel = false;
		// 接頭辞（`a ` など）は絞り込みの文字に含めない
		this.picker.filterValue = value => paradisParsePalettePrefix(value).rest;
	}

	/** 開いて、選ばれた行へ移るまで待つ。 */
	async run(): Promise<void> {
		this.render();
		this._register(this.picker.onDidChangeValue(() => this.render()));
		this._register(this.picker.onDidTriggerItemButton(event => this.onDidTriggerItemButton(event.item, event.button)));

		const picked = await new Promise<{ item: ParadisCrossJumpItem; side: boolean } | undefined>(resolve => {
			this._register(this.picker.onDidAccept(() => {
				const item = this.picker.activeItems[0];
				if (!item) {
					return;
				}
				resolve({ item, side: this.picker.keyMods.ctrlCmd });
				this.picker.hide();
			}));
			this._register(this.picker.onDidHide(() => resolve(undefined)));
			activeSession = this;
			this.picker.show();
			this.mountChrome();
		});
		if (activeSession === this) {
			activeSession = undefined;
		}
		this.dispose();
		if (picked) {
			await this.open(picked.item, picked.side);
		}
	}

	/** Tab（+1）・Shift+Tab（-1）。「コマンド」へ進んだらコマンドパレットへ切り替える。 */
	cycle(delta: 1 | -1): void {
		const prefix = paradisParsePalettePrefix(this.picker.value);
		const current = prefix.kind === 'agent' || prefix.kind === 'editor' || prefix.kind === 'space' ? prefix.kind : this.kind;
		const next = paradisCyclePaletteKind(current, delta);
		this.selectKind(next);
	}

	/** 入力が空のときの Ctrl+Backspace: 選んでいる行を閉じる・止める。 */
	runSecondary(): void {
		const item = this.picker.activeItems[0];
		if (item?.kind === 'editor') {
			void this.closeEditor(item);
		} else if (item?.kind === 'agent') {
			void this.stopAgent(item);
		}
	}

	private selectKind(kind: ParadisPaletteKind): void {
		if (kind === 'command') {
			this.switchTo('>');
			return;
		}
		this.kind = kind;
		// 接頭辞で選んでいた種類は、タブで替えたら外す（入力の残りはそのまま）
		const prefix = paradisParsePalettePrefix(this.picker.value);
		if (prefix.kind === 'agent' || prefix.kind === 'editor' || prefix.kind === 'space') {
			this.picker.value = prefix.rest;
		}
		this.render();
		const count = this.counts(paradisParsePalettePrefix(this.picker.value).rest)[kind];
		status(localize('paradis.palette.kindChanged', "{0}: {1} 件", paradisPaletteKindLabel(kind), count ?? 0));
	}

	/** ほかのクイックアクセスへ切り替える（コマンドパレット・ヘルプ・ファイル・文字の検索）。 */
	private switchTo(value: string): void {
		this.switching = true;
		this.quickInputService.quickAccess.show(value);
	}

	/** 種類のタブとヒントを器に足す。閉じたら外す。 */
	private mountChrome(): void {
		if (this.switching || !paradisIsCenteredQuickInput(this.picker)) {
			return;
		}
		const widget = paradisFindQuickInputWidget(this.layoutService.activeContainer);
		if (!widget) {
			return;
		}
		this.kindsBar = this._register(new ParadisPaletteKindsBar(widget, {
			onSelect: kind => this.selectKind(kind),
			onHelp: () => this.switchTo('?'),
		}));
		this._register(paradisAddPaletteHints(widget, [
			// allow-any-unicode-next-line
			localize('paradis.palette.hintKinds', "Tab 種類"),
			localize('paradis.palette.hintSide', "{0} 横に開く", this.keyLabel(KeyMod.CtrlCmd | KeyCode.Enter)),
		]));
		this._register(holdKindsVisible(this.kindsVisible));
		this.updateKinds();
	}

	private render(): void {
		const value = this.picker.value;
		this.inputEmpty.set(!value);
		const prefix = paradisParsePalettePrefix(value);
		if (prefix.kind === 'command') {
			this.switchTo(value);
			return;
		}
		if (prefix.kind === 'help') {
			this.switchTo('?');
			return;
		}
		const kind = prefix.kind ?? this.kind;
		const query = prefix.rest.trim();
		const show = (candidate: ParadisPaletteKind) => kind === 'all' || kind === candidate;
		const items: ParadisCrossJumpPickItem[] = [];

		if (!query && kind === 'all') {
			const recents = this.recentItems();
			if (recents.length) {
				items.push({ type: 'separator', label: localize('paradis.palette.recent', "最近・ピン") }, ...recents);
			}
			const actions = this.actionItems('');
			if (actions.length) {
				items.push({ type: 'separator', label: localize('paradis.palette.actions', "操作") }, ...actions);
			}
		}
		const agents = this.agentItems.filter(item => paradisPaletteMatches(query, item.label, item.description));
		if (show('agent') && this.agentItems.length) {
			const attention = agents.filter(item => item.kind === 'agent' && isAttention(item.entry.status)).length;
			const label = attention
				? localize('paradis.palette.agentsAttention', "エージェント {0}（要対応 {1}）", agents.length, attention)
				: localize('paradis.palette.agents', "エージェント {0}", agents.length);
			items.push({ type: 'separator', label }, ...this.agentItems);
		}
		const editors = this.editorItems.filter(item => paradisPaletteMatches(query, item.label, item.description));
		if (show('editor') && this.editorItems.length) {
			items.push({ type: 'separator', label: localize('paradis.palette.editors', "開いているタブ {0}", editors.length) }, ...this.editorItems);
		}
		if (query && kind === 'all') {
			const actions = this.actionItems(query);
			if (actions.length) {
				items.push({ type: 'separator', label: localize('paradis.palette.actions', "操作") }, ...actions);
			}
		}
		// 一致が無いときの逃げ道（作る・コマンド・ファイル名・中身）。一致は一覧と同じ関数で数える
		if (query && !this.anyMatch(query, kind)) {
			items.push({ type: 'separator', label: localize('paradis.palette.noMatch', "「{0}」に一致するものはありません", query) }, ...this.suggestionItems(query));
		}
		// スペースの見出し（ボタンを持つ区切り）は、次の見出しまでの行をすべて子として束ねるので、スペースは必ず最後に置く
		if (show('space')) {
			for (const group of paradisGroupPaletteSpaces(this.spaces.map((space, index) => ({ repositoryId: space.repositoryId, item: this.spaceItems[index] })))) {
				const children = group.items.map(entry => entry.item);
				const matched = children.filter(item => paradisPaletteMatches(query, item.label, item.description));
				const attention = matched.filter(item => item.kind === 'space' && isAttention(this.agentStatusStore.getScopeStatus(item.stateKey))).length;
				const working = matched.filter(item => item.kind === 'space' && this.agentStatusStore.getScopeStatus(item.stateKey) === 'working').length;
				const parts = [localize('paradis.palette.spaceCount', "{0} 件", matched.length)];
				if (attention) {
					parts.push(localize('paradis.palette.spaceAttention', "要対応 {0}", attention));
				}
				if (working) {
					parts.push(localize('paradis.palette.spaceWorking', "実行中 {0}", working));
				}
				// ボタン（空でも）を持つ区切りは、本家が左に名前と説明を出す見出しの行にし、下の行を子として束ねる
				items.push({ type: 'separator', label: `$(${Codicon.repo.id}) ${this.repositoryNames.get(group.repositoryId) ?? ''}`, description: parts.join(' · '), buttons: [] }, ...children);
			}
		}
		this.picker.items = items;
		this.updateKinds();
	}

	private anyMatch(query: string, kind: ParadisPaletteKind): boolean {
		const counts = this.counts(query);
		return (counts[kind] ?? 0) > 0 || (kind === 'all' && this.actionItems(query).length > 0);
	}

	private counts(query: string): Partial<Record<ParadisPaletteKind, number>> {
		const count = (list: readonly ParadisCrossJumpItem[]) => list.filter(item => paradisPaletteMatches(query, item.label, item.description)).length;
		const agent = count(this.agentItems);
		const editor = count(this.editorItems);
		const space = count(this.spaceItems);
		return { all: agent + editor + space, agent, editor, space };
	}

	private updateKinds(): void {
		if (!this.kindsBar) {
			return;
		}
		const prefix = paradisParsePalettePrefix(this.picker.value);
		const query = prefix.rest.trim();
		const attention = this.agentItems.filter(item => item.kind === 'agent' && isAttention(item.entry.status) && paradisPaletteMatches(query, item.label, item.description)).length;
		const selected = prefix.kind === 'agent' || prefix.kind === 'editor' || prefix.kind === 'space' ? prefix.kind : this.kind;
		this.kindsBar.update({ selected, counts: this.counts(query), attention });
	}

	// --- 行 --------------------------------------------------------------------------------------------------

	private agentItem(entry: IParadisAgentLiveEntry, id = `${ID_PREFIX}agent/${entry.token}`, description?: string): ParadisCrossJumpItem {
		return {
			kind: 'agent',
			entry,
			id,
			label: entry.title,
			description: description ?? [entry.spaceName, STATUS_LABELS[entry.status] ?? entry.status, paradisFormatCrossJumpAgo(this.now - entry.since)].join(' · '),
			iconClass: dotClass(entry.status),
			buttons: [this.button(Codicon.debugStop, localize('paradis.palette.stop', "止める（ターミナルを閉じる）"), KeyMod.CtrlCmd | KeyCode.Backspace)],
		};
	}

	private collectEditorItems(): ParadisCrossJumpItem[] {
		// エージェントの端末がエディタのタブになっているときは、上のエージェントの行と同じものなので外す。
		const agentTerminalResources = new Set<string>();
		for (const entry of this.agents) {
			const resource = this.terminalService.getInstanceFromId(entry.instanceId)?.resource;
			if (resource) {
				agentTerminalResources.add(resource.toString());
			}
		}
		const items: ParadisCrossJumpItem[] = [];
		this.editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).forEach((identifier, index) => {
			const resource = identifier.editor.resource;
			if (resource?.scheme === Schemas.vscodeTerminal && agentTerminalResources.has(resource.toString())) {
				return;
			}
			items.push(this.editorItem(identifier, `${ID_PREFIX}editor/${index}`));
		});
		return items;
	}

	private editorItem(identifier: IEditorIdentifier, id: string, description?: string): ParadisCrossJumpItem {
		// アイコンは「開いているエディターを表示」（editorQuickAccess.ts）と同じ組み立てにする。iconClasses は
		// 行のラベルの要素そのものに付くので、`codicon` の class を渡すとラベル全体が codicon のフォントで描かれ、
		// 文字が欠けてアイコンが縦にずれる（paracode-183〜185 の崩れ）。
		const icon = identifier.editor.getIcon();
		const iconResource = EditorResourceAccessor.getOriginalUri(identifier.editor, { supportSideBySide: SideBySideEditor.PRIMARY });
		return {
			kind: 'editor',
			identifier,
			key: identifier.editor.resource?.toString(),
			id,
			label: identifier.editor.getName(),
			description: description ?? identifier.editor.getDescription(),
			iconPath: URI.isUri(icon) ? { dark: icon } : undefined,
			iconClasses: getIconClasses(this.modelService, this.languageService, iconResource, undefined, icon).concat(identifier.editor.getLabelExtraClasses()),
			buttons: [
				this.button(Codicon.splitHorizontal, localize('paradis.palette.openSide', "横に開く"), KeyMod.CtrlCmd | KeyCode.Enter),
				this.button(Codicon.close, localize('paradis.palette.close', "閉じる"), KeyMod.CtrlCmd | KeyCode.Backspace),
			],
		};
	}

	private spaceItem(space: IParadisSpaceEntry, id = `${ID_PREFIX}space/${space.space}`, description?: string, label?: string): ParadisCrossJumpItem {
		const branch = space.kind === 'worktree' ? space.worktree?.branch : this.worktreeService.getRepositoryBranch(space.repositoryId);
		const scopeStatus = this.agentStatusStore.getScopeStatus(space.space);
		const current = space.space === this.activeStateKey ? localize('paradis.crossJump.currentSpace', "今のスペース") : undefined;
		// リポジトリの見出しの下では、worktree はブランチ名を先に（名前は agent-… の自動名が多い）、本体は「本体（ブランチ）」
		const childLabel = space.kind === 'worktree'
			? `$(${Codicon.gitBranch.id}) ${branch ?? space.worktree?.name ?? space.name}`
			: `$(${Codicon.repo.id}) ${branch ? localize('paradis.palette.repositoryBody', "本体（{0}）", branch) : localize('paradis.palette.repositoryBodyNoBranch', "本体")}`;
		const parts = space.kind === 'worktree' ? [space.worktree?.name, scopeStatus ? STATUS_LABELS[scopeStatus] : undefined, current] : [scopeStatus ? STATUS_LABELS[scopeStatus] : undefined, current];
		return {
			kind: 'space',
			stateKey: space.space,
			id,
			label: label ?? childLabel,
			description: description ?? (parts.filter((part): part is string => !!part).join(' · ') || undefined),
			iconClass: dotClass(scopeStatus),
		};
	}

	private recentItems(): ParadisCrossJumpItem[] {
		const kindNames = { agent: paradisPaletteKindLabel('agent'), editor: paradisPaletteKindLabel('editor'), space: paradisPaletteKindLabel('space') };
		const shown = paradisPaletteRecentsToShow(this.recents, entry => !!this.resolveRecent(entry));
		const items: ParadisCrossJumpItem[] = [];
		for (const recent of shown) {
			const resolved = this.resolveRecent(recent);
			if (!resolved) {
				continue;
			}
			const id = `${ID_PREFIX}recent/${recent.kind}/${recent.key}`;
			const description = [kindNames[recent.kind], paradisFormatCrossJumpAgo(this.now - recent.at)].join(' · ');
			const pin: IQuickInputButton = recent.pinned
				? { iconClass: ThemeIcon.asClassName(Codicon.pinned), tooltip: localize('paradis.palette.unpin', "ピンを外す"), alwaysVisible: true }
				: { iconClass: ThemeIcon.asClassName(Codicon.pin), tooltip: localize('paradis.palette.pin', "ピンを付ける") };
			let item: ParadisCrossJumpItem;
			if (resolved.kind === 'agent') {
				item = this.agentItem(resolved.entry, id, description);
			} else if (resolved.kind === 'editor') {
				item = this.editorItem(resolved.identifier, id, description);
			} else if (resolved.kind === 'space') {
				const space = this.spaces.find(candidate => candidate.space === resolved.stateKey);
				if (!space) {
					continue;
				}
				item = this.spaceItem(space, id, description, `$(${(space.kind === 'worktree' ? Codicon.gitBranch : Codicon.repo).id}) ${space.name}`);
			} else {
				continue;
			}
			items.push({ ...item, buttons: [...(item.buttons ?? []), pin] });
		}
		return items;
	}

	private resolveRecent(recent: IParadisPaletteRecent): ParadisCrossJumpItem | undefined {
		switch (recent.kind) {
			case 'agent': return this.agentItems.find(item => item.kind === 'agent' && item.entry.token === recent.key);
			case 'editor': return this.editorItems.find(item => item.kind === 'editor' && item.key === recent.key);
			case 'space': return this.spaceItems.find(item => item.kind === 'space' && item.stateKey === recent.key);
		}
	}

	private collectActions(): IParadisPaletteAction[] {
		const actions: IParadisPaletteAction[] = [];
		if (this.createRepositoryId) {
			const repositoryId = this.createRepositoryId;
			actions.push({
				id: 'createWorktree',
				label: localize('paradis.palette.action.createWorktree', "新しいスペース（ワークツリー）を作る..."),
				icon: Codicon.add,
				run: () => this.commandService.executeCommand(CREATE_WORKTREE_COMMAND_ID, repositoryId, { repositoryId }),
			});
		}
		actions.push({
			id: 'terminal',
			label: localize('paradis.palette.action.terminal', "ターミナルを開く"),
			icon: Codicon.terminal,
			commandId: TerminalCommandId.CreateTerminalEditorSameGroup,
			run: () => this.commandService.executeCommand(TerminalCommandId.CreateTerminalEditorSameGroup),
		});
		for (const agent of paradisTabLauncherAgents(this.modelCatalogService.getAgentTemplates())) {
			actions.push({
				id: `launch/${agent.id}`,
				label: localize('paradis.palette.action.launch', "{0} を起動", agent.label),
				icon: Codicon.robot,
				run: () => this.launchAgent(agent.id),
			});
		}
		actions.push({
			id: 'agentLiveWindow',
			label: localize('paradis.palette.action.agentLiveWindow', "エージェント一覧のウィンドウを開く"),
			icon: Codicon.window,
			run: () => this.agentLiveWindowService.open(),
		});
		return actions;
	}

	private actionItems(query: string): ParadisCrossJumpItem[] {
		return paradisPaletteActionsToShow(this.actions, query).map(action => ({
			kind: 'action',
			run: action.run,
			id: `${ID_PREFIX}action/${action.id}`,
			label: `$(${action.icon.id}) ${action.label}`,
			keybinding: action.commandId ? this.keybindingService.lookupKeybinding(action.commandId) : undefined,
		}));
	}

	private suggestionItems(query: string): ParadisCrossJumpItem[] {
		const items: ParadisCrossJumpItem[] = [];
		if (this.createRepositoryId) {
			items.push({
				kind: 'create',
				repositoryId: this.createRepositoryId,
				name: query,
				id: `${ID_PREFIX}suggest/create`,
				label: `$(${Codicon.add.id}) ${localize('paradis.crossJump.create', "ワークツリー「{0}」を作る", query)}`,
				alwaysShow: true,
			});
		}
		items.push(
			{ kind: 'switch', value: `>${query}`, id: `${ID_PREFIX}suggest/command`, label: `$(${Codicon.chevronRight.id}) ${localize('paradis.palette.suggestCommand', "コマンドで探す: >{0}", query)}`, alwaysShow: true },
			{ kind: 'switch', value: query, id: `${ID_PREFIX}suggest/file`, label: `$(${Codicon.file.id}) ${localize('paradis.palette.suggestFile', "ファイル名で探す: {0}", query)}`, alwaysShow: true },
			{ kind: 'switch', value: `%${query}`, id: `${ID_PREFIX}suggest/text`, label: `$(${Codicon.search.id}) ${localize('paradis.palette.suggestText', "ファイルの中身を探す: %{0}", query)}`, alwaysShow: true },
		);
		return items;
	}

	private button(icon: ThemeIcon, label: string, keybinding: number): IQuickInputButton {
		return { iconClass: ThemeIcon.asClassName(icon), tooltip: localize('paradis.palette.buttonTooltip', "{0} ({1})", label, this.keyLabel(keybinding)) };
	}

	/** キーの表示（Linux・Windows は Ctrl+Enter、macOS は ⌘ の記号）。 */
	private keyLabel(keybinding: number): string {
		const decoded = decodeKeybinding(keybinding, OS);
		return (decoded && this.keybindingService.resolveKeybinding(decoded)[0]?.getLabel()) ?? '';
	}

	// --- 操作 --------------------------------------------------------------------------------------------------

	private onDidTriggerItemButton(item: ParadisCrossJumpItem, button: IQuickInputButton): void {
		const icon = button.iconClass ?? '';
		if (icon === ThemeIcon.asClassName(Codicon.pin) || icon === ThemeIcon.asClassName(Codicon.pinned)) {
			const recentKey = item.kind === 'agent' ? item.entry.token : item.kind === 'editor' ? item.key : item.kind === 'space' ? item.stateKey : undefined;
			if (recentKey && (item.kind === 'agent' || item.kind === 'editor' || item.kind === 'space')) {
				this.storeRecents(paradisTogglePalettePin(this.recents, item.kind, recentKey, Date.now()));
				this.renderKeepingActive(item.id);
			}
		} else if (icon === ThemeIcon.asClassName(Codicon.splitHorizontal) && item.kind === 'editor') {
			this.picker.hide();
			void this.open(item, true);
		} else if (icon === ThemeIcon.asClassName(Codicon.close) && item.kind === 'editor') {
			void this.closeEditor(item);
		} else if (icon === ThemeIcon.asClassName(Codicon.debugStop) && item.kind === 'agent') {
			void this.stopAgent(item);
		}
	}

	private async closeEditor(item: ParadisCrossJumpItem & { kind: 'editor' }): Promise<void> {
		await this.editorService.closeEditor(item.identifier);
		// 保存の確認で取りやめたときは開いたまま残る
		const stillOpen = this.editorService.getEditors(EditorsOrder.SEQUENTIAL).some(identifier => identifier.editor === item.identifier.editor && identifier.groupId === item.identifier.groupId);
		if (!stillOpen && !this._store.isDisposed) {
			this.editorItems = this.editorItems.filter(candidate => candidate.kind !== 'editor' || candidate.identifier.editor !== item.identifier.editor);
			this.renderKeepingActive(undefined);
		}
	}

	private async stopAgent(item: ParadisCrossJumpItem & { kind: 'agent' }): Promise<void> {
		const instance = this.terminalService.getInstanceFromId(item.entry.instanceId);
		if (!instance) {
			return;
		}
		// 本家のターミナルを閉じる操作（プロセスが動いていれば本家の確認が出る）
		await this.terminalService.safeDisposeTerminal(instance);
		if (instance.isDisposed && !this._store.isDisposed) {
			this.agentItems = this.agentItems.filter(candidate => candidate.kind !== 'agent' || candidate.entry.token !== item.entry.token);
			this.renderKeepingActive(undefined);
		}
	}

	private renderKeepingActive(id: string | undefined): void {
		this.render();
		const active = id ? this.picker.items.find((candidate): candidate is ParadisCrossJumpItem => candidate.type !== 'separator' && candidate.id === id) : undefined;
		if (active) {
			this.picker.activeItems = [active];
		}
	}

	private storeRecents(recents: IParadisPaletteRecent[]): void {
		this.recents = recents;
		this.storageService.store(RECENT_STORAGE_KEY, JSON.stringify(recents), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private record(item: ParadisCrossJumpItem): void {
		const key = item.kind === 'agent' ? item.entry.token : item.kind === 'editor' ? item.key : item.kind === 'space' ? item.stateKey : undefined;
		if (key && (item.kind === 'agent' || item.kind === 'editor' || item.kind === 'space')) {
			this.storeRecents(paradisRecordPaletteRecent(this.recents, item.kind, key, Date.now()));
		}
	}

	private async launchAgent(agentId: string): Promise<void> {
		const agent = paradisTabLauncherAgents(this.modelCatalogService.getAgentTemplates()).find(candidate => candidate.id === agentId);
		if (!agent) {
			return;
		}
		const stored = paradisParseStoredLaunchChoices(this.storageService.get(PARADIS_AGENT_LAUNCH_OPTIONS_STORAGE_KEY, StorageScope.PROFILE));
		const choice = paradisNormalizeLaunchChoice(agent, paradisRestoreLaunchChoice(agent, stored[agent.id]));
		const rootUri = paradisTabLauncherRoot(this.workspaceSwitchService.activeStateKey, this.spaces, this.workspaceContextService.getWorkspace().folders[0]?.uri);
		if (!rootUri) {
			return;
		}
		try {
			await this.instantiationService.invokeFunction(paradisLaunchAgentInWorkspace, {
				rootUri,
				stateKey: this.workspaceSwitchService.activeStateKey,
				agentId: agent.id,
				modelId: choice.modelId,
				effortId: choice.effortId,
				permissionId: choice.permissionId,
			});
		} catch (error) {
			this.notificationService.error(localize('paradis.palette.launchFailed', "{0} を起動できませんでした: {1}", agent.label, toErrorMessage(error)));
		}
	}

	/** 選ばれた行へ移る。`side` は Ctrl+Enter（タブは横のグループに開く）。 */
	private async open(item: ParadisCrossJumpItem, side: boolean): Promise<void> {
		this.record(item);
		switch (item.kind) {
			case 'agent':
				await paradisRevealNotifiedPane({ hostService: this.hostService, terminalService: this.terminalService, workspaceSwitchService: this.workspaceSwitchService }, item.entry.stateKey, item.entry.instanceId);
				break;
			case 'editor':
				await this.editorService.openEditor(item.identifier.editor, { preserveFocus: false }, side ? SIDE_GROUP : item.identifier.groupId);
				break;
			case 'space':
				// UI からの切り替えなので連打は畳み込む（中間のスペースを経由しない）。
				await this.workspaceSwitchService.switchToStateKey(item.stateKey, { coalesce: true });
				break;
			case 'create':
				// 名前を入れた状態で作成のダイアログを開く（ベースブランチ・エージェントはダイアログで選ぶ）。
				await this.commandService.executeCommand(CREATE_WORKTREE_COMMAND_ID, item.repositoryId, { repositoryId: item.repositoryId, name: item.name });
				break;
			case 'action':
				await item.run();
				break;
			case 'switch':
				this.quickInputService.quickAccess.show(item.value);
				break;
		}
	}
}

/**
 * 種類のタブを出している印を立てる。横断ジャンプからコマンドパレットへ替わるときは、新しい方が印を立てた後に古い方が
 * 片付くので、数を数えて最後の 1 つが外れたときだけ下ろす。
 */
let kindsVisibleHolders = 0;
function holdKindsVisible(key: IContextKey<boolean>): IDisposable {
	kindsVisibleHolders++;
	key.set(true);
	let released = false;
	return {
		dispose: () => {
			if (!released) {
				released = true;
				if (--kindsVisibleHolders === 0) {
					key.set(false);
				}
			}
		}
	};
}

/** 器の下端のヒントに、パレットのキーを足す。dispose で外す。 */
function paradisAddPaletteHints(widget: HTMLElement, texts: readonly string[]): IDisposable {
	const hint = paradisEnsureQuickInputHint(widget);
	const added = texts.map(text => {
		const element = dom.append(hint, dom.$('span.paradis-palette-hint'));
		element.textContent = text;
		return element;
	});
	return { dispose: () => added.forEach(element => element.remove()) };
}

class ParadisCrossJumpAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_CROSS_JUMP_COMMAND_ID,
			title: localize2('paradis.crossJump.open', "エージェント・タブ・スペースへ移動..."),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, options?: { readonly kind?: ParadisPaletteKind }): Promise<void> {
		const instantiationService = accessor.get(IInstantiationService);
		const kind = options?.kind && ['all', 'agent', 'editor', 'space'].includes(options.kind) ? options.kind : 'all';
		await instantiationService.createInstance(ParadisCrossJumpSession, kind).run();
	}
}

registerAction2(ParadisCrossJumpAction);

/** Tab・Shift+Tab: 横断ジャンプでは種類を回し、コマンドパレットからは横断ジャンプへ戻る。 */
function cycleKind(accessor: ServicesAccessor, delta: 1 | -1): void {
	if (activeSession) {
		activeSession.cycle(delta);
		return;
	}
	if (accessor.get(IQuickInputService).currentQuickInput?.contextKey === COMMANDS_PICKER_CONTEXT_KEY) {
		void accessor.get(ICommandService).executeCommand(PARADIS_CROSS_JUMP_COMMAND_ID, { kind: paradisCyclePaletteKind('command', delta) });
	}
}

const paletteKindsWhen = ContextKeyExpr.and(
	ContextKeyExpr.has('inQuickInput'),
	InputFocusedContext,
	ParadisPaletteKindsVisibleContext,
	ContextKeyExpr.or(ContextKeyExpr.has(CROSS_JUMP_CONTEXT_KEY), ContextKeyExpr.has(COMMANDS_PICKER_CONTEXT_KEY)),
);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: NEXT_KIND_COMMAND_ID,
			title: localize2('paradis.palette.nextKind', "パレット: 次の種類"),
			keybinding: { primary: KeyCode.Tab, when: paletteKindsWhen, weight: KeybindingWeight.WorkbenchContrib + 50 },
		});
	}
	run(accessor: ServicesAccessor): void {
		cycleKind(accessor, 1);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PREVIOUS_KIND_COMMAND_ID,
			title: localize2('paradis.palette.previousKind', "パレット: 前の種類"),
			keybinding: { primary: KeyMod.Shift | KeyCode.Tab, when: paletteKindsWhen, weight: KeybindingWeight.WorkbenchContrib + 50 },
		});
	}
	run(accessor: ServicesAccessor): void {
		cycleKind(accessor, -1);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: SECONDARY_ACTION_COMMAND_ID,
			title: localize2('paradis.palette.secondaryAction', "パレット: 選んでいる行を閉じる・止める"),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.Backspace,
				when: ContextKeyExpr.and(ContextKeyExpr.has('inQuickInput'), ContextKeyExpr.has(CROSS_JUMP_CONTEXT_KEY), ParadisCrossJumpInputEmptyContext),
				weight: KeybindingWeight.WorkbenchContrib + 50,
			},
		});
	}
	run(): void {
		activeSession?.runSecondary();
	}
});

/**
 * コマンドパレット（`>`）にも同じ種類のタブを出す（「コマンド」を選んだ状態）。ほかのタブを押すか Tab で横断ジャンプへ
 * 戻る。Ctrl+P から `>` を打ったときは picker がそのままで contextKey だけが替わるので、入力が変わるたびに見直す。
 */
class ParadisPaletteCommandsKinds extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisPaletteCommandsKinds';

	private readonly mounted = this._register(new MutableDisposable<DisposableStore>());
	private readonly inputListener = this._register(new MutableDisposable());
	private readonly kindsVisible: IContextKey<boolean>;

	constructor(
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this.kindsVisible = ParadisPaletteKindsVisibleContext.bindTo(contextKeyService);
		this._register(this.quickInputService.onShow(() => {
			const input = this.quickInputService.currentQuickInput;
			this.inputListener.value = input?.type === QuickInputType.QuickPick ? (input as IQuickPick<IQuickPickItem>).onDidChangeValue(() => this.update()) : undefined;
			this.update();
		}));
		this._register(this.quickInputService.onHide(() => {
			this.inputListener.clear();
			this.mounted.clear();
		}));
	}

	private update(): void {
		const input = this.quickInputService.currentQuickInput;
		const wanted = !!input && input.contextKey === COMMANDS_PICKER_CONTEXT_KEY && paradisIsCenteredQuickInput(input);
		if (!wanted) {
			this.mounted.clear();
			return;
		}
		if (this.mounted.value) {
			return;
		}
		const widget = paradisFindQuickInputWidget(this.layoutService.activeContainer);
		if (!widget) {
			return;
		}
		const store = new DisposableStore();
		const bar = store.add(new ParadisPaletteKindsBar(widget, {
			onSelect: kind => {
				if (kind !== 'command') {
					void this.commandService.executeCommand(PARADIS_CROSS_JUMP_COMMAND_ID, { kind });
				}
			},
			onHelp: () => this.quickInputService.quickAccess.show('?'),
		}));
		bar.update({ selected: 'command', counts: {}, attention: 0 });
		// allow-any-unicode-next-line
		store.add(paradisAddPaletteHints(widget, [localize('paradis.palette.hintKinds', "Tab 種類")]));
		store.add(holdKindsVisible(this.kindsVisible));
		this.mounted.value = store;
	}
}

registerWorkbenchContribution2(ParadisPaletteCommandsKinds.ID, ParadisPaletteCommandsKinds, WorkbenchPhase.AfterRestored);
