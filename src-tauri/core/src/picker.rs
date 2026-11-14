//! In-app directory picker for non-local projects.
//! A newer navigation wins. A listing or read error cannot be confirmed.
//! Escape closes only the picker and leaves the project form path alone.

use serde_json::{json, Value};

#[derive(Clone)]
pub struct Session {
    pub id: String,
    pub host_id: String,
    pub form_path: String,
    pub generation: u64,
    pub pending_index: Option<isize>,
    pub history: Vec<String>,
    pub index: isize,
    pub address: String,
    pub query: String,
    pub selected: String,
    pub path: String,
    pub parent: Option<String>,
    pub dirs: Vec<Value>,
    pub error: Option<String>,
    pub loading: bool,
    pub closed: bool,
}

impl Session {
    pub fn open(id: String, host_id: String, initial: String, form_path: String) -> Self {
        Self {
            id,
            host_id,
            form_path,
            generation: 0,
            pending_index: None,
            history: Vec::new(),
            index: -1,
            address: initial,
            query: String::new(),
            selected: String::new(),
            path: String::new(),
            parent: None,
            dirs: Vec::new(),
            error: None,
            loading: true,
            closed: false,
        }
    }

    pub fn navigate(&mut self, input: String, history_index: Option<isize>) -> u64 {
        self.generation += 1;
        self.loading = true;
        self.error = None;
        self.selected.clear();
        self.query.clear();
        self.address = input;
        self.pending_index = history_index;
        self.generation
    }

    pub fn apply(&mut self, generation: u64, listing: Value) {
        if generation != self.generation || self.closed { return; }
        self.loading = false;
        self.path = listing["path"].as_str().unwrap_or(&self.address).to_string();
        self.address = self.path.clone();
        self.parent = listing["parent"].as_str().map(|value| value.to_string());
        self.error = listing["error"].as_str().map(|value| value.to_string()).filter(|value| !value.is_empty());
        self.dirs = listing["dirs"].as_array().cloned().unwrap_or_default();
        if self.error.is_none() {
            if let Some(index) = self.pending_index.take() {
                self.index = index;
            } else if self.history.get(self.index as usize).map(|path| path == &self.path).unwrap_or(false) {
            } else {
                let next = (self.index + 1) as usize;
                self.history.truncate(next);
                self.history.push(self.path.clone());
                self.index = self.history.len() as isize - 1;
            }
        }
    }

    pub fn click(&mut self, path: &str) { if !self.loading && self.error.is_none() { self.selected = path.to_string(); } }

    pub fn enter(&mut self, path: &str) -> Option<u64> {
        if self.loading || self.error.is_some() { return None; }
        self.selected = path.to_string();
        Some(self.navigate(path.to_string(), None))
    }

    pub fn back(&mut self) -> Option<u64> {
        if self.index <= 0 { return None; }
        let index = self.index - 1;
        let path = self.history.get(index as usize)?.clone();
        Some(self.navigate(path, Some(index)))
    }

    pub fn forward(&mut self) -> Option<u64> {
        let next = self.index + 1;
        let path = self.history.get(next as usize)?.clone();
        Some(self.navigate(path, Some(next)))
    }

    pub fn parent(&mut self) -> Option<u64> {
        let path = self.parent.clone()?;
        if self.loading { return None; }
        Some(self.navigate(path, None))
    }

    pub fn home(&mut self) -> u64 { self.navigate(String::new(), None) }

    pub fn filter(&mut self, query: String) {
        self.query = query;
        self.selected.clear();
    }

    pub fn filtered(&self) -> Vec<Value> {
        let query = self.query.to_lowercase();
        self.dirs.iter().filter(|entry| entry["name"].as_str().unwrap_or("").to_lowercase().contains(&query)).cloned().collect()
    }

    pub fn can_confirm(&self) -> bool { !self.closed && !self.loading && self.error.is_none() && !self.path.is_empty() }

    pub fn confirm(&self) -> Option<String> {
        if !self.can_confirm() { return None; }
        Some(if self.selected.is_empty() { self.path.clone() } else { self.selected.clone() })
    }

    pub fn esc(&mut self) -> String {
        self.closed = true;
        self.form_path.clone()
    }

    pub fn view(&self) -> Value {
        let windows = self.path.chars().nth(1) == Some(':');
        let crumbs: Vec<&str> = if windows { self.path.split(['\\', '/']).filter(|part| !part.is_empty()).collect() } else { self.path.split('/').filter(|part| !part.is_empty()).collect() };
        json!({
            "id": self.id,
            "hostId": self.host_id,
            "loading": self.loading,
            "error": self.error,
            "path": self.path,
            "parent": self.parent,
            "address": self.address,
            "query": self.query,
            "selected": self.selected,
            "dirs": self.filtered(),
            "crumbs": crumbs,
            "canBack": self.index > 0,
            "canForward": (self.index as usize) + 1 < self.history.len(),
            "canConfirm": self.can_confirm(),
            "closed": self.closed,
            "formPath": self.form_path,
            "generation": self.generation
        })
    }
}
