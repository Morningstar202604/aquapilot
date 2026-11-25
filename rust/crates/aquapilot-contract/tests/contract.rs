use std::collections::BTreeSet;

use aquapilot_contract::{all_http_paths, contract};

#[test]
fn contract_counts_are_frozen() {
    let c = contract();
    assert_eq!(c.schema_version, 1);
    assert_eq!(c.http.legacy.len(), 32);
    assert_eq!(c.http.versioned.len(), 9);
    assert_eq!(c.http.public.len(), 3);
    assert_eq!(c.http.meta, ["/api/openapi.json"]);
    assert_eq!(c.http.mcp, ["/mcp"]);
    assert_eq!(c.http.methods, ["GET", "HEAD"]);
    assert_eq!(c.ws.path, "/ws");
    assert_eq!(c.ws.max_payload_bytes, 524288);
    assert_eq!(c.ws.client_types.len(), 19);
    assert_eq!(c.ws.server_types.len(), 14);
}

#[test]
fn public_routes_are_part_of_the_http_surface() {
    let c = contract();
    let all: BTreeSet<&str> = all_http_paths().into_iter().collect();
    for route in &c.http.public {
        assert!(
            all.contains(route.as_str()),
            "public route {route} is missing"
        );
    }
    assert_eq!(c.http.unauthorized_status, 401);
    assert_eq!(c.http.method_not_allowed_status, 405);
    assert_eq!(c.http.unknown_api_status, 404);
}

#[test]
fn every_http_path_is_under_api_or_mcp() {
    for route in all_http_paths() {
        assert!(
            route.starts_with("/api/") || route == "/mcp",
            "unexpected route surface: {route}"
        );
    }
}

#[test]
fn versioned_routes_use_one_path_parameter_style() {
    let c = contract();
    for route in &c.http.versioned {
        assert!(route.starts_with("/api/v1/"), "{route} is not versioned");
        assert!(!route.contains(':'), "{route} uses colon parameters");
        assert!(
            !route.contains('<'),
            "{route} uses angle-bracket parameters"
        );
    }
}

#[test]
fn ws_type_tags_are_unique_and_do_not_collide_within_each_direction() {
    let c = contract();
    for types in [&c.ws.client_types, &c.ws.server_types] {
        let unique: BTreeSet<&str> = types.iter().map(String::as_str).collect();
        assert_eq!(unique.len(), types.len(), "duplicate WS type tag");
    }
}

#[test]
fn source_hashes_are_sha256_and_cover_the_server_surface() {
    let c = contract();
    assert_eq!(c.sources.len(), 8);
    for (path, hash) in &c.sources {
        assert!(path.starts_with("src/"), "unexpected source path {path}");
        assert_eq!(hash.len(), 64, "{path} hash is not sha256 hex");
        assert!(
            hash.chars().all(|ch| ch.is_ascii_hexdigit()),
            "{path} hash contains non-hex characters"
        );
    }
    assert!(c.sources.contains_key("src/server/apiRoutes.ts"));
    assert!(c.sources.contains_key("src/server/index.ts"));
    assert!(c.sources.contains_key("src/shared/protocol.ts"));
}
