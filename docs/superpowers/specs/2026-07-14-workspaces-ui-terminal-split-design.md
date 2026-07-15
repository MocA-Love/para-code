# Workspaces UI and Terminal Split Design

## 目的

Workspacesサイドバーのリポジトリ開閉状態をアプリ再起動後も復元し、設定を有効にした場合だけeditor split直後に分割先へ新規terminalを開く。

## 採用方式

開閉状態はworkspace storageへcollapsed repository IDの集合として保存する。Split動作は通常の`paradis`設定として登録し、4方向のeditor split commandが作成したgroupを明示してterminal editorを生成する。

## Workspaces開閉状態

- storage keyはPara Code固有名とし、値はcollapsedなrepository IDのJSON配列にする。
- `StorageScope.WORKSPACE`とmachine targetを使用し、別workspaceの状態を混在させない。
- view初期化時に配列を検証してSetへ読み込む。壊れた値は空集合として扱う。
- repository nodeのcollapse eventでSetを更新し、100msのschedulerで保存する。
- tree refreshでは同一セッションの現在状態を優先し、初登場repositoryだけを展開する。
- repository削除時は不要IDをSetから削除して保存する。
- worktree childの展開状態は保存対象にしない。

## Split設定

- 設定名は`paradis.editor.openTerminalOnSplit`とする。
- Para Code設定セクション、boolean、window scope、default `false`で登録する。
- OFFでは現在どおり新groupを空のままfocusする。
- ONではsplitで作成したgroupのview columnを明示して、新しいterminal editorを1つ生成する。
- 既存terminalは再利用しない。
- terminal生成後はそのinstanceをfocusする。
- Right、Down、Left、Upの4方向command、通常のSplit Editor action、Split Editor Orthogonal actionへ同じ設定を適用する。
- `Split Editor in Group`は新しいeditor groupを作らない別機能のため対象外とする。
- terminal生成失敗時は作成済みgroupを削除せず空のまま残し、notificationへエラーを表示する。

## エラー処理

- storage JSONが配列でない、IDが文字列でない、読込に失敗した場合は開閉状態を初期化する。
- 保存失敗はview操作を妨げず、ログへ記録する。
- terminal service未対応環境では空group動作へ安全に戻す。
- split後にgroupがdisposeされた場合、遅れて作られたterminalを別groupへ開かない。

## 検証

- repositoryを閉じ、workbench再生成後も閉じた状態になる。
- repositoryごとの状態が独立し、別workspaceへ漏れない。
- repository削除後にstale IDが保存値から消える。
- 設定OFFで4方向とも空groupになる。
- 設定ONで4方向とも分割先に新規terminalが1つ作られる。
- 通常のSplit Editor actionとOrthogonal actionも設定ON/OFFに従う。
- 既存terminalが別groupから移動・再利用されない。
- terminal生成失敗時に空groupが残り、エラー通知される。
- split直後にgroupがdisposeされた競合で別groupへterminalが開かれない。

## レビュー境界

開閉状態永続化とSplit設定を別タスクとして実装・レビューする。両方のCritical/Important指摘を解消した後、全9件を対象に最終統合レビューを行う。
