/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 2 画面のファイル転送のタブ（EditorPane）。左にこのマシン、右にこのウィンドウの接続先を並べ、
// 下に畳める転送の待ち行列を置く。左右の幅は SplitView で変えられ、狭いとき（エディタを分けたとき
// など）は上下に積む。

import * as dom from '../../../../base/browser/dom.js';
import { Orientation, Sizing, SplitView } from '../../../../base/browser/ui/splitview/splitview.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { dirname, extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { PARADIS_FILE_TRANSFER_EDITOR_ID, ParadisTransferSide } from '../common/paradisFileTransfer.js';
import { IParadisTransferItem } from '../common/paradisFileTransferQueue.js';
import { ParadisFileTransferInput } from './paradisFileTransferInput.js';
import { ParadisFileTransferPane } from './paradisFileTransferPane.js';
import { ParadisFileTransferQueueView } from './paradisFileTransferQueueView.js';
import { IParadisFileTransferService } from './paradisFileTransferService.js';
import './media/paradisFileTransfer.css';

/** これより狭いと左右を上下に積む。 */
const PARADIS_STACK_BELOW_WIDTH = 760;
/** 片側の最小の幅（高さ）。 */
const PARADIS_PANE_MINIMUM = 220;

export class ParadisFileTransferEditor extends EditorPane {

	static readonly ID = PARADIS_FILE_TRANSFER_EDITOR_ID;

	private root: HTMLElement | undefined;
	private panesContainer: HTMLElement | undefined;
	private readonly panes = new Map<ParadisTransferSide, ParadisFileTransferPane>();
	private queueView: ParadisFileTransferQueueView | undefined;
	private readonly splitView = this._register(new MutableDisposable<SplitView<number>>());
	private orientation: Orientation | undefined;
	private dimension: dom.Dimension | undefined;
	private readonly inputStore = this._register(new DisposableStore());
	private initialized = false;
	/** 読み直しを済ませた（終わった）転送の項目。 */
	private readonly settledItems = new Set<number>();
	private readonly pendingRefresh = new Set<ParadisFileTransferPane>();
	private readonly refreshScheduler = this._register(new RunOnceScheduler(() => {
		const panes = [...this.pendingRefresh];
		this.pendingRefresh.clear();
		for (const pane of panes) {
			void pane.refresh();
		}
	}, 300));

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IParadisFileTransferService private readonly transferService: IParadisFileTransferService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super(PARADIS_FILE_TRANSFER_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = dom.append(parent, dom.$('.para-ft'));
		this.panesContainer = dom.append(this.root, dom.$('.para-ft-panes'));
		const host = {
			otherPane: (side: ParadisTransferSide) => this.panes.get(side === 'local' ? 'remote' : 'local'),
			closeEditor: () => {
				if (this.input) {
					void this.group.closeEditor(this.input);
				}
			},
		};
		for (const side of ['local', 'remote'] as const) {
			const pane = this._register(this.instantiationService.createInstance(ParadisFileTransferPane, side, host));
			this._register(pane.onDidNavigate(resource => this.rememberLocation(side, resource)));
			this.panes.set(side, pane);
		}
		this.queueView = this._register(this.instantiationService.createInstance(ParadisFileTransferQueueView, this.transferService.queue, (item: IParadisTransferItem) => void this.transferService.retry(item)));
		this.root.appendChild(this.queueView.element);
		this._register(this.queueView.onDidChangeHeight(() => this.relayout()));
		this._register(this.transferService.queue.onDidChange(() => this.refreshAfterTransfers()));
	}

	/**
	 * 転送が終わった（または途中で止まった）ら、送り先を開いている側を読み直す。
	 * 進み具合の通知は秒に数回来るので、終わった項目が増えたときだけ、少し待ってまとめて読む。
	 */
	private refreshAfterTransfers(): void {
		const items = this.transferService.queue.items;
		// 待ち行列から消えた項目の印は捨てる（溜め続けない）
		const present = new Set(items.map(item => item.id));
		for (const id of [...this.settledItems]) {
			if (!present.has(id)) {
				this.settledItems.delete(id);
			}
		}
		for (const item of items) {
			if (item.state === 'waiting' || item.state === 'running') {
				// 再試行で流し直したものは、終わったらもう一度読み直す
				this.settledItems.delete(item.id);
				continue;
			}
			if ((item.state === 'done' || item.state === 'error' || item.state === 'cancelled') && !this.settledItems.has(item.id)) {
				this.settledItems.add(item.id);
				const folder = dirname(item.target);
				for (const pane of this.panes.values()) {
					if (pane.currentLocation && extUri.isEqual(pane.currentLocation, folder)) {
						this.pendingRefresh.add(pane);
					}
				}
			}
		}
		if (this.pendingRefresh.size && !this.refreshScheduler.isScheduled()) {
			this.refreshScheduler.schedule();
		}
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputStore.clear();
		if (!(input instanceof ParadisFileTransferInput)) {
			return;
		}
		this.inputStore.add(input.onDidRequestReveal(() => void this.applyReveal(input)));
		if (!this.initialized) {
			this.initialized = true;
			const folder = this.workspaceContextService.getWorkspace().folders[0]?.uri;
			await Promise.all((['local', 'remote'] as const).map(async side => {
				const pane = this.panes.get(side)!;
				const remembered = input.locations[side];
				const start = remembered && this.transferService.owns(side, remembered)
					? remembered
					: await this.transferService.defaultLocation(side, folder);
				if (start) {
					await pane.navigate(start, false);
				}
			}));
		}
		await this.applyReveal(input);
	}

	private async applyReveal(input: ParadisFileTransferInput): Promise<void> {
		const reveal = input.takeReveal();
		if (!reveal) {
			return;
		}
		const pane = this.panes.get(reveal.side);
		if (pane && this.transferService.owns(reveal.side, reveal.resource)) {
			await pane.navigate(reveal.resource);
			pane.focus();
		}
	}

	private rememberLocation(side: ParadisTransferSide, resource: URI): void {
		if (this.input instanceof ParadisFileTransferInput) {
			this.input.locations[side] = resource;
		}
	}

	override layout(dimension: dom.Dimension): void {
		this.dimension = dimension;
		this.relayout();
	}

	private relayout(): void {
		const dimension = this.dimension;
		if (!dimension || !this.root || !this.panesContainer || !this.queueView) {
			return;
		}
		const narrow = dimension.width < PARADIS_STACK_BELOW_WIDTH;
		this.root.classList.toggle('stack', narrow);
		this.queueView.setNarrow(narrow);
		const orientation = narrow ? Orientation.VERTICAL : Orientation.HORIZONTAL;
		const height = Math.max(0, dimension.height - this.queueView.height);
		this.panesContainer.style.height = `${height}px`;
		const size = orientation === Orientation.HORIZONTAL ? dimension.width : height;
		const other = orientation === Orientation.HORIZONTAL ? height : dimension.width;
		if (orientation !== this.orientation || !this.splitView.value) {
			this.createSplitView(orientation, size, other);
		}
		this.splitView.value!.layout(size, other);
	}

	/** 向きが変わったら作り直す（片側の部品はそのまま移す）。 */
	private createSplitView(orientation: Orientation, size: number, other: number): void {
		this.orientation = orientation;
		this.splitView.clear();
		dom.clearNode(this.panesContainer!);
		const splitView = new SplitView<number>(this.panesContainer!, { orientation, proportionalLayout: true });
		// 先に大きさを与えてから足すと、2 つが半分ずつになる
		splitView.layout(size, other);
		for (const side of ['local', 'remote'] as const) {
			const pane = this.panes.get(side)!;
			splitView.addView({
				element: pane.element,
				minimumSize: PARADIS_PANE_MINIMUM,
				maximumSize: Number.POSITIVE_INFINITY,
				onDidChange: Event.None,
				layout: (size, _offset, other) => {
					if (orientation === Orientation.HORIZONTAL) {
						pane.layout(size, other ?? 0);
					} else {
						pane.layout(other ?? 0, size);
					}
				},
			}, Sizing.Distribute);
		}
		this.splitView.value = splitView;
	}

	override focus(): void {
		super.focus();
		this.panes.get('local')?.focus();
	}
}
