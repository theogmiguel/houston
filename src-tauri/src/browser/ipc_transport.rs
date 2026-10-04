use tauri::http::{Request, Response};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponse, InvokeResponseBody};
use tauri::webview::InvokeRequest;
use tauri::Manager;

const CHILD_REFUSAL: &str = "browser: content-only webviews cannot use the IPC protocol";

// WebView2's native postMessage switch does not disable Tauri's fetch transport.
// Route that protocol through the webview identity guard before any plugin dispatch.
pub(crate) fn install(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_asynchronous_uri_scheme_protocol("ipc", |context, request, responder| {
        if request.method() == "OPTIONS" {
            responder.respond(response(200, "ok", "text/plain", Vec::new()));
            return;
        }
        if super::id::is_content_only_label(context.webview_label()) {
            responder.respond(response(
                403,
                "error",
                "text/plain",
                CHILD_REFUSAL.as_bytes().to_vec(),
            ));
            return;
        }
        let Some(webview) = context.app_handle().get_webview(context.webview_label()) else {
            responder.respond(response(
                404,
                "error",
                "text/plain",
                b"IPC webview is unavailable".to_vec(),
            ));
            return;
        };
        let invocation = match parse_request(request) {
            Ok(invocation) => invocation,
            Err(error) => {
                responder.respond(response(400, "error", "text/plain", error.into_bytes()));
                return;
            }
        };
        // on_message retains Tauri's invoke-key validation and capability checks.
        webview.on_message(
            invocation,
            Box::new(move |_, _, result, _, _| {
                let (verdict, mime, body) = match result {
                    InvokeResponse::Ok(InvokeResponseBody::Json(body)) => {
                        ("ok", "application/json", body.into_bytes())
                    }
                    InvokeResponse::Ok(InvokeResponseBody::Raw(body)) => {
                        ("ok", "application/octet-stream", body)
                    }
                    InvokeResponse::Err(error) => (
                        "error",
                        "application/json",
                        serde_json::to_vec(&error.0).unwrap_or_default(),
                    ),
                };
                responder.respond(response(200, verdict, mime, body));
            }),
        );
    })
}

fn response(status: u16, verdict: &str, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "POST, OPTIONS")
        .header("Access-Control-Allow-Headers", "*")
        .header("Access-Control-Expose-Headers", "Tauri-Response")
        .header("Tauri-Response", verdict)
        .header("Content-Type", mime)
        .body(body)
        .expect("constant IPC response headers are valid")
}

fn parse_request(request: Request<Vec<u8>>) -> Result<InvokeRequest, String> {
    if request.method() != "POST" {
        return Err(format!("IPC method {:?} must be POST", request.method()));
    }
    let (parts, bytes) = request.into_parts();
    let header = |name: &str| -> Result<&str, String> {
        parts
            .headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| format!("IPC requires a valid {name} header"))
    };
    let callback = |name: &str| -> Result<CallbackFn, String> {
        let value = header(name)?;
        value
            .parse()
            .map(CallbackFn)
            .map_err(|_| format!("IPC {name} header {value:?} must be an unsigned callback ID"))
    };
    let content_type = parts
        .headers
        .get("Content-Type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or_default()
        .trim();
    let body = match content_type {
        "application/octet-stream" => InvokeBody::Raw(bytes),
        "application/json" if bytes.is_empty() => InvokeBody::Json(serde_json::json!({})),
        "application/json" => InvokeBody::Json(
            serde_json::from_slice(&bytes)
                .map_err(|error| format!("IPC JSON body is invalid: {error}"))?,
        ),
        other => {
            return Err(format!(
                "IPC content type {other:?} must be application/json or application/octet-stream"
            ))
        }
    };
    Ok(InvokeRequest {
        cmd: percent_encoding::percent_decode_str(parts.uri.path().trim_start_matches('/'))
            .decode_utf8_lossy()
            .into_owned(),
        callback: callback("Tauri-Callback")?,
        error: callback("Tauri-Error")?,
        url: tauri::Url::parse(header("Origin")?)
            .map_err(|error| format!("IPC Origin header must be a URL: {error}"))?,
        invoke_key: header("Tauri-Invoke-Key")?.to_owned(),
        body,
        headers: parts.headers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(mime: &str, body: Vec<u8>) -> Request<Vec<u8>> {
        Request::builder()
            .method("POST")
            .uri("ipc://localhost/plugin%3A__TAURI_CHANNEL__%7Cfetch")
            .header("Origin", "http://tauri.localhost")
            .header("Tauri-Invoke-Key", "fixture-key")
            .header("Tauri-Callback", "1")
            .header("Tauri-Error", "2")
            .header("Content-Type", mime)
            .body(body)
            .unwrap()
    }

    #[test]
    fn preserves_channel_command_and_raw_payload() {
        let invocation = parse_request(request("application/octet-stream", vec![0, 255])).unwrap();
        assert_eq!(invocation.cmd, "plugin:__TAURI_CHANNEL__|fetch");
        assert!(matches!(invocation.body, InvokeBody::Raw(bytes) if bytes == [0, 255]));
        assert_eq!(invocation.invoke_key, "fixture-key");
        assert_eq!(invocation.callback.0, 1);
        assert_eq!(invocation.error.0, 2);
    }

    #[test]
    fn accepts_json_parameters_and_refuses_missing_integrity_header() {
        let invocation = parse_request(request(
            "application/json; charset=utf-8",
            b"{\"value\":1}".to_vec(),
        ))
        .unwrap();
        assert!(
            matches!(invocation.body, InvokeBody::Json(value) if value == serde_json::json!({"value":1}))
        );
        let mut invalid = request("application/json", Vec::new());
        invalid.headers_mut().remove("Tauri-Invoke-Key");
        assert!(parse_request(invalid)
            .unwrap_err()
            .contains("Tauri-Invoke-Key"));
    }

    #[test]
    fn invalid_callback_ids_and_payload_types_are_refused() {
        let mut invalid = request("application/json", Vec::new());
        invalid
            .headers_mut()
            .insert("Tauri-Callback", "not-a-number".parse().unwrap());
        let error = parse_request(invalid).unwrap_err();
        assert!(error.contains("not-a-number") && error.contains("unsigned callback ID"));
        let error = parse_request(request("text/plain", b"payload".to_vec())).unwrap_err();
        assert!(error.contains("text/plain") && error.contains("application/octet-stream"));
    }
}
