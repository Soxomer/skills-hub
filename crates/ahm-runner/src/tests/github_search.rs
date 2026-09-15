use mockito::Matcher;

use super::search_github_repos_inner;

fn json_one_repo() -> String {
    r#"{
  "items": [
    {
      "full_name": "o/r",
      "html_url": "https://example.com/o/r",
      "description": "d",
      "stargazers_count": 123,
      "updated_at": "2020-01-01T00:00:00Z",
      "clone_url": "https://example.com/o/r.git"
    }
  ]
}"#
    .to_string()
}

#[test]
fn limit_is_clamped() {
    let mut server = mockito::Server::new();

    let _m1 = server
        .mock("GET", "/search/repositories")
        .match_query(Matcher::AllOf(vec![
            Matcher::UrlEncoded("q".into(), "hello".into()),
            Matcher::UrlEncoded("per_page".into(), "1".into()),
        ]))
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(json_one_repo())
        .create();

    let out = search_github_repos_inner(&server.url(), "hello", 0, None, "").unwrap();
    assert_eq!(out.len(), 1);

    let _m2 = server
        .mock("GET", "/search/repositories")
        .match_query(Matcher::AllOf(vec![
            Matcher::UrlEncoded("q".into(), "hello".into()),
            Matcher::UrlEncoded("per_page".into(), "50".into()),
        ]))
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(json_one_repo())
        .create();

    let _ = search_github_repos_inner(&server.url(), "hello", 999, None, "").unwrap();
}

#[test]
fn maps_fields() {
    let mut server = mockito::Server::new();
    let _m = server
        .mock("GET", "/search/repositories")
        .match_query(Matcher::AllOf(vec![
            Matcher::UrlEncoded("q".into(), "x".into()),
            Matcher::UrlEncoded("per_page".into(), "2".into()),
        ]))
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(json_one_repo())
        .create();

    let out = search_github_repos_inner(&server.url(), "x", 2, None, "").unwrap();
    assert_eq!(out[0].full_name, "o/r");
    assert_eq!(out[0].stars, 123);
}

#[test]
fn http_error_has_context() {
    let mut server = mockito::Server::new();
    let _m = server
        .mock("GET", "/search/repositories")
        .with_status(500)
        .with_body("oops")
        .create();

    let err = search_github_repos_inner(&server.url(), "x", 2, None, "").unwrap_err();
    let msg = format!("{:#}", err);
    assert!(msg.contains("GitHub search returned error"), "{msg}");
}
