//! Phase-3 stub / first-pass music cache for Tauri.
//! Electron still owns the production cache path; this returns an empty
//! snapshot and basic folder helpers so the PlatformAdapter boundary works.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MusicCacheSettings {
    pub enabled: bool,
    pub max_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MusicCacheSnapshot {
    pub automatic_bytes: u64,
    pub collections: Vec<serde_json::Value>,
    pub entries: Vec<serde_json::Value>,
    pub error: Option<String>,
    pub saved_bytes: u64,
    pub settings: MusicCacheSettings,
}

fn cache_root() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or_else(|| "No data directory".to_string())?;
    let path = base.join("feishin").join("music-cache");
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
pub fn music_cache_list() -> Result<MusicCacheSnapshot, String> {
    Ok(MusicCacheSnapshot {
        settings: MusicCacheSettings {
            enabled: true,
            max_bytes: 10 * 1024 * 1024 * 1024,
        },
        error: Some("Tauri music cache is a Phase-3 stub; downloads not implemented yet".into()),
        ..Default::default()
    })
}

#[tauri::command]
pub fn music_cache_configure(_settings: MusicCacheSettings) -> Result<(), String> {
    let _ = cache_root()?;
    Ok(())
}

#[tauri::command]
pub fn music_cache_lookup(
    _descriptor: Option<serde_json::Value>,
    _key: Option<String>,
) -> Result<Option<String>, String> {
    Ok(None)
}

#[tauri::command]
pub fn music_cache_open_folder() -> Result<String, String> {
    let path = cache_root()?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn music_cache_clear() -> Result<(), String> {
    Ok(())
}
