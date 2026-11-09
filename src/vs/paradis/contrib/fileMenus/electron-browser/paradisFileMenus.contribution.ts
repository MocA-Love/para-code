/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ファイル・フォルダの右クリックの共通の項目を、足りない場所にだけ足す（Q599 案 A）。
// 横に並べて開く・エクスプローラー ビューで表示・OS で表示（手元のみ）・ターミナルで開く（エディタエリア）・パスのコピー・
// 相対パスをコピー・ダウンロード（SSH のみ）・エージェントへ送る。
//
// upstream の登録は変えず、`MenuRegistry.appendMenuItem` で各 MenuId の末尾（その場所にすでにある group の末尾か、
// `zz_paradisFiles_*` の group）に足す。すでにその場所にある項目は足さない（二重に並ぶため）。
// 場所ごとの引数は common/paradisFileMenus.ts で URI の並びに直してから動く。
//
// ブランチの変更点（git 拡張のビュー）は拡張の側のコマンドが URI の配列にしてこのコマンドを呼ぶ。
// ターミナルのファイルのリンクは、右クリックした位置のリンク（terminalLinkMenu が控える）を対象にする。

import { Codicon } from '../../../../base/common/codicons.js';
import { Schemas } from '../../../../base/common/network.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { basename } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { ILocalizedString, localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IListService } from '../../../../platform/list/browser/listService.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { RemoteNameContext, ResourceContextKey } from '../../../../workbench/common/contextkeys.js';
import { REVEAL_IN_EXPLORER_COMMAND_ID } from '../../../../workbench/contrib/files/browser/fileConstants.js';
import { FileDownload } from '../../../../workbench/contrib/files/browser/fileImportExport.js';
import { getMultiSelectedResources, IExplorerService } from '../../../../workbench/contrib/files/browser/files.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService, SIDE_GROUP } from '../../../../workbench/services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IWorkingCopyService } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { paradisHandOffToSpaceAgent, paradisSpaceAgentHandoffServices } from '../../agentHandoff/electron-browser/paradisSpaceAgentHandoff.js';
import { paradisUsesBatchDownload } from '../../fileTransfer/common/paradisExplorerDownload.js';
import { ParadisBatchDownload } from '../../fileTransfer/electron-browser/paradisExplorerDownload.js';
import { IParadisTerminalLinkAtMouseService, PARADIS_TERMINAL_FILE_LINK_AT_MOUSE, PARADIS_TERMINAL_FOLDER_LINK_AT_MOUSE } from '../../terminalLinkMenu/browser/paradisTerminalLinkMenu.contribution.js';
import { paradisCommonFolder, ParadisFileMenuCommandId, paradisFilePathsPrompt, paradisResolveFileMenuTargets, paradisTerminalFolders, paradisToWindowUri } from '../common/paradisFileMenus.js';

//#region when

const SCHEME_FILE = ResourceContextKey.Scheme.isEqualTo(Schemas.file);
const SCHEME_REMOTE = ResourceContextKey.Scheme.isEqualTo(Schemas.vscodeRemote);
/** 手元か接続先のファイル（untitled・差分の git: などのパスの無いものを外す）。 */
const SCHEME_FILE_OR_REMOTE = ContextKeyExpr.or(SCHEME_FILE, SCHEME_REMOTE)!;
const LOCAL_WINDOW = RemoteNameContext.isEqualTo('');
const REMOTE_WINDOW = RemoteNameContext.notEqualsTo('');
const SCM_GIT = ContextKeyExpr.equals('scmProvider', 'git');
const SCM_UNTRACKED = ContextKeyExpr.equals('scmResourceGroup', 'untracked');
/** 検索のファイルの行・フォルダーの行（「その他のファイル」を除く）。upstream の「パスのコピー」と同じ条件。 */
const SEARCH_FILE_OR_FOLDER = ContextKeyExpr.has('fileMatchOrFolderMatchWithResourceFocus');
const SEARCH_FILE = ContextKeyExpr.has('fileMatchFocus');
const TERMINAL_FILE_LINK = PARADIS_TERMINAL_FILE_LINK_AT_MOUSE.isEqualTo(true);
const TERMINAL_FILE_ONLY_LINK = ContextKeyExpr.and(TERMINAL_FILE_LINK, PARADIS_TERMINAL_FOLDER_LINK_AT_MOUSE.negate());

/** fork が足す group（その場所の upstream の group より後ろに並ぶ名前）。 */
const GROUP_COPY = 'zz_paradisFiles_1copy';
const GROUP_DOWNLOAD = 'zz_paradisFiles_2download';
const GROUP_AGENT = 'zz_paradisFiles_3agent';
/** ターミナルの右クリックでは、URL のリンクの項目（0_0_paradisLink）と同じ先頭に置く。 */
const TERMINAL_GROUP_OPEN = '0_0_paradisLink';
const TERMINAL_GROUP_VIEW = '0_0_paradisLink_2';
const TERMINAL_GROUP_COPY = '0_0_paradisLink_3';
const TERMINAL_GROUP_TRANSFER = '0_0_paradisLink_4';

//#endregion

interface IParadisFileMenuItem {
	readonly id: MenuId;
	readonly group: string;
	readonly order: number;
	readonly when: ContextKeyExpression | undefined;
}

interface IParadisFileMenuOperation {
	readonly id: ParadisFileMenuCommandId;
	readonly title: ILocalizedString;
	readonly icon: ThemeIcon;
	readonly menus: readonly IParadisFileMenuItem[];
	/** ターミナルのファイルのリンクの右クリックに出すとき。 */
	readonly terminalLink?: { readonly group: string; readonly order: number; readonly when: ContextKeyExpression | undefined };
	/** `accessor` は await の前にだけ使う。 */
	run(accessor: ServicesAccessor, targets: readonly URI[]): Promise<void>;
}

/** 右クリックの引数を対象の URI の並びに直す（`accessor` は同期で読む）。 */
function resolveTargets(accessor: ServicesAccessor, args: readonly unknown[]): URI[] {
	const first = args[0];
	if (URI.isUri(first)) {
		// エクスプローラー・開いているエディター・タブ: upstream と同じ選び方（右クリックした項目を含む複数選択なら全部）
		return getMultiSelectedResources(first, accessor.get(IListService), accessor.get(IEditorService), accessor.get(IEditorGroupsService), accessor.get(IExplorerService));
	}
	const list = accessor.get(IListService).lastFocusedList;
	const remoteAuthority = accessor.get(IWorkbenchEnvironmentService).remoteAuthority;
	const targets = paradisResolveFileMenuTargets(args, list ? { focus: list.getFocus() as unknown[], selection: list.getSelection() as unknown[] } : undefined);
	return targets.map(uri => paradisToWindowUri(uri, remoteAuthority));
}

interface IParadisResolvedTarget {
	readonly resource: URI;
	readonly name: string;
	readonly isDirectory: boolean;
	/** 見つからない（削除されたファイルなど）。 */
	readonly missing: boolean;
}

async function statTargets(fileService: IFileService, targets: readonly URI[]): Promise<IParadisResolvedTarget[]> {
	const stats = await fileService.resolveAll(targets.map(resource => ({ resource })));
	return targets.map((resource, index) => {
		const stat = stats[index]?.success ? stats[index].stat : undefined;
		return stat
			? { resource: stat.resource, name: stat.name, isDirectory: stat.isDirectory, missing: false }
			: { resource, name: basename(resource), isDirectory: false, missing: true };
	});
}

async function copyPaths(accessor: ServicesAccessor, targets: readonly URI[], relative: boolean): Promise<void> {
	const labelService = accessor.get(ILabelService);
	const clipboardService = accessor.get(IClipboardService);
	const configurationService = accessor.get(IConfigurationService);
	if (!targets.length) {
		return;
	}
	// upstream の「パスのコピー」（fileCommands.ts の resourcesToClipboard）と同じ書き方・同じ区切りの設定
	const configured = configurationService.getValue<unknown>(relative ? 'explorer.copyRelativePathSeparator' : 'explorer.copyPathSeparator');
	const separator = configured === '/' || configured === '\\' ? configured : undefined;
	const text = targets.map(resource => labelService.getUriLabel(resource, { relative, noPrefix: true, separator })).join(isWindows ? '\r\n' : '\n');
	await clipboardService.writeText(text);
}

const OPERATIONS: readonly IParadisFileMenuOperation[] = [
	{
		id: ParadisFileMenuCommandId.OpenToSide,
		title: localize2('paradis.files.openToSide', "横に並べて開く"),
		icon: Codicon.splitHorizontal,
		menus: [
			{ id: MenuId.SCMResourceContext, group: 'navigation', order: 100, when: SCM_GIT },
			{ id: MenuId.SearchContext, group: 'navigation', order: 1, when: SEARCH_FILE },
		],
		terminalLink: { group: TERMINAL_GROUP_OPEN, order: 2, when: TERMINAL_FILE_ONLY_LINK },
		async run(accessor, targets) {
			const fileService = accessor.get(IFileService);
			const editorService = accessor.get(IEditorService);
			const files = (await statTargets(fileService, targets)).filter(target => !target.isDirectory);
			if (files.length) {
				await editorService.openEditors(files.map(target => ({ resource: target.resource, options: { pinned: true } })), SIDE_GROUP);
			}
		},
	},
	{
		id: ParadisFileMenuCommandId.RevealInExplorer,
		title: localize2('paradis.files.revealInExplorer', "エクスプローラー ビューで表示"),
		icon: Codicon.eye,
		menus: [
			{ id: MenuId.OpenEditorsContext, group: 'zz_paradisFiles_0view', order: 1, when: SCHEME_FILE_OR_REMOTE },
			{ id: MenuId.SCMResourceContext, group: '2_view', order: 2, when: ContextKeyExpr.and(SCM_GIT, SCM_UNTRACKED) },
			{ id: MenuId.SCMResourceFolderContext, group: '2_view', order: 2, when: SCM_GIT },
		],
		terminalLink: { group: TERMINAL_GROUP_VIEW, order: 1, when: TERMINAL_FILE_LINK },
		async run(accessor, targets) {
			// upstream と同じく、エクスプローラーで選べるのは 1 つ（先頭）
			const commandService = accessor.get(ICommandService);
			if (targets[0]) {
				await commandService.executeCommand(REVEAL_IN_EXPLORER_COMMAND_ID, targets[0]);
			}
		},
	},
	{
		id: ParadisFileMenuCommandId.RevealInOS,
		title: isWindows
			? localize2('paradis.files.revealInOS.windows', "エクスプローラーで表示する")
			: isMacintosh
				? localize2('paradis.files.revealInOS.mac', "Finder で表示する")
				: localize2('paradis.files.revealInOS.linux', "含まれているフォルダーを開く"),
		icon: Codicon.folderOpened,
		menus: [
			{ id: MenuId.SCMResourceContext, group: '2_view', order: 1, when: ContextKeyExpr.and(SCM_GIT, SCM_UNTRACKED, LOCAL_WINDOW) },
			{ id: MenuId.SCMResourceFolderContext, group: '2_view', order: 1, when: ContextKeyExpr.and(SCM_GIT, LOCAL_WINDOW) },
			{ id: MenuId.SearchContext, group: 'search_3', order: 2, when: ContextKeyExpr.and(SEARCH_FILE_OR_FOLDER, LOCAL_WINDOW) },
		],
		terminalLink: { group: TERMINAL_GROUP_VIEW, order: 2, when: ContextKeyExpr.and(TERMINAL_FILE_LINK, LOCAL_WINDOW) },
		async run(accessor, targets) {
			const nativeHostService = accessor.get(INativeHostService);
			for (const target of targets) {
				if (target.scheme === Schemas.file) {
					await nativeHostService.showItemInFolder(target.fsPath);
				}
			}
		},
	},
	{
		id: ParadisFileMenuCommandId.OpenInTerminal,
		title: localize2('paradis.files.openInTerminal', "ターミナルで開く"),
		icon: Codicon.terminal,
		menus: [
			// upstream の「統合ターミナルで開く」（パネルに開く。navigation の 30）のすぐ下
			{ id: MenuId.ExplorerContext, group: 'navigation', order: 31, when: SCHEME_FILE_OR_REMOTE },
			{ id: MenuId.OpenEditorsContext, group: 'zz_paradisFiles_0view', order: 2, when: SCHEME_FILE_OR_REMOTE },
			{ id: MenuId.EditorTitleContext, group: '2_files', order: 3, when: SCHEME_FILE_OR_REMOTE },
			{ id: MenuId.SCMResourceContext, group: '2_view', order: 3, when: SCM_GIT },
			{ id: MenuId.SCMResourceFolderContext, group: '2_view', order: 3, when: SCM_GIT },
			{ id: MenuId.SearchContext, group: 'search_3', order: 3, when: SEARCH_FILE_OR_FOLDER },
		],
		async run(accessor, targets) {
			const fileService = accessor.get(IFileService);
			const terminalService = accessor.get(ITerminalService);
			const folders = paradisTerminalFolders(await statTargets(fileService, targets));
			let last;
			for (const cwd of folders) {
				// 開き先はエディタエリア（利用者の「ターミナル」はエディタエリアのもの）。cwd を渡すのでスペースのフォルダには差し替わらない
				last = await terminalService.createTerminal({ cwd, location: TerminalLocation.Editor });
			}
			if (last) {
				terminalService.setActiveInstance(last);
				await last.focusWhenReady(true);
			}
		},
	},
	{
		id: ParadisFileMenuCommandId.CopyPath,
		title: localize2('paradis.files.copyPath', "パスのコピー"),
		icon: Codicon.link,
		menus: [
			{ id: MenuId.SCMResourceContext, group: GROUP_COPY, order: 1, when: SCM_GIT },
			{ id: MenuId.SCMResourceFolderContext, group: GROUP_COPY, order: 1, when: SCM_GIT },
		],
		terminalLink: { group: TERMINAL_GROUP_COPY, order: 1, when: TERMINAL_FILE_LINK },
		run: (accessor, targets) => copyPaths(accessor, targets, false),
	},
	{
		id: ParadisFileMenuCommandId.CopyRelativePath,
		title: localize2('paradis.files.copyRelativePath', "相対パスをコピー"),
		icon: Codicon.link,
		menus: [
			{ id: MenuId.SCMResourceContext, group: GROUP_COPY, order: 2, when: SCM_GIT },
			{ id: MenuId.SCMResourceFolderContext, group: GROUP_COPY, order: 2, when: SCM_GIT },
			// upstream の「パスのコピー」（search_2 の 2）と「すべてコピー」（3）の間
			{ id: MenuId.SearchContext, group: 'search_2', order: 2.5, when: SEARCH_FILE_OR_FOLDER },
		],
		terminalLink: { group: TERMINAL_GROUP_COPY, order: 2, when: TERMINAL_FILE_LINK },
		run: (accessor, targets) => copyPaths(accessor, targets, true),
	},
	{
		id: ParadisFileMenuCommandId.Download,
		title: localize2('paradis.files.download', "ダウンロード..."),
		icon: Codicon.cloudDownload,
		menus: [
			{ id: MenuId.OpenEditorsContext, group: GROUP_DOWNLOAD, order: 1, when: SCHEME_REMOTE },
			{ id: MenuId.SCMResourceContext, group: GROUP_DOWNLOAD, order: 1, when: ContextKeyExpr.and(SCM_GIT, REMOTE_WINDOW) },
			{ id: MenuId.SCMResourceFolderContext, group: GROUP_DOWNLOAD, order: 1, when: ContextKeyExpr.and(SCM_GIT, REMOTE_WINDOW) },
			{ id: MenuId.SearchContext, group: GROUP_DOWNLOAD, order: 1, when: ContextKeyExpr.and(SEARCH_FILE_OR_FOLDER, REMOTE_WINDOW) },
		],
		terminalLink: { group: TERMINAL_GROUP_TRANSFER, order: 1, when: ContextKeyExpr.and(TERMINAL_FILE_LINK, REMOTE_WINDOW) },
		async run(accessor, targets) {
			const fileService = accessor.get(IFileService);
			const workingCopyService = accessor.get(IWorkingCopyService);
			const notificationService = accessor.get(INotificationService);
			const instantiationService = accessor.get(IInstantiationService);
			if (!targets.length) {
				return;
			}
			if (targets.some(target => target.scheme !== Schemas.vscodeRemote)) {
				notificationService.info(localize('paradis.files.download.notRemote', "ダウンロードできるのは接続先（SSH など）のファイルだけです。"));
				return;
			}
			// 未保存の変更は接続先にまだ無いので、落とすと保存済みの内容になる。タブのダウンロードと同じく止める
			if (targets.some(target => workingCopyService.isDirty(target))) {
				notificationService.info(localize('paradis.files.download.dirty', "未保存の変更があるファイルが含まれています。保存してからダウンロードしてください。"));
				return;
			}
			const resolved = await statTargets(fileService, targets);
			const missing = resolved.filter(target => target.missing);
			const items = resolved.filter(target => !target.missing);
			if (missing.length) {
				notificationService.warn(localize('paradis.files.download.missing', "接続先に見つからないため、次のファイルはダウンロードしません（削除されたファイルなど）: {0}", missing.map(target => target.name).join(', ')));
			}
			if (!items.length) {
				return;
			}
			try {
				// SSH で 2 件以上なら、保存先のフォルダーを 1 回だけ聞いてまとめて落とす（エクスプローラーと同じ振り分け）
				if (paradisUsesBatchDownload(items)) {
					await instantiationService.createInstance(ParadisBatchDownload).download(items);
				} else {
					await instantiationService.createInstance(FileDownload).download(items);
				}
			} catch (error) {
				notificationService.error(error);
			}
		},
	},
	{
		id: ParadisFileMenuCommandId.SendToAgent,
		title: localize2('paradis.files.sendToAgent', "エージェントへ送る..."),
		icon: Codicon.send,
		menus: [
			{ id: MenuId.ExplorerContext, group: GROUP_AGENT, order: 1, when: SCHEME_FILE_OR_REMOTE },
			{ id: MenuId.OpenEditorsContext, group: GROUP_AGENT, order: 1, when: SCHEME_FILE_OR_REMOTE },
			// タブの「ファイル」の段（2_files）の次の段
			{ id: MenuId.EditorTitleContext, group: '2_files_paradisAgent', order: 1, when: SCHEME_FILE_OR_REMOTE },
			{ id: MenuId.SCMResourceContext, group: GROUP_AGENT, order: 1, when: SCM_GIT },
			{ id: MenuId.SCMResourceFolderContext, group: GROUP_AGENT, order: 1, when: SCM_GIT },
			{ id: MenuId.SearchContext, group: GROUP_AGENT, order: 1, when: SEARCH_FILE_OR_FOLDER },
		],
		terminalLink: { group: TERMINAL_GROUP_TRANSFER, order: 2, when: TERMINAL_FILE_LINK },
		async run(accessor, targets) {
			const services = paradisSpaceAgentHandoffServices(accessor);
			const labelService = accessor.get(ILabelService);
			if (!targets.length) {
				return;
			}
			// 今のスペースのフォルダからの相対パス（スペースの外なら絶対パス）を 1 行に 1 つ
			const paths = targets.map(resource => labelService.getUriLabel(resource, { relative: true, noPrefix: true }));
			await paradisHandOffToSpaceAgent(services, {
				prompt: paradisFilePathsPrompt(paths),
				placeholder: targets.length === 1
					? localize('paradis.files.sendToAgent.placeholder', "「{0}」のパスを送るエージェントを選んでください", basename(targets[0]))
					: localize('paradis.files.sendToAgent.placeholderMany', "{0} 件のパスを送るエージェントを選んでください", targets.length),
				// 全部を含むフォルダーが今のスペースの中に無ければ送らない（スペースの取り違えを防ぐ）
				expectedRoot: paradisCommonFolder(targets),
			});
		},
	},
];

for (const operation of OPERATIONS) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: operation.id,
				title: operation.title,
				icon: operation.icon,
				f1: false,
				menu: operation.menus.map(item => ({ id: item.id, group: item.group, order: item.order, when: item.when })),
			});
		}

		override run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
			return operation.run(accessor, resolveTargets(accessor, args));
		}
	});

	const terminalLink = operation.terminalLink;
	if (terminalLink) {
		const menu = { id: MenuId.TerminalInstanceContext, group: terminalLink.group, order: terminalLink.order, when: terminalLink.when };
		registerAction2(class extends Action2 {
			constructor() {
				super({
					id: `${operation.id}.terminalLink`,
					title: operation.title,
					icon: operation.icon,
					f1: false,
					menu,
				});
			}

			override run(accessor: ServicesAccessor): Promise<void> {
				const link = accessor.get(IParadisTerminalLinkAtMouseService).fileLink;
				return operation.run(accessor, link ? [link.resource] : []);
			}
		});
	}
}

// ターミナルのファイルのリンク: クリックと同じくエディタで開く（⌘クリックの代わり）
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.files.open.terminalLink',
			title: localize2('paradis.files.open', "ファイルを開く"),
			icon: Codicon.goToFile,
			f1: false,
			menu: { id: MenuId.TerminalInstanceContext, group: TERMINAL_GROUP_OPEN, order: 1, when: TERMINAL_FILE_ONLY_LINK },
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const link = accessor.get(IParadisTerminalLinkAtMouseService).fileLink;
		const editorService = accessor.get(IEditorService);
		if (link && !link.isDirectory) {
			await editorService.openEditor({ resource: link.resource, options: { pinned: true } });
		}
	}
});
