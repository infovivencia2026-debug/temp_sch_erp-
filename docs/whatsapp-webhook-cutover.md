# WhatsApp webhook cutover (Connect -> ERP)

Meta sends WhatsApp events to one URL. After this change it calls the ERP, and
the ERP passes every event on to Yajur Connect unchanged. Both keep working.

## 1. Set three secrets (in the `worker` folder)

```
npx wrangler secret put WHATSAPP_APP_SECRET
npx wrangler secret put WHATSAPP_VERIFY_TOKEN
npx wrangler secret put WA_FORWARD_URL
```

- WHATSAPP_APP_SECRET: Meta app -> Settings -> Basic -> App secret (Show).
  Connect already has the same value in its META_APP_SECRET env or data/settings.json.
- WHATSAPP_VERIFY_TOKEN: any new random string, e.g. from `openssl rand -hex 16`. Keep it for step 2.
- WA_FORWARD_URL: `https://connect.yajur.org/webhooks/whatsapp`

## 2. Point Meta at the ERP

Callback URL: `https://yjps.xulo.in/api/v1/public/webhooks/whatsapp`
(the worker serves `/api/v1/public/webhooks/whatsapp` on every school host).

Meta -> your app -> WhatsApp -> Configuration -> Webhook -> Edit:
paste the callback URL and the verify token, press Verify and save.
Keep the "messages" field subscribed.

## 3. Check

Send a message to the school number from your phone: it should show in Connect
as before, and ticks (delivered/read) should show on ERP messages.

## Roll back

Meta -> WhatsApp -> Configuration -> Edit: put back
`https://connect.yajur.org/webhooks/whatsapp` with Connect's own verify token.
