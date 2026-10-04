# Database migrations

Refinery embeds `V<number>__description.sql` files at compile time and runs pending
migrations at startup. Start with the next unused integer. Keep SQL migrations in
this directory; `build.rs` makes changes here trigger recompilation.

- Treat committed/applied migrations as immutable. Add another migration to fix one.
- Do not add `BEGIN`, `COMMIT`, or `PRAGMA user_version`. Refinery owns transactions
  and records version, name, checksum, and applied timestamp in its history table.
- All pending migrations run in one transaction. An error rolls back that batch.
- Checksum drift, missing migrations, and newer database histories are errors, never
  reasons to recreate a managed index.
- Keep foreign keys and FTS triggers correct when rebuilding a table. Test upgrades
  with existing rows as well as fresh databases.

Run `cargo test --manifest-path src-tauri/Cargo.toml --lib` from the repo root.
The tests cover fresh startup, repeated startup, atomic failure/retry, checksums,
newer/unknown schemas, and the one-time discard of the two prototype schemas.

The prototype reset in `src/migrations.rs` is outside the migration history. It only
recognizes old `user_version` 1/2 databases without Refinery history. It copies no
records and cannot run on a Refinery-managed database.
