# ADR 0001: Tauri Mac-first slim desktop

## Status

Accepted on branch `feat/tauri-mac-slim` (migration in progress).

## Context

Personal Feishin fork wants a Mac-first desktop shell with a smaller product surface,
replacing Electron with Tauri 2 over time while keeping music playback, cache, lyrics,
Auto-DJ, Butterchurn, tag/cover editor, multi-server addresses, tray, EQ/transcoding,
and related KEEP features.

## Decision

1. Cut features via `src/shared/lib/product-features.ts` flags (UI/nav first; Electron still builds).
2. Introduce `PlatformAdapter` (`src/renderer/platform/platform-adapter.ts`) for music cache and future desktop APIs.
3. Scaffold Tauri 2 under `src-tauri/` sharing the existing Vite web renderer (`build:web` / `tauri:web:dev`).
4. Web audio player first on Tauri; MPV later. Windows packaging may stay stubbed.

## Consequences

- Cut features remain in the tree behind flags for easier rollback.
- Tauri music cache starts as a stub; Electron cache remains the production path until ported.
- Do not merge to `development` without explicit approval; never force-push `main`.

## Tooling notes

- Tauri 2.12 requires rustc >= 1.90.
- Linux builds need WebKitGTK/pkg-config; Mac is the primary target for this branch.
