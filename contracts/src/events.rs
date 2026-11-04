//! NEP-297 event log lines, which indexers and our dashboard read.

use near_sdk::env;
use near_sdk::serde_json::{self, json};

pub fn emit_event(standard: &str, version: &str, event: &str, data: serde_json::Value) {
    let payload = json!({
        "standard": standard,
        "version": version,
        "event": event,
        "data": data,
    });
    env::log_str(&format!("EVENT_JSON:{}", payload));
}

/// NEP-171 (NFT) event.
pub fn emit(event: &str, data: serde_json::Value) {
    emit_event("nep171", "1.2.0", event, data);
}