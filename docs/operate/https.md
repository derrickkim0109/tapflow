---
title: HTTPS
description: "Serve the relay over HTTPS so teammates get the Smooth stream with native resolution and hardware decoding: a certificate from your DNS account, a certificate you already have, or HTTPS through Tailscale or a VPS."
---

# HTTPS

Browsers decode video in hardware only on HTTPS pages. Over plain HTTP, teammates on the LAN get the **Standard** stream: 1280 px, decoded in software. Serving the relay over HTTPS moves them to **Smooth**, at native resolution and decoded in hardware. [Streaming Quality](/operate/streaming-quality) shows how each kind of connection maps to a profile.

HTTPS is optional. Standard needs no setup, and you can add HTTPS later without changing anything else.

## Pick a method {#pick-a-method}

| How teammates reach the relay | Method | What you need |
|---|---|---|
| Directly, on the same LAN | [Certificate from your DNS account](#dns-auto-issue) | A domain on Cloudflare or Vercel and an API token for it |
| Directly, on the same LAN | [A certificate you already have](#import-cert) | Certificate and key files, such as an internal PKI or wildcard certificate |
| Through Tailscale | [`tailscale serve`](#tailscale) | Tailscale's free HTTPS certificates |
| Through a VPS with rathole | Caddy on the VPS | The steps in [External access](/operate/external-access#_1-set-up-caddy-for-https-on-the-vps) |

With a tunnel, TLS ends in front of the relay, so the relay itself stays on HTTP and needs no `tls` settings.

## Certificate from your DNS account {#dns-auto-issue}

The relay gets a Let's Encrypt certificate over DNS-01 and renews it on its own. It also points the domain's A record at this Mac's LAN address, so teammates only need the domain.

1. Run `tapflow init` on the relay Mac and choose:
   - **Tunnel provider**: None
   - **Streaming performance**: Smooth
   - **Certificate method**: Cloudflare DNS or Vercel DNS
   - **Domain for tapflow**: for example `tap.yourcompany.com`
2. `init` creates `.env` in the data directory (`~/.tapflow/data/.env` on a default install) with a line for the token. Paste the API token after `TAPFLOW_CLOUDFLARE_TOKEN=` or `TAPFLOW_VERCEL_TOKEN=`. For a Vercel team domain, also add `TAPFLOW_VERCEL_TEAM_ID`.
3. Start the relay with `tapflow start`, or `tapflow relay start` on a relay-only Mac. The banner shows `Relay started on https://<domain>:4000`.
4. Share that address with teammates. Opening the relay by IP address or `localhost` shows a certificate name warning, because the certificate is for the domain.

Remote agents now connect with `wss://` instead of `ws://`. The agent connection command the relay prints already uses it.

## A certificate you already have {#import-cert}

Use this for an internal PKI or a wildcard certificate you already hold. You renew it yourself.

1. Run `tapflow init`, choose **None**, **Smooth** and **Existing certificate**, and enter the paths to the fullchain certificate and the private key. Or add the `tls` block to `tapflow.config.json` yourself:

   ```json
   {
     "tls": {
       "mode": "import-cert",
       "certPath": "/path/to/fullchain.pem",
       "keyPath": "/path/to/privkey.pem"
     }
   }
   ```

2. Make sure the name on the certificate resolves to the relay's LAN address, in your DNS or on each teammate's machine.
3. Start the relay. The banner shows the name tapflow read from the certificate. If it shows `localhost` with a warning, the certificate has no name tapflow can use; [Configuration](/reference/configuration#https-secure-context) lists which names it accepts.

## Through Tailscale {#tailscale}

<a id="enable-https-for-the-smoother-stream-optional"></a>

The default Tailscale URL is plain HTTP, and tailnet addresses count as external, so teammates get a stream trimmed to 1000 px and decoded in software. Terminating over Tailscale's free HTTPS brings them in through the tunnel port, which moves them to the Smooth profile. Tailscale issues and renews the `*.ts.net` certificate automatically, so no domain or DNS token is needed.

1. In the Tailscale admin console under **DNS**, enable **MagicDNS** and **HTTPS Certificates**. You'll acknowledge that machine names appear in the public Certificate Transparency log.
2. On the relay Mac, terminate HTTPS in front of the relay's **tunnel port**. It is `TAPFLOW_TUNNEL_PORT` when you set it, and `4001` otherwise; only when the relay itself runs on 4001 does the default step aside to 4002. The command below uses the default, so replace `4001` with the port the start banner prints if yours differs:

   ```sh
   tailscale serve --bg 4001
   ```

   ::: warning Serve the tunnel port, not 4000
   `tailscale serve` connects to the relay from the relay Mac itself. On port `4000` the relay treats those connections as local and does not ask them to sign in. On the tunnel port every connection counts as remote. If an earlier setup serves `4000`, run `tailscale serve reset` and then the command above. `tapflow start` warns while the old setting is in place.
   :::

3. Point `publicUrl` at the HTTPS address in `tapflow.config.json` so the banner and the links tapflow shares match:

   ```json
   {
     "tunnel": {
       "provider": "tailscale",
       "publicUrl": "https://your-hostname.tailnet.ts.net"
     }
   }
   ```

Setting up Tailscale itself is in [External access](/operate/external-access#tailscale-recommended).

## Check that it worked {#check}

Open the dashboard at the HTTPS address and start a QA Session. The label beside the frame rate under the device reads **Smooth**. When it reads **Standard**, the page is still on HTTP.

## When teammates cannot connect {#troubleshooting}

- **Certificate name warning**: open the domain, not an IP address or `localhost`.
- **The domain does not load on the LAN**: some routers block a public domain that points to a private address (DNS rebinding protection). Add an exception on the router, or map the domain to the LAN address in local DNS.
- **Nothing on the LAN loads**: networks with Wi-Fi client isolation block traffic between devices. Use a normal home or office network.
- **Browser warns about the certificate after testing**: a staging certificate (`TAPFLOW_ACME_STAGING=1`) is not trusted. After switching to production, the browser may keep showing the old error; check in a private window.

Every `tls` key is in [Configuration](/reference/configuration#https-secure-context).
