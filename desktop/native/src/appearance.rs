use anyhow::{Context, Result, bail, ensure};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
};
use icu_properties::{
    CodePointSetData,
    props::{ExtendedPictographic, RegionalIndicator},
};
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::{fmt, io::Cursor};
use unicode_segmentation::UnicodeSegmentation;

const MAX_REVISION: i64 = (1 << 53) - 1;
const ICONS: &[&str] = &[
    "code", "terminal", "puzzle", "chat", "monitor", "book", "folder", "sun",
];

pub(crate) fn initialize(db: &Connection) -> Result<()> {
    db.execute(
        "CREATE TABLE IF NOT EXISTS backend_appearance (
           backend_id TEXT PRIMARY KEY, overrides TEXT NOT NULL, revision INTEGER NOT NULL
         )",
        [],
    )?;
    Ok(())
}

#[derive(Debug)]
pub(crate) struct RevisionConflict;

impl fmt::Display for RevisionConflict {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str("设置已在其他设备或工具中更新，请重新打开编辑后再保存")
    }
}

impl std::error::Error for RevisionConflict {}

#[derive(Default, Serialize)]
pub(crate) struct Saved {
    pub(crate) revision: i64,
    overrides: Map<String, Value>,
}

impl Saved {
    pub(crate) fn read(db: &Connection, id: &str) -> Result<Self> {
        let row: Option<(i64, String)> = db
            .query_row(
                "SELECT revision,overrides FROM backend_appearance WHERE backend_id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((revision, overrides)) = row {
            ensure!((0..=MAX_REVISION).contains(&revision), "实例外观版本无效");
            Ok(Self {
                revision,
                overrides: serde_json::from_str(&overrides).context("实例外观记录无效")?,
            })
        } else {
            Ok(Self::default())
        }
    }

    pub(crate) fn update(db: &mut Connection, id: &str, change: Change) -> Result<Self> {
        let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut saved = Self::read(&transaction, id)?;
        if let Some(expected) = change.revision {
            ensure!(saved.revision == expected, RevisionConflict);
        }
        ensure!(saved.revision < MAX_REVISION, "实例外观版本已达上限");
        for (field, value) in change.patch {
            if value.is_null() {
                saved.overrides.remove(&field);
            } else {
                saved.overrides.insert(field, value);
            }
        }
        saved.revision += 1;
        transaction.execute(
            "INSERT INTO backend_appearance (backend_id,overrides,revision) VALUES (?1,?2,?3)
             ON CONFLICT(backend_id) DO UPDATE SET overrides=excluded.overrides,revision=excluded.revision",
            rusqlite::params![id, serde_json::to_string(&saved.overrides)?, saved.revision],
        )?;
        transaction.commit()?;
        Ok(saved)
    }

    pub(crate) fn document(self, info: &Value) -> Value {
        let defaults = defaults(info);
        let values = self.values(&defaults);
        json!({
            "id": info["id"], "revision": self.revision, "overrides": self.overrides,
            "defaults": defaults, "values": values,
        })
    }

    pub(crate) fn apply(&self, info: &mut Value) {
        let values = self.values(&defaults(info));
        info["name"] = values["name"].clone();
        info["appearance"] = json!(values);
    }

    fn values(&self, defaults: &Map<String, Value>) -> Map<String, Value> {
        let mut values = defaults.clone();
        values.extend(self.overrides.clone());
        values
    }
}

fn defaults(info: &Value) -> Map<String, Value> {
    let product = info["product"].as_str().unwrap_or("agent");
    let style = product
        .to_lowercase()
        .chars()
        .filter(|character| !character.is_whitespace() && !matches!(character, '_' | '-'))
        .collect::<String>();
    let icon = match style.as_str() {
        "codex" => "code",
        "dsh" => "terminal",
        "claude" | "claudecode" => "sun",
        _ => "puzzle",
    };
    Map::from_iter([
        ("name".into(), info["name"].clone()),
        (
            "description".into(),
            json!(
                info["presentation"]["description"]
                    .as_str()
                    .unwrap_or(product)
            ),
        ),
        ("icon".into(), json!({"kind":"builtin","value":icon})),
    ])
}

pub(crate) struct Change {
    revision: Option<i64>,
    patch: Map<String, Value>,
}

impl Change {
    pub(crate) fn parse(input: Value) -> Result<Self> {
        let body = input.as_object().context("实例外观参数无效")?;
        ensure!(body.len() == 2, "实例外观参数无效");
        let revision = body
            .get("revision")
            .and_then(Value::as_f64)
            .filter(|value| value.fract() == 0.0 && (0.0..=MAX_REVISION as f64).contains(value))
            .context("实例外观版本无效")? as i64;
        let patch = body
            .get("patch")
            .and_then(Value::as_object)
            .context("实例外观参数无效")?;
        Self::new(Some(revision), patch)
    }

    pub(crate) fn new(revision: Option<i64>, patch: &Map<String, Value>) -> Result<Self> {
        ensure!(
            revision.is_none_or(|value| (0..=MAX_REVISION).contains(&value)),
            "实例外观版本无效"
        );
        ensure!(!patch.is_empty(), "没有需要保存的设置");
        let mut normalized = Map::new();
        for (field, value) in patch {
            let value = match (field.as_str(), value.is_null()) {
                ("name" | "description" | "icon", true) => Value::Null,
                ("name", false) => json!(text(value, 1, 80)?),
                ("description", false) => json!(text(value, 0, 160)?),
                ("icon", false) => icon(value)?,
                _ => bail!("实例外观字段无效"),
            };
            normalized.insert(field.clone(), value);
        }
        Ok(Self {
            revision,
            patch: normalized,
        })
    }
}

fn text(value: &Value, minimum: usize, maximum: usize) -> Result<&str> {
    let value = value.as_str().context("实例外观文本无效")?;
    let value =
        value.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
    ensure!(
        (minimum..=maximum).contains(&value.encode_utf16().count()),
        "实例外观文本长度无效"
    );
    Ok(value)
}

fn icon(value: &Value) -> Result<Value> {
    let icon = value.as_object().context("实例图标无效")?;
    ensure!(icon.len() == 2, "实例图标无效");
    let value = icon.get("value").context("实例图标无效")?;
    match icon.get("kind").and_then(Value::as_str) {
        Some("builtin") => {
            let name = value
                .as_str()
                .filter(|name| ICONS.contains(name))
                .context("内置图标无效")?;
            Ok(json!({"kind":"builtin","value":name}))
        }
        Some("emoji") => {
            let emoji = text(value, 1, 32)?;
            let pictographic = CodePointSetData::new::<ExtendedPictographic>();
            let regional = CodePointSetData::new::<RegionalIndicator>();
            ensure!(
                emoji.graphemes(true).count() == 1
                    && emoji.chars().any(|c| pictographic.contains(c)
                        || regional.contains(c)
                        || c == '\u{20e3}'),
                "请选择一个 Emoji"
            );
            Ok(json!({"kind":"emoji","value":emoji}))
        }
        Some("image") => {
            let url = value
                .as_str()
                .filter(|value| value.len() <= 90_000)
                .context("实例图标格式无效")?;
            let (mime, encoded) = url.split_once(',').context("实例图标格式无效")?;
            ensure!(
                matches!(
                    mime,
                    "data:image/png;base64" | "data:image/jpeg;base64" | "data:image/webp;base64"
                ),
                "实例图标格式无效"
            );
            let bytes = STANDARD
                .decode(encoded)
                .or_else(|_| STANDARD_NO_PAD.decode(encoded))?;
            Ok(json!({"kind":"image","value":raster(&bytes)?}))
        }
        _ => bail!("实例图标类型无效"),
    }
}

pub(crate) fn raster(bytes: &[u8]) -> Result<String> {
    let format = image::guess_format(bytes)?;
    ensure!(
        matches!(
            format,
            ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
        ),
        "请选择 PNG、JPEG 或 WebP 图片"
    );
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(192 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder()?;
    let (width, height) = decoder.dimensions();
    ensure!(
        u64::from(width) * u64::from(height) <= 24_000_000,
        "图片像素过多"
    );
    let orientation = decoder.orientation()?;
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    let mut side = width.min(height).min(192);
    loop {
        let square = image
            .resize_to_fill(side, side, image::imageops::FilterType::Lanczos3)
            .into_rgba8();
        let mut bytes = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut bytes).write_image(
            &square,
            side,
            side,
            image::ExtendedColorType::Rgba8,
        )?;
        if bytes.len() <= 48 * 1024 {
            return Ok(format!("data:image/webp;base64,{}", STANDARD.encode(bytes)));
        }
        // Keep the same bounded WebP payload while preserving alpha with a pure Rust encoder.
        side = side * 3 / 4;
        ensure!(side > 0, "图片无法保存");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_all_supported_rasters_to_bounded_webp() -> Result<()> {
        let source = DynamicImage::new_rgb8(80, 56);
        for format in [ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::WebP] {
            let mut input = Cursor::new(Vec::new());
            source.write_to(&mut input, format)?;
            let url = raster(input.get_ref())?;
            let bytes = STANDARD.decode(url.strip_prefix("data:image/webp;base64,").unwrap())?;
            assert!(bytes.len() <= 48 * 1024);
            let output = image::load_from_memory_with_format(&bytes, ImageFormat::WebP)?;
            assert_eq!((output.width(), output.height()), (56, 56));
        }
        Ok(())
    }
}
