---
title: 로그인과 계정
description: "`tapflow admin init`이 Already initialized로 실패할 때, 초대 링크나 비밀번호 재설정 링크가 만료되거나 거절될 때, 업그레이드 후 로그아웃됐을 때, 대소문자만 다른 계정이 있을 때의 해결 방법입니다."
---

# 로그인과 계정

관리자 계정 생성, 초대 링크와 비밀번호 재설정 링크, 로그인 문제를 해결합니다.

## `tapflow admin init` 실패 (`Already initialized`)

릴레이에 이미 관리자 계정이 존재합니다. 대시보드에 로그인한 뒤 **Settings → Team**에서 팀원을 초대하세요.

## 초대 링크가 만료됨

초대 링크는 **7일** 후 만료됩니다. Admin이 **Settings → Team**에서 새 초대를 만들어야 합니다. SMTP가 설정되지 않은 경우 초대 다이얼로그에 표시된 링크를 복사해 공유할 수 있습니다.

## 비밀번호 재설정 링크가 만료됨

비밀번호 재설정 링크는 **2시간** 후 만료됩니다. Admin이 **Settings → Team**에서 해당 멤버 행의 **Reset pwd**를 눌러 새 링크를 만들 수 있습니다. 링크는 다이얼로그에 표시되어 복사해 전달할 수 있고 SMTP가 설정되어 있으면 이메일로도 발송됩니다. 가장 최근에 만든 링크만 동작합니다.

## 초대 시 이미 멤버인 이메일이라고 나옴 {#invite-already-a-member}

이메일 입력란 아래에 **Already a member. Change their role in the list instead.**가 나오거나 초대 수락 화면에 **This email already has an account**가 나옵니다. 초대는 계정을 새로 만들 뿐 기존 계정을 바꾸지 않습니다. 그래서 이미 로그인할 수 있는 주소는 대소문자가 달라도 다시 초대할 수 없습니다.

- 역할을 바꾸려면 **Settings → Team**의 멤버 목록에서 바꾸세요.
- 비밀번호를 잊었다면 Admin이 그 멤버 행의 **Reset pwd**를 누르세요.

## 업그레이드 후 로그아웃됨 {#signed-out-after-upgrading}

v0.26.0으로 업그레이드하면 모두 한 번 다시 로그인해야 합니다. 이제 로그인 세션은 로그인할 때의 비밀번호에 묶이는데 이전 버전의 세션에는 그 정보가 없기 때문입니다. 비밀번호가 재설정되거나 바뀔 때도 같은 일이 한 사용자에게 일어나서 다른 모든 브라우저가 로그아웃됩니다. **Settings**에서 직접 바꾼 브라우저는 로그인이 유지됩니다.

## 비밀번호 재설정 후 토큰이 동작하지 않음 {#tokens-revoked-by-reset}

비밀번호를 재설정하면 그 멤버의 개인 액세스 토큰이 CI 토큰과 에이전트 토큰까지 모두 폐기되고 그 토큰으로 연결된 에이전트는 `Unauthorized: this token was revoked or has expired, or its owner was removed`와 함께 끊깁니다. 탈취된 계정을 가졌던 사람이 만든 토큰이 남지 않게 하기 위해서입니다. 로그인한 뒤 **Settings → Tokens**(Viewer는 [`POST /api/v1/tokens`](/ko/reference/api#post-api-v1-tokens)를 씁니다)에서 토큰을 새로 발급해 CI 시크릿과 각 원격 에이전트의 `--token` 등 기존 토큰이 있던 자리에 넣으세요. **Settings**에서 직접 비밀번호를 바꾸면 토큰은 유지됩니다.

## 대소문자만 다른 계정이 두 개 있음 {#accounts-differ-in-case}

릴레이 시작 로그에 **Accounts 2,3 differ only in letter case or spaces**가 나옵니다. 이제 이메일은 대소문자를 구분하지 않고 비교하지만 예전에 `alice@example.com`과 `Alice@example.com`처럼 따로 만들어진 두 계정은 그대로 둡니다. 두 계정 모두 정확한 주소로는 계속 로그인할 수 있습니다. 쓰지 않는 쪽을 **Settings → Team**에서 삭제하면 경고가 사라집니다.
