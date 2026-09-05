# Push notifications to the parent app

The parent app is a WebView shell, and a closed app has no page to poll. Push
is the one thing the platform has to do: Firebase Cloud Messaging wakes the
app's `PushService`, which posts the phone's own notification and opens the
link inside the app when tapped.

Everything is built and dormant. Two files switch it on; neither lives in git.

## 1. Firebase project (once)

1. Create a project at https://console.firebase.google.com and add an Android
   app with package name `com.schoolerp.parent`.
2. Download `google-services.json` and place it at
   `mobile/apps/parent/app/google-services.json`. Rebuild the APK. Without the
   file the build still succeeds and the app simply has no push.
3. Project settings → Service accounts → Generate new private key. Save the
   JSON on the server, e.g. `/etc/temperp/fcm-service-account.json`, readable
   by the worker's user only.

## 2. Server

Set `FCM_SERVICE_ACCOUNT_FILE=/etc/temperp/fcm-service-account.json` in the
worker's environment file and restart the worker. On start it logs
`push pump started`; without the variable it logs
`push disabled: FCM_SERVICE_ACCOUNT_FILE not set` and nothing else changes.

## How it flows

- After sign-in the site reads the device token from the app's bridge and
  `PUT /api/v1/me/push-token` records it against that account
  (`push_tokens`). Signing out deletes the account's tokens.
- The worker's pump (`internal/api/push_tokens.go`) runs every five seconds.
  Once a minute it materialises family alerts for every token holder, the same
  pass the alert feed runs when opened, so an app that is never opened still
  has rows written. Then it hands every new `notifications` row younger than
  a day to the phones of its user and marks it `pushed_at`. Every alert kind
  the product writes is covered, because the pump reads the table they all
  write.
- Tokens Firebase reports as unregistered are deleted.

## Checking it

```
journalctl -u temperp-worker -f | grep push
```
`push: pass rows=N sent=M` appears whenever something went out.
