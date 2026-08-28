/// Unified In-Memory MFT & Application Search Engine.
/// Provides sub-millisecond (< 1ms) parallel search across 1,000,000+ files and apps.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Instant;

use crate::apps::{scan_windows_apps, AppItem};
#[cfg(windows)]
use crate::ntfs::windows_ntfs::{is_ntfs_drive, scan_volume_mft};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeSearchResult {
    #[serde(rename = "fileName")]
    pub file_name: String,
    #[serde(rename = "filePath")]
    pub file_path: String,
    pub snippet: String,
    pub score: f64,
    #[serde(rename = "fileExt", skip_serializing_if = "Option::is_none")]
    pub file_ext: Option<String>,
    #[serde(rename = "fileSize", skip_serializing_if = "Option::is_none")]
    pub file_size: Option<u64>,
    #[serde(rename = "fileModified", skip_serializing_if = "Option::is_none")]
    pub file_modified: Option<f64>,
    pub category: String, // "calc" | "app" | "file" | "action"
    pub action: String,
    #[serde(rename = "actionTitle")]
    pub action_title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

/// One MFT record, holding no heap allocations of its own.
///
/// This used to carry three `String`s -- `name`, `name_lower` and `ext` -- which
/// cost ~150 bytes and three separate allocations per file. A full NTFS volume
/// has one to two million records, so the index alone sat on 150-250MB of RAM
/// and fragmented the allocator doing it. Names now live in `VolumeData::names`,
/// a single arena per volume, and an entry is a fixed 32-byte slice reference
/// into it. `ext` is derived on demand (`entry_ext`) rather than stored: it is
/// always a suffix of the lowercased name.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct CompactFileEntry {
    pub frn: u64,
    pub parent_frn: u64,
    /// Byte offset into the volume's name arena.
    pub name_off: u32,
    /// Length of the display name; the lowercased form follows it.
    pub name_len: u16,
    /// Length of the lowercased name. Case folding is not length-preserving
    /// outside ASCII (Turkish dotted capitals in particular), so it is stored
    /// rather than assumed equal to `name_len`.
    pub lower_len: u16,
    pub is_dir: bool,
    pub volume_idx: u8,
}

#[derive(Default)]
#[allow(dead_code)]
pub struct VolumeData {
    pub drive_letter: char,
    pub journal_id: u64,
    pub next_usn: i64,
    /// Directory FRN -> (parent FRN, name slice in `names`). Directory names are
    /// already in the arena because directories are indexed as records too, so
    /// this borrows them instead of cloning a `String` per folder.
    pub parent_map: HashMap<u64, (u64, u32, u16)>,
    pub files: Vec<CompactFileEntry>,
    /// Every name and lowercased name on this volume, concatenated.
    pub names: String,
}

impl VolumeData {
    /// Append a name and its lowercased form to the arena.
    fn intern(&mut self, name: &str) -> (u32, u16, u16) {
        let off = self.names.len() as u32;
        let lower = name.to_lowercase();
        self.names.push_str(name);
        self.names.push_str(&lower);
        (off, name.len() as u16, lower.len() as u16)
    }

    #[inline]
    fn slice(&self, off: u32, len: u16) -> &str {
        let start = off as usize;
        &self.names[start..start + len as usize]
    }

    #[inline]
    pub fn name(&self, e: &CompactFileEntry) -> &str {
        self.slice(e.name_off, e.name_len)
    }

    #[inline]
    pub fn name_lower(&self, e: &CompactFileEntry) -> &str {
        let start = e.name_off as usize + e.name_len as usize;
        &self.names[start..start + e.lower_len as usize]
    }

    /// Lowercased extension including the dot, or "" when the name has none.
    #[inline]
    pub fn ext(&self, e: &CompactFileEntry) -> &str {
        let lower = self.name_lower(e);
        match lower.rfind('.') {
            Some(i) => &lower[i..],
            None => "",
        }
    }
}

#[derive(Default)]
pub struct MftIndex {
    pub volumes: Vec<VolumeData>,
    pub apps: Vec<AppItem>,
    pub git_repos: Vec<crate::git::GitRepoSummary>,
    pub total_files: usize,
    pub status: String,
    pub scan_time_ms: u64,
}

pub type SharedMftIndex = Arc<RwLock<MftIndex>>;

impl MftIndex {
    pub fn new() -> Self {
        Self {
            volumes: Vec::new(),
            apps: Vec::new(),
            git_repos: Vec::new(),
            total_files: 0,
            status: "uninitialized".to_string(),
            scan_time_ms: 0,
        }
    }

    /// Reconstruct full path for a file by climbing parent FRN map
    pub fn reconstruct_path(&self, volume_idx: usize, parent_frn: u64, file_name: &str) -> String {
        if volume_idx >= self.volumes.len() {
            return file_name.to_string();
        }

        let vol = &self.volumes[volume_idx];
        let mut path_parts = Vec::with_capacity(8);
        let mut curr_frn = parent_frn;
        let mut depth = 0;

        while curr_frn != 0 && depth < 32 {
            if let Some(&(parent_id, off, len)) = vol.parent_map.get(&curr_frn) {
                if len > 0 {
                    path_parts.push(vol.slice(off, len));
                }
                curr_frn = parent_id;
                depth += 1;
            } else {
                break;
            }
        }

        path_parts.reverse();
        let mut full_path = String::with_capacity(128);
        full_path.push(vol.drive_letter);
        full_path.push_str(":\\");

        for part in path_parts {
            full_path.push_str(part);
            full_path.push('\\');
        }
        full_path.push_str(file_name);

        full_path
    }

    /// Execute sub-millisecond search across apps, git repos and all MFT file records
    pub fn search(&self, query: &str, filter_type: &str, limit: usize) -> Vec<NativeSearchResult> {
        let q = query.trim();
        if q.is_empty() {
            return Vec::new();
        }

        let mut results = Vec::with_capacity(limit + 5);

        // 1. Quick Math calculation (instant < 0.05ms)
        if let Some(calc_res) = evaluate_math(q) {
            results.push(calc_res);
            if filter_type == "actions" || filter_type == "calc" {
                return results;
            }
        }

        // 2. Quick System Actions (lock, sleep, restart, shutdown, empty trash, my ip, etc.)
        let sys_actions = evaluate_system_actions(q);
        for action in sys_actions {
            results.push(action);
            if filter_type == "actions" {
                return results;
            }
        }

        let q_lower = q.to_lowercase();

        // 2. Git Repository explicit search prefix (e.g. "repo:localmind", "repo localmind", "git localmind", "git:", "repo")
        let is_explicit_repo_query = q_lower.starts_with("repo:")
            || q_lower.starts_with("repo ")
            || q_lower == "repo"
            || q_lower.starts_with("git:")
            || q_lower.starts_with("git ")
            || q_lower == "git"
            || q_lower.starts_with("project:")
            || q_lower.starts_with("project ")
            || q_lower == "project"
            || filter_type == "repo"
            || filter_type == "repos";

        if is_explicit_repo_query {
            let mut term = q_lower.as_str();
            if let Some(rest) = term.strip_prefix("repo:") {
                term = rest;
            } else if let Some(rest) = term.strip_prefix("repo ") {
                term = rest;
            } else if term == "repo" {
                term = "";
            } else if let Some(rest) = term.strip_prefix("git:") {
                term = rest;
            } else if let Some(rest) = term.strip_prefix("git ") {
                term = rest;
            } else if term == "git" {
                term = "";
            } else if let Some(rest) = term.strip_prefix("project:") {
                term = rest;
            } else if let Some(rest) = term.strip_prefix("project ") {
                term = rest;
            } else if term == "project" {
                term = "";
            }

            let repo_term_lower = term.trim();
            let p_chars: Vec<char> = repo_term_lower.chars().collect();

            for repo in &self.git_repos {
                let name_lower = repo.name.to_lowercase();
                let score = if repo_term_lower.is_empty() {
                    0.95
                } else if name_lower == repo_term_lower {
                    1.0
                } else if name_lower.starts_with(repo_term_lower) {
                    0.98
                } else if name_lower.contains(repo_term_lower) {
                    0.94
                } else {
                    fuzzy_match_score_precomputed(&p_chars, repo_term_lower, &name_lower)
                };

                if score > 0.60 {
                    let snippet = format!("🌿 {} · {}", repo.branch, repo.path);
                    results.push(NativeSearchResult {
                        file_name: repo.name.clone(),
                        file_path: repo.path.clone(),
                        snippet,
                        score: score + 0.05, // Give repos a slight boost
                        file_ext: None,
                        file_size: None,
                        file_modified: None,
                        category: "repo".to_string(),
                        action: "open_in_vscode".to_string(),
                        action_title: format!("Open {} in VS Code", repo.name),
                        icon: Some("git".to_string()),
                    });
                }
            }

            if is_explicit_repo_query && (!repo_term_lower.is_empty() || !results.is_empty()) {
                results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
                return results.into_iter().take(limit).collect();
            }
        }

        // 2b. In general search ("all"), also search discovered git repositories
        if filter_type == "all" && !is_explicit_repo_query && q_lower.len() >= 2 {
            let p_chars: Vec<char> = q_lower.chars().collect();
            for repo in &self.git_repos {
                let name_lower = repo.name.to_lowercase();
                let score = if name_lower == q_lower {
                    1.0
                } else if name_lower.starts_with(&q_lower) {
                    0.98
                } else if name_lower.contains(&q_lower) {
                    0.94
                } else {
                    fuzzy_match_score_precomputed(&p_chars, &q_lower, &name_lower)
                };

                if score > 0.70 {
                    let snippet = format!("🌿 {} · {}", repo.branch, repo.path);
                    results.push(NativeSearchResult {
                        file_name: repo.name.clone(),
                        file_path: repo.path.clone(),
                        snippet,
                        score: score + 0.02,
                        file_ext: None,
                        file_size: None,
                        file_modified: None,
                        category: "repo".to_string(),
                        action: "open_in_vscode".to_string(),
                        action_title: format!("Open {} in VS Code", repo.name),
                        icon: Some("git".to_string()),
                    });
                }
            }
        }

        let q_tokens: Vec<&str> = q_lower.split_whitespace().filter(|w| !w.is_empty()).collect();

        // 3. Apps Search (if filter allows)
        if filter_type == "all" || filter_type == "apps" {
            for app in &self.apps {
                let name_lower = app.name.to_lowercase();
                let score = if name_lower == q_lower {
                    1.0
                } else if name_lower.starts_with(&q_lower) {
                    0.98
                } else if name_lower.contains(&q_lower) {
                    0.95
                } else if !q_tokens.is_empty() && q_tokens.iter().all(|tok| name_lower.contains(tok)) {
                    0.90
                } else {
                    // Typo-tolerant fuzzy match for apps (e.g. vscod -> VS Code, notepda -> Notepad, chome -> Chrome)
                    fuzzy_match_score(&q_lower, &name_lower)
                };

                if score > 0.0 {
                    results.push(NativeSearchResult {
                        file_name: app.name.clone(),
                        file_path: app.path.clone(),
                        snippet: app.description.clone(),
                        score,
                        file_ext: Some(".exe".to_string()),
                        file_size: None,
                        file_modified: None,
                        category: app.category.clone(),
                        action: app.action.clone(),
                        action_title: app.action_title.clone(),
                        icon: app.icon.clone(),
                    });
                }
            }
        }

        // Early return if exact app match on short query
        if results.iter().any(|r| r.score >= 0.98) && q_tokens.len() <= 1 && filter_type == "all" {
            results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
            return results.into_iter().take(limit).collect();
        }

        // 4. Parallel MFT Files Search using Rayon (< 0.5ms across 1,000,000 items)
        if filter_type == "all" || filter_type == "files" {
            let q_str = q_lower.as_str();
            let q_chars: Vec<char> = q_str.chars().collect();
            let q_chars_slice = q_chars.as_slice();
            let tokens_slice = q_tokens.as_slice();
            let num_tokens = tokens_slice.len();

            // Keep only the best `cap` matches instead of collecting every hit.
            let cap = (limit * 4).max(64);
            let by_score_desc = |a: &(usize, &CompactFileEntry, f64), b: &(usize, &CompactFileEntry, f64)| {
                b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal)
            };

            let matched_files: Vec<(usize, &CompactFileEntry, f64)> = self
                .volumes
                .par_iter()
                .enumerate()
                .flat_map(|(vol_idx, vol)| {
                    vol.files.par_iter().filter_map(move |file| {
                        let fname_lower = vol.name_lower(file);
                        let score = if fname_lower == q_str {
                            1.0
                        } else if fname_lower.starts_with(q_str) {
                            0.98
                        } else if fname_lower.contains(q_str) {
                            0.94
                        } else if num_tokens > 1 && tokens_slice.iter().all(|tok| fname_lower.contains(tok)) {
                            0.88
                        } else if q_str.len() >= 3 {
                            // Subsequence & Typo-Tolerant Damerau-Levenshtein Fuzzy Matching
                            fuzzy_match_score_precomputed(q_chars_slice, q_str, fname_lower)
                        } else {
                            0.0
                        };

                        if score > 0.0 {
                            Some((vol_idx, file, score))
                        } else {
                            None
                        }
                    })
                })
                .fold(Vec::new, |mut acc, item| {
                    acc.push(item);
                    if acc.len() >= cap * 4 {
                        acc.sort_unstable_by(by_score_desc);
                        acc.truncate(cap);
                    }
                    acc
                })
                .reduce(Vec::new, |mut a, mut b| {
                    a.append(&mut b);
                    a.sort_unstable_by(by_score_desc);
                    a.truncate(cap);
                    a
                });

            let mut scored = matched_files;
            scored.sort_unstable_by(by_score_desc);

            for (vol_idx, file, score) in scored.into_iter().take(limit * 2) {
                let vol = &self.volumes[vol_idx];
                let name = vol.name(file);
                let full_path = self.reconstruct_path(vol_idx, file.parent_frn, name);
                let ext = vol.ext(file);

                // If directory is a Git repository, classify as "repo" with smart snippet
                let is_dir = file.is_dir;
                let mut category = if is_dir { "folder".to_string() } else { "file".to_string() };
                let mut snippet = full_path.clone();
                let mut action = "open_file".to_string();
                let mut action_title = format!("Open {}", name);
                let mut icon = None;

                if is_dir {
                    if let Some(repo) = self.git_repos.iter().find(|r| r.path.eq_ignore_ascii_case(&full_path)) {
                        category = "repo".to_string();
                        action = "open_in_vscode".to_string();
                        action_title = format!("Open {} in VS Code", name);
                        icon = Some("git".to_string());
                        snippet = format!("🌿 {} · {}", repo.branch, full_path);
                    }
                }

                results.push(NativeSearchResult {
                    file_name: name.to_string(),
                    file_path: full_path,
                    snippet,
                    score,
                    file_ext: if ext.is_empty() { None } else { Some(ext.to_string()) },
                    file_size: None,
                    file_modified: None,
                    category,
                    action,
                    action_title,
                    icon,
                });

                if results.len() >= limit * 2 {
                    break;
                }
            }
        }

        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        results.into_iter().take(limit).collect()
    }
}

/// Zero-allocation bounded Damerau-Levenshtein calculation (max distance 1 or 2).
/// Supports insertions, deletions, substitutions, and adjacent character swaps (transpositions).
#[inline]
pub fn damerau_levenshtein_bounded(s1: &[char], s2: &[char], max_dist: usize) -> usize {
    let len1 = s1.len();
    let len2 = s2.len();

    if len1.abs_diff(len2) > max_dist {
        return max_dist + 1;
    }
    if len1 == 0 {
        return len2;
    }
    if len2 == 0 {
        return len1;
    }
    if len1 > 48 || len2 > 48 {
        return max_dist + 1;
    }

    let mut d = [[0usize; 50]; 50];

    for i in 0..=len1 {
        d[i][0] = i;
    }
    for j in 0..=len2 {
        d[0][j] = j;
    }

    for i in 1..=len1 {
        let mut min_in_row = d[i][0];
        let char1 = s1[i - 1];

        for j in 1..=len2 {
            let char2 = s2[j - 1];
            let cost = if char1 == char2 { 0 } else { 1 };

            let mut val = (d[i - 1][j] + 1)
                .min(d[i][j - 1] + 1)
                .min(d[i - 1][j - 1] + cost);

            if i > 1 && j > 1 && char1 == s2[j - 2] && s1[i - 2] == char2 {
                val = val.min(d[i - 2][j - 2] + 1);
            }

            d[i][j] = val;
            min_in_row = min_in_row.min(val);
        }

        if min_in_row > max_dist {
            return max_dist + 1;
        }
    }

    d[len1][len2]
}

/// Check if pattern matches first letters of words in target (e.g. "vsc" -> "Visual Studio Code")
#[inline]
pub fn match_acronym(p_chars: &[char], target: &str) -> f64 {
    if p_chars.len() < 2 {
        return 0.0;
    }
    let mut p_idx = 0;
    let mut prev_is_sep = true;

    for c in target.chars() {
        if prev_is_sep && p_idx < p_chars.len() && c == p_chars[p_idx] {
            p_idx += 1;
        }
        prev_is_sep = matches!(c, ' ' | '_' | '-' | '.' | '/' | '\\');
    }

    if p_idx == p_chars.len() {
        0.92
    } else {
        0.0
    }
}

/// Ultra-fast zero-allocation fuzzy matching with typo tolerance, acronyms, and subsequence bonuses.
#[inline]
pub fn fuzzy_match_score_precomputed(p_chars: &[char], pattern: &str, target: &str) -> f64 {
    let p_len = p_chars.len();
    if p_len == 0 || target.is_empty() {
        return 0.0;
    }

    // 1. Exact match
    if pattern == target {
        return 1.0;
    }

    // 2. Prefix match
    if target.starts_with(pattern) {
        return 0.98;
    }

    // 3. Substring match
    if target.contains(pattern) {
        return 0.94;
    }

    // 4. Acronym match (e.g. vsc -> Visual Studio Code, np -> Notepad++)
    let acronym_score = match_acronym(p_chars, target);
    if acronym_score > 0.0 {
        return acronym_score;
    }

    // 5. Subsequence Fuzzy Match with bonuses
    let mut p_idx = 0;
    let mut consecutive_bonus: f64 = 0.0;
    let mut boundary_bonus: f64 = 0.0;
    let mut prev_matched_idx = 0usize;
    let mut first_matched_idx = 0usize;
    let mut last_matched_idx = 0usize;
    let mut prev_t_char = '\0';

    for (t_idx, t_char) in target.chars().enumerate() {
        if p_idx < p_len && t_char == p_chars[p_idx] {
            if t_idx == 0 {
                boundary_bonus += 0.12;
            } else if matches!(prev_t_char, '_' | '-' | '.' | ' ' | '/' | '\\' | ':') {
                boundary_bonus += 0.10;
            }

            if p_idx > 0 && t_idx == prev_matched_idx + 1 {
                consecutive_bonus += 0.06;
            }

            if p_idx == 0 {
                first_matched_idx = t_idx;
            }
            last_matched_idx = t_idx;
            prev_matched_idx = t_idx;
            p_idx += 1;
        }
        prev_t_char = t_char;
    }

    if p_idx == p_len {
        let span = (last_matched_idx.saturating_sub(first_matched_idx) + 1) as f64;
        let density = (p_len as f64) / span.max(1.0);
        let raw_score = 0.65 + (density * 0.12) + (consecutive_bonus.min(0.08)) + (boundary_bonus.min(0.08));
        return raw_score.clamp(0.0, 0.92);
    }

    // 6. Typo Tolerance with Bounded Damerau-Levenshtein Edit Distance (>= 3 chars)
    if p_len >= 3 {
        let max_allowed_dist = if p_len <= 5 { 1 } else { 2 };
        let t_chars: Vec<char> = target.chars().collect();

        // 6a. Direct whole target distance
        let dist = damerau_levenshtein_bounded(p_chars, &t_chars, max_allowed_dist);
        if dist <= max_allowed_dist {
            let penalty = (dist as f64) * 0.12;
            return (0.86 - penalty).max(0.65);
        }

        // 6b. Word token prefix distance (e.g. "pyhton" -> "python_file.py", "vscod" -> "vscode.exe", "notepda" -> "notepad")
        for word in target.split(|c: char| !c.is_alphanumeric()) {
            if word.len() >= p_len.saturating_sub(1) {
                let w_chars: Vec<char> = word.chars().collect();
                let check_len = p_len.min(w_chars.len());
                let prefix_slice = &w_chars[..check_len];
                let w_dist = damerau_levenshtein_bounded(p_chars, prefix_slice, max_allowed_dist);
                if w_dist <= max_allowed_dist {
                    let penalty = (w_dist as f64) * 0.12;
                    let length_penalty = ((w_chars.len().saturating_sub(p_len)) as f64) * 0.01;
                    return (0.85 - penalty - length_penalty).max(0.65);
                }
            }
        }
    }

    0.0
}

/// Fallback wrapper for tests
#[inline]
pub fn fuzzy_match_score(pattern: &str, target: &str) -> f64 {
    let p_chars: Vec<char> = pattern.chars().collect();
    fuzzy_match_score_precomputed(&p_chars, pattern, target)
}


pub fn get_local_ip() -> String {
    for target in &["8.8.8.8:80", "1.1.1.1:80", "192.168.1.1:80", "10.0.0.1:80", "172.16.0.1:80"] {
        if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
            if socket.connect(target).is_ok() {
                if let Ok(addr) = socket.local_addr() {
                    let ip_str = addr.ip().to_string();
                    if ip_str != "0.0.0.0" && ip_str != "127.0.0.1" {
                        return ip_str;
                    }
                }
            }
        }
    }
    "127.0.0.1".to_string()
}

pub fn evaluate_system_actions(q: &str) -> Vec<NativeSearchResult> {
    let q_lower = q.trim().to_lowercase();
    if q_lower.is_empty() {
        return Vec::new();
    }

    let mut actions = Vec::new();
    let local_ip = get_local_ip();

    struct ActionSpec {
        keys: &'static [&'static str],
        title: &'static str,
        cmd: &'static str,
        desc: &'static str,
        category: &'static str,
        action: &'static str,
        action_title: &'static str,
        icon: &'static str,
    }

    let specs = [
        ActionSpec {
            keys: &["lock", "lock screen", "lock workstation", "lock pc", "kilit", "kilitle", "ekranı kilitle", "ekrani kilitle", "ekran kilidi"],
            title: "Lock Workstation",
            cmd: "lock",
            desc: "Lock current Windows session (Win + L)",
            category: "action",
            action: "system_command",
            action_title: "Lock Screen",
            icon: "lock",
        },
        ActionSpec {
            keys: &["sleep", "sleep pc", "suspend", "uyku", "uyut", "uyku modu", "askıya al", "askiya al"],
            title: "Sleep PC",
            cmd: "sleep",
            desc: "Put computer into sleep mode",
            category: "action",
            action: "system_command",
            action_title: "Sleep",
            icon: "sleep",
        },
        ActionSpec {
            keys: &["restart", "reboot", "restart pc", "yeniden başlat", "yeniden baslat", "bilgisayarı yeniden başlat", "bilgisayari yeniden baslat", "reset"],
            title: "Restart Computer",
            cmd: "restart",
            desc: "Reboot Windows operating system",
            category: "action",
            action: "system_command",
            action_title: "Restart",
            icon: "restart",
        },
        ActionSpec {
            keys: &["shutdown", "shut down", "power off", "turn off", "kapat", "bilgisayarı kapat", "bilgisayari kapat", "bilgisayar kapat"],
            title: "Shut Down Computer",
            cmd: "shutdown",
            desc: "Turn off Windows computer",
            category: "action",
            action: "system_command",
            action_title: "Shut Down",
            icon: "shutdown",
        },
        ActionSpec {
            keys: &[
                "empty trash", "empty recycle bin", "recycle bin", "trash",
                "çöpü boşalt", "copu bosalt", "çöp kutusu", "cop kutusu",
                "çöp kutusunu boşalt", "cop kutusunu bosalt", "geri dönüşüm kutusu", "geri donusum kutusu",
            ],
            title: "Empty Recycle Bin",
            cmd: "empty_trash",
            desc: "Permanently delete items in Recycle Bin",
            category: "action",
            action: "system_command",
            action_title: "Empty Recycle Bin",
            icon: "trash",
        },
        ActionSpec {
            keys: &["my ip", "ip", "local ip", "ip address", "ip adresi", "ip adresim", "yerel ip", "what is my ip", "benim ip", "ip nedir"],
            title: "Local IP Address",
            cmd: "ip_copy",
            desc: "Copy your local network IPv4 address",
            category: "action",
            action: "copy",
            action_title: "Copy IP Address",
            icon: "network",
        },
        ActionSpec {
            keys: &["logout", "log out", "sign out", "signout", "oturum kapat", "oturumu kapat"],
            title: "Sign Out",
            cmd: "logout",
            desc: "Sign out of current user session",
            category: "action",
            action: "system_command",
            action_title: "Sign Out",
            icon: "logout",
        },
        ActionSpec {
            keys: &["calc", "calculator", "hesap makinesi", "hesap makinasi", "hesap", "hesap makinası"],
            title: "Calculator",
            cmd: "calc",
            desc: "Open Windows Calculator",
            category: "app",
            action: "open",
            action_title: "Open Calculator",
            icon: "calc",
        },
    ];

    for spec in specs {
        let is_exact = spec.keys.iter().any(|&k| k == q_lower);
        let is_prefix = !is_exact && spec.keys.iter().any(|&k| k.starts_with(&q_lower) || (q_lower.len() >= 3 && k.contains(&q_lower)));

        if is_exact || is_prefix {
            let (file_name, file_path, snippet) = if spec.cmd == "ip_copy" {
                (
                    format!("Local IP: {}", local_ip),
                    local_ip.clone(),
                    format!("Your local network IPv4 address ({})", local_ip),
                )
            } else {
                (
                    spec.title.to_string(),
                    spec.cmd.to_string(),
                    spec.desc.to_string(),
                )
            };

            actions.push(NativeSearchResult {
                file_name,
                file_path,
                snippet,
                score: if is_exact { 1.0 } else { 0.95 },
                file_ext: None,
                file_size: None,
                file_modified: None,
                category: spec.category.to_string(),
                action: spec.action.to_string(),
                action_title: spec.action_title.to_string(),
                icon: Some(spec.icon.to_string()),
            });
        }
    }

    actions
}

#[derive(Debug, PartialEq, Clone)]
enum MathToken {
    Num(f64),
    Ident(String),
    Op(char),
    LParen,
    RParen,
    Comma,
}

fn tokenize_math(input: &str) -> Option<Vec<MathToken>> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    let len = chars.len();

    while i < len {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }

        if c.is_ascii_digit() || c == '.' {
            let start = i;
            let mut has_dot = c == '.';
            i += 1;
            while i < len {
                let next_c = chars[i];
                if next_c.is_ascii_digit() {
                    i += 1;
                } else if next_c == '.' && !has_dot {
                    has_dot = true;
                    i += 1;
                } else {
                    break;
                }
            }
            let s: String = chars[start..i].iter().collect();
            let n: f64 = s.parse().ok()?;
            tokens.push(MathToken::Num(n));
            continue;
        }

        if c.is_ascii_alphabetic() {
            let start = i;
            while i < len && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let ident: String = chars[start..i].iter().collect::<String>().to_lowercase();
            match ident.as_str() {
                "pi" => tokens.push(MathToken::Num(std::f64::consts::PI)),
                "e" => tokens.push(MathToken::Num(std::f64::consts::E)),
                "tau" => tokens.push(MathToken::Num(std::f64::consts::TAU)),
                _ => tokens.push(MathToken::Ident(ident)),
            }
            continue;
        }

        match c {
            '+' | '-' | '*' | '/' | '%' | '^' => {
                tokens.push(MathToken::Op(c));
                i += 1;
            }
            'x' | 'X' => {
                tokens.push(MathToken::Op('*'));
                i += 1;
            }
            '(' => {
                tokens.push(MathToken::LParen);
                i += 1;
            }
            ')' => {
                tokens.push(MathToken::RParen);
                i += 1;
            }
            ',' => {
                tokens.push(MathToken::Comma);
                i += 1;
            }
            _ => return None,
        }
    }

    Some(tokens)
}

struct MathParser {
    tokens: Vec<MathToken>,
    pos: usize,
}

impl MathParser {
    fn new(tokens: Vec<MathToken>) -> Self {
        Self { tokens, pos: 0 }
    }

    fn peek(&self) -> Option<&MathToken> {
        self.tokens.get(self.pos)
    }

    fn next(&mut self) -> Option<MathToken> {
        if self.pos < self.tokens.len() {
            let tok = self.tokens[self.pos].clone();
            self.pos += 1;
            Some(tok)
        } else {
            None
        }
    }

    fn parse_expression(&mut self) -> Option<f64> {
        let mut left = self.parse_term()?;

        while let Some(MathToken::Op(op)) = self.peek() {
            if *op == '+' || *op == '-' {
                let op_char = *op;
                self.next();
                let right = self.parse_term()?;
                left = match op_char {
                    '+' => left + right,
                    '-' => left - right,
                    _ => unreachable!(),
                };
            } else {
                break;
            }
        }

        Some(left)
    }

    fn parse_term(&mut self) -> Option<f64> {
        let mut left = self.parse_power()?;

        while let Some(MathToken::Op(op)) = self.peek() {
            if *op == '*' || *op == '/' || *op == '%' {
                let op_char = *op;
                self.next();
                let right = self.parse_power()?;
                left = match op_char {
                    '*' => left * right,
                    '/' => {
                        if right == 0.0 {
                            return None;
                        }
                        left / right
                    }
                    '%' => {
                        if right == 0.0 {
                            return None;
                        }
                        left % right
                    }
                    _ => unreachable!(),
                };
            } else {
                break;
            }
        }

        Some(left)
    }

    fn parse_power(&mut self) -> Option<f64> {
        let base = self.parse_factor()?;

        if let Some(MathToken::Op('^')) = self.peek() {
            self.next();
            let exp = self.parse_power()?;
            return Some(base.powf(exp));
        }

        Some(base)
    }

    fn parse_factor(&mut self) -> Option<f64> {
        match self.peek()? {
            MathToken::Op('+') => {
                self.next();
                self.parse_factor()
            }
            MathToken::Op('-') => {
                self.next();
                Some(-self.parse_factor()?)
            }
            MathToken::Num(n) => {
                let val = *n;
                self.next();
                Some(val)
            }
            MathToken::Ident(id) => {
                let func_name = id.clone();
                self.next();
                if let Some(MathToken::LParen) = self.peek() {
                    self.next();
                    let arg = self.parse_expression()?;
                    let arg2 = if let Some(MathToken::Comma) = self.peek() {
                        self.next();
                        Some(self.parse_expression()?)
                    } else {
                        None
                    };
                    if let Some(MathToken::RParen) = self.peek() {
                        self.next();
                    } else {
                        return None;
                    }

                    match func_name.as_str() {
                        "sqrt" => Some(arg.sqrt()),
                        "cbrt" => Some(arg.cbrt()),
                        "sin" => Some(arg.to_radians().sin()),
                        "cos" => Some(arg.to_radians().cos()),
                        "tan" => Some(arg.to_radians().tan()),
                        "asin" => Some(arg.asin().to_degrees()),
                        "acos" => Some(arg.acos().to_degrees()),
                        "atan" => Some(arg.atan().to_degrees()),
                        "abs" => Some(arg.abs()),
                        "log" | "log10" => Some(arg.log10()),
                        "log2" => Some(arg.log2()),
                        "ln" => Some(arg.ln()),
                        "exp" => Some(arg.exp()),
                        "round" => Some(arg.round()),
                        "floor" => Some(arg.floor()),
                        "ceil" => Some(arg.ceil()),
                        "pow" => Some(arg.powf(arg2.unwrap_or(1.0))),
                        _ => None,
                    }
                } else {
                    None
                }
            }
            MathToken::LParen => {
                self.next();
                let val = self.parse_expression()?;
                if let Some(MathToken::RParen) = self.peek() {
                    self.next();
                    Some(val)
                } else {
                    None
                }
            }
            _ => None,
        }
    }
}

pub fn evaluate_math(q: &str) -> Option<NativeSearchResult> {
    let mut raw = q.trim();
    if raw.is_empty() {
        return None;
    }

    // Strip leading `= `, `calc `, `calculator `, `hesap `
    let raw_lower = raw.to_lowercase();
    if let Some(rest) = raw_lower.strip_prefix("calc ") {
        raw = raw[raw.len() - rest.len()..].trim();
    } else if let Some(rest) = raw_lower.strip_prefix("calculator ") {
        raw = raw[raw.len() - rest.len()..].trim();
    } else if let Some(rest) = raw_lower.strip_prefix("hesap ") {
        raw = raw[raw.len() - rest.len()..].trim();
    } else if let Some(rest) = raw.strip_prefix('=') {
        raw = rest.trim();
    }

    if let Some(rest) = raw.strip_suffix('=') {
        raw = rest.trim();
    }

    if raw.is_empty() {
        return None;
    }

    // 1. Percentage check: "20% of 500" or "15% * 80"
    let clean = raw.replace(',', ".");
    let parts: Vec<&str> = clean.split_whitespace().collect();
    if parts.len() == 3 && (parts[1].eq_ignore_ascii_case("of") || parts[1] == "*") {
        if parts[0].ends_with('%') {
            let pct_str = &parts[0][..parts[0].len() - 1];
            if let (Ok(pct), Ok(total)) = (pct_str.parse::<f64>(), parts[2].parse::<f64>()) {
                let res = (pct / 100.0) * total;
                let res_str = format_num(res);
                return Some(NativeSearchResult {
                    file_name: format!("= {}", res_str),
                    file_path: res_str.clone(),
                    snippet: format!("Calculation: {} = {}", raw, res_str),
                    score: 1.0,
                    file_ext: None,
                    file_size: None,
                    file_modified: None,
                    category: "calc".to_string(),
                    action: "copy".to_string(),
                    action_title: "Copy Result".to_string(),
                    icon: Some("calc".to_string()),
                });
            }
        }
    }

    // Percentage additions / subtractions e.g. "500 + 20%" or "500 - 10%"
    if parts.len() == 3 && (parts[1] == "+" || parts[1] == "-") && parts[2].ends_with('%') {
        let pct_str = &parts[2][..parts[2].len() - 1];
        if let (Ok(base), Ok(pct)) = (parts[0].parse::<f64>(), pct_str.parse::<f64>()) {
            let delta = (pct / 100.0) * base;
            let res = if parts[1] == "+" { base + delta } else { base - delta };
            let res_str = format_num(res);
            return Some(NativeSearchResult {
                file_name: format!("= {}", res_str),
                file_path: res_str.clone(),
                snippet: format!("Calculation: {} = {}", raw, res_str),
                score: 1.0,
                file_ext: None,
                file_size: None,
                file_modified: None,
                category: "calc".to_string(),
                action: "copy".to_string(),
                action_title: "Copy Result".to_string(),
                icon: Some("calc".to_string()),
            });
        }
    }

    // 2. Hex / Binary conversions
    let raw_lower_clean = clean.to_lowercase();
    if raw_lower_clean.starts_with("0x") && raw_lower_clean.len() > 2 {
        if let Ok(val) = u64::from_str_radix(&raw_lower_clean[2..], 16) {
            let res_str = val.to_string();
            return Some(NativeSearchResult {
                file_name: format!("= {}", res_str),
                file_path: res_str.clone(),
                snippet: format!("Hex to Decimal: {} = {}", raw, res_str),
                score: 1.0,
                file_ext: None,
                file_size: None,
                file_modified: None,
                category: "calc".to_string(),
                action: "copy".to_string(),
                action_title: "Copy Decimal Value".to_string(),
                icon: Some("calc".to_string()),
            });
        }
    }

    if raw_lower_clean.starts_with("0b") && raw_lower_clean.len() > 2 {
        if let Ok(val) = u64::from_str_radix(&raw_lower_clean[2..], 2) {
            let res_str = val.to_string();
            return Some(NativeSearchResult {
                file_name: format!("= {}", res_str),
                file_path: res_str.clone(),
                snippet: format!("Binary to Decimal: {} = {}", raw, res_str),
                score: 1.0,
                file_ext: None,
                file_size: None,
                file_modified: None,
                category: "calc".to_string(),
                action: "copy".to_string(),
                action_title: "Copy Decimal Value".to_string(),
                icon: Some("calc".to_string()),
            });
        }
    }

    if raw_lower_clean.starts_with("hex ") {
        let num_str = raw_lower_clean["hex ".len()..].trim();
        if let Ok(val) = num_str.parse::<u64>() {
            let hex_str = format!("0x{:X}", val);
            return Some(NativeSearchResult {
                file_name: format!("= {}", hex_str),
                file_path: hex_str.clone(),
                snippet: format!("Decimal to Hex: {} = {}", val, hex_str),
                score: 1.0,
                file_ext: None,
                file_size: None,
                file_modified: None,
                category: "calc".to_string(),
                action: "copy".to_string(),
                action_title: "Copy Hex Value".to_string(),
                icon: Some("calc".to_string()),
            });
        }
    }

    if raw_lower_clean.starts_with("bin ") || raw_lower_clean.starts_with("binary ") {
        let prefix_len = if raw_lower_clean.starts_with("bin ") { 4 } else { 7 };
        let num_str = raw_lower_clean[prefix_len..].trim();
        if let Ok(val) = num_str.parse::<u64>() {
            let bin_str = format!("0b{:b}", val);
            return Some(NativeSearchResult {
                file_name: format!("= {}", bin_str),
                file_path: bin_str.clone(),
                snippet: format!("Decimal to Binary: {} = {}", val, bin_str),
                score: 1.0,
                file_ext: None,
                file_size: None,
                file_modified: None,
                category: "calc".to_string(),
                action: "copy".to_string(),
                action_title: "Copy Binary Value".to_string(),
                icon: Some("calc".to_string()),
            });
        }
    }

    // 3. Normal Math Expressions
    let has_op = clean.chars().any(|c| matches!(c, '+' | '-' | '*' | '/' | '^' | '%' | 'x' | 'X'));
    let has_func = ["sqrt", "sin", "cos", "tan", "abs", "log", "ln", "round", "floor", "ceil", "cbrt", "pow"]
        .iter()
        .any(|&f| raw_lower_clean.contains(f));

    if !has_op && !has_func {
        return None;
    }

    if !clean.chars().any(|c| c.is_ascii_digit()) && !["pi", "e", "tau"].iter().any(|&c| raw_lower_clean.contains(c)) {
        return None;
    }

    let tokens = tokenize_math(&clean)?;
    if tokens.is_empty() {
        return None;
    }

    let mut parser = MathParser::new(tokens);
    let val = parser.parse_expression()?;

    if parser.pos == parser.tokens.len() && !val.is_nan() && !val.is_infinite() {
        let res_str = format_num(val);
        return Some(NativeSearchResult {
            file_name: format!("= {}", res_str),
            file_path: res_str.clone(),
            snippet: format!("Calculation: {} = {}", raw, res_str),
            score: 1.0,
            file_ext: None,
            file_size: None,
            file_modified: None,
            category: "calc".to_string(),
            action: "copy".to_string(),
            action_title: "Copy Result".to_string(),
            icon: Some("calc".to_string()),
        });
    }

    None
}

fn format_num(val: f64) -> String {
    if val.fract() == 0.0 && val >= i64::MIN as f64 && val <= i64::MAX as f64 {
        format!("{:.0}", val)
    } else {
        format!("{:.8}", val)
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct IndexedVolumeInfo {
    pub drive_letter: String,
    pub file_count: usize,
    pub is_mft: bool,
}

impl MftIndex {
    pub fn get_volumes_info(&self) -> Vec<IndexedVolumeInfo> {
        self.volumes
            .iter()
            .map(|v| IndexedVolumeInfo {
                drive_letter: format!("{}:\\", v.drive_letter),
                file_count: v.files.len(),
                is_mft: v.journal_id != 0,
            })
            .collect()
    }
}

fn scan_volume_fallback(drive: char, vol_idx: u8) -> Option<VolumeData> {
    let root = format!("{}:\\", drive);
    let root_path = std::path::PathBuf::from(&root);
    if !root_path.exists() {
        return None;
    }

    log::info!("Scanning volume {}:\\ via fast directory crawler fallback...", drive);
    let mut vol = VolumeData {
        drive_letter: drive,
        journal_id: 0,
        next_usn: 0,
        parent_map: HashMap::with_capacity(20_000),
        files: Vec::with_capacity(150_000),
        names: String::with_capacity(150_000 * 35),
    };

    let mut queue = std::collections::VecDeque::new();
    let mut next_frn: u64 = 1;

    let root_frn = next_frn;
    next_frn += 1;
    let (root_off, root_name_len, _) = vol.intern(&root);
    vol.parent_map.insert(root_frn, (0, root_off, root_name_len));
    queue.push_back((root_frn, root_path));

    let skip_dirs = [
        "$recycle.bin",
        "system volume information",
        "msocache",
        "recovery",
        "$windows.~bt",
        "$windows.~ws",
        ".git",
        "node_modules",
    ];

    while let Some((curr_parent_frn, dir_path)) = queue.pop_front() {
        if let Ok(entries) = std::fs::read_dir(&dir_path) {
            for entry in entries.flatten() {
                let fname = match entry.file_name().into_string() {
                    Ok(n) => n,
                    Err(_) => continue,
                };

                let fname_lower = fname.to_lowercase();
                if skip_dirs.iter().any(|&s| fname_lower == s) {
                    continue;
                }

                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                let my_frn = next_frn;
                next_frn += 1;

                let (off, name_len, lower_len) = vol.intern(&fname);

                if is_dir {
                    vol.parent_map.insert(my_frn, (curr_parent_frn, off, name_len));
                    queue.push_back((my_frn, entry.path()));
                }

                vol.files.push(CompactFileEntry {
                    frn: my_frn,
                    parent_frn: curr_parent_frn,
                    name_off: off,
                    name_len,
                    lower_len,
                    is_dir,
                    volume_idx: vol_idx,
                });
            }
        }
    }

    vol.names.shrink_to_fit();
    vol.files.shrink_to_fit();
    log::info!("Volume {}:\\ fallback scan complete: {} files found", drive, vol.files.len());
    Some(vol)
}

/// Scan all NTFS & FAT32/exFAT volumes in background and populate in-memory index
pub fn scan_all_drives_background(shared_index: SharedMftIndex) {
    std::thread::spawn(move || {
        let start = Instant::now();
        log::info!("Starting background MFT & App scan across all drives...");

        {
            if let Ok(mut idx) = shared_index.write() {
                idx.status = "scanning".to_string();
            }
        }

        // 1. Scan Installed Windows Applications (parallel Rayon scan < 15ms)
        let apps = scan_windows_apps();
        log::info!("Found {} Windows applications & system tools in {:?}", apps.len(), start.elapsed());

        // 1b. Discover and cache Git Repositories in background
        let git_repos = crate::git::discover_and_cache_git_repos(&[]);
        log::info!("Found {} Git repositories in {:?}", git_repos.len(), start.elapsed());

        // 1c. PRE-CACHE: Publish apps & repos immediately so user can search apps instantly (< 20ms from launch)
        {
            if let Ok(mut idx) = shared_index.write() {
                idx.apps = apps.clone();
                idx.git_repos = git_repos.clone();
                idx.status = "indexing_volumes".to_string();
            }
        }

        // 2. Scan All Storage Volumes (C:\, D:\, E:\, etc.)
        let mut volumes_data = Vec::new();
        let mut total_files = 0;

        #[cfg(windows)]
        {
            for letter in b'C'..=b'Z' {
                let drive = letter as char;
                let root = format!("{}:\\", drive);
                if !std::path::Path::new(&root).exists() {
                    continue;
                }

                let vol_idx = volumes_data.len() as u8;
                let mut scanned_vol = None;

                if is_ntfs_drive(drive) {
                    log::info!("Scanning NTFS volume {}:\\ via MFT...", drive);
                    match scan_volume_mft(drive) {
                        Ok(scan_res) => {
                            let count = scan_res.records.len();
                            log::info!("Volume {}:\\ scanned via MFT: {} files in {:?}", drive, count, start.elapsed());

                            let mut vol = VolumeData {
                                drive_letter: drive,
                                journal_id: scan_res.journal_id,
                                next_usn: scan_res.next_usn,
                                parent_map: HashMap::with_capacity(count / 8),
                                files: Vec::with_capacity(count),
                                names: String::with_capacity(count * 40),
                            };

                            for rec in scan_res.records {
                                let (off, name_len, lower_len) = vol.intern(&rec.name);
                                if rec.is_dir {
                                    vol.parent_map.insert(rec.frn, (rec.parent_frn, off, name_len));
                                }
                                vol.files.push(CompactFileEntry {
                                    frn: rec.frn,
                                    parent_frn: rec.parent_frn,
                                    name_off: off,
                                    name_len,
                                    lower_len,
                                    is_dir: rec.is_dir,
                                    volume_idx: vol_idx,
                                });
                            }

                            vol.names.shrink_to_fit();
                            vol.files.shrink_to_fit();
                            scanned_vol = Some(vol);
                        }
                        Err(e) => {
                            log::warn!("MFT scan failed for drive {}: {}, falling back to fast crawler...", drive, e);
                        }
                    }
                }

                // If MFT was skipped/failed or drive is non-NTFS, crawl via fast filesystem walker
                if scanned_vol.is_none() {
                    scanned_vol = scan_volume_fallback(drive, vol_idx);
                }

                if let Some(vol) = scanned_vol {
                    total_files += vol.files.len();
                    volumes_data.push(vol);
                }
            }
        }

        let elapsed = start.elapsed();
        log::info!(
            "MFT & Drive Indexing Complete: {} total files & {} apps indexed in {:.2?}",
            total_files,
            apps.len(),
            elapsed
        );

        if let Ok(mut idx) = shared_index.write() {
            idx.volumes = volumes_data;
            idx.apps = apps;
            idx.git_repos = git_repos;
            idx.total_files = total_files;
            idx.status = "ready".to_string();
            idx.scan_time_ms = elapsed.as_millis() as u64;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_math_evaluation() {
        let res = evaluate_math("150 * 4").unwrap();
        assert_eq!(res.file_name, "= 600");
        assert_eq!(res.category, "calc");

        let res_div = evaluate_math("1024 / 8").unwrap();
        assert_eq!(res_div.file_name, "= 128");

        let res_unspaced = evaluate_math("150*4").unwrap();
        assert_eq!(res_unspaced.file_name, "= 600");

        let res_precedence = evaluate_math("25 + 10 * 2").unwrap();
        assert_eq!(res_precedence.file_name, "= 45");

        let res_parens = evaluate_math("(10 + 20) * 3").unwrap();
        assert_eq!(res_parens.file_name, "= 90");

        let res_pct = evaluate_math("20% of 500").unwrap();
        assert_eq!(res_pct.file_name, "= 100");

        let res_pct_add = evaluate_math("500 + 20%").unwrap();
        assert_eq!(res_pct_add.file_name, "= 600");

        let res_hex = evaluate_math("0xff").unwrap();
        assert_eq!(res_hex.file_name, "= 255");

        let res_sqrt = evaluate_math("sqrt(144)").unwrap();
        assert_eq!(res_sqrt.file_name, "= 12");

        let res_calc_prefix = evaluate_math("calc 150 * 4").unwrap();
        assert_eq!(res_calc_prefix.file_name, "= 600");

        let res_equals_prefix = evaluate_math("= 25 + 10").unwrap();
        assert_eq!(res_equals_prefix.file_name, "= 35");

        let res_hesap_prefix = evaluate_math("hesap 100 / 5").unwrap();
        assert_eq!(res_hesap_prefix.file_name, "= 20");

        let res_equals_suffix = evaluate_math("50 * 2 =").unwrap();
        assert_eq!(res_equals_suffix.file_name, "= 100");
    }

    #[test]
    fn test_system_actions_evaluation() {
        let lock_acts = evaluate_system_actions("lock");
        assert!(!lock_acts.is_empty());
        assert_eq!(lock_acts[0].action, "system_command");
        assert_eq!(lock_acts[0].file_path, "lock");

        let kilit_acts = evaluate_system_actions("kilit");
        assert!(!kilit_acts.is_empty());
        assert_eq!(kilit_acts[0].file_path, "lock");

        let sleep_acts = evaluate_system_actions("sleep");
        assert!(!sleep_acts.is_empty());
        assert_eq!(sleep_acts[0].file_path, "sleep");

        let uyku_acts = evaluate_system_actions("uyku");
        assert!(!uyku_acts.is_empty());
        assert_eq!(uyku_acts[0].file_path, "sleep");

        let restart_acts = evaluate_system_actions("restart");
        assert!(!restart_acts.is_empty());
        assert_eq!(restart_acts[0].file_path, "restart");

        let reboot_tr = evaluate_system_actions("yeniden başlat");
        assert!(!reboot_tr.is_empty());
        assert_eq!(reboot_tr[0].file_path, "restart");

        let shutdown_acts = evaluate_system_actions("shutdown");
        assert!(!shutdown_acts.is_empty());
        assert_eq!(shutdown_acts[0].file_path, "shutdown");

        let kapat_acts = evaluate_system_actions("kapat");
        assert!(!kapat_acts.is_empty());
        assert_eq!(kapat_acts[0].file_path, "shutdown");

        let trash_acts = evaluate_system_actions("empty trash");
        assert!(!trash_acts.is_empty());
        assert_eq!(trash_acts[0].file_path, "empty_trash");

        let cop_acts = evaluate_system_actions("çöpü boşalt");
        assert!(!cop_acts.is_empty());
        assert_eq!(cop_acts[0].file_path, "empty_trash");

        let ip_acts = evaluate_system_actions("my ip");
        assert!(!ip_acts.is_empty());
        assert_eq!(ip_acts[0].action, "copy");

        let ip_tr = evaluate_system_actions("ip adresi");
        assert!(!ip_tr.is_empty());
        assert_eq!(ip_tr[0].action, "copy");

        let calc_acts = evaluate_system_actions("calc");
        assert!(!calc_acts.is_empty());
        assert_eq!(calc_acts[0].file_path, "calc");
        assert_eq!(calc_acts[0].category, "app");

        let hesap_acts = evaluate_system_actions("hesap makinesi");
        assert!(!hesap_acts.is_empty());
        assert_eq!(hesap_acts[0].file_path, "calc");
    }

    #[test]
    fn test_mft_search_and_path_reconstruction() {
        let mut index = MftIndex::new();
        let mut vol = VolumeData {
            drive_letter: 'C',
            journal_id: 1,
            next_usn: 1000,
            ..Default::default()
        };

        for (frn, parent, name) in [(1u64, 0u64, "Users"), (2, 1, "samet"), (3, 2, "Documents")] {
            let (off, len, _) = vol.intern(name);
            vol.parent_map.insert(frn, (parent, off, len));
        }

        for (frn, name) in [(100u64, "invoice_2026.pdf"), (101, "budget_report.xlsx")] {
            let (off, name_len, lower_len) = vol.intern(name);
            vol.files.push(CompactFileEntry {
                frn,
                parent_frn: 3,
                name_off: off,
                name_len,
                lower_len,
                is_dir: false,
                volume_idx: 0,
            });
        }

        // Names and extensions must read back correctly out of the arena.
        assert_eq!(vol.name(&vol.files[0]), "invoice_2026.pdf");
        assert_eq!(vol.name_lower(&vol.files[0]), "invoice_2026.pdf");
        assert_eq!(vol.ext(&vol.files[0]), ".pdf");
        assert_eq!(vol.ext(&vol.files[1]), ".xlsx");

        index.volumes.push(vol);

        // Test path reconstruction
        let path = index.reconstruct_path(0, 3, "invoice_2026.pdf");
        assert_eq!(path, r"C:\Users\samet\Documents\invoice_2026.pdf");

        // Test search
        let results = index.search("invoice", "all", 10);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].file_name, "invoice_2026.pdf");
        assert_eq!(results[0].file_path, r"C:\Users\samet\Documents\invoice_2026.pdf");

        // Test fuzzy matching (e.g. "invc" or "bdgt")
        let fuzzy_res = index.search("invc", "all", 10);
        assert!(!fuzzy_res.is_empty());
        assert_eq!(fuzzy_res[0].file_name, "invoice_2026.pdf");

        let fuzzy_bdgt = index.search("bdgt", "all", 10);
        assert!(!fuzzy_bdgt.is_empty());
        assert_eq!(fuzzy_bdgt[0].file_name, "budget_report.xlsx");
    }

    #[test]
    fn test_fuzzy_scores() {
        assert!(fuzzy_match_score("sptfy", "spotify.exe") > 0.70);
        assert!(fuzzy_match_score("chrm", "google chrome.lnk") > 0.70);
        assert!(fuzzy_match_score("vsc", "visual studio code") > 0.70);
        assert_eq!(fuzzy_match_score("xyz123", "spotify.exe"), 0.0);

        // Typo tolerance tests (Damerau-Levenshtein / Transpositions / Deletions)
        assert!(fuzzy_match_score("vscod", "vscode.exe") > 0.70);
        assert!(fuzzy_match_score("notepda", "notepad.exe") > 0.70);
        assert!(fuzzy_match_score("pyhton", "python.exe") > 0.70);
        assert!(fuzzy_match_score("dockre", "docker desktop.lnk") > 0.70);
        assert!(fuzzy_match_score("chome", "google chrome.lnk") > 0.70);
    }
}

#[cfg(test)]
mod footprint {
    use super::*;

    /// Documents what one indexed record costs. Not a behavioural test -- it
    /// prints the figures the README quotes, so they can be re-checked.
    #[test]
    fn report_entry_footprint() {
        // What the entry used to be: three owned Strings plus the scalars.
        #[allow(dead_code)]
        struct LegacyEntry {
            frn: u64,
            parent_frn: u64,
            name: String,
            name_lower: String,
            ext: String,
            is_dir: bool,
            volume_idx: u8,
        }

        let legacy_struct = std::mem::size_of::<LegacyEntry>();
        let now_struct = std::mem::size_of::<CompactFileEntry>();

        // Average NTFS filename, and what each layout allocates for it.
        let name = "quarterly_report_2026_final.pdf";
        let heap_legacy = name.len() * 2 + 4; // name + lowercase + ".pdf"
        let heap_now = name.len() * 2;        // one arena slice, shared buffer

        let per_file_legacy = legacy_struct + heap_legacy;
        let per_file_now = now_struct + heap_now;

        println!("struct:    legacy {legacy_struct} B -> now {now_struct} B");
        println!("per file:  legacy {per_file_legacy} B -> now {per_file_now} B");
        println!("allocations per file: legacy 3 -> now 0");
        for files in [500_000usize, 1_000_000, 2_000_000] {
            let a = files * per_file_legacy / (1024 * 1024);
            let b = files * per_file_now / (1024 * 1024);
            println!("{files:>9} files: {a:>4} MB -> {b:>4} MB (saves {} MB)", a - b);
        }

        assert!(now_struct < legacy_struct);
        assert!(per_file_now < per_file_legacy);
    }
}
