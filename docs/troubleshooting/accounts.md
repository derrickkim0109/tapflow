---
title: Sign-in & accounts
description: "`tapflow admin init` reporting Already initialized, an invitation or password reset link that has expired or is refused, being signed out after an upgrade, and accounts that differ only in letter case."
---

# Sign-in & accounts

Fixes for creating the admin account, invitation and password reset links, and signing in.

## `tapflow admin init` fails (`Already initialized`)

An admin account already exists on the relay. Sign in and invite teammates from **Settings → Team**.

## Invitation link expired

Invitation links expire after **7 days**. An Admin must create a new invitation from **Settings → Team**. If SMTP is not configured, copy the link shown in the invite dialog and share it manually.

## Password reset link expired

Password reset links expire after **2 hours**. An Admin can make a new link with **Reset pwd** on the member's row in **Settings → Team**. The link appears in a dialog to copy and share, and is also emailed when SMTP is configured. Only the newest link works.

## The invitation says the email is already a member {#invite-already-a-member}

**Already a member. Change their role in the list instead.** appears under the email field, or the invite page says **This email already has an account**. An invitation creates an account and never changes one, so an address that already signs in cannot be invited again, whatever its letter case.

- To give the member another role, change it in the member list in **Settings → Team**.
- If they forgot their password, an Admin presses **Reset pwd** on their row instead.

## Signed out after upgrading {#signed-out-after-upgrading}

After upgrading to v0.26.0, everyone has to sign in once. Sessions are now tied to the password they were signed in with, and sessions from earlier versions carry no such link. The same happens to one user whenever their password is reset or changed: every other browser is signed out. The browser where they changed it in **Settings** stays signed in.

## Tokens stopped working after a password reset {#tokens-revoked-by-reset}

A password reset revokes all of that member's personal access tokens, CI and agent tokens included, and agents connected with them disconnect with `Unauthorized: this token was revoked or has expired, or its owner was removed`. Whoever held a compromised account could otherwise keep the tokens they made. After signing in, issue new tokens in **Settings → Tokens** (a Viewer uses [`POST /api/v1/tokens`](/reference/api#post-api-v1-tokens)), and put them where the old ones were: CI secrets and each remote agent's `--token`. A password change in **Settings** keeps the tokens.

## Two accounts differ only in letter case {#accounts-differ-in-case}

The relay's startup log says **Accounts 2,3 differ only in letter case or spaces**. Email addresses are compared without regard to case now, but two accounts created earlier as, for example, `alice@example.com` and `Alice@example.com` are left as they are. Each still signs in with its exact address. Remove the one nobody uses in **Settings → Team**, and the warning stops.
