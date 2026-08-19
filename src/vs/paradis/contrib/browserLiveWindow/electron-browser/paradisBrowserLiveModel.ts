/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { GroupsOrder, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IParadisAgentBrowserBindingModel, ParadisPaneAgentKind } from '../../agentBrowser/electron-browser/paradisAgentBrowserBindingModel.js';
import { IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisBrowserLiveEntry, IParadisBrowserLiveSummary, paradisSummarizeBrowserLiveEntries } from '../common/paradisBrowserLiveWindow.js';

/** 変化の検出を挟むための待ち時間 (ms)。連続する変更をまとめて1回の再計算にする。 */
const RECOMPUTE_DELAY = 80;

function agentLabel(kind: ParadisPaneAgentKind): string {
	switch (kind) {
		case 'claude':
			return 'Claude';
		case 'codex':
			return 'Codex';
		case 'shell':
		default:
			// allow-any-unicode-next-line
			return localize('paradis.browserLive.agent.shell', "ターミナル");
	}
}

/**
 * ブラウザ一覧に出すエントリの供給元。
 *
 * 材料は3つ。
 * - いまのスペースで開いている内蔵ブラウザ …… {@link IBrowserViewWorkbenchService}
 * - 各ページの状態 (タイトル・URL・favicon・読み込み中・表示中か) …… ビューのモデル
 * - どのページをどのエージェントが共有しているか …… {@link IParadisAgentBrowserBindingModel}
 *
 * ウィンドウを開いていない間もタイトルバーのバッジのために動き続けるので、集計は
 * イベント駆動 + 署名比較にして、変化がないときは何も通知しない。
 */
export class ParadisBrowserLiveModel extends Disposable {

	private readonly _onDidChangeEntries = this._register(new Emitter<void>());
	readonly onDidChangeEntries = this._onDidChangeEntries.event;

	/** viewId ごとの購読 (入力とモデルの変化)。ビューの増減に合わせて張り替える。 */
	private readonly viewSubscriptions = this._register(new DisposableMap<string, DisposableStore>());
	private readonly recomputeScheduler: RunOnceScheduler;

	private _entries: readonly IParadisBrowserLiveEntry[] = [];
	private signature = '';

	constructor(
		@IBrowserViewWorkbenchService private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@IParadisAgentBrowserBindingModel private readonly bindingModel: IParadisAgentBrowserBindingModel,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@IHostService private readonly hostService: IHostService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
	) {
		super();

		this.recomputeScheduler = this._register(new RunOnceScheduler(() => this.recompute(), RECOMPUTE_DELAY));

		this._register(this.browserViewWorkbenchService.onDidChangeBrowserViews(() => this.onSourcesChanged()));
		// タブの並び替え・開閉はエントリの順序に効く。エディタ側の変化はまとめてここで拾う。
		this._register(this.editorService.onDidEditorsChange(() => this.onSourcesChanged()));
		this._register(this.bindingModel.onDidChange(() => this.schedule()));
		// スペース切り替えが終わったら組み直す。切り替え中は下の recompute() が見送るため、
		// 完了の合図が無いと空のまま止まりうる。
		this._register(this.workspaceSwitchService.onDidSwitchScope(() => this.onSourcesChanged()));

		this.onSourcesChanged();
	}

	get entries(): readonly IParadisBrowserLiveEntry[] {
		return this._entries;
	}

	get summary(): IParadisBrowserLiveSummary {
		return paradisSummarizeBrowserLiveEntries(this._entries);
	}

	/**
	 * サムネ取得のために、そのビューのモデルを引く。まだ解決されていなければ undefined。
	 *
	 * ここだけは台帳の直接引きにする。渡ってくる viewId は {@link entries} 由来 (= 既に
	 * スコープで絞ったあと) なので結果は変わらないが、{@link inputs} は呼ぶたびに全ビュー分の
	 * フィルタ (グループ走査を含む) を回して新しい Map を作るため、サムネの取得周期ごとに
	 * 呼ぶには重すぎる。
	 */
	getViewModel(viewId: string): IBrowserViewModel | undefined {
		return this.browserViewWorkbenchService.getKnownBrowserViews().get(viewId)?.model;
	}

	/**
	 * 一覧に載せるブラウザビュー。
	 *
	 * 「知っているビュー」(getKnownBrowserViews) ではなく、必ずこちらを使う。スペースを
	 * 切り替えても他スペースの BrowserEditorInput は破棄されず (paradisBrowserScope が
	 * 切り替え中の dispose を veto する)、知っているビューには他スペースのページが残り続ける。
	 * 今のスペースに属するページだけを返すのは、そのスコープ判定を含む contextual 側だけ
	 * (フィルタの結果が変わると onDidChangeBrowserViews も発火するので、購読はそのままでよい)。
	 */
	private inputs(): Map<string, BrowserEditorInput> {
		return this.browserViewWorkbenchService.getContextualBrowserViews();
	}

	/**
	 * そのブラウザのタブを前面に出す。
	 *
	 * ウィンドウを前面へ出すのはタブを開いた後。先に focus するとアクティブグループが
	 * 変わる余地が残り、直後の openEditor が意図しないグループへ載りうる
	 * (agentBrowser の共有ページ復帰と同じ順序にしてある)。
	 */
	async reveal(viewId: string): Promise<void> {
		const input = this.inputs().get(viewId);
		if (!input) {
			return;
		}
		await this.editorService.openEditor(input);
		await this.hostService.focus(mainWindow);
	}

	/** そのタブを閉じる。どのグループにも載っていない (背景の) ビューでは何もしない。 */
	async close(viewId: string): Promise<void> {
		const input = this.inputs().get(viewId);
		if (!input) {
			return;
		}
		for (const group of this.editorGroupsService.groups) {
			if (group.contains(input)) {
				await group.closeEditor(input);
				return;
			}
		}
	}

	async reload(viewId: string): Promise<void> {
		await this.getViewModel(viewId)?.reload();
	}

	private onSourcesChanged(): void {
		this.refreshSubscriptions();
		this.schedule();
	}

	private schedule(): void {
		if (!this.recomputeScheduler.isScheduled()) {
			this.recomputeScheduler.schedule();
		}
	}

	/**
	 * ビューごとの購読を現状に合わせる。
	 *
	 * 入力の `onDidChangeLabel` はタイトル・favicon・読み込み状態・遷移でまとめて発火する。
	 * 表示中かどうかだけはラベルに出ないので、解決済みのモデルを個別に購読する。
	 */
	private refreshSubscriptions(): void {
		const inputs = this.inputs();
		for (const [viewId] of this.viewSubscriptions) {
			if (!inputs.has(viewId)) {
				this.viewSubscriptions.deleteAndDispose(viewId);
			}
		}
		for (const [viewId, input] of inputs) {
			if (this.viewSubscriptions.get(viewId)) {
				continue;
			}
			const store = new DisposableStore();
			store.add(input.onDidChangeLabel(() => this.schedule()));
			const trackModel = (model: IBrowserViewModel) => {
				store.add(model.onDidChangeVisibility(() => this.schedule()));
				this.schedule();
			};
			store.add(input.onDidResolveModel(model => trackModel(model)));
			if (input.model) {
				trackModel(input.model);
			}
			this.viewSubscriptions.set(viewId, store);
		}
	}

	private recompute(): void {
		if (this.workspaceSwitchService.isSwitching) {
			// 切り替え中はどのページのスコープも 'pending' 扱いになり、絞り込みの結果が空になる。
			// そのまま反映すると一覧が一度全部消え (タイルとサムネを作り直すことになり)、
			// ウィンドウを開いていなくてもタイトルバーのバッジが 0 に落ちて戻る。
			// 完了時は onDidSwitchScope で組み直す。
			return;
		}
		const entries = this.collect();
		const signature = entries.map(entry => [
			entry.viewId, entry.title, entry.url, entry.favicon ?? '', entry.loading ? '1' : '0',
			entry.errorText ?? '', entry.visible ? '1' : '0', entry.agents.join(','), String(entry.order),
		].join('\u0000')).join('\u0001');
		if (signature === this.signature) {
			return;
		}
		this.signature = signature;
		this._entries = entries;
		this._onDidChangeEntries.fire();
	}

	private collect(): IParadisBrowserLiveEntry[] {
		const inputs = this.inputs();
		const agentsByPage = this.collectAgents();

		// エディタで見えている順を先に決め、どのグループにも載っていないビュー (背景で
		// 作られたページ) は末尾へ回す。upstream のタブ候補一覧と同じ並べ方。
		const order = new Map<string, number>();
		for (const group of this.editorGroupsService.getGroups(GroupsOrder.GRID_APPEARANCE)) {
			for (const editor of group.editors) {
				if (editor instanceof BrowserEditorInput && !order.has(editor.id)) {
					order.set(editor.id, order.size);
				}
			}
		}

		const entries: IParadisBrowserLiveEntry[] = [];
		for (const [viewId, input] of inputs) {
			const model = input.model;
			entries.push({
				viewId,
				title: model?.title ?? input.title ?? '',
				url: model?.url ?? input.url ?? '',
				favicon: model?.favicon,
				loading: model?.loading === true,
				errorText: model?.error?.errorDescription,
				// モデル未解決のビューはまだ描かれていない。撮りに行かせないよう false にしておく。
				visible: model?.visible === true,
				agents: agentsByPage.get(viewId) ?? [],
				order: order.get(viewId) ?? Number.MAX_SAFE_INTEGER,
			});
		}
		entries.sort((a, b) => a.order - b.order);
		return entries;
	}

	/** pageId → 共有しているエージェントの表示名 (重複なし、ペインの並び順)。 */
	private collectAgents(): Map<string, string[]> {
		const kindByToken = new Map<string, ParadisPaneAgentKind>();
		for (const pane of this.bindingModel.getPanes()) {
			kindByToken.set(pane.token, pane.agentKind);
		}
		const result = new Map<string, string[]>();
		for (const binding of this.bindingModel.bindings) {
			const kind = kindByToken.get(binding.token);
			if (!kind) {
				continue;
			}
			const label = agentLabel(kind);
			const labels = result.get(binding.pageId);
			if (!labels) {
				result.set(binding.pageId, [label]);
			} else if (!labels.includes(label)) {
				labels.push(label);
			}
		}
		return result;
	}
}
