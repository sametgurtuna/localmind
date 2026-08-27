/// Smart Git Workspace & Repository Analysis Module for LocalMind.
/// Inspects Git repository state (branch, uncommitted files, commits, remote URL)
/// with sub-millisecond direct .git parsing and silent background CLI integration.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn silent_git_cmd(repo_path: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(repo_path);
    cmd.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCommitInfo {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub time_relative: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFileInfo {
    pub path: String,
    pub status: String, // "M" | "A" | "D" | "R" | "?" | "U"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitRepoStatus {
    pub name: String,
    pub path: String,
    pub branch: String,
    #[serde(rename = "remoteUrl", skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
    #[serde(rename = "remoteWebUrl", skip_serializing_if = "Option::is_none")]
    pub remote_web_url: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    #[serde(rename = "modifiedCount")]
    pub modified_count: usize,
    #[serde(rename = "stagedCount")]
    pub staged_count: usize,
    #[serde(rename = "untrackedCount")]
    pub untracked_count: usize,
    #[serde(rename = "isClean")]
    pub is_clean: bool,
    #[serde(rename = "lastCommit", skip_serializing_if = "Option::is_none")]
    pub last_commit: Option<GitCommitInfo>,
    #[serde(rename = "recentCommits")]
    pub recent_commits: Vec<GitCommitInfo>,
    #[serde(rename = "changedFiles")]
    pub changed_files: Vec<GitFileInfo>,
    #[serde(rename = "readmeSnippet", skip_serializing_if = "Option::is_none")]
    pub readme_snippet: Option<String>,
}

/// Helper to convert SSH or git URLs (git@github.com:owner/repo.git) to browser HTTPS URLs
pub fn normalize_git_web_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.starts_with("https://") || trimmed.starts_with("http://") {
        let mut url = trimmed.to_string();
        if url.ends_with(".git") {
            url.truncate(url.len() - 4);
        }
        return Some(url);
    }

    // git@github.com:user/repo.git
    if let Some(rest) = trimmed.strip_prefix("git@") {
        if let Some((host, repo_path)) = rest.split_once(':') {
            let mut repo = repo_path.to_string();
            if repo.ends_with(".git") {
                repo.truncate(repo.len() - 4);
            }
            return Some(format!("https://{}/{}", host, repo));
        }
    }

    None
}

/// Check if a directory is the root of a Git repository
pub fn is_git_repo(path: &Path) -> bool {
    let git_dir = path.join(".git");
    git_dir.exists()
}

/// Fast non-blocking extraction of git repo status
pub fn get_git_repo_status(repo_path_str: &str) -> Option<GitRepoStatus> {
    let repo_path = PathBuf::from(repo_path_str);
    if !repo_path.exists() {
        return None;
    }

    let actual_root = if is_git_repo(&repo_path) {
        repo_path
    } else if repo_path.file_name().map_or(false, |n| n == ".git") {
        repo_path.parent()?.to_path_buf()
    } else {
        // Walk up parents up to 4 levels
        let mut curr = repo_path.parent();
        let mut found = None;
        for _ in 0..4 {
            if let Some(p) = curr {
                if is_git_repo(p) {
                    found = Some(p.to_path_buf());
                    break;
                }
                curr = p.parent();
            } else {
                break;
            }
        }
        found?
    };

    let repo_name = actual_root
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Repository".to_string());

    // 1. Direct .git file parsing for Branch & Remote (sub-millisecond instant)
    let git_dir = actual_root.join(".git");
    let mut branch = String::from("HEAD");
    let mut remote_url: Option<String> = None;

    if git_dir.is_dir() {
        // Read HEAD
        if let Ok(head_content) = fs::read_to_string(git_dir.join("HEAD")) {
            let line = head_content.trim();
            if let Some(ref_path) = line.strip_prefix("ref: refs/heads/") {
                branch = ref_path.to_string();
            } else if line.len() >= 7 {
                branch = line[..7].to_string();
            }
        }

        // Read config for origin remote
        if let Ok(cfg_content) = fs::read_to_string(git_dir.join("config")) {
            let mut in_origin = false;
            for line in cfg_content.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("[remote \"origin\"]") {
                    in_origin = true;
                    continue;
                } else if trimmed.starts_with('[') {
                    in_origin = false;
                }

                if in_origin && trimmed.starts_with("url =") {
                    if let Some((_, val)) = trimmed.split_once('=') {
                        remote_url = Some(val.trim().to_string());
                        break;
                    }
                }
            }
        }
    }

    let remote_web_url = remote_url.as_deref().and_then(normalize_git_web_url);

    // 2. Query git CLI for changes and commits (using silent command)
    let mut changed_files = Vec::new();
    let mut modified_count = 0;
    let mut staged_count = 0;
    let mut untracked_count = 0;

    if let Ok(output) = silent_git_cmd(&actual_root)
        .args(["status", "--porcelain=v1"])
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if line.len() < 3 {
                    continue;
                }
                let index_status = line.chars().next().unwrap_or(' ');
                let worktree_status = line.chars().nth(1).unwrap_or(' ');
                let file_path = line[3..].trim().to_string();

                let (stat_type, is_staged, is_untracked) = match (index_status, worktree_status) {
                    ('?', '?') => ("?", false, true),
                    ('A', _) => ("A", true, false),
                    ('D', _) => ("D", true, false),
                    (_, 'D') => ("D", false, false),
                    ('M', _) => ("M", true, false),
                    (_, 'M') => ("M", false, false),
                    ('R', _) => ("R", true, false),
                    ('U', _) | (_, 'U') => ("U", false, false),
                    _ => ("M", false, false),
                };

                if is_untracked {
                    untracked_count += 1;
                } else if is_staged {
                    staged_count += 1;
                } else {
                    modified_count += 1;
                }

                if changed_files.len() < 40 {
                    changed_files.push(GitFileInfo {
                        path: file_path,
                        status: stat_type.to_string(),
                    });
                }
            }
        }
    }

    let is_clean = changed_files.is_empty();

    // 3. Query git log for last 5 commits
    let mut recent_commits = Vec::new();
    if let Ok(output) = silent_git_cmd(&actual_root)
        .args(["log", "-n", "5", "--pretty=format:%h|||%s|||%an|||%cr"])
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let parts: Vec<&str> = line.split("|||").collect();
                if parts.len() >= 4 {
                    recent_commits.push(GitCommitInfo {
                        hash: parts[0].trim().to_string(),
                        message: parts[1].trim().to_string(),
                        author: parts[2].trim().to_string(),
                        time_relative: parts[3].trim().to_string(),
                    });
                }
            }
        }
    }

    let last_commit = recent_commits.first().cloned();

    // 4. Check for README snippet (up to 800 chars)
    let mut readme_snippet = None;
    for readme_name in &["README.md", "readme.md", "README.txt", "README"] {
        let p = actual_root.join(readme_name);
        if p.exists() {
            if let Ok(content) = fs::read_to_string(&p) {
                let trimmed = content.trim();
                if !trimmed.is_empty() {
                    let snippet: String = trimmed.chars().take(800).collect();
                    readme_snippet = Some(snippet);
                    break;
                }
            }
        }
    }

    Some(GitRepoStatus {
        name: repo_name,
        path: actual_root.to_string_lossy().to_string(),
        branch,
        remote_url,
        remote_web_url,
        ahead: 0,
        behind: 0,
        modified_count,
        staged_count,
        untracked_count,
        is_clean,
        last_commit,
        recent_commits,
        changed_files,
        readme_snippet,
    })
}

/// Discover common git repositories across user profile and indexed folders
pub fn discover_git_repositories(configured_folders: &[String]) -> Vec<PathBuf> {
    let mut roots = Vec::new();

    // 1. Add configured index folders
    for f in configured_folders {
        let p = PathBuf::from(f);
        if p.exists() {
            roots.push(p);
        }
    }

    // 2. Add typical dev paths in user home
    if let Some(home) = dirs_next::home_dir() {
        for sub in &[
            "Desktop",
            "Documents",
            "Projects",
            "Developer",
            "dev",
            "repos",
            "source/repos",
            "workspace",
            "work",
        ] {
            let p = home.join(sub);
            if p.exists() {
                roots.push(p);
            }
        }
    }

    let mut repos = Vec::new();
    let mut visited = std::collections::HashSet::new();

    for root in roots {
        scan_folder_for_git_roots(&root, 0, 3, &mut repos, &mut visited);
    }

    repos
}

fn scan_folder_for_git_roots(
    dir: &Path,
    current_depth: usize,
    max_depth: usize,
    results: &mut Vec<PathBuf>,
    visited: &mut std::collections::HashSet<PathBuf>,
) {
    if current_depth > max_depth {
        return;
    }

    if let Ok(canon) = dir.canonicalize() {
        if !visited.insert(canon) {
            return;
        }
    }

    // If dir contains .git, it is a repo root - do not recurse deeper into this repo
    if is_git_repo(dir) {
        results.push(dir.to_path_buf());
        return;
    }

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            let name = p.file_name().unwrap_or_default().to_string_lossy();
            // Skip massive or irrelevant directories
            if name.starts_with('.')
                || name == "node_modules"
                || name == "target"
                || name == "build"
                || name == "dist"
                || name == "vendor"
                || name == "__pycache__"
                || name == "AppData"
            {
                continue;
            }
            scan_folder_for_git_roots(&p, current_depth + 1, max_depth, results, visited);
        }
    }
}
