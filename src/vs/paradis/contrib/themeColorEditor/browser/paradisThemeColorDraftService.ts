/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// テーマの色エディタの下書き（未保存の変更）を持つサービス。
//
// 変更はすぐ設定のメモリ層（ConfigurationTarget.MEMORY）へ書く。メモリ層への書き込みはディスクに触れず
// 変更イベントだけを出すので（configurationService.ts の writeConfigurationValue）、テーマサービスが
// 色を作り直し、エディタの文字色やターミナルまで含めて実際の画面が変わる。「保存」でユーザー設定の
// 今のテーマ用スコープ（"[テーマ名]"）へ移し、メモリ層は編集前の値へ戻す。「破棄」はメモリ層を戻すだけ。
// 下書きはテーマごとに持つ（スコープが別なので、テーマを切り替えても混ざらない）。
//
// 保存は「下書きで変えた所だけ」を保存時点のユーザー設定に当てる。編集中に settings.json の手編集や
// 別のウィンドウで入った変更は残す。textMateRules（配列）は部分的に当てられないので、編集中に
// 他所でも変わっていたら上書きしてよいか確認する。保存中に入った編集は消さずに下書きとして残す。

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InMemoryStorageService } from '../../../../platform/storage/common/storage.js';
import { IColorTheme, IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ColorThemeData } from '../../../../workbench/services/themes/common/colorThemeData.js';
import {
	IParadisColorLayers,
	IParadisJsonObject,
	paradisApplyColorEdits,
	paradisBuildMemoryValue,
	paradisBuildScopedPreview,
	paradisColorPreviewValue,
	paradisJsonEquals,
	paradisMergeScopedEdits,
	paradisReadExactScope,
	paradisReplaceExactScope,
	paradisThemeSpecificValues,
	PARADIS_COLOR_CUSTOMIZATIONS_KEY,
	PARADIS_SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS_KEY,
	PARADIS_TOKEN_COLOR_CUSTOMIZATIONS_KEY,
} from '../common/paradisThemeColorModel.js';

/** シンタックスの色の下書きの種類。 */
export type ParadisScopedDraftKind = 'token' | 'semantic';

const SCOPED_KINDS: readonly ParadisScopedDraftKind[] = ['token', 'semantic'];

const SCOPED_KEYS: { readonly [K in ParadisScopedDraftKind]: string } = {
	token: PARADIS_TOKEN_COLOR_CUSTOMIZATIONS_KEY,
	semantic: PARADIS_SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS_KEY,
};

/** 1 段深く差分を取るキー（セマンティックの rules はオブジェクトなので規則ごとに当てる）。 */
const SCOPED_NESTED: { readonly [K in ParadisScopedDraftKind]: readonly string[] } = {
	token: [],
	semantic: ['rules'],
};

const ALL_KEYS = [PARADIS_COLOR_CUSTOMIZATIONS_KEY, PARADIS_TOKEN_COLOR_CUSTOMIZATIONS_KEY, PARADIS_SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS_KEY];

interface IScopedDraft {
	/** 編集を始めた時点（または最後に保存した時点）のユーザー設定の中身。差分の基準。 */
	readonly original: IParadisJsonObject;
	readonly draft: IParadisJsonObject;
}

export const IParadisThemeColorDraftService = createDecorator<IParadisThemeColorDraftService>('paradisThemeColorDraftService');

export interface IParadisThemeColorDraftService {
	readonly _serviceBrand: undefined;

	/** 下書きが変わったとき（件数・値）。 */
	readonly onDidChange: Event<void>;

	/** 下書き以外（settings.json の手編集など）で設定の層が変わったとき。 */
	readonly onDidChangeLayers: Event<void>;

	/** 未保存の変更の件数（UI の色は 1 色 1 件、シンタックスの色はテーマ・種類ごとに 1 件）。 */
	readonly dirtyCount: number;

	/** 設定の層の値（色の出どころの判定に使う）。 */
	getLayers(key: string): IParadisColorLayers;

	/** テーマの色（設定の上書きを除いた、テーマそのものの色）を読むための複製。 */
	getThemeSnapshot(): ColorThemeData | undefined;

	/** UI の色の下書き。無ければ undefined。値が undefined の下書きは「ユーザーの値を消す」。 */
	getColorEdit(settingsId: string, colorId: string): { readonly save: string | undefined } | undefined;

	/** 下書きのある色 ID。 */
	getColorEditIds(settingsId: string): string[];

	/** UI の色を変える（save が undefined ならユーザーの値を消す）。すぐ画面に反映する。 */
	setColor(settingsId: string, colorId: string, save: string | undefined): void;

	/** この色の下書きを取り消す（保存済みの状態に戻す）。 */
	dropColorEdit(settingsId: string, colorId: string): void;

	/** シンタックスの色の、今のテーマのスコープの中身（下書きがあれば下書き）。 */
	getScopedDraft(kind: ParadisScopedDraftKind, settingsId: string): IParadisJsonObject;

	/** 保存済みの中身（下書きの比較元）。 */
	getScopedOriginal(kind: ParadisScopedDraftKind, settingsId: string): IParadisJsonObject;

	/** シンタックスの色のスコープの中身を差し替える。すぐ画面に反映する。 */
	setScopedDraft(kind: ParadisScopedDraftKind, settingsId: string, draft: IParadisJsonObject): void;

	/**
	 * ユーザー設定へ書き、メモリ層を編集前に戻す。保存を始めた時点の下書きだけを片付け、保存中に入った
	 * 編集は残す。確認で上書きをやめたときは何も書かずに false を返す。
	 */
	save(): Promise<boolean>;

	/** 下書きを全部捨て、メモリ層を編集前に戻す。 */
	discard(): void;

	/** 保存の直前に呼ぶ処理を登録する（カラーピッカーが間引き中の最後の値を下書きへ入れるため）。 */
	registerFlushParticipant(flush: () => void): IDisposable;
}

export class ParadisThemeColorDraftService extends Disposable implements IParadisThemeColorDraftService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _onDidChangeLayers = this._register(new Emitter<void>());
	readonly onDidChangeLayers: Event<void> = this._onDidChangeLayers.event;

	private readonly colorDrafts = new Map<string, Map<string, string | undefined>>();
	private readonly scopedDrafts: { readonly [K in ParadisScopedDraftKind]: Map<string, IScopedDraft> } = { token: new Map(), semantic: new Map() };
	/** 編集を始める前のメモリ層の値（キーごと）。下書きが無くなったらこれに戻す。 */
	private readonly baseMemory = new Map<string, unknown>();

	private snapshot: { readonly theme: IColorTheme; readonly data: ColorThemeData | undefined } | undefined;
	/** 保存の前に、間引き中の値を下書きへ入れてもらう相手（カラーピッカー）。 */
	private readonly flushParticipants = new Set<() => void>();
	/** 自分のメモリ層への書き込み中（そのときのテーマの作り直しでは、テーマの複製を捨てない）。 */
	private writingPreview = false;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IThemeService private readonly themeService: IThemeService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			// 自分のメモリ層への書き込みでは作り直さない。settings.json の手での変更などで下の層が
			// 変わったら、プレビューの値（Para Code の既定を見せるか、null で隠すか）を計算し直す。
			if (e.source === ConfigurationTarget.MEMORY) {
				return;
			}
			let affected = false;
			for (const key of ALL_KEYS) {
				if (e.affectsConfiguration(key)) {
					affected = true;
					if (this.baseMemory.has(key)) {
						this.writePreview(key);
					}
				}
			}
			if (affected) {
				this._onDidChangeLayers.fire();
			}
		}));
		// テーマのファイルが変わって読み直されたときなどに、テーマの色の複製を作り直す。
		this._register(this.themeService.onDidColorThemeChange(() => {
			if (!this.writingPreview) {
				this.snapshot = undefined;
			}
		}));
	}

	get dirtyCount(): number {
		let count = 0;
		for (const edits of this.colorDrafts.values()) {
			count += edits.size;
		}
		for (const kind of SCOPED_KINDS) {
			for (const draft of this.scopedDrafts[kind].values()) {
				if (!paradisJsonEquals(draft.original, draft.draft)) {
					count++;
				}
			}
		}
		return count;
	}

	getLayers(key: string): IParadisColorLayers {
		const inspected = this.configurationService.inspect<unknown>(key);
		return { paraDefault: inspected.defaultValue, user: inspected.userValue, workspace: inspected.workspaceValue };
	}

	getThemeSnapshot(): ColorThemeData | undefined {
		const theme = this.themeService.getColorTheme();
		if (this.snapshot?.theme !== theme) {
			this.snapshot = { theme, data: createThemeSnapshot(theme) };
		}
		return this.snapshot.data;
	}

	getColorEdit(settingsId: string, colorId: string): { readonly save: string | undefined } | undefined {
		const edits = this.colorDrafts.get(settingsId);
		return edits?.has(colorId) ? { save: edits.get(colorId) } : undefined;
	}

	getColorEditIds(settingsId: string): string[] {
		return [...(this.colorDrafts.get(settingsId)?.keys() ?? [])];
	}

	setColor(settingsId: string, colorId: string, save: string | undefined): void {
		let edits = this.colorDrafts.get(settingsId);
		if (!edits) {
			edits = new Map();
			this.colorDrafts.set(settingsId, edits);
		}
		edits.set(colorId, save);
		// 保存済みの値と同じに戻ったら、下書きとして数えない。
		const saved = paradisReadExactScope(this.getUserBase(PARADIS_COLOR_CUSTOMIZATIONS_KEY), settingsId)[colorId];
		if ((typeof saved === 'string' ? saved : undefined)?.toLowerCase() === save?.toLowerCase()) {
			edits.delete(colorId);
		}
		if (!edits.size) {
			this.colorDrafts.delete(settingsId);
		}
		this.changed(PARADIS_COLOR_CUSTOMIZATIONS_KEY);
	}

	dropColorEdit(settingsId: string, colorId: string): void {
		const edits = this.colorDrafts.get(settingsId);
		if (edits?.delete(colorId)) {
			if (!edits.size) {
				this.colorDrafts.delete(settingsId);
			}
			this.changed(PARADIS_COLOR_CUSTOMIZATIONS_KEY);
		}
	}

	getScopedDraft(kind: ParadisScopedDraftKind, settingsId: string): IParadisJsonObject {
		return this.scopedDrafts[kind].get(settingsId)?.draft ?? this.getScopedOriginal(kind, settingsId);
	}

	getScopedOriginal(kind: ParadisScopedDraftKind, settingsId: string): IParadisJsonObject {
		return this.scopedDrafts[kind].get(settingsId)?.original ?? paradisReadExactScope(this.getUserBase(SCOPED_KEYS[kind]), settingsId);
	}

	setScopedDraft(kind: ParadisScopedDraftKind, settingsId: string, draft: IParadisJsonObject): void {
		const drafts = this.scopedDrafts[kind];
		const original = this.getScopedOriginal(kind, settingsId);
		if (paradisJsonEquals(original, draft)) {
			drafts.delete(settingsId);
		} else {
			drafts.set(settingsId, { original, draft });
		}
		this.changed(SCOPED_KEYS[kind]);
	}

	registerFlushParticipant(flush: () => void): IDisposable {
		this.flushParticipants.add(flush);
		return toDisposable(() => this.flushParticipants.delete(flush));
	}

	async save(): Promise<boolean> {
		// ピッカーが間引いて持っている最後の値を、下書きへ入れてから保存する。
		for (const flush of [...this.flushParticipants]) {
			flush();
		}
		// 保存を始めた時点の下書き。保存中（書き込みを待つ間）に入った編集と見分けるために取っておく。
		const colorSnapshot = new Map([...this.colorDrafts].map(([settingsId, edits]) => [settingsId, new Map(edits)] as const));
		const scopedSnapshot = { token: new Map(this.scopedDrafts.token), semantic: new Map(this.scopedDrafts.semantic) };

		// 確認ダイアログを出している間にも settings.json は変わりうるので、確認のあとは今の値から作り直す。
		// 作り直して新しい競合が出たら、もう一度だけでなく、確認していない競合が無くなるまで聞く。
		const confirmed = new Set<string>();
		let plan = this.planSave(colorSnapshot, scopedSnapshot);
		while (plan.conflicts.some(conflict => !confirmed.has(conflict))) {
			const result = await this.dialogService.confirm({
				message: localize('paradis.themeColors.conflict', "編集中に、ほかの所でもシンタックスの色の規則が変わっています。下書きで上書きしますか？"),
				detail: localize('paradis.themeColors.conflictDetail', "対象: {0}。上書きすると、ほかの所で入った規則の変更は消えます。", plan.conflicts.join(', ')),
				primaryButton: localize('paradis.themeColors.conflictOverwrite', "上書きして保存"),
			});
			if (!result.confirmed) {
				return false;
			}
			plan.conflicts.forEach(conflict => confirmed.add(conflict));
			plan = this.planSave(colorSnapshot, scopedSnapshot);
		}
		const { writes, savedScoped } = plan;

		// ユーザー設定を先に書いてからメモリ層を戻す（逆だと一瞬だけ元の色に戻って見える）。
		for (const write of writes) {
			await this.configurationService.updateValue(write.key, write.value, ConfigurationTarget.USER);
		}

		// 保存した下書きだけを片付ける。保存中に値が変わった色・スコープは下書きとして残す。
		for (const [settingsId, edits] of colorSnapshot) {
			const current = this.colorDrafts.get(settingsId);
			for (const [colorId, value] of edits) {
				if (current?.has(colorId) && current.get(colorId) === value) {
					current.delete(colorId);
				}
			}
			if (current && !current.size) {
				this.colorDrafts.delete(settingsId);
			}
		}
		for (const kind of SCOPED_KINDS) {
			for (const [settingsId, draft] of scopedSnapshot[kind]) {
				const current = this.scopedDrafts[kind].get(settingsId);
				if (current === draft) {
					this.scopedDrafts[kind].delete(settingsId);
				} else if (current) {
					// 残った下書きの基準を保存した中身にする（次の保存で同じ差分を二度当てたり、
					// 自分の保存を「ほかの所での変更」と取り違えたりしないため）。
					const original = savedScoped[kind].get(settingsId) ?? current.original;
					if (paradisJsonEquals(original, current.draft)) {
						this.scopedDrafts[kind].delete(settingsId);
					} else {
						this.scopedDrafts[kind].set(settingsId, { original, draft: current.draft });
					}
				}
			}
		}
		for (const key of [...this.baseMemory.keys()]) {
			this.writePreview(key);
		}
		this._onDidChange.fire();
		return true;
	}

	/** 保存時点（呼んだ時点）のユーザー設定に、保存する下書きを当てた書き込みの一覧を作る。 */
	private planSave(colorSnapshot: ReadonlyMap<string, ReadonlyMap<string, string | undefined>>, scopedSnapshot: { readonly [K in ParadisScopedDraftKind]: ReadonlyMap<string, IScopedDraft> }) {
		const writes: { key: string; value: unknown }[] = [];
		const savedScoped = { token: new Map<string, IParadisJsonObject>(), semantic: new Map<string, IParadisJsonObject>() };
		const conflicts: string[] = [];
		if (colorSnapshot.size) {
			let value = this.getUserBase(PARADIS_COLOR_CUSTOMIZATIONS_KEY);
			for (const [settingsId, edits] of colorSnapshot) {
				value = paradisApplyColorEdits(value, settingsId, edits);
			}
			writes.push({ key: PARADIS_COLOR_CUSTOMIZATIONS_KEY, value });
		}
		for (const kind of SCOPED_KINDS) {
			const drafts = scopedSnapshot[kind];
			if (!drafts.size) {
				continue;
			}
			let value = this.getUserBase(SCOPED_KEYS[kind]);
			for (const [settingsId, draft] of drafts) {
				const merge = paradisMergeScopedEdits(paradisReadExactScope(value, settingsId), draft.original, draft.draft, SCOPED_NESTED[kind]);
				conflicts.push(...merge.conflicts.map(key => `"[${settingsId}]".${key}`));
				savedScoped[kind].set(settingsId, merge.merged);
				value = paradisReplaceExactScope(value, settingsId, merge.merged);
			}
			writes.push({ key: SCOPED_KEYS[kind], value });
		}
		return { writes, savedScoped, conflicts };
	}

	discard(): void {
		this.colorDrafts.clear();
		this.scopedDrafts.token.clear();
		this.scopedDrafts.semantic.clear();
		for (const key of [...this.baseMemory.keys()]) {
			this.writePreview(key);
		}
		this._onDidChange.fire();
	}

	/**
	 * ユーザー設定の書き込み先の値。リモート接続中でリモートのユーザー設定に値があればそちらへ書かれるので
	 * （configurationService.ts の toEditableConfigurationTarget）、読む側も合わせる。
	 */
	private getUserBase(key: string): unknown {
		const inspected = this.configurationService.inspect<unknown>(key);
		return inspected.userRemoteValue !== undefined ? inspected.userRemoteValue : inspected.userLocalValue;
	}

	private changed(key: string): void {
		this.writePreview(key);
		this._onDidChange.fire();
	}

	/** そのキーのメモリ層を、今の下書きに合わせて書き直す。下書きが無ければ編集前の値に戻す。 */
	private writePreview(key: string): void {
		const previews = this.buildPreviews(key);
		if (!this.baseMemory.has(key)) {
			if (!previews.size) {
				return;
			}
			this.baseMemory.set(key, this.configurationService.inspect<unknown>(key).memoryValue);
		}
		const base = this.baseMemory.get(key);
		if (!previews.size) {
			this.baseMemory.delete(key);
		}
		this.writingPreview = true;
		try {
			this.configurationService.updateValue(key, paradisBuildMemoryValue(base, previews), ConfigurationTarget.MEMORY).catch(onUnexpectedError);
		} finally {
			this.writingPreview = false;
		}
	}

	private buildPreviews(key: string): Map<string, IParadisJsonObject> {
		const previews = new Map<string, IParadisJsonObject>();
		const layers = this.getLayers(key);
		if (key === PARADIS_COLOR_CUSTOMIZATIONS_KEY) {
			for (const [settingsId, edits] of this.colorDrafts) {
				const preview: IParadisJsonObject = {};
				for (const [colorId, save] of edits) {
					preview[colorId] = paradisColorPreviewValue(layers, settingsId, colorId, save);
				}
				previews.set(settingsId, preview);
			}
			return previews;
		}
		const kind = SCOPED_KINDS.find(k => SCOPED_KEYS[k] === key);
		if (kind) {
			for (const [settingsId, draft] of this.scopedDrafts[kind]) {
				// ワークスペースの値は保存後も勝つので、プレビューでも同じキーはワークスペースの値を見せる。
				const workspace = paradisThemeSpecificValues(layers.workspace, settingsId);
				previews.set(settingsId, paradisBuildScopedPreview(draft.original, draft.draft, SCOPED_NESTED[kind], workspace));
			}
		}
		return previews;
	}
}

/**
 * 今のテーマから、設定の上書きを除いた複製を作る。ColorThemeData はテーマそのものの色（colorMap）を
 * 外に出さないが、保存用の書き出し（toStorage）は colorMap とテーマのトークン規則を含むので、
 * それをメモリ上の保存先へ書いて読み戻す（fromStorageData は上書きを持たない複製を返す）。
 */
function createThemeSnapshot(theme: IColorTheme): ColorThemeData | undefined {
	if (!(theme instanceof ColorThemeData)) {
		return undefined;
	}
	const storage = new InMemoryStorageService();
	try {
		theme.toStorage(storage);
		return ColorThemeData.fromStorageData(storage);
	} finally {
		storage.dispose();
	}
}
