use crate::{
    im_agent::cli_request,
    im_client::{Client, MAX_CURSOR, agent_http, checked_bytes, is_uid, origin_url, required},
    im_crypto::new_agent_vault,
    migration::{self, GatewayEnvironment},
    state::{create_private_file, private_directory},
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    env, fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

const COMMANDS: &str = "register|me|contacts|add-contact|chats|chat|group|group-update|history|search|send|stream-start|stream-update|cancel|request|request-cancel|stickers|sticker-save|sticker-remove|upload|sync|read";

struct Arguments<'a> {
    command: Option<&'a str>,
    options: BTreeMap<&'a str, &'a str>,
}

impl<'a> Arguments<'a> {
    fn parse(args: &'a [String]) -> Result<Self> {
        let mut options = BTreeMap::new();
        let mut command = None;
        let mut args = args.iter().map(String::as_str);
        while let Some(arg) = args.next() {
            if matches!(arg, "-h" | "--help") {
                command = Some("help");
                continue;
            }
            let Some(option) = arg.strip_prefix("--") else {
                ensure!(
                    command.is_none() && !arg.starts_with('-'),
                    "无效的独立 Agent 参数"
                );
                command = Some(arg);
                continue;
            };
            let (name, inline) = option
                .split_once('=')
                .map_or((option, None), |(name, value)| (name, Some(value)));
            let value = match name {
                "close" if inline.is_none() => "true",
                "origin" | "state" | "username" | "account" | "name" | "user" | "conversation"
                | "text" | "request-id" | "cursor" | "before" | "wait" | "sequence" | "message"
                | "revision" | "status" | "activities" | "members" | "add" | "remove" | "owner"
                | "file" | "attachments" | "mentions" | "reply" | "query" | "sticker" => inline
                    .or_else(|| args.next().filter(|value| !value.starts_with("--")))
                    .with_context(|| format!("缺少 --{name} 的值"))?,
                _ => anyhow::bail!("未知的独立 Agent 选项"),
            };
            options.insert(name, value);
        }
        Ok(Self { command, options })
    }

    fn get(&self, name: &str) -> Option<&'a str> {
        self.options.get(name).copied()
    }

    fn require(&self, name: &str) -> Result<&'a str> {
        self.get(name)
            .filter(|value| !value.is_empty())
            .with_context(|| format!("缺少 --{name}"))
    }

    fn number(&self, name: &str) -> Result<Option<u64>> {
        self.get(name)
            .map(|value| {
                value
                    .parse::<u64>()
                    .ok()
                    .filter(|n| *n <= MAX_CURSOR)
                    .with_context(|| format!("--{name} 需要非负整数"))
            })
            .transpose()
    }

    fn required_number(&self, name: &str) -> Result<u64> {
        self.number(name)?.with_context(|| format!("缺少 --{name}"))
    }

    fn list(&self, name: &str) -> Option<Vec<&'a str>> {
        self.get(name).map(|value| value.split(',').collect())
    }

    fn state(&self, environment: &Environment) -> Result<PathBuf> {
        let state = self
            .get("state")
            .map(PathBuf::from)
            .or_else(|| {
                environment
                    .get("POCKET_IM_AGENT_STATE")
                    .map(PathBuf::from)
                    .map(|path| environment.0.resolve(path))
            })
            .or_else(|| {
                dirs::home_dir()
                    .map(|home| home.join(".local/state/codex-pocket-remote/im-agent.json"))
            })
            .context("无法定位独立 Agent 凭据文件")?;
        Ok(std::path::absolute(state)?)
    }

    fn origin(&self, environment: &Environment, saved: Option<&str>) -> Result<String> {
        let env_origin = environment.get("POCKET_IM_ORIGIN");
        origin_url(
            self.get("origin")
                .or(env_origin.as_deref())
                .or(saved)
                .context("缺少 --origin 或 POCKET_IM_ORIGIN")?,
        )
    }
}

struct Environment(GatewayEnvironment);

impl Environment {
    fn load() -> Result<Self> {
        let directory = env::var_os("POCKET_NATIVE_STATE_DIR")
            .map(PathBuf::from)
            .or_else(|| dirs::data_local_dir().map(|path| path.join("agent-space-native-preview")));
        let Some(directory) = directory else {
            return Ok(Self(GatewayEnvironment::default()));
        };
        let directory = std::path::absolute(directory)?;
        migration::initialize(&directory)?;
        Ok(Self(GatewayEnvironment::load(
            &directory,
            migration::source(),
        )?))
    }

    fn get(&self, name: &str) -> Option<String> {
        env::var(name)
            .ok()
            .or_else(|| self.0.get(name).map(str::to_owned))
    }
}

pub(crate) fn run(args: &[String]) -> Result<()> {
    match tokio::runtime::Runtime::new()?.block_on(execute(args)) {
        Ok(value) => {
            let mut output = io::stdout().lock();
            serde_json::to_writer_pretty(&mut output, &value)?;
            writeln!(output)?;
            Ok(())
        }
        Err(error) => {
            eprintln!("{}", json!({"error":error.to_string()}));
            std::process::exit(1)
        }
    }
}

async fn execute(args: &[String]) -> Result<Value> {
    let args = Arguments::parse(args)?;
    let Some(command) = args.command.filter(|name| *name != "help") else {
        return Ok(json!({
            "usage":format!("agent-space-native --im <{COMMANDS}> [options]"),
            "registration":"register --origin URL --username USERNAME --name NAME; set POCKET_IM_INVITATION",
            "options":"--state PATH; --user USER_ID; --account UID_OR_USERNAME; --conversation ID; --text TEXT; --request-id ID; --cursor N; --wait MS; --before N; --sequence N",
            "group":"group --name NAME --members IDS; group-update --conversation ID [--name NAME] [--add IDS] [--remove ID] [--owner ID] [--close]",
            "stream":"stream-start --conversation ID [--text TEXT]; stream-update --conversation ID --message ID --revision N [--text TEXT] [--status streaming|complete|failed] [--activities JSON]",
            "files":"upload --conversation ID --file PATH; send --conversation ID [--attachments IDS] [--mentions IDS] [--reply ID] [--sticker ID]; request --conversation ID --file JSON; search --conversation ID --query TEXT"
        }));
    };
    let environment = Environment::load()?;
    let state = args.state(&environment)?;
    if command == "register" {
        return register(&args, &environment, &state).await;
    }
    let credentials = match Client::read_credentials(&state) {
        Ok(value) => Some(value),
        Err(error) if missing_file(&error) => None,
        Err(error) => return Err(error),
    };
    let saved_origin = credentials
        .as_ref()
        .and_then(|value| value["origin"].as_str());
    let origin = args.origin(&environment, saved_origin)?;
    let explicit_token = environment.get("POCKET_IM_TOKEN");
    ensure!(
        saved_origin.is_none_or(|saved| saved == origin) || explicit_token.is_some(),
        "服务地址与凭据文件不符，请选择独立的 --state 文件"
    );
    let same_origin = credentials
        .as_ref()
        .filter(|value| value["origin"] == origin);
    let token = explicit_token
        .as_deref()
        .or_else(|| same_origin.and_then(|value| value["token"].as_str()))
        .context("缺少独立 Agent 凭据文件或 POCKET_IM_TOKEN")?;
    let credentials =
        same_origin.filter(|value| !value["user"].is_null() && !value["secrets"].is_null());
    let client = Client::with_credentials(&origin, token, credentials)?;
    if credentials.is_some() && explicit_token.is_some() {
        client.verify().await?;
    }
    message(&args, command, &client).await
}

async fn message(args: &Arguments<'_>, command: &str, client: &Client) -> Result<Value> {
    let (method, params) = match command {
        "me" => ("account.me", Value::Null),
        "contacts" => ("contacts.list", Value::Null),
        "add-contact" => (
            "contact.add",
            json!({"identifier":args.require("account")?}),
        ),
        "chats" => ("conversations.list", Value::Null),
        "chat" => (
            "conversation.direct",
            json!({"userId":args.require("user")?}),
        ),
        "group" => {
            args.require("members")?;
            (
                "group.create",
                json!({"name":args.require("name")?,"userIds":args.list("members")}),
            )
        }
        "group-update" => (
            "group.update",
            json!({
                "name":args.get("name"),"add":args.list("add"),"remove":args.get("remove"),"ownerId":args.get("owner"),
                "closed":args.get("close").map(|_| true),
            }),
        ),
        "history" => ("message.history", json!({"before":args.number("before")?})),
        "search" => (
            "message.search",
            json!({"query":args.require("query")?,"before":args.number("before")?}),
        ),
        "send" | "stream-start" => (
            "message.send",
            json!({
                "clientId":request_id(args),"text":args.get("text").unwrap_or_default(),
                "options":{
                    "state":if command == "stream-start" { "streaming" } else { "complete" },
                    "attachmentIds":args.list("attachments"),"mentions":args.list("mentions"),
                    "replyTo":args.get("reply"),"stickerId":args.get("sticker")
                }
            }),
        ),
        "stream-update" => {
            let activities = args
                .get("activities")
                .map(serde_json::from_str::<Value>)
                .transpose()?;
            (
                "message.update",
                json!({
                    "messageId":args.require("message")?,"revision":args.required_number("revision")?,
                    "text":args.get("text").unwrap_or_default(),"state":args.get("status").unwrap_or("streaming"),
                    "activities":activities,
                }),
            )
        }
        "cancel" => (
            "message.cancel",
            json!({"messageId":args.require("message")?}),
        ),
        "request" => {
            let file = fs::File::open(args.require("file")?)?;
            let interaction: Value = serde_json::from_reader(file.take(1024 * 1024))?;
            (
                "message.send",
                json!({
                    "clientId":request_id(args),
                    "text":args.get("text").or_else(|| interaction["title"].as_str()).unwrap_or_default(),
                    "options":{"interaction":interaction},
                }),
            )
        }
        "request-cancel" => (
            "interaction.cancel",
            json!({"messageId":args.require("message")?}),
        ),
        "stickers" => ("stickers.list", Value::Null),
        "sticker-save" => (
            "sticker.save",
            json!({"fileId":args.require("attachments")?}),
        ),
        "sticker-remove" => (
            "sticker.remove",
            json!({"stickerId":args.require("sticker")?}),
        ),
        "upload" => (
            "attachment.upload",
            json!({"path":std::path::absolute(args.require("file")?)?}),
        ),
        "sync" => (
            "events.sync",
            json!({"cursor":args.number("cursor")?.unwrap_or(0),"wait":args.number("wait")?}),
        ),
        "read" => (
            "conversation.markRead",
            json!({"sequence":args.required_number("sequence")?}),
        ),
        _ => anyhow::bail!("未知命令，请运行 agent-space-native --im help"),
    };
    let cid = match command {
        "group-update" | "history" | "search" | "send" | "stream-start" | "stream-update"
        | "cancel" | "request" | "request-cancel" | "sticker-save" | "upload" | "read" => {
            args.require("conversation")?
        }
        _ => "",
    };
    let result = cli_request(client, cid, json!({"method":method,"params":params})).await?;
    Ok(match method {
        "message.send" | "message.update" | "message.cancel" | "interaction.cancel" => {
            json!({"message":result})
        }
        "attachment.upload" => json!({"file":result}),
        _ => result,
    })
}

fn request_id(args: &Arguments<'_>) -> String {
    args.get("request-id")
        .map_or_else(|| Uuid::new_v4().to_string(), str::to_owned)
}

fn missing_file(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<io::Error>()
        .is_some_and(|error| error.kind() == io::ErrorKind::NotFound)
}

async fn register(args: &Arguments<'_>, environment: &Environment, state: &Path) -> Result<Value> {
    let origin = args.origin(environment, None)?;
    let username = args.require("username")?;
    let display_name = args.require("name")?;
    let invitation = environment
        .get("POCKET_IM_INVITATION")
        .filter(|value| !value.is_empty())
        .context("缺少 POCKET_IM_INVITATION")?;
    let (secrets, vault) = new_agent_vault()?;
    let request = agent_http(&origin, None)?
        .post(format!("{origin}/api/im/agents/register"))
        .timeout(Duration::from_secs(15))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(json!({"invitation":invitation,"username":username,"displayName":display_name,"vault":vault}).to_string());
    let parent = state.parent().context("凭据文件路径无效")?;
    if !parent.try_exists()? {
        private_directory(parent)?;
    }
    let mut pending = create_private_file(state)
        .context("无法新建凭据文件，请为新账号使用未占用的 --state 路径")?;
    let next = parent.join(format!(".im-agent-{}.tmp", Uuid::new_v4()));
    let prepare = (|| -> Result<fs::File> {
        serde_json::to_writer(
            &mut pending,
            &json!({
                "origin":origin,"secrets":secrets,"pendingRegistration":true,"username":username,
            }),
        )?;
        pending.sync_all()?;
        create_private_file(&next)
    })();
    drop(pending);
    let mut completed = match prepare {
        Ok(file) => file,
        Err(error) => {
            let _ = fs::remove_file(state);
            return Err(error);
        }
    };
    let response = checked_bytes(request, 64 * 1024)
        .await
        .and_then(|bytes| Ok(serde_json::from_slice::<Value>(&bytes)?));
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            drop(completed);
            let _ = fs::remove_file(&next);
            return Err(error);
        }
    };
    let token = required(&response, "token")?;
    ensure!(
        response["user"]["kind"] == "agent"
            && is_uid(required(&response["user"], "id")?)
            && is_uid(required(&response["owner"], "id")?)
            && response["expiresAt"].is_u64(),
        "服务返回的注册凭据无效"
    );
    serde_json::to_writer_pretty(
        &mut completed,
        &json!({
            "origin":origin,"token":token,"user":response["user"],"owner":response["owner"],
            "expiresAt":response["expiresAt"],"secrets":secrets,
        }),
    )?;
    completed.sync_all()?;
    drop(completed);
    fs::rename(&next, state).with_context(|| format!("已签发凭据保存在 {}", next.display()))?;
    Ok(json!({
        "user":response["user"],"owner":response["owner"],"expiresAt":response["expiresAt"],
        "credentialFile":state,
    }))
}
