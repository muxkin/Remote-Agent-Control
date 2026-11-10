use crate::{
    appearance::{self, Change, Saved},
    plugins,
    state::{private_directory, verify_database_paths},
};
use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value, json};
use std::{collections::BTreeMap, fs::File, io::Read, path::Path, time::Duration};

const HELP: &str = "用法: agent-space-native --instance list | show <id> | set <id> [--name 名称] [--description 说明] [--icon 内置图标 | --emoji 表情 | --image 图片路径] [--revision 版本] | reset <id> [--revision 版本]";

pub(crate) fn run(directory: &Path, args: &[String]) -> Result<()> {
    if args.is_empty() || args == ["help"] {
        println!("{HELP}");
        return Ok(());
    }
    let names = plugins::instance_names(directory)?;
    let configured = |id: &str| {
        ensure!(names.contains_key(id), "找不到此 Agent 实例");
        Ok::<_, anyhow::Error>(())
    };
    let value = match args {
        [command] if command == "list" => {
            let db = connection(directory)?;
            let mut rows = Vec::with_capacity(names.len());
            for (id, name) in &names {
                let mut row = serde_json::to_value(Saved::read(&db, id)?)?;
                row["id"] = json!(id);
                row["configuredName"] = json!(name);
                rows.push(row);
            }
            json!(rows)
        }
        [command, id] if command == "show" => {
            configured(id)?;
            let db = connection(directory)?;
            let mut value = serde_json::to_value(Saved::read(&db, id)?)?;
            value["id"] = json!(id);
            value
        }
        [command, id, options @ ..] if matches!(command.as_str(), "set" | "reset") => {
            configured(id)?;
            let change = change(options, command == "reset")?;
            let mut db = connection(directory)?;
            let saved = Saved::update(&mut db, id, change)?;
            json!({"id":id,"revision":saved.revision,"saved":true})
        }
        _ => bail!("{HELP}"),
    };
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

fn connection(directory: &Path) -> Result<Connection> {
    ensure!(
        directory.join("state.sqlite").is_file(),
        "请先启动适配器初始化状态目录"
    );
    private_directory(directory)?;
    verify_database_paths(directory)?;
    let db = Connection::open_with_flags(
        directory.join("state.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_WRITE,
    )?;
    db.busy_timeout(Duration::from_secs(3))?;
    appearance::initialize(&db)?;
    Ok(db)
}

fn change(options: &[String], reset: bool) -> Result<Change> {
    let mut args = options.chunks_exact(2);
    ensure!(args.remainder().is_empty(), "{HELP}");
    let mut parsed = BTreeMap::new();
    for pair in &mut args {
        let key = pair[0].as_str();
        ensure!(
            (key == "--revision"
                || (!reset
                    && matches!(
                        key,
                        "--name" | "--description" | "--icon" | "--emoji" | "--image"
                    )))
                && parsed.insert(key, pair[1].as_str()).is_none(),
            "{HELP}"
        );
    }
    let revision = parsed
        .remove("--revision")
        .map(|value| value.parse::<i64>().context("实例外观版本无效"))
        .transpose()?;
    let mut patch = Map::new();
    if reset {
        for field in ["name", "description", "icon"] {
            patch.insert(field.into(), Value::Null);
        }
    } else {
        for (option, field) in [("--name", "name"), ("--description", "description")] {
            if let Some(value) = parsed.remove(option) {
                patch.insert(field.into(), json!(value));
            }
        }
        ensure!(parsed.len() <= 1, "一次只能指定一种图标");
        if let Some((option, value)) = parsed.into_iter().next() {
            let icon = match option {
                "--icon" => json!({"kind":"builtin","value":value}),
                "--emoji" => json!({"kind":"emoji","value":value}),
                "--image" => {
                    const MAX_BYTES: u64 = 5 * 1024 * 1024;
                    let mut bytes = Vec::new();
                    File::open(value)?
                        .take(MAX_BYTES + 1)
                        .read_to_end(&mut bytes)?;
                    ensure!(bytes.len() as u64 <= MAX_BYTES, "图片不能超过 5 MiB");
                    json!({"kind":"image","value":appearance::raster(&bytes)?})
                }
                _ => unreachable!("validated appearance option"),
            };
            patch.insert("icon".into(), icon);
        }
    }
    Change::new(revision, &patch)
}
