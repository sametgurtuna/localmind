<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="120" alt="LocalMind icon" />
</p>

<h1 align="center">LocalMind</h1>

<p align="center">
  <strong>AI powered desktop search for Windows: instant files, semantic content search, apps, math, and unit conversion, all fully offline.</strong>
</p>

<p align="center">
  <a href="#quick-start"><img src="https://img.shields.io/badge/-Get%20Started-000?style=for-the-badge" alt="Get Started" /></a>&nbsp;
  <img src="https://img.shields.io/badge/platform-Windows-blue?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/tauri-v2-orange?style=flat-square" alt="Tauri v2" />
  <img src="https://img.shields.io/badge/rust-native%20MFT%20engine-CE422B?style=flat-square" alt="Rust" />
  <img src="https://img.shields.io/badge/python-AI%20sidecar-3776AB?style=flat-square" alt="Python" />
</p>

LocalMind is a Spotlight style launcher for Windows that understands both **what your files are named** and **what is inside them**. Press a hotkey from anywhere, start typing, and instantly get files, folders, installed apps, semantic matches inside documents and code, quick calculations, currency conversions, and system actions, all ranked together in one list.

Everything runs on your machine. There is no cloud API, no account, and no telemetry. The embedding model, the vector database, and the native file index all live locally, so your files and your queries never leave your computer.

## Table of Contents

- [Why LocalMind](#why-localmind)
- [Feature Tour](#feature-tour)
- [Supported File Types](#supported-file-types)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Production Build](#production-build)
- [Configuration](#configuration)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Project Structure](#project-structure)
- [Privacy](#privacy)
- [Contributing](#contributing)
- [License](#license)

## Why LocalMind

Windows Search is fast at file names but blind to file content. Spotlight style AI tools that understand content usually mean sending your data to a cloud API. LocalMind closes that gap with a hybrid engine:

- A **native Rust MFT scanner** reads the NTFS Master File Table directly, so searching file and folder names across every drive on your PC returns results in well under a second, even across a million files.
- A **local AI sidecar** chunks and embeds the text inside your documents and code with `sentence-transformers`, so you can search by meaning, not just by file name.
- A **unified results list** blends files, apps, semantic matches, calculations, and conversions into one ranked, keyboard driven list, so you never have to think about which "mode" to use.

## Feature Tour

### Instant native file search

<table>
<tr>
<td width="45%">

The Rust backend queries the NTFS Master File Table (`FSCTL_ENUM_USN_DATA`) directly instead of walking the file system, and falls back to the Windows Search Indexer (`Search.CollatorDSO`) when running without administrator rights. Combined with an in-memory, parallelized (`rayon`) search index, this returns sub-millisecond results across every indexed drive.

</td>
<td>

```
┌─────────────────────────────┐
│ 🔍  jwt auth                │
├─────────────────────────────┤
│ 📄 auth.service.ts           │
│    src/services · 2 KB       │
│ 📄 jwt-helper.py              │
│    ai_engine · 4 KB           │
│ 🧠 "JWT auth implementation"  │
│    api/routes.py · line 118   │
└─────────────────────────────┘
```

</td>
</tr>
</table>

### Semantic content search

Ask questions the way you would ask a person: *"that Docker PDF I downloaded"*, *"the React login component"*, *"jwt auth implementation"*. The AI engine encodes your query with `all-MiniLM-L6-v2`, compares it against every chunk stored in LanceDB, and returns the closest matches with the exact line range highlighted, so you land precisely where the relevant text is.

### App launcher with real icons

A native Windows scanner discovers Start Menu shortcuts (`.lnk`), UWP apps, and system settings panels, then extracts full resolution 32 bit icons directly from the executables, so results look and feel native rather than generic.

### Quick actions on every result

Every result opens an action menu without leaving the keyboard: open, open containing folder, copy path, copy as code snippet, open in terminal, run as administrator, preview, favorite, or delete.

### Split preview panel

Select a result and preview it inline: syntax highlighted code and text, file metadata (size, modified date, path), and one click actions, all without switching windows.

### Built in calculator and unit tools

Type `20% of 500`, `0xff to dec`, or a currency amount like `120 usd` and get an instant, copyable answer, no separate calculator app required. Quick system actions such as *lock*, *sleep*, *restart*, *shutdown*, *empty recycle bin*, and *my ip* are one keystroke away.

### Grouped, ranked results

Files, semantic matches, apps, calculations, conversions, and web search shortcuts are grouped and ranked into a single scannable list, so the most relevant answer is always near the top regardless of which subsystem produced it.

### Global hotkey, everywhere

`Ctrl+Space` summons a floating, always on top search bar from any application, and disappears the moment you are done.

### Real time index that stays current

A file system watcher (`watchdog`) detects created, modified, and deleted files and updates the semantic index incrementally, so you never have to manually re-index.

### Configurable and private by default

Choose which folders are indexed, exclude patterns, maximum file size, OCR for scanned images, embedding quantization for faster indexing, autostart, theme, and language, all from the in-app settings panel.

## Supported File Types

| Category | Extensions |
|---|---|
| **Text & Config** | `.txt` `.md` `.json` `.csv` `.xml` `.yaml` `.yml` `.toml` `.log` `.env` `.sql` |
| **Source Code** | `.js` `.ts` `.tsx` `.jsx` `.py` `.rs` `.go` `.java` `.c` `.cpp` `.h` `.rb` `.sh` `.bat` `.html` `.css` `.r` |
| **Documents** | `.pdf` `.docx` `.xlsx` `.pptx` `.ipynb` |
| **Images** *(OCR, optional)* | `.png` `.jpg` `.jpeg` `.bmp` `.tiff` |

## Architecture

```
┌────────────────────────────┐        ┌──────────────────────────────┐
│   React + TypeScript        │  IPC   │        Tauri v2 (Rust)        │
│   Tailwind CSS + Vite        │◄──────►│                                │
│                              │        │  • Window management          │
│  • SearchBar / ActionMenu    │        │  • Global shortcut             │
│  • ResultsList / Grouping    │        │  • System tray                 │
│  • SplitPreviewPanel         │        │  • Sidecar lifecycle           │
│  • SettingsPanel             │        │  • Native MFT / NTFS scanner   │
│  • EngineStatus               │        │  • App & icon scanner          │
│  • i18n (EN / TR)             │        │  • Self elevation              │
└────────────────────────────┘        └───────────────┬────────────────┘
                                                        │
                                            HTTP · 127.0.0.1:<port>
                                                        │
                                        ┌───────────────┴────────────────┐
                                        │        Python AI Engine         │
                                        │        (FastAPI sidecar)        │
                                        │                                  │
                                        │  • sentence-transformers         │
                                        │    (all-MiniLM-L6-v2)            │
                                        │  • LanceDB vector store          │
                                        │  • watchdog file watcher         │
                                        │  • Text extractors                │
                                        │  • Windows Search fallback        │
                                        │  • Evaluator (math / conversions) │
                                        └──────────────────────────────────┘
```

### How It Works

**Instant search flow (Rust)**

1. User types a query, the frontend sends it to the Tauri backend
2. The in-memory MFT index (built from the NTFS Master File Table, or the Windows Search Indexer as a fallback) is queried in parallel across CPU cores
3. File and app matches return in well under a second, even across drives with millions of entries

**Semantic search flow (Python sidecar)**

1. In parallel, the frontend sends `POST /search` to the local sidecar
2. The sidecar encodes the query with `all-MiniLM-L6-v2`
3. LanceDB returns the top-*k* nearest chunks
4. Results (file path, snippet, relevance score, line range) are merged into the UI

**Indexing flow**

1. Recursively scans configured folders
2. Extracts text (`pdfplumber`, `python-docx`, `openpyxl`, `python-pptx`, plain text readers, optional OCR)
3. Splits text into overlapping ~500 character chunks with line tracking
4. Generates embeddings via `sentence-transformers` (optionally int8 quantized for faster indexing)
5. Stores vectors in LanceDB, a local, file based database that needs no server
6. `watchdog` monitors the file system in real time and updates the index incrementally

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | [Tauri v2](https://v2.tauri.app/) · Rust |
| Frontend | React 19 · TypeScript · Vite · Tailwind CSS v4 |
| Native search engine | Rust · `rayon` (parallel search) · NTFS MFT / USN Journal · Windows Search fallback |
| AI engine | FastAPI · Uvicorn · Python |
| Embeddings | [sentence-transformers](https://www.sbert.net/) · `all-MiniLM-L6-v2` |
| Vector database | [LanceDB](https://lancedb.com/) |
| Text extraction | `pdfplumber` · `python-docx` · `openpyxl` · `python-pptx` |
| File watching | `watchdog` |
| Syntax highlighting | `highlight.js` |

## Prerequisites

| Dependency | Minimum version | Install |
|---|---|---|
| Node.js | 18+ | [nodejs.org](https://nodejs.org/) |
| Rust | 1.77.2+ | [rustup.rs](https://rustup.rs/) |
| Python | 3.10+ | [python.org](https://www.python.org/) |

> LocalMind's native search engine uses Windows specific APIs (NTFS MFT access, UWP app scanning, icon extraction), so it currently targets **Windows 10/11**.

## Quick Start

```bash
# Clone
git clone https://github.com/sametgurtuna/localmind.git
cd localmind

# Frontend dependencies
npm install

# Python dependencies
cd ai_engine
pip install -r requirements.txt
cd ..

# Launch in development mode
npm run tauri dev
```

> **First run:** The `all-MiniLM-L6-v2` model (~80 MB) is downloaded automatically and cached for subsequent launches. For full speed native file search, LocalMind can request administrator privileges to read the NTFS Master File Table directly; without elevation it falls back to the Windows Search Indexer automatically.

## Production Build

```bash
# 1. Package the Python sidecar as a standalone binary
cd ai_engine
pip install pyinstaller
python build.py          # outputs to src-tauri/binaries/
cd ..

# 2. Build the Tauri desktop installer
npm run tauri build       # outputs to src-tauri/target/release/bundle/
```

## Configuration

All settings are accessible from the in-app settings panel (gear icon) or the system tray menu.

| Setting | Default | Description |
|---|---|---|
| Global Shortcut | `Ctrl+Space` | Toggle the floating search window |
| Theme | Dark | Dark or Light |
| Language | English | English / Turkish |
| Autostart | Enabled | Launch with the operating system |
| Max File Size | 50 MB | Skip files exceeding this limit |
| Indexed Folders | Documents, Downloads, Desktop | Folders to scan recursively |
| Exclude Patterns | `node_modules`, `*.min.js`, `*.log`, `.git` | Glob patterns to ignore |
| OCR | Off | Extract text from scanned images (adds ~500 MB of models) |
| Embedding Quantization | Off | int8 dynamic quantization, roughly 2x faster indexing |

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Space` | Show / hide LocalMind |
| `Tab` | Cycle search tabs (Files → Semantic → Apps) |
| `Enter` | Open selected result |
| `Ctrl+Enter` | Open containing folder |
| `Ctrl+P` | Toggle inline file preview |
| `Ctrl+Shift+C` | Copy file path of selected result |
| `Ctrl+1`-`9` | Open Nth result directly |
| `Esc` | Clear search / dismiss |

## Project Structure

```
localmind/
├── src/                        # React frontend
│   ├── components/             #   UI (SearchBar, ResultsList, ActionMenu,
│   │                           #   SplitPreviewPanel, EngineStatus, SettingsPanel, …)
│   ├── hooks/                  #   Custom hooks (useSearch, useSidecar, useEngineSettings, …)
│   ├── i18n/                   #   Translation files (en.json, tr.json)
│   └── lib/                    #   Utilities (api, config, converter, grouping, webSearch)
├── src-tauri/                  # Tauri backend (Rust)
│   ├── src/                    #   commands, sidecar, tray, window, mft_index,
│   │                           #   ntfs, apps, elevation
│   └── capabilities/           #   Permission declarations
├── ai_engine/                  # Python AI sidecar
│   ├── main.py                 #   FastAPI server & startup
│   ├── embedder.py             #   Embedding model management
│   ├── indexer.py              #   File scanning & indexing
│   ├── search.py               #   Semantic search logic
│   ├── db.py                   #   LanceDB operations
│   ├── extractor.py            #   Text extraction (PDF, DOCX, XLSX, PPTX, …)
│   ├── chunker.py               #   Text chunking with line tracking
│   ├── watcher.py               #   Real-time file system watcher
│   ├── file_search.py           #   Fuzzy file name search
│   ├── winsearch.py             #   Windows Search Indexer fallback (ADODB)
│   ├── app_launcher.py          #   Installed app discovery
│   ├── evaluator.py             #   Math, unit, and quick action evaluator
│   ├── query_parser.py          #   Query preprocessing
│   ├── settings.py              #   Engine settings persisted outside the UI
│   └── build.py                 #   PyInstaller build script
├── .github/workflows/ci.yml   # CI pipeline
├── package.json
├── LICENSE
└── README.md
```

## Privacy

LocalMind is designed to be local only by default:

- **Zero cloud dependency**, no API keys, no external endpoints
- **Zero telemetry**, no analytics, no tracking, no crash reporters
- **Zero data upload**, your files and embeddings never leave `~/.localmind/`
- **Localhost only IPC**, the sidecar communicates exclusively over `127.0.0.1`
- **Native search stays native**, the NTFS MFT scanner and Windows Search fallback never send file metadata anywhere off device

## Contributing

Contributions are welcome. Please open an issue first to discuss what you would like to change, then submit a pull request.

## License

[MIT](LICENSE)
