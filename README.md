# Image Shelf

A local image library for Windows and Linux. Add multiple folders, let Qwen generate
searchable tags and captions, and find images through a SQLite full-text index.

The application is React + TypeScript + Tailwind + shadcn-style Radix components,
inside Tauri. Rust handles SQLite, folder scanning, thumbnails, model downloads, and
llama.cpp. **No Python is used to build or run the application.** Earlier classifier
research files remain in this repository; see [EXPERIMENT.md](EXPERIMENT.md).

## Run from source

Install Node 22+, pnpm, Rust 1.92+ (stable), and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).
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

1. Add folders using the plus button. Subfolders are included automatically. Enabled
   folders are rescanned at startup and every hour while the app is open, even with
   automatic classification turned off. A scheduled scan waits for any current task
   to finish; you can also use **Scan folders** at any time.
2. Download the model once with **Download model**. It downloads 2.65 GB from Qwen's
   official repository, checks SHA-256, and resumes interrupted downloads.
3. Choose **Classify pending**, or enable **Classify automatically**. Automatic mode
   checks the indexed pending queue every 30 seconds while the app is open.
4. Search tags, captions, filenames, and categories. Words use prefix matching and
   combine with AND. Click a tag to insert it into the search field as `#tag`.
   Type `#` followed by a name for autocomplete. Names with spaces use
   `#"green trees"`; selecting a suggestion adds the quotes for you. Hashtags match
   exact tags and combine with each other and ordinary search words. Clear the field
   to remove tag filters. Filter by folder or status.
5. Open an image in a nearly full-window viewer. The image fits the available space
   without cropping; **Hide details** gives it the full width. Edit tags with
   autocomplete and click a tag button to remove it.
   Pale blue tags come from manual edits or folder names; hover for the exact source.
   AI tags stay neutral. Edits update search immediately.
6. Use the settings button beside **Tags** to manage the shared tag catalog. Search,
   rename or merge tags, see image-use counts, filter unused tags, and purge orphans.
   Only unused tags can be deleted; purge never removes an image's assigned tags.

Resize thumbnails with **Ctrl+scroll** over the image grid or **Ctrl+plus/minus**.
The footer has matching buttons and shows the width. Sizes range from 160 to 640
pixels and are remembered on this device. Ordinary scrolling and text size stay unchanged.

Each nested directory below a configured folder contributes its name as a tag.
For example, with a root of `Photos`, `Photos/Trips/Alps/image.jpg` gets `trips`
and `alps`. The configured root and its parents do not become tags. Folder and
manual tags survive AI classification and file-content changes. Removing a folder
tag from an image suppresses it on later scans, even after orphan cleanup.
Renaming a tag updates all its images as a user edit; naming an existing tag merges
them. Files and folders on disk are not renamed.

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
Tags are unique entities in `tags`, connected to images through `image_tags`.
Each assignment records its source: AI, user, or folder. Repeated names are
trimmed, lowercased, and deduplicated; use counts count distinct images. A tag can
have several sources on one image. `images.tags_text` is a derived FTS cache,
maintained by relationship triggers, not the authoritative tag store.

Database changes use [Refinery](https://github.com/rust-db/refinery), with numbered SQL
files embedded from `src-tauri/migrations/`. Applied versions, names, checksums, and
timestamps live in `refinery_schema_history`. Pending migrations run together in
one transaction. Failed upgrades roll back; changed migration checksums, missing
migrations, and databases from newer app versions stop startup without resetting data.

The two pre-Refinery prototype schemas are discarded once, including folder settings
and indexed classifications. Re-add folders and classify again. Image files and model
weights are untouched. There is no string-tag conversion, legacy source, or automatic
backup of these disposable prototype indexes. Unknown schemas are never reset.

To change the database, add the next `V<number>__description.sql` migration and run
`cargo test --manifest-path src-tauri/Cargo.toml --lib`. Never edit, remove, or renumber
an applied migration. See [migration conventions](src-tauri/migrations/README.md).

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
- Nineteen Rust database/worker tests, nine browser interaction tests, and a search parser test passed; TypeScript build
  and Rust clippy passed.
- The extracted Debian app ran in native WebKit through WebDriver. Real Qwen inference
  with configured categories reached SQLite, tag search returned the indexed results,
  and pause retained pending images. See [native validation](results/desktop-validation.json)
  and [native screenshot](results/desktop-native.png).
- Native window closure now terminates its model process. Linux also ties the model
  to the parent's lifetime, and Windows uses a kill-on-close job object. The Windows
  process-management module cross-compiles; the complete Windows app and installer
  still require the Windows CI job and have not been run on this Linux machine.
