---
title: Deployment options
description: "Choose where the relay runs: on the same Mac as the agent, on a separate always-on Mac, or in Docker, and how teammates on the same network reach it."
---

<a id="self-hosting-the-relay"></a>

# Deployment options

The relay is a lightweight Node.js server. It routes WebSocket traffic and serves the dashboard, so it needs little CPU or memory. The agent is what drives simulators and emulators, and it runs on a Mac. Most teams start with one Mac running both.

## Choose a setup {#choose-a-setup}

<a id="deployment-scenarios"></a>

| Setup | Fits when | Start with |
|---|---|---|
| [Single Mac](#local-single-mac) | One Mac runs the simulators, and teammates are on the same network | `tapflow start` |
| [Separate relay](#team-separate-relay-server) | Several Macs run simulators, and one always-on Mac serves the dashboard | `tapflow relay start`, then `tapflow agent start` on each Mac |
| [Relay in Docker](#relay-in-docker) | The relay lives on a Linux server or NAS, and agents stay on Macs | `docker compose up -d` |

Two things are added on top of any of them: [External access](/operate/external-access) for teammates outside the office network, and [HTTPS](/operate/https) for a smoother stream.

::: tip Keep agents and the relay on the same wired LAN
The agent streams video frames to the relay continuously, so the two must share a LAN. Different floors or VLANs in one building are fine, because internal routing keeps latency low. Placing an agent across the internet raises RTT and drops frames. **Wired Ethernet is recommended**; Wi-Fi works but can stutter on a Mac (AWDL), so see [Stream lag or stuttering](/troubleshooting/streaming#stream-lag) if playback hitches.
:::

## Single Mac {#local-single-mac}

The relay and the agent run on the same Mac, started by one command:

```sh
tapflow start
```

The banner prints the address teammates open, `http://<this Mac's LAN IP>:4000`. The relay generates its own `JWT_SECRET`, so there is nothing else to set. [Quick Start](/get-started/quick-start) walks through this setup from install to the first tap.

## Separate relay {#team-separate-relay-server}

The relay runs on one always-on Mac, and an agent runs on each Mac with simulators or emulators.

**On the relay Mac:**

```sh
tapflow relay start
```

**On each agent Mac:**

```sh
tapflow agent start --relay ws://192.168.x.x:4000 --token tflw_pat_xxxxxxxx
```

An agent on a different machine than the relay needs an `agent`-scope token. [Remote relay authentication](/operate/agents#remote-relay-authentication) shows how to create one. The scheme is `ws://`, or `wss://` when the relay serves [HTTPS](/operate/https); the relay prints the exact command when it starts.

## Relay in Docker {#relay-in-docker}

The official image runs the relay only. Agents still run on Macs on your LAN and connect to the Docker host with an `agent`-scope token, the same way as with a separate relay. The Compose file, the required data volume and the first account are in [Deploy with Docker](/operate/docker).

## Teammates on the same network {#internal-access-same-network}

Teammates open `http://<relay LAN IP>:4000` in a browser. The port is `local.port` in `tapflow.config.json` (default `4000`). Nothing needs to be installed on their side. To pin a fixed signing key instead of the generated one, see [JWT_SECRET](/operate/configure#jwt-secret).

## Moved sections {#moved-sections}

Sections that used to be on this page now live on these pages.

- [Deploy with Docker](/operate/docker)
  - <a id="docker-compose-lan-server" data-moved-to="/operate/docker#docker-compose-lan-server"></a>[Deploy with Docker](/operate/docker#docker-compose-lan-server)
- [Configuring tapflow](/operate/configure)
  - <a id="deployment-configuration" data-moved-to="/operate/configure#deployment-configuration"></a>[Deployment configuration](/operate/configure#deployment-configuration)
  - <a id="jwt-secret" data-moved-to="/operate/configure#jwt-secret"></a>[JWT_SECRET](/operate/configure#jwt-secret)
  - <a id="tapflow-config-json" data-moved-to="/operate/configure#tapflow-config-json"></a>[tapflow.config.json](/operate/configure#tapflow-config-json)
- [External access](/operate/external-access)
  - <a id="external-access" data-moved-to="/operate/external-access#external-access"></a>[External access](/operate/external-access#external-access)
  - <a id="tailscale-recommended" data-moved-to="/operate/external-access#tailscale-recommended"></a>[Tailscale (recommended)](/operate/external-access#tailscale-recommended)
  - <a id="vps-rathole" data-moved-to="/operate/external-access#vps-rathole"></a>[VPS + rathole](/operate/external-access#vps-rathole)
  - <a id="_1-set-up-caddy-for-https-on-the-vps" data-moved-to="/operate/external-access#_1-set-up-caddy-for-https-on-the-vps"></a>[1. Set up Caddy for HTTPS on the VPS](/operate/external-access#_1-set-up-caddy-for-https-on-the-vps)
  - <a id="_2-configure-tapflow-on-the-relay-mac" data-moved-to="/operate/external-access#_2-configure-tapflow-on-the-relay-mac"></a>[2. Configure tapflow on the relay Mac](/operate/external-access#_2-configure-tapflow-on-the-relay-mac)
- [HTTPS](/operate/https)
  - <a id="enable-https-for-the-smoother-stream-optional" data-moved-to="/operate/https#enable-https-for-the-smoother-stream-optional"></a>[Enable HTTPS for the smoother stream (optional)](/operate/https#enable-https-for-the-smoother-stream-optional)
- [Backups & uptime](/operate/relay-operations)
  - <a id="backup" data-moved-to="/operate/relay-operations#backup"></a>[Backup](/operate/relay-operations#backup)
  - <a id="recommended-litestream-for-sqlite" data-moved-to="/operate/relay-operations#recommended-litestream-for-sqlite"></a>[Recommended: Litestream for SQLite](/operate/relay-operations#recommended-litestream-for-sqlite)
  - <a id="pm2-keeping-the-relay-mac-always-on" data-moved-to="/operate/relay-operations#pm2-keeping-the-relay-mac-always-on"></a>[PM2 (keeping the relay Mac always on)](/operate/relay-operations#pm2-keeping-the-relay-mac-always-on)
  - <a id="systemd-linux-relay-server" data-moved-to="/operate/relay-operations#systemd-linux-relay-server"></a>[systemd (Linux relay server)](/operate/relay-operations#systemd-linux-relay-server)
