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

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onefile",
        "--name", output_name,
        "--distpath", dist_dir,
        "--workpath", os.path.join(script_dir, "build"),
        "--specpath", os.path.join(script_dir, "build"),
        "--clean",
        "--noconfirm",
        main_path,
    ]

    print(f"Building sidecar: {output_name}")
    print(f"Command: {' '.join(cmd)}")
    subprocess.run(cmd, check=True)
    print(f"Build complete: {os.path.join(dist_dir, output_name)}")


if __name__ == "__main__":
    build()
