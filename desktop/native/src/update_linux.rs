use crate::plugin_catalog::{Package, read_manifest};
use anyhow::{Context, Result, bail, ensure};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::Read,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Component, Path, PathBuf},
};

const PROGRAM: &str = "agent-space-native";
const PLUGINS: &str = "usr/lib/agent-space-native/official-plugins";
const MAX_PAYLOAD: u64 = 512 * 1024 * 1024;

pub(crate) fn installed(executable: &Path) -> bool {
    let Some(directory) = executable.parent() else {
        return false;
    };
    let uid = rustix::process::geteuid().as_raw();
    if !executable.is_absolute()
        || executable.file_name() != Some(PROGRAM.as_ref())
        || !fs::symlink_metadata(directory).is_ok_and(|metadata| {
            metadata.is_dir() && metadata.uid() == uid && metadata.mode() & 0o300 == 0o300
        })
        || !fs::symlink_metadata(executable)
            .is_ok_and(|metadata| metadata.is_file() && metadata.uid() == uid)
    {
        return false;
    }
    let plugins = directory.join("official-plugins");
    match fs::symlink_metadata(&plugins) {
        Ok(metadata) if metadata.is_dir() && metadata.uid() == uid => {
            ["codex", "dsh"].into_iter().all(|product| {
                let source = plugins.join(product);
                fs::symlink_metadata(&source)
                    .is_ok_and(|metadata| metadata.is_dir() && metadata.uid() == uid)
                    && read_manifest(&source).is_ok_and(|manifest| {
                        manifest.name == format!("@agent-remote/adapter-{product}")
                            && manifest.product == product
                    })
            })
        }
        // Earlier user installations could contain only the main executable.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => dirs::home_dir()
            .is_some_and(|home| directory == home.join(".local/opt/agent-space/native")),
        _ => false,
    }
}

pub(crate) fn replace(executable: &Path, artifact: &Path) -> Result<()> {
    let directory = executable.parent().context("安装位置无效")?;
    let staged = tempfile::Builder::new()
        .prefix(".next-")
        .tempdir_in(directory)?;
    unpack(artifact, staged.path())?;
    crate::update_install::replace_files(executable, || {
        for name in [PROGRAM, "official-plugins"] {
            fs::rename(staged.path().join(name), directory.join(name))?;
        }
        Ok(())
    })
}

fn unpack(artifact: &Path, destination: &Path) -> Result<()> {
    if let Some(root) = artifact
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_suffix(".tar.zst"))
    {
        return unpack_payload(File::open(artifact)?, destination, Some(Path::new(root)));
    }

    let mut archive = ar::Archive::new(File::open(artifact)?);
    while let Some(entry) = archive.next_entry() {
        let entry = entry?;
        if entry.header().identifier() == b"data.tar.zst" {
            return unpack_payload(entry, destination, None);
        }
    }
    bail!("更新包缺少 Zstandard 格式的 Debian 数据归档")
}

fn unpack_payload(reader: impl Read, destination: &Path, root: Option<&Path>) -> Result<()> {
    let decoded = zstd::stream::read::Decoder::new(reader)?.take(MAX_PAYLOAD + 1);
    let mut payload = tar::Archive::new(decoded);
    let mut files = HashSet::new();
    let mut size = 0u64;
    for (index, entry) in payload.entries()?.enumerate() {
        ensure!(index < 8192, "更新包文件过多");
        let mut entry = entry?;
        let path = entry.path()?;
        ensure!(
            path.components()
                .all(|part| matches!(part, Component::Normal(_) | Component::CurDir)),
            "更新包路径无效"
        );
        let path: PathBuf = path
            .components()
            .filter(|part| *part != Component::CurDir)
            .collect();
        let target = if let Some(root) = root {
            let relative = path.strip_prefix(root).context("更新包目录无效")?;
            if relative == Path::new(PROGRAM) || relative.starts_with("official-plugins") {
                relative.to_path_buf()
            } else {
                continue;
            }
        } else if path == Path::new("usr/bin/agent-space-native") {
            PathBuf::from(PROGRAM)
        } else if let Ok(relative) = path.strip_prefix(PLUGINS) {
            Path::new("official-plugins").join(relative)
        } else {
            continue;
        };
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            continue;
        }
        ensure!(kind.is_file(), "更新包中的程序和插件须为普通文件");
        ensure!(files.insert(target.clone()), "更新包包含重复文件");
        size = size.checked_add(entry.size()).context("更新包体积无效")?;
        ensure!(size <= MAX_PAYLOAD, "更新包解压后过大");
        let target = destination.join(target);
        fs::create_dir_all(target.parent().context("更新包路径无效")?)?;
        entry.unpack(&target)?;
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644))?;
    }
    ensure!(destination.join(PROGRAM).is_file(), "更新包缺少适配器");
    fs::set_permissions(destination.join(PROGRAM), fs::Permissions::from_mode(0o755))?;
    for product in ["codex", "dsh"] {
        let root = destination.join("official-plugins").join(product);
        let manifest = read_manifest(&root)?;
        ensure!(
            manifest.name == format!("@agent-remote/adapter-{product}")
                && manifest.product == product,
            "更新包的官方插件标识无效"
        );
        let binary = Package { manifest, root }.executable()?;
        fs::set_permissions(binary, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};

    fn package(path: &Path, corrupt: bool) -> Result<()> {
        let mut payload = tar::Builder::new(Vec::new());
        let mut append = |path: &str, bytes: &[u8]| -> Result<()> {
            let mut header = tar::Header::new_gnu();
            header.set_mode(0o755);
            header.set_size(bytes.len() as u64);
            header.set_cksum();
            payload.append_data(&mut header, path, bytes)?;
            Ok(())
        };
        append("./usr/bin/agent-space-native", b"new adapter")?;
        for product in ["codex", "dsh"] {
            let binary = format!("agent-space-adapter-{product}");
            let bytes = b"\x7fELFnative plugin";
            let sha256 = format!("{:x}", Sha256::digest(bytes));
            let manifest = json!({
                "sdk":1,"name":format!("@agent-remote/adapter-{product}"),
                "version":"0.3.99","product":product,"stateVersion":1,
                "entry":binary,"sha256":sha256
            });
            append(
                &format!("./{PLUGINS}/{product}/adapter.json"),
                &serde_json::to_vec(&manifest)?,
            )?;
            append(
                &format!("./{PLUGINS}/{product}/{binary}"),
                if corrupt && product == "dsh" {
                    b"\x7fELFdamaged plugin"
                } else {
                    bytes
                },
            )?;
        }
        let compressed = zstd::stream::encode_all(payload.into_inner()?.as_slice(), 1)?;
        let mut archive = ar::Builder::new(File::create(path)?);
        let header = ar::Header::new(b"data.tar.zst".to_vec(), compressed.len() as u64);
        archive.append(&header, compressed.as_slice())?;
        Ok(())
    }

    #[test]
    fn user_update_installs_both_verified_plugins_and_preserves_other_files() -> Result<()> {
        let root = tempfile::tempdir()?;
        let artifact = root.path().join("update.deb");
        package(&artifact, false)?;
        let directory = root.path().join("installed");
        fs::create_dir(&directory)?;
        let executable = directory.join(PROGRAM);
        fs::write(&executable, b"old adapter")?;
        fs::write(directory.join("unrelated"), b"keep this")?;
        fs::create_dir(directory.join("official-plugins"))?;
        fs::write(directory.join("official-plugins/previous"), b"old bundle")?;
        replace(&executable, &artifact)?;
        assert_eq!(fs::read(&executable)?, b"new adapter");
        assert_eq!(fs::metadata(&executable)?.mode() & 0o777, 0o755);
        assert_eq!(fs::read(directory.join("unrelated"))?, b"keep this");
        assert!(!directory.join("official-plugins/previous").exists());
        for product in ["codex", "dsh"] {
            let binary = directory.join(format!(
                "official-plugins/{product}/agent-space-adapter-{product}"
            ));
            assert_eq!(fs::read(&binary)?, b"\x7fELFnative plugin");
            assert_eq!(fs::metadata(binary)?.mode() & 0o777, 0o755);
        }
        Ok(())
    }

    #[test]
    fn invalid_plugin_leaves_the_existing_user_installation_intact() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let artifact = directory.path().join("update.deb");
        package(&artifact, true)?;
        let executable = directory.path().join(PROGRAM);
        fs::write(&executable, b"old adapter")?;
        fs::create_dir(directory.path().join("official-plugins"))?;
        fs::write(
            directory.path().join("official-plugins/previous"),
            b"old bundle",
        )?;
        assert!(replace(&executable, &artifact).is_err());
        assert_eq!(fs::read(executable)?, b"old adapter");
        assert_eq!(
            fs::read(directory.path().join("official-plugins/previous"))?,
            b"old bundle"
        );
        Ok(())
    }

    #[test]
    fn portable_updates_detect_the_bundle_in_a_user_chosen_directory() -> Result<()> {
        let fixture = tempfile::tempdir()?;
        let directory = fixture.path().join("my adapter");
        let artifact = fixture.path().join("update.deb");
        package(&artifact, false)?;
        fs::create_dir(&directory)?;
        let executable = directory.join(PROGRAM);
        fs::write(&executable, b"adapter")?;
        assert!(!installed(&executable));
        unpack(&artifact, &directory)?;
        assert!(installed(&executable));

        fs::set_permissions(&directory, fs::Permissions::from_mode(0o500))?;
        assert!(!installed(&executable));
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        fs::remove_file(&executable)?;
        let actual = fixture.path().join(PROGRAM);
        fs::write(&actual, b"adapter")?;
        std::os::unix::fs::symlink(actual, &executable)?;
        assert!(!installed(&executable));
        Ok(())
    }
}
