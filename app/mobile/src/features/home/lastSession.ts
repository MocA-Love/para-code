// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ホームの「再開」カードの記録（最後に開いたセッション）。形と読み戻しだけを持つ純関数で、
 * 保存と購読は `lastSessionStore.ts`。
 *
 * 表示に要る名前（ターミナル名・スペース名・ブランチ・色）も一緒に持つ。再開カードは別の PC の
 * セッションを指すことがあり、そのときストアには相手のスペースの情報が無いため。
 */
export interface LastSession {
	readonly pcId: string;
	readonly spaceId: string;
	/** 開いていたタブのターミナル。無ければスペースの既定のタブを開く。 */
	readonly terminalKey?: string;
	/** カードの見出し（ターミナル名。無ければスペース名）。 */
	readonly title: string;
	readonly spaceName: string;
	readonly branch?: string;
	/** スペースの色（点に使う）。 */
	readonly color?: string;
	/** 開いた時刻（epoch ms）。 */
	readonly at: number;
}

/** 名前として持つ長さの上限（壊れた値や長すぎる値で画面が崩れないように）。 */
const TEXT_MAX = 200;

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value.slice(0, TEXT_MAX) : undefined;
}

/** 保存された値を読み戻す。形が違えば undefined（カードを出さない）。 */
export function parseLastSession(raw: unknown): LastSession | undefined {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return undefined;
	}
	const value = raw as Record<string, unknown>;
	const pcId = text(value['pcId']);
	const spaceId = text(value['spaceId']);
	const title = text(value['title']);
	const spaceName = text(value['spaceName']);
	const at = value['at'];
	if (pcId === undefined || spaceId === undefined || title === undefined || spaceName === undefined || typeof at !== 'number' || !Number.isFinite(at)) {
		return undefined;
	}
	const terminalKey = text(value['terminalKey']);
	const branch = text(value['branch']);
	const color = text(value['color']);
	return {
		pcId,
		spaceId,
		title,
		spaceName,
		at,
		...(terminalKey !== undefined ? { terminalKey } : {}),
		...(branch !== undefined ? { branch } : {}),
		...(color !== undefined ? { color } : {}),
	};
}

/**
 * 記録しようとしている値が、いまの記録と同じ中身か（開いた時刻は比べない）。同じなら保存し直さない
 * （セッション画面は開いている間に何度も記録を呼ぶので、Keychain へ書く回数を抑える）。
 */
export function sameLastSession(current: LastSession | undefined, next: Omit<LastSession, 'at'>): boolean {
	return current !== undefined
		&& current.pcId === next.pcId
		&& current.spaceId === next.spaceId
		&& current.terminalKey === next.terminalKey
		&& current.title === next.title
		&& current.spaceName === next.spaceName
		&& current.branch === next.branch
		&& current.color === next.color;
}

/** 再開カードの下の一文（「para-code · feat/auth」）。 */
export function lastSessionSubtitle(session: LastSession): string {
	return session.branch !== undefined ? `${session.spaceName}  ·  ${session.branch}` : session.spaceName;
}
