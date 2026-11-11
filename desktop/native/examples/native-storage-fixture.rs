use serde_json::{Value, json};
use std::{
    env, fs,
    io::{self, BufRead, Read, Write},
    path::PathBuf,
};
use uuid::Uuid;

fn main() -> anyhow::Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut state = PathBuf::new();
    let mut relay = String::new();
    loop {
        let mut header = String::new();
        if input.read_line(&mut header)? == 0 {
            return Ok(());
        }
        let length = header
            .trim_end()
            .strip_prefix("Content-Length: ")
            .unwrap()
            .parse()?;
        let mut delimiter = [0; 2];
        input.read_exact(&mut delimiter)?;
        assert_eq!(&delimiter, b"\r\n");
        let mut body = vec![0; length];
        input.read_exact(&mut body)?;
        let request: Value = serde_json::from_slice(&body)?;
        let params = &request["params"];
        let object = || {
            let (prefix, id) = params["key"].as_str().unwrap().rsplit_once('/').unwrap();
            assert_eq!(prefix, "fixture/private-encrypted-v2");
            Uuid::parse_str(id).unwrap()
        };
        let result = match request["method"].as_str().unwrap() {
            "adapter/check" => json!({"sdk":1}),
            "adapter/initialize" => {
                assert_eq!(params["config"]["purpose"], "media");
                assert_eq!(params["config"]["settings"]["token"], "fixture-only");
                assert!(env::var_os("POCKET_NATIVE_ENROLLMENT").is_none());
                state = PathBuf::from(params["stateDirectory"].as_str().unwrap());
                relay = params["config"]["origin"].as_str().unwrap().to_owned();
                json!({"sdk":1})
            }
            "adapter/status" => json!({"info":{},"status":{}}),
            "storage/info" => json!({
                "version":1,"visibility":"private","uploadOrigins":["https://uploads.example.org"],"remove":true,
            }),
            "storage/createUpload" => {
                let id = object();
                assert!(params["expiresAt"].as_u64().is_some());
                if params["size"].as_u64().unwrap() > 128 {
                    json!({"url":format!("https://uploads.example.org/{id}?signed=fixture"),
                        "method":"PUT","encoding":"raw","headers":{"Content-Type":"application/octet-stream"}})
                } else {
                    json!({"url":"https://uploads.example.org/","method":"POST","encoding":"multipart",
                        "fields":{"key":params["key"],"policy":"fixture"},"fileField":"file"})
                }
            }
            "storage/putFile" => {
                let id = object();
                let file = PathBuf::from(params["file"].as_str().unwrap());
                assert_eq!(file.parent(), Some(state.as_path()));
                assert_eq!(params["contentType"], "application/octet-stream");
                assert_eq!(params["allowedOrigin"], relay);
                assert!(params["expiresAt"].as_u64().is_some());
                fs::copy(file, state.join(id.to_string()))?;
                json!("created")
            }
            "storage/downloadUrl" => {
                assert!(params["expiresAt"].as_u64().is_some());
                json!(format!(
                    "https://objects.example.org/{}?signed=fixture",
                    object()
                ))
            }
            "storage/remove" => {
                fs::remove_file(state.join(object().to_string()))?;
                json!({"ok":true})
            }
            method => anyhow::bail!("Unexpected fixture request {method}"),
        };
        let response = serde_json::to_vec(&json!({
            "jsonrpc":"2.0","id":request["id"],"generation":params["generation"],"result":result,
        }))?;
        write!(output, "Content-Length: {}\r\n\r\n", response.len())?;
        output.write_all(&response)?;
        output.flush()?;
    }
}
