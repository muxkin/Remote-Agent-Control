use super::*;
use crate::{
    files::Scope,
    migration,
    state::{Store, private_directory},
};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};

struct TempState(PathBuf);

impl Drop for TempState {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn private_json(path: &Path, data: &Value) -> Result<()> {
    let mut file = private_file(path, true)?;
    file.set_len(0)?;
    file.write_all(&serde_json::to_vec(data)?)?;
    Ok(())
}

#[tokio::test]
async fn resumes_an_existing_node_object_after_state_import() -> Result<()> {
    let temp = TempState(std::env::temp_dir().join(format!("native-storage-{}", Uuid::new_v4())));
    private_directory(&temp.0)?;
    let legacy = temp.0.join("node");
    let state = temp.0.join("rust");
    drop(Store::open(&legacy)?);
    let uploads = legacy.join("uploads");
    let transfers = legacy.join("transfers-v2");
    let transfer = Uuid::new_v4();
    let object = Uuid::new_v4();
    let thread = Uuid::new_v4();
    let scope = Scope::codex(crate::codex_backend::ID, thread);
    let device = Uuid::new_v4().to_string();
    let bytes = b"existing private object";
    let digest = format!("{:x}", Sha256::digest(bytes));
    let part_directory = uploads.join(transfer.to_string());
    private_directory(&uploads)?;
    private_directory(&part_directory)?;
    private_directory(&transfers)?;
    let expires = now() + 86_400_000;
    let manifest = json!({
        "id":transfer,"name":"old.txt","size":bytes.len(),"sha256":digest,
        "hashes":[digest],"version":Uuid::new_v4(),"key":STANDARD.encode([73;32]),
        "nonce":STANDARD.encode([16;8]),"mime":"application/octet-stream","storage":true,
    });
    private_json(
        &uploads.join(format!("{transfer}.json")),
        &json!({
            "id":transfer,"device":device,"thread":thread,"name":"old.txt","size":bytes.len(),
            "sha256":digest,"file":part_directory.join("old.txt"),"complete":false,
            "offset":0,"expires":expires,
        }),
    )?;
    private_json(
        &transfers.join(format!("{transfer}.json")),
        &json!({
            "manifest":manifest,"file":part_directory.join("old.txt.part"),"device":device,
            "thread":thread,"direction":"up","present":[],"expires":expires,
        }),
    )?;
    let record_path = transfers.join(format!("{object}.object"));
    let key = format!("codex-pocket/private-encrypted-v2/{object}");
    let record = json!({"id":object,"key":key,"transfer":transfer,"indices":[0],"expires":expires});
    private_json(&record_path, &record)?;
    migration::import(&legacy, &state, None)?;
    migration::initialize(&state)?;
    let db = Arc::new(Mutex::new(Store::open(&state)?));

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let ciphertext = encrypt(&manifest, 0, bytes.to_vec())?;
    let requests = Arc::new(AtomicUsize::new(0));
    let reads = requests.clone();
    let fixture = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let mut socket = BufReader::new(socket);
            let mut first = String::new();
            socket.read_line(&mut first).await?;
            let mut line = String::new();
            loop {
                line.clear();
                if socket.read_line(&mut line).await? == 0 || line == "\r\n" {
                    break;
                }
            }
            if first.starts_with("CONNECT rs.qiniuapi.com:443 ") {
                socket.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await?;
                continue;
            }
            assert!(first.starts_with(&format!("GET /{key}?e=")));
            assert!(first.contains("&token=fixture:"));
            let mut body = ciphertext.clone();
            if reads.fetch_add(1, Ordering::SeqCst) == 0 {
                body[0] ^= 1;
            }
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await?;
            socket.write_all(&body).await?;
        }
        Ok::<_, std::io::Error>(())
    });
    let endpoint = format!("http://{address}");
    let http = Client::builder()
        .proxy(reqwest::Proxy::https(&endpoint)?)
        .timeout(Duration::from_secs(2))
        .build()?;
    let storage = Storage {
        inner: Arc::new(Qiniu {
            http,
            upload: Url::parse(&endpoint)?,
            download: Url::parse(&endpoint)?,
            access_key: "fixture".into(),
            secret: hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, b"fixture secret"),
            bucket: "fixture".into(),
            prefix: "codex-pocket".into(),
            batch: 1,
            jobs: Semaphore::new(2),
        }),
    };
    let request = json!({"objectId":object});
    let resume = |owner: String, scope: Scope| {
        storage.handle(
            db.clone(),
            owner,
            scope,
            transfer,
            "storage-import",
            &request,
        )
    };
    assert!(
        resume(Uuid::new_v4().to_string(), scope.clone())
            .await
            .is_err()
    );
    assert!(
        resume(
            device.clone(),
            Scope::codex(crate::codex_backend::ID, Uuid::new_v4())
        )
        .await
        .is_err()
    );
    for (field, value) in [
        ("key", json!("different/private-encrypted-v2/object")),
        ("transfer", json!(Uuid::new_v4())),
        ("indices", json!([1])),
        ("expires", json!(now() - 1)),
    ] {
        let mut invalid = record.clone();
        invalid[field] = value;
        private_json(&record_path, &invalid)?;
        assert!(resume(device.clone(), scope.clone()).await.is_err());
    }
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    private_json(&record_path, &record)?;
    assert!(resume(device.clone(), scope.clone()).await.is_err());
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert_eq!(
        resume(device.clone(), scope.clone()).await?,
        json!({"ok":true})
    );
    assert_eq!(
        resume(device.clone(), scope.clone()).await?,
        json!({"ok":true})
    );
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    let path = db
        .lock()
        .unwrap()
        .file_request(&device, &scope, transfer, "finish", None, &[])?;
    assert_eq!(std::fs::read(path["path"].as_str().unwrap())?, bytes);
    assert_eq!(std::fs::read(record_path)?, serde_json::to_vec(&record)?);
    fixture.abort();
    Ok(())
}
