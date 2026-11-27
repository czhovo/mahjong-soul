# Third-Party Components and Assets

- AutoHotkey 2.0.30 is downloaded and SHA-256 verified from its official GitHub Release during `setup.ps1` and is not redistributed in this repository.
- Python dependencies are installed via `pip` under their respective package licenses.
- Minimal button, digit, glyph, and tile templates under `static-assets/extracted` and `templates` remain the property of their respective copyright holders; no full game asset bundles (`.majset`) or personal screenshots are distributed.
- `patch-tiles.py` generates coded tile skins locally from the user's own game installation; backups and generated bundles stay in `private/`.
- Tingfeng v111 and Tingyuan v21 are distributed as prebuilt Windows x64 binaries via GitHub Releases without engine source code. Checksums are pinned in `release-manifest.json` and `engine-pins.json`.
- WGC capture DLL uses LLVM-MinGW static runtime libraries (licenses in `licenses/llvm-mingw`); x64 engines are built with GCC under the GCC Runtime Library Exception (licenses in `licenses/gcc`).
- `nlohmann/json` MIT license is included in `licenses/nlohmann/LICENSE.MIT`.
