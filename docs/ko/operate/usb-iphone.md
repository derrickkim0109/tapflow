---
title: USB로 연결한 iPhone
description: 에이전트 맥에 USB로 연결한 iPhone을 시뮬레이터처럼 대시보드에서 열 수 있게 준비합니다. 개발자 모드, 서명 팀, 카메라 권한, 자동 잠금 설정과 iPhone에서 할 수 없는 것을 정리합니다.
---

# USB로 연결한 iPhone

에이전트 맥에 USB로 연결한 iPhone은 시뮬레이터 옆에 **USB** 배지를 달고 표시됩니다. 대시보드에서 열면 화면이 브라우저로 미러링되고, 탭·드래그·길게 누르기·타이핑을 iPhone으로 보낼 수 있습니다. 아직 실험 기능입니다. 실제 iPhone에서 확인한 것은 미러링과 탭이고, 드래그·타이핑·설치·실행은 하드웨어에서 확인하지 않았습니다. iPad도 목록에 나오지만 시도해 본 적은 없습니다.

## iPhone 준비

1. USB 케이블로 에이전트 맥에 연결하고, iPhone에 뜨는 **이 컴퓨터를 신뢰하겠습니까?**에서 **신뢰**를 누릅니다.
2. **설정 › 개인정보 보호 및 보안 › 개발자 모드**를 켭니다. 켜면 iPhone이 재시동합니다. 이 항목이 보이지 않으면 맥의 Xcode에서 iPhone을 한 번 열면 나타납니다.
3. **설정 › 디스플레이 및 밝기 › 자동 잠금**을 **안 함**으로 두고 충전기를 연결해 둡니다. 잠긴 iPhone은 화면 캡처가 멈추고, tapflow는 잠금을 풀 수 없습니다.
4. iPhone을 두 대 이상 연결한다면 **설정 › 일반 › 정보 › 이름**에서 서로 다른 이름을 붙입니다. 맥의 화면 캡처는 iPhone을 이름으로만 구분하므로, 같은 이름의 iPhone이 둘이면 tapflow는 어느 쪽인지 고르지 않고 캡처를 거절합니다.

USB로 연결돼 있고, 신뢰했고, 개발자 모드가 켜진 iPhone만 목록에 나옵니다. Wi-Fi로만 페어링된 iPhone은 화면을 캡처할 수 없어 나오지 않습니다.

**에이전트가 실행 중일 때 iPhone을 꽂거나 빼도 됩니다. 다시 시작할 필요가 없습니다.** 에이전트는 30초마다 기기 목록을 다시 읽으므로, 꽂은 iPhone은 30초 안팎에 기기 목록에 나타납니다. 뺀 iPhone은 아무도 열어 두지 않았다면 1분쯤 뒤 목록에서 빠지고, 화면 캡처와 러너도 함께 멈춥니다. 다시 꽂으면 새 세션으로 열립니다.

## 서명 팀 지정

iPhone의 입력은 tapflow가 iPhone에 설치하는 XCUITest 러너를 거칩니다. iPhone에 설치하려면 러너를 Apple 개발자 팀으로 서명해야 하므로, 에이전트를 실행하는 환경에 팀 ID를 지정합니다.

```sh
export TAPFLOW_IOS_TEAM_ID=ABCDE12345
tapflow agent start
```

| 변수 | 설명 |
|---|---|
| `TAPFLOW_IOS_TEAM_ID` | 러너를 서명할 Apple 개발자 팀 ID(10자). 없으면 화면은 미러링되지만 입력이 거절되고, 대시보드는 이 변수를 지정하라고 알려 줍니다. developer.apple.com/account의 **Membership details**에서 확인하거나, 서명 인증서의 `OU=` 값을 읽습니다: `security find-certificate -c "Apple Development" -p \| openssl x509 -noout -subject`. `security find-identity`가 Apple Development 인증서 뒤 괄호 안에 보여 주는 값은 팀 ID가 아닙니다. |
| `TAPFLOW_IOS_BUNDLE_PREFIX` | 러너의 번들 ID 접두사. 기본값 `dev.tapflow`. App ID는 모든 Apple 팀을 통틀어 하나뿐이라, 다른 팀이 이미 `dev.tapflow.treerunner.*`를 등록했다면 `com.example.tapflow`처럼 자기 팀이 쓰는 접두사를 지정합니다. |

맥의 Xcode에 그 팀의 계정으로 로그인돼 있어야 합니다(**Xcode › Settings › Accounts**).

**첫 빌드는 팀의 Apple 개발자 계정을 바꿉니다.** 러너는 `-allowProvisioningUpdates`로 빌드되므로 iPhone을 팀의 기기로 등록하고, App ID `<접두사>.treerunner.host`와 `<접두사>.treerunner.uitests`, 그리고 둘을 위한 개발용 프로비저닝 프로파일을 만듭니다. 처음 보는 iPhone을 열면 그 iPhone을 등록하려고 러너를 다시 빌드합니다.

## 카메라 권한 허용

macOS는 USB로 연결한 iPhone의 화면을 카메라 장치로 다룹니다. 그래서 tapflow는 iPhone을 처음 열 때 에이전트 맥에서 `device-capture-helper`를 만들고(`~/Library/Caches/tapflow`, Xcode의 Swift 컴파일러가 필요합니다), macOS는 이 앱의 카메라 접근을 허용할지 묻습니다.

**이 질문은 에이전트 맥의 화면에 뜨므로, 맥 앞에 있는 사람이 허용을 눌러야 합니다.** 원격으로 테스트하는 팀이라면 운영자가 iPhone을 한 번 열어 미리 허용해 두세요. 거절했다면 **시스템 설정 › 개인정보 보호 및 보안 › 카메라**에서 `device-capture-helper`를 켭니다. 거절된 동안 대시보드는 `Screen capture: camera access denied`로 시작하는 오류를 보여 줍니다.

캡처가 실패하면 그 이유가 대시보드의 기기 상태에 표시됩니다. iPhone이 잠겨 있거나 케이블이 빠졌다면 잠금을 풀거나 다시 연결하세요. tapflow가 캡처를 다시 시도합니다.

## 빌드 설치

iPhone에는 기기용 빌드만 설치할 수 있습니다. Firebase App Distribution에 올리는 `.ipa`나 ad-hoc·개발용으로 내보낸 `.ipa`, 또는 iphoneos용 `.app`을 zip이나 tar로 묶어 올립니다.

- **설치는 iPhone에 있던 앱을 지우지 않고 그 위에 덮어씁니다.** 앱의 데이터와 로그인 상태가 남습니다. 시뮬레이터와 달리 깨끗한 상태에서 시작하지 않습니다.
- 설치가 거절되면(프로파일에 이 iPhone이 없음, 인증서 만료 등) iPhone의 기존 앱은 그대로 남습니다.
- 기존 앱이 다른 팀이나 App ID로 서명돼 있어 덮어쓸 수 없을 때만, tapflow가 기존 앱을 지우고 한 번 더 설치합니다. 이때는 앱의 데이터가 사라집니다.
- **시뮬레이터 빌드는 iPhone에서 실행할 수 없습니다.** 같은 앱이 TestFlight나 Firebase로 이미 설치돼 있으면 tapflow는 그 앱을 쓰고, 대시보드에 지금 테스트하는 것이 올린 빌드가 아니라는 경고와 설치된 버전을 보여 줍니다. 설치돼 있지 않으면 기기용 빌드를 올리라는 오류로 끝납니다.

## iPhone에서 할 수 없는 것

iPhone에서는 다음 기능이 거절되고, 대시보드는 해당 버튼을 보여 주지 않습니다.

- **Full reset**과 실행 초기화, 앱 데이터 지우기
- 클립보드 주고받기, 네트워크 제어, URL·딥 링크 열기, 에이전트의 스크린샷
- **Rotate**와 소프트웨어 키보드 버튼
- 핀치, 버튼 길게 누르기, 사이드 버튼, ⌘·⌃·⌥ 단축키

드래그는 손을 뗀 뒤에 시작점에서 끝점까지 직선으로 재생됩니다. 홈 버튼과 볼륨 버튼은 iPhone으로 보내지만, 볼륨 버튼은 하드웨어에서 확인하지 않았습니다.

iPhone은 맥에서 아무것도 부팅하지 않으므로, 맥의 메모리나 CPU가 부족해도 iPhone 세션은 거절되지 않습니다. 기기 목록에서는 시뮬레이터와 함께 iOS 버전 아래에 놓이고, Booted 대신 **Connected**로 표시되며, 다른 기기처럼 즐겨찾기·이름 바꾸기·숨기기를 할 수 있습니다. 맥에 부하가 걸려 있어도 iPhone이 있으면 그 맥의 카드가 열리고, 시뮬레이터만 흐리게 표시됩니다.

## 관련 문서

- [에이전트 설정](/ko/operate/agents)
- [설정 레퍼런스](/ko/reference/configuration)
