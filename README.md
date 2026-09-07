# iCloud Album Viewer

iCloud共有アルバムの公開リンクを読み込み、軽い時系列ギャラリーとして表示する家族向けビューアーです。

## 機能

- iCloud共有アルバムの固定リンクをサーバー側で保持
- メールアドレスとパスワードによるログイン保護
- 管理者ページから家族用アカウントを招待
- 招待メールのリンクから各ユーザーが初回パスワードを設定
- 各ユーザー本人によるパスワード変更
- 管理者によるユーザー削除
- 写真と動画を時系列表示
- 日付カードを自動判定して通常表示から除外
- 大きいアルバムでも初期表示が重くなりにくい段階的な画像URL取得

## セットアップ

`.env.example` を参考に `.env` を作成してください。

```env
ALBUM_VIEWER_ADMIN_EMAIL=admin@example.com
ALBUM_VIEWER_ADMIN_PASSWORD=change-this-password
ALBUM_VIEWER_SESSION_SECRET=use-a-long-random-string
ALBUM_VIEWER_ADMIN_RESET=false
INVITE_TTL_HOURS=72
ICLOUD_SHARED_ALBUM_URL="https://www.icloud.com/sharedalbum/ja-jp/#..."

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your@gmail.com
SMTP_PASS=your-google-app-password
SMTP_FROM="iCloud Album Viewer <your@gmail.com>"
```

初回起動時に管理者が存在しなければ、`ALBUM_VIEWER_ADMIN_EMAIL` と `ALBUM_VIEWER_ADMIN_PASSWORD` で管理者を作成します。既存管理者のメールアドレスやパスワードを `.env` から反映したい場合だけ、一度 `ALBUM_VIEWER_ADMIN_RESET=true` にして再起動してください。反映後は `false` に戻します。

## 起動

```bash
npm install
npm start
```

ブラウザで `http://localhost:4173/login` を開きます。

## メール送信

GmailをSMTPに使う場合は、Googleアカウントの2段階認証を有効にし、アプリパスワードを発行して `SMTP_PASS` に設定します。Gmailのアプリパスワードは画面上でスペース区切り表示されることがありますが、このアプリではスペースを除去して認証に使います。

SMTP未設定でもアカウント発行はできます。その場合、管理者画面とサーバーログに招待リンクが表示されます。

## 配置について

このアプリはNode.jsサーバーで動きます。ログイン、SMTP、iCloudアルバム取得、ユーザー保存をサーバー側で処理するため、GitHub Pagesのような静的ホスティングだけでは動作しません。

GitHubにはプライベートリポジトリとしてソースコードを置き、本番公開はNode.jsが動く環境に配置してください。`.env` と `data/` はリポジトリに含めません。

## Cloudflare無料運用

Cloudflare Workers + Static Assets + Cloudflare Accessで運用できます。この構成ではアプリ内のログイン、SMTP、ユーザー管理をCloudflare Accessに任せます。

Cloudflare側には以下の環境変数を設定します。

```env
ICLOUD_SHARED_ALBUM_URL="https://www.icloud.com/sharedalbum/ja-jp/#..."
CACHE_TTL_SECONDS=600
```

OpenAI画像認識を使う場合だけ、追加で `OPENAI_API_KEY` を設定します。費用ゼロ運用を優先する場合は未設定のままにしてください。

ローカルでCloudflare版を確認する場合は `.dev.vars.example` を参考に `.dev.vars` を作り、以下を実行します。

```bash
npm run cf:dev
```

Cloudflareへ直接デプロイする場合は以下です。

```bash
npm run cf:deploy
```

## コマンド

```bash
npm test
npm start
```
