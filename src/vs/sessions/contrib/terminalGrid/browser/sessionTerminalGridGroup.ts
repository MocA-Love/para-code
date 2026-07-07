/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { TERMINAL_VIEW_ID } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { Event, Emitter } from '../../../../base/common/event.js';
import { IDisposable, Disposable, DisposableStore, dispose, toDisposable } from '../../../../base/common/lifecycle.js';
import { Orientation } from '../../../../base/browser/ui/sash/sash.js';
import { isHorizontal, IWorkbenchLayoutService, Position } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ITerminalInstance, Direction, ITerminalGroup, ITerminalGroupService, ITerminalInstanceService, ITerminalConfigurationService, ITerminalService, ITerminalEditorService, TerminalDataTransfers } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { getTerminalResourcesFromDragEvent } from '../../../../workbench/contrib/terminal/browser/terminalUri.js';
import { ViewContainerLocation, IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IShellLaunchConfig, ITerminalTabLayoutInfoById, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { TerminalStatus } from '../../../../workbench/contrib/terminal/browser/terminalStatusList.js';
import { addDisposableListener, getWindow } from '../../../../base/browser/dom.js';
import { asArray } from '../../../../base/common/arrays.js';
import { hasKey, isNumber, type SingleOrMany } from '../../../../base/common/types.js';
import { IPaneCompositePartService } from '../../../../workbench/services/panecomposite/browser/panecomposite.js';
import { Grid, Direction as GridDirection, Sizing as GridSizing, IView as IGridCellView, IViewSize } from '../../../../base/browser/ui/grid/grid.js';
import { containsDragType } from '../../../../platform/dnd/browser/dnd.js';
import { createParadisPaneIndicator } from '../../../../paradis/contrib/agentBrowser/browser/paradisPaneIndicator.js';

const enum Constants {
	/**
	 * The minimum size in pixels of a grid cell (mirrors `SplitPaneMinSize` in
	 * `terminalGroup.ts`).
	 */
	CellMinSize = 80,
	/**
	 * The number of cells the terminal gets added or removed when asked to increase or decrease
	 * the view size.
	 */
	ResizePartCellCount = 4
}

/**
 * Converts a {@link Direction} (as used by {@link ITerminalGroup}) into the {@link GridDirection}
 * expected by the generic {@link Grid} widget. The two enums intentionally use different
 * underlying numeric values, so a value can never be reused directly.
 */
function toGridDirection(direction: Direction): GridDirection {
	switch (direction) {
		case Direction.Left: return GridDirection.Left;
		case Direction.Right: return GridDirection.Right;
		case Direction.Up: return GridDirection.Up;
		case Direction.Down: return GridDirection.Down;
	}
}

/**
 * Implemented by {@link SessionTerminalGridGroup} and invoked by {@link SessionTerminalGridCell}
 * when a terminal tab is dropped onto one of its cells (see `_registerDragAndDrop` below). This
 * indirection exists so the cell (and its drag & drop handling) can stay a plain, DI-free class
 * while still being able to ask the owning group to actually move the dropped instance into place.
 */
interface ISessionTerminalGridDropTarget {
	moveInstanceInDirection(source: ITerminalInstance, reference: ITerminalInstance, direction: Direction): void;
}

/** CSS class suffix (`drop-<suffix>`) used for the directional drop overlay, see {@link SessionTerminalGridCell}. */
function directionToDropClassSuffix(direction: Direction): 'up' | 'down' | 'left' | 'right' {
	switch (direction) {
		case Direction.Up: return 'up';
		case Direction.Down: return 'down';
		case Direction.Left: return 'left';
		case Direction.Right: return 'right';
	}
}

/**
 * Computes which of the 4 directions (if any) a terminal tab drag is currently hovering over,
 * given the pointer position and the bounding box of the cell being dragged over.
 *
 * The quadrant math mirrors `positionOverlay` in
 * `src/vs/workbench/browser/parts/editor/editorDropTarget.ts` (the "prefer horizontal" branch: top
 * third / bottom third for up/down, left half / right half of the remaining band for left/right).
 * That file is not imported or modified; only the logic shape is reused here for a 2D terminal
 * grid instead of editor groups. The middle third of both axes is a dead zone (`undefined`) so
 * small pointer jitter near the center of a cell does not flicker between directions.
 */
function computeGridDropDirection(clientX: number, clientY: number, targetRect: DOMRect): Direction | undefined {
	const width = targetRect.width;
	const height = targetRect.height;
	if (width <= 0 || height <= 0) {
		return undefined;
	}

	const x = clientX - targetRect.left;
	const y = clientY - targetRect.top;

	const inMiddleThirdX = x > width / 3 && x < (width * 2) / 3;
	const inMiddleThirdY = y > height / 3 && y < (height * 2) / 3;
	if (inMiddleThirdX && inMiddleThirdY) {
		return undefined;
	}

	// Outside the centre dead zone: whichever axis the pointer has travelled proportionally
	// further from the centre on decides if this is a horizontal or a vertical split request.
	const distanceFromCenterX = Math.abs(x - width / 2) / (width / 2);
	const distanceFromCenterY = Math.abs(y - height / 2) / (height / 2);

	if (distanceFromCenterY >= distanceFromCenterX) {
		return y < height / 2 ? Direction.Up : Direction.Down;
	}
	return x < width / 2 ? Direction.Left : Direction.Right;
}

/**
 * A single leaf cell of the {@link SessionTerminalGridContainer}. Like `SplitPane` in
 * `terminalGroup.ts`, this only attaches/detaches the xterm DOM element of a terminal instance to
 * whatever element the layout algorithm gives it; it does not know anything about its neighbors.
 *
 * It additionally owns this fork's terminal-tab drag & drop handling for 4-direction grid splits
 * (see `_registerDragAndDrop`). Upstream's `TerminalInstanceDragAndDropController`
 * (`terminalInstance.ts`) already listens for the same drag events on this exact DOM element
 * (`instance.attachToElement(this.element)` below attaches the terminal into `this.element`, which
 * is the same container upstream's controller registers on), but can only resolve a 2-way
 * before/after split. Rather than editing that upstream class, this cell registers its own
 * capture-phase listeners on `this.element` so they run before upstream's bubble-phase ones, and
 * calls `stopPropagation()` to suppress the upstream handling whenever the drag is a terminal tab
 * (non-terminal drags, e.g. file drops, are left untouched so existing behavior keeps working).
 */
class SessionTerminalGridCell implements IGridCellView {
	readonly minimumWidth = Constants.CellMinSize;
	readonly maximumWidth = Number.POSITIVE_INFINITY;
	readonly minimumHeight = Constants.CellMinSize;
	readonly maximumHeight = Number.POSITIVE_INFINITY;

	readonly onDidChange: Event<IViewSize | undefined> = Event.None;

	readonly element: HTMLElement;

	private readonly _dndDisposables = new DisposableStore();
	private _dropOverlay: HTMLElement | undefined;
	private readonly _paneIndicator: IDisposable;

	constructor(
		readonly instance: ITerminalInstance,
		private readonly _dropTarget: ISessionTerminalGridDropTarget,
		private readonly _terminalService: ITerminalService
	) {
		this.element = document.createElement('div');
		this.element.className = 'session-terminal-grid-cell';
		this.instance.attachToElement(this.element);
		this._registerDragAndDrop();
		// Fork feature: small agent-browser-binding indicator in the cell's top-right corner
		// (green when this pane has a browser page bound, gray otherwise; click opens the binding
		// dialog). This is a DI-free helper; the actual state is supplied by the electron-browser
		// contribution via `setParadisPaneIndicatorHost` (see paradisPaneIndicator.ts), so the
		// indicator stays hidden when no host is registered (e.g. web builds).
		const indicator = createParadisPaneIndicator(this.instance.instanceId);
		this.element.appendChild(indicator.element);
		this._paneIndicator = indicator;
	}

	private _registerDragAndDrop(): void {
		this._dndDisposables.add(addDisposableListener(this.element, 'dragenter', (e: DragEvent) => {
			if (!containsDragType(e, TerminalDataTransfers.Terminals)) {
				return;
			}
			e.stopPropagation();
			this._updateDropOverlay(e);
		}, true));

		this._dndDisposables.add(addDisposableListener(this.element, 'dragover', (e: DragEvent) => {
			if (!containsDragType(e, TerminalDataTransfers.Terminals)) {
				return;
			}
			// Needed so the browser actually fires a `drop` event afterwards, mirrors
			// `DragAndDropObserver`'s own `dragover` handling in `base/browser/dom.ts`. This must
			// happen here (rather than relying on upstream's handler) because `stopPropagation`
			// below prevents the event from ever reaching upstream's `DragAndDropObserver`.
			e.preventDefault();
			e.stopPropagation();
			this._updateDropOverlay(e);
		}, true));

		this._dndDisposables.add(addDisposableListener(this.element, 'dragleave', (e: DragEvent) => {
			if (!containsDragType(e, TerminalDataTransfers.Terminals)) {
				return;
			}
			e.stopPropagation();
			this._clearDropOverlay();
		}, true));

		this._dndDisposables.add(addDisposableListener(this.element, 'drop', (e: DragEvent) => {
			if (!containsDragType(e, TerminalDataTransfers.Terminals)) {
				return;
			}
			// このウィンドウ内でドラッグ元ターミナルを解決できるかをまず確認する。別ウィンドウ（同一
			// プロファイルで複数ウィンドウを使う場合）からドラッグされたターミナルは、このウィンドウの
			// `terminalService.instances` には存在しないため `getInstanceFromResource` は undefined を
			// 返す。その場合は upstream が永続プロセスの引き継ぎ（`TerminalService._addInstanceToGroup`
			// → `requestDetachInstance`）で処理する経路を、同じ要素に bubble 段で登録された upstream の
			// `DragAndDropObserver` が駆動する。ここで無条件に `stopPropagation` するとその経路に到達
			// できずドロップが黙って失われるので、自前でグリッド分割を実行できるとき（＝同一ウィンドウ内
			// のターミナルを解決できたとき）だけイベントを横取りする。
			const source = this._resolveDropSource(e);
			if (!source) {
				this._clearDropOverlay();
				return;
			}
			e.stopPropagation();
			this._handleDrop(e, source);
		}, true));
	}

	/**
	 * Resolves the terminal instance being dragged from a drop {@link DragEvent}, but only if it
	 * belongs to this window. Returns `undefined` for a terminal dragged in from another window (its
	 * URI is not present in this window's `terminalService.instances`), which the caller uses to
	 * decide whether to handle the drop itself or defer to upstream's cross-window handoff.
	 */
	private _resolveDropSource(e: DragEvent): ITerminalInstance | undefined {
		const resources = getTerminalResourcesFromDragEvent(e);
		const sourceUri = resources?.[0];
		return this._terminalService.getInstanceFromResource(sourceUri);
	}

	private _updateDropOverlay(e: DragEvent): void {
		const direction = computeGridDropDirection(e.clientX, e.clientY, this.element.getBoundingClientRect());
		if (direction === undefined) {
			this._clearDropOverlay();
			return;
		}
		if (!this._dropOverlay) {
			this._dropOverlay = document.createElement('div');
			this.element.appendChild(this._dropOverlay);
		}
		this._dropOverlay.className = `session-terminal-grid-drop-overlay drop-${directionToDropClassSuffix(direction)}`;
	}

	private _clearDropOverlay(): void {
		this._dropOverlay?.remove();
		this._dropOverlay = undefined;
	}

	private _handleDrop(e: DragEvent, source: ITerminalInstance): void {
		const direction = computeGridDropDirection(e.clientX, e.clientY, this.element.getBoundingClientRect());
		this._clearDropOverlay();
		if (direction === undefined) {
			return;
		}

		if (source === this.instance) {
			return;
		}

		this._dropTarget.moveInstanceInDirection(source, this.instance, direction);
	}

	layout(width: number, height: number): void {
		// Only layout once both dimensions are known, the grid always provides an exact box so
		// unlike `SplitPane` there is no need to separately track an "orthogonal" size.
		if (!width || !height) {
			return;
		}
		this.instance.layout({ width, height });
	}

	dispose(): void {
		this._clearDropOverlay();
		this._paneIndicator.dispose();
		this._dndDisposables.dispose();
		this.instance.detachFromElement();
	}
}

/**
 * Owns the actual {@link Grid} widget backing a {@link SessionTerminalGridGroup}. This plays the
 * same role `SplitPaneContainer` plays for the upstream single-axis `TerminalGroup`, except it
 * supports arbitrary 2D layouts instead of a single row/column.
 */
class SessionTerminalGridContainer extends Disposable {
	private _grid: Grid<SessionTerminalGridCell> | undefined;
	private readonly _cells = new Map<ITerminalInstance, SessionTerminalGridCell>();

	private _width: number;
	private _height: number;

	constructor(
		private readonly _container: HTMLElement,
		private readonly _dropTarget: ISessionTerminalGridDropTarget,
		@ITerminalService private readonly _terminalService: ITerminalService
	) {
		super();
		this._width = this._container.offsetWidth;
		this._height = this._container.offsetHeight;
	}

	private _firstCell(): SessionTerminalGridCell | undefined {
		return this._cells.values().next().value;
	}

	/**
	 * Adds a new cell for `instance`, placed next to `referenceInstance` in `direction`. When the
	 * grid is still empty, `instance` becomes the grid's sole initial view and `referenceInstance`
	 * is ignored (a {@link Grid} always requires exactly one initial view). When a
	 * `referenceInstance` is not (or no longer) part of the grid, an arbitrary existing cell is
	 * used instead so the new pane always ends up placed somewhere sensible.
	 */
	addCell(instance: ITerminalInstance, referenceInstance: ITerminalInstance | undefined, direction: Direction): void {
		if (this._cells.has(instance)) {
			return;
		}

		const cell = new SessionTerminalGridCell(instance, this._dropTarget, this._terminalService);

		if (!this._grid) {
			this._cells.set(instance, cell);
			this._grid = new Grid<SessionTerminalGridCell>(cell);
			this._register(this._grid);
			this._container.appendChild(this._grid.element);
			this._grid.layout(this._width, this._height);
			return;
		}

		const referenceCell = (referenceInstance && this._cells.get(referenceInstance)) ?? this._firstCell();
		if (!referenceCell) {
			// Should be unreachable: the grid always has at least one cell once created.
			cell.dispose();
			return;
		}

		this._cells.set(instance, cell);
		this._grid.addView(cell, GridSizing.Distribute, referenceCell, toGridDirection(direction));
		this._grid.layout(this._width, this._height);
	}

	removeCell(instance: ITerminalInstance): void {
		const cell = this._cells.get(instance);
		if (!cell || !this._grid) {
			return;
		}

		this._cells.delete(instance);
		if (this._cells.size > 0) {
			this._grid.removeView(cell, GridSizing.Distribute);
		}
		// When this was the last cell the group is about to fully dispose anyway (see
		// `SessionTerminalGridGroup.dispose`), `Grid.removeView` cannot remove the last view so it
		// must not be called in that case.
		cell.dispose();
	}

	getCellSize(instance: ITerminalInstance): IViewSize | undefined {
		const cell = this._cells.get(instance);
		if (!cell || !this._grid) {
			return undefined;
		}
		return this._grid.getViewSize(cell);
	}

	resizeCell(instance: ITerminalInstance, size: IViewSize): void {
		const cell = this._cells.get(instance);
		if (!cell || !this._grid) {
			return;
		}
		this._grid.resizeView(cell, size);
	}

	layout(width: number, height: number): void {
		this._width = width;
		this._height = height;
		this._grid?.layout(width, height);
	}

	override dispose(): void {
		for (const cell of this._cells.values()) {
			cell.dispose();
		}
		this._cells.clear();
		super.dispose();
	}
}

/**
 * A drop-in replacement for the upstream `TerminalGroup` (`terminalGroup.ts`) that arranges its
 * terminal instances in a free-form 2D {@link Grid} instead of a single row or column.
 *
 * This implements {@link ITerminalGroup} in full so it can be substituted at the single DI
 * factory point in `terminalGroupService.ts` (see the `PARA-PATCH` marker there). It additionally
 * exposes {@link splitInDirection}, a fork-only API (not part of `ITerminalGroup`) used by
 * `sessionTerminalGrid.contribution.ts` to add panes in any of the 4 directions, which is what
 * makes true "田の字" (2x2 and beyond) layouts possible.
 *
 * Most of the bookkeeping below (instance list management, active instance tracking, title/bell
 * text, visibility, disposal) is intentionally kept identical to `TerminalGroup` so behavior stays
 * consistent; only the parts that depend on the underlying layout engine are re-implemented
 * against {@link SessionTerminalGridContainer} instead of `SplitPaneContainer`.
 *
 * It also implements {@link ISessionTerminalGridDropTarget} so a {@link SessionTerminalGridCell}
 * can ask it to place a dropped terminal tab in a given direction via {@link moveInstanceInDirection}
 * (see `_registerDragAndDrop` on `SessionTerminalGridCell` for where this is invoked from).
 */
export class SessionTerminalGridGroup extends Disposable implements ITerminalGroup, ISessionTerminalGridDropTarget {
	private _terminalInstances: ITerminalInstance[] = [];
	private _gridContainer: SessionTerminalGridContainer | undefined;
	private _groupElement: HTMLElement | undefined;
	private _panelPosition: Position = Position.BOTTOM;
	private _terminalLocation: ViewContainerLocation = ViewContainerLocation.Panel;
	private _instanceDisposables: Map<number, IDisposable[]> = new Map();

	private _activeInstanceIndex: number = -1;

	get terminalInstances(): ITerminalInstance[] { return this._terminalInstances; }

	private _hadFocusOnExit: boolean = false;
	get hadFocusOnExit(): boolean { return this._hadFocusOnExit; }

	private _initialRelativeSizes: number[] | undefined;
	private _visible: boolean = false;

	private readonly _onDidDisposeInstance: Emitter<ITerminalInstance> = this._register(new Emitter<ITerminalInstance>());
	readonly onDidDisposeInstance = this._onDidDisposeInstance.event;
	private readonly _onDidFocusInstance: Emitter<ITerminalInstance> = this._register(new Emitter<ITerminalInstance>());
	readonly onDidFocusInstance = this._onDidFocusInstance.event;
	private readonly _onDidChangeInstanceCapability: Emitter<ITerminalInstance> = this._register(new Emitter<ITerminalInstance>());
	readonly onDidChangeInstanceCapability = this._onDidChangeInstanceCapability.event;
	private readonly _onDisposed: Emitter<ITerminalGroup> = this._register(new Emitter<ITerminalGroup>());
	readonly onDisposed = this._onDisposed.event;
	private readonly _onInstancesChanged: Emitter<void> = this._register(new Emitter<void>());
	readonly onInstancesChanged = this._onInstancesChanged.event;
	private readonly _onDidChangeActiveInstance = this._register(new Emitter<ITerminalInstance | undefined>());
	readonly onDidChangeActiveInstance = this._onDidChangeActiveInstance.event;
	private readonly _onPanelOrientationChanged = this._register(new Emitter<Orientation>());
	readonly onPanelOrientationChanged = this._onPanelOrientationChanged.event;

	constructor(
		private _container: HTMLElement | undefined,
		shellLaunchConfigOrInstance: IShellLaunchConfig | ITerminalInstance | undefined,
		@ITerminalConfigurationService private readonly _terminalConfigurationService: ITerminalConfigurationService,
		@ITerminalInstanceService private readonly _terminalInstanceService: ITerminalInstanceService,
		@IPaneCompositePartService private readonly _paneCompositePartService: IPaneCompositePartService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IViewDescriptorService private readonly _viewDescriptorService: IViewDescriptorService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ITerminalGroupService private readonly _terminalGroupService: ITerminalGroupService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@ITerminalEditorService private readonly _terminalEditorService: ITerminalEditorService
	) {
		super();
		if (shellLaunchConfigOrInstance) {
			this.addInstance(shellLaunchConfigOrInstance);
		}
		if (this._container) {
			this.attachToElement(this._container);
		}
		// Unlike `TerminalGroup`, the grid does not need to rotate itself when the panel moves
		// between the bottom/side of the workbench, since it natively supports both axes at once.
		// The event is still fired once so consumers relying on an initial value keep working.
		this._onPanelOrientationChanged.fire(this._terminalLocation === ViewContainerLocation.Panel && isHorizontal(this._panelPosition) ? Orientation.HORIZONTAL : Orientation.VERTICAL);
		this._register(toDisposable(() => {
			if (this._container && this._groupElement) {
				this._groupElement.remove();
				this._groupElement = undefined;
			}
		}));
	}

	addInstance(shellLaunchConfigOrInstance: IShellLaunchConfig | ITerminalInstance, parentTerminalId?: number): void {
		let instance: ITerminalInstance;
		// if a parent terminal is provided, find it
		// otherwise, parent is the active terminal
		const parentIndex = parentTerminalId ? this._terminalInstances.findIndex(t => t.instanceId === parentTerminalId) : this._activeInstanceIndex;
		if (hasKey(shellLaunchConfigOrInstance, { instanceId: true })) {
			instance = shellLaunchConfigOrInstance;
		} else {
			instance = this._terminalInstanceService.createInstance(shellLaunchConfigOrInstance, TerminalLocation.Panel);
		}
		const referenceInstance = parentIndex >= 0 ? this._terminalInstances[parentIndex] : undefined;
		if (this._terminalInstances.length === 0) {
			this._terminalInstances.push(instance);
			this._activeInstanceIndex = 0;
		} else {
			this._terminalInstances.splice(parentIndex + 1, 0, instance);
		}
		this._initInstanceListeners(instance);

		// Callers of `addInstance`/`split` don't specify a direction (that is what the
		// grid-only `splitInDirection` API is for), so default new panes to the right of their
		// reference instance, which keeps single-axis growth working the same as before.
		this._gridContainer?.addCell(instance, referenceInstance, Direction.Right);

		this._onInstancesChanged.fire();
	}

	/**
	 * Fork-only API (not part of {@link ITerminalGroup}): creates a new terminal instance and
	 * places it in `direction` relative to `instance`, which must already belong to this group.
	 * This is how `sessionTerminalGrid.contribution.ts` builds true 2D ("田の字") layouts.
	 */
	splitInDirection(instance: ITerminalInstance, direction: Direction): void {
		const referenceIndex = this._terminalInstances.indexOf(instance);
		if (referenceIndex === -1) {
			return;
		}

		const newInstance = this._terminalInstanceService.createInstance({}, TerminalLocation.Panel);
		this._terminalInstances.splice(referenceIndex + 1, 0, newInstance);
		this._initInstanceListeners(newInstance);

		this._gridContainer?.addCell(newInstance, instance, direction);

		this._setActiveInstance(newInstance);
		this._onInstancesChanged.fire();
	}

	/**
	 * {@link ISessionTerminalGridDropTarget} implementation: called by a {@link SessionTerminalGridCell}
	 * belonging to this group when a terminal tab (`source`) is dropped onto `reference` (a cell's
	 * own instance, always a member of this group) requesting a split in `direction`. This is the
	 * 4-direction analogue of `TerminalGroupService.moveInstance`, which only supports a 2-way
	 * before/after move and does not know about grid positions at all.
	 */
	moveInstanceInDirection(source: ITerminalInstance, reference: ITerminalInstance, direction: Direction): void {
		if (source === reference || !this._terminalInstances.includes(reference)) {
			return;
		}
		// Guard against stale/disposed drag data (e.g. a terminal tab dragged from a window that
		// has since closed the source terminal).
		if (!this._terminalService.instances.includes(source)) {
			return;
		}

		const sourceGroup = this._terminalGroupService.getGroupForInstance(source);
		if (sourceGroup) {
			// `removeInstance` also fully disposes `sourceGroup` when this was its last remaining
			// pane, mirroring the cross-group handling in `TerminalGroupService.moveInstance`. When
			// `sourceGroup === this` (reordering a pane within the same grid), this removes the
			// existing bookkeeping entry and grid cell so the re-add below does not duplicate it.
			sourceGroup.removeInstance(source);
		} else if (source.target === TerminalLocation.Editor) {
			// エディタ所属のターミナル（ターミナルエディタのタブ）は `getGroupForInstance` が undefined を
			// 返すため上の分岐に入らない。この場合に何もせず grid へ追加すると、(1) インスタンスが
			// terminalEditorService と grid group の両方に登録されて `terminalService.instances` に二重に
			// 現れ、(2) xterm DOM だけが grid へ移って元のエディタタブは空のまま残り、(3) その空タブを
			// 閉じると `TerminalEditorInput` がインスタンスごと dispose して grid のペインが死ぬ。
			// upstream の `TerminalService.moveToTerminalView`(terminalService.ts) と同じ手順で、
			// terminalEditorService から detach（`TerminalEditorInput` とインスタンスの結び付きを切る）
			// してから panel 所属に付け替える。
			this._terminalEditorService.detachInstance(source);
			source.target = TerminalLocation.Panel;
		}

		const referenceIndex = this._terminalInstances.indexOf(reference);
		this._terminalInstances.splice(referenceIndex + 1, 0, source);
		this._initInstanceListeners(source);

		this._gridContainer?.addCell(source, reference, direction);

		this._setActiveInstance(source);
		this._onInstancesChanged.fire();
	}

	override dispose(): void {
		this._terminalInstances = [];
		this._onInstancesChanged.fire();
		this._gridContainer?.dispose();
		super.dispose();
	}

	get activeInstance(): ITerminalInstance | undefined {
		if (this._terminalInstances.length === 0) {
			return undefined;
		}
		return this._terminalInstances[this._activeInstanceIndex];
	}

	getLayoutInfo(isActive: boolean): ITerminalTabLayoutInfoById {
		const instances = this.terminalInstances.filter(instance => isNumber(instance.persistentProcessId) && instance.shouldPersist);
		const totalArea = instances.reduce((total, t) => total + this._getCellArea(t), 0);
		return {
			isActive: isActive,
			activePersistentProcessId: this.activeInstance ? this.activeInstance.persistentProcessId : undefined,
			terminals: instances.map(t => {
				return {
					// The 2D grid has no single "size" axis to persist a 1D `SplitView` proportion
					// against, so the relative area of each cell is used as a reasonable analogue.
					relativeSize: totalArea > 0 ? this._getCellArea(t) / totalArea : 0,
					terminal: t.persistentProcessId || 0
				};
			})
		};
	}

	private _getCellArea(instance: ITerminalInstance): number {
		const size = this._gridContainer?.getCellSize(instance);
		return size ? size.width * size.height : 0;
	}

	private _initInstanceListeners(instance: ITerminalInstance) {
		this._instanceDisposables.set(instance.instanceId, [
			instance.onDisposed(instance => {
				this._onDidDisposeInstance.fire(instance);
				this._handleOnDidDisposeInstance(instance);
			}),
			instance.onDidFocus(instance => {
				this._setActiveInstance(instance);
				this._onDidFocusInstance.fire(instance);
			}),
			instance.capabilities.onDidChangeCapabilities(() => this._onDidChangeInstanceCapability.fire(instance)),
		]);
	}

	private _handleOnDidDisposeInstance(instance: ITerminalInstance) {
		this._removeInstance(instance);
	}

	removeInstance(instance: ITerminalInstance) {
		this._removeInstance(instance);
	}

	private _removeInstance(instance: ITerminalInstance) {
		const index = this._terminalInstances.indexOf(instance);
		if (index === -1) {
			return;
		}

		const wasActiveInstance = instance === this.activeInstance;
		this._terminalInstances.splice(index, 1);

		// Adjust focus if the instance was active
		if (wasActiveInstance && this._terminalInstances.length > 0) {
			const newIndex = index < this._terminalInstances.length ? index : this._terminalInstances.length - 1;
			this.setActiveInstanceByIndex(newIndex);
			// TODO: Only focus the new instance if the group had focus?
			this.activeInstance?.focus(true);
		} else if (index < this._activeInstanceIndex) {
			// Adjust active instance index if needed
			this._activeInstanceIndex--;
		}

		this._gridContainer?.removeCell(instance);

		// Fire events and dispose group if it was the last instance
		if (this._terminalInstances.length === 0) {
			this._hadFocusOnExit = instance.hadFocusOnExit;
			this._onDisposed.fire(this);
			this.dispose();
		} else {
			this._onInstancesChanged.fire();
		}

		// Dispose instance event listeners
		const disposables = this._instanceDisposables.get(instance.instanceId);
		if (disposables) {
			dispose(disposables);
			this._instanceDisposables.delete(instance.instanceId);
		}
	}

	moveInstance(instances: SingleOrMany<ITerminalInstance>, index: number, position: 'before' | 'after'): void {
		instances = asArray(instances);
		const hasInvalidInstance = instances.some(instance => !this.terminalInstances.includes(instance));
		if (hasInvalidInstance) {
			return;
		}
		const insertIndex = position === 'before' ? index : index + 1;
		this._terminalInstances.splice(insertIndex, 0, ...instances);
		for (const item of instances) {
			const originSourceGroupIndex = position === 'after' ? this._terminalInstances.indexOf(item) : this._terminalInstances.lastIndexOf(item);
			this._terminalInstances.splice(originSourceGroupIndex, 1);
		}
		// NOTE: unlike `TerminalGroup`, the visual position of each pane in the grid is left
		// untouched here. A flat array index doesn't map onto a single well-defined location in a
		// 2D grid, so this only reorders the traversal order used by `focusPreviousPane`/
		// `focusNextPane`; use `splitInDirection` to actually change a pane's grid position.
		this._onInstancesChanged.fire();
	}

	private _setActiveInstance(instance: ITerminalInstance) {
		this.setActiveInstanceByIndex(this._getIndexFromId(instance.instanceId));
	}

	private _getIndexFromId(terminalId: number): number {
		let terminalIndex = -1;
		this.terminalInstances.forEach((terminalInstance, i) => {
			if (terminalInstance.instanceId === terminalId) {
				terminalIndex = i;
			}
		});
		if (terminalIndex === -1) {
			throw new Error(`Terminal with ID ${terminalId} does not exist (has it already been disposed?)`);
		}
		return terminalIndex;
	}

	setActiveInstanceByIndex(index: number, force?: boolean): void {
		// Check for invalid value
		if (index < 0 || index >= this._terminalInstances.length) {
			return;
		}

		const oldActiveInstance = this.activeInstance;
		this._activeInstanceIndex = index;
		if (oldActiveInstance !== this.activeInstance || force) {
			this._onInstancesChanged.fire();
			this._onDidChangeActiveInstance.fire(this.activeInstance);
		}
	}

	attachToElement(element: HTMLElement): void {
		this._container = element;

		// If we already have a group element, we can reparent it
		if (!this._groupElement) {
			this._groupElement = document.createElement('div');
			this._groupElement.classList.add('terminal-group', 'session-terminal-grid-group');
		}

		this._container.appendChild(this._groupElement);
		if (!this._gridContainer) {
			this._panelPosition = this._layoutService.getPanelPosition();
			this._terminalLocation = this._viewDescriptorService.getViewLocationById(TERMINAL_VIEW_ID)!;
			this._gridContainer = this._instantiationService.createInstance(SessionTerminalGridContainer, this._groupElement, this);
			let previousInstance: ITerminalInstance | undefined;
			for (const instance of this.terminalInstances) {
				this._gridContainer.addCell(instance, previousInstance, Direction.Right);
				previousInstance = instance;
			}
		}
	}

	get title(): string {
		if (this._terminalInstances.length === 0) {
			// Normally consumers should not call into title at all after the group is disposed but
			// this is required when the group is used as part of a tree.
			return '';
		}
		let title = this.terminalInstances[0].title + this._getBellTitle(this.terminalInstances[0]);
		if (this.terminalInstances[0].description) {
			title += ` (${this.terminalInstances[0].description})`;
		}
		for (let i = 1; i < this.terminalInstances.length; i++) {
			const instance = this.terminalInstances[i];
			if (instance.title) {
				title += `, ${instance.title + this._getBellTitle(instance)}`;
				if (instance.description) {
					title += ` (${instance.description})`;
				}
			}
		}
		return title;
	}

	private _getBellTitle(instance: ITerminalInstance) {
		if (this._terminalConfigurationService.config.enableBell && instance.statusList.statuses.some(e => e.id === TerminalStatus.Bell)) {
			return '*';
		}
		return '';
	}

	setVisible(visible: boolean): void {
		this._visible = visible;
		if (this._groupElement) {
			this._groupElement.style.display = visible ? '' : 'none';
		}

		// The upstream `SplitPaneContainer` this class replaces relies on flexbox for sizing, so a
		// display toggle alone is enough to give it correct dimensions once visible again. Our
		// `Grid`, however, is sized by explicit `layout(width, height)` calls; while `_groupElement`
		// was `display: none` (or not yet attached to a visible ancestor), `offsetWidth`/`offsetHeight`
		// read as 0, so any `Grid`/cell created or laid out during that time is pinned at a near-zero
		// size (only `minimumWidth`/`minimumHeight` get honored) until something explicitly re-lays it
		// out with the real, now-visible dimensions. Do that here so newly created terminal groups
		// (which start hidden until they become the active tab) actually render their content.
		if (visible && this._container) {
			this.layout(this._container.offsetWidth, this._container.offsetHeight);
		}

		this.terminalInstances.forEach(i => i.setVisible(visible));
	}

	split(shellLaunchConfig: IShellLaunchConfig): ITerminalInstance {
		const instance = this._terminalInstanceService.createInstance(shellLaunchConfig, TerminalLocation.Panel);
		this.addInstance(instance, shellLaunchConfig.parentTerminalId);
		this._setActiveInstance(instance);
		return instance;
	}

	addDisposable(disposable: IDisposable): void {
		this._register(disposable);
	}

	layout(width: number, height: number): void {
		if (this._gridContainer) {
			this._gridContainer.layout(width, height);
			if (this._initialRelativeSizes && this._visible) {
				this.resizePanes(this._initialRelativeSizes);
				this._initialRelativeSizes = undefined;
			}
		}
	}

	focusPreviousPane(): void {
		const newIndex = this._activeInstanceIndex === 0 ? this._terminalInstances.length - 1 : this._activeInstanceIndex - 1;
		this.setActiveInstanceByIndex(newIndex);
	}

	focusNextPane(): void {
		const newIndex = this._activeInstanceIndex === this._terminalInstances.length - 1 ? 0 : this._activeInstanceIndex + 1;
		this.setActiveInstanceByIndex(newIndex);
	}

	private _getPosition(): Position {
		switch (this._terminalLocation) {
			case ViewContainerLocation.Panel:
				return this._panelPosition;
			case ViewContainerLocation.Sidebar:
				return this._layoutService.getSideBarPosition();
			case ViewContainerLocation.AuxiliaryBar:
				return this._layoutService.getSideBarPosition() === Position.LEFT ? Position.RIGHT : Position.LEFT;
			default:
				return this._panelPosition;
		}
	}

	private _getOrientation(): Orientation {
		return isHorizontal(this._getPosition()) ? Orientation.HORIZONTAL : Orientation.VERTICAL;
	}

	resizePane(direction: Direction): void {
		if (!this._gridContainer) {
			return;
		}

		const isHorizontalResize = (direction === Direction.Left || direction === Direction.Right);

		const groupOrientation = this._getOrientation();

		const shouldResizePart =
			(isHorizontalResize && groupOrientation === Orientation.VERTICAL) ||
			(!isHorizontalResize && groupOrientation === Orientation.HORIZONTAL);

		const font = this._terminalConfigurationService.getFont(getWindow(this._groupElement));
		// TODO: Support letter spacing and line height
		const charSize = (isHorizontalResize ? font.charWidth : font.charHeight);

		if (charSize) {
			let resizeAmount = charSize * Constants.ResizePartCellCount;

			if (shouldResizePart) {

				const position = this._getPosition();
				const shouldShrink =
					(position === Position.LEFT && direction === Direction.Left) ||
					(position === Position.RIGHT && direction === Direction.Right) ||
					(position === Position.BOTTOM && direction === Direction.Down) ||
					(position === Position.TOP && direction === Direction.Up);

				if (shouldShrink) {
					resizeAmount *= -1;
				}

				this._layoutService.resizePart(this._paneCompositePartService.getPartId(this._terminalLocation), resizeAmount, resizeAmount);
			} else if (this.activeInstance) {
				this._resizeCellInDirection(this.activeInstance, direction, resizeAmount);
			}
		}
	}

	private _resizeCellInDirection(instance: ITerminalInstance, direction: Direction, amount: number): void {
		if (!this._gridContainer) {
			return;
		}
		const currentSize = this._gridContainer.getCellSize(instance);
		if (!currentSize) {
			return;
		}

		const isHorizontalResize = direction === Direction.Left || direction === Direction.Right;
		const shouldShrink = direction === Direction.Left || direction === Direction.Up;
		const signedAmount = shouldShrink ? -amount : amount;

		const nextWidth = isHorizontalResize ? Math.max(Constants.CellMinSize, currentSize.width + signedAmount) : currentSize.width;
		const nextHeight = isHorizontalResize ? currentSize.height : Math.max(Constants.CellMinSize, currentSize.height + signedAmount);

		this._gridContainer.resizeCell(instance, { width: nextWidth, height: nextHeight });
	}

	resizePanes(relativeSizes: number[]): void {
		if (!this._gridContainer || !this._visible) {
			this._initialRelativeSizes = relativeSizes;
			return;
		}

		// NOTE: `relativeSizes` was designed for a 1D `SplitView` and assumes a single ordered
		// axis; there is no lossless way to map it onto an arbitrary 2D grid layout, so restoring
		// exact proportions for grid groups is intentionally not supported here.
	}
}
