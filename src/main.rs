use axum::{
    Router,
    extract::{Path, State, WebSocketUpgrade, ws},
    http::{HeaderMap, Method, StatusCode, Uri, header},
    response::{Html, IntoResponse, Response},
    routing::{any, delete, get},
};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;
use axum::extract::DefaultBodyLimit;

const INDEX_HTML: &str = include_str!("../static/index.html");
const APP_JS: &str = include_str!("../static/app.js");
const PAGE_SIZE: usize = 100;

#[derive(Clone, Serialize, Deserialize)]
struct LoggedRequest {
    id: String,
    timestamp: String,
    method: String,
    url: String,
    headers: String,
    body: String,
    body_size: i64,
}

struct AppState {
    db: Mutex<Connection>,
    tx: broadcast::Sender<String>,
    max_requests: i64,
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3000);
    let max_requests: i64 = std::env::var("MAX_REQUESTS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1000);
    let db_path = std::env::var("DB_PATH").unwrap_or_else(|_| "./data.db".to_string());

    let conn = Connection::open(&db_path).expect("Failed to open SQLite database");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS requests (
            id TEXT PRIMARY KEY,
            timestamp TEXT NOT NULL,
            method TEXT NOT NULL,
            url TEXT NOT NULL,
            headers TEXT NOT NULL,
            body TEXT NOT NULL DEFAULT '',
            body_size INTEGER NOT NULL DEFAULT 0
        )",
    )
    .expect("Failed to create table");

    let (tx, _) = broadcast::channel::<String>(100);

    let state = Arc::new(AppState {
        db: Mutex::new(conn),
        tx,
        max_requests,
    });

    let app = Router::new()
        .route("/", get(serve_index))
        .route("/app.js", get(serve_js))
        .route("/ws", get(ws_handler))
        .route("/api/requests", delete(clear_all))
        .route("/api/requests/{id}", delete(delete_one))
        .route("/hook", any(log_request))
        .layer(DefaultBodyLimit::max(10 * 1024 * 1024))
        .with_state(state);

    let lan_ip = local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string());

    let addr = format!("0.0.0.0:{port}");
    println!("HTTP Logger → http://{lan_ip}:{port}/");

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn serve_index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn serve_js() -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/javascript")],
        APP_JS,
    )
        .into_response()
}

async fn log_request(
    State(state): State<Arc<AppState>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let id = uuid::Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let url = uri.to_string();

    let headers_vec: Vec<(String, String)> = headers
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let headers_json = serde_json::to_string(&headers_vec).unwrap_or_else(|_| "[]".to_string());

    let body_size = body.len() as i64;
    let body_b64 = BASE64.encode(&body);

    let req = LoggedRequest {
        id,
        timestamp,
        method: method.to_string(),
        url,
        headers: headers_json,
        body: body_b64,
        body_size,
    };

    {
        let db = state.db.lock().unwrap();
        db.execute(
            "INSERT INTO requests (id, timestamp, method, url, headers, body, body_size) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![req.id, req.timestamp, req.method, req.url, req.headers, req.body, req.body_size],
        ).ok();

        // Enforce MAX_REQUESTS — delete oldest beyond limit
        db.execute(
            "DELETE FROM requests WHERE id IN (SELECT id FROM requests ORDER BY timestamp DESC LIMIT -1 OFFSET ?1)",
            rusqlite::params![state.max_requests],
        ).ok();
    }

    let msg = json!({"type": "new", "request": req}).to_string();
    let _ = state.tx.send(msg);

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        r#"{"ok":1}"#,
    )
}

async fn clear_all(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    {
        let db = state.db.lock().unwrap();
        db.execute("DELETE FROM requests", []).ok();
    }
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        r#"{"ok":1}"#,
    )
}

async fn delete_one(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    {
        let db = state.db.lock().unwrap();
        db.execute("DELETE FROM requests WHERE id = ?1", rusqlite::params![id])
            .ok();
    }
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        r#"{"ok":1}"#,
    )
}

async fn ws_handler(
    State(state): State<Arc<AppState>>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

async fn handle_ws(mut socket: ws::WebSocket, state: Arc<AppState>) {
    // Subscribe to broadcast FIRST (race condition fix)
    let mut rx = state.tx.subscribe();

    // Load initial history
    let (requests, total) = load_history(&state, None);
    let history_msg = json!({
        "type": "history",
        "requests": requests,
        "total": total,
    })
    .to_string();

    if socket.send(ws::Message::Text(history_msg.into())).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            // Broadcast messages (new requests)
            result = rx.recv() => {
                match result {
                    Ok(msg) => {
                        if socket.send(ws::Message::Text(msg.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // Close connection, client will reconnect
                        break;
                    }
                    Err(_) => break,
                }
            }
            // Client messages
            result = socket.recv() => {
                match result {
                    Some(Ok(ws::Message::Text(text))) => {
                        if let Ok(cmd) = serde_json::from_str::<serde_json::Value>(&text) {
                            if cmd.get("type").and_then(|t| t.as_str()) == Some("load_more") {
                                if let Some(before) = cmd.get("before").and_then(|b| b.as_str()) {
                                    let (requests, total) = load_history(&state, Some(before.to_string()));
                                    let msg = json!({
                                        "type": "history",
                                        "requests": requests,
                                        "total": total,
                                    }).to_string();
                                    if socket.send(ws::Message::Text(msg.into())).await.is_err() {
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    Some(Ok(ws::Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }
}

fn load_history(state: &AppState, before: Option<String>) -> (Vec<LoggedRequest>, i64) {
    let db = state.db.lock().unwrap();

    let total: i64 = db
        .query_row("SELECT COUNT(*) FROM requests", [], |row| row.get(0))
        .unwrap_or(0);

    let requests = if let Some(before_ts) = before {
        let mut stmt = db
            .prepare(
                "SELECT id, timestamp, method, url, headers, body, body_size FROM requests WHERE timestamp < ?1 ORDER BY timestamp DESC LIMIT ?2",
            )
            .unwrap();
        stmt.query_map(rusqlite::params![before_ts, PAGE_SIZE as i64], map_row)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    } else {
        let mut stmt = db
            .prepare(
                "SELECT id, timestamp, method, url, headers, body, body_size FROM requests ORDER BY timestamp DESC LIMIT ?1",
            )
            .unwrap();
        stmt.query_map(rusqlite::params![PAGE_SIZE as i64], map_row)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    };

    (requests, total)
}

fn map_row(row: &rusqlite::Row) -> rusqlite::Result<LoggedRequest> {
    Ok(LoggedRequest {
        id: row.get(0)?,
        timestamp: row.get(1)?,
        method: row.get(2)?,
        url: row.get(3)?,
        headers: row.get(4)?,
        body: row.get(5)?,
        body_size: row.get(6)?,
    })
}
