# Feishin Tauri shell (Mac-first)

Phase 3 scaffold for replacing Electron with Tauri 2 while reusing the Vite web renderer.

## Requirements

- Rust toolchain **1.90+** (`rustup update`)
- On macOS: Xcode CLT
- On Linux (optional CI): `webkit2gtk-4.1`, `librsvg2`, `patchelf`, `pkg-config`, etc. (see Tauri docs)

## Commands (repo root)

```bash
bun install
bun run tauri:dev     # starts Vite web on :5173 + Tauri
bun run tauri:build   # packages using out/web from build:web
```

Music cache commands are stubbed (`src/music_cache.rs`). Electron remains the production desktop path until the port lands.

Windows targets are left for later (bundle config present, not validated).
