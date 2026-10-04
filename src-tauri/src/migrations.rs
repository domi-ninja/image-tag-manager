use anyhow::{bail, Context, Result};
use rusqlite::{Connection, TransactionBehavior};

mod embedded {
    refinery::embed_migrations!("migrations");
}

fn runner() -> refinery::Runner {
    embedded::migrations::runner()
        .set_grouped(true)
        .set_abort_divergent(true)
        .set_abort_missing(true)
}

pub fn run(connection: &mut Connection) -> Result<()> {
    discard_prototype_index(connection)?;
    runner()
        .run(connection)
        .context("Database migration failed; no pending migrations were applied")?;
    Ok(())
}

// One-time clean break from the two prototype schemas, not a data conversion.
// Once Refinery owns an index, errors must never trigger this reset.
fn discard_prototype_index(connection: &mut Connection) -> Result<()> {
    let tx = connection.transaction_with_behavior(TransactionBehavior::Exclusive)?;
    let managed: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='refinery_schema_history')",
        [], |row| row.get(0),
    )?;
    if managed {
        return Ok(());
    }
    let version: i64 = tx.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let tables: i64 = tx.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        [],
        |row| row.get(0),
    )?;
    if version == 0 && tables == 0 {
        return Ok(());
    }
    let known_tables: i64 = tx.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('folders','images','tags')",
        [], |row| row.get(0),
    )?;
    if !matches!(version, 1 | 2) || known_tables != 3 {
        bail!("Unrecognized database schema. The index was left unchanged.");
    }
    tx.execute_batch(
        "
        DROP TRIGGER IF EXISTS images_ai;
        DROP TRIGGER IF EXISTS images_ad;
        DROP TRIGGER IF EXISTS images_au;
        DROP TRIGGER IF EXISTS image_tags_ai;
        DROP TRIGGER IF EXISTS image_tags_ad;
        DROP TABLE IF EXISTS image_search;
        DROP TABLE IF EXISTS image_tags;
        DROP TABLE IF EXISTS ignored_folder_tags;
        DROP TABLE tags;
        DROP TABLE images;
        DROP TABLE folders;
        DROP TABLE IF EXISTS settings;
        PRAGMA user_version=0;
    ",
    )?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use refinery::{Migration, Runner};

    #[test]
    fn fresh_install_records_history_and_reopening_preserves_data() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        run(&mut c).unwrap();
        c.execute("INSERT INTO tags(name) VALUES('keep me')", [])
            .unwrap();
        run(&mut c).unwrap();
        let applied = runner().get_applied_migrations(&mut c).unwrap();
        assert_eq!(applied.len(), runner().get_migrations().len());
        assert_eq!(
            applied[0].checksum(),
            runner().get_migrations()[0].checksum()
        );
        assert_eq!(
            c.query_row("SELECT name FROM tags", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "keep me"
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
    }
    #[test]
    fn pending_migrations_are_atomic_and_retryable() {
        let mut c = Connection::open_in_memory().unwrap();
        run(&mut c).unwrap();
        c.execute("INSERT INTO tags(name) VALUES('keep me')", [])
            .unwrap();
        let mut migrations = runner().get_migrations().clone();
        let next = migrations.last().unwrap().version() + 1;
        migrations.push(
            Migration::unapplied(
                &format!("V{next}__add_notes"),
                "CREATE TABLE notes(id INTEGER PRIMARY KEY);",
            )
            .unwrap(),
        );
        migrations.push(
            Migration::unapplied(
                &format!("V{}__broken", next + 1),
                "INSERT INTO missing_table VALUES(1);",
            )
            .unwrap(),
        );
        assert!(Runner::new(&migrations)
            .set_grouped(true)
            .run(&mut c)
            .is_err());
        assert!(c.prepare("SELECT * FROM notes").is_err());
        assert_eq!(
            runner().get_applied_migrations(&mut c).unwrap().len(),
            runner().get_migrations().len()
        );
        assert_eq!(
            c.query_row("SELECT name FROM tags", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "keep me"
        );
        migrations.pop();
        Runner::new(&migrations)
            .set_grouped(true)
            .run(&mut c)
            .unwrap();
        assert!(c.prepare("SELECT * FROM notes").is_ok());
        // An older binary must reject a newer history without wiping it.
        assert!(run(&mut c).is_err());
        assert!(c.prepare("SELECT * FROM notes").is_ok());
    }
    #[test]
    fn changed_checksum_and_unknown_unmanaged_schema_are_not_reset() {
        let mut c = Connection::open_in_memory().unwrap();
        run(&mut c).unwrap();
        c.execute("INSERT INTO tags(name) VALUES('keep me')", [])
            .unwrap();
        c.execute("UPDATE refinery_schema_history SET checksum='1'", [])
            .unwrap();
        assert!(run(&mut c).is_err());
        assert_eq!(
            c.query_row("SELECT name FROM tags", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "keep me"
        );
        let mut unknown = Connection::open_in_memory().unwrap();
        unknown.execute_batch("CREATE TABLE important(value TEXT); INSERT INTO important VALUES('keep me'); PRAGMA user_version=99;").unwrap();
        assert!(run(&mut unknown).is_err());
        assert_eq!(
            unknown
                .query_row("SELECT value FROM important", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "keep me"
        );
    }
    #[test]
    fn prototype_reset_creates_entity_schema_without_converting_strings_or_touching_files() {
        for prototype_version in [1, 2] {
            let dir = tempfile::tempdir().unwrap();
            std::fs::create_dir(dir.path().join("models")).unwrap();
            std::fs::write(dir.path().join("models/model.gguf"), b"model").unwrap();
            std::fs::write(dir.path().join("original.jpg"), b"original").unwrap();
            let c = Connection::open(dir.path().join("index.sqlite3")).unwrap();
            if prototype_version == 1 {
                c.execute_batch("CREATE TABLE folders(id INTEGER PRIMARY KEY); CREATE TABLE images(id INTEGER PRIMARY KEY,tags_json TEXT); CREATE TABLE tags(image_id INTEGER,name TEXT); INSERT INTO images VALUES(1,'malformed old tags'); PRAGMA user_version=1;").unwrap();
            } else {
                c.execute_batch(include_str!("../migrations/V1__initial_schema.sql"))
                    .unwrap();
                c.execute_batch("INSERT INTO folders(id,path,name) VALUES(1,'photos','Photos'); INSERT INTO images(id,folder_id,path,filename,modified,size,seen) VALUES(1,1,'photos/a.jpg','a.jpg',1,1,'scan'); INSERT INTO tags(id,name) VALUES(1,'old'); INSERT INTO image_tags VALUES(1,1,'user'); PRAGMA user_version=2;").unwrap();
            }

            drop(c);
            let db = crate::db::Db::new(dir.path()).unwrap();
            assert_eq!(db.stats().unwrap().total, 0);
            assert!(db.folders().unwrap().is_empty());
            let c = db.connect().unwrap();
            assert!(c.prepare("SELECT tags_json FROM images").is_err());
            assert_eq!(
                std::fs::read(dir.path().join("original.jpg")).unwrap(),
                b"original"
            );
            assert_eq!(
                std::fs::read(dir.path().join("models/model.gguf")).unwrap(),
                b"model"
            );
        }
    }
}
