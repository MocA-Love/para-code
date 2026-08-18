/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// レイアウトプリセットの保存・読み出しと適用エンジン。
//
// 適用は2段構え。VS Code の applyLayout() は「枠の形」しか作れない（どのグループに何を開くかは
// 指定できない）ので、
//   1. applyLayout() でグリッドを組む
//   2. getGroups(GRID_APPEARANCE) で枠を左上から順に取り、枠ごとに中身を開く
// という順で埋める。1 と 2 のあいだで並びが一致することが前提なので、枠の列挙順は
// paradisFlattenLayoutSlots() と GRID_APPEARANCE で必ず揃える。
//
// electron-browser 層に置いているのは、内蔵ブラウザ（vscode-browser スキーム）のエディタ解決が
// electron-browser 側でしか登録されないため。web ビルドに載せると browser 枠だけが黙って開かない。

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isAbsolute } from '../../../../base/common/path.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { BrowserViewUri } from '../../../../platform/browserView/common/browserViewUri.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { GroupOrientation, GroupsOrder, IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { paradisResolveExternalPath } from '../../../common/paradisPathUri.js';
import { paradisPresetTitleConfig } from '../../terminalPresets/browser/paradisPresetService.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	IParadisApplyLayoutPresetOptions,
	IParadisLayoutPresetDefinition,
	IParadisLayoutPresetService,
	IParadisLayoutSlot,
	IParadisResolvedLayoutPreset,
	isValidLayoutPresetDefinition,
	ParadisLayoutApplyMode,
	paradisFlattenLayoutSlots,
	paradisLayoutGroupArguments,
	paradisLayoutOrientationValue,
	paradisLayoutPresetKey,
	paradisResolveLayoutPresetIndex,
	paradisUsableLayoutPresetId,
	PARADIS_LAYOUT_PRESETS_SETTING,
} from '../common/paradisLayoutPresets.js';

// allow-any-unicode-next-line
const STR_PRESET_GONE = localize('paradis.layoutPresets.gone', "このレイアウトプリセットは見つかりませんでした。設定が別の場所で変更された可能性があります。一覧を開き直してください。");

export class ParadisLayoutPresetService extends Disposable implements IParadisLayoutPresetService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangePresets = this._register(new Emitter<void>());
	readonly onDidChangePresets: Event<void> = this._onDidChangePresets.event;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisTerminalScopeService private readonly terminalScopeService: IParadisTerminalScopeService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_LAYOUT_PRESETS_SETTING)) {
				this._onDidChangePresets.fire();
			}
		}));
	}

	// --- 読み出し --------------------------------------------------------------------------------

	get presets(): readonly IParadisResolvedLayoutPreset[] {
		const raw = this.configurationService.getValue<unknown>(PARADIS_LAYOUT_PRESETS_SETTING);
		if (!Array.isArray(raw)) {
			return [];
		}
		const takenIds = new Set<string>();
		const resolved: IParadisResolvedLayoutPreset[] = [];
		raw.forEach((entry, index) => {
			if (!isValidLayoutPresetDefinition(entry)) {
				// 手書きの壊れたエントリは読み飛ばす。位置は詰めない——`sourceIndex` は
				// 設定配列そのものの添字であり、書き戻すときにこの添字で場所を決めるため。
				return;
			}
			const id = paradisUsableLayoutPresetId(entry, takenIds);
			resolved.push({
				...entry,
				id,
				sourceIndex: index,
				key: paradisLayoutPresetKey({ ...entry, id }, index),
			});
		});
		return resolved;
	}

	// --- 書き込み --------------------------------------------------------------------------------

	async savePreset(definition: IParadisLayoutPresetDefinition, replace?: IParadisResolvedLayoutPreset): Promise<string> {
		const raw = this.configurationService.getValue<unknown>(PARADIS_LAYOUT_PRESETS_SETTING);
		const list: unknown[] = Array.isArray(raw) ? [...raw] : [];
		// id は必ず採番して返す。呼び出し側が「今保存した1件」を後から引き直せる唯一の手がかりで、
		// 中身での照合は同名・同内容の双子があると別の1件を掴む。
		const id = (replace?.id ?? definition.id) || generateUuid();
		if (replace) {
			list[this._requirePresetIndex(list, replace)] = { ...definition, id };
		} else {
			list.push({ ...definition, id });
		}
		await this.configurationService.updateValue(PARADIS_LAYOUT_PRESETS_SETTING, list, {}, ConfigurationTarget.USER, { donotNotifyError: false });
		return id;
	}

	/**
	 * プリセットを1件だけ削除する。**名前で消さない**——同じ名前のプリセットが並んでいると
	 * 巻き添えで全部消える。
	 */
	async deletePreset(preset: IParadisResolvedLayoutPreset): Promise<void> {
		const raw = this.configurationService.getValue<unknown>(PARADIS_LAYOUT_PRESETS_SETTING);
		const list: unknown[] = Array.isArray(raw) ? [...raw] : [];
		list.splice(this._requirePresetIndex(list, preset), 1);
		await this.configurationService.updateValue(PARADIS_LAYOUT_PRESETS_SETTING, list, {}, ConfigurationTarget.USER, { donotNotifyError: false });
	}

	private _requirePresetIndex(list: readonly unknown[], preset: IParadisResolvedLayoutPreset): number {
		const index = paradisResolveLayoutPresetIndex(list, preset);
		if (index < 0) {
			throw new Error(STR_PRESET_GONE);
		}
		return index;
	}

	// --- 適用 ------------------------------------------------------------------------------------

	/**
	 * 適用先のエディタ部分（＝ウィンドウ）。
	 *
	 * **`IEditorGroupsService` を直接使ってはいけない。** 別ウィンドウのエディタ（補助エディタ
	 * ウィンドウ）が開いているとき、`applyLayout()` はアクティブな部分にしか効かないのに
	 * `getGroups()` は全ウィンドウ分を平らに返す（`GRID_APPEARANCE` は複数ウィンドウにまたがって
	 * 計算できない、と upstream 側にも明記されている）。この2つを混ぜると、枠と中身の対応が
	 * ずれて別ウィンドウにターミナルが開き、置き換え時には別ウィンドウのタブまで閉じてしまう。
	 */
	private get _targetPart(): IEditorPart {
		return this.editorGroupsService.getPart(this.editorGroupsService.activeGroup);
	}

	get openEditorCount(): number {
		return this._targetPart.groups.reduce((total, group) => total + group.count, 0);
	}

	/**
	 * 枠の数と実際に出来たグループの数がずれたときに知らせる。
	 *
	 * ここがずれると「指定した枠と違うところに中身が入り、あふれた分は黙って消える」という、
	 * 一見それらしく見えるのに間違っている結果になる。読み込み時の正規化で防いでいるつもりでも、
	 * 上流のグリッド側の都合が変わればまた起こりうるので、気づける形にしておく。
	 */
	private _warnOnSlotCountMismatch(presetName: string, slots: number, groups: number): void {
		if (slots === groups) {
			return;
		}
		this.logService.warn(`[ParadisLayoutPresets] slot/group count mismatch for '${presetName}': ${slots} slots vs ${groups} groups`);
		this.notificationService.warn(localize(
			'paradis.layoutPresets.slotCountMismatch',
			// allow-any-unicode-next-line
			"レイアウト「{0}」は{1}個の枠を指定していますが、作れた枠は{2}個でした。一部の枠の中身は開かれていません。",
			presetName,
			slots,
			groups,
		));
	}

	async applyPreset(preset: IParadisLayoutPresetDefinition, options: IParadisApplyLayoutPresetOptions): Promise<void> {
		const slots = paradisFlattenLayoutSlots(preset.root);
		if (slots.length === 0) {
			return;
		}
		const part = this._targetPart;
		// 枠を埋め切るまでには実時間で十数秒かかりうる。ターミナルの所属スペースは
		// createTerminal を呼んだ**その瞬間の**アクティブスコープで決まるので、途中で
		// ユーザーがスペースを切り替えると2枠目以降だけ別スペースに紐づく。始めた時点の
		// スペースを控えて、作った端末を明示的にそこへ付け替える。
		const stateKey = this.workspaceSwitchService.activeStateKey;

		if (options.mode === ParadisLayoutApplyMode.Replace && !await this._closeAllEditors(part)) {
			// 未保存の変更で閉じるのを取り消されたら、グリッドは組み替えずにここで止める。
			// ただし**それより前のグループで閉じ終わったタブは戻らない**（エディタを閉じる操作に
			// 取り消しは無い）。全部閉じられるかを先に確かめる手段が無いので、ここは
			// 「これ以上壊さない」までしかできない。
			return;
		}

		part.applyLayout({
			orientation: paradisLayoutOrientationValue(preset.orientation) === 1 ? GroupOrientation.VERTICAL : GroupOrientation.HORIZONTAL,
			groups: paradisLayoutGroupArguments(preset.root),
		});

		// applyLayout の直後は、グリッド上の並び（GRID_APPEARANCE）と葉の並びが1対1で対応する。
		// 既定の CREATION_TIME で取ると並びが一致せず、指定と違う枠に中身が入る。
		const groups = part.getGroups(GroupsOrder.GRID_APPEARANCE);
		this._warnOnSlotCountMismatch(preset.name, slots.length, groups.length);
		for (let index = 0; index < slots.length && index < groups.length; index++) {
			const group = groups[index];
			const slot = slots[index];
			if (slot.kind === 'empty') {
				continue;
			}
			// 枠を埋めるのは実時間で数秒かかる（特にターミナルのプロセス起動）。その間にユーザーが
			// その枠を閉じている可能性があるので、毎回まだ生きているか確かめてから開く。
			if (part.getGroup(group.id) !== group) {
				continue;
			}
			try {
				await this._fillSlot(group, slot, preset.name, stateKey);
			} catch (error) {
				// 1つの枠の失敗で残りを開かないのは損なので、続行して最後にまとめて知らせる。
				this.logService.warn(`[ParadisLayoutPresets] failed to fill slot ${index} (${slot.kind})`, error);
				this.notificationService.warn(localize(
					'paradis.layoutPresets.slotFailed',
					// allow-any-unicode-next-line
					"レイアウト「{0}」の{1}番目の枠を開けませんでした。",
					preset.name,
					index + 1,
				));
			}
		}

		part.getGroups(GroupsOrder.GRID_APPEARANCE)[0]?.focus();
	}

	/**
	 * 適用先のエディタ部分で開いているエディタをすべて閉じる。1つでも取り消されたら false。
	 * グループの配列は閉じている最中に縮むので、先に控えを取り、毎回まだ同じグループかを確かめる。
	 */
	private async _closeAllEditors(part: IEditorPart): Promise<boolean> {
		for (const group of [...part.getGroups(GroupsOrder.GRID_APPEARANCE)]) {
			if (part.getGroup(group.id) !== group) {
				continue;
			}
			if (!await group.closeAllEditors()) {
				return false;
			}
		}
		return true;
	}

	private async _fillSlot(group: IEditorGroup, slot: IParadisLayoutSlot, presetName: string, stateKey: string | undefined): Promise<void> {
		switch (slot.kind) {
			case 'terminal':
				return this._openTerminal(group, slot, presetName, stateKey);
			case 'browser':
				return this._openBrowser(group, slot);
			case 'file':
				return this._openFile(group, slot);
		}
	}

	private async _openTerminal(group: IEditorGroup, slot: IParadisLayoutSlot, presetName: string, stateKey: string | undefined): Promise<void> {
		const name = slot.name?.trim() || presetName;
		// 既知の制限: この名前は `titleTemplate` として渡るが、ターミナルの復元情報
		// （IPtyHostAttachTarget）には含まれないため、**ウィンドウをリロードすると `zsh` 等に戻る**。
		// コマンドプリセット側は永続プロセスIDとの対応表を自前で持って貼り直しているが、その台帳は
		// あちらの private なので共有していない。名前が消えても実害は表示だけなので、ここでは
		// 台帳を持たない選択をしている（`name` で渡すのは論外——OSC タイトルの購読が張られなくなり、
		// エージェントCLIの判別が全部効かなくなる。paradisPresetTitleConfig のコメント参照）。
		const instance = await this.terminalService.createTerminal({
			config: paradisPresetTitleConfig(name),
			cwd: this._resolveCwd(slot.cwd),
			location: { viewColumn: group.id },
			// 目的の枠をグループIDではなくオブジェクト同一性で保証する。ここを view column の
			// 数値解決に任せると、生成中に別のグループが増減したときに隣の枠へ入りうる。
			paradisExactEditorGroup: group,
			// 拡張機能が提供するプロファイルは IPC を数値の view column でしか渡せず、
			// 上の同一性保証を維持できない。ユーザーのレイアウト適用を失敗させるより、
			// 解決済みの組み込み既定シェルで開く（paradisEditorSplitTerminalService と同じ判断）。
			skipContributedProfileCheck: true,
		});

		if (stateKey) {
			// 生成〜表示のあいだにユーザーが別スペースへ切り替えても、既定の（生成時点で
			// アクティブなスコープへの）暗黙タグ付けを明示的に上書きし、始めたスペースへ紐付ける。
			this.terminalScopeService.assignInstanceScope(instance.instanceId, stateKey);
		}

		const command = slot.command?.trim();
		if (!command) {
			return;
		}
		await instance.processReady;
		if (instance.isDisposed) {
			return;
		}
		await instance.sendText(command, true);
	}

	private async _openBrowser(group: IEditorGroup, slot: IParadisLayoutSlot): Promise<void> {
		// 内蔵ブラウザは vscode-browser スキームのエディタ解決経由で開く。**必ず明示的に
		// グループを渡す**——省略すると paradis.browser.newTabPlacement（sideGroup/window）や
		// workbench.editor.useModal の既定経路が横取りし、狙った枠に入らない。
		await this.editorService.openEditor({
			resource: BrowserViewUri.forId(generateUuid()),
			options: { viewState: { url: slot.url?.trim() || undefined }, pinned: true },
		}, group);
	}

	private async _openFile(group: IEditorGroup, slot: IParadisLayoutSlot): Promise<void> {
		const resource = this._resolveFile(slot.path);
		if (!resource) {
			return;
		}
		await this.editorService.openEditor({ resource, options: { pinned: true } }, group);
	}

	/**
	 * 作業ディレクトリを解決する。相対はワークスペースフォルダ基準。
	 * 絶対指定でも基準フォルダと同じ名前空間で解決する（リモートや UNC のワークスペースで
	 * ローカルの file: を強制すると開けない cwd になる）。
	 */
	private _resolveCwd(spec: string | undefined): URI | undefined {
		const folder = this.contextService.getWorkspace().folders[0]?.uri;
		const cwd = spec?.trim();
		if (!cwd) {
			return folder;
		}
		if (isAbsolute(cwd)) {
			return (folder && paradisResolveExternalPath(folder, cwd)) ?? URI.file(cwd);
		}
		return folder ? joinPath(folder, cwd) : undefined;
	}

	/** ファイル枠のパスを解決する。可搬性のため保存はワークスペースフォルダ相対を推奨している。 */
	private _resolveFile(spec: string | undefined): URI | undefined {
		const path = spec?.trim();
		if (!path) {
			return undefined;
		}
		const folder = this.contextService.getWorkspace().folders[0]?.uri;
		if (isAbsolute(path)) {
			return (folder && paradisResolveExternalPath(folder, path)) ?? URI.file(path);
		}
		return folder ? joinPath(folder, path) : undefined;
	}
}
