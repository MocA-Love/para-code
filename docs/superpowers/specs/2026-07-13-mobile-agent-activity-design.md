# Mobile Agent Activity Design

## Scope

モバイルの親エージェント画面から、Claude Code と Codex の SubAgent・Task・Web検索を同じ情報階層で確認できるようにする。親画面では実行中項目だけをコンパクトに示し、一覧画面と SubAgent 専用画面では親セッション配下であることを常に明示する。

## Activity hierarchy

- 親エージェント画面: ヘッダー直下に実行中の SubAgent / Task を固定表示する。
- アクティビティ一覧: セッション内の完了済みを含む SubAgent / Task と compaction を上限付きで表示する。
- SubAgent 詳細: provider、状態、指示内容、関連 Task、SubAgent transcript を表示する。
- 詳細要求は親セッションの token、epoch、購読状態、既知 SubAgent ID を PC 側で再検証する。

## Web search and favicon transport

検索開始と検索結果は発生時刻の位置にそれぞれ表示し、途中の会話やツール実行の順序を変えない。結果 URL から抽出するのは最大6件のホスト名だけで、IPアドレス、localhost、`.local`、`.internal` は対象外とする。

既定表示はローカル生成のドメイン頭文字アイコンとし、外部通信しない。ユーザーが各検索カード内の説明付き操作を明示的に押した場合だけ、モバイルから Google S2 favicon service へホスト名を送って取得する。検索クエリ、パス、URLパラメーターは送信しない。この方式では Google に利用者のIPアドレスと参照ドメインが伝わるため、画像取得失敗時はローカルアイコンへフォールバックする。将来、PC relay にキャッシュ付き favicon proxy を設けられる場合は、この外部通信を relay 側へ移す。
