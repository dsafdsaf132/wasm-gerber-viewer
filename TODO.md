# Project Review TODO

Review baseline: `v0.5.0` (`8e5dc58`), 2026-07-10

Scope: Gerber/Drill parser, WebGL renderer, browser UI, Node/CLI package,
build, release, and compatibility workflows.

Priority definitions:

- **P1**: Resource exhaustion or application termination can be triggered by
  untrusted input. Address before adding more public input surfaces.
- **P2**: A runtime failure or regression can escape current recovery or CI
  checks. Address in the next reliability cycle.
- **P3**: Error handling, documentation, or quality-gate debt that can obscure
  future regressions.

## P1: Input Workload Limits

### [ ] P1-1 Add parser-wide work and allocation budgets

Affected code:

- `wasm/src/parser/state.rs`
- `wasm/src/parser/geometry.rs`
- `wasm/src/parser/aperture.rs`
- `wasm/src/parser/aperture_macro.rs`

Gerber Step-and-Repeat counts currently accept the full `u32` range and are
expanded through nested loops. Standard and macro polygon vertex counts are
also used without a practical upper bound, with some paths relying on
infallible `Vec::push` allocation. A small Gerber input can therefore consume
the available CPU and WASM memory or terminate the runtime.

Required work:

- Reject invalid or excessive Step-and-Repeat dimensions before expansion.
- Validate polygon and aperture-macro vertex counts against supported Gerber
  limits.
- Introduce a shared parser budget for generated primitives, regions,
  sublayers, and interaction records.
- Use checked arithmetic and fallible reservations before expansion loops.
- Return a stable, user-facing parser limit error instead of reaching OOM.
- Add adversarial tests for oversized SR commands and polygon counts.

Completion criteria:

- Tiny inputs cannot request unbounded generated geometry.
- Parser limit failures leave the processor reusable.
- Normal performance fixtures continue to parse without reduced coverage.

### [ ] P1-2 Apply ingestion limits to remote, archive, and repeat paths

Affected code:

- `js/core/config.js`
- `js/core/viewer.js`
- `js/loading/source-loader.js`

The advertised `300 MiB` limit is enforced for local top-level files only.
Remote responses are accumulated without a byte cap, ZIP entries have no
per-entry or total uncompressed-size limit, and the query-string `repeat`
parameter has no maximum before it reaches `Array.from`.

Required work:

- Enforce the file limit using both `Content-Length` and streamed received
  bytes; cancel the response reader when the limit is crossed.
- Enforce ZIP entry count, per-entry uncompressed size, and total uncompressed
  size limits before reading layer text.
- Reject suspicious compression ratios where metadata permits detection.
- Define and enforce a maximum repeat count and maximum resulting layer count.
- Keep all limits in shared configuration and show the actual limit in UI
  diagnostics.
- Add tests for missing/incorrect `Content-Length`, ZIP expansion, and crafted
  `repeat` query parameters.

Completion criteria:

- Every browser ingestion path has a bounded byte and layer budget.
- Limit errors close readers, hide loading state, and leave the viewer usable.

## P2: Renderer Reliability

### [ ] P2-1 Make framebuffer replacement transactional

Affected code: `wasm/src/renderer/mod.rs`

`resize_to` records the new explicit size and replaces layer FBOs one at a
time. If a later allocation fails, the renderer retains mixed framebuffer
sizes. FBO creation also leaks already-created textures/framebuffers when a
subsequent WebGL allocation fails. Context restoration has a similar partial
commit risk while rebuilding per-layer caches.

Required work:

- Allocate all replacement FBOs and caches into temporary owners first.
- Commit the new size and resources only after every allocation succeeds.
- Add RAII cleanup guards for partially built FBOs and shader resources.
- Preserve the old renderer state on resize or restore failure.
- Add failure-injection tests with a mock WebGL resource factory.

Completion criteria:

- Failed resize/restore calls can be retried without rebuilding the processor.
- Every failed WebGL allocation releases resources created by that attempt.

### [ ] P2-2 Abort failed browser PNG streams

Affected code:

- `packages/wasm-gerber-renderer/index.js`
- `packages/wasm-gerber-renderer/index.d.ts`
- `packages/wasm-gerber-renderer/README.md`

Browser streaming export closes the writable only on success. On compression,
pixel-read, or write failure it releases the writer lock without aborting the
underlying stream, which can leave a partial file or open writable behind.

Required work:

- Expose an `abort(error)` operation from the writable sink adapter.
- Abort the writer or `FileSystemWritableFileStream` on export failure.
- Preserve the original rendering error if abort also fails.
- Test write rejection, compression failure, and successful close behavior.

## P2: CI and Build Integrity

### [ ] P2-3 Check every deployed JavaScript module

Affected code: `.github/workflows/build-and-deploy.yml`

The current `js/*.js` glob checks only `js/main.js`; it does not parse modules
under `js/core`, `js/loading`, `js/rendering`, `js/layers`, or `js/ui`.

Required work:

- Change the syntax gate to recursively enumerate all JavaScript files.
- Run the package test suite for browser helper changes, or move viewer tests
  into a dedicated root test command.
- Make UI-only pull requests execute the relevant tests before deployment.

Completion criteria:

- A syntax error in any deployed module fails the pull-request workflow.
- Viewer helper tests run when their source files change.

### [ ] P2-4 Validate rendered pixels, not only PNG byte length

Affected code: `.github/workflows/renderer-compatibility.yml`

CLI and Node smoke tests currently require only a PNG larger than 100 bytes.
A valid but entirely blank image satisfies this check, so shader, stencil, and
compositing regressions can pass the platform matrix.

Required work:

- Decode smoke-test PNGs and assert dimensions and a minimum non-background
  pixel count.
- Include a fixture that covers polarity, holes, analytic arc regions, drills,
  and inverted rendering.
- Store a compact image signature or bounded pixel-difference baseline where
  exact output is stable.
- Keep a native context clear/readPixels test separate from renderer output
  validation.

### [ ] P2-5 Make the WASM build toolchain reproducible

Affected code:

- `scripts/vercel-build.sh`
- Rust toolchain configuration at the repository root

The script declares `wasm-pack 0.14.0` but uses any existing `wasm-pack` found
on `PATH`. The review build consequently used `0.13.1`. Rust is also selected
as moving `stable`, so generated glue and binaries can differ across machines.

Required work:

- Verify the installed `wasm-pack` version and install/use the pinned version
  when it differs.
- Pin Rust with `rust-toolchain.toml`, including the WASM target and required
  components.
- Include tool versions in the WASM source hash or build metadata.
- Test that local `npm pack` and CI release builds use the same versions.

### [ ] P2-6 Add real macOS x64 validation or correct the support claim

Affected code:

- `.github/workflows/renderer-compatibility.yml`
- `packages/wasm-gerber-renderer/README.md`
- Translated renderer READMEs and `SKILL.md`

The README says the renderer compatibility workflow performs build-only
validation for macOS x64, but the workflow matrix has no macOS x64 job.

Required work:

- Add an Intel macOS build/smoke job when an appropriate runner is available,
  or explicitly attribute build validation to the upstream
  `node-gles-webgl2` project.
- Generate support tables from one source or test them against the workflow
  matrix to prevent future drift.

## P3: UI Error Handling and Quality Gates

### [ ] P3-1 Handle file-upload promises at event boundaries

Affected code: `js/core/viewer.js`

File input and drop handlers call `handleFileUpload` without awaiting or
catching its promise. An unexpected collection or pipeline error produces an
unhandled rejection and skips final UI refresh and file-input reset.

Required work:

- Catch upload errors at both event boundaries and report them consistently.
- Move loading-modal cleanup, UI refresh, and file-input reset into a final
  cleanup path that always runs.
- Add tests for archive-read failure and non-recoverable worker failure.

### [ ] P3-2 Enforce formatting and linting in CI

Current baseline:

- `cargo fmt --manifest-path wasm/Cargo.toml --all -- --check` fails because
  three test modules start with a blank line.
- `cargo clippy --manifest-path wasm/Cargo.toml --all-targets -- -D warnings`
  fails on a redundant closure, a complex return type, and approximate
  `FRAC_PI_2` constants in renderer tests.

Required work:

- Fix the current formatting and Clippy findings.
- Add `cargo fmt --check` and an agreed Clippy policy to pull-request CI.
- Keep generated WASM output outside formatting and lint inputs.

## Verification Baseline

The following checks passed during the review:

- `cargo test --manifest-path wasm/Cargo.toml --all-targets`: 154 tests passed.
- `npm run check` in `packages/wasm-gerber-renderer`: 21 tests passed.
- `./scripts/vercel-build.sh`: WASM release build completed.
- `npm pack --dry-run`: package contained 15 files and packed successfully.
- Recursive `node --check` over `js/**/*.js`: passed.
- Required DOM IDs: no missing or duplicate IDs were detected.

Remaining runtime validation:

- Run browser interaction and visual checks at desktop and mobile viewports.
- Run the native Node/CLI pixel smoke on supported Linux, macOS, and Windows
  runners. The review environment installed `node-gles-webgl2` successfully,
  but its PRoot/Xvfb display could not initialize a native context.
