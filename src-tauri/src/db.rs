use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};
use walkdir::WalkDir;

#[derive(Clone)]
pub struct Db {
    pub root: PathBuf,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub enabled: bool,
    pub categories: Vec<String>,
    pub instructions: String,
    pub count: i64,
    pub pending: i64,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    pub id: i64,
    pub folder_id: i64,
    pub path: String,
    pub filename: String,
    pub caption: String,
    pub tags: Vec<String>,
    pub category: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub modified: i64,
}
#[derive(Default, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Search {
    #[serde(default)]
    pub query: String,
    pub folder_id: Option<i64>,
    pub tag: Option<String>,
    pub status: Option<String>,
    #[serde(default)]
    pub page: u32,
}
#[derive(Serialize)]
pub struct Page {
    pub images: Vec<Photo>,
    pub total: i64,
}
#[derive(Serialize)]
pub struct Tag {
    pub name: String,
    pub count: i64,
}
#[derive(Serialize)]
pub struct Stats {
    pub total: i64,
    pub classified: i64,
    pub pending: i64,
    pub errors: i64,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Classification {
    pub tags: Vec<String>,
    pub caption: String,
    #[serde(default)]
    pub category: Option<String>,
}

pub fn clean_tags(tags: Vec<String>) -> Vec<String> {
    let mut tags: Vec<_> = tags
        .into_iter()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(100).collect::<String>())
        .collect();
    tags.sort();
    tags.dedup();
    tags.truncate(40);
    tags
}
fn photo_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Photo> {
    let tags: String = r.get(5)?;
    Ok(Photo {
        id: r.get(0)?,
        folder_id: r.get(1)?,
        path: r.get(2)?,
        filename: r.get(3)?,
        caption: r.get(4)?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        category: r.get(6)?,
        status: r.get(7)?,
        error: r.get(8)?,
        modified: r.get(9)?,
    })
}
const COLUMNS:&str="i.id,i.folder_id,i.path,i.filename,i.caption,i.tags_json,i.category,i.status,i.error,i.modified";
impl Db {
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        let db = Self {
            root: root.as_ref().to_owned(),
        };
        std::fs::create_dir_all(db.root.join("thumbnails"))?;
        db.connect()?.execute_batch("PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS folders(id INTEGER PRIMARY KEY,path TEXT NOT NULL UNIQUE,name TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,categories TEXT NOT NULL DEFAULT '[]',instructions TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS images(id INTEGER PRIMARY KEY,folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,path TEXT NOT NULL UNIQUE,filename TEXT NOT NULL,modified INTEGER NOT NULL,size INTEGER NOT NULL,seen TEXT NOT NULL,caption TEXT NOT NULL DEFAULT '',tags_json TEXT NOT NULL DEFAULT '[]',tags_text TEXT NOT NULL DEFAULT '',category TEXT,status TEXT NOT NULL DEFAULT 'pending',error TEXT);
        CREATE INDEX IF NOT EXISTS images_folder ON images(folder_id);
        CREATE INDEX IF NOT EXISTS images_status ON images(status,folder_id);
        CREATE TABLE IF NOT EXISTS tags(image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,name TEXT NOT NULL,PRIMARY KEY(image_id,name));
        CREATE INDEX IF NOT EXISTS tags_name ON tags(name,image_id);
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS image_search USING fts5(filename,caption,tags_text,category,content='images',content_rowid='id',tokenize='unicode61 remove_diacritics 2');
        CREATE TRIGGER IF NOT EXISTS images_ai AFTER INSERT ON images BEGIN INSERT INTO image_search(rowid,filename,caption,tags_text,category) VALUES(new.id,new.filename,new.caption,new.tags_text,new.category); END;
        CREATE TRIGGER IF NOT EXISTS images_ad AFTER DELETE ON images BEGIN INSERT INTO image_search(image_search,rowid,filename,caption,tags_text,category) VALUES('delete',old.id,old.filename,old.caption,old.tags_text,old.category); END;
        CREATE TRIGGER IF NOT EXISTS images_au AFTER UPDATE OF filename,caption,tags_text,category ON images BEGIN INSERT INTO image_search(image_search,rowid,filename,caption,tags_text,category) VALUES('delete',old.id,old.filename,old.caption,old.tags_text,old.category); INSERT INTO image_search(rowid,filename,caption,tags_text,category) VALUES(new.id,new.filename,new.caption,new.tags_text,new.category); END;
        PRAGMA user_version=1;")?;
        Ok(db)
    }
    pub fn connect(&self) -> Result<Connection> {
        let c = Connection::open(self.root.join("index.sqlite3"))?;
        c.busy_timeout(Duration::from_secs(10))?;
        c.execute_batch("PRAGMA foreign_keys=ON;")?;
        Ok(c)
    }
    pub fn folders(&self) -> Result<Vec<Folder>> {
        let c = self.connect()?;
        let mut s=c.prepare("SELECT f.id,f.path,f.name,f.enabled,f.categories,f.instructions,count(i.id),coalesce(sum(i.status='pending'),0) FROM folders f LEFT JOIN images i ON i.folder_id=f.id GROUP BY f.id ORDER BY f.name,f.id")?;
        let rows = s.query_map([], |r| {
            let raw: String = r.get(4)?;
            Ok(Folder {
                id: r.get(0)?,
                path: r.get(1)?,
                name: r.get(2)?,
                enabled: r.get(3)?,
                categories: serde_json::from_str(&raw).unwrap_or_default(),
                instructions: r.get(5)?,
                count: r.get(6)?,
                pending: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
    pub fn add_folder(&self, path: &str) -> Result<()> {
        let path = Path::new(path)
            .canonicalize()
            .context("The folder could not be opened")?;
        if !path.is_dir() {
            bail!("Choose a folder")
        }
        for f in self.folders()? {
            let p = Path::new(&f.path);
            if path.starts_with(p) || p.starts_with(&path) {
                bail!("This folder overlaps an existing folder: {}", f.name)
            }
        }
        let name = path
            .file_name()
            .unwrap_or(path.as_os_str())
            .to_string_lossy();
        self.connect()?.execute(
            "INSERT INTO folders(path,name) VALUES(?1,?2)",
            params![path.to_string_lossy(), name],
        )?;
        Ok(())
    }
    pub fn save_folder(&self, f: Folder) -> Result<()> {
        if f.name.trim().is_empty() {
            bail!("Give the folder a name")
        }
        if f.instructions.len() > 4000 || f.categories.len() > 100 {
            bail!("Use at most 100 categories and 4,000 characters of instructions")
        }
        self.connect()?.execute(
            "UPDATE folders SET name=?1,enabled=?2,categories=?3,instructions=?4 WHERE id=?5",
            params![
                f.name.trim(),
                f.enabled,
                serde_json::to_string(&clean_tags(f.categories))?,
                f.instructions.trim(),
                f.id
            ],
        )?;
        Ok(())
    }
    pub fn remove_folder(&self, id: i64) -> Result<()> {
        self.connect()?
            .execute("DELETE FROM folders WHERE id=?1", [id])?;
        Ok(())
    }
    pub fn setting(&self, key: &str, default: &str) -> Result<String> {
        Ok(self
            .connect()?
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()?
            .unwrap_or(default.into()))
    }
    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.connect()?.execute("INSERT INTO settings VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value])?;
        Ok(())
    }
    pub fn stats(&self) -> Result<Stats> {
        Ok(self.connect()?.query_row("SELECT count(*),coalesce(sum(status='classified'),0),coalesce(sum(status='pending'),0),coalesce(sum(status='error'),0) FROM images",[],|r|Ok(Stats{total:r.get(0)?,classified:r.get(1)?,pending:r.get(2)?,errors:r.get(3)?}))?)
    }
    pub fn search(&self, q: &Search) -> Result<Page> {
        let c = self.connect()?;
        let tokens: Vec<_> = q
            .query
            .split(|ch: char| !ch.is_alphanumeric())
            .filter(|s| !s.is_empty())
            .take(30)
            .map(|s| format!("\"{}\"*", s))
            .collect();
        let fts = tokens.join(" AND ");
        let condition="(?1 IS NULL OR i.folder_id=?1) AND (?2 IS NULL OR i.status=?2) AND (?3 IS NULL OR EXISTS(SELECT 1 FROM tags t WHERE t.image_id=i.id AND t.name=?3))";
        let condition = if fts.is_empty() {
            condition.to_string()
        } else {
            format!("{condition} AND i.id IN (SELECT rowid FROM image_search WHERE image_search MATCH ?4)")
        };
        // A bound no-op keeps parameter counts consistent with empty searches.
        let condition = if fts.is_empty() {
            format!("{condition} AND length(?4)>=0")
        } else {
            condition
        };
        let total = c.query_row(
            &format!("SELECT count(*) FROM images i WHERE {condition}"),
            params![q.folder_id, q.status, q.tag, fts],
            |r| r.get(0),
        )?;
        let mut s=c.prepare(&format!("SELECT {COLUMNS} FROM images i WHERE {condition} ORDER BY i.filename COLLATE NOCASE,i.id LIMIT 48 OFFSET ?5"))?;
        let images = s
            .query_map(
                params![q.folder_id, q.status, q.tag, fts, i64::from(q.page) * 48],
                photo_row,
            )?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Page { images, total })
    }
    pub fn tags(&self, folder: Option<i64>) -> Result<Vec<Tag>> {
        let c = self.connect()?;
        let mut s=c.prepare("SELECT t.name,count(*) FROM tags t JOIN images i ON i.id=t.image_id WHERE ?1 IS NULL OR i.folder_id=?1 GROUP BY t.name ORDER BY count(*) DESC,t.name LIMIT 80")?;
        let rows = s.query_map([folder], |r| {
            Ok(Tag {
                name: r.get(0)?,
                count: r.get(1)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
    pub fn photo(&self, id: i64) -> Result<Photo> {
        Ok(self.connect()?.query_row(
            &format!("SELECT {COLUMNS} FROM images i WHERE id=?1"),
            [id],
            photo_row,
        )?)
    }
    pub fn next(&self) -> Result<Option<Photo>> {
        Ok(self.connect()?.query_row(&format!("SELECT {COLUMNS} FROM images i JOIN folders f ON f.id=i.folder_id WHERE i.status='pending' AND f.enabled=1 ORDER BY i.id LIMIT 1"),[],photo_row).optional()?)
    }
    pub fn retry(&self, folder: Option<i64>) -> Result<()> {
        self.connect()?.execute("UPDATE images SET status='pending',error=NULL WHERE status='error' AND (?1 IS NULL OR folder_id=?1)",[folder])?;
        Ok(())
    }
    pub fn store(
        &self,
        id: i64,
        classification: Classification,
        expected_modified: Option<i64>,
    ) -> Result<bool> {
        let mut c = self.connect()?;
        let tx = c.transaction()?;
        let tags = clean_tags(classification.tags);
        if tags.is_empty() {
            bail!("Classification returned no tags")
        }
        let n=tx.execute("UPDATE images SET caption=?1,tags_json=?2,tags_text=?3,category=?4,status='classified',error=NULL WHERE id=?5 AND (?6 IS NULL OR (modified=?6 AND status='pending'))",params![classification.caption.trim(),serde_json::to_string(&tags)?,tags.join(" "),classification.category,id,expected_modified])?;
        if n > 0 {
            tx.execute("DELETE FROM tags WHERE image_id=?1", [id])?;
            for tag in tags {
                tx.execute("INSERT INTO tags VALUES(?1,?2)", params![id, tag])?;
            }
        }
        tx.commit()?;
        Ok(n > 0)
    }
    pub fn fail(&self, id: i64, error: &str) -> Result<()> {
        self.connect()?.execute(
            "UPDATE images SET status='error',error=?1 WHERE id=?2 AND status='pending'",
            params![error, id],
        )?;
        Ok(())
    }
    /// A partial or cancelled traversal never removes existing indexed files.
    pub fn scan(&self, folder: &Folder, cancel: &std::sync::atomic::AtomicBool) -> Result<usize> {
        use std::sync::atomic::Ordering;
        if !Path::new(&folder.path).is_dir() {
            bail!("Folder unavailable: {}", folder.path)
        }
        let mut c = self.connect()?;
        let generation = uuid::Uuid::new_v4().to_string();
        let mut count = 0;
        for entry in WalkDir::new(&folder.path).follow_links(false) {
            if cancel.load(Ordering::Relaxed) {
                return Ok(count);
            }
            let entry = entry.context(
                "Could not read the entire folder; existing index entries were retained",
            )?;
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let ext = path
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            if !["jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff"].contains(&ext.as_str())
            {
                continue;
            }
            let meta = entry.metadata()?;
            let modified = meta
                .modified()?
                .duration_since(UNIX_EPOCH)?
                .as_nanos()
                .min(i64::MAX as u128) as i64;
            let path_string = path.to_string_lossy().to_string();
            let previous: Option<(i64, i64, i64)> = c
                .query_row(
                    "SELECT id,modified,size FROM images WHERE path=?1",
                    [&path_string],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            let tx = c.transaction()?;
            match previous {
                Some((id, m, size)) if m == modified && size == meta.len() as i64 => {
                    tx.execute(
                        "UPDATE images SET seen=?1 WHERE id=?2",
                        params![generation, id],
                    )?;
                }
                Some((id, _, _)) => {
                    tx.execute("DELETE FROM tags WHERE image_id=?1", [id])?;
                    tx.execute("UPDATE images SET modified=?1,size=?2,seen=?3,caption='',tags_json='[]',tags_text='',category=NULL,status='pending',error=NULL WHERE id=?4",params![modified,meta.len() as i64,generation,id])?;
                }
                None => {
                    tx.execute("INSERT INTO images(folder_id,path,filename,modified,size,seen) VALUES(?1,?2,?3,?4,?5,?6)",params![folder.id,path_string,entry.file_name().to_string_lossy(),modified,meta.len() as i64,generation])?;
                }
            }
            tx.commit()?;
            count += 1;
        }
        if !cancel.load(Ordering::Relaxed) {
            c.execute(
                "DELETE FROM images WHERE folder_id=?1 AND seen<>?2",
                params![folder.id, generation],
            )?;
        }
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    fn fixture() -> (tempfile::TempDir, Db, Folder) {
        let dir = tempfile::tempdir().unwrap();
        let images = dir.path().join("photos");
        std::fs::create_dir(&images).unwrap();
        std::fs::write(images.join("one.jpg"), b"image").unwrap();
        let db = Db::new(dir.path().join("db")).unwrap();
        db.add_folder(images.to_str().unwrap()).unwrap();
        let f = db.folders().unwrap().remove(0);
        db.scan(&f, &AtomicBool::new(false)).unwrap();
        (dir, db, f)
    }
    fn result() -> Classification {
        Classification {
            tags: vec![" Forest ".into(), "forest".into(), "green trees".into()],
            caption: "A sunny woodland".into(),
            category: Some("nature".into()),
        }
    }
    #[test]
    fn tags_and_fulltext_follow_edits_and_folder_removal() {
        let (_dir, db, f) = fixture();
        let id = db.next().unwrap().unwrap().id;
        db.store(id, result(), None).unwrap();
        assert_eq!(db.tags(None).unwrap().len(), 2);
        for query in ["forest", "woodl", "nature", "FOREST", "forest green"] {
            assert_eq!(
                db.search(&Search {
                    query: query.into(),
                    ..Default::default()
                })
                .unwrap()
                .total,
                1
            );
        }
        db.store(
            id,
            Classification {
                tags: vec!["city".into()],
                caption: "Street".into(),
                category: None,
            },
            None,
        )
        .unwrap();
        assert_eq!(
            db.search(&Search {
                query: "forest".into(),
                ..Default::default()
            })
            .unwrap()
            .total,
            0
        );
        db.remove_folder(f.id).unwrap();
        assert_eq!(
            db.search(&Search {
                query: "city".into(),
                ..Default::default()
            })
            .unwrap()
            .total,
            0
        );
        assert!(Path::new(&f.path).join("one.jpg").exists());
    }
    #[test]
    fn search_punctuation_is_literal_and_cannot_inject_sql_or_fts() {
        let (_dir, db, _) = fixture();
        for query in [
            "\"",
            "*",
            "forest OR city",
            "x'; DROP TABLE images; --",
            "near(foo)",
        ] {
            assert!(db
                .search(&Search {
                    query: query.into(),
                    ..Default::default()
                })
                .is_ok());
        }
        assert_eq!(db.stats().unwrap().total, 1);
    }
    #[test]
    fn unchanged_scan_preserves_tags_changed_file_requeues_and_deleted_file_disappears() {
        let (_dir, db, f) = fixture();
        let id = db.next().unwrap().unwrap().id;
        db.store(id, result(), None).unwrap();
        db.scan(&f, &AtomicBool::new(false)).unwrap();
        assert_eq!(db.stats().unwrap().classified, 1);
        std::fs::write(Path::new(&f.path).join("one.jpg"), b"changed image content").unwrap();
        db.scan(&f, &AtomicBool::new(false)).unwrap();
        assert_eq!(db.stats().unwrap().pending, 1);
        assert!(db.tags(None).unwrap().is_empty());
        std::fs::remove_file(Path::new(&f.path).join("one.jpg")).unwrap();
        db.scan(&f, &AtomicBool::new(false)).unwrap();
        assert_eq!(db.stats().unwrap().total, 0);
    }
    #[test]
    fn unavailable_or_cancelled_scan_keeps_index() {
        let (_dir, db, f) = fixture();
        std::fs::remove_file(Path::new(&f.path).join("one.jpg")).unwrap();
        db.scan(&f, &AtomicBool::new(true)).unwrap();
        assert_eq!(db.stats().unwrap().total, 1);
        std::fs::remove_dir(&f.path).unwrap();
        assert!(db.scan(&f, &AtomicBool::new(false)).is_err());
        assert_eq!(db.stats().unwrap().total, 1);
    }
    #[test]
    fn overlapping_folders_are_rejected() {
        let (_dir, db, f) = fixture();
        let sub = Path::new(&f.path).join("nested");
        std::fs::create_dir(&sub).unwrap();
        assert!(db.add_folder(&f.path).is_err());
        assert!(db.add_folder(sub.to_str().unwrap()).is_err());
    }
    #[test]
    fn background_results_do_not_overwrite_manual_edits() {
        let (_dir, db, _) = fixture();
        let p = db.next().unwrap().unwrap();
        db.store(p.id, result(), None).unwrap();
        assert!(!db
            .store(
                p.id,
                Classification {
                    tags: vec!["wrong".into()],
                    caption: "stale".into(),
                    category: None
                },
                Some(p.modified)
            )
            .unwrap());
        assert_eq!(db.photo(p.id).unwrap().caption, "A sunny woodland");
    }
    #[test]
    fn disabled_folder_stays_searchable_but_does_not_classify() {
        let (_dir, db, mut f) = fixture();
        f.enabled = false;
        db.save_folder(f).unwrap();
        assert!(db.next().unwrap().is_none());
        assert_eq!(db.search(&Search::default()).unwrap().total, 1);
    }
    #[test]
    fn folder_tag_status_filters_and_pagination() {
        let (dir, db, f) = fixture();
        let more = dir.path().join("more");
        std::fs::create_dir(&more).unwrap();
        for n in 0..60 {
            std::fs::write(more.join(format!("{n:02}.png")), b"test").unwrap();
        }
        db.add_folder(more.to_str().unwrap()).unwrap();
        let second = db
            .folders()
            .unwrap()
            .into_iter()
            .find(|x| x.id != f.id)
            .unwrap();
        db.scan(&second, &AtomicBool::new(false)).unwrap();
        let filter = Search {
            folder_id: Some(second.id),
            ..Default::default()
        };
        let first = db.search(&filter).unwrap();
        assert_eq!(first.total, 60);
        assert_eq!(first.images.len(), 48);
        let last = db.search(&Search { page: 1, ..filter }).unwrap();
        assert_eq!(last.images.len(), 12);
        let id = first.images[0].id;
        db.store(id, result(), None).unwrap();
        assert_eq!(
            db.search(&Search {
                tag: Some("forest".into()),
                status: Some("classified".into()),
                folder_id: Some(second.id),
                ..Default::default()
            })
            .unwrap()
            .total,
            1
        );
    }
}
