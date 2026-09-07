# iCloud Album Viewer

iCloud 共有アルバムの公開リンクを読み込み、写真と動画を軽い時系列ビューで表示する家族向けビューアーです。

## 機能

- iCloud 共有アルバムの固定 URL をサーバー側に保存
- メールアドレスとパスワードによるアプリ内ログイン
- 管理者ページから家族用アカウントを発行
- 招待リンクから各ユーザーが初回パスワードを設定
- 各ユーザー自身のアカウントページからパスワード変更
- 管理者によるユーザー削除
- 写真と動画の時系列表示
- 日付カードを検出して、前後の写真の日付補正に利用
- 大きいアルバムでも初期表示が重くなりにくい段階的な画像 URL 取得

## ローカル起動

`.env.example` を参考に `.env` を作成します。

```env
ALBUM_VIEWER_ADMIN_EMAIL=admin@example.com
ALBUM_VIEWER_ADMIN_PASSWORD=change-this-password
ALBUM_VIEWER_SESSION_SECRET=use-a-long-random-string
ICLOUD_SHARED_ALBUM_URL="https://www.icloud.com/sharedalbum/ja-jp/#..."

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your@gmail.com
SMTP_PASS=your-google-app-password
SMTP_FROM="iCloud Album Viewer <your@gmail.com>"
```

```bash
npm install
npm start
```

ブラウザで `http://localhost:4173/login` を開きます。

## Cloudflare 構成

Cloudflare は無料ホスティングと D1 データベースだけに使います。ログイン、ユーザー管理、招待リンク、パスワード変更はアプリ内 UI で行います。

使う Cloudflare サービス:

- Workers Static Assets: HTML/CSS/JS の配信
- Workers: iCloud アルバム取得 API と認証処理
- D1: ユーザー、招待、セッションの保存

Cloudflare Access はこの構成では不要です。アプリ内ログイン画面を使うため、Access アプリは無効化または削除してください。

## Cloudflare 用の環境変数

本番 Worker には Wrangler secret で設定します。

```bash
npx wrangler secret put ICLOUD_SHARED_ALBUM_URL --name icloud-album-viewer
npx wrangler secret put ALBUM_VIEWER_ADMIN_EMAIL --name icloud-album-viewer
npx wrangler secret put ALBUM_VIEWER_ADMIN_PASSWORD --name icloud-album-viewer
npx wrangler secret put ALBUM_VIEWER_SESSION_SECRET --name icloud-album-viewer
```

招待メールを自動送信したい場合、Cloudflare Worker から SMTP は直接使えません。独自ドメインがない場合は Google Apps Script を Gmail 送信用の小さな Webhook として使います。

Google Apps Script 側の作成手順:

1. https://script.google.com/ を開く
2. 「新しいプロジェクト」を作成
3. `docs/google-apps-script-mailer.gs` の内容を貼り付ける
4. `MAIL_SECRET` を長いランダム文字列に変更
5. 「デプロイ」>「新しいデプロイ」> 種類で「ウェブアプリ」を選択
6. 「次のユーザーとして実行」は「自分」
7. 「アクセスできるユーザー」は「全員」
8. デプロイして Google の承認を済ませ、表示されたウェブアプリ URL を控える

控えた URL と `MAIL_SECRET` に入れた文字列を Worker secret に設定します。

```bash
npx wrangler secret put GOOGLE_MAIL_WEBHOOK_URL --name icloud-album-viewer
npx wrangler secret put GOOGLE_MAIL_WEBHOOK_SECRET --name icloud-album-viewer
npx wrangler secret put GMAIL_FROM --name icloud-album-viewer
npx wrangler secret put MAIL_REPLY_TO --name icloud-album-viewer
```

`GMAIL_FROM` と `MAIL_REPLY_TO` は Gmail アドレスを入れます。メール本文の送信元名は `iCloud Album Viewer` になります。

独自ドメインを取得した場合は Resend も使えます。Resend で必要なもの:

- Resend アカウント
- 送信元ドメインの認証
- API Key

```bash
npx wrangler secret put RESEND_API_KEY --name icloud-album-viewer
npx wrangler secret put MAIL_FROM --name icloud-album-viewer
npx wrangler secret put MAIL_REPLY_TO --name icloud-album-viewer
```

Google Apps Script または Resend が未設定でも、管理者ページに招待リンクが表示されるためアカウント発行はできます。

メール設定後は `/admin` の「メール送信」から、自分宛にテストメールを送れます。

## D1

初回またはスキーマ変更後にマイグレーションを適用します。

```bash
npm run cf:migrate:local
npm run cf:migrate:remote
```

## Cloudflare ローカル確認

```bash
npm run cf:dev -- --env-file .env
```

標準では `http://127.0.0.1:8787`、ポート指定時は指定した URL を開きます。

## デプロイ

```bash
npm run cf:deploy
```

現在の Worker URL:

```text
https://icloud-album-viewer.h-ryo1103.workers.dev
```

## 管理

管理者でログイン後、`/admin` から家族アカウントを発行します。メール API が未設定のときは招待リンクが画面に表示されます。各メンバーは招待リンクからパスワードを設定し、以後は `/login` からログインします。

各メンバーのパスワード変更は `/account` から本人だけが行います。

## テスト

```bash
npm test
```
