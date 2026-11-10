use super::*;
use crate::{
    files::Scope,
    migration,
    state::{Store, private_directory},
};
use sha2::{Digest, Sha256};
use std::{
    io::{Seek, SeekFrom, Write},
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

fn fixture_storage(address: std::net::SocketAddr) -> Result<Storage> {
    let endpoint = format!("http://{address}");
    let http = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()?;
    Storage::new(
        Provider::Qiniu(Qiniu {
            http,
            upload_override: None,
            endpoints: OnceCell::new_with(Some(Endpoints {
                upload: Url::parse(&endpoint)?,
                resource: Url::parse(&endpoint)?,
            })),
            download: Url::parse(&endpoint)?,
            access_key: "fixture".into(),
            secret: hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, b"fixture secret"),
            bucket: "fixture".into(),
        }),
        &|key| (key == "POCKET_NATIVE_STORAGE_BATCH_MIB").then(|| "1".into()),
    )
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
    let blocks = [
        vec![16; BLOCK],
        vec![27; BLOCK],
        vec![38; BLOCK],
        b"existing private object".to_vec(),
    ];
    let bytes = blocks.concat();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let hashes = blocks
        .iter()
        .map(|block| format!("{:x}", Sha256::digest(block)))
        .collect::<Vec<_>>();
    let part_directory = uploads.join(transfer.to_string());
    private_directory(&uploads)?;
    private_directory(&part_directory)?;
    private_directory(&transfers)?;
    let expires = now() + 86_400_000;
    let manifest = json!({
        "id":transfer,"name":"old.txt","size":bytes.len(),"sha256":digest,
        "hashes":hashes,"version":Uuid::new_v4(),"key":STANDARD.encode([73;32]),
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
    let part = part_directory.join("old.txt.part");
    let mut old_file = private_file(&part, true)?;
    old_file.seek(SeekFrom::Start(BLOCK as u64))?;
    old_file.write_all(&blocks[1])?;
    drop(old_file);
    let old_bytes = std::fs::read(&part)?;
    private_json(
        &transfers.join(format!("{transfer}.json")),
        &json!({
            "manifest":manifest,"file":part,"device":device,
            "thread":thread,"direction":"up","present":[1],"expires":expires,
        }),
    )?;
    let record_path = transfers.join(format!("{object}.object"));
    let key = format!("codex-pocket/private-encrypted-v2/{object}");
    let record =
        json!({"id":object,"key":key,"transfer":transfer,"indices":[0,1,2,3],"expires":expires});
    private_json(&record_path, &record)?;
    migration::import(&legacy, &state, None)?;
    migration::initialize(&state)?;
    let db = Arc::new(Mutex::new(Store::open(&state)?));

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let mut ciphertext = Vec::new();
    for (index, bytes) in blocks.into_iter().enumerate() {
        ciphertext.extend(encrypt(&manifest, index, bytes)?);
    }
    let requests = Arc::new(AtomicUsize::new(0));
    let cleanup = Arc::new(AtomicUsize::new(0));
    let reads = requests.clone();
    let deletes = cleanup.clone();
    let fixture = tokio::spawn(async move {
        let full = BLOCK + aead::MAX_TAG_LEN;
        let ranges = [
            0..full,
            0..full,
            2 * full..3 * full,
            2 * full..3 * full,
            3 * full..ciphertext.len(),
        ];
        while let Ok((socket, _)) = listener.accept().await {
            let mut socket = BufReader::new(socket);
            let mut first = String::new();
            socket.read_line(&mut first).await?;
            let mut range_header = String::new();
            let mut line = String::new();
            loop {
                line.clear();
                if socket.read_line(&mut line).await? == 0 || line == "\r\n" {
                    break;
                }
                if line.to_ascii_lowercase().starts_with("range: ") {
                    range_header = line["range: ".len()..].trim().to_owned();
                }
            }
            if first.starts_with("POST /delete/") {
                deletes.fetch_add(1, Ordering::SeqCst);
                socket
                    .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                    .await?;
                continue;
            }
            assert!(first.starts_with(&format!("GET /{key}?e=")));
            assert!(first.contains("&token=fixture:"));
            let attempt = reads.fetch_add(1, Ordering::SeqCst);
            let range = ranges[attempt].clone();
            assert_eq!(
                range_header,
                format!("bytes={}-{}", range.start, range.end - 1)
            );
            if attempt == 4 {
                // The provider switches to a full response after serving an earlier range.
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            ciphertext.len()
                        )
                        .as_bytes(),
                    )
                    .await?;
                socket.write_all(&ciphertext).await?;
                continue;
            }
            let start = range.start + usize::from(attempt == 2);
            socket.write_all(format!(
                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                range.end - 1, ciphertext.len(), range.len(),
            ).as_bytes()).await?;
            if attempt != 2 {
                let mut body = ciphertext[range].to_vec();
                if attempt == 0 {
                    body[0] ^= 1;
                }
                socket.write_all(&body).await?;
            }
        }
        Ok::<_, std::io::Error>(())
    });
    let storage = fixture_storage(address)?;
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
        ("indices", json!([4])),
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
    let invalid_range = resume(device.clone(), scope.clone()).await.unwrap_err();
    assert!(invalid_range.to_string().contains("字节范围"));
    assert_eq!(requests.load(Ordering::SeqCst), 3);
    let staged =
        db.lock()
            .unwrap()
            .file_request(&device, &scope, transfer, "missing", None, &[])?;
    assert_eq!(staged["missing"], json!([2, 3]));
    assert_eq!(
        resume(device.clone(), scope.clone()).await?,
        json!({"ok":true})
    );
    assert_eq!(
        resume(device.clone(), scope.clone()).await?,
        json!({"ok":true})
    );
    assert_eq!(requests.load(Ordering::SeqCst), 5);
    assert_eq!(cleanup.load(Ordering::SeqCst), 1);
    assert_eq!(std::fs::read(part)?, old_bytes);
    let path = db
        .lock()
        .unwrap()
        .file_request(&device, &scope, transfer, "finish", None, &[])?;
    assert_eq!(std::fs::read(path["path"].as_str().unwrap())?, bytes);
    assert_eq!(std::fs::read(record_path)?, serde_json::to_vec(&record)?);
    fixture.abort();
    Ok(())
}

#[test]
fn inherits_only_enabled_legacy_media_and_transport_settings() -> Result<()> {
    let temp = TempState(std::env::temp_dir().join(format!("native-transport-{}", Uuid::new_v4())));
    let source = temp.0.join("node");
    let target = temp.0.join("rust");
    private_directory(&temp.0)?;
    private_directory(&source)?;
    private_directory(&target)?;
    let old = source.join("gateway.env");
    let mut file = private_file(&old, true)?;
    file.write_all(b"POCKET_MEDIA_BUCKET=legacy-bucket\nPOCKET_P2P=0\nUNRELATED=ignored\n")?;
    drop(file);
    let disabled = migrated_transport_settings(&target, Some(&source))?;
    assert_eq!(disabled, HashMap::from([("POCKET_P2P".into(), "0".into())]));
    let explicit = transport_settings(private_file(&old, false)?, true)?;
    assert_eq!(explicit["POCKET_MEDIA_BUCKET"], "legacy-bucket");

    let mut file = private_file(&target.join("gateway.env"), true)?;
    file.write_all(b"POCKET_MEDIA_ADAPTER=/old/adapter.mjs\nPOCKET_MEDIA_BUCKET=migrated-bucket\nPOCKET_STUN_URLS=stun:stun.example.org\n")?;
    drop(file);
    let migrated = migrated_transport_settings(&target, Some(&source))?;
    assert_eq!(
        migrated,
        HashMap::from([
            ("POCKET_MEDIA_BUCKET".into(), "migrated-bucket".into()),
            ("POCKET_STUN_URLS".into(), "stun:stun.example.org".into()),
        ])
    );
    Ok(())
}

#[tokio::test]
async fn discovers_provider_endpoints_and_requires_a_private_bucket() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let control = Url::parse(&format!("http://{address}/"))?;
    let get = |name: &str| {
        Some(
            match name {
                "POCKET_MEDIA_ORIGIN" => "https://private.example.org",
                "POCKET_MEDIA_BUCKET" => "fixture-bucket",
                "POCKET_QINIU_ACCESS_KEY" => "fixture-key",
                "POCKET_QINIU_SECRET_KEY" => "fixture-secret",
                _ => return None,
            }
            .into(),
        )
    };
    let mut storage = Storage::qiniu(None, &get)?;
    let Provider::Qiniu(qiniu) = &mut Arc::get_mut(&mut storage.inner).unwrap().provider else {
        unreachable!()
    };
    let secret = hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, b"fixture-secret");
    let fixture = tokio::spawn(async move {
        for private in [0, 1, 1] {
            for management in [false, true] {
                let (socket, _) = listener.accept().await?;
                let mut socket = BufReader::new(socket);
                let mut start = String::new();
                socket.read_line(&mut start).await?;
                let mut authorization = String::new();
                let mut date = String::new();
                let mut content_type = String::new();
                let mut line = String::new();
                loop {
                    line.clear();
                    if socket.read_line(&mut line).await? == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some((name, value)) = line.trim().split_once(": ") {
                        match name.to_ascii_lowercase().as_str() {
                            "authorization" => authorization = value.to_owned(),
                            "x-qiniu-date" => date = value.to_owned(),
                            "content-type" => content_type = value.to_owned(),
                            _ => {}
                        }
                    }
                }
                let data = if management {
                    assert!(start.starts_with("POST /v2/bucketInfo?bucket=fixture-bucket "));
                    assert_eq!(content_type, "application/x-www-form-urlencoded");
                    assert!(
                        regex::Regex::new(r"^\d{8}T\d{6}Z$")
                            .unwrap()
                            .is_match(&date)
                    );
                    let signed = format!(
                        "POST /v2/bucketInfo?bucket=fixture-bucket\nHost: {address}\nContent-Type: {content_type}\nX-Qiniu-Date: {date}\n\n"
                    );
                    let signature = URL_SAFE.encode(hmac::sign(&secret, signed.as_bytes()));
                    assert_eq!(authorization, format!("Qiniu fixture-key:{signature}"));
                    json!({"private":private})
                } else {
                    assert!(
                        start.starts_with("GET /v4/query?ak=fixture-key&bucket=fixture-bucket ")
                    );
                    assert!(authorization.is_empty());
                    json!({"hosts":[{
                        "up":{"domains":["upload.qiniup.com.invalid", "up-z0.qiniup.com"]},
                        "rs":{"domains":["rs-z0.qiniuapi.com"]},
                    }]})
                };
                let body = data.to_string();
                socket.write_all(format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len(),
                ).as_bytes()).await?;
            }
        }
        Ok::<_, std::io::Error>(())
    });
    let failure = qiniu
        .discover(&control)
        .await
        .err()
        .context("Public bucket was accepted")?;
    assert!(failure.to_string().contains("必须为私有"));
    let region = qiniu.discover(&control).await?;
    assert_eq!(region.upload.as_str(), "https://up-z0.qiniup.com/");
    assert_eq!(region.resource.as_str(), "https://rs-z0.qiniuapi.com/");
    qiniu.upload_override = Some(Url::parse("https://uploads.example.org/")?);
    let overridden = qiniu.discover(&control).await?;
    assert_eq!(overridden.upload.as_str(), "https://uploads.example.org/");
    fixture.await??;
    Ok(())
}

#[test]
fn upgrades_a_legacy_grant_deadline_exactly_once() -> Result<()> {
    let mut db = rusqlite::Connection::open_in_memory()?;
    db.execute_batch(
        "CREATE TABLE native_storage_objects (
           id TEXT PRIMARY KEY, device TEXT NOT NULL, thread TEXT NOT NULL, transfer TEXT NOT NULL,
           indices TEXT NOT NULL, download INTEGER NOT NULL, expires INTEGER NOT NULL
         );",
    )?;
    let grant = now() - 300_000;
    db.execute(
        "INSERT INTO native_storage_objects VALUES ('old','phone','thread','transfer','[0]',0,?1)",
        [grant],
    )?;
    for _ in 0..2 {
        initialize_receipts(&mut db)?;
        let receipt = db.query_row(
            "SELECT expires,grant_expires,indices FROM native_storage_objects WHERE id='old'",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )?;
        assert_eq!(
            receipt,
            (grant + OBJECT_TTL_MS - GRANT_TTL_MS, grant, "[0]".into())
        );
    }
    Ok(())
}

#[tokio::test]
async fn imports_after_grant_expiry_and_retries_cleanup() -> Result<()> {
    let temp = TempState(std::env::temp_dir().join(format!("native-receipts-{}", Uuid::new_v4())));
    private_directory(&temp.0)?;
    let device = "old-device";
    let scope = Scope::codex(crate::codex_backend::ID, Uuid::new_v4());
    let bytes = b"uploaded before the phone grant expired";
    let hash = format!("{:x}", Sha256::digest(bytes));
    let mut store = Store::open(&temp.0)?;
    let manifest = store.begin_upload(
        device,
        &scope,
        json!({"name":"new.txt","size":bytes.len(),"sha256":hash,"hashes":[hash]}),
        Some(1),
    )?;
    let transfer = Uuid::parse_str(manifest["id"].as_str().unwrap())?;
    let db = Arc::new(Mutex::new(store));

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let storage = fixture_storage(listener.local_addr()?)?;
    let grant = storage
        .handle(
            db.clone(),
            device.into(),
            scope.clone(),
            transfer,
            "storage-plan",
            &json!({"indices":[0]}),
        )
        .await?;
    let object = Uuid::parse_str(grant["objectId"].as_str().unwrap())?;
    let stale = Uuid::new_v4();
    {
        let store = db.lock().unwrap();
        let duration = store.db.query_row(
            "SELECT expires-grant_expires FROM native_storage_objects WHERE id=?1",
            [object.to_string()],
            |row| row.get::<_, i64>(0),
        )?;
        assert_eq!(duration, OBJECT_TTL_MS - GRANT_TTL_MS);
        store.db.execute(
            "UPDATE native_storage_objects SET grant_expires=?1 WHERE id=?2",
            params![now() - 1, object.to_string()],
        )?;
        store.record_storage_object(stale, device, &scope, transfer, &[0], false)?;
        store.db.execute(
            "UPDATE native_storage_objects SET expires=?1 WHERE id=?2",
            params![now() - 1, stale.to_string()],
        )?;
    }
    drop(db);
    let db = Arc::new(Mutex::new(Store::open(&temp.0)?));
    let key = storage.inner.key(object);
    let delete = |id| {
        format!(
            "POST /delete/{} ",
            URL_SAFE.encode(format!("fixture:{}", storage.inner.key(id))),
        )
    };
    let delete_stale = delete(stale);
    let delete_imported = delete(object);
    let ciphertext = encrypt(&manifest, 0, bytes.to_vec())?;
    let fixture = tokio::spawn(async move {
        let size = ciphertext.len();
        for attempt in 0..4 {
            let (socket, _) = listener.accept().await?;
            let mut socket = BufReader::new(socket);
            let mut first = String::new();
            socket.read_line(&mut first).await?;
            let mut line = String::new();
            let mut range = String::new();
            loop {
                line.clear();
                if socket.read_line(&mut line).await? == 0 || line == "\r\n" {
                    break;
                }
                if line.to_ascii_lowercase().starts_with("range: ") {
                    range = line["range: ".len()..].trim().to_owned();
                }
            }
            match attempt {
                0 | 1 => assert!(first.starts_with(&delete_stale)),
                2 => {
                    assert!(first.starts_with(&format!("GET /{key}?")));
                    assert_eq!(range, format!("bytes=0-{}", size - 1));
                }
                _ => assert!(first.starts_with(&delete_imported)),
            }
            let response = match attempt {
                0 => "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
                2 => format!("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-{}/{size}\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n", size-1),
                _ => "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".into(),
            };
            socket.write_all(response.as_bytes()).await?;
            if attempt == 2 {
                socket.write_all(&ciphertext).await?;
            }
        }
        Ok::<_, std::io::Error>(())
    });
    let count = || {
        db.lock()
            .unwrap()
            .db
            .query_row("SELECT count(*) FROM native_storage_objects", [], |row| {
                row.get::<_, i64>(0)
            })
    };
    storage.remove_expired_batch(&db, "").await?;
    assert_eq!(count()?, 2);
    storage.remove_expired_batch(&db, "").await?;
    assert_eq!(count()?, 1);
    let imported = storage
        .handle(
            db.clone(),
            device.into(),
            scope.clone(),
            transfer,
            "storage-import",
            &json!({"objectId":object}),
        )
        .await?;
    assert_eq!(imported, json!({"ok":true}));
    assert_eq!(count()?, 0);
    let complete =
        db.lock()
            .unwrap()
            .file_request(device, &scope, transfer, "finish", None, &[])?;
    assert_eq!(std::fs::read(complete["path"].as_str().unwrap())?, bytes);
    fixture.await??;
    Ok(())
}
