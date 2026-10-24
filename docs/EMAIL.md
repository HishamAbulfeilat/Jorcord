# Email (SMTP) setup

Jorcord sends account email (verify address, password reset, "your password was changed") through any SMTP server.
Every message is multipart: HTML plus a plain-text alternative. Links are built from `PUBLIC_URL`, so set it to the
address users actually open (for example `https://chat.example.com`). Links open the web app in the browser, which also
works for the native apps (the user signs in afterwards).

| Variable | Meaning |
| --- | --- |
| `SMTP_URL` | `smtp://user:pass@host:587` (STARTTLS) or `smtps://user:pass@host:465` (implicit TLS). Unset = nothing is sent. |
| `MAIL_FROM` | Sender, e.g. `Jorcord <no-reply@example.com>`. Most providers only accept a sender or domain you verified. |
| `PUBLIC_URL` | Base of every emailed link. |
| `REQUIRE_EMAIL_VERIFICATION` | `true` = sign-up sends a verification mail and sign-in returns `403 EMAIL_NOT_VERIFIED` until the link is used. Default `false`. Already-verified accounts, bots and accounts without an email are unaffected. Needs working SMTP, otherwise nobody can sign in. |

At startup the server logs one line saying whether SMTP is configured (host and port only, never credentials). Without
`SMTP_URL`, mail is printed to the log in development and dropped (with a warning) in production.

## Test it

```sh
SMTP_URL='smtp://...' MAIL_FROM='Jorcord <you@example.com>' \
  pnpm --filter @jorcord/server exec tsx scripts/send-test-mail.ts you@example.com
```

It verifies the connection, sends one message and prints the provider's real error on failure.

## Free options

**Brevo** (300 mails/day free). Create an account, verify a single sender address (Senders & IP), then SMTP & API ->
SMTP keys.

```
SMTP_URL=smtp://YOUR_LOGIN:YOUR_SMTP_KEY@smtp-relay.brevo.com:587
MAIL_FROM=Jorcord <the-verified-sender@example.com>
```

**Gmail** (about 500/day). Turn on 2-step verification, create an app password at myaccount.google.com/apppasswords.

```
SMTP_URL=smtp://you%40gmail.com:YOUR_16_CHAR_APP_PASSWORD@smtp.gmail.com:587
MAIL_FROM=Jorcord <you@gmail.com>
```

**Resend** (free tier; needs a verified domain). Add the DNS records Resend shows you, create an API key.

```
SMTP_URL=smtps://resend:re_YOUR_API_KEY@smtp.resend.com:465
MAIL_FROM=Jorcord <no-reply@your-verified-domain.com>
```

## Gotchas

- **URL-encode the username and password** inside `SMTP_URL`: `@` is `%40`, `:` is `%3A`, `/` is `%2F`, `#` is `%23`,
  `%` is `%25`, space is `%20`. An unencoded `@` in a Gmail address is the most common cause of "Invalid login".
- **Oracle Cloud (and many other clouds) block outbound port 25**, so running your own mail server (MTA) on a free VM
  will not deliver. Use a relay on 587/465 as above. Even where port 25 is open, mail from a fresh VPS IP without SPF,
  DKIM and reverse DNS usually lands in spam.
- Use a `MAIL_FROM` the provider has verified, otherwise it rejects or rewrites the sender.
- For your own domain add the provider's SPF/DKIM DNS records; this is the biggest deliverability factor.
- Reset and verification are rate-limited per address and IP; "resend" never reveals whether an address has an account.

## Password reset and two-factor

If the account has two-factor authentication enabled, the reset link alone is not enough: the reset page asks for the
current authenticator code. A wrong code does not use up the link, but five wrong codes invalidate it. (There are no
recovery codes; an admin can disable 2FA for a user who lost their authenticator.)
