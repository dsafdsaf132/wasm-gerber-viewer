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
- [Sample 1: SparkFun Thing Plus ESP32 WROOM C Panel](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsparkfun%2FSparkFun_Thing_Plus_ESP32_WROOM_C%2Fmain%2FHardware%2FProduction%2FSparkFun_Thing_Plus_ESP32_WROOM_C-Panel.zip)
- [Sample 2: LimeSDR-PCIe](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmyriadrf%2FLimeSDR-PCIe%2Fmaster%2Fhardware%2F1v3%2FDFM%2FLimeSDR-PCIe_1v3_DB_DFMr2.zip)
- [Sample 3: LimeNET-Micro](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmyriadrf%2FLimeNET-Micro%2Fmaster%2Fhardware%2F2v1%2FLimeNet-Micro_2v1-SDR_DB_DFMr2.zip)
- [Sample 4: Zaius EVT3 Motherboard (ODB++)](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fmedia.githubusercontent.com%2Fmedia%2Fopencomputeproject%2Fzaius-barreleye-g2%2Fmaster%2FHW%2FEE%2FGBR%2FEVT%2FMB%2FZaius-EVT3-LAYOUT-MB-ODB-X02-20161226-Final.zip)
- [Feature test](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fgerber-feature-test.gbr)
- Performance test - Stars: [1K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fperformance-test-stars-1K.gbr), [10K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fperformance-test-stars-10K.gbr), [100K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-100K.gbr), [1M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr), [5M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=5&repeatOffsetX=70), [10M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=10&repeatOffsetX=70), [20M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=20&repeatOffsetX=70), [50M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=50&repeatOffsetX=70), [100M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=100&repeatOffsetX=0.007)
- Performance test - Single region: [72K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fperformance-test-region-72K.gbr), [648K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-region-648K.gbr), [1.8M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-region-1.8M.gbr)
- Performance test - Arc region: [1.3M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-arc-region-1.3M.gbr)
- Memory64 test - Pads, 4 GiB 이상의 메모리 사용: [24M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fmemory64-test-pads-24M.gbr)

## 기능

- 대형 Gerber 파일(10 MB 이상)을 빠르게 렌더링
- WASM과 WebGL2를 이용한 하드웨어 가속 렌더링
- RS-274X Gerber 렌더링 지원
- NC drill 오버레이 렌더링 지원
- ODB++ 잡 가져오기 지원 (`.zip`, `.tgz`, `.tar.gz`, `.tar`)
- 모바일 기기 터치 조작 지원
- 레이어별 색상, 투명도, 표시 여부 제어
- Union, Intersection, Difference 및 사용자 지정 coverage 조합을 지원하는
  Composite Layer
- 도형 선택과 선택 영역 강조 표시 지원
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

wasm32는 `wasm/pkg`, memory64는 `wasm/pkg64`에 빌드합니다. memory64 스크립트가
필요한 빌드 도구를 설치합니다.

```bash
rustup target add wasm32-unknown-unknown
wasm-pack build wasm --target web --out-dir pkg --release
./scripts/build-wasm64.sh
```

## npm 패키지

[wasm-gerber-renderer](packages/wasm-gerber-renderer/README.kr.md)

JavaScript, Node.js, CLI에서 Gerber 파일을 PNG로 렌더링하는 패키지입니다.
Node.js와 CLI 렌더링은
[`node-gles-webgl2`](https://github.com/dsafdsaf132/node-gles-webgl2)를 통해 지원됩니다.

## 프로젝트 구조

Rust/WASM pipeline과 module 세부 내용은
[wasm/README.md](wasm/README.md)를 참고하세요.

```text
wasm-gerber-viewer/
├── index.html                         # 애플리케이션 셸
├── package.json                       # 프로젝트 메타데이터와 스크립트
├── css/                               # UI 스타일
├── js/
│   ├── main.js                        # 브라우저 진입점
│   ├── core/                          # GerberViewer 상태와 실행 흐름
│   ├── loading/                       # 파일, 압축, URL, repeat, worker 로딩
│   ├── layers/                        # 레이어 목록 UI, 필터, 색상, composite bitset
│   │   └── composite-layers.js        # preset, source slot, visible-area bitset
│   ├── rendering/                     # viewport 계산, 측정, 스크린샷 내보내기
│   └── ui/                            # dialog, DOM 조회, 알림, 진단, 옵션
│       └── composite-layer-dialog.js   # Composite 생성, 편집, 이름 변경 dialog
├── vendor/                            # vendored 브라우저 라이브러리
├── packages/
│   └── wasm-gerber-renderer/          # npm 패키지와 Node CLI
├── wasm/
│   ├── Cargo.toml                     # Rust crate manifest
│   ├── README.md                      # Rust/WASM 파이프라인 설명
│   ├── pkg/                           # 생성된 wasm-pack 출력 (wasm32)
│   ├── pkg64/                         # 생성된 memory64 빌드 (scripts/build-wasm64.sh)
│   └── src/
│       ├── lib.rs                     # WASM API 진입점
│       ├── tests.rs                   # crate 단위 테스트
│       ├── geometry/                  # 공용 geometry 모델과 region contour
│       ├── parser/                    # Gerber 파서, aperture, 명령 처리, 테스트
│       ├── drill/                     # Excellon/NC drill 파서와 테스트
│       ├── interaction/               # picking, compact payload, highlight 데이터
│       ├── renderer/                  # Gerber/composite mask, GPU 리소스, shader, 테스트
│       │   ├── composite.rs           # membership, lookup, outline, cache, picking 상태
│       │   └── shaders/composite_*.frag.glsl
│       └── util/                      # 포맷팅과 유틸리티
├── demo/                              # 샘플과 성능 테스트 Gerber
├── docs/                              # README assets
├── scripts/                           # 빌드와 배포 스크립트
└── .github/workflows/                 # CI, 배포, release 워크플로
```

## 브라우저 요구 사항

WebGL2와 WebAssembly SIMD 지원이 필요합니다.

### 64비트 (memory64)

- Chrome·Edge 133+
- Firefox 134+

### 32비트 (wasm32)

- Chrome·Edge 96–132
- Firefox 114–133
- Safari 16.4+ / iPhone·iPad 브라우저: iOS 16.4+

## 출처

샘플 압축 파일은 각 원본 출처에서 로드하며 이 저장소에 포함하지 않습니다.

<details>
<summary>Sample 1: SparkFun Thing Plus ESP32 WROOM C Panel</summary>

- Project: [SparkFun Thing Plus ESP32 WROOM C Panel](https://github.com/sparkfun/SparkFun_Thing_Plus_ESP32_WROOM_C)
- Copyright: SparkFun Electronics
- License: [CC BY-SA 4.0](https://github.com/sparkfun/SparkFun_Thing_Plus_ESP32_WROOM_C/blob/main/LICENSE.md)
- Archive: <https://raw.githubusercontent.com/sparkfun/SparkFun_Thing_Plus_ESP32_WROOM_C/main/Hardware/Production/SparkFun_Thing_Plus_ESP32_WROOM_C-Panel.zip>

</details>

<details>
<summary>Sample 2: LimeSDR-PCIe</summary>

- Project: [LimeSDR-PCIe](https://github.com/myriadrf/LimeSDR-PCIe)
- Copyright: LimeSDR-PCIe (c) 2016 Lime Microsystems Ltd
- License: [CC BY 3.0](https://github.com/myriadrf/LimeSDR-PCIe/blob/master/hardware/COPYING)
- Archive: <https://raw.githubusercontent.com/myriadrf/LimeSDR-PCIe/master/hardware/1v3/DFM/LimeSDR-PCIe_1v3_DB_DFMr2.zip>

</details>

<details>
<summary>Sample 3: LimeNET-Micro</summary>

- Project: [LimeNET-Micro](https://github.com/myriadrf/LimeNET-Micro)
- Copyright: Lime Microsystems Ltd
- License: [CC BY 3.0](https://github.com/myriadrf/LimeNET-Micro#licensing)
- Archive: <https://raw.githubusercontent.com/myriadrf/LimeNET-Micro/master/hardware/2v1/LimeNet-Micro_2v1-SDR_DB_DFMr2.zip>

</details>

<details>
<summary>Sample 4: Zaius EVT3 Motherboard (ODB++)</summary>

- Project: [Zaius & Barreleye G2](https://github.com/opencomputeproject/zaius-barreleye-g2)
- Copyright: Copyright International Business Machines Corporation 2015
- License: [Open Compute Project Hardware License-Permissive (OCPHL-P) v1.0](https://raw.githubusercontent.com/opencomputeproject/zaius-barreleye-g2/master/license.md)
- Archive: <https://media.githubusercontent.com/media/opencomputeproject/zaius-barreleye-g2/master/HW/EE/GBR/EVT/MB/Zaius-EVT3-LAYOUT-MB-ODB-X02-20161226-Final.zip>

</details>

## 라이선스

[MIT License](LICENSE)
