/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// serve-sim の `/helper/<udid>/ax`（`axDescribe` の生の木: AXLabel・AXValue・AXUniqueId・role_description・type・
// enabled・frame・children）を、mobile_ui_snapshot / mobile_ui_find / mobile_ui_tap が返す形へ直す純関数。
// 木の読み方（最初の根の frame を画面とみなす・要素は 500 個まで）は Orca の serve-sim-ax-normalization.ts
// （MIT, Copyright (c) 2026 Lovecast Inc.）と serve-sim 0.1.49 の src/ax.ts（Apache-2.0）を参考に書き直した。
// 座標は画面の左上を原点にしたポイント（mobile_tap が受ける単位）。

export interface IParadisSimulatorAxRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** mobile_ui_find の `role` で絞れる種類。 */
export type ParadisSimulatorAxRole = 'button' | 'text' | 'field' | 'image' | 'switch' | 'slider' | 'link' | 'cell' | 'list' | 'tab' | 'checkbox' | 'container' | 'other';

export interface IParadisSimulatorAxNode {
	readonly role: ParadisSimulatorAxRole;
	/** serve-sim の `type`（例 `Button`、`StaticText`）。 */
	readonly type: string;
	readonly label: string;
	readonly value: string;
	readonly identifier?: string;
	readonly enabled: boolean;
	readonly frame: IParadisSimulatorAxRect;
	readonly children: IParadisSimulatorAxNode[];
	/** 要素の上限で子を落としたとき。 */
	readonly truncated?: true;
	/**
	 * 入力中の欄とみなしたもの。serve-sim の木にはフォーカスの印が無いので、mobile_type_text の前後で値が
	 * 変わった欄に付ける（{@link paradisMarkTypedSimulatorField}）。
	 */
	readonly focused?: true;
}

export interface IParadisSimulatorAxSnapshot {
	/** 画面の大きさ（ポイント）。 */
	readonly screen: { readonly width: number; readonly height: number };
	readonly root: IParadisSimulatorAxNode;
	/** 木に入れた要素の数。 */
	readonly count: number;
}

/** 木に入れる要素の上限（serve-sim と同じ）。 */
const MAX_NODES = 500;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function rect(value: unknown): IParadisSimulatorAxRect {
	const frame = record(value);
	return { x: num(frame.x), y: num(frame.y), width: num(frame.width), height: num(frame.height) };
}

const ROLE_BY_TYPE: { readonly [type: string]: ParadisSimulatorAxRole } = {
	button: 'button', menubutton: 'button', popupbutton: 'button', segmentedcontrol: 'button', stepper: 'button',
	statictext: 'text', text: 'text',
	textfield: 'field', securetextfield: 'field', textview: 'field', searchfield: 'field',
	image: 'image', icon: 'image',
	switch: 'switch', toggle: 'switch',
	slider: 'slider', progressindicator: 'slider',
	link: 'link',
	cell: 'cell',
	table: 'list', collectionview: 'list', scrollview: 'list', outline: 'list',
	tab: 'tab', tabbar: 'tab',
	checkbox: 'checkbox', radiobutton: 'checkbox',
	group: 'container', window: 'container', application: 'container', other: 'container', navigationbar: 'container', toolbar: 'container',
};

/** serve-sim の `type` から、絞り込みに使う種類を決める。知らない種類は other。 */
export function paradisSimulatorAxRole(type: string): ParadisSimulatorAxRole {
	return ROLE_BY_TYPE[type.replace(/[^a-z]/gi, '').toLowerCase()] ?? 'other';
}

/** タップに応える種類か。 */
function respondsToTap(node: IParadisSimulatorAxNode): boolean {
	return node.enabled && (node.role === 'button' || node.role === 'field' || node.role === 'switch' || node.role === 'slider' || node.role === 'link' || node.role === 'cell' || node.role === 'tab' || node.role === 'checkbox');
}

/**
 * 生の木を直す。最初の根の frame を画面とみなし、座標をその左上からのポイントにする。
 * 形が違えば投げる。
 */
export function paradisNormalizeSimulatorAx(raw: unknown): IParadisSimulatorAxSnapshot {
	if (!Array.isArray(raw) || raw.some(node => !node || typeof node !== 'object' || Array.isArray(node))) {
		throw new Error('serve-sim returned an accessibility tree in an unexpected shape');
	}
	const first = rect(record(raw[0]).frame);
	const screen = first.width > 0 && first.height > 0 ? first : { x: 0, y: 0, width: 0, height: 0 };
	let remaining = MAX_NODES;
	const visit = (value: unknown): IParadisSimulatorAxNode => {
		remaining--;
		const node = record(value);
		const rawChildren = Array.isArray(node.children) ? node.children : [];
		const children: IParadisSimulatorAxNode[] = [];
		for (const child of rawChildren) {
			if (remaining <= 0) {
				break;
			}
			children.push(visit(child));
		}
		const frame = rect(node.frame);
		const type = text(node.type);
		const identifier = text(node.AXUniqueId);
		return {
			role: paradisSimulatorAxRole(type),
			type,
			label: text(node.AXLabel),
			value: text(node.AXValue),
			...(identifier ? { identifier } : {}),
			enabled: node.enabled !== false,
			frame: { x: frame.x - screen.x, y: frame.y - screen.y, width: frame.width, height: frame.height },
			children,
			...(children.length < rawChildren.length ? { truncated: true as const } : {}),
		};
	};
	const roots: IParadisSimulatorAxNode[] = [];
	for (const value of raw) {
		if (remaining <= 0) {
			break;
		}
		roots.push(visit(value));
	}
	const root: IParadisSimulatorAxNode = roots.length === 1
		? roots[0]
		: { role: 'container', type: 'Screen', label: '', value: '', enabled: true, frame: { x: 0, y: 0, width: screen.width, height: screen.height }, children: roots };
	return { screen: { width: screen.width, height: screen.height }, root, count: MAX_NODES - remaining };
}

export interface IParadisSimulatorAxQuery {
	readonly text?: string;
	readonly identifier?: string;
	readonly role?: string;
	readonly exact?: boolean;
	readonly interactableOnly?: boolean;
	readonly limit?: number;
}

export interface IParadisSimulatorAxMatch {
	readonly role: ParadisSimulatorAxRole;
	readonly type: string;
	readonly label: string;
	readonly value: string;
	readonly identifier?: string;
	readonly enabled: boolean;
	readonly interactable: boolean;
	readonly frame: IParadisSimulatorAxRect;
	/** そのまま mobile_tap へ渡せる中心（ポイント）。 */
	readonly center: { readonly x: number; readonly y: number };
}

function fieldMatches(field: string, term: string, exact: boolean): boolean {
	const a = field.toLowerCase();
	const b = term.toLowerCase();
	return exact ? a === b : a.includes(b);
}

/** 画面の中に少しでも見えている要素か（画面の外へ流れた行をタップさせない）。 */
function onScreen(node: IParadisSimulatorAxNode, screen: { readonly width: number; readonly height: number }): boolean {
	const { x, y, width, height } = node.frame;
	return width > 0 && height > 0 && x + width > 0 && y + height > 0 && (screen.width <= 0 || x < screen.width) && (screen.height <= 0 || y < screen.height);
}

/**
 * 木から要素を探す。text はラベルと値、identifier はアクセシビリティの識別子、role は種類で見る。
 * 返すのは見つかった数と、上から `limit` 件（既定 20）。
 */
export function paradisFindSimulatorAx(snapshot: IParadisSimulatorAxSnapshot, query: IParadisSimulatorAxQuery): { readonly total: number; readonly matches: IParadisSimulatorAxMatch[] } {
	const exact = query.exact === true;
	const limit = query.limit && query.limit > 0 ? query.limit : 20;
	const role = query.role?.toLowerCase();
	const found: IParadisSimulatorAxMatch[] = [];
	const visit = (node: IParadisSimulatorAxNode) => {
		const interactable = respondsToTap(node);
		const matchesText = query.text === undefined || fieldMatches(node.label, query.text, exact) || fieldMatches(node.value, query.text, exact);
		const matchesId = query.identifier === undefined || fieldMatches(node.identifier ?? '', query.identifier, exact);
		const matchesRole = role === undefined || node.role === role;
		const hasTerm = query.text !== undefined || query.identifier !== undefined || role !== undefined;
		if (hasTerm && matchesText && matchesId && matchesRole && (!query.interactableOnly || interactable) && onScreen(node, snapshot.screen)) {
			const { x, y, width, height } = node.frame;
			found.push({
				role: node.role, type: node.type, label: node.label, value: node.value,
				...(node.identifier ? { identifier: node.identifier } : {}),
				enabled: node.enabled, interactable, frame: node.frame,
				center: { x: Math.round((x + width / 2) * 10) / 10, y: Math.round((y + height / 2) * 10) / 10 },
			});
		}
		for (const child of node.children) {
			visit(child);
		}
	};
	visit(snapshot.root);
	return { total: found.length, matches: found.slice(0, limit) };
}

/**
 * タップする要素を 1 つ選ぶ。タップに応える要素を先に、同じなら小さい（いちばん内側の）要素。
 * 見つからなければ undefined。
 */
export function paradisPickSimulatorAxTarget(matches: readonly IParadisSimulatorAxMatch[]): IParadisSimulatorAxMatch | undefined {
	let best: IParadisSimulatorAxMatch | undefined;
	for (const match of matches) {
		if (!best) {
			best = match;
			continue;
		}
		if (match.interactable !== best.interactable) {
			if (match.interactable) {
				best = match;
			}
			continue;
		}
		if (match.frame.width * match.frame.height < best.frame.width * best.frame.height) {
			best = match;
		}
	}
	return best;
}

/** 欄（field）の値を、位置と識別子で引けるように集める（mobile_type_text の前の値を覚えるため）。 */
export function paradisSimulatorFieldValues(snapshot: IParadisSimulatorAxSnapshot): Map<string, string> {
	const values = new Map<string, string>();
	const visit = (node: IParadisSimulatorAxNode) => {
		if (node.role === 'field') {
			values.set(fieldKey(node), node.value);
		}
		node.children.forEach(visit);
	};
	visit(snapshot.root);
	return values;
}

function fieldKey(node: IParadisSimulatorAxNode): string {
	return `${node.identifier ?? ''}|${Math.round(node.frame.x)},${Math.round(node.frame.y)},${Math.round(node.frame.width)},${Math.round(node.frame.height)}`;
}

/**
 * 文字を入れる前の欄の値（`before`）と比べて、値が変わった最初の欄に `focused` を付けた木を返す。
 * 変わった欄が無ければそのまま返す。
 */
export function paradisMarkTypedSimulatorField(snapshot: IParadisSimulatorAxSnapshot, before: ReadonlyMap<string, string>): IParadisSimulatorAxSnapshot {
	let marked = false;
	const visit = (node: IParadisSimulatorAxNode): IParadisSimulatorAxNode => {
		const children = node.children.map(visit);
		const changed = !marked && node.role === 'field' && before.has(fieldKey(node)) && before.get(fieldKey(node)) !== node.value;
		if (changed) {
			marked = true;
		}
		return changed ? { ...node, children, focused: true } : children.some((child, index) => child !== node.children[index]) ? { ...node, children } : node;
	};
	// 子から先に見るので、入れ子の欄では内側が先に印を受ける
	const root = visit(snapshot.root);
	return root === snapshot.root ? snapshot : { ...snapshot, root };
}
