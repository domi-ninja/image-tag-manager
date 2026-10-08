CREATE TABLE classification_timings (
    id INTEGER PRIMARY KEY,
    image_id INTEGER NOT NULL,
    threads INTEGER NOT NULL CHECK(threads > 0),
    elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms >= 0),
    recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX classification_timings_by_threads ON classification_timings(threads, elapsed_ms);
