# Mahjong Soul Controller (Tingfeng v12)

Automated visual recognition and input controller for the Windows Steam client of Mahjong Soul (`recognize v7`, `execute v3`). It observes visible table state, maintains public event and hand ledgers incrementally, filters legal actions according to game rules, queries the decision engine, and executes and verifies actions. Supports both 4-player (Yonma) and 3-player (Sanma) tables, two-stage call/discard, first-open call reason reporting, optional call-wait inference, automatic win after Riichi, automatic Kita in Sanma, and post-match auto-rematch flows.

4-player matches use **Tingfeng v103** and 3-player matches use **Tingyuan v13**, each with 5.5s / 3.5s / 2.2s time budgets. **This repository contains no engine source code and no engine binaries.** Prebuilt Windows x64 engine binaries are distributed via [GitHub Releases](https://github.com/czhovo/mahjong-soul/releases) and are downloaded and SHA-256 verified automatically by `setup.ps1`. `wgc-capture.cpp` provides the Windows Graphics Capture implementation for the controller.

This public release excludes startup fixture checks, engine warmup probes, click self-tests, personal screenshots, and hardcoded nickname templates. It only retains the in-memory `--name` glyph matching path (always enabled by default), does not recognize avatars, does not archive win or match-result screenshots, and does not print personal win, placement, or PT settlement details. Only minimal UI button, digit, glyph, and tile templates required for recognition are included.

## Installation and Usage

Requirements: Windows 10 1903+, Node.js 22+, Windows x64 Python 3.12, and the Steam version of Mahjong Soul. Run the setup script from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

For offline or manual engine installation, download `mahjong-soul-engines-v103-v13-windows-x64.zip` from [Releases](https://github.com/czhovo/mahjong-soul/releases) and pass `-EngineZip`:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -EngineZip .\mahjong-soul-engines-v103-v13-windows-x64.zip
```

Generate and install the coded tile skin from your local game files, then start the controller:

```powershell
node resident.mjs -g
```

### CLI Options

- `-b` / `-s` / `-g` / `-t`: Bronze / Silver / Gold / Jade room (mutually exclusive).
- `-3` / `-4`: 3-player / 4-player mode (defaults to 4-player).
- `-f`: Skip lobby room-entry clicks and wait directly for an active match (required when no room flag is specified).
- `-l`: Use the reduced search budget profile (3.5s, stepping down to 2.2s on low reserve time).
- `-d`: Archive all captured frames locally (disabled by default).
- `--naku`: Enable opponent call-wait inference (disabled by default).
- `--lag`: Enable stall/lag recovery (disabled by default).
- `--name`: Accepted for CLI compatibility; in-memory nickname matching is always enabled in this public release.

## Capture and Execution

Frames are captured via Windows Graphics Capture (WGC) bound to the game window handle (HWND), unaffected by window movement or occlusion, and passed as raw pixels over shared memory. `execute v3` delivers client-coordinate clicks through a persistent AutoHotkey v2 stdin/stdout pipe: UI buttons, toggles, and retries briefly acquire focus and restore the previous foreground window and cursor position, while ordinary discards do not require foreground activation.

## References

- [Setup & Configuration](docs/%E9%85%8D%E7%BD%AE%E8%AF%B4%E6%98%8E.md)
- [Action Filter Rules](docs/%E5%8A%A8%E4%BD%9C%E8%BF%87%E6%BB%A4%E8%A7%84%E5%88%99.md)
- [Engine Protocol](docs/%E5%86%B3%E7%AD%96%E4%BE%A7%E6%8E%A5%E5%8F%A3.md)
- [Validation & Privacy Scope](VALIDATION.md)
- [Third-Party Components](THIRD_PARTY.md)
