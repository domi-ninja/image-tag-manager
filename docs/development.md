# Development

[Back to README](../README.md)

## Commands

| Command | Behavior |
| --- | --- |
| `pnpm install` | Install JavaScript dependencies only. |
| `pnpm dev` | Launch the desktop app with frontend hot reload and Rust rebuilds on changes. Keeps running. |
| `pnpm build` | Build the release app and installers once, then exit. Does not launch or install. |
| `pnpm start` | Launch the existing native release build. Does not build, install, or watch. Run `pnpm build` first. |
| `pnpm install:linux` | Install dependencies, build an AppImage, and install it for the current Linux user. Does not launch or watch. |
| `pnpm install:linux --no-build` | Install an existing AppImage without rebuilding. |
| `pnpm dev:web` | Watch and serve the frontend only. Native desktop services are unavailable. Used by browser tests. |
| `pnpm build:web` | Type-check and build frontend assets once. |
| `pnpm preview:web` | Serve already-built frontend assets without watching. Native desktop services are unavailable. |

Desktop development and builds automatically download the pinned llama.cpp runtime
if it has not been prepared for this platform and version. `pnpm prepare:runtime`
is the internal setup command; it skips a matching existing runtime. Model weights
are downloaded separately from inside the app.

`pnpm start` uses Cargo to locate the default release output. Custom target builds
must be launched from their output directory. To run an installed app, use its
application-menu entry or installed executable instead.

## Development setup

Install Node 22+, pnpm, Rust 1.92+ (stable), and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).
On Ubuntu:

```sh
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev
pnpm install
pnpm dev
```

Windows requires the Microsoft C++ build tools and WebView2, as described in the
Tauri prerequisites. The same pnpm commands work in PowerShell. The runtime preparation
script downloads the CPU build for the current platform. Supported runtime packages:
Windows x64, Linux x64, and macOS x64/arm64. Windows and Linux have CI build jobs;
macOS has not been tested.

## Build installers

```sh
pnpm build
```

Artifacts are in `src-tauri/target/release/bundle/`. Build Windows installers on
Windows and Linux packages on Linux. `.github/workflows/build.yml` builds both and
uploads installers as workflow artifacts. Windows artifacts are unsigned; code signing
is not configured. Model weights download on first use and are not in the installer.

## Automatic updates

The app checks GitHub Releases at startup. Open **Options**, then choose
**Download update** to download and verify it while continuing to use the library.
**Update ready** means it will activate on the next launch, without another
network connection.
Linux replaces its AppImage and restarts; Windows launches the per-user NSIS
installer silently and reopens the updated app. A failed activation is not retried
in a loop: open the existing app and download the update again. Deb/MSI installs
do not support this update path; use AppImage/NSIS releases.

To release, bump the version in package.json, src-tauri/Cargo.toml, and
src-tauri/tauri.conf.json together (and update Cargo.lock). Commit, tag with
`v<version>`, then push the commit and tag to the GitHub remote.
The release workflow builds Linux x64 and Windows x64, signs update packages,
and publishes the draft only after both succeed. It generates latest.json for
the app's update endpoint.

The public verification key is committed in tauri.conf.json. The private signing
key is configured as the GitHub secret TAURI_SIGNING_PRIVATE_KEY; its local backup
is ~/.config/image-tag-manager/update.key. Keep this key backed up privately:
existing installs cannot accept releases signed by a different key. Update
signatures are separate from Windows Authenticode certificates; Windows may
still show SmartScreen warnings for a first installation.

## Validation

```sh
pnpm build:web
cargo test --manifest-path src-tauri/Cargo.toml --lib --features desktop
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features desktop -- -D warnings
pnpm exec playwright install chromium
pnpm exec playwright test
```

The Rust tests exercise real SQLite indexing, prefix search, tag updates, pagination,
folder removal, changed/missing files, overlapping roots, background/manual edit
races, migration rollback/checksums, source preservation, counts, merging, and orphan cleanup. Browser tests exercise the actual React UI with a mocked Tauri bridge and the
retained sample photos. They do not claim to exercise a native Windows webview.

Run a real, native inference and indexing check without the desktop window:

```sh
cargo run --manifest-path src-tauri/Cargo.toml --bin verify -- \
  .native-test samples src-tauri/runtime 3
```

This downloads and verifies the model, indexes the sample folder into a real SQLite
database, runs native Qwen on three pending images, generates thumbnails, and searches
the resulting index. It does not call Python or a hosted model API.

### Verified in this workspace

- Linux Debian installer built successfully, approximately 38 MB including the CPU runtime.
- Twenty Rust database/worker tests, an isolated Linux trash integration test,
  sixteen browser interaction tests, and a search parser test passed; TypeScript build
  and Rust clippy passed.
- The extracted Debian app ran in native WebKit through WebDriver. Real Qwen inference
  with configured categories reached SQLite, tag search returned the indexed results,
  and pause retained pending images. See [native validation](../results/desktop-validation.json)
  and [native screenshot](../results/desktop-native.png).
- Native window closure now terminates its model process. Linux also ties the model
  to the parent's lifetime, and Windows uses a kill-on-close job object. The Windows
  process-management module cross-compiles; the complete Windows app and installer
  still require the Windows CI job and have not been run on this Linux machine.
