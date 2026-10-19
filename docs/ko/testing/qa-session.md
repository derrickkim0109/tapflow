---
title: QA 세션
description: Mac과 기기를 골라 세션을 시작하고 기기 화면을 브라우저에서 조작하는 화면입니다. 세션에서 쓸 수 있는 기능마다 자세한 페이지로 안내합니다.
---

# QA 세션

QA 세션은 Mac에서 실행 중인 iOS 시뮬레이터나 Android 에뮬레이터를 브라우저로 보면서 직접 조작하는 화면입니다. 기기는 운영자의 Mac에서 돌아가므로 팀원은 아무것도 설치하지 않습니다. [App Center](/ko/testing/app-center)에서 빌드 행의 **Start QA**를 누르면 열립니다.

## 세션 시작 {#start-a-session}

### Mac 고르기 {#select-mac}

**Select Mac** 화면에는 이 플랫폼의 기기를 가진 Mac이 카드로 나옵니다. 카드마다 이름, 상태 점, 남은 슬롯 수(`2/4 slots`처럼 남은 수/전체 수), CPU와 RAM 사용률이 표시됩니다.

| 상태 점 | 의미 |
|---|---|
| 초록 | 여유 있음 |
| 노랑 | CPU나 RAM 사용률이 70% 이상 80% 이하 |
| 빨강 | CPU나 RAM 사용률이 80%를 넘음. 카드를 누를 수 없습니다 |
| 회색 | 사용률 보고가 없거나 30초 넘게 끊김. 카드에 **Stale**이 붙습니다 |

빨간 카드에 마우스를 올리면 **This Mac is currently overloaded. Try again later.**가 표시됩니다. 다른 Mac을 고르거나 잠시 뒤에 다시 시도하세요.

### 기기 고르기 {#select-device}

**Select device** 화면에서 기기를 클릭하면 세션이 시작됩니다. 기기마다 상태가 표시됩니다.

- **Booted**: 이미 켜져 있는 기기입니다.
- **Available**: 꺼져 있고 바로 쓸 수 있는 기기입니다. 고르면 켜집니다.
- **In use**: 다른 팀원이 쓰고 있어 고를 수 없습니다.

**Search device…** 검색창으로 기기 이름을 찾습니다. OS 버전 필터(기본값 **Any version**)로 목록을 좁힙니다.

**Full reset** 스위치를 켜고 기기를 고르면 다른 앱을 포함한 그 기기의 데이터를 모두 지우고 시작합니다. 스위치를 끈 채로 시작해도 테스트할 빌드는 매번 새로 설치되므로 그 앱의 데이터는 지워진 상태로 시작합니다. 한 번만 적용되는 설정이라 기기를 고르는 순간 스위치가 다시 꺼집니다. 이 스위치는 Mac이 초기화를 지원할 때만 보입니다.

### 앱 실행 {#launch}

기기가 켜지면 빌드가 자동으로 설치됩니다. 기기 오른쪽 정보 카드에 **Starting device…**, **Installing app…** 같은 진행 상태가 표시됩니다. 설치가 끝나면 툴바에 **Launch app** 버튼이 나타나고 이 버튼을 눌러 앱을 실행합니다. 자세한 내용은 [기기 조작](/ko/testing/device-controls#launch-the-app)을 참고하세요.

### 세션 나가기 {#leave-a-session}

화면 위쪽 경로 표시(breadcrumb)는 `앱 이름 › 빌드 › Mac › 기기` 순서입니다. 앞 단계를 누르면 그 단계로 돌아갑니다. 기기 화면을 떠나면 그 기기는 종료되므로 다른 팀원이 바로 쓸 수 있습니다. 브라우저 탭을 닫을 때도 같습니다.

## 세션에서 할 수 있는 일 {#features}

| 기능 | 설명 |
|---|---|
| [화면 조작](/ko/testing/device-controls#touch-and-gestures) | 클릭으로 터치하고 드래그로 스와이프합니다. Option(Alt)을 누른 채 드래그하면 핀치입니다. |
| [키 입력](/ko/testing/device-controls#typing) | 기기 화면을 한 번 클릭한 뒤 키보드로 입력합니다. |
| [앱 실행](/ko/testing/device-controls#launch-the-app) | 설치된 빌드를 **Launch app**으로 실행합니다. |
| [기기 버튼](/ko/testing/device-controls#device-buttons) | iOS의 Home과 기기 테두리의 측면 버튼, Android의 **Home**·**Back**·**Recent Apps**·**Volume Up**·**Volume Down**·**Power**를 누릅니다. |
| [소프트웨어 키보드](/ko/testing/device-controls#software-keyboard) | iOS 화면 키보드를 올리거나 내립니다. |
| [회전](/ko/testing/device-controls#rotate) | 기기를 가로·세로로 돌립니다. |
| [접기와 펼치기](/ko/testing/device-controls#fold) | 폴더블 Android 에뮬레이터를 접거나 펼칩니다. |
| [기기 재시작](/ko/testing/device-controls#restart) | 기기를 다시 켭니다. 테스트 중인 빌드는 새로 설치되고 다른 앱의 데이터는 남습니다. |
| [클립보드](/ko/testing/device-controls#clipboard) | 기기와 내 컴퓨터 사이에서 텍스트를 복사하고 붙여 넣습니다. |
| [딥 링크](/ko/testing/deep-links) | URL을 입력해 앱의 특정 화면을 바로 엽니다. |
| [네트워크 제어](/ko/testing/network-control) | 기기를 오프라인으로 만들었다가 다시 연결합니다. |
| [오디오](/ko/testing/audio) | 기기 소리를 브라우저에서 듣습니다. |
| [스크린샷](/ko/testing/screenshots-and-recordings#screenshots) | 기기 화면을 PNG로 내려받습니다. |
| [녹화](/ko/testing/screenshots-and-recordings#recordings) | 기기 화면을 영상으로 녹화해 팀과 공유합니다. |
| [댓글](/ko/testing/comments) | 빌드에 글과 이미지를 남깁니다. |
| [키보드 단축키](#keyboard-shortcuts) | 자주 쓰는 기능을 단축키로 실행합니다. |

기능 버튼은 기기 오른쪽 툴바에 Navigation(이동), Device(기기 상태), Capture(캡처), Environment(환경) 네 묶음으로 놓여 있습니다. Mac이 지원하지 않는 기능의 버튼은 보이지 않습니다.

## 정보 카드 {#info-card}

기기 오른쪽 정보 카드에는 세션 상태가 표시됩니다.

- **Focus**: 키 입력이 기기로 가는 동안 초록색으로 바뀝니다.
- **fps**: 초당 받는 화면 수입니다. 15를 넘으면 **Active**, 그 이하이면 **Idle**로 표시됩니다. 화면이 멈춰 있으면 수치가 낮은 것이 정상입니다.
- **Smooth** / **Standard**: 이 브라우저가 받는 스트림 프로파일입니다. **Standard**를 누르면 Smooth로 바꾸는 조건을 안내하는 창이 열립니다. 프로파일은 [스트림 품질](/ko/operate/streaming-quality)을 참고하세요.

카드 아래쪽 탭에서 [댓글](/ko/testing/comments)(**Comments**)과 [녹화](/ko/testing/screenshots-and-recordings#recordings)(**Recordings**)를 봅니다.

## 키보드 단축키 {#keyboard-shortcuts}

아래 단축키는 대시보드의 입력창에 커서가 있을 때는 동작하지 않습니다.

| 단축키 | 동작 | 플랫폼 |
|---|---|---|
| <kbd>⌘</kbd> <kbd>K</kbd> | [딥 링크](/ko/testing/deep-links) 입력창 열기 | iOS, Android |
| <kbd>⌘</kbd> <kbd>S</kbd> | [스크린샷](/ko/testing/screenshots-and-recordings#screenshots) | iOS, Android |
| <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>Y</kbd> | [녹화](/ko/testing/screenshots-and-recordings#recordings) 시작·중지 | iOS, Android |
| <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>O</kbd> | [회전](/ko/testing/device-controls#rotate) | iOS, Android |
| <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>U</kbd> | [Home 버튼](/ko/testing/device-controls#device-buttons) | iOS |
| <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>K</kbd> | [소프트웨어 키보드](/ko/testing/device-controls#software-keyboard) 올리기·내리기 | iOS |
| <kbd>⌥</kbd> + 드래그 | [핀치](/ko/testing/device-controls#touch-and-gestures) | iOS, Android |
| <kbd>⌘</kbd>/<kbd>Ctrl</kbd> <kbd>C</kbd>·<kbd>X</kbd>·<kbd>V</kbd> | [클립보드](/ko/testing/device-controls#clipboard) 복사·잘라내기·붙여넣기 | iOS, Android |

그 밖의 키는 기기 화면을 클릭한 뒤 누르면 기기로 전달됩니다.

## 제한 사항 {#limits}

- 한 기기는 한 번에 한 사람만 씁니다. 다른 팀원이 쓰는 기기는 **In use**로 표시되고 고를 수 없습니다.
- 기기 화면을 떠나면 기기가 종료됩니다. 화면에 띄워 둔 상태는 남지 않고 다른 앱의 데이터는 남습니다. 테스트할 빌드는 다음 세션을 시작할 때 다시 설치되므로 그 앱의 데이터는 이어지지 않습니다.

## 문제 해결 {#troubleshooting}

세션이 끊기면 대시보드가 이유를 알림으로 보여 주고 Mac 목록으로 돌아갑니다.

| 알림 | 원인과 조치 |
|---|---|
| **`The agent disconnected — this session ended.`** | Mac 쪽 연결이 끊겼습니다. Mac을 다시 골라 새 세션을 시작합니다. |
| **This device is already open in another browser session.** | 다른 사람이 그 기기를 쓰고 있습니다. 연결이 끊긴 사이 새로고침했다면 내 이전 탭이 기기를 잡고 있으며 약 45초 안에 풀립니다. |
| **That Mac is too busy to start a session.** | Mac의 CPU나 RAM이 한도를 넘었습니다. 다른 Mac을 고르거나 잠시 기다립니다. |

스트림이 끊기거나 느리면 [스트림과 세션 문제 해결](/ko/troubleshooting/streaming)을 참고하세요.

## 관련 문서 {#related}

- [App Center](/ko/testing/app-center): 빌드를 고르고 리뷰 상태를 바꾸는 화면
- [기기 조작](/ko/testing/device-controls): 터치, 버튼, 회전, 클립보드 등 기기를 다루는 방법
- [스트림 품질](/ko/operate/streaming-quality): Smooth와 Standard 프로파일의 차이
