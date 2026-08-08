// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 通知の見出しの組み立て（受け取る側の担当ぶん）。
 *
 * PCは「ワークツリー名（title）」と「エージェント種別（subtitle）」までしか作れない。
 * 何台のPCとペアリングしているかを知っているのは電話側だけで、1台しか繋いでいない人に
 * PC名を出しても場所を食うだけになるためで、2台以上のときにPC名を継ぎ足すのはここの役目。
 *
 * アプリ未起動時に同じ組み立てをするのは通知拡張（ios/NotifyExtension/NotificationService.swift）。
 * 出来上がりが食い違うと、繋がっているときと切れているときで通知の見た目が変わってしまうので、
 * 規則を変えるときは必ず両方を直すこと。
 *
 * **材料の出どころだけは揃えられない**。拡張からは台帳が見えないため、向こうは台数を
 * 「共有Keychainに入っている鍵の本数」で、PC名を「PCが名乗った名前」で代用している。
 * 孤児鍵が残っていたり、こちらで名前を付け替えていると表示が食い違う（遷移先は別に決めるので実害はない）。
 */

/** 中黒は前後に空白を置く（iOSの通知でPC名と種別が詰まって読めなくなるのを避ける）。 */
const SEPARATOR = ' · ';

/**
 * タイトルの下に出す一行を作る。
 *
 * @param subtitle PCが名乗ったエージェント種別（例: 'Claude'）。旧PCからは届かない
 * @param pcName   そのPCの表示名。台帳側の名前（ユーザーが付け替えたもの）を優先して渡すこと
 * @param multiplePcs 2台以上とペアリングしているか
 * @returns 出す一行。出すものが何も無ければ undefined
 */
export function notifySubtitle(subtitle: string | undefined, pcName: string | undefined, multiplePcs: boolean): string | undefined {
	const parts: string[] = [];
	const agent = subtitle?.trim();
	if (agent !== undefined && agent.length > 0) {
		parts.push(agent);
	}
	const pc = multiplePcs ? pcName?.trim() : undefined;
	if (pc !== undefined && pc.length > 0) {
		parts.push(pc);
	}
	return parts.length > 0 ? parts.join(SEPARATOR) : undefined;
}
