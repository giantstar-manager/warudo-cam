# Warudo Cam

SOOP에서 Warudo를 사용하는 스트리머들을 위한 P2P 영상 전송 도구.
서버 없이 브라우저만으로 Warudo 아바타 영상을 상대방 OBS에 전송합니다.

## 사용법

### 영상 보내는 사람 (Push)

1. [Push 페이지](index.html) 열기
2. Warudo Virtual Camera 선택
3. **"연결 코드 생성"** 클릭 → 코드 복사
4. 카톡/디코로 상대방에게 코드 전달
5. 상대방이 보낸 **응답 코드** 붙여넣기 → **"연결"** 클릭

### 영상 받는 사람 (View)

1. [View 페이지](view.html) 열기
2. 상대방이 보낸 **연결 코드** 붙여넣기 → **"연결"** 클릭
3. 생성된 **응답 코드** 복사 → 카톡/디코로 상대방에게 전달
4. 연결 완료! 비디오가 표시됩니다

### OBS에서 사용하기

1. OBS → **소스 추가** → **브라우저**
2. URL: View 페이지 주소 입력
3. 위 View 과정 진행 → 연결 후 아바타 영상만 표시됨

## 기술 스택

- **WebRTC** P2P 직접 연결 (서버 없음)
- **STUN**: Google, Cloudflare (무료)
- **TURN**: 자체 coturn 서버 (선택, NAT 환경 대비)
- **호스팅**: GitHub Pages (무료)

## TURN 서버 설정

P2P가 안 될 때를 대비해 TURN 서버를 설정할 수 있습니다.
→ [coturn 설정 가이드](docs/coturn-setup.md)

`rtc.js` 상단의 `ICE_SERVERS` 배열에서 TURN 서버 주소와 인증 정보를 수정하세요.

## 요구 사항

- Chrome 브라우저 (데스크톱)
- Warudo + Virtual Camera 활성화
- OBS Studio (영상 수신 시)
