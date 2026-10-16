/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルの履歴の一覧（Q372、案 A ＋ デザイン D1）。
//
// - 自分で文字を打った後の ↓ で、打った文字に前方一致する履歴の一覧をプロンプトの真下に開く
//   （下に入らなければ真上）。最新をプロンプトに接する側に置き、↓ で古い方へ、↑ で新しい方へ。
//   最新でさらに ↑ を押すと閉じて、打っていた文字に戻る
// - 入力が空のときと、シェルの ↑ で遡っている間の ↑↓ はシェルへ渡す（遡り中の ↓ で一覧を開かない。
//   判定は common/paradisTerminalHistoryNavigation.ts）
// - スペースごとの履歴を使っているターミナルでは、見出しのタブか Ctrl+S で「このスペース / 全スペース」を
//   切り替える。開くたびに「このスペース」から始める
// - Para Code で実行したコマンドを、スペースの履歴フォルダの隣に記録し、時刻・場所・終了コード・回数を出す
//
// upstream の terminal suggest には手を入れず、Ctrl+Space の補完としてそのまま残す。キーをシェルへ
// 流さずに受けるため、ここのコマンドだけ `DEFAULT_COMMANDS_TO_SKIP_SHELL` に並べてある
// （`workbench/contrib/terminal/common/terminal.ts` の PARA-PATCH）。

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { raceTimeout } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { localize, localize2 } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ICommandDetectionCapability, ITerminalCommand, TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { IPromptInputModel } from '../../../../platform/terminal/common/capabilities/commandDetection/promptInputModel.js';
import { PosixShellType } from '../../../../platform/terminal/common/terminal.js';
import { ITerminalContribution, ITerminalInstance, IXtermTerminal } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { registerActiveInstanceAction } from '../../../../workbench/contrib/terminal/browser/terminalActions.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../../workbench/contrib/terminal/browser/terminalExtensions.js';
import { TerminalContextKeys } from '../../../../workbench/contrib/terminal/common/terminalContextKey.js';
import { paradisTerminalHistoryProvider } from '../../terminalHistorySuggest/browser/paradisTerminalHistoryCompletion.contribution.js';
import { paradisIsSpaceHistoryId, paradisSpaceHistoryDirectoryOf, paradisSpaceHistoryRoot } from '../../terminalSpaceHistory/common/paradisTerminalSpaceHistory.js';
import { IParadisCommandRecord, paradisShouldRecordCommand } from '../common/paradisTerminalCommandRecords.js';
import { PARADIS_EXTERNAL_PROMPT_CHANGE_MS, ParadisHistoryNavigationTracker, paradisPromptTextWithoutGhost } from '../common/paradisTerminalHistoryNavigation.js';
import { IParadisHistoryPanelItem, paradisFilterHistory, paradisMergeHistory, paradisMoveHistorySelection, paradisPlaceHistoryPanel } from '../common/paradisTerminalHistoryPanelModel.js';
import { ParadisTypedPrefixTracker, paradisPromptTextAfterCursor } from '../common/paradisTerminalTypedPrefix.js';
import { IParadisTerminalCommandRecordService } from './paradisTerminalCommandRecordService.js';
import { PARADIS_HISTORY_PANEL_CHROME_HEIGHT, PARADIS_HISTORY_PANEL_ROW_HEIGHT, ParadisHistoryPanelScope, ParadisTerminalHistoryPanelWidget } from './paradisTerminalHistoryPanelWidget.js';

/** ↓ で履歴の一覧を開くか。 */
export const PARADIS_TERMINAL_HISTORY_PANEL_ENABLED = 'paradis.terminal.historyPanel.enabled';

/** 一覧に一度に出す行の最大。 */
const MAX_VISIBLE_ROWS = 10;

const paradisHistoryPanelCanOpen = new RawContextKey<boolean>('para.terminalHistoryPanelCanOpen', false, localize('para.terminalHistoryPanelCanOpen', "Whether Down opens the command history panel in the terminal (Para Code)"));
const paradisHistoryPanelVisible = new RawContextKey<boolean>('para.terminalHistoryPanelVisible', false, localize('para.terminalHistoryPanelVisible', "Whether the command history panel is open in the terminal (Para Code)"));

/** このファイルのコマンド。キーをシェルへ流さないよう、すべて skip-shell の一覧に並べてある。 */
export const enum ParadisTerminalHistoryPanelCommandId {
	Open = 'paradis.terminal.historyPanel.open',
	SelectOlder = 'paradis.terminal.historyPanel.selectOlder',
	SelectNewer = 'paradis.terminal.historyPanel.selectNewer',
	Run = 'paradis.terminal.historyPanel.run',
	Insert = 'paradis.terminal.historyPanel.insert',
	Close = 'paradis.terminal.historyPanel.close',
	ToggleScope = 'paradis.terminal.historyPanel.toggleScope',
}

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis.terminal',
	order: 100,
	type: 'object',
	title: localize('paradis.terminal.title', "Para Code Terminal"),
	properties: {
		[PARADIS_TERMINAL_HISTORY_PANEL_ENABLED]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.terminal.historyPanel.enabled', "ターミナルで文字を打った後に ↓ キーを押すと、打った文字で始まる履歴の一覧を出します。何も打っていないときと、↑ キーで履歴を遡っている間の ↑↓ はシェルの履歴のままです。\n\n一覧に時刻・場所・終了コード・回数を出すため、Para Code で実行したコマンドを本人だけが読めるファイルに記録します。シェルの履歴に残さない設定（`HISTIGNORE`・`HISTORY_IGNORE`・`zshaddhistory` など）は見ないので、そうしたコマンドも記録に残ります。残したくないコマンドは先頭に空白を入れて実行してください。"),
		},
	},
});

/** 読み込んだ履歴（範囲ごと、打った文字で絞る前）。 */
interface IHistoryData {
	readonly space: readonly IParadisHistoryPanelItem[] | undefined;
	readonly all: readonly IParadisHistoryPanelItem[] | undefined;
}

/** 開いている一覧 1 つ分。閉じると破棄する。 */
class OpenPanel extends Disposable {
	readonly cts = this._register(new CancellationTokenSource());
	readonly store = this._register(new DisposableStore());
	data: IHistoryData = { space: undefined, all: undefined };
	loading = true;
	scope: ParadisHistoryPanelScope | undefined;
	typed: string;
	items: readonly IParadisHistoryPanelItem[] = [];
	selectedIndex = 0;
	home: string | undefined;
	/** 選んだ履歴を、打った文字がシェルに出るのを待ってから入れようとしている。 */
	accepting = false;
	/** 見出しとキーの帯の高さ（px、前に描いたときの値）。 */
	chromeHeight = PARADIS_HISTORY_PANEL_CHROME_HEIGHT;

	constructor(readonly widget: ParadisTerminalHistoryPanelWidget, typed: string, scope: ParadisHistoryPanelScope | undefined) {
		super();
		this._register(widget);
		this._register(toDisposable(() => this.cts.cancel()));
		this.typed = typed;
		this.scope = scope;
	}
}

export class ParadisTerminalHistoryPanelContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'para.terminalHistoryPanel';

	static get(instance: ITerminalInstance): ParadisTerminalHistoryPanelContribution | null {
		return instance.getContribution<ParadisTerminalHistoryPanelContribution>(ParadisTerminalHistoryPanelContribution.ID);
	}

	private readonly _canOpenKey: IContextKey<boolean>;
	private readonly _visibleKey: IContextKey<boolean>;
	private readonly _commandDetectionListeners = this._register(new MutableDisposable<DisposableStore>());
	private readonly _panel = this._register(new MutableDisposable<OpenPanel>());
	private _commandDetection: ICommandDetectionCapability | undefined;
	private _xterm: RawXtermTerminal | undefined;
	private readonly _navigation = new ParadisHistoryNavigationTracker();
	/** 前方一致に使う「自分で打った文字」（入力行の value にはプロンプトの表示や薄い文字が混ざりうる）。 */
	private readonly _typedPrefix = new ParadisTypedPrefixTracker();

	constructor(
		private readonly _ctx: ITerminalContributionContext,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IParadisTerminalCommandRecordService private readonly _recordService: IParadisTerminalCommandRecordService,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._canOpenKey = paradisHistoryPanelCanOpen.bindTo(contextKeyService);
		this._visibleKey = paradisHistoryPanelVisible.bindTo(contextKeyService);

		const capabilities = _ctx.instance.capabilities;
		this._register(capabilities.onDidAddCommandDetectionCapability(e => this._attachCommandDetection(e)));
		this._register(capabilities.onDidRemoveCommandDetectionCapability(() => {
			this._commandDetectionListeners.clear();
			this._commandDetection = undefined;
			this._close(false);
			this._updateCanOpen();
		}));
		const commandDetection = capabilities.get(TerminalCapability.CommandDetection);
		if (commandDetection) {
			this._attachCommandDetection(commandDetection);
		}
		this._register(_ctx.instance.onDidBlur(() => this._close(false)));
		this._register(_ctx.instance.onDimensionsChanged(() => this._renderPanel()));
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_TERMINAL_HISTORY_PANEL_ENABLED)) {
				this._close(false);
				this._updateCanOpen();
			}
		}));
	}

	xtermReady(xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
		this._xterm = xterm.raw;
		this._register(xterm.raw.onData(data => {
			const model = this._commandDetection?.promptInputModel;
			const now = Date.now();
			this._navigation.input(data, model ? paradisPromptTextWithoutGhost(model) : '', now);
			this._typedPrefix.input(data, now);
			this._updateCanOpen();
		}));
		this._register(xterm.raw.onScroll(() => this._close(false)));
	}

	private _attachCommandDetection(commandDetection: ICommandDetectionCapability): void {
		this._commandDetection = commandDetection;
		const store = new DisposableStore();
		const model = commandDetection.promptInputModel;
		const onPromptChanged = () => {
			const now = Date.now();
			this._navigation.prompt(paradisPromptTextWithoutGhost(model), now);
			this._typedPrefix.prompt(model, now);
			this._updateCanOpen();
			this._refilter();
		};
		store.add(model.onDidStartInput(() => {
			this._typedPrefix.promptStarted();
			onPromptChanged();
		}));
		store.add(model.onDidChangeInput(onPromptChanged));
		store.add(model.onDidFinishInput(onPromptChanged));
		store.add(commandDetection.onCommandExecuted(() => {
			this._navigation.reset();
			this._typedPrefix.commandExecuted();
			this._close(false);
			this._updateCanOpen();
		}));
		store.add(commandDetection.onCommandFinished(command => {
			this._navigation.reset();
			this._typedPrefix.commandFinished();
			this._updateCanOpen();
			this._recordCommand(command);
		}));
		this._commandDetectionListeners.value = store;
		// つなぎ直したターミナルは次のプロンプトの印を待たず、今の入力行から始める。
		this._typedPrefix.prompt(model, Date.now());
		this._updateCanOpen();
	}

	private _isEnabled(): boolean {
		return this._configurationService.getValue(PARADIS_TERMINAL_HISTORY_PANEL_ENABLED) !== false;
	}

	private _updateCanOpen(): void {
		const commandDetection = this._commandDetection;
		this._canOpenKey.set(this._isEnabled()
			&& commandDetection !== undefined
			&& this._typedText(commandDetection.promptInputModel) !== undefined
			&& this._navigation.canOpen(commandDetection.promptInputModel, commandDetection.executingCommand, false));
	}

	/**
	 * 前方一致に使う文字（プロンプトの終わりからカーソルまで、ゴースト文字を除く）。確かめられない・
	 * 空白だけのときは undefined（一覧は開かない）。
	 */
	private _typedText(model: IPromptInputModel): string | undefined {
		const typed = this._typedPrefix.resolve(model, Date.now());
		return typed !== undefined && typed.trim().length > 0 ? typed : undefined;
	}

	/**
	 * Para Code で実行したコマンドを、スペースの履歴フォルダの隣に記録する。フォルダを持たない
	 * ターミナルは共通の記録へ。
	 */
	private _recordCommand(command: ITerminalCommand): void {
		if (command.wasReplayed || !paradisShouldRecordCommand(command.command)) {
			return;
		}
		const directory = paradisSpaceHistoryDirectoryOf(this._ctx.instance);
		const record: IParadisCommandRecord = {
			command: command.command.trimEnd(),
			cwd: command.cwd,
			exitCode: command.exitCode,
			timestamp: command.timestamp,
			duration: command.duration,
		};
		this._recordService.record(directory, record);
	}

	// #region open / close

	open(): void {
		const xterm = this._xterm;
		const model = this._commandDetection?.promptInputModel;
		if (!xterm?.element || !model || !this._isEnabled()) {
			return;
		}
		// ↓ を押した時点の入力行で確かめ直す（シェルの描き直しが遅れて届いた場合）。開けなければ ↓ は
		// シェルのもの（このキーはシェルへ流れない設定なので、ここで渡す）。
		const typed = this._typedText(model);
		if (typed === undefined || !this._navigation.canOpen(model, this._commandDetection?.executingCommand, false)) {
			this._forwardDown(xterm, model);
			return;
		}
		const directory = paradisSpaceHistoryDirectoryOf(this._ctx.instance);
		const widget = this._instantiationService.createInstance(ParadisTerminalHistoryPanelWidget, xterm.element);
		const panel = new OpenPanel(widget, typed, directory !== undefined && this._spaceHistoryShell() !== undefined ? 'space' : undefined);
		panel.store.add(widget.onDidSelectItem(index => {
			panel.selectedIndex = index;
			this._renderPanel();
		}));
		panel.store.add(widget.onDidRunItem(index => {
			panel.selectedIndex = index;
			this.accept(true);
		}));
		panel.store.add(widget.onDidChangeScope(scope => this._setScope(scope)));
		this._panel.value = panel;
		this._visibleKey.set(true);
		this._renderPanel();
		void this._load(panel, directory);
	}

	private _forwardDown(xterm: RawXtermTerminal, model: IPromptInputModel): void {
		const down = xterm.modes.applicationCursorKeysMode ? '\x1bOB' : '\x1b[B';
		const now = Date.now();
		this._navigation.input(down, paradisPromptTextWithoutGhost(model), now);
		this._typedPrefix.input(down, now);
		this._updateCanOpen();
		void this._ctx.instance.sendText(down, false);
	}

	private _close(restore: boolean): void {
		if (!this._panel.value) {
			return;
		}
		this._panel.clear();
		this._visibleKey.set(false);
		if (restore) {
			// 一覧は入力行を書き換えないので、戻すものは無い（打っていた文字のまま）。
			this._ctx.instance.focus();
		}
	}

	close(): void {
		this._close(true);
	}

	// #endregion

	// #region keys

	select(direction: 'older' | 'newer'): void {
		const panel = this._panel.value;
		if (!panel) {
			return;
		}
		const move = paradisMoveHistorySelection(panel.selectedIndex, panel.items.length, direction);
		if (move.kind === 'close') {
			this._close(true);
			return;
		}
		panel.selectedIndex = move.index;
		this._renderPanel();
	}

	toggleScope(): void {
		const panel = this._panel.value;
		if (panel?.scope !== undefined) {
			this._setScope(panel.scope === 'space' ? 'all' : 'space');
		}
	}

	private _setScope(scope: ParadisHistoryPanelScope): void {
		const panel = this._panel.value;
		if (!panel || panel.scope === undefined || panel.scope === scope) {
			return;
		}
		panel.scope = scope;
		panel.selectedIndex = 0;
		this._applyFilter(panel);
		this._renderPanel();
	}

	/**
	 * 選んだ履歴を入力行へ入れる。`run` なら続けて実行する。入力行の今の文字（ゴースト文字を除く）を
	 * 消してから書く。打った文字で始まる履歴なら、足りない分だけを書く。
	 */
	accept(run: boolean): void {
		const panel = this._panel.value;
		const model = this._commandDetection?.promptInputModel;
		const item = panel?.items[panel.selectedIndex];
		if (!panel || !model || !item) {
			this._close(true);
			return;
		}
		if (panel.accepting) {
			// 前に押した分を待っている（もう一度押しても、打ちかけの行を実行しない）。
			return;
		}
		if (this._typedPrefix.resolve(model, Date.now()) === undefined) {
			// 一覧を開いた後に打った文字が、まだシェルに出ていない。出てから入れる。
			panel.accepting = true;
			void this._acceptWhenShown(panel, model, item, run);
			return;
		}
		this._write(model, item, run);
	}

	private async _acceptWhenShown(panel: OpenPanel, model: IPromptInputModel, item: IParadisHistoryPanelItem, run: boolean): Promise<void> {
		const deadline = Date.now() + PARADIS_EXTERNAL_PROMPT_CHANGE_MS;
		while (this._typedPrefix.resolve(model, Date.now()) === undefined && Date.now() < deadline && !panel.cts.token.isCancellationRequested) {
			const changed = Event.toPromise(model.onDidChangeInput, panel.store);
			await raceTimeout(changed, deadline - Date.now(), () => changed.cancel());
		}
		if (this._panel.value === panel) {
			this._write(model, item, run);
		}
	}

	private _write(model: IPromptInputModel, item: IParadisHistoryPanelItem, run: boolean): void {
		const typed = this._typedPrefix.resolve(model, Date.now());
		if (typed === undefined) {
			this._close(true);
			return;
		}
		// キーから組み立てた文字のままなら、カーソルは打った文字の末尾にあり、その後ろの表示（薄い文字・
		// 右プロンプト）は入力ではない。
		const suffix = this._typedPrefix.cursorAtEndOfTyped(model) ? '' : paradisPromptTextAfterCursor(model);
		const prefix = typed.trimStart();
		let edit: string;
		let text: string;
		let line: string;
		if (suffix.length === 0 && item.command.startsWith(prefix)) {
			edit = '';
			text = item.command.substring(prefix.length);
			line = typed + text;
		} else {
			edit = '\x1b[3~'.repeat(suffix.length) + '\x7f'.repeat(typed.length);
			text = item.command;
			line = item.command;
		}
		this._close(false);
		const now = Date.now();
		this._navigation.wrote(now);
		this._typedPrefix.wrote(line, now);
		this._updateCanOpen();
		const instance = this._ctx.instance;
		void (async () => {
			if (edit.length > 0) {
				await instance.sendText(edit, false);
			}
			// 複数行のコマンドは貼り付けとして送り、途中の改行で実行されないようにする。
			await instance.sendText(text, run, text.includes('\n'));
		})();
		instance.focus();
	}

	// #endregion

	// #region data

	/**
	 * スペースごとの履歴ファイルを持つシェル（zsh・bash）。fish の履歴は fish のデータフォルダに、
	 * PowerShell の履歴は PSReadLine の場所にあり、スペースの履歴フォルダからは読めない。
	 */
	private _spaceHistoryShell(): PosixShellType.Zsh | PosixShellType.Bash | undefined {
		const shellType = this._ctx.instance.shellType;
		return shellType === PosixShellType.Zsh || shellType === PosixShellType.Bash ? shellType : undefined;
	}

	private async _load(panel: OpenPanel, directory: string | undefined): Promise<void> {
		const token = panel.cts.token;
		const provider = paradisTerminalHistoryProvider();
		try {
			const [sources, spaceRecords, home] = await Promise.all([
				provider?.getHistorySources(this._ctx.instance, token),
				this._recordService.read(directory, token),
				provider?.home(token),
			]);
			if (token.isCancellationRequested) {
				return;
			}
			panel.home = home;
			const persisted = sources?.persisted ?? [];
			const shellFile = sources?.shellFile ?? [];
			if (panel.scope === undefined || directory === undefined) {
				// スペースの切り替えが無い（スペースごとの履歴を使っていない、または fish・PowerShell）。
				// 記録（スペースの履歴フォルダが無ければ共通の記録）を先に、その後ろに全ターミナル共通の
				// 履歴とシェルの履歴ファイル。
				panel.data = { ...panel.data, all: paradisMergeHistory(spaceRecords, [persisted, shellFile]) };
				panel.loading = false;
				this._applyFilter(panel);
				this._renderPanel();
				return;
			}
			panel.data = { ...panel.data, space: paradisMergeHistory(spaceRecords, [sources?.space ?? []]) };
			this._applyFilter(panel);
			this._renderPanel();
			const others = await this._loadOtherSpaces(directory, token);
			if (token.isCancellationRequested) {
				return;
			}
			panel.data = {
				...panel.data,
				all: paradisMergeHistory(spaceRecords.concat(others.records), [sources?.space ?? [], ...others.lists, persisted, shellFile]),
			};
			panel.loading = false;
			this._applyFilter(panel);
			this._renderPanel();
		} catch (error) {
			this._logService.trace('[paradisTerminalHistoryPanel] could not load the history', error);
			panel.loading = false;
			this._renderPanel();
		}
	}

	/**
	 * ほかのスペースの記録と履歴ファイル（最後に書かれたものから順に）と、スペースの履歴フォルダを
	 * 持たないターミナルの共通の記録。
	 */
	private async _loadOtherSpaces(directory: string, token: CancellationToken): Promise<{ readonly records: readonly IParadisCommandRecord[]; readonly lists: readonly (readonly string[])[] }> {
		const provider = paradisTerminalHistoryProvider();
		const root = paradisSpaceHistoryRoot();
		const rootResource = root === undefined ? undefined : await provider?.toResource(root, token);
		const common = await this._recordService.read(undefined, token);
		if (!provider || root === undefined || rootResource === undefined || token.isCancellationRequested) {
			return { records: common, lists: [] };
		}
		let children: { readonly name: string; readonly mtime: number }[] = [];
		try {
			const stat = await this._fileService.resolve(rootResource, { resolveMetadata: true });
			children = (stat.children ?? [])
				.filter(child => child.isDirectory && paradisIsSpaceHistoryId(child.name))
				.map(child => ({ name: child.name, mtime: child.mtime }))
				.sort((a, b) => b.mtime - a.mtime);
		} catch {
			return { records: common, lists: [] };
		}
		const shell = this._spaceHistoryShell();
		const own = directory.replace(/[\\/]+$/, '');
		const results = await Promise.all(children.map(async child => {
			const shellPath = `${root.replace(/[\\/]+$/, '')}/${child.name}`;
			if (shellPath === own) {
				return undefined;
			}
			const [records, list] = await Promise.all([
				this._recordService.read(shellPath, token),
				shell !== undefined ? provider.readHistoryFile(`${shellPath}/${shell}_history`, shell, token) : Promise.resolve(undefined),
			]);
			return { records, list: list ?? [] };
		}));
		const records: IParadisCommandRecord[] = [...common];
		const lists: (readonly string[])[] = [];
		for (const result of results) {
			if (result) {
				records.push(...result.records);
				lists.push(result.list);
			}
		}
		return { records, lists };
	}

	/** 打った文字で絞り直す。 */
	private _refilter(): void {
		const panel = this._panel.value;
		const model = this._commandDetection?.promptInputModel;
		if (!panel || !model) {
			return;
		}
		const typed = this._typedPrefix.resolve(model, Date.now());
		if (typed === undefined) {
			// シェルの表示が追いつく前・確かめられない間は今の絞り込みのまま（選んだときに確かめ直す）。
			return;
		}
		if (typed.trim().length === 0) {
			this._close(false);
			return;
		}
		if (typed === panel.typed) {
			return;
		}
		panel.typed = typed;
		panel.selectedIndex = 0;
		this._applyFilter(panel);
		this._renderPanel();
	}

	private _applyFilter(panel: OpenPanel): void {
		const source = panel.scope === 'space' ? panel.data.space : panel.data.all;
		panel.items = paradisFilterHistory(source ?? [], panel.typed);
		panel.selectedIndex = Math.min(panel.selectedIndex, Math.max(0, panel.items.length - 1));
	}

	// #endregion

	// #region layout

	private _renderPanel(): void {
		const panel = this._panel.value;
		const xterm = this._xterm;
		const element = xterm?.element;
		// eslint-disable-next-line no-restricted-syntax
		const screen = element?.querySelector<HTMLElement>('.xterm-screen');
		if (!panel || !xterm || !element || !screen || xterm.rows === 0) {
			return;
		}
		const cellHeight = screen.clientHeight / xterm.rows;
		const cursorY = xterm.buffer.active.cursorY;
		const screenTop = screen.offsetTop;
		const lineTop = screenTop + cursorY * cellHeight;
		const lineBottom = lineTop + cellHeight;
		const width = Math.max(360, Math.min(760, screen.clientWidth - 16));
		panel.widget.setWidth(width);
		const scope = panel.scope;
		const render = (chromeHeight: number) => {
			const available = (pixels: number) => Math.floor((pixels - chromeHeight - 4) / PARADIS_HISTORY_PANEL_ROW_HEIGHT);
			const rowsBelow = available(screenTop + screen.clientHeight - lineBottom);
			const rowsAbove = available(lineTop - screenTop);
			const placement = paradisPlaceHistoryPanel(rowsBelow, rowsAbove, Math.min(MAX_VISIBLE_ROWS, Math.max(1, panel.items.length)));
			panel.widget.render({
				items: panel.items,
				selectedIndex: panel.selectedIndex,
				scope,
				counts: {
					space: panel.data.space === undefined ? undefined : paradisFilterHistory(panel.data.space, panel.typed).length,
					all: panel.data.all === undefined ? undefined : paradisFilterHistory(panel.data.all, panel.typed).length,
				},
				typed: panel.typed,
				loading: panel.loading && (scope === 'space' ? panel.data.space : panel.data.all) === undefined,
				placement,
				home: panel.home,
			});
			return placement;
		};
		// 見出しとキーの帯は幅が狭いと折り返すので、描いた後の高さで行数を数え直す。
		let placement = render(panel.chromeHeight);
		const chromeHeight = panel.widget.chromeHeight();
		if (chromeHeight !== panel.chromeHeight) {
			panel.chromeHeight = chromeHeight;
			placement = render(chromeHeight);
		}
		const height = panel.widget.element.offsetHeight;
		const top = placement.place === 'below' ? lineBottom + 2 : Math.max(0, lineTop - height - 2);
		panel.widget.setPosition(top, screen.offsetLeft + 4);
	}

	// #endregion
}

registerTerminalContribution(ParadisTerminalHistoryPanelContribution.ID, ParadisTerminalHistoryPanelContribution);

// #region commands

const panelVisible = ContextKeyExpr.and(TerminalContextKeys.focus, paradisHistoryPanelVisible);

registerActiveInstanceAction({
	id: ParadisTerminalHistoryPanelCommandId.Open,
	title: localize2('paradis.terminal.historyPanel.open', "履歴の一覧を開く"),
	f1: false,
	keybinding: {
		primary: KeyCode.DownArrow,
		weight: KeybindingWeight.WorkbenchContrib + 1,
		when: ContextKeyExpr.and(
			TerminalContextKeys.focus,
			paradisHistoryPanelCanOpen,
			paradisHistoryPanelVisible.negate(),
			TerminalContextKeys.suggestWidgetVisible.negate(),
			TerminalContextKeys.altBufferActive.negate(),
			TerminalContextKeys.terminalShellIntegrationEnabled,
			EditorContextKeys.isComposing.negate(),
			ContextKeyExpr.equals(`config.${PARADIS_TERMINAL_HISTORY_PANEL_ENABLED}`, true),
		),
	},
	run: instance => ParadisTerminalHistoryPanelContribution.get(instance)?.open(),
});

registerActiveInstanceAction({
	id: ParadisTerminalHistoryPanelCommandId.SelectOlder,
	title: localize2('paradis.terminal.historyPanel.selectOlder', "履歴の一覧で古い方へ"),
	f1: false,
	keybinding: {
		primary: KeyCode.DownArrow,
		secondary: [KeyMod.CtrlCmd | KeyCode.KeyR],
		mac: { primary: KeyCode.DownArrow, secondary: [KeyMod.WinCtrl | KeyCode.KeyR] },
		weight: KeybindingWeight.WorkbenchContrib + 3,
		when: panelVisible,
	},
	run: instance => ParadisTerminalHistoryPanelContribution.get(instance)?.select('older'),
});

registerActiveInstanceAction({
	id: ParadisTerminalHistoryPanelCommandId.SelectNewer,
	title: localize2('paradis.terminal.historyPanel.selectNewer', "履歴の一覧で新しい方へ"),
	f1: false,
	keybinding: {
		primary: KeyCode.UpArrow,
		weight: KeybindingWeight.WorkbenchContrib + 3,
		when: panelVisible,
	},
	run: instance => ParadisTerminalHistoryPanelContribution.get(instance)?.select('newer'),
});

registerActiveInstanceAction({
	id: ParadisTerminalHistoryPanelCommandId.Run,
	title: localize2('paradis.terminal.historyPanel.run', "選んだ履歴を実行"),
	f1: false,
	keybinding: {
		primary: KeyCode.Enter,
		weight: KeybindingWeight.WorkbenchContrib + 3,
		when: panelVisible,
	},
	run: instance => ParadisTerminalHistoryPanelContribution.get(instance)?.accept(true),
});

registerActiveInstanceAction({
	id: ParadisTerminalHistoryPanelCommandId.Insert,
	title: localize2('paradis.terminal.historyPanel.insert', "選んだ履歴を入力行へ入れる"),
	f1: false,
	keybinding: {
		primary: KeyCode.Tab,
		secondary: [KeyCode.RightArrow],
		weight: KeybindingWeight.WorkbenchContrib + 3,
		when: panelVisible,
	},
	run: instance => ParadisTerminalHistoryPanelContribution.get(instance)?.accept(false),
});

registerActiveInstanceAction({
	id: ParadisTerminalHistoryPanelCommandId.Close,
	title: localize2('paradis.terminal.historyPanel.close', "履歴の一覧を閉じる"),
	f1: false,
	keybinding: {
		primary: KeyCode.Escape,
		weight: KeybindingWeight.WorkbenchContrib + 3,
		when: panelVisible,
	},
	run: instance => ParadisTerminalHistoryPanelContribution.get(instance)?.close(),
});

registerActiveInstanceAction({
	id: ParadisTerminalHistoryPanelCommandId.ToggleScope,
	title: localize2('paradis.terminal.historyPanel.toggleScope', "履歴の一覧でこのスペースと全スペースを切り替える"),
	f1: false,
	keybinding: {
		primary: KeyMod.CtrlCmd | KeyCode.KeyS,
		mac: { primary: KeyMod.WinCtrl | KeyCode.KeyS },
		weight: KeybindingWeight.WorkbenchContrib + 3,
		when: panelVisible,
	},
	run: instance => ParadisTerminalHistoryPanelContribution.get(instance)?.toggleScope(),
});

// #endregion
