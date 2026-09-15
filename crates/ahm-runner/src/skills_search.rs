use anyhow::{Context, Result};
use serde::Deserialize;

use super::network_proxy::app_http_client;

#[derive(Debug, Deserialize)]
struct SkillsShResponse {
    skills: Vec<SkillsShItem>,
}

#[derive(Debug, Deserialize)]
struct SkillsShItem {
    name: String,
    installs: u64,
    source: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OnlineSkillResult {
    pub name: String,
    pub installs: u64,
    pub source: String,
    pub source_url: String,
}

pub fn search_skills_online(
    query: &str,
    limit: usize,
    proxy_url: &str,
) -> Result<Vec<OnlineSkillResult>> {
    search_skills_online_inner("https://skills.sh", query, limit, proxy_url)
}

fn search_skills_online_inner(
    base_url: &str,
    query: &str,
    limit: usize,
    proxy_url: &str,
) -> Result<Vec<OnlineSkillResult>> {
    let client = app_http_client(proxy_url, Some(20))?;
    let base_url = base_url.trim_end_matches('/');
    let url = format!(
        "{}/api/search?q={}&limit={}",
        base_url,
        urlencoding::encode(query),
        limit.clamp(1, 50)
    );

    let response = client
        .get(url)
        .header("User-Agent", "skills-hub")
        .send()
        .context("skills.sh search request failed")?
        .error_for_status()
        .context("skills.sh search returned error")?;

    let result: SkillsShResponse = response.json().context("parse skills.sh response")?;

    Ok(result
        .skills
        .into_iter()
        .map(|item| {
            let source_url = format!("https://github.com/{}", item.source);
            OnlineSkillResult {
                name: item.name,
                installs: item.installs,
                source: item.source,
                source_url,
            }
        })
        .collect())
}

#[cfg(test)]
#[path = "tests/skills_search.rs"]
mod tests;
