use serde_json::{Value, json};
use std::{
    env, fs,
    io::{self, BufRead, Read, Write},
    path::PathBuf,
    thread::sleep,
    time::Duration,
};

fn main() -> anyhow::Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut state = PathBuf::new();
    let mut messages: Vec<Value> = Vec::new();
    loop {
        let mut header = String::new();
        if input.read_line(&mut header)? == 0 {
            return Ok(());
        }
        let length = header
            .trim_end()
            .strip_prefix("Content-Length: ")
            .expect("fixture frame")
            .parse()?;
        let mut delimiter = [0; 2];
        input.read_exact(&mut delimiter)?;
        assert_eq!(&delimiter, b"\r\n");
        let mut body = vec![0; length];
        input.read_exact(&mut body)?;
        let request: Value = serde_json::from_slice(&body)?;
        let params = &request["params"];
        let thread = json!({
            "id":"demo-thread","title":"Native plugin fixture","cwd":"/fixture","updatedAt":1,
            "owner":true,"synchronized":true,"canSend":true,"activeTurnId":null,
            "model":null,"runtimeStatus":"idle","requests":[],"pendingRequests":0
        });
        let result = match request["method"].as_str().unwrap() {
            "adapter/check" => {
                assert_eq!(params["sdk"], 1);
                assert!(env::var_os("POCKET_NATIVE_ENROLLMENT").is_none());
                json!({"sdk":1})
            }
            "adapter/initialize" => {
                match params["packageVersion"].as_str() {
                    Some("1.2.0") => std::process::exit(4),
                    Some("1.1.0") => sleep(Duration::from_millis(500)),
                    _ => {}
                }
                let expected = if params["id"] == "second-fixture" {
                    "second-token"
                } else {
                    "fixture-token"
                };
                assert_eq!(params["config"]["token"], expected);
                assert!(env::var_os("NATIVE_PLUGIN_FIXTURE_TOKEN").is_none());
                assert!(env::var_os("NATIVE_PLUGIN_SECOND_TOKEN").is_none());
                assert!(env::var_os("POCKET_NATIVE_ENROLLMENT").is_none());
                state = PathBuf::from(params["stateDirectory"].as_str().unwrap());
                messages = fs::read(state.join("messages.json"))
                    .ok()
                    .map(|data| serde_json::from_slice(&data).unwrap())
                    .unwrap_or_default();
                json!({"sdk":1})
            }
            "adapter/status" => json!({
                "info":{"connected":true,"profile":"rust-native-plugin","capabilities":{
                    "history":{"state":"supported"},"send":{"state":"supported"}
                }},
                "status":{"connected":true,"writesEnabled":true,"supportedVersion":true,"capabilities":{"send":true}}
            }),
            "adapter/read" => match params["method"].as_str().unwrap() {
                "threads.list" => json!({"threads":[thread],"nextCursor":null}),
                "thread.read" => json!({"thread":thread,"messages":messages}),
                "history.read" => json!({"messages":messages,"nextCursor":null}),
                _ => Value::Null,
            },
            "adapter/view" => {
                assert_eq!(params["thread"], "demo-thread");
                let observations: Vec<_> = messages
                    .iter()
                    .map(|message| {
                        json!({
                            "requestId":message["id"],"turnId":message["id"],"state":"completed",
                        })
                    })
                    .collect();
                json!({"thread":thread,"messages":messages,"observations":observations})
            }
            "adapter/write" => {
                if params["action"].get("Create").is_some() {
                    let progress = serde_json::to_vec(&json!({
                        "jsonrpc":"2.0","method":"adapter/threadCreated","generation":params["generation"],
                        "params":{"requestId":request["id"],"threadId":"created-before-exit"},
                    }))?;
                    write!(output, "Content-Length: {}\r\n\r\n", progress.len())?;
                    output.write_all(&progress)?;
                    output.flush()?;
                    std::process::exit(5);
                }
                assert_eq!(params["thread"], "demo-thread");
                let text = params["action"]["Send"]["text"].as_str().unwrap();
                messages.push(json!({"id":params["requestId"],"role":"user","text":text}));
                let temp = state.join("messages.tmp");
                fs::write(&temp, serde_json::to_vec(&messages)?)?;
                fs::rename(temp, state.join("messages.json"))?;
                if text == "crash-after-write" {
                    std::process::exit(3);
                }
                if text == "slow-write" {
                    let marker = state.join("write-in-flight");
                    fs::write(&marker, b"")?;
                    sleep(Duration::from_millis(3500));
                    fs::remove_file(marker)?;
                }
                json!({"state":"completed"})
            }
            _ => Value::Null,
        };
        let reply = serde_json::to_vec(&json!({
            "jsonrpc":"2.0","id":request["id"],"generation":params["generation"],"result":result,
        }))?;
        write!(output, "Content-Length: {}\r\n\r\n", reply.len())?;
        output.write_all(&reply)?;
        output.flush()?;
    }
}
