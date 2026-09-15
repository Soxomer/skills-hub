use mockito::Matcher;

use super::search_skills_online_inner;

fn json_response() -> String {
    r#"{
  "skills": [
    {
      "name": "react-expert",
      "installs": 203000,
      "source": "vercel-labs/agent-skills"
    },
    {
      "name": "vue-master",
      "installs": 57000,
      "source": "vuejs/vue-skills"
    }
  ],
  "count": 2
}"#
    .to_string()
}

fn json_empty() -> String {
    r#"{"skills": [], "count": 0}"#.to_string()
}

#[test]
fn parses_search_results() {
    let mut server = mockito::Server::new();
    let _m = server
        .mock("GET", "/api/search")
        .match_query(Matcher::AllOf(vec![
            Matcher::UrlEncoded("q".into(), "react".into()),
            Matcher::UrlEncoded("limit".into(), "20".into()),
        ]))
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(json_response())
        .create();

    let out = search_skills_online_inner(&server.url(), "react", 20, "").unwrap();
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].name, "react-expert");
    assert_eq!(out[0].installs, 203000);
    assert_eq!(out[0].source, "vercel-labs/agent-skills");
    assert_eq!(
        out[0].source_url,
        "https://github.com/vercel-labs/agent-skills"
    );
}

#[test]
fn source_url_is_constructed_from_source() {
    let mut server = mockito::Server::new();
    let _m = server
        .mock("GET", "/api/search")
        .match_query(Matcher::AllOf(vec![
            Matcher::UrlEncoded("q".into(), "vue".into()),
            Matcher::UrlEncoded("limit".into(), "5".into()),
        ]))
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(json_response())
        .create();

    let out = search_skills_online_inner(&server.url(), "vue", 5, "").unwrap();
    assert_eq!(out[1].source_url, "https://github.com/vuejs/vue-skills");
}

#[test]
fn http_error_returns_error() {
    let mut server = mockito::Server::new();
    let _m = server
        .mock("GET", "/api/search")
        .with_status(500)
        .with_body("internal error")
        .create();

    let err = search_skills_online_inner(&server.url(), "test", 10, "").unwrap_err();
    let msg = format!("{:#}", err);
    assert!(msg.contains("skills.sh search returned error"), "{}", msg);
}

#[test]
fn empty_results() {
    let mut server = mockito::Server::new();
    let _m = server
        .mock("GET", "/api/search")
        .match_query(Matcher::AllOf(vec![
            Matcher::UrlEncoded("q".into(), "nonexistent".into()),
            Matcher::UrlEncoded("limit".into(), "10".into()),
        ]))
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(json_empty())
        .create();

    let out = search_skills_online_inner(&server.url(), "nonexistent", 10, "").unwrap();
    assert!(out.is_empty());
}
