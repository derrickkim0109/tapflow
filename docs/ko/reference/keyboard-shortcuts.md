---
title: 키보드 단축키
description: "tapflow 대시보드의 모든 키보드 단축키: QA Session 동작(딥 링크, 스크린샷, 녹화, 회전, Home, 소프트웨어 키보드, 핀치, 클립보드), 기기에 입력하기, 사이드바, Mac Resources 차트."
---

# 키보드 단축키

대시보드의 단축키를 동작하는 곳별로 모았습니다. 단축키는 <kbd>⌘</kbd>(Command) 키 기준이며 클립보드와 사이드바만 <kbd>Ctrl</kbd>도 받습니다.

## QA Session {#qa-session}

대시보드의 입력창에 커서가 있을 때는 동작하지 않습니다.

| 단축키 | 동작 | 플랫폼 |
|---|---|---|
| <kbd>⌘</kbd> <kbd>K</kbd> | [딥 링크](/ko/testing/deep-links) 입력창 열기 | iOS, Android |
| <kbd>⌘</kbd> <kbd>S</kbd> | [스크린샷](/ko/testing/screenshots-and-recordings#screenshots) 찍기 | iOS, Android |
| <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>Y</kbd> | [녹화](/ko/testing/screenshots-and-recordings#recordings) 시작·중지 | iOS, Android |
| <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>O</kbd> | [회전](/ko/testing/device-controls#rotate) | iOS, Android |
| <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>U</kbd> | [Home 버튼](/ko/testing/device-controls#device-buttons) 누르기 | iOS |
| <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>K</kbd> | [소프트웨어 키보드](/ko/testing/device-controls#software-keyboard) 올리기·내리기 | iOS |
| <kbd>⌥</kbd> + 드래그 | [핀치](/ko/testing/device-controls#touch-and-gestures) | iOS, Android |
| <kbd>⌘</kbd>/<kbd>Ctrl</kbd> <kbd>C</kbd>·<kbd>X</kbd>·<kbd>V</kbd> | 기기와 내 컴퓨터 사이의 [클립보드](/ko/testing/device-controls#clipboard) 복사·잘라내기·붙여넣기 | iOS, Android |

## 기기에 입력하기 {#typing-on-the-device}

기기 화면을 클릭하면 그 뒤로 누르는 다른 키는 모두 기기로 전달됩니다. <kbd>⇧</kbd>, <kbd>Ctrl</kbd>, <kbd>⌘</kbd>는 보조 키로 함께 전달됩니다. 이 상태에서는 정보 카드의 **Focus** 표시가 초록색으로 바뀝니다. 기기 바깥을 클릭하면 끝납니다.

## 대시보드 {#dashboard}

| 단축키 | 동작 |
|---|---|
| <kbd>⌘</kbd>/<kbd>Ctrl</kbd> <kbd>B</kbd> | 사이드바 열기·닫기 |

## Mac Resources 차트 {#mac-resources-charts}

[Mac Resources](/ko/operate/scaling#mac-resources) 페이지에서 차트에 포커스가 있을 때:

| 키 | 동작 |
|---|---|
| <kbd>←</kbd> <kbd>→</kbd> (또는 <kbd>↓</kbd> <kbd>↑</kbd>) | 이전·다음 측정값으로 이동 |
| <kbd>Home</kbd> / <kbd>End</kbd> | 가장 오래된·최신 측정값으로 이동 |
| <kbd>Esc</kbd> | 측정값 표시 닫기 |

## 관련 문서 {#related}

- [기기 조작](/ko/testing/device-controls): 터치, 제스처, 기기 버튼, 클립보드 자세히 보기
- [QA Session](/ko/testing/qa-session): 세션에서 할 수 있는 모든 것
