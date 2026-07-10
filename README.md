# Van!shment chat

二人だけの、消えていくチャット。

同じ「あいことば」を入力した二人がつながり、会話を終えるとメッセージは消えます。相手のメッセージは送信した瞬間だけ読めて、自分が返信するとゴースト（透明な吹き出し）に変わります。

## URL

https://crazy-music-man.github.io/vanishment-chat-app/remote.html

## 構成

| レイヤー | ホスト | 技術 |
|---------|--------|------|
| フロントエンド | GitHub Pages | HTML / CSS / vanilla JS |
| WebSocket 中継 | Cloudflare Workers + Durable Objects | JavaScript (worker/) |

## ローカル開発

```bash
# Worker（WebSocket中継サーバー）
cd worker
npm install
npx wrangler dev

# 別ターミナルでHTMLを配信
python3 -m http.server 8000
# → http://localhost:8000/remote.html を開く
```

ローカルでは自動的に `ws://localhost:8787` に接続されます。

## デプロイ

```bash
# Worker
cd worker
npx wrangler deploy

# フロントエンド
git push  # GitHub Pages が自動反映
```

---

## Changelog

### v1.0.1 (2026-07-10)

- ロビーの説明文を簡潔に変更
- CSS / JS を外部ファイル（style.css, app.js）に分離し、remote.html を構造のみに整理
- 退出・終了処理の重複コードを `resetToLobby()` に共通化

### v1.0.0 (2026-07-10)

初回リリース。

- あいことば（ルーム名）で二人がマッチングするチャット
- 相手のメッセージは返信するとゴースト化（内容が消えて輪郭だけ残る）
- スタンプリアクション（8種）
- 「一時退出」と「終了」の選択 ― 終了すると相手にも通知されルームが閉じる
- メッセージ内の URL を自動でハイパーリンク化
- チャット全体のスクリーンショット保存（シャッターボタン → 長押しで保存）
- 返信までの時間に応じて吹き出し間のギャップが変化
- シアン〜クリームのグラデーション背景 UI
- GitHub Pages + Cloudflare Workers によるサーバーレス構成
