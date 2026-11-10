use serde_json::{Value, json};

const FIELD_LIMIT: usize = 16 * 1024;

fn excerpt(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    format!("{}…", &text[..text.floor_char_boundary(limit)])
}

fn command(item: &Value, limit: usize) -> String {
    if let Some(text) = item["command"].as_str() {
        return excerpt(text, limit);
    }
    let mut command = String::new();
    for arg in item["command"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if !command.is_empty() {
            command.push(' ');
        }
        command.push_str(&excerpt(arg, limit));
        if command.len() > limit {
            break;
        }
    }
    excerpt(&command, limit)
}

pub fn summary(item: &Value) -> Option<String> {
    let label = match item["type"].as_str()? {
        "commandExecution" | "CommandExecution" => {
            let command = command(item, 240);
            if command.is_empty() {
                "命令".into()
            } else {
                format!("命令 · {command}")
            }
        }
        "fileChange" | "FileChange" => "文件修改".into(),
        "mcpToolCall" | "McpToolCall" | "dynamicToolCall" | "DynamicToolCall" => {
            format!(
                "工具 · {}",
                excerpt(item["tool"].as_str().unwrap_or("调用"), 240)
            )
        }
        "webSearch" | "WebSearch" => "网页搜索".into(),
        _ => return None,
    };
    let status = excerpt(item["status"].as_str().unwrap_or("已记录"), 80);
    Some(format!("{label} · {status}"))
}

pub fn details(item: &Value) -> Option<Value> {
    let mut result = json!({});
    match item["type"].as_str()? {
        "commandExecution" | "CommandExecution" => {
            let command = command(item, FIELD_LIMIT);
            if !command.is_empty() {
                let exit = item["exitCode"]
                    .as_i64()
                    .or_else(|| item["exit_code"].as_i64());
                result["details"] = json!(match exit {
                    Some(code) => format!("{command}\n退出码：{code}"),
                    None => command,
                });
            }
            if let Some(output) = item["aggregatedOutput"]
                .as_str()
                .or_else(|| item["aggregated_output"].as_str())
                .or_else(|| item["output"].as_str())
                .filter(|output| !output.is_empty())
            {
                result["output"] = json!(excerpt(output, FIELD_LIMIT));
            }
        }
        "fileChange" | "FileChange" => {
            let changes: Vec<_> = item["changes"].as_array().into_iter().flatten().take(16)
                .filter_map(|change| Some(json!({
                    "path": excerpt(change["path"].as_str()?, 1024),
                    "kind": excerpt(change["kind"]["type"].as_str().or_else(|| change["kind"].as_str()).unwrap_or("update"), 80),
                    "diff": excerpt(change["diff"].as_str().unwrap_or_default(), 2048),
                })))
                .collect();
            if !changes.is_empty() {
                result["changes"] = json!(changes);
            }
        }
        "mcpToolCall" | "McpToolCall" | "dynamicToolCall" | "DynamicToolCall" => {
            let text = item["result"]["content"]
                .as_array()
                .or_else(|| item["contentItems"].as_array())
                .map_or_else(String::new, |content| {
                    content
                        .iter()
                        .take(8)
                        .filter_map(|item| item["text"].as_str())
                        .map(|text| excerpt(text, 2048))
                        .collect::<Vec<_>>()
                        .join("\n")
                });
            if !text.is_empty() {
                result["output"] = json!(text);
            }
            if let Some(error) = item["error"]["message"].as_str() {
                result["details"] = json!(excerpt(error, FIELD_LIMIT));
            }
        }
        "webSearch" | "WebSearch" => {
            if let Some(query) = item["query"].as_str().filter(|query| !query.is_empty()) {
                result["details"] = json!(excerpt(query, FIELD_LIMIT));
            }
        }
        _ => return None,
    }
    (!result.as_object()?.is_empty()).then_some(result)
}

pub fn apply_details(message: &mut Value, details: &Value) {
    if let Some(fields) = details.as_object() {
        for (key, value) in fields {
            message[key] = value.clone();
        }
        message["deferred"] = json!(false);
    }
}
