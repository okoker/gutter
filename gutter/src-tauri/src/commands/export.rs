use std::fs;

/// Strip dangerous HTML elements and event handler attributes from content.
/// Uses a simple state-machine approach to avoid adding a regex dependency.
fn sanitize_html(input: &str) -> String {
    let mut result = input.to_string();

    // Remove dangerous tags (case-insensitive). Script tags include content.
    let dangerous_pairs = &[("script", true), ("iframe", false), ("object", false),
                            ("embed", false), ("base", false), ("form", false)];

    for (tag, remove_content) in dangerous_pairs {
        loop {
            let lower = result.to_lowercase();
            let open_pattern = format!("<{}", tag);
            if let Some(start) = lower.find(&open_pattern) {
                if *remove_content {
                    let close_pattern = format!("</{}>", tag);
                    if let Some(end) = lower[start..].find(&close_pattern) {
                        result = format!("{}{}", &result[..start], &result[start + end + close_pattern.len()..]);
                        continue;
                    }
                }
                // Remove just the tag
                if let Some(end) = result[start..].find('>') {
                    result = format!("{}{}", &result[..start], &result[start + end + 1..]);
                    continue;
                }
            }
            break;
        }
    }

    // Remove event handler attributes (onclick, onerror, onload, etc.)
    loop {
        let lower = result.to_lowercase();
        let mut found = false;
        if let Some(pos) = lower.find(" on") {
            // Check we're inside a tag and it's an event handler (letter follows "on")
            let after = &lower[pos + 3..];
            if let Some(ch) = after.chars().next() {
                if ch.is_ascii_alphabetic() {
                    // Find the = and skip the attribute value
                    if let Some(eq) = result[pos..].find('=') {
                        let val_start = pos + eq + 1;
                        let rest = result[val_start..].trim_start();
                        let trim_offset = val_start + (result[val_start..].len() - rest.len());
                        let val_end = if rest.starts_with('"') {
                            rest[1..].find('"').map(|i| trim_offset + 1 + i + 1)
                        } else if rest.starts_with('\'') {
                            rest[1..].find('\'').map(|i| trim_offset + 1 + i + 1)
                        } else {
                            rest.find(|c: char| c.is_whitespace() || c == '>').map(|i| trim_offset + i)
                        };
                        if let Some(end) = val_end {
                            result = format!("{}{}", &result[..pos], &result[end..]);
                            found = true;
                        }
                    }
                }
            }
        }
        if !found { break; }
    }

    result
}

#[tauri::command]
pub fn export_html(content: String, path: String) -> Result<(), String> {
    let content = sanitize_html(&content);
    let html = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Exported Document</title>
  <style>
    body {{ max-width: 48rem; margin: 2rem auto; padding: 0 1rem; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a1a1a; }}
    h1 {{ font-size: 2rem; margin: 1.5rem 0 0.75rem; }}
    h2 {{ font-size: 1.5rem; margin: 1.25rem 0 0.625rem; }}
    h3 {{ font-size: 1.25rem; margin: 1rem 0 0.5rem; }}
    pre {{ background: #f5f5f5; padding: 1rem; border-radius: 6px; overflow-x: auto; }}
    code {{ background: #f0f0f0; padding: 0.2em 0.4em; border-radius: 3px; font-size: 0.9em; }}
    pre code {{ background: none; padding: 0; }}
    blockquote {{ border-left: 3px solid #ddd; margin: 1rem 0; padding: 0.5rem 1rem; color: #555; }}
    table {{ border-collapse: collapse; width: 100%; }}
    th, td {{ border: 1px solid #ddd; padding: 0.5rem; text-align: left; }}
    th {{ background: #f5f5f5; }}
    mark {{ background: #fef08a; padding: 0.1em 0.2em; border-radius: 2px; }}
    img {{ max-width: 100%; }}
    hr {{ border: none; border-top: 1px solid #ddd; margin: 2rem 0; }}
  </style>
</head>
<body>
{}
</body>
</html>"#,
        content
    );
    fs::write(&path, html).map_err(|e| format!("Failed to export HTML: {}", e))
}
