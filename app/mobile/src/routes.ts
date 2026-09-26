// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 作り直し後の画面のルート（Orca と同じ「PC → スペース → セッション」の押し進む階層）。
 *
 * | ルート | 画面 |
 * |---|---|
 * | `/` | ホーム（PC のカード・再開・クイック操作・使用量） |
 * | `/pc/[pcId]` | PC の画面（スペースとエージェントの一覧） |
 * | `/pc/[pcId]/session/[spaceId]?tab=…` | セッション（エージェント・ターミナル・ブラウザのタブ） |
 * | `/pc/[pcId]/source-control/[spaceId]` | ソース管理 |
 * | `/pc/[pcId]/review/[spaceId]?path=…` | 差分レビュー |
 * | `/pc/[pcId]/files/[spaceId]?path=…` | ファイル |
 * | `/notifications` | 通知の一覧 |
 * | `/settings`・`/settings/<page>` | 設定と、その下の各ページ |
 * | `/pair`・`/onboarding` | ペアリング・はじめて |
 *
 * 画面を移るときは文字列を組み立てず、ここの関数で行き先を作る（`router.push(routes.session(...))`）。
 * ID は任意の文字列（ワークスペースの ID は `1:w1` のような形）なので、パスへの埋め込みは
 * expo-router の `params` に任せて符号化させる。
 *
 * 画面から切り離した純関数なので、組み立てと読み戻しをテストで固定している（`routes.test.ts`）。
 */

/** expo-router の `Href` に渡せる形（型付きルートは使っていないので自前で持つ）。 */
export type RouteHref = string | { readonly pathname: string; readonly params: Readonly<Record<string, string>> };

/**
 * セッション画面で開くタブ。エージェントとターミナルは PC のターミナル（`terminalKey`）1つに対応し、
 * ブラウザは PC の para-browser のミラー（スペースに1つ）。
 */
export type SessionTab =
	| { readonly kind: 'terminal'; readonly terminalKey: string }
	| { readonly kind: 'browser' };

const TERMINAL_TAB_PREFIX = 'terminal:';
const BROWSER_TAB = 'browser';

/** セッションのタブをクエリの値にする（`terminal:<terminalKey>` か `browser`）。 */
export function encodeSessionTab(tab: SessionTab): string {
	return tab.kind === 'browser' ? BROWSER_TAB : `${TERMINAL_TAB_PREFIX}${tab.terminalKey}`;
}

/** クエリの値からセッションのタブを読み戻す。形が違えば undefined（＝既定のタブを開く）。 */
export function parseSessionTab(raw: string | readonly string[] | undefined): SessionTab | undefined {
	const value = firstParam(raw);
	if (value === BROWSER_TAB) {
		return { kind: 'browser' };
	}
	if (value !== undefined && value.startsWith(TERMINAL_TAB_PREFIX) && value.length > TERMINAL_TAB_PREFIX.length) {
		return { kind: 'terminal', terminalKey: value.slice(TERMINAL_TAB_PREFIX.length) };
	}
	return undefined;
}

/**
 * `useLocalSearchParams()` の値は、同じ名前が複数あると配列になる。先頭の1つだけを使う。
 * 空文字は「無い」とみなす。
 */
export function firstParam(raw: string | readonly string[] | undefined): string | undefined {
	const value = typeof raw === 'string' ? raw : raw?.[0];
	return value === undefined || value.length === 0 ? undefined : value;
}

/** 設定の下のページ（`/settings/<page>`）。 */
export type SettingsPage = 'usage' | 'notifications' | 'terminal' | 'presets' | 'pcs' | 'changelog' | 'about';

/** セッションを開くときの指定。 */
export interface SessionRouteOptions {
	/** 開くタブ。省略すると画面が既定のタブ（要対応のエージェントなど）を選ぶ。 */
	readonly tab?: SessionTab;
	/**
	 * 「新しく開いた」ことを示す一度限りの印（`createAgentLatestEntryToken()`）。
	 * 通知やホームから開いたときに会話の最新まで送る判定に使う（`shouldHandleLatestEntry`）。
	 */
	readonly latest?: string;
}

function withOptional(params: Record<string, string>, extra: Record<string, string | undefined>): Record<string, string> {
	const result = { ...params };
	for (const [key, value] of Object.entries(extra)) {
		if (value !== undefined && value.length > 0) {
			result[key] = value;
		}
	}
	return result;
}

export const routes = {
	home: (): RouteHref => '/',
	pc: (pcId: string): RouteHref => ({ pathname: '/pc/[pcId]', params: { pcId } }),
	session: (pcId: string, spaceId: string, options: SessionRouteOptions = {}): RouteHref => ({
		pathname: '/pc/[pcId]/session/[spaceId]',
		params: withOptional({ pcId, spaceId }, {
			tab: options.tab !== undefined ? encodeSessionTab(options.tab) : undefined,
			latest: options.latest,
		}),
	}),
	sourceControl: (pcId: string, spaceId: string): RouteHref => ({
		pathname: '/pc/[pcId]/source-control/[spaceId]',
		params: { pcId, spaceId },
	}),
	/** `path` を渡すとそのファイルから見始める。 */
	review: (pcId: string, spaceId: string, path?: string): RouteHref => ({
		pathname: '/pc/[pcId]/review/[spaceId]',
		params: withOptional({ pcId, spaceId }, { path }),
	}),
	/** `path` を渡すとそのフォルダ・ファイルを開く。 */
	files: (pcId: string, spaceId: string, path?: string): RouteHref => ({
		pathname: '/pc/[pcId]/files/[spaceId]',
		params: withOptional({ pcId, spaceId }, { path }),
	}),
	notifications: (): RouteHref => '/notifications',
	settings: (page?: SettingsPage): RouteHref => (page === undefined ? '/settings' : `/settings/${page}`),
	pair: (): RouteHref => '/pair',
	onboarding: (): RouteHref => '/onboarding',
} as const;
