// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ホーム画面・ロック画面のウィジェットと Live Activity が開くリンク（`paracode-mobile:///widget/<行き先>?…`）を、
 * いまの画面のルートへ書き換える純関数（`legacyLinks.ts` の `redirectLegacyLink` から呼ぶ）。
 * Live Activity（`native/ParaCodeWidgets/ParaCodeLiveActivity.swift`）は、表示していた1件のセッションを
 * `session` で直接開く（中継の画面で PC の状態を待たない）。PC・スペースが分からないときだけ中継の画面へ落ちる。
 *
 * ウィジェット（Swift）はルートの形を知らず、行き先の種類と ID だけをクエリで渡す。ルートを変えたときに
 * 直すのはここだけで済み、ウィジェットのタイムラインに古い URL が残っていても開ける。
 * ID（ワークスペースの `1:w1` など）はクエリで受け、パスへ埋めるときに符号化する。
 *
 * | リンク | 行き先 |
 * |---|---|
 * | `/widget/attention` | 中継の画面（要対応のセッションへ。無ければホーム） |
 * | `/widget/session?pc=…&space=…&terminal=…&latest=…` | セッション（エージェントのタブ）。許可カード・質問はここで答える |
 * | `/widget/pc?pc=…` | PC の画面 |
 * | `/widget/home` | ホーム |
 * | `/widget/system?pc=…` | 設定 → 使用量 → システム |
 * | `/widget/source-control?pc=…&space=…` | ソース管理 |
 * | `/widget/review?pc=…&space=…` | 差分のレビュー |
 * | `/widget/pair` | ペアリング |
 * | `/widget/settings` | 設定 → ウィジェット |
 */

export const WIDGET_LINK_PREFIX = '/widget/';

const OPEN_SESSION = '/open-session';

function readQuery(query: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const pair of query.split('&')) {
		const at = pair.indexOf('=');
		if (at <= 0) {
			continue;
		}
		const name = pair.slice(0, at);
		let value: string;
		try {
			value = decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' '));
		} catch {
			continue;
		}
		if (value.length > 0 && value.length <= 500 && !result.has(name)) {
			result.set(name, value);
		}
	}
	return result;
}

function segment(value: string): string {
	return encodeURIComponent(value);
}

function withQuery(path: string, params: readonly (readonly [string, string | undefined])[]): string {
	const parts = params
		.filter((entry): entry is readonly [string, string] => entry[1] !== undefined && entry[1].length > 0)
		.map(([name, value]) => `${name}=${encodeURIComponent(value)}`);
	return parts.length > 0 ? `${path}?${parts.join('&')}` : path;
}

/**
 * ウィジェットのリンクなら書き換えた行き先。`pathname` は先頭が `/widget/` のパス、`query` は `?` の後ろ。
 * 知らない行き先はホームへ（「Unmatched Route」にしない）。
 */
export function redirectWidgetLink(pathname: string, query: string): string {
	const target = pathname.slice(WIDGET_LINK_PREFIX.length);
	const q = readQuery(query);
	const pc = q.get('pc');
	const space = q.get('space');
	switch (target) {
		case 'attention':
			return OPEN_SESSION;
		case 'session': {
			if (pc === undefined) {
				return OPEN_SESSION;
			}
			if (space === undefined) {
				return `/pc/${segment(pc)}`;
			}
			const terminal = q.get('terminal');
			return withQuery(`/pc/${segment(pc)}/session/${segment(space)}`, [
				['tab', terminal !== undefined ? `terminal:${terminal}` : undefined],
				['latest', q.get('latest')],
			]);
		}
		case 'pc':
			return pc !== undefined ? `/pc/${segment(pc)}` : '/';
		case 'home':
			return '/';
		case 'system':
			return '/settings/usage/system';
		case 'source-control':
			return pc !== undefined && space !== undefined ? `/pc/${segment(pc)}/source-control/${segment(space)}` : pc !== undefined ? `/pc/${segment(pc)}` : '/';
		case 'review':
			return pc !== undefined && space !== undefined ? `/pc/${segment(pc)}/review/${segment(space)}` : pc !== undefined ? `/pc/${segment(pc)}` : '/';
		case 'pair':
			return '/pair';
		case 'settings':
			return '/settings/widgets';
		default:
			return '/';
	}
}
