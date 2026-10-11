use url::Url;

#[derive(Clone)]
pub struct Pairing {
    pub code: String,
    pub server: String,
}

pub fn parse(value: &str) -> Result<Pairing, &'static str> {
    let invalid = "invalidLink";
    if value.len() > 2048 {
        return Err(invalid);
    }
    let link = Url::parse(value).map_err(|_| invalid)?;
    if link.scheme() != "ahm"
        || link.host_str() != Some("connect")
        || !link.username().is_empty()
        || link.password().is_some()
        || link.port().is_some()
        || link.fragment().is_some()
        || !matches!(link.path(), "" | "/")
    {
        return Err(invalid);
    }
    let pairs: Vec<_> = link.query_pairs().collect();
    if pairs.len() != 2 {
        return Err(invalid);
    }
    let code: Vec<_> = pairs.iter().filter(|(k, _)| k == "code").collect();
    let server: Vec<_> = pairs.iter().filter(|(k, _)| k == "server").collect();
    if code.len() != 1 || server.len() != 1 {
        return Err(invalid);
    }
    let code = code[0].1.to_string();
    if !(16..=256).contains(&code.len())
        || !code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(invalid);
    }
    let server = Url::parse(&server[0].1).map_err(|_| invalid)?;
    if server.scheme() != "https"
        || server.host_str().is_none()
        || !server.username().is_empty()
        || server.password().is_some()
        || server.port().is_some()
        || server.path() != "/"
        || server.query().is_some()
        || server.fragment().is_some()
    {
        return Err(invalid);
    }
    Ok(Pairing {
        code,
        server: server.origin().ascii_serialization(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_bounded_pairing_links_with_https_origins() {
        let valid = "ahm://connect?code=abcdefghijklmnop&server=https%3A%2F%2Fexample.com";
        let parsed = parse(valid).unwrap();
        assert_eq!(parsed.server, "https://example.com");
        assert_eq!(parsed.code, "abcdefghijklmnop");
        for bad in [
            format!("{valid}&code=abcdefghijklmnop"),
            format!("{valid}&extra=x"),
            valid.replace("https", "http"),
            valid.replace("example.com", "user%40example.com"),
            valid.replace("example.com", "example.com%2Fpath"),
            valid.replace("abcdefghijklmnop", "short"),
            valid.replace("abcdefghijklmnop", "abcdefghijklmnop%20--evil"),
            valid.replace("connect?", "connect:42?"),
            valid.replace("connect?", "connect/path?"),
        ] {
            assert!(parse(&bad).is_err());
        }
    }
}
