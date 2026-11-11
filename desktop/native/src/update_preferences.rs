use crate::{migration::GatewayEnvironment, state::private_file};
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

    pub(crate) fn load(
        directory: &Path,
        origin: &Url,
        environment: &GatewayEnvironment,
    ) -> Result<Self> {
        let legacy = legacy_settings();
        let hybrid = crate::migration::source()
            .filter(|source| source.join("adapters/registry.json").is_file())
            .map(|_| (environment, env::var_os("POCKET_NATIVE_VERSION").is_some()));
        Self::load_from(
            directory,
            origin,
            legacy.as_deref(),
            env::var("POCKET_NATIVE_UPDATE_BASE_URL").ok().as_deref(),
            hybrid,
        )
    }

    fn load_from(
        directory: &Path,
        origin: &Url,
        legacy: Option<&Path>,
        environment_base: Option<&str>,
        hybrid: Option<(&GatewayEnvironment, bool)>,
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
        let mut migrated = legacy.is_some();
        if let Some(path) = legacy {
            ensure!(
                fs::symlink_metadata(path)?.is_file(),
                "旧版更新配置路径无效"
            );
            let old = read_preferences(fs::File::open(path)?)?;
            preferences = Self::new(old.auto_update, old.base.as_deref().unwrap_or(""))?;
            if let Some(base) = &mut preferences.base {
                let url = Url::parse(base)?;
                if !url.path().ends_with("/native/rust/") {
                    let suffix = if url.path().ends_with("/native/") {
                        &["rust", ""][..]
                    } else {
                        &["native", "rust", ""][..]
                    };
                    *base = channel(url, suffix)?;
                }
            }
        }
        let mut handed_off = false;
        if let Some((environment, inherited)) = hybrid {
            handed_off = inherited;
            if let Some((base, disabled)) = hybrid_preferences(environment) {
                migrated = true;
                if disabled {
                    preferences.auto_update = false;
                }
                if let Some(base) = base {
                    preferences.base = Some(channel(origin.join(&base)?, &["rust", ""])?);
                }
            }
        }
        if let Some(base) = environment_base.filter(|base| !base.trim().is_empty()) {
            let base = origin.join(base)?;
            preferences.base = Some(if handed_off {
                migrated = true;
                channel(base, &["rust", ""])?
            } else {
                https_base(base)?.to_string()
            });
        }
        if migrated {
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

fn channel(url: Url, suffix: &[&str]) -> Result<String> {
    let mut url = https_base(url)?;
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("旧版更新地址无效"))?
        .pop_if_empty()
        .extend(suffix.iter().copied());
    Ok(url.to_string())
}

fn hybrid_preferences(environment: &GatewayEnvironment) -> Option<(Option<String>, bool)> {
    let base = environment
        .get("POCKET_NATIVE_UPDATE_BASE_URL")
        .filter(|base| !base.trim().is_empty())
        .map(str::to_owned);
    let disabled = environment.get("POCKET_NATIVE_UPDATES") == Some("0");
    (base.is_some() || disabled).then_some((base, disabled))
}

fn legacy_settings() -> Option<PathBuf> {
    if let Some(path) = env::var_os("POCKET_NATIVE_LEGACY_DESKTOP_SETTINGS") {
        return Some(PathBuf::from(path));
    }
    let state = env::var_os("POCKET_NATIVE_STATE_DIR").map(PathBuf::from);
    if !uses_default_state(
        state.as_deref(),
        crate::state::default_directory().as_deref(),
    ) {
        return None;
    }
    let base = dirs::config_dir()?;
    ["Agent Space Adapter", "agent-space-desktop"]
        .into_iter()
        .map(|name| base.join(name).join("settings.json"))
        .find(|file| file.is_file())
}

fn uses_default_state(state: Option<&Path>, default: Option<&Path>) -> bool {
    // The update helper passes the current state path explicitly, including on a standard install.
    state.is_none_or(|state| {
        std::path::absolute(state)
            .ok()
            .as_deref()
            .zip(default)
            .is_some_and(|(state, default)| state == default)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
    origin: Option<String>,
    legacy_gateway: Option<LegacyGatewayPaths>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyGatewayPaths {
    environment_file: PathBuf,
    working_directory: PathBuf,
}

pub(crate) struct LegacyGateway {
    pub environment_file: PathBuf,
    pub working_directory: PathBuf,
    pub origin: Option<String>,
}

fn read_desktop_settings() -> Result<Option<DesktopSettings>> {
    let Some(path) = legacy_settings() else {
        return Ok(None);
    };
    ensure!(
        fs::symlink_metadata(&path)?.is_file(),
        "旧版桌面设置路径无效"
    );
    let settings = serde_json::from_slice(&settings_bytes(fs::File::open(path)?)?)
        .context("旧版桌面设置文件无法读取")?;
    Ok(Some(settings))
}

pub(crate) fn legacy_origin() -> Result<Option<String>> {
    Ok(read_desktop_settings()?
        .and_then(|settings| settings.origin)
        .filter(|origin| !origin.is_empty()))
}

pub(crate) fn legacy_gateway() -> Result<Option<LegacyGateway>> {
    let Some(settings) = read_desktop_settings()? else {
        return Ok(None);
    };
    let Some(gateway) = settings.legacy_gateway else {
        return Ok(None);
    };
    ensure!(
        gateway.environment_file.is_absolute() && gateway.working_directory.is_absolute(),
        "旧版网关配置和工作目录必须使用绝对路径"
    );
    Ok(Some(LegacyGateway {
        environment_file: gateway.environment_file,
        working_directory: gateway.working_directory,
        origin: settings.origin.filter(|origin| !origin.is_empty()),
    }))
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
    fn updated_default_installation_can_still_discover_legacy_gateway_settings() {
        let root = tempfile::tempdir().unwrap();
        let default = root.path().join("agent-space-native-preview");
        let isolated = root.path().join("test-profile");
        assert!(uses_default_state(None, Some(&default)));
        assert!(uses_default_state(Some(&default), Some(&default)));
        assert!(!uses_default_state(Some(&isolated), Some(&default)));
        assert!(!uses_default_state(Some(&isolated), None));
    }

    #[test]
    fn migrates_legacy_switch_and_source_once_and_keeps_an_explicit_reset() -> Result<()> {
        let fixture = tempfile::tempdir()?;
        let directory = fixture.path().join("state");
        private_directory(&directory)?;
        let legacy = fixture.path().join("settings.json");
        let old = br#"{"autoUpdate":false,"updateBaseURL":"https://updates.example.org/custom","enrollment":"ignored"}"#;
        fs::write(&legacy, old)?;
        let origin = Url::parse("https://agent.example.org/")?;
        let preferences = Preferences::load_from(&directory, &origin, Some(&legacy), None, None)?;
        assert_eq!(
            preferences,
            Preferences::new(false, "https://updates.example.org/custom/native/rust/")?,
        );
        assert_eq!(fs::read(&legacy)?, old);
        assert!(!fs::read_to_string(directory.join(FILE))?.contains("enrollment"));
        let reset = Preferences::new(true, "")?;
        reset.save(&directory)?;
        assert_eq!(
            Preferences::load_from(&directory, &origin, Some(&legacy), Some("/other/"), None)?,
            reset,
        );
        Ok(())
    }

    #[test]
    fn migrates_hybrid_channel_and_keeps_a_later_override() -> Result<()> {
        use std::io::Write;
        let fixture = tempfile::tempdir()?;
        let directory = fixture.path().join("state");
        let source = fixture.path().join("hybrid");
        private_directory(&directory)?;
        private_directory(&source)?;
        let mut gateway = private_file(&source.join("gateway.env"), true)?;
        write!(
            gateway,
            "POCKET_NATIVE_UPDATES=0\nPOCKET_NATIVE_UPDATE_BASE_URL=/legacy/channel\n"
        )?;
        drop(gateway);
        let origin = Url::parse("https://agent.example.org/")?;
        let environment = GatewayEnvironment::load(&directory, Some(&source))?;
        let preferences =
            Preferences::load_from(&directory, &origin, None, None, Some((&environment, false)))?;
        assert_eq!(
            preferences,
            Preferences::new(false, "https://agent.example.org/legacy/channel/rust/")?
        );

        let fresh = fixture.path().join("handoff");
        private_directory(&fresh)?;
        let inherited = Preferences::load_from(
            &fresh,
            &origin,
            None,
            Some("https://updates.example.org/native/"),
            Some((&environment, true)),
        )?;
        assert_eq!(
            inherited,
            Preferences::new(false, "https://updates.example.org/native/rust/")?
        );
        let reset = Preferences::new(true, "https://updates.example.org/explicit/")?;
        reset.save(&fresh)?;
        assert_eq!(
            Preferences::load_from(&fresh, &origin, None, None, Some((&environment, false)))?,
            reset
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
            Preferences::load_from(fixture.path(), &origin, None, Some("/updates"), None)?,
            Preferences::new(true, "https://agent.example.org/updates/")?,
        );
        Ok(())
    }
}
