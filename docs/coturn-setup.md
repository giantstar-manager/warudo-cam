# Coturn TURN 서버 설치 가이드 (Ubuntu)

> 집/사무실 Ubuntu 서버에 coturn을 설치하여 TURN 서버를 운영하는 방법입니다.

---

## 목차

1. [개요](#개요)
2. [사전 준비](#사전-준비)
3. [coturn 설치](#coturn-설치)
4. [SSL 인증서 발급](#ssl-인증서-발급)
5. [coturn 설정](#coturn-설정)
6. [방화벽 설정](#방화벽-설정)
7. [서비스 시작](#서비스-시작)
8. [DDNS 설정 (유동 IP인 경우)](#ddns-설정-유동-ip인-경우)
9. [동작 테스트](#동작-테스트)
10. [rtc.js 설정](#rtcjs-설정)
11. [인증서 자동 갱신](#인증서-자동-갱신)
12. [트러블슈팅](#트러블슈팅)

---

## 개요

### TURN 서버가 왜 필요한가요?

영상 스트리밍은 기본적으로 **P2P(피어 투 피어)** 방식으로 직접 연결을 시도합니다.
하지만 한국 ISP(KT, SK, LG 등)는 대부분 **Symmetric NAT**을 사용하기 때문에,
P2P 직접 연결이 실패하는 경우가 자주 발생합니다.

**TURN 서버**는 이런 상황에서 **중계 서버** 역할을 합니다:

```
[카메라 PC] --X--> [방송 PC]     ← P2P 연결 실패 (NAT 때문)

[카메라 PC] --> [TURN 서버] --> [방송 PC]   ← TURN 서버가 중간에서 영상 전달
```

즉, P2P가 안 될 때 **예비 경로**로 사용되는 서버입니다.

### 직접 운영하면 뭐가 좋은가요?

- **무료**: 외부 TURN 서비스 비용 없음
- **빠름**: 같은 네트워크 or 국내 서버라 지연이 적음
- **안정**: 내가 직접 관리하므로 제한 없음

---

## 사전 준비

시작하기 전에 아래 항목을 확인하세요:

| 항목 | 설명 |
|------|------|
| **Ubuntu 서버** | Ubuntu 20.04 이상, 인터넷에 연결된 물리 서버 |
| **도메인 또는 DDNS** | SSL 인증서 발급에 필요 (예: `myturn.duckdns.org`) |
| **공유기 포트포워딩** | 필요한 포트를 서버로 열어줘야 함 |
| **SSH 접속** | 서버에 터미널로 접속할 수 있어야 함 |

### 필요한 포트 목록

| 포트 | 프로토콜 | 용도 |
|------|----------|------|
| 3478 | TCP/UDP | TURN 기본 포트 |
| 443 | TCP | TLS를 통한 TURN (방화벽 우회에 유리) |
| 49152-65535 | UDP | 미디어 릴레이 포트 범위 |

> **중요**: 공유기 관리 페이지에서 위 포트들을 서버 내부 IP로 포트포워딩 해주세요.

---

## coturn 설치

서버에 SSH로 접속한 후 아래 명령어를 실행합니다:

```bash
$ sudo apt update
$ sudo apt install -y coturn
```

설치가 완료되면 coturn 서비스가 자동으로 생기지만, 아직 시작하지 마세요.
설정을 먼저 해야 합니다.

---

## SSL 인증서 발급

TURN 서버를 TLS(암호화) 모드로 운영하려면 SSL 인증서가 필요합니다.
Let's Encrypt를 사용하면 무료로 발급받을 수 있습니다.

### certbot 설치

```bash
$ sudo apt install -y certbot
```

### 인증서 발급

> **주의**: 인증서 발급 전에 **80번 포트**가 열려있어야 합니다.
> 공유기에서 80번 포트도 서버로 포트포워딩 해주세요. (발급 후 닫아도 됨)

```bash
$ sudo certbot certonly --standalone -d your-domain.kr
```

`your-domain.kr` 부분을 본인의 도메인(또는 DDNS 주소)으로 바꿔주세요.

이메일 입력, 약관 동의 등의 질문이 나오면 답변해주세요.

성공하면 인증서가 아래 경로에 저장됩니다:

```
/etc/letsencrypt/live/your-domain.kr/fullchain.pem   ← 인증서
/etc/letsencrypt/live/your-domain.kr/privkey.pem     ← 개인키
```

### coturn이 인증서를 읽을 수 있게 권한 설정

```bash
$ sudo chmod 755 /etc/letsencrypt/live/
$ sudo chmod 755 /etc/letsencrypt/archive/
```

---

## coturn 설정

기존 설정 파일을 백업하고, 새로 작성합니다:

```bash
$ sudo cp /etc/turnserver.conf /etc/turnserver.conf.backup
```

아래 내용을 그대로 복사해서 설정 파일에 붙여넣으세요:

```bash
$ sudo nano /etc/turnserver.conf
```

### 설정 파일 전체 내용

아래 내용을 **그대로 복사**해서 붙여넣으세요.
`your-domain.kr`과 `YOUR_SECURE_PASSWORD_HERE`만 본인 것으로 바꿔주세요:

```
# === 기본 포트 ===
listening-port=3478
tls-listening-port=443

# === 인증 방식 ===
fingerprint
lt-cred-mech

# === 사용자 계정 (비밀번호를 반드시 변경하세요!) ===
user=warudo:YOUR_SECURE_PASSWORD_HERE

# === 도메인 (본인 도메인으로 변경) ===
realm=your-domain.kr

# === SSL 인증서 경로 (본인 도메인으로 변경) ===
cert=/etc/letsencrypt/live/your-domain.kr/fullchain.pem
pkey=/etc/letsencrypt/live/your-domain.kr/privkey.pem

# === 미디어 릴레이 포트 범위 ===
min-port=49152
max-port=65535

# === 보안 설정 ===
no-multicast-peers
no-cli
```

> **비밀번호 팁**: `YOUR_SECURE_PASSWORD_HERE`를 영문+숫자 조합으로 바꿔주세요.
> 예: `Myp4ssw0rd!2024` (이것도 그대로 쓰지 말고, 본인만의 비밀번호를 만드세요)

nano 에디터에서 저장하려면: `Ctrl+O` → `Enter` → `Ctrl+X`

---

## 방화벽 설정

Ubuntu 방화벽(ufw)에서 필요한 포트를 열어줍니다:

```bash
$ sudo ufw allow 3478/tcp
$ sudo ufw allow 3478/udp
$ sudo ufw allow 443/tcp
$ sudo ufw allow 49152:65535/udp
```

방화벽이 활성화되어 있는지 확인:

```bash
$ sudo ufw status
```

만약 비활성화 상태라면 활성화합니다:

```bash
$ sudo ufw enable
```

> **참고**: SSH 포트(기본 22번)도 열려있는지 확인하세요.
> 실수로 SSH 포트를 안 열면 서버에 접속이 안 될 수 있습니다!
> ```bash
> $ sudo ufw allow 22/tcp
> ```

---

## 서비스 시작

### coturn 서비스 활성화

먼저, coturn 자동 시작 설정 파일을 수정합니다:

```bash
$ sudo nano /etc/default/coturn
```

파일에서 아래 줄을 찾아 **주석(#)을 제거**하세요:

```
# 변경 전:
#TURNSERVER_ENABLED=1

# 변경 후:
TURNSERVER_ENABLED=1
```

저장 후 종료합니다. (`Ctrl+O` → `Enter` → `Ctrl+X`)

### 서비스 시작 및 자동 시작 등록

```bash
$ sudo systemctl enable coturn
$ sudo systemctl start coturn
```

### 서비스 상태 확인

```bash
$ sudo systemctl status coturn
```

`active (running)` 이라고 나오면 정상입니다. 아래와 비슷하게 보여야 합니다:

```
● coturn.service - coTURN STUN/TURN Server
   Active: active (running) since ...
```

만약 실패했다면 로그를 확인하세요:

```bash
$ sudo journalctl -u coturn -n 50
```

---

## DDNS 설정 (유동 IP인 경우)

가정용 인터넷은 보통 IP가 주기적으로 바뀝니다(유동 IP).
DDNS를 사용하면 IP가 바뀌어도 같은 주소로 접속할 수 있습니다.

### 방법 1: DuckDNS (무료, 간편)

1. [https://www.duckdns.org](https://www.duckdns.org) 접속 후 계정 생성
2. 원하는 서브도메인 등록 (예: `myturn` → `myturn.duckdns.org`)
3. 서버에서 자동 업데이트 스크립트 설정:

```bash
$ mkdir -p ~/duckdns
$ nano ~/duckdns/duck.sh
```

아래 내용을 붙여넣으세요 (토큰과 도메인을 본인 것으로 변경):

```bash
#!/bin/bash
echo url="https://www.duckdns.org/update?domains=myturn&token=YOUR_DUCKDNS_TOKEN&ip=" | curl -k -o ~/duckdns/duck.log -K -
```

실행 권한 부여 및 크론 등록:

```bash
$ chmod +x ~/duckdns/duck.sh
$ crontab -e
```

크론탭에 아래 줄 추가 (5분마다 IP 업데이트):

```
*/5 * * * * ~/duckdns/duck.sh >/dev/null 2>&1
```

### 방법 2: No-IP (무료 플랜 있음)

1. [https://www.noip.com](https://www.noip.com) 접속 후 계정 생성
2. 호스트네임 등록
3. Linux 클라이언트 설치:

```bash
$ sudo apt install -y noip2
$ sudo noip2 -C
```

설정 시 No-IP 계정 정보를 입력하면 자동으로 IP를 업데이트해줍니다.

```bash
$ sudo systemctl enable noip2
$ sudo systemctl start noip2
```

> **고정 IP를 사용하는 경우**: DDNS 설정은 필요 없습니다. 도메인 DNS에서 A 레코드를
> 서버 IP로 직접 지정하면 됩니다.

---

## 동작 테스트

coturn이 제대로 작동하는지 테스트합니다.

### turnutils로 테스트

```bash
$ turnutils_uclient -t -u warudo -w YOUR_SECURE_PASSWORD_HERE your-domain.kr
```

`YOUR_SECURE_PASSWORD_HERE`를 설정 파일에 넣은 비밀번호로,
`your-domain.kr`을 본인 도메인으로 바꿔주세요.

성공하면 아래와 비슷한 출력이 나옵니다:

```
0: Total transmit time is ...
0: Total lost packets ...
0: Average round trip delay ...
```

에러 없이 출력되면 TURN 서버가 정상 작동하는 것입니다.

### 외부에서 테스트 (선택사항)

다른 네트워크(예: 스마트폰 LTE)에서도 테스트하고 싶다면:

1. [https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/) 접속
2. STUN or TURN URI에 입력: `turn:your-domain.kr:443?transport=tcp`
3. Username: `warudo`
4. Password: 설정한 비밀번호
5. "Add Server" 클릭 → "Gather candidates" 클릭
6. `relay` 타입 candidate가 나오면 성공!

---

## rtc.js 설정

TURN 서버가 정상 작동하면, `rtc.js` 파일에서 ICE 서버 설정을 변경합니다.

기존 ICE 서버 설정을 찾아서 아래와 같이 TURN 서버 정보를 추가하세요:

```javascript
{
  urls: 'turn:your-domain.kr:443?transport=tcp',
  username: 'warudo',
  credential: 'YOUR_SECURE_PASSWORD_HERE'
}
```

> **포트 443을 사용하는 이유**: 일부 네트워크에서 3478 포트를 막아놓는 경우가 있습니다.
> 443 포트(HTTPS 포트)는 거의 모든 곳에서 열려있어서 **방화벽 우회에 유리**합니다.

### 변경할 부분 예시

`your-domain.kr`과 `YOUR_SECURE_PASSWORD_HERE`를 본인 것으로 바꿔주세요:

```javascript
// TURN 서버 설정 (STUN과 함께 사용)
const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: 'turn:your-domain.kr:443?transport=tcp',
    username: 'warudo',
    credential: 'YOUR_SECURE_PASSWORD_HERE'
  }
];
```

---

## 인증서 자동 갱신

Let's Encrypt 인증서는 **90일마다 만료**됩니다.
자동 갱신을 설정해두면 신경 쓸 필요가 없습니다.

### 갱신 테스트

먼저 갱신이 정상적으로 되는지 테스트합니다:

```bash
$ sudo certbot renew --dry-run
```

에러 없이 완료되면 자동 갱신이 가능한 상태입니다.

### 크론으로 자동 갱신 등록

```bash
$ sudo crontab -e
```

아래 줄을 추가합니다 (매일 새벽 3시에 갱신 시도, 갱신 후 coturn 재시작):

```
0 3 * * * certbot renew --quiet --deploy-hook "systemctl restart coturn"
```

> **설명**: `--deploy-hook`은 인증서가 실제로 갱신됐을 때만 coturn을 재시작합니다.
> 갱신이 필요 없으면(만료 30일 전이 아니면) 아무 일도 안 합니다.

---

## 트러블슈팅

### 문제: coturn 서비스가 시작되지 않음

**원인 1: 443 포트를 다른 프로그램이 사용 중**

```bash
$ sudo lsof -i :443
```

nginx, apache 등이 443 포트를 쓰고 있으면 충돌합니다.
해당 서비스를 중지하거나, coturn의 TLS 포트를 다른 번호(예: 5349)로 변경하세요.

**원인 2: 인증서 경로가 잘못됨**

```bash
$ sudo ls -la /etc/letsencrypt/live/your-domain.kr/
```

파일이 없다면 인증서 발급이 안 된 것입니다. SSL 인증서 발급 단계를 다시 진행하세요.

**원인 3: /etc/default/coturn 설정 누락**

```bash
$ cat /etc/default/coturn
```

`TURNSERVER_ENABLED=1`이 있는지 확인하세요.

---

### 문제: 포트가 막혀있음 (외부에서 접속 안 됨)

**확인 방법:**

```bash
$ sudo ss -tlnp | grep turnserver
```

coturn이 해당 포트에서 리스닝하고 있는지 확인합니다.

**해결:**

1. ufw 방화벽 규칙 확인: `sudo ufw status`
2. 공유기 포트포워딩 확인 (공유기 관리 페이지 접속)
3. ISP에서 포트를 차단하는 경우: ISP 고객센터에 문의

---

### 문제: 인증서가 만료됨

**증상**: 브라우저에서 연결이 안 되거나 TLS 에러 발생

**해결:**

```bash
$ sudo certbot renew --force-renewal
$ sudo systemctl restart coturn
```

---

### 문제: relay candidate가 안 나옴 (Trickle ICE 테스트)

1. 비밀번호에 특수문자가 있으면 문제가 될 수 있습니다 → 영문+숫자만 사용해보세요
2. 도메인이 서버 IP로 제대로 연결되는지 확인:
   ```bash
   $ nslookup your-domain.kr
   ```
3. coturn 로그에서 에러 확인:
   ```bash
   $ sudo journalctl -u coturn -n 100 --no-pager
   ```

---

### 문제: 서버 재부팅 후 coturn이 안 켜짐

```bash
$ sudo systemctl is-enabled coturn
```

`disabled`라고 나오면:

```bash
$ sudo systemctl enable coturn
$ sudo systemctl start coturn
```

---

## 요약 체크리스트

설정이 다 끝났다면 아래를 모두 확인하세요:

- [ ] coturn 설치됨
- [ ] SSL 인증서 발급됨
- [ ] `/etc/turnserver.conf` 설정 완료 (비밀번호, 도메인 변경)
- [ ] `/etc/default/coturn`에서 `TURNSERVER_ENABLED=1` 설정
- [ ] 방화벽 포트 열림 (3478, 443, 49152-65535)
- [ ] 공유기 포트포워딩 설정
- [ ] coturn 서비스 시작 및 자동시작 등록
- [ ] `turnutils_uclient` 테스트 통과
- [ ] `rtc.js`에 TURN 서버 정보 입력
- [ ] 인증서 자동 갱신 크론 등록
- [ ] (유동 IP인 경우) DDNS 설정

모두 체크되면 TURN 서버 설정 완료입니다! :tada:
