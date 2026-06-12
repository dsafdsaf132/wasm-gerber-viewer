<div align="center">

# wasm-gerber-viewer

PCB 시각화를 위한 WASM/WebGL2 기반 Gerber 파일 뷰어입니다.

![WASM Gerber Viewer preview](demo/preview.png)

<br/>

[**`English`**](README.md) · [**`简体中文`**](README.zh-Hans.md) · [**`繁體中文`**](README.zh-Hant.md) · **`한국어`**

</div>

---

웹사이트:

- [Viewer](https://wasm-gerber-viewer.vercel.app/) / [Mirror](https://dsafdsaf132.github.io/wasm-gerber-viewer/)
- [Sample 1: KLP-5e ESP32 Sensor Board](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fraw.githubusercontent.com%2Ffutureshocked%2FKLP-5e-ESP32-sensor-board%2Fmain%2FKiCad%2520project%2Fdfm%2Fgerber.zip)
- [Sample 2: Xassette-Asterisk](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fprocessor-cdn.kitspace.org%2Fv6%2FSdtElectronics%2FXassette-Asterisk%2F6ccd88501c99e2339571de744d003d571be47fad%2F_%2FXassette-Asterisk-6ccd885-gerbers.zip)
- [Sample 3: OtterCastAmp](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fprocessor-cdn.kitspace.org%2Fv6%2FOttercast%2FOtterCastAmp%2F0b5f7f9a8e4e43a5d39048b9a1fa03e5cf7fc9f7%2F_%2FOtterCastAmp-0b5f7f9-gerbers.zip)
- [Feature test](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fgerber-feature-test.gbr)
- Performance test - Stars: [1K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fperformance-test-stars-1K.gbr), [10K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fperformance-test-stars-10K.gbr), [100K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-100K.gbr), [1M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr), [5M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=5&repeatOffsetX=70), [10M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=10&repeatOffsetX=70), [20M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=20&repeatOffsetX=70), [50M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=50&repeatOffsetX=70), [100M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=100&repeatOffsetX=0.007)
- Performance test - Single region: [72K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fperformance-test-region-72K.gbr), [648K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-region-648K.gbr), [1.8M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-region-1.8M.gbr)
- Performance test - Arc region: [1.3M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-arc-region-1.3M.gbr)

## 기능

- 대형 Gerber 파일(10 MB 이상)을 빠르게 렌더링
- WASM과 WebGL2를 이용한 하드웨어 가속 렌더링
- RS-274X Gerber 렌더링 지원
- NC drill 오버레이 렌더링 지원
- 모바일 기기 터치 조작 지원
- 레이어별 색상, 투명도, 표시 여부 제어
- 좌우/상하 반전 제어
- mm/inch 단위 전환이 가능한 자 측정
- 자 오버레이를 포함한 해상도별 스크린샷 내보내기

## 빠른 시작

<details>
<summary>Bash</summary>

```bash
viewer_url="$(
  curl -fsSL https://api.github.com/repos/dsafdsaf132/wasm-gerber-viewer/releases/latest |
  sed -n '/"browser_download_url": .*\/wasm-gerber-viewer-.*\.tar\.gz"/ {
    s/.*"browser_download_url": *"\([^"]*\)".*/\1/p
    q
  }'
)"

curl -fsSL "$viewer_url" | tar -xz &&
cd wasm-gerber-viewer-* &&
python3 -m http.server 8000
```

브라우저에서 `http://localhost:8000`을 열고 Gerber 파일을 업로드합니다.

</details>

<details>
<summary>PowerShell</summary>

```powershell
$viewerUrl = (
  Invoke-RestMethod -Uri "https://api.github.com/repos/dsafdsaf132/wasm-gerber-viewer/releases/latest"
).assets |
  Where-Object { $_.name -match '^wasm-gerber-viewer-.*\.tar\.gz$' } |
  Select-Object -First 1 -ExpandProperty browser_download_url

Invoke-WebRequest -Uri $viewerUrl -OutFile viewer.tar.gz
tar -xzf viewer.tar.gz
Remove-Item viewer.tar.gz
Set-Location ((Get-ChildItem -Directory -Filter "wasm-gerber-viewer-*" | Select-Object -First 1).FullName)

python -m http.server 8000
```

브라우저에서 `http://localhost:8000`을 열고 Gerber 파일을 업로드합니다.

</details>

## 빌드

미리 빌드된 release artifact 대신 로컬에서 WASM 패키지를 다시 빌드해야 할 때 사용합니다.

요구 사항:

- **Rust stable** - [rustup](https://rustup.rs/)으로 설치
- **wasm-pack** - `cargo install wasm-pack`

```bash
rustup target add wasm32-unknown-unknown
wasm-pack build wasm --target web --out-dir pkg --release
```

## npm 패키지

[wasm-gerber-renderer](packages/wasm-gerber-renderer/README.kr.md)

JavaScript, Node.js, CLI에서 Gerber 파일을 PNG로 렌더링하는 패키지입니다.
Node.js와 CLI 렌더링은
[`node-gles-webgl2`](https://github.com/dsafdsaf132/node-gles-webgl2)를 통해 지원됩니다.

## 프로젝트 구조

```text
wasm-gerber-viewer/
├── index.html                         # 애플리케이션 셸
├── package.json                       # 프로젝트 메타데이터와 스크립트
├── css/
│   └── style.css                      # UI 스타일
├── js/
│   ├── main.js                        # GerberViewer 실행 흐름과 UI 연결
│   ├── config.js                      # 공통 상수와 기본값
│   ├── diagnostics.js                 # 진단 패널
│   ├── dom-elements.js                # DOM 요소 조회
│   ├── drawer-controller.js           # 드로어 열기/닫기 동작
│   ├── file-utils.js                  # 파일 이름과 오류 처리 유틸리티
│   ├── gerber-parse-worker.js         # Gerber 파싱 Web Worker
│   ├── layer-filters.js               # 레이어 종류 필터
│   ├── layer-list.js                  # 레이어 목록 렌더링
│   ├── measurements.js                # 자 측정과 단위 표시
│   ├── notifications.js               # 토스트 알림
│   ├── screenshot-exporter.js         # 스크린샷 내보내기
│   ├── source-loader.js               # 로컬 파일, 압축 파일, URL 입력 로딩
│   ├── viewer-options.js              # 뷰어 옵션 저장과 복원
│   └── viewport.js                    # 카메라와 viewport 계산
├── vendor/
│   ├── README.md                      # vendored 라이브러리 설명
│   ├── jszip-3.10.1.min.js            # ZIP 압축 파일 로딩
│   ├── lucide-1.16.0.min.js           # UI 아이콘
│   └── licenses/                      # vendored 라이선스
├── packages/
│   └── wasm-gerber-renderer/
│       ├── package.json               # npm 패키지 설정
│       ├── index.js                   # 브라우저 렌더러 진입점
│       ├── node.js                    # Node.js/headless 렌더러 진입점
│       ├── shared.js                  # 브라우저/Node 공통 로직
│       ├── index.d.ts                 # 브라우저 타입 정의
│       ├── node.d.ts                  # Node.js 타입 정의
│       ├── bin/                       # gerber-renderer CLI
│       ├── scripts/                   # 패키징용 WASM stage/clean 스크립트
│       └── test/                      # 패키지 테스트
├── wasm/
│   ├── Cargo.toml                     # Rust crate manifest
│   ├── Cargo.lock                     # Rust dependency lockfile
│   ├── rust-pipeline.md               # Rust/WASM 파이프라인 설명
│   ├── pkg/                           # 생성된 wasm-pack 출력
│   └── src/
│       ├── lib.rs                     # WASM API 진입점
│       ├── drill.rs                   # Excellon/NC drill 파서
│       ├── interaction.rs             # 도형 선택과 강조 표시 데이터
│       ├── parse_common.rs            # 파서 숫자 처리 공통 함수
│       ├── parser.rs                  # Gerber 파서 진입점
│       ├── parser/                    # aperture, macro, geometry, state, tests
│       ├── renderer.rs                # WebGL 렌더러
│       ├── renderer/                  # 렌더러 모듈
│       │   ├── buffer.rs              # GPU 리소스 구조체
│       │   ├── camera.rs              # 변환 계산
│       │   ├── shader.rs              # 셰이더 프로그램
│       │   └── shaders/               # GLSL 셰이더 소스
│       ├── shape.rs                   # geometry 데이터 모델
│       └── util.rs                    # 포맷팅과 유틸리티
├── demo/                              # 샘플과 성능 테스트 Gerber
├── scripts/
│   └── vercel-build.sh                # CI/Vercel WASM 빌드 스크립트
└── .github/workflows/
    ├── build-and-deploy.yml           # 빌드, 테스트, 배포 워크플로
    ├── renderer-compatibility.yml     # 렌더러 패키지 호환성 테스트
    └── release.yml                    # 수동 release 워크플로
```

## 브라우저 요구 사항

WebGL2를 지원하는 최신 브라우저가 필요합니다.

- Chrome 80+, Firefox 75+, Safari 15+, Edge 80+

## 출처

샘플 압축 파일은 각 원본 출처에서 로드하며 이 저장소에 포함하지 않습니다.

<details>
<summary>Sample 1: KLP-5e ESP32 Sensor Board</summary>

- Project: [KLP-5e ESP32 Sensor Board](https://github.com/futureshocked/KLP-5e-ESP32-sensor-board)
- Copyright: Copyright (c) 2025, Peter Dalmaris
- License: CERN-OHL-S v2.0
- Archive: <https://raw.githubusercontent.com/futureshocked/KLP-5e-ESP32-sensor-board/main/KiCad%20project/dfm/gerber.zip>

</details>

<details>
<summary>Sample 2: Xassette-Asterisk</summary>

- Project: [Xassette-Asterisk](https://github.com/SdtElectronics/Xassette-Asterisk)
- Copyright: SdtElectronics
- License: CERN-OHL-W v2.0
- Archive: <https://processor-cdn.kitspace.org/v6/SdtElectronics/Xassette-Asterisk/6ccd88501c99e2339571de744d003d571be47fad/_/Xassette-Asterisk-6ccd885-gerbers.zip>

</details>

<details>
<summary>Sample 3: OtterCastAmp</summary>

- Project: [OtterCastAmp](https://github.com/Ottercast/OtterCastAmp)
- Copyright: Copyright (c) 2021 Ottercast, Niklas Fauth
- License: MIT License
- Archive: <https://processor-cdn.kitspace.org/v6/Ottercast/OtterCastAmp/0b5f7f9a8e4e43a5d39048b9a1fa03e5cf7fc9f7/_/OtterCastAmp-0b5f7f9-gerbers.zip>

</details>

## 라이선스

[MIT License](LICENSE)
