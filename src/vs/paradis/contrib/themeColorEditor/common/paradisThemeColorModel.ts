/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// テーマの色エディタの判断ロジック（DOM・サービスに依存しない純関数）。
//
// 色の出どころは設定の層ごとに読み、テーマサービス（colorThemeData.ts の setCustomColors /
// getThemeSpecificColors）と同じ規則で「どの層の値が効くか」を決める。規則の要点:
//   - 層は default（Para Code の既定）< user < workspace < memory の順に、キー単位で深くマージされる
//   - マージ後の値のうち、今のテーマに一致する "[テーマ名]" の中の値が、スコープなしの値より常に勝つ
//     （そのため default 層の "[Houston]" はユーザーのスコープなしの値より強い）
//   - "default" はテーマの色ではなく、色レジストリの既定値に戻す値
// メモリ層もキー単位の深いマージなので「下の層の値を消す」ことは表せない。値に null を書くと
// マージ後のそのパスが null になり、テーマサービスは文字列以外を無視するので、結果として
// 下の層（同じパス）の値を隠せる。プレビューはこの性質を使う。

/** コマンド「テーマの色を編集…」。歯車メニュー（settingsMenu）からも呼ぶ。 */
export const PARADIS_THEME_COLORS_EDIT_COMMAND_ID = 'paradis.themeColors.edit';
/** コマンド「テーマの色: 画面から選ぶ」。 */
export const PARADIS_THEME_COLORS_PICK_COMMAND_ID = 'paradis.themeColors.pickFromScreen';

export const PARADIS_COLOR_CUSTOMIZATIONS_KEY = 'workbench.colorCustomizations';
export const PARADIS_TOKEN_COLOR_CUSTOMIZATIONS_KEY = 'editor.tokenColorCustomizations';
export const PARADIS_SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS_KEY = 'editor.semanticTokenColorCustomizations';
/** 色レジストリの既定値に戻す値（colorThemeData.ts の DEFAULT_COLOR_CONFIG_VALUE と同じ）。 */
export const PARADIS_DEFAULT_COLOR_VALUE = 'default';

export interface IParadisJsonObject {
	[key: string]: unknown;
}

export function paradisIsPlainObject(value: unknown): value is IParadisJsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
	return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** 保存先のキー（今のテーマ用のスコープ）。 */
export function paradisThemeScopeKey(settingsId: string): string {
	return `[${settingsId}]`;
}

const THEME_SCOPE_REGEX = /\[(.+?)\]/g;

function isThemeScope(key: string): boolean {
	return key.charAt(0) === '[' && key.charAt(key.length - 1) === ']';
}

/** colorThemeData.ts の isThemeScopeMatch と同じ判定（`*` のワイルドカードを含む）。 */
function themeIdMatches(settingsId: string, themeId: string): boolean {
	const first = themeId.charAt(0);
	const last = themeId.charAt(themeId.length - 1);
	return themeId === settingsId
		|| (first === '*' && last === '*' && settingsId.includes(themeId.slice(1, -1)))
		|| (last === '*' && settingsId.startsWith(themeId.slice(0, -1)))
		|| (first === '*' && settingsId.endsWith(themeId.slice(1)));
}

/** `"[Abyss][Monokai]"` のようなキーが今のテーマに当たるか。 */
export function paradisThemeScopeMatches(settingsId: string, key: string): boolean {
	if (!isThemeScope(key)) {
		return false;
	}
	for (const match of key.matchAll(THEME_SCOPE_REGEX)) {
		if (themeIdMatches(settingsId, match[1])) {
			return true;
		}
	}
	return false;
}

/**
 * 1 つの層の値から、今のテーマに効くスコープ内の値を集める（キーの並び順で後勝ち。配列は連結）。
 * colorThemeData.ts の getThemeSpecificColors と同じ規則。
 */
export function paradisThemeSpecificValues(layerValue: unknown, settingsId: string): IParadisJsonObject | undefined {
	if (!paradisIsPlainObject(layerValue)) {
		return undefined;
	}
	let result: IParadisJsonObject | undefined;
	for (const key of Object.keys(layerValue)) {
		const scoped = layerValue[key];
		if (!paradisIsPlainObject(scoped) || !paradisThemeScopeMatches(settingsId, key)) {
			continue;
		}
		result ??= {};
		for (const subKey of Object.keys(scoped)) {
			const before = result[subKey];
			const after = scoped[subKey];
			if (Array.isArray(before) && Array.isArray(after)) {
				result[subKey] = before.concat(after);
			} else if (after) {
				result[subKey] = after;
			}
		}
	}
	return result;
}

// --- UI の色 --------------------------------------------------------------------------------------

/** 色の値として有効なもの（`#RRGGBB(AA)` か `"default"`）。テーマサービスは文字列以外を無視する。 */
function asColorValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

export interface IParadisLayerColor {
	/** 今のテーマのスコープ内の値。 */
	readonly scoped: string | undefined;
	/** スコープなしの値。 */
	readonly unscoped: string | undefined;
}

export function paradisReadLayerColor(layerValue: unknown, settingsId: string, colorId: string): IParadisLayerColor {
	if (!paradisIsPlainObject(layerValue)) {
		return { scoped: undefined, unscoped: undefined };
	}
	return {
		scoped: asColorValue(paradisThemeSpecificValues(layerValue, settingsId)?.[colorId]),
		unscoped: asColorValue(layerValue[colorId]),
	};
}

/** 色の出どころ。`theme` はテーマの色（テーマが持たなければレジストリの既定値）。 */
export type ParadisColorSource = 'theme' | 'paraDefault' | 'user' | 'workspace';

/** 設定の層の値（`configurationService.inspect(key)` の default / user / workspace をそのまま入れる）。 */
export interface IParadisColorLayers {
	readonly paraDefault: unknown;
	readonly user: unknown;
	readonly workspace: unknown;
}

export interface IParadisColorOrigin {
	readonly source: ParadisColorSource;
	/** 効いている設定の値。`theme` のときは undefined。`"default"` もありうる。 */
	readonly value: string | undefined;
	/** 効いている値が今のテーマのスコープ内のものか。 */
	readonly scoped: boolean;
}

const LAYERS_HIGH_TO_LOW: readonly Exclude<ParadisColorSource, 'theme'>[] = ['workspace', 'user', 'paraDefault'];

/** どの層の値が効いているかを決める（テーマサービスと同じ規則。ファイルの冒頭のコメント参照）。 */
export function paradisResolveColorOrigin(layers: IParadisColorLayers, settingsId: string, colorId: string): IParadisColorOrigin {
	const read = {
		workspace: paradisReadLayerColor(layers.workspace, settingsId, colorId),
		user: paradisReadLayerColor(layers.user, settingsId, colorId),
		paraDefault: paradisReadLayerColor(layers.paraDefault, settingsId, colorId),
	};
	for (const source of LAYERS_HIGH_TO_LOW) {
		const value = read[source].scoped;
		if (value !== undefined) {
			return { source, value, scoped: true };
		}
	}
	for (const source of LAYERS_HIGH_TO_LOW) {
		const value = read[source].unscoped;
		if (value !== undefined) {
			return { source, value, scoped: false };
		}
	}
	return { source: 'theme', value: undefined, scoped: false };
}

/**
 * ユーザー設定の値に、今のテーマのスコープ（`"[テーマ名]"`）の中だけ編集を当てた新しい値を返す。
 * 編集の値が undefined なら、その色をスコープから消す。他のキー・他のテーマのスコープ・
 * スコープなしの値には触らない。スコープが空になったらスコープごと消し、全体が空なら undefined を返す。
 */
export function paradisApplyColorEdits(userValue: unknown, settingsId: string, edits: ReadonlyMap<string, string | undefined>): unknown {
	const result: IParadisJsonObject = paradisIsPlainObject(userValue) ? cloneJson(userValue) : {};
	const scopeKey = paradisThemeScopeKey(settingsId);
	const scoped: IParadisJsonObject = paradisIsPlainObject(result[scopeKey]) ? result[scopeKey] as IParadisJsonObject : {};
	for (const [colorId, value] of edits) {
		if (value === undefined) {
			delete scoped[colorId];
		} else {
			scoped[colorId] = value;
		}
	}
	if (Object.keys(scoped).length) {
		result[scopeKey] = scoped;
	} else {
		delete result[scopeKey];
	}
	return Object.keys(result).length ? result : undefined;
}

/**
 * メモリ層へ書くプレビューの値（その色のパス `"[テーマ名]".colorId` に置く値）を決める。
 * 保存後に効く値と同じ見た目になるようにする:
 *   - ワークスペースのスコープ内の値があれば、保存してもそれが勝つのでそれを見せる
 *   - 新しい値があればそれ
 *   - ユーザーの値を消す場合は、同じパスに Para Code の既定があればそれ、無ければ null で
 *     同じパスの値を隠す（スコープなしの値やテーマの色が見える）
 */
export function paradisColorPreviewValue(layers: IParadisColorLayers, settingsId: string, colorId: string, save: string | undefined): string | null {
	const scopeKey = paradisThemeScopeKey(settingsId);
	const exact = (layer: unknown) => {
		const scoped = paradisIsPlainObject(layer) ? layer[scopeKey] : undefined;
		return paradisIsPlainObject(scoped) ? asColorValue(scoped[colorId]) : undefined;
	};
	return exact(layers.workspace) ?? save ?? exact(layers.paraDefault) ?? null;
}

/**
 * メモリ層の新しい値を作る。元のメモリ層の値（編集を始める前の値）に、テーマごとのプレビューを重ねる。
 * プレビューが 1 件も無ければ元の値をそのまま返す。
 */
export function paradisBuildMemoryValue(baseMemory: unknown, previews: ReadonlyMap<string, IParadisJsonObject>): unknown {
	if (!previews.size) {
		return baseMemory;
	}
	const result: IParadisJsonObject = paradisIsPlainObject(baseMemory) ? cloneJson(baseMemory) : {};
	for (const [settingsId, preview] of previews) {
		const scopeKey = paradisThemeScopeKey(settingsId);
		const existing = paradisIsPlainObject(result[scopeKey]) ? result[scopeKey] as IParadisJsonObject : {};
		result[scopeKey] = { ...existing, ...cloneJson(preview) };
	}
	return result;
}

/** 「テーマの色に戻す」で保存する値。undefined はユーザーの値を消すだけでよいことを表す。 */
export function paradisPlanRevertToTheme(layersWithoutUserValue: IParadisColorLayers, settingsId: string, colorId: string, themeHex: string | undefined): string | undefined {
	// ユーザーの値を消しただけでテーマの色に戻るなら、消すだけにする（settings.json に余計な値を残さない）。
	if (paradisResolveColorOrigin(layersWithoutUserValue, settingsId, colorId).source === 'theme') {
		return undefined;
	}
	// Para Code の既定などが下にあるなら、テーマの色そのものを書くしかない。テーマがこの色を
	// 持っていない（レジストリの既定値が効いている）なら "default" がまさにその色になる。
	return themeHex ?? PARADIS_DEFAULT_COLOR_VALUE;
}

/**
 * 「Para Code の既定に戻す」で保存する値。undefined はユーザーの値（`"[テーマ名]"` ちょうどの中）を消すだけでよいことを表す。
 * スコープなしの値や `"[A][テーマ名]"` のような別のキーにもユーザーの値があり、消すだけでは既定に戻らないときは、
 * Para Code の既定の値をそのまま書く。
 */
export function paradisPlanRevertToParaDefault(layersWithoutUserValue: IParadisColorLayers, settingsId: string, colorId: string): string | undefined {
	const origin = paradisResolveColorOrigin(layersWithoutUserValue, settingsId, colorId);
	if (origin.source === 'paraDefault' || origin.source === 'workspace') {
		return undefined;
	}
	const para = paradisReadLayerColor(layersWithoutUserValue.paraDefault, settingsId, colorId);
	return para.scoped ?? para.unscoped;
}

/**
 * ユーザー設定の `"[テーマ名]"` ちょうどのキーに書いた値が、後ろに並ぶ別のスコープのキー（`"[A][テーマ名]"` や
 * `"[テーマ*]"`）に負けるか。テーマサービスはスコープのキーを並び順に当てて後勝ちにするため。
 * まだキーが無ければ、書くときに末尾へ足されるので負けない。
 */
export function paradisExactScopeShadowed(userValue: unknown, settingsId: string, colorId: string): boolean {
	if (!paradisIsPlainObject(userValue)) {
		return false;
	}
	const keys = Object.keys(userValue);
	const index = keys.indexOf(paradisThemeScopeKey(settingsId));
	if (index === -1) {
		return false;
	}
	return keys.slice(index + 1).some(key => {
		const scoped = userValue[key];
		return paradisThemeScopeMatches(settingsId, key) && paradisIsPlainObject(scoped) && typeof scoped[colorId] === 'string';
	});
}

// --- 一覧・検索 -----------------------------------------------------------------------------------

export interface IParadisColorEntry {
	readonly id: string;
	readonly description: string;
}

/** 一覧のグループ（ID のドットより前）。 */
export function paradisColorGroupOf(colorId: string): string {
	const index = colorId.indexOf('.');
	return index === -1 ? colorId : colorId.slice(0, index);
}

/** 空白区切りの語がすべて、ID・説明・グループ名のどれかに含まれるものを残す（大文字小文字は無視）。 */
export function paradisFilterColorEntries<T extends IParadisColorEntry>(entries: readonly T[], query: string, groupLabel: (group: string) => string): T[] {
	const terms = query.toLowerCase().split(/[\s、,]+/).filter(term => term.length > 0);
	if (!terms.length) {
		return entries.slice();
	}
	return entries.filter(entry => {
		const haystack = `${entry.id}\n${entry.description}\n${groupLabel(paradisColorGroupOf(entry.id))}`.toLowerCase();
		return terms.every(term => haystack.includes(term));
	});
}

/** グループごとにまとめる。グループは表示名の順、グループ内は ID の順。 */
export function paradisGroupColorEntries<T extends IParadisColorEntry>(entries: readonly T[], groupLabel: (group: string) => string): { group: string; label: string; entries: T[] }[] {
	const groups = new Map<string, T[]>();
	for (const entry of entries) {
		const group = paradisColorGroupOf(entry.id);
		let list = groups.get(group);
		if (!list) {
			list = [];
			groups.set(group, list);
		}
		list.push(entry);
	}
	return [...groups.entries()]
		.map(([group, list]) => ({ group, label: groupLabel(group), entries: list.sort((a, b) => a.id.localeCompare(b.id)) }))
		.sort((a, b) => a.label.localeCompare(b.label));
}

// --- 画面から選ぶ（CSS 変数の逆引き） --------------------------------------------------------------

/** colorUtils.ts の asCssVariableName と同じ変換。 */
export function paradisCssVariableName(colorId: string): string {
	return `--vscode-${colorId.replace(/\./g, '-')}`;
}

/** CSS 変数名 → 色 ID の表。`a.b-c` と `a-b.c` は同じ変数名になるので、1 つの名前に複数の ID が並びうる。 */
export function paradisBuildCssVariableReverseMap(colorIds: Iterable<string>): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const id of colorIds) {
		const name = paradisCssVariableName(id);
		const list = map.get(name);
		if (list) {
			list.push(id);
		} else {
			map.set(name, [id]);
		}
	}
	return map;
}

const CSS_VAR_REGEX = /var\(\s*(--vscode-[A-Za-z0-9_-]+)/g;

/** CSS の値に出てくる `var(--vscode-…)` を色 ID に戻す（出てきた順。入れ子の既定値も拾う）。 */
export function paradisCssValueColorIds(cssValue: string, reverseMap: ReadonlyMap<string, readonly string[]>): string[] {
	const result: string[] = [];
	for (const match of cssValue.matchAll(CSS_VAR_REGEX)) {
		for (const id of reverseMap.get(match[1]) ?? []) {
			if (!result.includes(id)) {
				result.push(id);
			}
		}
	}
	return result;
}

export type ParadisColorRole = 'background' | 'foreground' | 'border' | 'icon' | 'shadow' | 'other';

/** CSS のプロパティ名から、その色の役割（背景・文字・枠線…）を決める。 */
export function paradisColorRoleOf(property: string): ParadisColorRole {
	if (property.startsWith('background')) {
		return 'background';
	}
	if (property === 'color' || property.startsWith('text-decoration') || property === 'caret-color' || property === '-webkit-text-fill-color') {
		return 'foreground';
	}
	if (property.startsWith('border') || property.startsWith('outline')) {
		return 'border';
	}
	if (property === 'fill' || property === 'stroke') {
		return 'icon';
	}
	if (property === 'box-shadow') {
		return 'shadow';
	}
	return 'other';
}

/** 1 つの要素（または祖先）に効いている CSS の宣言。 */
export interface IParadisCssDeclaration {
	readonly property: string;
	readonly value: string;
}

export interface IParadisColorCandidate {
	readonly id: string;
	readonly role: ParadisColorRole;
	/** 0 がクリックした要素、1 が親…。 */
	readonly depth: number;
}

/**
 * 要素と祖先の宣言（`levels[0]` が要素自身）から、色の候補を出す。
 * 近い要素を先に、同じ要素の中では背景・文字・枠線…の順に並べ、同じ ID は最初の 1 件だけ残す。
 */
export function paradisCollectColorCandidates(levels: readonly (readonly IParadisCssDeclaration[])[], reverseMap: ReadonlyMap<string, readonly string[]>, limit: number): IParadisColorCandidate[] {
	const roleOrder: readonly ParadisColorRole[] = ['background', 'foreground', 'border', 'icon', 'shadow', 'other'];
	const seen = new Set<string>();
	const result: IParadisColorCandidate[] = [];
	levels.forEach((declarations, depth) => {
		const found: IParadisColorCandidate[] = [];
		for (const declaration of declarations) {
			const role = paradisColorRoleOf(declaration.property);
			for (const id of paradisCssValueColorIds(declaration.value, reverseMap)) {
				found.push({ id, role, depth });
			}
		}
		found.sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role));
		for (const candidate of found) {
			if (!seen.has(candidate.id)) {
				seen.add(candidate.id);
				result.push(candidate);
			}
		}
	});
	return result.slice(0, limit);
}

/**
 * 要素の CSS を `element.matches()` に渡せる形にする。疑似要素（`::before` など）は
 * matches() に渡すと常に一致しないので外し、その疑似要素を持つ要素に一致させる。
 */
export function paradisStripPseudoElements(selector: string): string {
	return selector.replace(/::?(before|after|placeholder|selection|marker|-webkit-[a-z-]+)(\([^)]*\))?/g, '');
}

// --- シンタックスの色 -----------------------------------------------------------------------------

export type ParadisTokenGroup = 'comments' | 'strings' | 'keywords' | 'numbers' | 'types' | 'functions' | 'variables';

/** よく使うグループと、それが当たる TextMate のスコープ（colorThemeData.ts の tokenGroupToScopesMap と同じ）。 */
export const PARADIS_TOKEN_GROUP_SCOPES: { readonly [G in ParadisTokenGroup]: readonly string[] } = {
	comments: ['comment', 'punctuation.definition.comment'],
	strings: ['string', 'meta.embedded.assembly'],
	keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'],
	numbers: ['constant.numeric'],
	types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
	functions: ['entity.name.function', 'support.function'],
	variables: ['variable', 'entity.name.variable'],
};

export const PARADIS_TOKEN_GROUPS = Object.keys(PARADIS_TOKEN_GROUP_SCOPES) as ParadisTokenGroup[];

/** グループの色を調べるときに代表として使うスコープ。 */
export const PARADIS_TOKEN_GROUP_PROBE: { readonly [G in ParadisTokenGroup]: string } = {
	comments: 'comment',
	strings: 'string',
	keywords: 'keyword.control',
	numbers: 'constant.numeric',
	types: 'entity.name.type',
	functions: 'entity.name.function',
	variables: 'variable',
};

/** 前景色と字形（斜体・太字など）。 */
export interface IParadisTokenStyle {
	readonly foreground?: string;
	readonly fontStyle?: string;
}

export type ParadisFontStyleFlag = 'italic' | 'bold' | 'underline' | 'strikethrough';

/** グループの値（文字列か `{ foreground, fontStyle }`）を揃える。 */
export function paradisReadTokenStyle(value: unknown): IParadisTokenStyle | undefined {
	if (typeof value === 'string') {
		return { foreground: value };
	}
	if (!paradisIsPlainObject(value)) {
		return undefined;
	}
	const foreground = typeof value.foreground === 'string' ? value.foreground : undefined;
	const fontStyle = typeof value.fontStyle === 'string' ? value.fontStyle : undefined;
	return tokenStyle(foreground, fontStyle);
}

/** 値のある項目だけを持つ字形（undefined の項目を作らない）。両方無ければ undefined。 */
function tokenStyle(foreground: string | undefined, fontStyle: string | undefined): IParadisTokenStyle | undefined {
	if (foreground === undefined && fontStyle === undefined) {
		return undefined;
	}
	return { ...(foreground !== undefined ? { foreground } : {}), ...(fontStyle !== undefined ? { fontStyle } : {}) };
}

export function paradisHasFontStyle(fontStyle: string | undefined, flag: ParadisFontStyleFlag): boolean {
	return (fontStyle ?? '').split(/\s+/).includes(flag);
}

/** 字形の語を足す／外す。全部外れたら空文字（テーマの字形を打ち消して「なし」にする値）を返す。 */
export function paradisToggleFontStyle(fontStyle: string | undefined, flag: ParadisFontStyleFlag, on: boolean): string {
	const order: readonly ParadisFontStyleFlag[] = ['italic', 'bold', 'underline', 'strikethrough'];
	const words = new Set((fontStyle ?? '').split(/\s+/).filter(word => word.length > 0));
	if (on) {
		words.add(flag);
	} else {
		words.delete(flag);
	}
	return order.filter(word => words.has(word)).join(' ');
}

/** グループに書く値。前景色だけなら文字列、字形があればオブジェクト、空なら undefined。 */
export function paradisTokenStyleToGroupValue(style: IParadisTokenStyle | undefined): string | IParadisJsonObject | undefined {
	if (!style || (style.foreground === undefined && style.fontStyle === undefined)) {
		return undefined;
	}
	if (style.fontStyle === undefined) {
		return style.foreground;
	}
	const result: IParadisJsonObject = {};
	if (style.foreground !== undefined) {
		result.foreground = style.foreground;
	}
	result.fontStyle = style.fontStyle;
	return result;
}

/** セマンティックの規則に書く値（`{ foreground, italic, bold, … }`）。空なら undefined。 */
export function paradisTokenStyleToSemanticValue(style: IParadisTokenStyle | undefined): string | IParadisJsonObject | undefined {
	if (!style || (style.foreground === undefined && style.fontStyle === undefined)) {
		return undefined;
	}
	if (style.fontStyle === undefined) {
		return style.foreground;
	}
	const result: IParadisJsonObject = {};
	if (style.foreground !== undefined) {
		result.foreground = style.foreground;
	}
	for (const flag of ['italic', 'bold', 'underline', 'strikethrough'] as const) {
		result[flag] = paradisHasFontStyle(style.fontStyle, flag);
	}
	return result;
}

/** セマンティックの規則の値を揃える（`{ italic: true }` などを fontStyle の語に直す）。 */
export function paradisReadSemanticStyle(value: unknown): IParadisTokenStyle | undefined {
	if (typeof value === 'string') {
		return { foreground: value };
	}
	if (!paradisIsPlainObject(value)) {
		return undefined;
	}
	const foreground = typeof value.foreground === 'string' ? value.foreground : undefined;
	const flags = (['italic', 'bold', 'underline', 'strikethrough'] as const).filter(flag => value[flag] === true);
	const hasFlags = (['italic', 'bold', 'underline', 'strikethrough'] as const).some(flag => typeof value[flag] === 'boolean');
	const fontStyle = typeof value.fontStyle === 'string' ? value.fontStyle : (hasFlags ? flags.join(' ') : undefined);
	return tokenStyle(foreground, fontStyle);
}

export interface IParadisTextMateRule {
	readonly scope: string;
	readonly settings: IParadisTokenStyle;
}

/** `textMateRules` の配列を読む（scope が文字列配列なら `, ` でつなぐ）。読めない要素は落とす。 */
export function paradisReadTextMateRules(value: unknown): IParadisTextMateRule[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const result: IParadisTextMateRule[] = [];
	for (const rule of value) {
		if (!paradisIsPlainObject(rule)) {
			continue;
		}
		const scope = typeof rule.scope === 'string' ? rule.scope : Array.isArray(rule.scope) ? rule.scope.filter(s => typeof s === 'string').join(', ') : undefined;
		const settings = paradisReadTokenStyle(rule.settings) ?? {};
		if (scope) {
			result.push({ scope, settings });
		}
	}
	return result;
}

/** ユーザー設定の値のうち、今のテーマのスコープ（`"[テーマ名]"` ちょうど）の中身を取り出す。 */
export function paradisReadExactScope(userValue: unknown, settingsId: string): IParadisJsonObject {
	const scoped = paradisIsPlainObject(userValue) ? userValue[paradisThemeScopeKey(settingsId)] : undefined;
	return paradisIsPlainObject(scoped) ? cloneJson(scoped) : {};
}

/** ユーザー設定の値の `"[テーマ名]"` を丸ごと差し替えた新しい値（空のスコープは消す。全体が空なら undefined）。 */
export function paradisReplaceExactScope(userValue: unknown, settingsId: string, scoped: IParadisJsonObject): unknown {
	const result: IParadisJsonObject = paradisIsPlainObject(userValue) ? cloneJson(userValue) : {};
	const scopeKey = paradisThemeScopeKey(settingsId);
	const cleaned: IParadisJsonObject = {};
	for (const key of Object.keys(scoped)) {
		if (scoped[key] !== undefined) {
			cleaned[key] = cloneJson(scoped[key]);
		}
	}
	if (Object.keys(cleaned).length) {
		result[scopeKey] = cleaned;
	} else {
		delete result[scopeKey];
	}
	return Object.keys(result).length ? result : undefined;
}

/**
 * スコープの中身を差し替えたときのプレビュー（メモリ層へ重ねる値）。メモリ層は深いマージなので、
 * 消したキーは null を置いて下の層の同じパスの値を隠す。配列（textMateRules）はマージされず
 * 丸ごと置き換わるので、そのまま入れる。`nested` に挙げたキー（セマンティックの rules）は 1 段深く同じ処理をする。
 */
export function paradisBuildScopedPreview(original: IParadisJsonObject, draft: IParadisJsonObject, nested: readonly string[] = [], workspace?: IParadisJsonObject): IParadisJsonObject {
	const result: IParadisJsonObject = {};
	const keys = new Set([...Object.keys(original), ...Object.keys(draft)]);
	for (const key of keys) {
		const before = original[key];
		const after = draft[key];
		const workspaceValue = workspace?.[key];
		if (nested.includes(key) && (paradisIsPlainObject(before) || paradisIsPlainObject(after))) {
			result[key] = paradisBuildScopedPreview(paradisIsPlainObject(before) ? before : {}, paradisIsPlainObject(after) ? after : {}, [], paradisIsPlainObject(workspaceValue) ? workspaceValue : undefined);
		} else if (workspaceValue !== undefined && workspaceValue !== null) {
			// ワークスペースに同じキーがあれば、保存後もそれが勝つ（配列は丸ごと、値はそのまま）。
			result[key] = cloneJson(workspaceValue);
		} else if (after === undefined) {
			result[key] = null;
		} else {
			result[key] = cloneJson(after);
		}
	}
	return result;
}

export interface IParadisScopedMerge {
	/** 保存する中身（今の値に、下書きで変えた所だけを当てたもの）。 */
	readonly merged: IParadisJsonObject;
	/** 下書きでも、ほかの所（settings.json の手編集・別のウィンドウ）でも変わっていた配列のキー。上書きの確認が要る。 */
	readonly conflicts: string[];
}

/**
 * 下書きで変えたキー（original と draft で違うもの）だけを、保存時点の今の値に当てる。
 * 下書きで触っていないキーは今の値のまま残す（編集中に他所で入った変更を消さない）。
 * `nested` のキー（セマンティックの rules）は 1 段深く同じ処理をする。配列（textMateRules）は部分的に当てられないので
 * 丸ごと置き換え、今の値も original から変わっていれば conflicts に挙げる。
 */
export function paradisMergeScopedEdits(current: IParadisJsonObject, original: IParadisJsonObject, draft: IParadisJsonObject, nested: readonly string[] = []): IParadisScopedMerge {
	const merged: IParadisJsonObject = cloneJson(current);
	const conflicts: string[] = [];
	const keys = new Set([...Object.keys(original), ...Object.keys(draft)]);
	for (const key of keys) {
		const before = original[key];
		const after = draft[key];
		if (paradisJsonEquals(before, after)) {
			continue;
		}
		if (nested.includes(key) && (paradisIsPlainObject(before) || paradisIsPlainObject(after))) {
			const now = merged[key];
			const inner = paradisMergeScopedEdits(paradisIsPlainObject(now) ? now : {}, paradisIsPlainObject(before) ? before : {}, paradisIsPlainObject(after) ? after : {});
			conflicts.push(...inner.conflicts.map(innerKey => `${key}.${innerKey}`));
			if (Object.keys(inner.merged).length) {
				merged[key] = inner.merged;
			} else {
				delete merged[key];
			}
			continue;
		}
		if ((Array.isArray(before) || Array.isArray(after)) && !paradisJsonEquals(current[key], before)) {
			conflicts.push(key);
		}
		if (after === undefined) {
			delete merged[key];
		} else {
			merged[key] = cloneJson(after);
		}
	}
	return { merged, conflicts };
}

/** 2 つの JSON の値が同じか（キーの順は問わない）。 */
export function paradisJsonEquals(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((value, index) => paradisJsonEquals(value, b[index]));
	}
	if (paradisIsPlainObject(a) && paradisIsPlainObject(b)) {
		const keysA = Object.keys(a).filter(key => a[key] !== undefined);
		const keysB = Object.keys(b).filter(key => b[key] !== undefined);
		return keysA.length === keysB.length && keysA.every(key => paradisJsonEquals(a[key], b[key]));
	}
	return false;
}

/** 下の比較で使う、1 つのセレクタ（`a.b c.d` のような親子の並びも可）がスコープの並びに当たるか。 */
function selectorMatches(selector: string, scopes: readonly string[]): number {
	const parts = selector.trim().split(/\s+/).filter(part => part.length > 0);
	if (!parts.length) {
		return -1;
	}
	const matchesScope = (part: string, scope: string) => scope === part || scope.startsWith(part + '.');
	// 最後の部分は一番内側のスコープ（並びの末尾）から探す。
	for (let index = scopes.length - 1; index >= 0; index--) {
		if (!matchesScope(parts[parts.length - 1], scopes[index])) {
			continue;
		}
		let partIndex = parts.length - 2;
		for (let parent = index - 1; parent >= 0 && partIndex >= 0; parent--) {
			if (matchesScope(parts[partIndex], scopes[parent])) {
				partIndex--;
			}
		}
		if (partIndex < 0) {
			// 深い（内側の）スコープに、長い名前で当たるほど強い。
			return index * 1000 + parts[parts.length - 1].length;
		}
	}
	return -1;
}

/** プレビューの文字をクリックしたときに選ぶもの。 */
export type ParadisSyntaxTarget =
	| { readonly kind: 'rule'; readonly index: number }
	| { readonly kind: 'group'; readonly group: ParadisTokenGroup }
	| { readonly kind: 'newRule'; readonly scope: string };

/**
 * クリックした文字のスコープ（外側→内側の順）から、編集する対象を決める。
 * 自分で書いた TextMate の規則が当たればそれ（強いもの、同点なら後のもの）、無ければ当たるグループ、
 * どちらも無ければ一番内側のスコープで新しい規則を作る案を返す。
 */
export function paradisMatchSyntaxTarget(scopes: readonly string[], rules: readonly IParadisTextMateRule[]): ParadisSyntaxTarget | undefined {
	let best: { index: number; score: number } | undefined;
	rules.forEach((rule, index) => {
		for (const selector of rule.scope.split(',')) {
			const score = selectorMatches(selector, scopes);
			if (score >= 0 && (!best || score >= best.score)) {
				best = { index, score };
			}
		}
	});
	if (best) {
		return { kind: 'rule', index: best.index };
	}
	let bestGroup: { group: ParadisTokenGroup; score: number } | undefined;
	for (const group of PARADIS_TOKEN_GROUPS) {
		for (const selector of PARADIS_TOKEN_GROUP_SCOPES[group]) {
			// `keyword - keyword.operator` のような除外つきのセレクタ
			const [include, exclude] = selector.split(' - ');
			const score = selectorMatches(include, scopes);
			if (score < 0 || (exclude && selectorMatches(exclude, scopes) >= 0)) {
				continue;
			}
			if (!bestGroup || score > bestGroup.score) {
				bestGroup = { group, score };
			}
		}
	}
	if (bestGroup) {
		return { kind: 'group', group: bestGroup.group };
	}
	const innermost = scopes[scopes.length - 1];
	return innermost && !innermost.startsWith('source.') && !innermost.startsWith('text.') ? { kind: 'newRule', scope: innermost } : undefined;
}
