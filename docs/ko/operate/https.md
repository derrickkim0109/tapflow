---
title: HTTPS
description: "팀원이 원본 해상도와 하드웨어 디코딩의 Smooth 스트림을 받도록 릴레이를 HTTPS로 제공합니다. DNS 계정으로 인증서를 발급하거나 가진 인증서를 쓰거나 Tailscale이나 VPS를 거쳐 HTTPS를 붙입니다."
---

# HTTPS

브라우저는 HTTPS 페이지에서만 영상을 하드웨어로 디코딩합니다. 평문 HTTP로 접속한 LAN 팀원은 1280px를 소프트웨어로 디코딩하는 **Standard** 스트림을 받습니다. 릴레이를 HTTPS로 제공하면 원본 해상도를 하드웨어로 디코딩하는 **Smooth**로 바뀝니다. 접속 방식별로 어떤 프로파일이 되는지는 [스트림 품질](/ko/operate/streaming-quality)에 있습니다.

HTTPS는 선택입니다. Standard는 설정 없이 동작하고 HTTPS는 나중에 다른 설정을 건드리지 않고 추가할 수 있습니다.

## 방법 고르기 {#pick-a-method}

| 팀원이 릴레이에 접속하는 방식 | 방법 | 필요한 것 |
|---|---|---|
| 같은 LAN에서 직접 | [DNS 계정으로 인증서 발급](#dns-auto-issue) | Cloudflare나 Vercel에 있는 도메인과 그 API 토큰 |
| 같은 LAN에서 직접 | [가진 인증서 사용](#import-cert) | 사내 PKI나 와일드카드 인증서 같은 인증서·키 파일 |
| Tailscale 경유 | [`tailscale serve`](#tailscale) | Tailscale의 무료 HTTPS 인증서 |
| rathole로 VPS 경유 | VPS의 Caddy | [외부 접속](/ko/operate/external-access#_1-vps에-caddy-설치)의 절차 |

터널을 쓰면 TLS가 릴레이 앞에서 끝나므로 릴레이는 HTTP 그대로 두고 `tls` 설정도 필요 없습니다.

## DNS 계정으로 인증서 발급 {#dns-auto-issue}

릴레이가 DNS-01로 Let's Encrypt 인증서를 받고 스스로 갱신합니다. 도메인의 A 레코드도 이 Mac의 LAN 주소로 맞춰 두므로 팀원은 도메인만 열면 됩니다.

1. 릴레이 Mac에서 `tapflow init`을 실행하고 다음을 고릅니다.
   - **Tunnel provider**: None
   - **Streaming performance**: Smooth
   - **Certificate method**: Cloudflare DNS 또는 Vercel DNS
   - **Domain for tapflow**: 예를 들어 `tap.yourcompany.com`
2. `init`이 데이터 디렉터리에 토큰용 줄이 든 `.env`를 만듭니다(기본 설치에서는 `~/.tapflow/data/.env`). `TAPFLOW_CLOUDFLARE_TOKEN=`이나 `TAPFLOW_VERCEL_TOKEN=` 뒤에 API 토큰을 붙여 넣으세요. Vercel 팀 도메인이면 `TAPFLOW_VERCEL_TEAM_ID`도 추가합니다.
3. `tapflow start`로 릴레이를 시작합니다. 릴레이만 두는 Mac이면 `tapflow relay start`를 씁니다. 배너에 `Relay started on https://<domain>:4000`이 나옵니다.
4. 그 주소를 팀원에게 공유합니다. 인증서가 도메인에 발급되므로 IP 주소나 `localhost`로 열면 인증서 이름 경고가 뜹니다.

이제 원격 에이전트는 `ws://` 대신 `wss://`로 연결합니다. 릴레이가 출력하는 에이전트 연결 명령에는 이미 반영되어 있습니다.

## 가진 인증서 사용 {#import-cert}

사내 PKI나 이미 가진 와일드카드 인증서를 쓸 때 고릅니다. 갱신은 직접 해야 합니다.

1. `tapflow init`에서 **None**, **Smooth**, **Existing certificate**를 고르고 fullchain 인증서와 개인 키 경로를 입력합니다. `tapflow.config.json`에 `tls` 블록을 직접 넣어도 됩니다.

   ```json
   {
     "tls": {
       "mode": "import-cert",
       "certPath": "/path/to/fullchain.pem",
       "keyPath": "/path/to/privkey.pem"
     }
   }
   ```

2. 인증서의 이름이 릴레이의 LAN 주소로 해석되게 DNS나 팀원 각자의 머신에 등록합니다.
3. 릴레이를 시작합니다. 배너에 tapflow가 인증서에서 읽은 이름이 나옵니다. 경고와 함께 `localhost`가 나오면 인증서에 tapflow가 쓸 수 있는 이름이 없는 것입니다. 쓸 수 있는 이름의 조건은 [설정 파일](/ko/reference/configuration#https-secure-context)에 있습니다.

## Tailscale 경유 {#tailscale}

<a id="https로-더-부드러운-스트림-켜기-선택"></a>

기본 Tailscale 주소는 평문 HTTP이고 tailnet 주소는 외부 주소로 분류되므로 팀원은 1000px로 줄인 스트림을 소프트웨어로 디코딩해 받습니다. Tailscale의 무료 HTTPS로 종단하면 터널 포트를 거쳐 들어오므로 Smooth 프로파일로 바뀝니다. Tailscale이 `*.ts.net` 인증서를 자동 발급·갱신하므로 도메인이나 DNS 토큰이 필요 없습니다.

1. Tailscale admin 콘솔의 **DNS** 설정에서 **MagicDNS**와 **HTTPS Certificates**를 켭니다. 머신 이름이 공개 Certificate Transparency 기록에 남는다는 점에 동의해야 합니다.
2. 릴레이 Mac에서 릴레이의 **터널 포트** 앞에 HTTPS를 둡니다. `TAPFLOW_TUNNEL_PORT`를 정했으면 그 포트이고 아니면 `4001`입니다. 릴레이 자신이 4001을 쓸 때만 기본값이 4002로 비켜섭니다. 아래 명령은 기본값을 쓰므로 시작 배너에 나온 포트가 다르면 `4001`을 그 번호로 바꾸세요.

   ```sh
   tailscale serve --bg 4001
   ```

   ::: warning tailscale serve는 4000이 아니라 터널 포트로
   `tailscale serve`는 릴레이 Mac 안에서 릴레이로 연결합니다. `4000` 포트에서는 릴레이가 이 연결을 로컬로 보고 로그인을 요구하지 않습니다. 터널 포트에서는 모든 연결을 원격으로 봅니다. 예전 설정이 `4000`을 serve하고 있다면 `tailscale serve reset`을 실행한 뒤 위 명령을 다시 실행하세요. 예전 설정이 남아 있는 동안 `tapflow start`가 경고합니다.
   :::

3. `tapflow.config.json`의 `publicUrl`을 HTTPS 주소로 바꿔 배너와 tapflow가 공유하는 링크를 맞춥니다.

   ```json
   {
     "tunnel": {
       "provider": "tailscale",
       "publicUrl": "https://your-hostname.tailnet.ts.net"
     }
   }
   ```

Tailscale 자체를 설정하는 방법은 [외부 접속](/ko/operate/external-access#tailscale-권장)에 있습니다.

## 적용 확인 {#check}

HTTPS 주소로 대시보드를 열고 QA Session을 시작합니다. 기기 아래 프레임 속도 옆 표시가 **Smooth**면 적용된 것입니다. **Standard**면 아직 HTTP로 열려 있습니다.

## 팀원이 접속하지 못할 때 {#troubleshooting}

- **인증서 이름 경고**: IP 주소나 `localhost` 말고 도메인으로 여세요.
- **LAN에서 도메인이 열리지 않음**: 일부 공유기는 공개 도메인이 사설 주소를 가리키는 응답을 막습니다(DNS 리바인딩 차단). 공유기에 예외를 추가하거나 로컬 DNS에서 도메인을 LAN 주소로 연결하세요.
- **LAN에서 아무것도 열리지 않음**: Wi-Fi 클라이언트 격리가 켜진 네트워크는 기기 간 통신을 막습니다. 일반 가정이나 사무실 네트워크를 쓰세요.
- **테스트 뒤 인증서 경고가 남음**: 스테이징 인증서(`TAPFLOW_ACME_STAGING=1`)는 신뢰되지 않습니다. 프로덕션으로 바꾼 뒤에도 브라우저가 이전 오류를 보여 줄 수 있으니 시크릿 창에서 확인하세요.

모든 `tls` 키는 [설정 파일](/ko/reference/configuration#https-secure-context)에 있습니다.
