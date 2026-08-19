/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as path from 'path';
import {
	commands, Disposable, Event, EventEmitter, FileDecoration, FileDecorationProvider, l10n, LogOutputChannel, Memento,
	ThemeColor, ThemeIcon, TreeDataProvider, TreeItem, TreeItemCollapsibleState, TreeView, Uri, window, workspace
} from 'vscode';
import type { Change } from './api/git';
import { Status } from './api/git.constants';
import type { Model } from './model';
import { getBranchDiffState, IParaBranchDiffState, onDidChangeBranchDiff, refreshBranchDiff, selectBranchDiffBase } from './paraBranchDiff';
import { Resource, type Repository } from './repository';
import { debounce } from './decorators';
import { toMultiFileDiffEditorUris } from './uri';
import { dispose } from './util';

const PARA_BRANCH_DIFF_VIEW_ID = 'git.paraBranchDiff';

/**
 * Scheme of the `resourceUri` handed to the tree. It has to differ from `file:` so that the
 * explorer's git decorations — which describe the *working tree* — do not paint their letter onto
 * a row that means "changed since the base branch". {@link ParaBranchDiffDecorationProvider}
 * decorates this scheme instead.
 */
const DECORATION_SCHEME = 'para-branch-diff';

/** Source URI of the multi diff editor opened by "Open All Changes". Never resolved, only keyed. */
const MULTI_DIFF_SCHEME = 'para-branch-diff-multi';

type ViewMode = 'tree' | 'list';
type SortKey = 'name' | 'path' | 'status';

const VIEW_MODE_KEY = 'paraBranchDiff.viewMode';
const SORT_KEY_KEY = 'paraBranchDiff.sortKey';

interface IFileEntry {
	readonly repository: Repository;
	readonly base: IParaBranchDiffState['base'];
	readonly change: Change;
	/** Path of the file relative to the repository root, always with forward slashes. */
	readonly relativePath: string;
	readonly name: string;
	/** Directory of {@link relativePath}, `''` for a file at the repository root. */
	readonly dirname: string;
}

interface IRepositoryNode {
	readonly kind: 'repository';
	readonly repository: Repository;
	readonly base: IParaBranchDiffState['base'];
	readonly count: number;
}

interface IFolderNode {
	readonly kind: 'folder';
	readonly repository: Repository;
	/** Path of the folder relative to the repository root, always with forward slashes. */
	readonly relativePath: string;
	readonly label: string;
	readonly children: Node[];
}

interface IFileNode {
	readonly kind: 'file';
	readonly entry: IFileEntry;
}

interface IMessageNode {
	readonly kind: 'message';
	readonly repository: Repository;
	readonly id: string;
	readonly label: string;
}

type Node = IRepositoryNode | IFolderNode | IFileNode | IMessageNode;

/** A repository with something to show, together with the rows derived from it. */
interface IVisibleRepository {
	readonly repository: Repository;
	readonly state: IParaBranchDiffState;
	readonly entries: readonly IFileEntry[];
}

/** Sorting thousands of rows through `String.localeCompare` rebuilds a collator on every call. */
const collator = new Intl.Collator(undefined, { numeric: true });

function isFileNode(node: unknown): node is IFileNode {
	return !!node && (node as IFileNode).kind === 'file';
}

/**
 * Order used when sorting by status. Files whose content changed come first, because those are
 * what a reviewer actually reads; pure additions and deletions are skimmed.
 */
function statusPriority(status: Status): number {
	switch (status) {
		case Status.INDEX_MODIFIED:
		case Status.MODIFIED:
			return 0;
		case Status.INDEX_RENAMED:
			return 1;
		case Status.INDEX_ADDED:
			return 2;
		case Status.INDEX_DELETED:
		case Status.DELETED:
			return 3;
		default:
			return 4;
	}
}

/**
 * Deliberately not `Resource.getStatusText()`: that speaks the vocabulary of the working tree, so
 * it answers "Index Added" for a file this branch simply added. Nothing here is staged.
 */
function statusText(status: Status): string {
	switch (status) {
		case Status.INDEX_MODIFIED:
		case Status.MODIFIED:
			// allow-any-unicode-next-line
			return l10n.t('変更');
		case Status.INDEX_ADDED:
			// allow-any-unicode-next-line
			return l10n.t('追加');
		case Status.INDEX_DELETED:
		case Status.DELETED:
			// allow-any-unicode-next-line
			return l10n.t('削除');
		case Status.INDEX_RENAMED:
			// allow-any-unicode-next-line
			return l10n.t('名前変更');
		default:
			return '';
	}
}

/**
 * Deliberately not `Resource.getStatusColor()`: that paints an index modification in the "staged"
 * colour, which would read as "already staged" on a row that only means "changed since the base".
 */
function statusColor(status: Status): ThemeColor | undefined {
	switch (status) {
		case Status.INDEX_MODIFIED:
		case Status.MODIFIED:
			return new ThemeColor('gitDecoration.modifiedResourceForeground');
		case Status.INDEX_ADDED:
			return new ThemeColor('gitDecoration.addedResourceForeground');
		case Status.INDEX_DELETED:
		case Status.DELETED:
			return new ThemeColor('gitDecoration.deletedResourceForeground');
		case Status.INDEX_RENAMED:
			return new ThemeColor('gitDecoration.renamedResourceForeground');
		default:
			return undefined;
	}
}

/**
 * The URI a row is decorated and icon-matched by. Built from the real path so that two
 * repositories contributing the same relative path stay distinct, and so that the file icon theme
 * still resolves the extension.
 */
function toDecorationUri(entry: IFileEntry): Uri {
	return Uri.file(entry.change.uri.fsPath).with({ scheme: DECORATION_SCHEME });
}

/**
 * Paints the status letter on the right of each row. Registered for {@link DECORATION_SCHEME}
 * only, so the explorer and the working tree keep the decorations they already had.
 */
class ParaBranchDiffDecorationProvider implements FileDecorationProvider {

	private readonly _onDidChangeFileDecorations = new EventEmitter<Uri[]>();
	readonly onDidChangeFileDecorations: Event<Uri[]> = this._onDidChangeFileDecorations.event;

	private decorations = new Map<string, FileDecoration>();
	private readonly disposables: Disposable[] = [];

	constructor() {
		this.disposables.push(window.registerFileDecorationProvider(this));
	}

	provideFileDecoration(uri: Uri): FileDecoration | undefined {
		return uri.scheme === DECORATION_SCHEME ? this.decorations.get(uri.toString()) : undefined;
	}

	update(entries: readonly IFileEntry[]): void {
		const next = new Map<string, FileDecoration>();

		for (const entry of entries) {
			const badge = Resource.getStatusLetter(entry.change.status);
			if (!badge) {
				continue;
			}

			next.set(toDecorationUri(entry).toString(), {
				badge,
				color: statusColor(entry.change.status),
				tooltip: statusText(entry.change.status)
			});
		}

		// Every URI that was decorated before or is decorated now has to be invalidated: the ones
		// that disappeared would otherwise keep their old letter.
		const changed = new Set([...this.decorations.keys(), ...next.keys()]);
		this.decorations = next;
		this._onDidChangeFileDecorations.fire([...changed].map(value => Uri.parse(value, true)));
	}

	dispose(): void {
		dispose(this.disposables);
		this._onDidChangeFileDecorations.dispose();
	}
}

/**
 * Backs the "Changes Since &lt;base branch&gt;" view — an independent section of the Source
 * Control container that sits below the graph, rather than a resource group nested inside the
 * Changes pane.
 *
 * The view is hidden entirely (via the `git.paraBranchDiff.hasChanges` context key, which its
 * `when` clause reads) whenever no repository has a meaningful base branch comparison, so the
 * section does not sit there empty.
 */
class ParaBranchDiffView implements TreeDataProvider<Node>, Disposable {

	private readonly _onDidChangeTreeData = new EventEmitter<void>();
	readonly onDidChangeTreeData: Event<void> = this._onDidChangeTreeData.event;

	private readonly treeView: TreeView<Node>;
	private readonly decorationProvider = new ParaBranchDiffDecorationProvider();
	private disposables: Disposable[] = [];

	private viewMode: ViewMode;
	private sortKey: SortKey;
	private disposed = false;

	/**
	 * Repositories that currently have something to show, in the order the model reports them.
	 * Recomputed on every refresh so that the view title, the badge and the context key never
	 * disagree with the rows.
	 */
	private visible: IVisibleRepository[] = [];

	constructor(
		private readonly model: Model,
		private readonly storage: Memento,
		private readonly logger: LogOutputChannel
	) {
		this.viewMode = this.storage.get<ViewMode>(VIEW_MODE_KEY) === 'list' ? 'list' : 'tree';
		this.sortKey = ((): SortKey => {
			const stored = this.storage.get<SortKey>(SORT_KEY_KEY);
			return stored === 'name' || stored === 'status' ? stored : 'path';
		})();

		this.treeView = window.createTreeView<Node>(PARA_BRANCH_DIFF_VIEW_ID, { treeDataProvider: this, showCollapseAll: true });
		this.disposables.push(this.treeView, this.decorationProvider, this._onDidChangeTreeData);

		this.disposables.push(onDidChangeBranchDiff(() => this.refresh()));
		this.disposables.push(this.model.onDidOpenRepository(() => this.refresh()));
		// Parking a repository fires this too, which is exactly when its rows have to disappear.
		this.disposables.push(this.model.onDidCloseRepository(() => this.refresh()));

		this.registerCommands();
		this.setViewModeContext();
		this.refresh();
	}

	private registerCommands(): void {
		this.disposables.push(
			commands.registerCommand('git.paraBranchDiffRefresh', () => {
				// Every repository, not just the visible ones: re-resolving a base branch that could
				// not be resolved before is the whole point of pressing refresh after a fetch.
				// `visible` is a subset of this, so resetting it separately would only make each
				// repository run its base/merge-base/diff round twice.
				for (const repository of this.model.repositories) {
					refreshBranchDiff(repository);
				}
			}),
			commands.registerCommand('git.paraBranchDiffSetViewModeTree', () => this.setViewMode('tree')),
			commands.registerCommand('git.paraBranchDiffSetViewModeList', () => this.setViewMode('list')),
			commands.registerCommand('git.paraBranchDiffSort', () => this.pickSortKey()),
			commands.registerCommand('git.paraBranchDiffOpenChanges', (node?: Node) => this.openChanges(node)),
			commands.registerCommand('git.paraBranchDiffOpenFile', (node?: Node) => this.openFile(node)),
			commands.registerCommand('git.paraBranchDiffViewAll', (node?: Node) => this.openAllChanges(node))
		);
	}

	/** Entry point for the base branch command, which stays registered even without a view. */
	selectBase(node?: Node): Promise<void> {
		return selectBranchDiffBase(this.model, this.logger, this.repositoryOf(node));
	}

	/**
	 * The repository a command should act on. A title bar command is handed the focused row rather
	 * than nothing, so every node kind has to answer — otherwise pressing a toolbar button after
	 * clicking a file would look like it was pressed on no repository at all.
	 *
	 * `undefined` means "could not tell", which leaves the caller to ask.
	 */
	private repositoryOf(node?: Node): Repository | undefined {
		switch (node?.kind) {
			case 'repository':
			case 'folder':
				return node.repository;
			case 'file':
				return node.entry.repository;
			case 'message':
				return node.repository;
			default:
				return this.visible.length === 1 ? this.visible[0].repository : undefined;
		}
	}

	private setViewMode(mode: ViewMode): void {
		if (this.viewMode === mode) {
			return;
		}

		this.viewMode = mode;
		void this.storage.update(VIEW_MODE_KEY, mode);
		this.setViewModeContext();
		this._onDidChangeTreeData.fire();
	}

	/**
	 * A quick pick rather than three menu entries, because an extension cannot put a check mark on
	 * a contributed menu item — the only alternative is hiding the active one, which leaves no way
	 * to see what the list is currently sorted by.
	 */
	private async pickSortKey(): Promise<void> {
		const items: { label: string; key: SortKey; description?: string }[] = [
			// allow-any-unicode-next-line
			{ label: l10n.t('ファイル名'), key: 'name' },
			// allow-any-unicode-next-line
			{ label: l10n.t('パス'), key: 'path' },
			// allow-any-unicode-next-line
			{ label: l10n.t('変更の種類'), key: 'status' }
		];

		for (const item of items) {
			if (item.key === this.sortKey) {
				// allow-any-unicode-next-line
				item.description = l10n.t('現在の並び順');
			}
		}

		// allow-any-unicode-next-line
		const pick = await window.showQuickPick(items, { placeHolder: l10n.t('並べ替えの基準を選択') });
		if (pick) {
			this.setSortKey(pick.key);
		}
	}

	private setSortKey(key: SortKey): void {
		if (this.sortKey === key) {
			return;
		}

		this.sortKey = key;
		void this.storage.update(SORT_KEY_KEY, key);
		this._onDidChangeTreeData.fire();
	}

	/** Drives which of the two view mode entries the "View & Sort" menu offers. */
	private setViewModeContext(): void {
		commands.executeCommand('setContext', 'git.paraBranchDiff.viewMode', this.viewMode);
	}

	/**
	 * Recollects what every repository has to show. Debounced because a single `git status` makes
	 * each repository fire its own change, and a workspace switch makes all of them fire at once.
	 */
	@debounce(100)
	private refresh(): void {
		// The debounce timer outlives dispose(), and writing to a disposed TreeView throws.
		if (this.disposed) {
			return;
		}

		this.visible = [];

		for (const repository of this.model.repositories) {
			const state = getBranchDiffState(repository);
			if (state && state.changes.length > 0) {
				this.visible.push({ repository, state, entries: this.entriesOf(repository, state) });
			}
		}

		const total = this.visible.reduce((sum, { entries }) => sum + entries.length, 0);

		commands.executeCommand('setContext', 'git.paraBranchDiff.hasChanges', this.visible.length > 0);

		this.decorationProvider.update(this.visible.flatMap(({ entries }) => entries));

		// With one repository the base branch belongs in the view header, where it explains every
		// row at once. With several it would be a lie, so each repository row carries its own.
		//
		// The count goes here rather than into `treeView.badge`, which is not a per-view badge at
		// all: it is summed into the Source Control activity badge together with the number of
		// pending changes, which would make that badge mean nothing. The header is also the only
		// place a count survives the view being collapsed, which is how it always first appears.
		this.treeView.description = this.visible.length === 1
			// allow-any-unicode-next-line
			? l10n.t('{0} 以降 · {1} 件', this.visible[0].state.base.label, total)
			// allow-any-unicode-next-line
			: (this.visible.length > 1 ? l10n.t('{0} 個のリポジトリ · {1} 件', this.visible.length, total) : undefined);

		this._onDidChangeTreeData.fire();
	}

	private entriesOf(repository: Repository, state: IParaBranchDiffState): IFileEntry[] {
		return state.changes.map(change => {
			const relativePath = path.relative(repository.root, change.uri.fsPath).replace(/\\/g, '/');
			const slash = relativePath.lastIndexOf('/');

			return {
				repository,
				base: state.base,
				change,
				relativePath,
				name: slash === -1 ? relativePath : relativePath.slice(slash + 1),
				dirname: slash === -1 ? '' : relativePath.slice(0, slash)
			};
		});
	}

	private compare(one: IFileEntry, other: IFileEntry): number {
		switch (this.sortKey) {
			case 'name': {
				const byName = collator.compare(one.name, other.name);
				return byName !== 0 ? byName : collator.compare(one.relativePath, other.relativePath);
			}
			case 'status': {
				const byStatus = statusPriority(one.change.status) - statusPriority(other.change.status);
				return byStatus !== 0 ? byStatus : collator.compare(one.relativePath, other.relativePath);
			}
			default:
				return collator.compare(one.relativePath, other.relativePath);
		}
	}

	// #region TreeDataProvider

	getChildren(element?: Node): Node[] {
		if (!element) {
			if (this.visible.length === 0) {
				return [];
			}

			// A single repository is the overwhelmingly common case, and wrapping its files in one
			// node the user always has to expand would be pure ceremony.
			if (this.visible.length === 1) {
				return this.childrenOf(this.visible[0]);
			}

			return this.visible.map(({ repository, state, entries }) => ({
				kind: 'repository',
				repository,
				base: state.base,
				count: entries.length
			} satisfies IRepositoryNode));
		}

		switch (element.kind) {
			case 'repository': {
				const found = this.visible.find(candidate => candidate.repository === element.repository);
				return found ? this.childrenOf(found) : [];
			}
			case 'folder':
				return element.children;
			default:
				return [];
		}
	}

	private childrenOf({ repository, state, entries }: IVisibleRepository): Node[] {
		const sorted = [...entries].sort((one, other) => this.compare(one, other));

		const nodes: Node[] = this.viewMode === 'list'
			? sorted.map(entry => ({ kind: 'file', entry } satisfies IFileNode))
			: this.buildTree(repository, sorted);

		if (state.truncated) {
			nodes.push({
				kind: 'message',
				repository,
				id: `truncated:${repository.root}`,
				// allow-any-unicode-next-line
				label: l10n.t('変更が多すぎるため、一部のファイルのみ表示しています')
			});
		}

		return nodes;
	}

	/**
	 * Groups the files by directory, collapsing chains of single-child folders into one row the
	 * way the explorer does, so that a deep package does not cost five clicks to reach.
	 */
	private buildTree(repository: Repository, entries: readonly IFileEntry[]): Node[] {
		interface Dir {
			readonly dirs: Map<string, Dir>;
			readonly files: IFileEntry[];
		}

		const root: Dir = { dirs: new Map(), files: [] };

		for (const entry of entries) {
			let current = root;

			if (entry.dirname !== '') {
				for (const segment of entry.dirname.split('/')) {
					let next = current.dirs.get(segment);
					if (!next) {
						next = { dirs: new Map(), files: [] };
						current.dirs.set(segment, next);
					}
					current = next;
				}
			}

			current.files.push(entry);
		}

		const toNodes = (dir: Dir, prefix: string): Node[] => {
			const folders: IFolderNode[] = [];

			for (const [name, child] of dir.dirs) {
				let label = name;
				let compacted = child;
				let relativePath = prefix === '' ? name : `${prefix}/${name}`;

				// A folder that holds nothing but a single folder is not worth a row of its own.
				while (compacted.files.length === 0 && compacted.dirs.size === 1) {
					const [onlyName, onlyChild] = [...compacted.dirs][0];
					label = `${label}/${onlyName}`;
					relativePath = `${relativePath}/${onlyName}`;
					compacted = onlyChild;
				}

				folders.push({
					kind: 'folder',
					repository,
					relativePath,
					label,
					children: toNodes(compacted, relativePath)
				});
			}

			// Compared by full path rather than by label: a compacted label such as `a/b` would
			// otherwise sort against `ab` in a way that depends on the locale's slash handling.
			folders.sort((one, other) => collator.compare(one.relativePath, other.relativePath));

			// `entries` arrived sorted, and grouping preserved that order within each directory.
			const files: IFileNode[] = dir.files.map(entry => ({ kind: 'file', entry }));

			return [...folders, ...files];
		};

		return toNodes(root, '');
	}

	getTreeItem(element: Node): TreeItem {
		switch (element.kind) {
			case 'repository':
				return this.repositoryTreeItem(element);
			case 'folder':
				return this.folderTreeItem(element);
			case 'file':
				return this.fileTreeItem(element);
			case 'message': {
				const item = new TreeItem(element.label, TreeItemCollapsibleState.None);
				item.id = element.id;
				item.iconPath = new ThemeIcon('info');
				item.contextValue = 'paraBranchDiffMessage';
				return item;
			}
		}
	}

	private repositoryTreeItem(node: IRepositoryNode): TreeItem {
		const item = new TreeItem(path.basename(node.repository.root), TreeItemCollapsibleState.Expanded);
		item.id = `repository:${node.repository.root}`;
		item.iconPath = new ThemeIcon('repo');
		// allow-any-unicode-next-line
		item.description = l10n.t('{0} 以降 · {1} 件', node.base.label, node.count);
		item.tooltip = node.repository.root;
		item.contextValue = 'paraBranchDiffRepository';
		return item;
	}

	private folderTreeItem(node: IFolderNode): TreeItem {
		const item = new TreeItem(node.label, TreeItemCollapsibleState.Expanded);
		item.id = `folder:${node.repository.root}:${node.relativePath}`;
		// Same scheme as the file rows, and for the same reason: a `file:` URI here would let the
		// working tree's decorations propagate up onto the folder (they are created with
		// `propagate = true`), so a folder would describe uncommitted work inside a view that is
		// about the base branch. The folder icon comes from the path, not the scheme.
		item.resourceUri = Uri.file(path.join(node.repository.root, node.relativePath)).with({ scheme: DECORATION_SCHEME });
		item.contextValue = 'paraBranchDiffFolder';
		return item;
	}

	private fileTreeItem(node: IFileNode): TreeItem {
		const { entry } = node;
		const item = new TreeItem(toDecorationUri(entry), TreeItemCollapsibleState.None);

		item.id = `file:${entry.repository.root}:${entry.relativePath}`;
		item.label = entry.name;
		// In tree mode the folder rows already say where the file is, so repeating the directory
		// on every row would only push the status letter off the edge.
		item.description = this.viewMode === 'list' ? entry.dirname : undefined;
		item.contextValue = 'paraBranchDiffFile';
		item.tooltip = entry.change.status === Status.INDEX_RENAMED
			? `${entry.relativePath}\n${statusText(entry.change.status)}: ${path.relative(entry.repository.root, entry.change.originalUri.fsPath).replace(/\\/g, '/')}`
			: `${entry.relativePath}\n${statusText(entry.change.status)}`;
		// `title` is never rendered for a row's default command, so it stays unlocalized rather
		// than duplicating the string the menu entry already carries.
		item.command = { command: 'git.paraBranchDiffOpenChanges', title: 'Open Changes', arguments: [node] };

		return item;
	}

	// #endregion

	// #region commands

	private async openChanges(node?: Node): Promise<void> {
		if (!isFileNode(node)) {
			return;
		}

		const { entry } = node;
		const { originalUri, modifiedUri } = toMultiFileDiffEditorUris(entry.change, entry.base.commit, 'HEAD');
		// allow-any-unicode-next-line
		const title = l10n.t('{0} ({1} 以降)', entry.name, entry.base.label);

		// Both sides are `git:` URIs read out of the object database, so they exist even when the
		// file does not: nothing to guard against here beyond a file that only exists on one side,
		// which has nothing to diff and is opened on its own instead.
		if (originalUri && modifiedUri) {
			await commands.executeCommand('vscode.diff', originalUri, modifiedUri, title);
		} else if (modifiedUri ?? originalUri) {
			await commands.executeCommand('vscode.open', modifiedUri ?? originalUri);
		}
	}

	/** Opens the file as it is on disk now, which is what "Open File" means everywhere else. */
	private async openFile(node?: Node): Promise<void> {
		if (!isFileNode(node)) {
			return;
		}

		const { entry } = node;

		// Decided from the status rather than from a failed open: `vscode.open` swallows the error
		// and puts a "file not found" editor on screen, so waiting for it to throw says nothing.
		if (entry.change.status === Status.DELETED || entry.change.status === Status.INDEX_DELETED) {
			// allow-any-unicode-next-line
			window.showInformationMessage(l10n.t('「{0}」は、このブランチが削除したファイルです。', entry.relativePath));
			return;
		}

		await commands.executeCommand('vscode.open', entry.change.uri);
	}

	private async openAllChanges(node?: Node): Promise<void> {
		// Asking rather than refusing, so that the button behaves like "Select Base Branch" right
		// next to it when several repositories have something to show.
		const repository = this.repositoryOf(node) ?? await this.model.pickRepository();
		const target = repository && this.visible.find(candidate => candidate.repository === repository);

		if (!target) {
			return;
		}

		const { state } = target;
		const resources = state.changes.map(change => toMultiFileDiffEditorUris(change, state.base.commit, 'HEAD'));

		if (resources.length === 0) {
			return;
		}

		await commands.executeCommand('_workbench.openMultiDiffEditor', {
			multiDiffSourceUri: Uri.from({ scheme: MULTI_DIFF_SCHEME, path: `${repository.root}/${state.base.commit}..HEAD` }),
			// allow-any-unicode-next-line
			title: l10n.t('{0} 以降の変更 ({1})', state.base.label, path.basename(repository.root)),
			resources
		});
	}

	// #endregion

	dispose(): void {
		this.disposed = true;
		commands.executeCommand('setContext', 'git.paraBranchDiff.hasChanges', false);
		this.disposables = dispose(this.disposables);
	}
}

/**
 * Wires the view up. The view itself only exists while `git.paraBranchDiff.enabled` is on, but the
 * base branch command stays registered either way: a keybinding is not filtered by the `when`
 * clause of a command palette entry, so an unregistered command would answer "command not found".
 */
export function registerParaBranchDiffView(model: Model, storage: Memento, logger: LogOutputChannel): Disposable {
	let view: ParaBranchDiffView | undefined;

	const update = () => {
		// The setting is `resource` scoped, so a multi-root workspace can enable it for one folder
		// and not another. The view exists as soon as anybody wants it; the per-repository check in
		// the provider decides whose rows actually appear.
		const enabled = (workspace.workspaceFolders ?? [{ uri: undefined }])
			.some(folder => workspace.getConfiguration('git', folder.uri).get<boolean>('paraBranchDiff.enabled', true));

		if (enabled && !view) {
			view = new ParaBranchDiffView(model, storage, logger);
		} else if (!enabled && view) {
			view.dispose();
			view = undefined;
		}
	};

	const listeners = [
		commands.registerCommand('git.paraSelectBranchDiffBase', (node?: Node) =>
			view ? view.selectBase(node) : selectBranchDiffBase(model, logger, undefined)),
		workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('git.paraBranchDiff.enabled')) {
				update();
			}
		}),
		workspace.onDidChangeWorkspaceFolders(() => update())
	];

	update();

	return {
		dispose: () => {
			dispose(listeners);
			view?.dispose();
			view = undefined;
		}
	};
}
