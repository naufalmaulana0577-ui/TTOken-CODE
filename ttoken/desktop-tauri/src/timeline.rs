//! Timestamped shell events, one JSON object per line, for startup measurements.
//!
//! Each line holds `wallMs` (milliseconds since the Unix epoch, comparable with timestamps the measurement
//! scripts take), `elapsedMs` (since this process started its timeline), the event name, and optional detail.
//! Events recorded before the log file is chosen are kept in memory and written when it opens.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// Event log shared by every shell component.
pub struct Timeline {
    start: Instant,
    sink: Mutex<Sink>,
}

struct Sink {
    file: Option<File>,
    pending: Vec<String>,
}

impl Timeline {
    /// Start the clock; call as early in `main` as possible.
    pub fn start() -> Self {
        Self {
            start: Instant::now(),
            sink: Mutex::new(Sink {
                file: None,
                pending: Vec::new(),
            }),
        }
    }

    /// Append to `path` from now on, after writing the events recorded so far.
    ///
    /// # Errors
    ///
    /// Returns the error from creating the parent directory or opening the file.
    pub fn open(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        let mut sink = self.sink.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        for line in sink.pending.drain(..) {
            file.write_all(line.as_bytes())?;
        }
        sink.file = Some(file);
        Ok(())
    }

    /// Record one event.
    pub fn mark(&self, event: &str, detail: &str) {
        let wall_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_millis());
        let elapsed_ms = self.start.elapsed().as_secs_f64() * 1000.0;
        let mut line = serde_json::json!({
            "wallMs": wall_ms,
            "elapsedMs": (elapsed_ms * 10.0).round() / 10.0,
            "event": event,
        });
        if !detail.is_empty() {
            line["detail"] = serde_json::Value::from(detail);
        }
        let mut text = line.to_string();
        text.push('\n');
        eprint!("ttoken-shell {text}");
        let mut sink = self.sink.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match sink.file.as_mut() {
            // A failed write loses one diagnostic line; it never stops the shell.
            Some(file) => drop(file.write_all(text.as_bytes())),
            None => sink.pending.push(text),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Timeline;

    #[test]
    fn writes_events_recorded_before_and_after_opening() {
        let directory = std::env::temp_dir().join(format!("ttoken-timeline-{}", std::process::id()));
        let path = directory.join("timeline.jsonl");
        let timeline = Timeline::start();
        timeline.mark("early", "");
        timeline.open(&path).expect("open timeline");
        timeline.mark("late", "detail");
        let text = std::fs::read_to_string(&path).expect("read timeline");
        let events: Vec<serde_json::Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).expect("json line"))
            .collect();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["event"], "early");
        assert_eq!(events[1]["detail"], "detail");
        assert!(events[1]["wallMs"].as_u64().expect("wall clock") > 0);
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }
}
