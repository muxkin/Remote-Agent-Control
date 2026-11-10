use crate::state::hash;
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Default, Deserialize)]
struct Config {
    #[serde(default)]
    plugins: HashMap<String, PluginConfig>,
    #[serde(default)]
    skills: SkillsConfig,
}

#[derive(Deserialize)]
struct PluginConfig {
    enabled: Option<bool>,
}

#[derive(Default, Deserialize)]
struct SkillsConfig {
    #[serde(default)]
    config: Vec<SkillConfig>,
}

#[derive(Deserialize)]
struct SkillConfig {
    path: PathBuf,
    enabled: Option<bool>,
}

#[derive(Deserialize)]
struct Frontmatter {
    name: String,
    description: String,
}

#[derive(Deserialize)]
struct SkillPresentation {
    interface: SkillInterface,
}

#[derive(Deserialize)]
struct SkillInterface {
    display_name: String,
}

pub struct Entry {
    id: String,
    public: Value,
    input: Value,
}

#[derive(Default)]
pub struct Catalog {
    skills: Vec<Entry>,
    plugins: Vec<Entry>,
}

impl Catalog {
    pub fn scan(home: &Path, cwd: &Path, disabled_plugins: &[String]) -> Result<Self> {
        let ancestors: Vec<_> = if cwd.is_absolute() {
            cwd.ancestors().collect()
        } else {
            Vec::new()
        };
        let user = home.parent().unwrap_or(home);
        let mut config = Config::default();
        let paths = std::iter::once(home.join("config.toml")).chain(
            ancestors
                .iter()
                .rev()
                .map(|path| path.join(".codex/config.toml")),
        );
        for path in paths {
            let raw = match fs::read_to_string(&path) {
                Ok(raw) => raw,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            let found: Config = toml::from_str(&raw)?;
            config.plugins.extend(found.plugins);
            config.skills.config.extend(found.skills.config);
        }
        let disabled: HashMap<_, _> = config
            .skills
            .config
            .into_iter()
            .map(|item| {
                let path = item.path.canonicalize().unwrap_or(item.path);
                (path, item.enabled == Some(false))
            })
            .collect();
        let mut skills = Scanner {
            seen: HashSet::new(),
            disabled,
            entries: Vec::new(),
        };
        for path in ancestors {
            let source = if path == user { "个人" } else { "项目" };
            for folder in [".agents/skills", ".codex/skills"] {
                skills.root(&path.join(folder), source, false);
            }
        }
        skills.root(&home.join("skills"), "个人", false);
        skills.root(&user.join(".agents/skills"), "个人", false);
        let mut plugins = Vec::new();
        for market in dirs(&home.join("plugins/cache")) {
            for plugin in dirs(&market) {
                let (Some(slug), Some(market)) = (name(&plugin), name(&market)) else {
                    continue;
                };
                let native = format!("{slug}@{market}");
                let enabled = config
                    .plugins
                    .get(&native)
                    .and_then(|config| config.enabled);
                let install = read_json(&plugin.join(".codex-remote-plugin-install.json"));
                let remote = install
                    .as_ref()
                    .and_then(|data| data["remote_plugin_id"].as_str())
                    .unwrap_or(&native);
                if enabled == Some(false)
                    || (enabled != Some(true) && install.is_none())
                    || disabled_plugins
                        .iter()
                        .any(|id| id == &native || id == remote)
                {
                    continue;
                }
                let Some(current) = dirs(&plugin).into_iter().max_by_key(|path| {
                    name(path)
                        .unwrap_or_default()
                        .split('.')
                        .map(|part| (part.parse::<u64>().ok(), part.to_owned()))
                        .collect::<Vec<_>>()
                }) else {
                    continue;
                };
                skills.root(&current.join("skills"), slug, true);
                let Some(manifest) = read_json(&current.join(".codex-plugin/plugin.json")) else {
                    continue;
                };
                let Some(native_name) = manifest["name"].as_str() else {
                    continue;
                };
                let label = manifest["interface"]["displayName"]
                    .as_str()
                    .unwrap_or(native_name);
                let description: String = manifest["interface"]["shortDescription"]
                    .as_str()
                    .or_else(|| manifest["description"].as_str())
                    .unwrap_or_default()
                    .chars()
                    .take(800)
                    .collect();
                let id = hash(&format!("{native}\0{}", name(&current).unwrap_or_default()));
                plugins.push(Entry {
                    public: json!({"id":id,"name":label.chars().take(100).collect::<String>(),"description":description}),
                    input: json!({"type":"mention","name":label,"path":format!("plugin://{native}")}),
                    id,
                });
            }
        }
        skills.entries.sort_by(|a, b| label(a).cmp(label(b)));
        plugins.sort_by(|a, b| label(a).cmp(label(b)));
        Ok(Self {
            skills: skills.entries,
            plugins,
        })
    }

    pub fn list(&self, skills: bool) -> Vec<&Value> {
        let entries = if skills { &self.skills } else { &self.plugins };
        entries.iter().map(|item| &item.public).collect()
    }

    pub fn select(&self, skills: &[String], plugins: &[String]) -> Result<Vec<Value>> {
        let mut selected = Vec::new();
        for (ids, entries) in [(skills, &self.skills), (plugins, &self.plugins)] {
            let mut seen = HashSet::new();
            for id in ids.iter().filter(|id| seen.insert(*id)) {
                let entry = entries
                    .iter()
                    .find(|entry| entry.id == *id)
                    .context("所选技能或插件已移除、停用或不属于当前项目")?;
                selected.push(entry.input.clone());
            }
        }
        Ok(selected)
    }
}

fn name(path: &Path) -> Option<&str> {
    path.file_name()?.to_str()
}

fn label(entry: &Entry) -> &str {
    entry.public["name"].as_str().unwrap_or_default()
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn dirs(path: &Path) -> Vec<PathBuf> {
    fs::read_dir(path)
        .into_iter()
        .flatten()
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir() && name(path).is_some_and(|name| !name.starts_with('.')))
        .collect()
}

struct Scanner {
    seen: HashSet<PathBuf>,
    disabled: HashMap<PathBuf, bool>,
    entries: Vec<Entry>,
}

impl Scanner {
    fn root(&mut self, path: &Path, source: &str, plugin: bool) {
        self.skill(&path.join("SKILL.md"), source, plugin);
        for dir in dirs(path) {
            self.skill(&dir.join("SKILL.md"), source, plugin);
        }
        if !plugin {
            for dir in dirs(&path.join(".system")) {
                self.skill(&dir.join("SKILL.md"), "系统", false);
            }
        }
    }

    fn skill(&mut self, path: &Path, source: &str, plugin: bool) {
        if let Ok(entry) = self.read(path, source, plugin) {
            self.entries.push(entry);
        }
    }

    fn read(&mut self, path: &Path, source: &str, plugin: bool) -> Result<Entry> {
        let path = path.canonicalize()?;
        let parent = path.parent().context("技能目录无效")?;
        ensure!(
            self.seen.insert(path.clone())
                && !self.disabled.get(&path).copied().unwrap_or(false)
                && !self.disabled.get(parent).copied().unwrap_or(false),
            "技能已读取或已停用"
        );
        let info = path.metadata()?;
        ensure!(info.is_file() && info.len() <= 512 * 1024, "技能文件无效");
        let text = fs::read_to_string(&path)?;
        let mut lines = text.lines();
        ensure!(lines.next() == Some("---"), "技能元数据无效");
        let mut front = String::new();
        loop {
            let line = lines.next().context("技能元数据未闭合")?;
            if line == "---" {
                break;
            }
            ensure!(front.len() + line.len() < 16 * 1024, "技能元数据过长");
            front.push_str(line);
            front.push('\n');
        }
        let skill: Frontmatter = serde_yaml_ng::from_str(&front)?;
        ensure!(!skill.name.trim().is_empty(), "技能名称无效");
        let display = fs::read_to_string(parent.join("agents/openai.yaml"))
            .ok()
            .filter(|text| text.len() <= 16 * 1024)
            .and_then(|text| serde_yaml_ng::from_str::<SkillPresentation>(&text).ok())
            .map_or_else(|| skill.name.clone(), |meta| meta.interface.display_name);
        let path = path.to_str().context("技能路径无效")?;
        let name = if plugin {
            format!("{source}:{}", skill.name)
        } else {
            skill.name.clone()
        };
        let kind = if plugin {
            "plugin"
        } else {
            match source {
                "项目" => "project",
                "系统" => "system",
                _ => "personal",
            }
        };
        let id = hash(&format!("{path}\0{name}\0{text}"));
        Ok(Entry {
            public: json!({"id":id,"name":name,"description":skill.description.chars().take(800).collect::<String>(),
                "source":source,"sourceKind":kind,"displayName":display.chars().take(120).collect::<String>()}),
            input: json!({"type":"skill","name":skill.name,"path":path}),
            id,
        })
    }
}
