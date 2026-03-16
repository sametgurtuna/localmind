<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="120" alt="LocalMind icon" />
</p>

<h1 align="center">LocalMind</h1>

<p align="center">
  <strong>AI-powered desktop file search — fully offline, fully yours.</strong>
</p>

<p align="center">
  <a href="#quick-start"><img src="https://img.shields.io/badge/-Get%20Started-000?style=for-the-badge" alt="Get Started" /></a>&nbsp;
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/tauri-v2-orange?style=flat-square" alt="Tauri v2" />
</p>

---

LocalMind indexes your local files and lets you search them with natural language queries. Everything — embeddings, vector storage, retrieval — runs on your machine. No cloud APIs, no telemetry, no data leaves your computer.

Think of it as **Spotlight meets AI**, but private by design.

## Highlights

| | Feature | Details |
|---|---|---|
| :mag: | **Semantic Search** | Ask in plain English — *"jwt auth implementation"*, *"that Docker PDF I downloaded"*, *"React login component"* |
| :file_folder: | **File Name Search** | Blazing-fast fuzzy matching across your entire file tree |
| :rocket: | **App Launcher** | Quickly find and launch installed applications |
| :link: | **Similar Files** | Discover related files through vector similarity |
| :eye: | **Inline Preview** | Syntax-highlighted file preview with line-level context |
| :keyboard: | **Global Shortcut** | `Ctrl+Space` summons a floating search bar from anywhere |
| :crescent_moon: | **Dark & Light Themes** | Seamless theme switching |
| :globe_with_meridians: | **Multi-language UI** | English & Turkish built-in (i18n-ready for more) |
| :zap: | **Incremental Indexing** | Only processes new or changed files |
| :eyes: | **Real-time Watcher** | Detects file create / modify / delete events instantly |
| :gear: | **Highly Configurable** | Folders, file size limits, exclude patterns, shortcuts, autostart |

## Supported File Types

| Category | Extensions |
|---|---|
| **Text & Config** | `.txt` `.md` `.json` `.csv` `.xml` `.yaml` `.yml` `.toml` `.log` `.env` `.sql` |
| **Source Code** | `.js` `.ts` `.tsx` `.jsx` `.py` `.rs` `.go` `.java` `.c` `.cpp` `.h` `.rb` `.sh` `.bat` `.html` `.css` `.r` |
| **Documents** | `.pdf` `.docx` `.xlsx` `.pptx` `.ipynb` |
| **Images** *(OCR, optional)* | `.png` `.jpg` `.jpeg` `.bmp` `.tiff` |

## Architecture

```
┌──────────────────────────┐          ┌───────────────────────┐
│    React + TypeScript     │   IPC    │    Tauri v2 (Rust)    │
│    Tailwind CSS + Vite    │◄────────►│                       │
│                           │          │  • Window management  │
│  • SearchBar              │          │  • Global shortcut    │
│  • ResultsList            │          │  • System tray        │
│  • FilePreview (hljs)     │          │  • Sidecar lifecycle  │
│  • SettingsPanel          │          │  • Native file ops    │
│  • i18n (EN / TR)         │          │  • Autostart          │
└──────────────────────────┘          └──────────┬────────────┘
                                                 │
                                      HTTP · 127.0.0.1:<port>
                                                 │
                                      ┌──────────┴────────────┐
                                      │   Python AI Engine     │
                                      │   (FastAPI sidecar)    │
                                      │                        │
                                      │  • sentence-transformers│
                                      │    (all-MiniLM-L6-v2)  │
                                      │  • LanceDB             │
                                      │  • watchdog            │
                                      │  • Text extractors     │
                                      └────────────────────────┘
```

### How It Works

**Search flow**

1. User types a query → frontend sends `POST /search` to the sidecar
2. Sidecar encodes the query with `all-MiniLM-L6-v2`
3. LanceDB returns the top-*k* nearest chunks
4. Results (file path, snippet, relevance score, line range) appear in the UI
5. Click to open the file, jump to a specific line, or preview inline

**Indexing flow**

1. Recursively scans configured folders
2. Extracts text (pdfplumber, python-docx, openpyxl, python-pptx, plain-text readers)
3. Splits text into overlapping ~500-char chunks with line tracking
4. Generates embeddings via sentence-transformers
5. Stores vectors in LanceDB (local, file-based — no server needed)
6. `watchdog` monitors for real-time file system events

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | [Tauri v2](https://v2.tauri.app/) · Rust |
| Frontend | React 19 · TypeScript · Vite · Tailwind CSS v4 |
| AI engine | FastAPI · Uvicorn · Python |
| Embeddings | [sentence-transformers](https://www.sbert.net/) · `all-MiniLM-L6-v2` |
| Vector database | [LanceDB](https://lancedb.com/) |
| Text extraction | pdfplumber · python-docx · openpyxl · python-pptx |
| File watching | watchdog |
| Syntax highlighting | highlight.js |

## Prerequisites

| Dependency | Minimum version | Install |
|---|---|---|
| Node.js | 18+ | [nodejs.org](https://nodejs.org/) |
| Rust | 1.77.2+ | [rustup.rs](https://rustup.rs/) |
| Python | 3.10+ | [python.org](https://www.python.org/) |

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

> **First run:** The `all-MiniLM-L6-v2` model (~80 MB) is downloaded automatically and cached for subsequent launches.

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

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Space` | Show / hide LocalMind |
| `Tab` | Cycle search tabs (Files → Semantic → Apps) |
| `Enter` | Open selected result |
| `Ctrl+Enter` | Open containing folder |
| `Ctrl+P` | Toggle inline file preview |
| `Ctrl+Shift+C` | Copy file path of selected result |
| `Ctrl+1`–`9` | Open Nth result directly |
| `Esc` | Clear search / dismiss |

## Project Structure

```
localmind/
├── src/                        # React frontend
│   ├── components/             #   UI components (SearchBar, ResultsList, FilePreview, …)
│   ├── hooks/                  #   Custom hooks (useSearch, useSidecar, useTheme, …)
│   ├── i18n/                   #   Translation files (en.json, tr.json)
│   └── lib/                    #   Utilities (api, config)
├── src-tauri/                  # Tauri backend (Rust)
│   ├── src/                    #   Rust modules (commands, sidecar, tray, window)
│   └── capabilities/           #   Permission declarations
├── ai_engine/                  # Python AI sidecar
│   ├── main.py                 #   FastAPI server & startup
│   ├── embedder.py             #   Embedding model management
│   ├── indexer.py              #   File scanning & indexing
│   ├── search.py               #   Semantic search logic
│   ├── db.py                   #   LanceDB operations
│   ├── extractor.py            #   Text extraction (PDF, DOCX, XLSX, PPTX, …)
│   ├── chunker.py              #   Text chunking with line tracking
│   ├── watcher.py              #   Real-time file system watcher
│   ├── file_search.py          #   Fuzzy file name search
│   ├── app_launcher.py         #   Installed app discovery
│   ├── query_parser.py         #   Query preprocessing
│   └── build.py                #   PyInstaller build script
├── .github/workflows/ci.yml   # CI pipeline
├── package.json
├── LICENSE
└── README.md
```

## Privacy

LocalMind is designed to be local-only by default:

- **Zero cloud dependency** — no API keys, no external endpoints
- **Zero telemetry** — no analytics, no tracking, no crash reporters
- **Zero data upload** — your files and embeddings never leave `~/.localmind/`
- **Localhost-only IPC** — sidecar communicates exclusively over `127.0.0.1`

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change, then submit a pull request.

## License

[MIT](LICENSE)
