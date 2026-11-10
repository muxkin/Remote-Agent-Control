use super::{Qiniu, origin};
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::time::Duration;
use url::{Position, Url};

pub(super) struct Endpoints {
    pub(super) upload: Url,
    pub(super) resource: Url,
}

impl Qiniu {
    pub(super) async fn endpoints(&self) -> Result<&Endpoints> {
        self.endpoints
            .get_or_try_init(|| async {
                self.discover(&Url::parse("https://uc.qiniuapi.com/")?)
                    .await
            })
            .await
    }

    pub(super) async fn discover(&self, control: &Url) -> Result<Endpoints> {
        let mut query = control.join("v4/query")?;
        query
            .query_pairs_mut()
            .append_pair("ak", &self.access_key)
            .append_pair("bucket", &self.bucket);
        let regions = response_json(self.http.get(query)).await?;
        let host = regions["hosts"].get(0).context("七牛未返回存储区域")?;
        let upload = match &self.upload_override {
            Some(upload) => upload.clone(),
            None => service_origin(host, "up")?,
        };
        let resource = service_origin(host, "rs")?;

        let mut bucket = control.join("v2/bucketInfo")?;
        bucket.query_pairs_mut().append_pair("bucket", &self.bucket);
        let info = response_json(self.management_request(bucket)).await?;
        ensure!(info["private"].as_u64() == Some(1), "七牛附件桶必须为私有");
        Ok(Endpoints { upload, resource })
    }

    pub(super) fn management_request(&self, url: Url) -> reqwest::RequestBuilder {
        const FORM: &str = "application/x-www-form-urlencoded";
        let utc = time::OffsetDateTime::now_utc();
        let date = format!(
            "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
            utc.year(),
            utc.month() as u8,
            utc.day(),
            utc.hour(),
            utc.minute(),
            utc.second(),
        );
        let host = &url[Position::BeforeHost..Position::AfterPort];
        let target = &url[Position::BeforePath..Position::AfterQuery];
        let token = self.sign(&format!(
            "POST {target}\nHost: {host}\nContent-Type: {FORM}\nX-Qiniu-Date: {date}\n\n"
        ));
        self.http
            .post(url)
            .header("Content-Type", FORM)
            .header("X-Qiniu-Date", date)
            .header("Authorization", format!("Qiniu {token}"))
    }
}

fn service_origin(host: &Value, service: &str) -> Result<Url> {
    host[service]["domains"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|domain| {
            domain.len() <= 253
                && domain
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'.'))
                && [".qiniuapi.com", ".qiniup.com", ".qiniu.com", ".qbox.me"]
                    .iter()
                    .any(|suffix| domain.ends_with(suffix))
        })
        .find_map(|domain| origin(&format!("https://{domain}/")).ok())
        .context("七牛未返回可信的区域服务地址")
}

async fn response_json(request: reqwest::RequestBuilder) -> Result<Value> {
    let mut response = request
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("七牛区域或权限查询失败"))?;
    ensure!(response.status().is_success(), "七牛区域或权限查询失败");
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("七牛区域或权限响应读取失败"))?
    {
        ensure!(
            body.len() + chunk.len() <= 64 * 1024,
            "七牛区域或权限响应过大"
        );
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).context("七牛区域或权限响应无效")
}
