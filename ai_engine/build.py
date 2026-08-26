"""Build script to package the AI engine as a standalone executable using PyInstaller."""
import os
import platform
import subprocess
import sys


def get_target_triple() -> str:
    """Get the platform target triple for Tauri sidecar naming."""
    machine = platform.machine().lower()
    system = platform.system().lower()

    arch_map = {
        "x86_64": "x86_64",
        "amd64": "x86_64",
        "aarch64": "aarch64",
        "arm64": "aarch64",
    }
    arch = arch_map.get(machine, machine)

    if system == "windows":
        return f"{arch}-pc-windows-msvc"
    elif system == "darwin":
        return f"{arch}-apple-darwin"
    elif system == "linux":
        return f"{arch}-unknown-linux-gnu"
    return f"{arch}-unknown-{system}"


def build():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    main_path = os.path.join(script_dir, "main.py")
    dist_dir = os.path.join(script_dir, "..", "src-tauri", "binaries")
    os.makedirs(dist_dir, exist_ok=True)

    target_triple = get_target_triple()
    output_name = f"localmind-ai-{target_triple}"

    collect_packages = [
        "uvicorn",
        "fastapi",
        "lancedb",
        "pyarrow",
        "tokenizers",
        "onnxruntime",
        # onnx (and its protobuf dependency) is what onnxruntime.quantization
        # needs for the one-off int8 conversion. Without it the packaged build
        # silently falls back to the 449MB fp32 weights.
        "onnx",
        "rapidfuzz",
        "watchdog",
        "openpyxl",
        "docx",
        "pptx",
        "pymupdf",
        "fitz",
        "pypdf",
        "pydantic",
    ]

    copy_metadata = [
        "tqdm",
        "regex",
        "requests",
        "packaging",
        "filelock",
        "numpy",
        "huggingface-hub",
        "safetensors",
        "tokenizers",
        "onnxruntime",
        "onnx",
        "fastapi",
        "uvicorn",
        "lancedb",
        "pyarrow",
    ]

    exclude_modules = [
        "torch",
        "torchvision",
        "torchaudio",
        "scipy",
        "matplotlib",
        "pandas",
        "IPython",
        "jupyter",
        "transformers",
        "sentence_transformers",
        "tensorboard",
        "caffe2",
        "tkinter",
        "test",
        "unittest",
    ]

    hidden_imports = [
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        "uvicorn.lifespan.off",
        "onnxruntime.quantization",
        "winsearch",
        "app_launcher",
        "chunker",
        "db",
        "embedder",
        "evaluator",
        "extractor",
        "file_search",
        "indexer",
        "query_parser",
        "search",
        "settings",
        "watcher",
    ]

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onefile",
        "--name", output_name,
        "--distpath", dist_dir,
        "--workpath", os.path.join(script_dir, "build"),
        "--specpath", os.path.join(script_dir, "build"),
        "--clean",
        "--noconfirm",
    ]

    for pkg in collect_packages:
        cmd.extend(["--collect-all", pkg])

    for meta in copy_metadata:
        cmd.extend(["--copy-metadata", meta])

    for exc in exclude_modules:
        cmd.extend(["--exclude-module", exc])

    for hi in hidden_imports:
        cmd.extend(["--hidden-import", hi])

    cmd.append(main_path)

    print(f"Building sidecar: {output_name}")
    print(f"Command: {' '.join(cmd)}")
    subprocess.run(cmd, check=True)

    exe_suffix = ".exe" if platform.system().lower() == "windows" else ""
    built_path = os.path.join(dist_dir, f"{output_name}{exe_suffix}")
    print(f"Build complete: {built_path}")


if __name__ == "__main__":
    build()
