---
title: 배포 방식 선택
description: 릴레이를 에이전트와 같은 Mac에서 실행할지, 항상 켜 둔 별도 Mac이나 Docker에 둘지 고르고 같은 네트워크의 팀원이 접속하는 방법을 확인합니다.
---

<a id="릴레이-배포"></a>

# 배포 방식 선택

릴레이는 가벼운 Node.js 서버입니다. WebSocket 트래픽을 중계하고 대시보드를 제공할 뿐이라 CPU와 메모리를 많이 쓰지 않습니다. 시뮬레이터와 에뮬레이터를 조작하는 쪽은 에이전트이고 에이전트는 Mac에서 실행됩니다. 대부분의 팀은 Mac 한 대에서 둘 다 실행하는 것으로 시작합니다.

## 구성 고르기 {#choose-a-setup}

<a id="배포-시나리오"></a>

| 구성 | 이럴 때 | 시작 명령 |
|---|---|---|
| [Mac 한 대](#local-single-mac) | Mac 한 대가 시뮬레이터를 돌리고 팀원이 같은 네트워크에 있을 때 | `tapflow start` |
| [릴레이 분리](#team-separate-relay-server) | 여러 Mac이 시뮬레이터를 돌리고 항상 켜 둔 Mac 한 대가 대시보드를 제공할 때 | `tapflow relay start`, 각 Mac에서 `tapflow agent start` |
| [Docker 릴레이](#relay-in-docker) | 릴레이는 Linux 서버나 NAS에 두고 에이전트는 Mac에 둘 때 | `docker compose up -d` |

어느 구성이든 두 가지를 더할 수 있습니다. 사무실 네트워크 밖의 팀원을 위한 [외부 접속](/ko/operate/external-access)과 더 부드러운 스트림을 위한 [HTTPS](/ko/operate/https)입니다.

::: tip 에이전트와 릴레이는 같은 유선 LAN에 두세요
에이전트는 릴레이로 영상 프레임을 지속적으로 전송하므로 둘은 같은 LAN에 있어야 합니다. 같은 사무실 건물이라면 층이 다르거나 VLAN이 분리돼 있어도 내부 라우팅으로 지연이 충분히 낮습니다. 다만 에이전트를 인터넷 너머 다른 네트워크에 두면 RTT가 높아져 프레임이 드롭됩니다. **유선 이더넷을 권장합니다.** Wi-Fi도 동작하지만 Mac에서는 AWDL 때문에 끊길 수 있습니다. 끊김이 보이면 [스트림 지연·끊김](/ko/troubleshooting/streaming#stream-lag)을 참고하세요.
:::

## Mac 한 대 {#local-single-mac}

<a id="로컬-운영-mac-한-대"></a>

릴레이와 에이전트를 같은 Mac에서 명령 하나로 실행합니다.

```sh
tapflow start
```

배너에 팀원이 열 주소 `http://<이 Mac의 LAN IP>:4000`이 나옵니다. 릴레이가 `JWT_SECRET`을 직접 만들므로 따로 설정할 것이 없습니다. 설치부터 첫 조작까지는 [빠른 시작](/ko/get-started/quick-start)에서 이 구성으로 안내합니다.

## 릴레이 분리 {#team-separate-relay-server}

<a id="팀-운영-릴레이-서버-분리"></a>

릴레이는 항상 켜 둔 Mac 한 대에서, 에이전트는 시뮬레이터나 에뮬레이터가 있는 각 Mac에서 실행합니다.

**릴레이 Mac에서:**

```sh
tapflow relay start
```

**각 에이전트 Mac에서:**

```sh
tapflow agent start --relay ws://192.168.x.x:4000 --token tflw_pat_xxxxxxxx
```

릴레이와 다른 머신의 에이전트는 `agent` 스코프 토큰이 필요합니다. 발급 방법은 [원격 릴레이 인증](/ko/operate/agents#원격-릴레이-인증)에 있습니다. 스킴은 `ws://`이고 릴레이가 [HTTPS](/ko/operate/https)로 동작하면 `wss://`입니다. 릴레이가 시작할 때 정확한 명령을 출력합니다.

## Docker 릴레이 {#relay-in-docker}

공식 이미지는 릴레이만 실행합니다. 에이전트는 여전히 LAN의 Mac에서 실행되며 릴레이 분리 구성과 똑같이 `agent` 스코프 토큰으로 Docker 호스트에 연결합니다. Compose 파일, 필수 데이터 볼륨, 첫 계정 만들기는 [Docker로 배포](/ko/operate/docker)에 있습니다.

## 같은 네트워크의 팀원 {#internal-access-same-network}

<a id="내부-접속-같은-네트워크"></a>

팀원은 브라우저에서 `http://<릴레이 LAN IP>:4000`을 엽니다. 포트는 `tapflow.config.json`의 `local.port`이고 기본값은 `4000`입니다. 팀원 쪽에는 설치할 것이 없습니다. 자동 생성 대신 고정 서명 키를 쓰려면 [JWT_SECRET](/ko/operate/configure#jwt-secret)을 참고하세요.

## 옮겨진 섹션 {#moved-sections}

이 페이지에 있던 섹션은 아래 페이지로 옮겨졌습니다.

- [Docker로 배포](/ko/operate/docker)
  - <a id="docker-compose-lan-서버" data-moved-to="/ko/operate/docker#docker-compose-lan-서버"></a>[Docker로 배포](/ko/operate/docker#docker-compose-lan-서버)
- [tapflow 설정](/ko/operate/configure)
  - <a id="배포-설정" data-moved-to="/ko/operate/configure#배포-설정"></a>[배포 설정](/ko/operate/configure#배포-설정)
  - <a id="jwt-secret" data-moved-to="/ko/operate/configure#jwt-secret"></a>[JWT_SECRET](/ko/operate/configure#jwt-secret)
  - <a id="tapflow-config-json" data-moved-to="/ko/operate/configure#tapflow-config-json"></a>[tapflow.config.json](/ko/operate/configure#tapflow-config-json)
- [외부 접속](/ko/operate/external-access)
  - <a id="외부-접속" data-moved-to="/ko/operate/external-access#외부-접속"></a>[외부 접속](/ko/operate/external-access#외부-접속)
  - <a id="tailscale-권장" data-moved-to="/ko/operate/external-access#tailscale-권장"></a>[Tailscale (권장)](/ko/operate/external-access#tailscale-권장)
  - <a id="vps-rathole" data-moved-to="/ko/operate/external-access#vps-rathole"></a>[VPS + rathole](/ko/operate/external-access#vps-rathole)
  - <a id="_1-vps에-caddy-설치" data-moved-to="/ko/operate/external-access#_1-vps에-caddy-설치"></a>[1. VPS에 Caddy 설치](/ko/operate/external-access#_1-vps에-caddy-설치)
  - <a id="_2-릴레이-mac에서-tapflow-설정" data-moved-to="/ko/operate/external-access#_2-릴레이-mac에서-tapflow-설정"></a>[2. 릴레이 Mac에서 tapflow 설정](/ko/operate/external-access#_2-릴레이-mac에서-tapflow-설정)
- [HTTPS](/ko/operate/https)
  - <a id="https로-더-부드러운-스트림-켜기-선택" data-moved-to="/ko/operate/https#https로-더-부드러운-스트림-켜기-선택"></a>[HTTPS로 더 부드러운 스트림 켜기 (선택)](/ko/operate/https#https로-더-부드러운-스트림-켜기-선택)
- [백업과 상시 운영](/ko/operate/relay-operations)
  - <a id="백업" data-moved-to="/ko/operate/relay-operations#백업"></a>[백업](/ko/operate/relay-operations#백업)
  - <a id="권장-sqlite에는-litestream-사용" data-moved-to="/ko/operate/relay-operations#권장-sqlite에는-litestream-사용"></a>[권장: SQLite에는 Litestream 사용](/ko/operate/relay-operations#권장-sqlite에는-litestream-사용)
  - <a id="pm2-릴레이-mac-상시-운영" data-moved-to="/ko/operate/relay-operations#pm2-릴레이-mac-상시-운영"></a>[PM2 (릴레이 Mac 상시 운영)](/ko/operate/relay-operations#pm2-릴레이-mac-상시-운영)
  - <a id="systemd-linux-릴레이-서버" data-moved-to="/ko/operate/relay-operations#systemd-linux-릴레이-서버"></a>[systemd (Linux 릴레이 서버)](/ko/operate/relay-operations#systemd-linux-릴레이-서버)
