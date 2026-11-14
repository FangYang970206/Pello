//! Terminal panes. A split adds a tile; it does not replace the terminal process.
//! The grid is the same 2×2 used by `src/renderer/terminal-layout.ts`.

use crate::i18n::translate;
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tile {
    pub id: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Tile {
    pub fn full(id: &str) -> Self {
        Self { id: id.to_string(), x: 0, y: 0, width: 2, height: 2 }
    }

    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "x": self.x, "y": self.y, "width": self.width, "height": self.height })
    }
}

pub fn split_tile(tiles: &[Tile], id: &str, next_id: &str, direction: &str, language: &str) -> Result<Vec<Tile>, String> {
    if tiles.len() >= 4 || tiles.iter().any(|tile| tile.id == next_id) {
        return Err(translate(language, "最多支持四个终端分栏", &[] as &[String]));
    }
    let Some(tile) = tiles.iter().find(|tile| tile.id == id) else {
        return Err(translate(language, "终端已关闭", &[] as &[String]));
    };
    let horizontal = match direction {
        "left" | "right" => true,
        "up" | "down" => false,
        _ => return Err(translate(language, "创建参数无效", &[] as &[String])),
    };
    if (if horizontal { tile.width } else { tile.height }) < 2 {
        return Err(translate(language, "此方向已达到分栏上限，请选择另一方向", &[] as &[String]));
    }
    let first = Tile {
        id: String::new(),
        x: tile.x,
        y: tile.y,
        width: if horizontal { 1 } else { tile.width },
        height: if horizontal { tile.height } else { 1 },
    };
    let second = Tile {
        id: String::new(),
        x: if horizontal { tile.x + 1 } else { tile.x },
        y: if horizontal { tile.y } else { tile.y + 1 },
        width: first.width,
        height: first.height,
    };
    let before = direction == "left" || direction == "up";
    let mut next = Vec::new();
    for item in tiles {
        if item.id != id {
            next.push(item.clone());
            continue;
        }
        let mut kept = first.clone();
        let mut added = second.clone();
        if before {
            kept.id = next_id.to_string();
            added.id = id.to_string();
        } else {
            kept.id = id.to_string();
            added.id = next_id.to_string();
        }
        next.push(kept);
        next.push(added);
    }
    Ok(next)
}

/// Trim a display name. Empty input is rejected by the caller; this only cleans it.
pub fn display_name(value: &str) -> String {
    value.trim().chars().filter(|char| (*char as u32) >= 32).take(80).collect()
}
