/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// レイアウトプリセット機能の共通型定義。
//
// プリセットは「エディタエリアの枠の形」と「各枠に何を開くか」を宣言的に持つ。適用時にその形へ
// グリッドを組み直し、枠ごとにターミナル・内蔵ブラウザ・ファイルを新規に開く。
//
// **開いているものの写しではない**。ワークスペースの Editor Working Set は「今そこに居る具体的な
// インスタンス」（ターミナルの永続プロセス、ブラウザの view id）を指すため、別のスペースで再生すると
// 「新しく起動する」ではなく「そのプロセスを復元しようとする」意味になってしまう。プリセットは
// 常に宣言（コマンド・URL・パス）だけを持ち、実体は適用のたびに作り直す。

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** 設定キー（ユーザーレベルのレイアウトプリセット定義）。 */
export const PARADIS_LAYOUT_PRESETS_SETTING = 'paradis.editor.layoutPresets';

/**
 * 1つのプリセットが持てる枠の数の上限。
 * 枠1つにつきターミナルのプロセスが1本立ち上がりうるので、手が滑って巨大な木を書いたときに
 * 何十個ものシェルが起動するのを防ぐ。超える定義は読み込み時に捨てる（黙って切り詰めない——
 * 切り詰めると「保存したはずの枠が消えている」という分かりにくい壊れ方をする）。
 */
export const PARADIS_LAYOUT_MAX_SLOTS = 16;

/**
 * 枠の入れ子の深さの上限（ルートの子を深さ1と数える）。
 * 深い木は画面上で意味を持たないうえ、再帰処理の停止性を保証するために要る。
 */
export const PARADIS_LAYOUT_MAX_DEPTH = 5;

/**
 * ルートの並べ方。
 *   - columns: ルートの子が左右に並ぶ（VS Code の GroupOrientation.HORIZONTAL）
 *   - rows: ルートの子が上下に並ぶ（GroupOrientation.VERTICAL）
 * 入れ子の子は常に親と直交する向きに並ぶ（VS Code のグリッドと同じ規則）。
 */
export const PARADIS_LAYOUT_ORIENTATIONS = ['columns', 'rows'] as const;
export type ParadisLayoutOrientation = typeof PARADIS_LAYOUT_ORIENTATIONS[number];

/** 枠に開くものの種類。 */
export const PARADIS_LAYOUT_SLOT_KINDS = ['empty', 'terminal', 'browser', 'file'] as const;
export type ParadisLayoutSlotKind = typeof PARADIS_LAYOUT_SLOT_KINDS[number];

/** 1つの枠に開くものの宣言。 */
export interface IParadisLayoutSlot {
	readonly kind: ParadisLayoutSlotKind;
	/** terminal: 起動直後に送るコマンド。未指定ならシェルを開くだけ。 */
	readonly command?: string;
	/** terminal: 作業ディレクトリ。相対ならワークスペースフォルダ基準。 */
	readonly cwd?: string;
	/** terminal: タブのタイトル。未指定はプリセット名。 */
	readonly name?: string;
	/** browser: 開く URL。未指定なら空のタブ。 */
	readonly url?: string;
	/** file: 開くファイル。相対ならワークスペースフォルダ基準（可搬性のため相対で保存する）。 */
	readonly path?: string;
}

/**
 * レイアウトの木。VS Code の `GroupLayoutArgument` と同じ形にしてあり、`slot` を落とすだけで
 * `applyLayout()` へ渡せる（{@link paradisLayoutGroupArguments}）。
 *
 * `children` を持つノードは分岐（子は親と直交する向きに並ぶ）、持たないノードは葉＝1つの枠。
 */
export interface IParadisLayoutNode {
	/**
	 * 同じ行／列の中での比率（相対値。同じ親の子の合計が全体になるよう正規化される）。
	 * GUI のキャンバスは等分でしか作らないが、設定を手で書けば指定できるので、
	 * GUI で編集し直しても消えないように保持する。
	 */
	readonly size?: number;
	/** 分岐ノード: 親と直交する向きに並ぶ子。 */
	readonly children?: readonly IParadisLayoutNode[];
	/** 葉ノード: この枠に開くもの。`children` があるときは無視される。 */
	readonly slot?: IParadisLayoutSlot;
}

/** プリセット定義（settings.json に書かれる形そのまま）。 */
export interface IParadisLayoutPresetDefinition {
	/**
	 * このプリセットの識別子。**名前は識別子ではない**（同じ名前のプリセットを複数登録できる）。
	 * GUI で保存するときは自動で採番する。改名しても同じプリセットとして追跡でき、同名が並んでも
	 * 削除・並び替えが取り違えない。
	 */
	readonly id?: string;
	/** 表示名。同名の重複を許す。 */
	readonly name: string;
	readonly description?: string;
	/** 一覧に出す codicon 名（例: "layout"）。未指定は "layout"。 */
	readonly icon?: string;
	/** ルートの並べ方。未指定は columns。 */
	readonly orientation?: ParadisLayoutOrientation;
	/** ルート直下のノード列。最低1つの葉を含む。 */
	readonly root: readonly IParadisLayoutNode[];
}

/** 設定から読み出して位置とキーを解決したプリセット。 */
export interface IParadisResolvedLayoutPreset extends IParadisLayoutPresetDefinition {
	/**
	 * 設定配列における位置。保存・削除・並び替えはこの位置を使う。
	 * **名前で探さない**（同名が並びうるため）。
	 */
	readonly sourceIndex: number;
	/** メニュー登録などに使う安定キー。id があれば id 由来、無ければ位置由来。 */
	readonly key: string;
}

/** プリセット適用時の既存エディタの扱い。 */
export const enum ParadisLayoutApplyMode {
	/** 開いているエディタをすべて閉じてから、プリセットの枠だけにする。 */
	Replace = 'replace',
	/** 開いているエディタを残したまま、プリセットの枠を重ねて適用する。 */
	Add = 'add',
}

export interface IParadisApplyLayoutPresetOptions {
	readonly mode: ParadisLayoutApplyMode;
}

export const IParadisLayoutPresetService = createDecorator<IParadisLayoutPresetService>('paradisLayoutPresetService');

export interface IParadisLayoutPresetService {
	readonly _serviceBrand: undefined;

	/** 有効なプリセット集合が変わったとき。 */
	readonly onDidChangePresets: Event<void>;

	/** 現在有効なプリセット（設定の並び順）。 */
	readonly presets: readonly IParadisResolvedLayoutPreset[];

	/**
	 * 適用先のウィンドウで今開いているエディタの数。適用前の確認を出すかどうかの判断に使う。
	 * **全ウィンドウの合計ではない**——別ウィンドウのタブを数えて確認を出しても、
	 * 適用でそれらが変わるわけではないので、ユーザーに関係のない選択を迫ることになる。
	 */
	readonly openEditorCount: number;

	/**
	 * プリセットを適用する。既存エディタの扱い（置き換え／追加）は呼び出し側が決める。
	 * 枠の生成に失敗したものは飛ばし、残りの枠は開き切る。
	 */
	applyPreset(preset: IParadisLayoutPresetDefinition, options: IParadisApplyLayoutPresetOptions): Promise<void>;

	/**
	 * プリセットを保存する。
	 * `replace` を渡したときだけ既存の1件を置き換え、渡さなければ新しい1件として追加する。
	 *
	 * @returns 保存した1件の id。**呼び出し側はこれで自分の1件を引き直すこと。**
	 *   指紋で探すと、名前も形も中身も同じ「双子」が既にあるときに他人の1件を掴む
	 *   （指紋は id を含まないので双子は区別できない）。
	 */
	savePreset(definition: IParadisLayoutPresetDefinition, replace?: IParadisResolvedLayoutPreset): Promise<string>;

	/** プリセットを設定から削除する。 */
	deletePreset(preset: IParadisResolvedLayoutPreset): Promise<void>;
}

// --- 木の走査 ------------------------------------------------------------------------------------

/** 分岐ノードか（＝子を1つ以上持つか）。 */
export function paradisIsLayoutBranch(node: IParadisLayoutNode): boolean {
	return Array.isArray(node.children) && node.children.length > 0;
}

/**
 * 葉＝枠を、VS Code の `GroupsOrder.GRID_APPEARANCE` と同じ深さ優先の順で列挙する。
 *
 * この順序が命綱で、`applyLayout()` の直後に `getGroups(GRID_APPEARANCE)` で取った配列と
 * 1対1で対応する。**`GroupsOrder` の既定（CREATION_TIME）で取ると並びが一致せず、
 * 指定と違う枠に中身が入る。**
 */
export function paradisFlattenLayoutSlots(nodes: readonly IParadisLayoutNode[]): IParadisLayoutSlot[] {
	const slots: IParadisLayoutSlot[] = [];
	const visit = (list: readonly IParadisLayoutNode[]): void => {
		for (const node of list) {
			if (paradisIsLayoutBranch(node)) {
				visit(node.children!);
			} else {
				slots.push(node.slot ?? { kind: 'empty' });
			}
		}
	};
	visit(nodes);
	return slots;
}

/** 葉＝枠の総数。 */
export function paradisCountLayoutSlots(nodes: readonly IParadisLayoutNode[]): number {
	return paradisFlattenLayoutSlots(nodes).length;
}

/**
 * 木を正規化する: 子が1つだけの分岐を、その子で置き換える（再帰的に）。
 *
 * **これを通さないと枠と中身の対応が1つずつずれる。** VS Code のグリッドは、ルート以外の
 * 「子が1つだけの分岐」を葉に潰す（`grid.ts` の `sanitizeGridNodeDescriptor`）。潰されると
 * 実際に作られる枠の数が {@link paradisFlattenLayoutSlots} の数より少なくなり、以降の枠すべてに
 * ひとつ後ろの中身が入って、末尾の中身は黙って捨てられる。GUI の操作では単一子の分岐は
 * 作られないが、設定を手で書けば到達できるので、読み込んだ時点で必ず正規化する。
 */
export function paradisNormalizeLayoutNodes(nodes: readonly IParadisLayoutNode[]): readonly IParadisLayoutNode[] {
	const result: IParadisLayoutNode[] = [];
	for (const node of nodes) {
		if (!paradisIsLayoutBranch(node)) {
			result.push(node);
			continue;
		}
		const children = paradisNormalizeLayoutNodes(node.children!);
		if (children.length === 0) {
			continue;
		}
		if (children.length === 1) {
			// 1つに畳むときは、畳まれる側の比率ではなく分岐が持っていた比率を引き継ぐ
			// （分岐が親の中で占めていた幅こそが、この枠の幅になるため）。
			result.push(node.size === undefined ? withoutSize(children[0]) : { ...children[0], size: node.size });
			continue;
		}
		result.push({ ...node, children });
	}
	return result;
}

/** 比率のキーごと落とす（`size: undefined` を残さない——形の比較に余計な差が出る）。 */
export function withoutSize(node: IParadisLayoutNode): IParadisLayoutNode {
	if (node.size === undefined) {
		return node;
	}
	const { size, ...rest } = node;
	return rest;
}

/**
 * `IEditorGroupsService.applyLayout()` が受け取る `GroupLayoutArgument` と同じ形。
 * workbench 層の型を common 層へ持ち込まずに済ませるため、構造だけを写して持つ。
 */
export interface IParadisGroupLayoutArgument {
	size?: number;
	groups?: IParadisGroupLayoutArgument[];
}

/**
 * `IEditorGroupsService.applyLayout()` へ渡す形に変換する。
 * 形の情報（size / children）だけを残し、中身（slot）は落とす——枠の形と中身は別々に適用するため。
 */
export function paradisLayoutGroupArguments(nodes: readonly IParadisLayoutNode[]): IParadisGroupLayoutArgument[] {
	return nodes.map(node => {
		// size が未指定のときはキーごと落とす。`{ size: undefined }` を渡すと、
		// 比率を「指定した」と解釈されうるので、指定していないことを構造で示す。
		const argument: IParadisGroupLayoutArgument = node.size === undefined ? {} : { size: node.size };
		if (paradisIsLayoutBranch(node)) {
			argument.groups = paradisLayoutGroupArguments(node.children!);
		}
		return argument;
	});
}

/**
 * ルートの並べ方を VS Code の `GroupOrientation` の値へ変換する。
 * 0 = HORIZONTAL（子が左右に並ぶ）、1 = VERTICAL（子が上下に並ぶ）。
 * `GroupOrientation` は workbench 層の const enum なので、common 層では数値で持つ。
 */
export function paradisLayoutOrientationValue(orientation: ParadisLayoutOrientation | undefined): 0 | 1 {
	return orientation === 'rows' ? 1 : 0;
}

// --- 識別 ----------------------------------------------------------------------------------------

/**
 * プリセットの安定キー。id を持つ定義（GUI で保存したもの）は id 由来、持たない定義（手書き）は
 * 位置由来にする。位置由来のキーは並び替え・削除でずれるが、ずれて困るのはこのキーを覚えている
 * 側だけで、GUI から保存したものには常に id が入る。
 */
export function paradisLayoutPresetKey(definition: IParadisLayoutPresetDefinition, index: number): string {
	return typeof definition.id === 'string' && definition.id.length > 0 ? definition.id : `#${index}`;
}

/**
 * 読み込んだ定義の id を、識別子として使ってよいものだけに正規化する。
 * 設定は手で編集できるので、id が文字列でないことも、エントリごとコピーされて**同じ id が2つある**
 * こともある。重複した id をそのまま使うと、2件目を編集・削除したつもりで1件目が書き換わる。
 *
 * @param taken 既に使われた id。呼ばれるたびに書き足す。
 */
export function paradisUsableLayoutPresetId(definition: IParadisLayoutPresetDefinition, taken: Set<string>): string | undefined {
	const id = definition.id;
	if (typeof id !== 'string' || id.length === 0 || taken.has(id)) {
		return undefined;
	}
	taken.add(id);
	return id;
}

/**
 * 定義の中身から作る指紋。「その位置に居るのが本当に当人か」を確かめるために使う。
 * ユーザーが編集できる項目をすべて突き合わせる——同名・同じ形で URL やコマンドだけが違う2件は
 * 正規に並べて登録できるので、名前と形だけでは双子を取り違える。
 *
 * 木は正規化してから比べる。設定に書かれた生の定義と、読み込んで正規化した解決済みプリセットを
 * 突き合わせる場面があるので、正規化の有無で別物と判定されないようにする。
 */
export function paradisLayoutPresetFingerprint(definition: IParadisLayoutPresetDefinition): string {
	const nodeSignature = (nodes: readonly IParadisLayoutNode[]): unknown[] => nodes.map(node => paradisIsLayoutBranch(node)
		? [node.size ?? null, nodeSignature(node.children!)]
		: [node.size ?? null, slotSignature(node.slot)]);
	const slotSignature = (slot: IParadisLayoutSlot | undefined): unknown[] => [
		slot?.kind ?? 'empty',
		(slot?.command ?? '').trim(),
		(slot?.cwd ?? '').trim(),
		(slot?.name ?? '').trim(),
		(slot?.url ?? '').trim(),
		(slot?.path ?? '').trim(),
	];
	return JSON.stringify([
		definition.name.trim(),
		(definition.description ?? '').trim(),
		definition.icon ?? '',
		definition.orientation ?? 'columns',
		nodeSignature(paradisNormalizeLayoutNodes(definition.root)),
	]);
}

/**
 * 書き戻す直前のリストから、対象プリセットの位置を解決する。見つからなければ -1。
 *
 * 一覧を開いてから保存するまでの間に設定を手で編集されたり、別ウィンドウで並び替えられたり
 * している可能性があるので、覚えていた位置をそのまま信じない。id があれば id で、無ければ
 * 「その位置の中身が指紋まで一致するか」で確かめる。
 */
export function paradisResolveLayoutPresetIndex(list: readonly unknown[], preset: IParadisResolvedLayoutPreset): number {
	if (preset.id) {
		const byId = list.findIndex(entry => isValidLayoutPresetDefinition(entry) && entry.id === preset.id);
		if (byId >= 0) {
			return byId;
		}
	}
	const candidate = list[preset.sourceIndex];
	return isValidLayoutPresetDefinition(candidate) && paradisLayoutPresetFingerprint(candidate) === paradisLayoutPresetFingerprint(preset)
		? preset.sourceIndex
		: -1;
}

// --- バリデーション ------------------------------------------------------------------------------

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === 'string';
}

function isValidSlot(value: unknown): value is IParadisLayoutSlot {
	if (value === undefined) {
		return true; // slot 未指定の葉は「未設定の枠」として扱う
	}
	if (!value || typeof value !== 'object') {
		return false;
	}
	const candidate = value as IParadisLayoutSlot;
	return (PARADIS_LAYOUT_SLOT_KINDS as readonly string[]).includes(candidate.kind)
		&& isOptionalString(candidate.command)
		&& isOptionalString(candidate.cwd)
		&& isOptionalString(candidate.name)
		&& isOptionalString(candidate.url)
		&& isOptionalString(candidate.path);
}

/**
 * ノード列の検証。葉の数を数えながら深さと総数の上限も見る。
 * 上限を超えた場合は false を返して定義ごと捨てる（黙って切り詰めない）。
 */
function validateNodes(value: unknown, depth: number, counter: { slots: number }): boolean {
	if (!Array.isArray(value) || value.length === 0) {
		return false;
	}
	if (depth > PARADIS_LAYOUT_MAX_DEPTH) {
		return false;
	}
	for (const entry of value) {
		if (!entry || typeof entry !== 'object') {
			return false;
		}
		const node = entry as IParadisLayoutNode;
		// 比率は相対値。VS Code 側は同じ親の子の合計を全体として正規化するので、
		// 「0.3 / 0.7」でも「3 / 7」でも同じ結果になる。上限は設けない。
		if (node.size !== undefined && (typeof node.size !== 'number' || !Number.isFinite(node.size) || node.size <= 0)) {
			return false;
		}
		if (node.children !== undefined) {
			if (!validateNodes(node.children, depth + 1, counter)) {
				return false;
			}
			continue;
		}
		if (!isValidSlot(node.slot)) {
			return false;
		}
		counter.slots++;
		if (counter.slots > PARADIS_LAYOUT_MAX_SLOTS) {
			return false;
		}
	}
	return true;
}

/** 定義の最低限のバリデーション（不正エントリは読み飛ばす）。 */
export function isValidLayoutPresetDefinition(value: unknown): value is IParadisLayoutPresetDefinition {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const candidate = value as IParadisLayoutPresetDefinition;
	if (typeof candidate.name !== 'string' || candidate.name.trim().length === 0) {
		return false;
	}
	if (candidate.orientation !== undefined && !(PARADIS_LAYOUT_ORIENTATIONS as readonly string[]).includes(candidate.orientation)) {
		return false;
	}
	return validateNodes(candidate.root, 1, { slots: 0 });
}

// --- 表示用 --------------------------------------------------------------------------------------

/**
 * 枠の内訳を短く表した文字列（例: "ターミナル×3 · ブラウザ"）。
 * 一覧やツールチップで「押す前に何が開くか」を示すために使う。
 */
export function paradisLayoutPresetSummary(definition: IParadisLayoutPresetDefinition, labels: Record<ParadisLayoutSlotKind, string>): string {
	const counts = new Map<ParadisLayoutSlotKind, number>();
	for (const slot of paradisFlattenLayoutSlots(definition.root)) {
		counts.set(slot.kind, (counts.get(slot.kind) ?? 0) + 1);
	}
	return PARADIS_LAYOUT_SLOT_KINDS
		.filter(kind => counts.has(kind))
		.map(kind => {
			const count = counts.get(kind)!;
			return count > 1 ? `${labels[kind]}×${count}` : labels[kind];
		})
		.join(' · ');
}
