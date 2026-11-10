use crate::state::private_file;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::{self, Read},
    path::{Path, PathBuf},
};
use url::Url;
use uuid::Uuid;

const FILE: &str = "native-update-settings.json";
const MAX_SETTINGS: u64 = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct Preferences {
    pub(crate) auto_update: bool,
    #[serde(rename = "updateBaseURL")]
    pub(crate) base: Option<String>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            auto_update: true,
            base: None,
        }
    }
}

pub(crate) fn https_base(mut url: Url) -> Result<Url> {
    ensure!(
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "请输入不含凭据、查询参数或片段的 HTTPS 更新地址"
    );
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("更新地址无效"))?
        .pop_if_empty()
        .push("");
    Ok(url)
}

impl Preferences {
    pub(crate) fn new(auto_update: bool, base: &str) -> Result<Self> {
        let base = base.trim();
        ensure!(base.len() <= 4096, "更新地址过长");
        let base = if base.is_empty() {
            None
        } else {
            Some(https_base(Url::parse(base).context("请输入完整的 HTTPS 更新地址")?)?.to_string())
        };
        Ok(Self { auto_update, base })
    }

    pub(crate) fn load(directory: &Path, origin: &Url) -> Result<Self> {
        let legacy = legacy_settings();
        Self::load_from(
            directory,
            origin,
            legacy.as_deref(),
            env::var("POCKET_NATIVE_UPDATE_BASE_URL").ok().as_deref(),
        )
    }

    fn load_from(
        directory: &Path,
        origin: &Url,
        legacy: Option<&Path>,
        environment_base: Option<&str>,
    ) -> Result<Self> {
        let path = directory.join(FILE);
        match private_file(&path, false) {
            Ok(file) => {
                let saved = read_preferences(file)?;
                return Self::new(saved.auto_update, saved.base.as_deref().unwrap_or(""));
            }
            Err(error)
                if error
                    .downcast_ref::<io::Error>()
                    .is_some_and(|error| error.kind() == io::ErrorKind::NotFound) => {}
            Err(error) => return Err(error),
        }
        let mut preferences = Self::default();
        if let Some(path) = legacy {
            ensure!(
                fs::symlink_metadata(path)?.is_file(),
                "旧版更新配置路径无效"
            );
            let old = read_preferences(fs::File::open(path)?)?;
            preferences = Self::new(old.auto_update, old.base.as_deref().unwrap_or(""))?;
            if let Some(base) = &mut preferences.base {
                let mut url = Url::parse(base)?;
                if !url.path().ends_with("/native/rust/") {
                    url.path_segments_mut()
                        .map_err(|_| anyhow::anyhow!("旧版更新地址无效"))?
                        .pop_if_empty()
                        .extend(["native", "rust", ""]);
                }
                *base = url.to_string();
            }
        }
        if let Some(base) = environment_base.filter(|base| !base.is_empty()) {
            preferences.base = Some(https_base(origin.join(base)?)?.to_string());
        }
        if legacy.is_some() {
            preferences.save(directory)?;
        }
        Ok(preferences)
    }

    pub(crate) fn save(&self, directory: &Path) -> Result<()> {
        let path = directory.join(format!(".native-update-settings-{}.part", Uuid::new_v4()));
        let temporary = tempfile::TempPath::try_from_path(&path)?;
        let mut file = private_file(&path, true)?;
        serde_json::to_writer(&mut file, self)?;
        file.sync_all()?;
        drop(file);
        temporary.persist(directory.join(FILE))?;
        Ok(())
    }
}

fn legacy_settings() -> Option<PathBuf> {
    if let Some(path) = env::var_os("POCKET_NATIVE_LEGACY_DESKTOP_SETTINGS") {
        return Some(PathBuf::from(path));
    }
    if env::var_os("POCKET_NATIVE_STATE_DIR").is_some() {
        return None;
    }
    let base = dirs::config_dir()?;
    ["Agent Space Adapter", "agent-space-desktop"]
        .into_iter()
        .map(|name| base.join(name).join("settings.json"))
        .find(|file| file.is_file())
}

pub(crate) fn legacy_origin() -> Result<Option<String>> {
    #[derive(Deserialize)]
    struct DesktopSettings {
        origin: Option<String>,
    }
    let Some(path) = legacy_settings() else {
        return Ok(None);
    };
    ensure!(
        fs::symlink_metadata(&path)?.is_file(),
        "旧版桌面设置路径无效"
    );
    let settings: DesktopSettings = serde_json::from_slice(&settings_bytes(fs::File::open(path)?)?)
        .context("旧版桌面设置文件无法读取")?;
    Ok(settings.origin.filter(|origin| !origin.is_empty()))
}

fn read_preferences(file: fs::File) -> Result<Preferences> {
    serde_json::from_slice(&settings_bytes(file)?).context("更新配置文件无法读取")
}

fn settings_bytes(file: fs::File) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    file.take(MAX_SETTINGS + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= MAX_SETTINGS, "更新配置文件过大");
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::private_directory;

    #[test]
    fn migrates_legacy_switch_and_source_once_and_keeps_an_explicit_reset() -> Result<()> {
        let fixture = tempfile::tempdir()?;
        let directory = fixture.path().join("state");
        private_directory(&directory)?;
        let legacy = fixture.path().join("settings.json");
        let old = br#"{"autoUpdate":false,"updateBaseURL":"https://updates.example.org/custom","enrollment":"ignored"}"#;
        fs::write(&legacy, old)?;
        let origin = Url::parse("https://agent.example.org/")?;
        let preferences = Preferences::load_from(&directory, &origin, Some(&legacy), None)?;
        assert_eq!(
            preferences,
            Preferences::new(false, "https://updates.example.org/custom/native/rust/")?,
        );
        assert_eq!(fs::read(&legacy)?, old);
        assert!(!fs::read_to_string(directory.join(FILE))?.contains("enrollment"));
        let reset = Preferences::new(true, "")?;
        reset.save(&directory)?;
        assert_eq!(
            Preferences::load_from(&directory, &origin, Some(&legacy), Some("/other/"))?,
            reset,
        );
        Ok(())
    }

    #[test]
    fn validates_sources_and_resolves_an_existing_environment_default() -> Result<()> {
        for base in [
            "http://updates.example.org/",
            "https://user:secret@updates.example.org/",
            "https://updates.example.org/?token=x",
            "https://updates.example.org/#fragment",
            "/relative/",
        ] {
            assert!(Preferences::new(true, base).is_err());
        }
        let fixture = tempfile::tempdir()?;
        let origin = Url::parse("https://agent.example.org/")?;
        assert_eq!(
            Preferences::load_from(fixture.path(), &origin, None, Some("/updates"))?,
            Preferences::new(true, "https://agent.example.org/updates/")?,
        );
        Ok(())
    }
}
