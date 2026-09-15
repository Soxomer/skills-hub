use super::fetch_featured_skills_inner;
use crate::skill_store::SkillStore;

fn temp_store() -> SkillStore {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("test.db");
    let store = SkillStore::new(db_path);
    store.ensure_schema().unwrap();
    // Leak the tempdir so it stays alive for the duration of the test.
    std::mem::forget(dir);
    store
}

fn json_payload() -> String {
    r#"{
  "updated_at": "2026-01-01T00:00:00Z",
  "skills": [
    {
      "slug": "foo",
      "name": "Foo Skill",
      "summary": "Does foo",
      "downloads": 100,
      "stars": 10,
      "source_url": "https://github.com/openclaw/skills/tree/main/skills/user/foo"
    },
    {
      "slug": "bar",
      "name": "Bar Skill",
      "summary": "Does bar",
      "downloads": 50,
      "stars": 5,
      "source_url": ""
    }
  ]
}"#
    .to_string()
}

#[test]
fn parses_and_filters_empty_source_url() {
    let mut server = mockito::Server::new();
    let _m = server
        .mock("GET", "/featured.json")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(json_payload())
        .create();

    let store = temp_store();
    let url = format!("{}/featured.json", server.url());
    let skills = fetch_featured_skills_inner(&url, &store).unwrap();

    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].slug, "foo");
    assert_eq!(skills[0].downloads, 100);
}

#[test]
fn falls_back_to_cache_on_http_failure() {
    let store = temp_store();

    // Pre-populate cache
    store
        .set_setting("featured_skills_cache", &json_payload())
        .unwrap();

    let mut server = mockito::Server::new();
    let _m = server
        .mock("GET", "/featured.json")
        .with_status(500)
        .with_body("error")
        .create();

    let url = format!("{}/featured.json", server.url());
    let skills = fetch_featured_skills_inner(&url, &store).unwrap();
    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].slug, "foo");
}

#[test]
fn falls_back_to_bundled_on_total_failure() {
    let store = temp_store();

    let mut server = mockito::Server::new();
    let _m = server
        .mock("GET", "/featured.json")
        .with_status(500)
        .with_body("error")
        .create();

    let url = format!("{}/featured.json", server.url());
    let skills = fetch_featured_skills_inner(&url, &store).unwrap();
    // Should not panic — returns bundled data (may or may not be empty
    // depending on the current bundled JSON, but should not error).
    let _ = skills.len();
}

#[test]
fn falls_back_to_bundled_on_malformed_json() {
    let store = temp_store();

    let mut server = mockito::Server::new();
    let _m = server
        .mock("GET", "/featured.json")
        .with_status(200)
        .with_body("not json")
        .create();

    let url = format!("{}/featured.json", server.url());
    // No cache, malformed body → falls back to bundled JSON gracefully
    let skills = fetch_featured_skills_inner(&url, &store).unwrap();
    let _ = skills.len();
}
