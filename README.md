# Neo HTTP Logger

A lightweight HTTP request inspector and logger with a real-time web UI. Send any HTTP request to the `/hook` endpoint and instantly see it in the browser — method, URL, headers, and body.

![Screenshot](assets/screenshot.png)

## Install

```bash
cargo install --git https://github.com/sergazin/neo_http_logger
```

## Features

- **Catch-all endpoint** — `POST /hook`, `GET /hook`, `PUT /hook`, etc. Any method works
- **Real-time updates** — WebSocket pushes new requests to the UI instantly
- **Body parsing** — JSON (syntax-highlighted tree), form-urlencoded, multipart/form-data, images, PDF, plain text, binary
- **Persistent storage** — SQLite database with configurable max request limit (auto-evicts oldest)
- **Download bodies** — download the raw request body with correct filename/extension
- **Infinite scroll** — paginated loading of request history
- **Delete** — remove individual requests or clear all

## Quick Start

```bash
cargo run
```

Open `http://localhost:3000/` in your browser, then send a test request:

```bash
curl -X POST http://localhost:3000/hook \
  -H "Content-Type: application/json" \
  -d '{"hello":"world"}'
```

## Configuration

Environment variables (or `.env` file):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `MAX_REQUESTS` | `1000` | Max stored requests (oldest auto-deleted) |
| `DB_PATH` | `./data.db` | SQLite database file path |

## API

| Endpoint | Method | Description |
|---|---|---|
| `/hook` | ANY | Log an incoming HTTP request |
| `/` | GET | Web UI |
| `/ws` | GET | WebSocket for real-time updates |
| `/api/requests` | DELETE | Clear all logged requests |
| `/api/requests/{id}` | DELETE | Delete a single request |

## Tech Stack

- **Rust** — Axum + Tokio async runtime
- **SQLite** — via rusqlite (bundled)
- **Frontend** — Vanilla JS + Tailwind CSS + Boxicons
- **WebSocket** — broadcast channel for real-time push

## Project Structure

```
src/main.rs       — Server: routes, WebSocket handler, SQLite storage
static/index.html — Web UI layout (Tailwind CSS)
static/app.js     — Frontend logic: WebSocket client, rendering, body parsing
```
