use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_SNIPPET_BYTES: u64 = 1_048_576;
const PROBE_BYTES: usize = 4096;

#[derive(Serialize)]
pub struct SnippetInfo {
    pub filename: String,
    pub path: String,
    pub preview: String,
    pub modified_ms: u128,
}

fn snippets_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    Ok(home.join(".gutter").join("snippets"))
}

fn validate_filename(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Filename cannot be empty".into());
    }
    if name.starts_with('.') {
        return Err("Filename cannot start with '.'".into());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("Filename cannot contain path separators".into());
    }
    if name.contains("..") {
        return Err("Filename cannot contain '..'".into());
    }
    if name.len() > 255 {
        return Err("Filename too long".into());
    }
    Ok(())
}

fn validate_inside_snippets(path: &Path) -> Result<(), String> {
    let dir = snippets_dir()?;
    let canon = fs::canonicalize(path).map_err(|e| e.to_string())?;
    let dir_canon = fs::canonicalize(&dir).map_err(|e| e.to_string())?;
    if !canon.starts_with(&dir_canon) {
        return Err("Path is outside snippets directory".into());
    }
    Ok(())
}

fn is_likely_text(bytes: &[u8]) -> bool {
    let probe_len = bytes.len().min(PROBE_BYTES);
    let probe = &bytes[..probe_len];
    !probe.contains(&0u8)
}

fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{FEFF}').unwrap_or(s)
}

fn extract_preview(s: &str) -> String {
    let stripped = strip_bom(s);
    let first_line = stripped
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("");
    let truncated: String = first_line.chars().take(120).collect();
    if first_line.chars().count() > 120 {
        format!("{}…", truncated)
    } else {
        truncated
    }
}

#[tauri::command]
pub fn ensure_snippets_dir() -> Result<String, String> {
    let dir = snippets_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_snippets() -> Result<Vec<SnippetInfo>, String> {
    let dir = snippets_dir()?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }

        // fs::metadata follows symlinks; we want the target's metadata.
        let meta = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        if meta.len() > MAX_SNIPPET_BYTES {
            continue;
        }

        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if !is_likely_text(&bytes) {
            continue;
        }

        let content = String::from_utf8_lossy(&bytes);
        let preview = extract_preview(&content);
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);

        out.push(SnippetInfo {
            filename: name,
            path: path.to_string_lossy().to_string(),
            preview,
            modified_ms,
        });
    }
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(out)
}

#[tauri::command]
pub fn read_snippet(path: String) -> Result<String, String> {
    // Ensure directory exists so canonicalize() can resolve it.
    fs::create_dir_all(snippets_dir()?).map_err(|e| e.to_string())?;
    let p = PathBuf::from(&path);
    validate_inside_snippets(&p)?;
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    Ok(strip_bom(&String::from_utf8_lossy(&bytes)).to_string())
}

#[tauri::command]
pub fn save_snippet(filename: String, content: String) -> Result<String, String> {
    validate_filename(&filename)?;
    let dir = snippets_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&filename);
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_snippet(path: String) -> Result<(), String> {
    fs::create_dir_all(snippets_dir()?).map_err(|e| e.to_string())?;
    let p = PathBuf::from(&path);
    validate_inside_snippets(&p)?;
    fs::remove_file(&p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_snippet(old_path: String, new_filename: String) -> Result<String, String> {
    validate_filename(&new_filename)?;
    fs::create_dir_all(snippets_dir()?).map_err(|e| e.to_string())?;
    let old = PathBuf::from(&old_path);
    validate_inside_snippets(&old)?;
    let dir = snippets_dir()?;
    let new_path = dir.join(&new_filename);
    fs::rename(&old, &new_path).map_err(|e| e.to_string())?;
    Ok(new_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_traversal() {
        assert!(validate_filename("../evil").is_err());
        assert!(validate_filename("a/b").is_err());
        assert!(validate_filename("a\\b").is_err());
        assert!(validate_filename(".hidden").is_err());
        assert!(validate_filename("").is_err());
        assert!(validate_filename("ok.md").is_ok());
        assert!(validate_filename("my-prompt.txt").is_ok());
    }

    #[test]
    fn binary_detection() {
        assert!(is_likely_text(b"hello world"));
        assert!(is_likely_text(b""));
        assert!(!is_likely_text(&[0xDE, 0xAD, 0x00, 0xBE]));
    }

    #[test]
    fn bom_stripping() {
        assert_eq!(strip_bom("\u{FEFF}hello"), "hello");
        assert_eq!(strip_bom("hello"), "hello");
    }

    #[test]
    fn preview_extraction() {
        assert_eq!(extract_preview(""), "");
        assert_eq!(extract_preview("\n\n# Hello\nbody"), "# Hello");
        let long = "x".repeat(200);
        let preview = extract_preview(&long);
        assert_eq!(preview.chars().count(), 121); // 120 + ellipsis
    }
}
