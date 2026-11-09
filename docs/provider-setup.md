# Operator walkthrough: Gmail and Microsoft 365 OAuth apps

Superlocal connects Gmail and Microsoft 365 (Office 365 / Exchange Online)
mailboxes through OAuth clients that **you** register and the local host owns.
This guide covers registering both apps, configuring the host, and connecting
mailboxes. It takes about 15 minutes per provider.

The examples assume the default local origin, **`http://localhost:5178`**. If you
changed `web.port` or `web.origin`, or you run a remote install, replace that origin
everywhere below. Redirect URIs must match **exactly**, including scheme, host,
port and path.

| Provider | Redirect URI to register |
| --- | --- |
| Gmail | `http://localhost:5178/v1/oauth/google/callback` |
| Microsoft 365 | `http://localhost:5178/v1/oauth/microsoft/callback` |

> Always open Superlocal at the configured origin (`http://localhost:5178`, not
> `127.0.0.1:5178`) before connecting. The host refuses to start OAuth from a
> different origin, because the session and callback must share one origin.

---

## 1. Register the Google OAuth client

You need a Google account that can create Google Cloud projects. The Gmail
mailboxes you connect can belong to any Google account you add as a test user.

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create
   or select a project (for example, `superlocal`).
2. **Enable the Gmail API:** APIs & Services → Library → *Gmail API* → **Enable**.
3. **Configure consent:** open *Google Auth Platform* (shown in older consoles as *OAuth consent screen*).
   - **Branding:** set an app name (for example, `Superlocal`), your support email
     and your developer contact email.
   - **Audience:**
     - *Internal* is available only if every mailbox is in your own Google
       Workspace organization. It needs no test users and its tokens don't expire
       weekly.
     - *External* is for personal Gmail or mixed accounts. Leave it in
       **Testing** and add **every Gmail address you will connect** under
       *Test users*.
   - **Data access (optional but recommended):** add the scopes Superlocal requests
     so the consent screen lists them:
     `openid`, `.../auth/userinfo.email`, `https://www.googleapis.com/auth/gmail.modify`,
     `https://www.googleapis.com/auth/gmail.send`.
4. **Create the client:** Clients (or Credentials) → **Create client** →
   application type **Web application**.
   - Name: `Superlocal local host`
   - **Authorized redirect URIs:** `http://localhost:5178/v1/oauth/google/callback`
   - Authorized JavaScript origins: not needed.
5. Copy the **Client ID** (`…apps.googleusercontent.com`) and the **Client secret**
   (`GOCSPX-…`). Google only shows the secret in full once, when you create it.

**Testing-mode caveat:** for an *External* app in Testing, Google expires refresh
tokens for Gmail scopes after **7 days**. The mailbox then shows *Sign in again*.
To avoid weekly reconnects, use an *Internal* app. Publishing an External app with
restricted Gmail scopes requires Google's verification and security assessment.

If you also use Google sign-in to restrict access to a remote install, register
`https://<your-origin>/api/auth/callback/google` on the same client. See *Restricted
Google access* in the README.

---

## 2. Register the Microsoft Entra app

You need a work or school Microsoft 365 tenant, and permission to register
applications there (or an admin who will register it for you).

1. Open the [Microsoft Entra admin center](https://entra.microsoft.com/) →
   *Identity* → *Applications* → **App registrations** → **New registration**.
   - Name: `Superlocal`
   - **Supported account types:** *Accounts in this organizational directory only
     (single tenant)*.
   - **Redirect URI:** platform **Web**, URI
     `http://localhost:5178/v1/oauth/microsoft/callback`.
     Microsoft accepts plain `http` only for `localhost`. Remote installs need `https`.
2. On the app's **Overview**, copy:
   - **Application (client) ID**
   - **Directory (tenant) ID**
3. **Create a client secret:** *Certificates & secrets* → *Client secrets* →
   **New client secret**. Pick an expiry and record it in your calendar, then copy
   the secret's **Value** immediately. Do not copy the *Secret ID*: Microsoft
   never shows the Value again.
4. **Add API permissions:** *API permissions* → **Add a permission** →
   *Microsoft Graph* → **Delegated permissions**, then add:
   `openid`, `email`, `profile`, `offline_access`, `User.Read`,
   `Mail.ReadWrite`, `Mail.Send`.
5. **Grant consent if required:** many tenants block user consent for third-party
   apps. If yours does, a Global or Privileged Role Administrator must click
   **Grant admin consent for \<tenant\>** on the same page. Otherwise each user
   consents at first sign-in.

Notes:

- Only accounts in **this tenant** can connect. Superlocal pins the tenant's
  token issuer, so personal outlook.com/hotmail accounts and guest tenants are
  rejected. A multi-tenant (`common`/`organizations`) setup is not supported.
- Some tenants require a Conditional Access exception or app assignment
  (*Enterprise applications → Superlocal → Properties → Assignment required*).
  If sign-in fails with an access policy error, ask your admin.

---

## 3. Configure the Superlocal host

Stop Superlocal (Ctrl-C), then edit the generated, git-ignored
`superlocal.local.json` in the repository root. Keep the file `0600`, and never
change its `instanceId`.

```jsonc
{
  "mode": "real",
  "providers": {
    "gmail": {
      "enabled": true,
      "oauth": {
        "clientId": { "env": "SUPERLOCAL_GOOGLE_CLIENT_ID" },
        "clientSecret": { "env": "SUPERLOCAL_GOOGLE_CLIENT_SECRET" },
        "scopes": ["openid", "email",
          "https://www.googleapis.com/auth/gmail.modify",
          "https://www.googleapis.com/auth/gmail.send"]
      }
    },
    "outlook": {
      "enabled": true,
      "oauth": {
        "clientId": { "env": "SUPERLOCAL_MICROSOFT_CLIENT_ID" },
        "clientSecret": { "env": "SUPERLOCAL_MICROSOFT_CLIENT_SECRET" },
        "tenantId": { "env": "SUPERLOCAL_MICROSOFT_TENANT_ID" },
        "scopes": ["openid", "email", "profile", "offline_access",
          "https://graph.microsoft.com/User.Read",
          "https://graph.microsoft.com/Mail.ReadWrite",
          "https://graph.microsoft.com/Mail.Send"]
      }
    }
  }
}
```

(Only the keys shown change; leave the rest of the file as generated.)

Each credential is either an `{ "env": "NAME" }` reference or a literal string
stored in this private file. Choose one:

- **Environment references (the defaults).** Export the variables in the shell that
  starts Superlocal. Bun runs with `--no-env-file`, so `.env` files are **not**
  read.

  ```sh
  export SUPERLOCAL_GOOGLE_CLIENT_ID='…apps.googleusercontent.com'
  export SUPERLOCAL_GOOGLE_CLIENT_SECRET='GOCSPX-…'
  export SUPERLOCAL_MICROSOFT_CLIENT_ID='<application-client-id>'
  export SUPERLOCAL_MICROSOFT_CLIENT_SECRET='<secret-value>'
  export SUPERLOCAL_MICROSOFT_TENANT_ID='<directory-tenant-id>'
  bun --no-env-file run start
  ```

- **Literal values.** Replace each `{ "env": … }` with the string itself, for example
  `"tenantId": "11111111-2222-…"`. Keep the file private and out of backups you
  share.

The tenant ID must be the directory **GUID**, not a domain name such as
`contoso.onmicrosoft.com`.

For Docker, pass the same variables to the container at runtime (not as build
arguments). The config lives at `/persist/superlocal.local.json`.

**Read-only alternative:** set `allowProviderWrites.real` to `false` and narrow the
scopes:

- Gmail: `openid`, `email`, `https://www.googleapis.com/auth/gmail.readonly`.
- Microsoft: `openid`, `email`, `profile`, `offline_access`,
  `https://graph.microsoft.com/User.Read`, `https://graph.microsoft.com/Mail.Read`.

Grant the matching permissions in the Google and Entra registrations. To send
again later, update the scopes and reconnect the mailboxes.

---

## 4. Connect the mailboxes

1. Start Superlocal (`bun --no-env-file run start`) and open
   **http://localhost:5178**.
2. Go to **Settings → Add Accounts**. **Gmail** and **Outlook** should both offer
   their sign-in buttons. If either shows a setup message instead, the host could
   not resolve that provider's credentials (see Troubleshooting).
3. Click **Sign in with Google**, choose the account, and approve access. An
   External app in Testing shows a "Google hasn't verified this app" warning; choose
   *Continue*. You are returned to Superlocal while the mailbox syncs.
4. Click **Sign in with Microsoft**, pick the work account, and accept the
   permissions (or rely on the admin consent granted earlier).
5. Use **Settings → Mailboxes** to choose which mailboxes appear in the unified
   inbox and which get pinned **Ctrl+1–9** shortcuts.

Repeat steps 3–4 for additional accounts. Each account becomes its own connection.

---

## Maintenance

- **Rotating the Microsoft client secret:** create a new secret before the old one
  expires, update `SUPERLOCAL_MICROSOFT_CLIENT_SECRET` (or the literal), and restart.
  Existing connections refresh with the configured secret and need no reconnect.
  The same applies to a rotated Google client secret.
- **Changing the client ID or tenant ID** (a new app registration): existing
  connections are bound to the old registration and stop refreshing. Reconnect
  them from **Settings** after restarting.
- **Revoked access** (password change, admin revocation, Google's 7-day Testing
  expiry): the mailbox shows *Sign in again*. Use it to reauthorize the **same**
  account. A different account must be added as a new connection.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Provider shows a setup message instead of a sign-in button | Credentials did not resolve. Check that the env vars are exported in the shell running `start` (no `.env` loading), that `tenantId` is set for Microsoft, and that the provider is `enabled`. Then restart. |
| "Open the configured web.origin before starting OAuth" | You opened `127.0.0.1` or another origin. Use `http://localhost:5178` (or your `web.origin`). |
| Google `Error 400: redirect_uri_mismatch` | The client's redirect URI differs from `<origin>/v1/oauth/google/callback`. Fix it in the console; changes can take a few minutes. |
| Google `Error 403: access_denied` (app in testing) | The Gmail address isn't a test user. Add it under *Audience → Test users*. |
| Gmail asks to sign in again every week | External app in Testing. Use an Internal app, or accept weekly reconnects. |
| Microsoft `AADSTS50011` | Redirect URI mismatch. Register `<origin>/v1/oauth/microsoft/callback` under the **Web** platform, not SPA or mobile. |
| Microsoft `AADSTS65001` / "Need admin approval" | User consent is blocked. An admin must grant consent on the app's *API permissions* page. |
| Microsoft `AADSTS700016` | Wrong tenant ID, or the app is registered in another tenant. Use the app's *Directory (tenant) ID*. |
| Microsoft `AADSTS7000215` | Invalid client secret: usually the *Secret ID* was copied instead of the *Value*, or the secret expired. |
| Back in Superlocal with "connection failed" and no provider error | The attempt expired (10-minute limit), the browser dropped the attempt cookie, or the account belongs to another tenant. Retry from **Settings** in the same browser at the configured origin. |
| "This account is already connected" | Use the existing mailbox's *Sign in again* option rather than adding it twice. |

Provider credentials are encrypted per connection by the SDK and never returned
to the browser. Never commit `superlocal.local.json`, runtime databases, or client
secrets.
