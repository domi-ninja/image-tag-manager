# Image Shelf

A local image library for Windows and Linux. Add multiple folders, let Qwen generate
searchable tags and captions, and find images through a SQLite full-text index.

The application is React + TypeScript + Tailwind + shadcn-style Radix components,
inside Tauri. Rust handles SQLite, folder scanning, thumbnails, model downloads, and
llama.cpp. **No Python is used to build or run the application.** Earlier classifier
research files remain in this repository; see [EXPERIMENT.md](EXPERIMENT.md).

## Run from source

Install Node 22+, pnpm, stable Rust, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).
On Ubuntu:

```sh
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev
pnpm install
pnpm prepare:runtime
pnpm desktop
```

Windows requires the Microsoft C++ build tools and WebView2, as described in the
Tauri prerequisites. The same pnpm commands work in PowerShell. The runtime preparation
script downloads the CPU build for the current platform. Supported runtime packages:
Windows x64, Linux x64, and macOS x64/arm64. Windows and Linux have CI build jobs;
macOS has not been tested.

## Use

1. Add folders using the plus button. Subfolders are included automatically.
2. Download the model once with **Download model**. It downloads 2.65 GB from Qwen's
   official repository, checks SHA-256, and resumes interrupted downloads.
3. Choose **Classify pending**, or enable **Classify automatically**. Automatic mode
   checks enabled folders every 30 seconds while the app is open.
4. Search tags, captions, filenames, and categories. Words use prefix matching and
   combine with AND. Click a tag for an exact tag filter. Filter by folder or status.
5. Open an image to edit its tags, caption, or category. Edits update search immediately.

Folder settings allow a display name, pause/resume, optional category list, and extra
classification instructions. Categories and instructions apply to future classifications.
Qwen still generates free-form tags when categories are supplied. Unknown categories
become null. Tagging uses a schema-constrained JSON response.

Originals are never moved, renamed, or deleted. Removing a folder deletes only its
index entries. Changed files return to the queue; files removed from a successfully
scanned folder disappear from the index. An unavailable folder retains its entries
and reports an error; disable it or restore access before running classification.
Overlapping roots are rejected to avoid duplicate indexing. Symlinks are not followed.

Pause finishes the current image before stopping. Pending work survives restarts.
Failed images remain visible with their errors and can be retried. Three consecutive
inference failures stop the batch. Closing the app stops its native model process.
Only one app instance is allowed.

Supported input: JPEG, PNG, WebP, GIF, BMP, TIFF. Animated formats use a still frame.
Images over 100 MB or decoder safety limits produce an error. RAW and HEIC are not
currently supported. EXIF orientation is respected. Preview thumbnails are cached.

## Model and data

The app uses [Qwen3-VL-2B-Instruct](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF),
Q8_0 text weights and the F16 vision projector. This is an 8-bit conversion of the
previously tested Qwen model; it is not the original Transformers/BF16 runtime.
The model revision and checksums are pinned in `src-tauri/src/inference.rs`.
The native runtime is llama.cpp `b11384`, pinned in `scripts/prepare-runtime.mjs`.

Inference and prompt processing use **8 CPU threads**, GPU offload is disabled,
and images are processed one at a time. The model stays loaded between batches.
The local server binds to a random loopback port with a per-run API key; the web UI
has no network model access. Only initial model/runtime downloads use the internet.
Do not interpret generated tags as verified facts; edit questionable details.

Tauri's per-user application data directory stores:

- `index.sqlite3`: folders, image metadata, tags, captions, categories, settings, FTS5.
- `models/`: downloaded GGUF weights and verification markers.
- `thumbnails/`: cached JPEG previews.
- `llama-server.log`: native inference diagnostics.

Typical Linux path: `~/.local/share/com.domi.imageshelf/`.
Typical Windows path: `%APPDATA%\com.domi.imageshelf\`.
The SQLite index uses WAL and foreign-key cascades. Search is paginated at 48 images;
the UI never loads a whole large library into memory. Thumbnails are decoded serially
to bound memory usage.

## Build installers

```sh
pnpm prepare:runtime
pnpm tauri build
```

Artifacts are in `src-tauri/target/release/bundle/`. Build Windows installers on
Windows and Linux packages on Linux. `.github/workflows/build.yml` builds both and
uploads installers as workflow artifacts. Windows artifacts are unsigned; code signing
is not configured. Model weights download on first use and are not in the installer.

## Validation

```sh
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features desktop -- -D warnings
pnpm exec playwright install chromium
pnpm exec playwright test
```

The Rust tests exercise real SQLite indexing, prefix search, tag updates, pagination,
folder removal, changed/missing files, overlapping roots, and background/manual edit
races. Browser tests exercise the actual React UI with a mocked Tauri bridge and the
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
- Eight Rust database tests and three browser interaction tests passed; TypeScript build
  and Rust clippy passed.
- The extracted Debian app ran in native WebKit through WebDriver. Real Qwen inference
  with configured categories reached SQLite, tag search returned the indexed results,
  and pause retained pending images. See [native validation](results/desktop-validation.json)
  and [native screenshot](results/desktop-native.png).
- Native window closure now terminates its model process. Linux also ties the model
  to the parent's lifetime, and Windows uses a kill-on-close job object. The Windows
  process-management module cross-compiles; the complete Windows app and installer
  still require the Windows CI job and have not been run on this Linux machine.
