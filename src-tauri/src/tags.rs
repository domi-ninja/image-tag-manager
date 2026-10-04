use crate::db::{clean_tags, Db};
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TagSource {
    Ai,
    User,
    Folder,
    Legacy,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PhotoTag {
    pub id: i64,
    pub name: String,
    pub sources: Vec<TagSource>,
}
#[derive(Serialize, Debug)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub count: i64,
}
#[derive(Serialize)]
pub struct TagPage {
    pub tags: Vec<Tag>,
    pub total: i64,
    pub orphans: i64,
}

pub fn tag_id(c: &Connection, name: &str) -> Result<i64> {
    c.execute(
        "INSERT INTO tags(name) VALUES(?1) ON CONFLICT(name) DO NOTHING",
        [name],
    )?;
    Ok(c.query_row("SELECT id FROM tags WHERE name=?1", [name], |r| r.get(0))?)
}
pub fn attach(c: &Connection, image: i64, name: &str, source: &str) -> Result<()> {
    let id = tag_id(c, name)?;
    c.execute(
        "INSERT OR IGNORE INTO image_tags(image_id,tag_id,source) VALUES(?1,?2,?3)",
        params![image, id, source],
    )?;
    Ok(())
}
pub fn photo_tags(c: &Connection, image: i64) -> Result<Vec<PhotoTag>> {
    let mut stmt = c.prepare("SELECT t.id,t.name,group_concat(it.source) FROM image_tags it JOIN tags t ON t.id=it.tag_id WHERE it.image_id=?1 GROUP BY t.id ORDER BY t.name")?;
    let rows = stmt.query_map([image], |r| {
        let sources: String = r.get(2)?;
        Ok(PhotoTag {
            id: r.get(0)?,
            name: r.get(1)?,
            sources: sources
                .split(',')
                .map(|s| match s {
                    "ai" => TagSource::Ai,
                    "user" => TagSource::User,
                    "folder" => TagSource::Folder,
                    _ => TagSource::Legacy,
                })
                .collect(),
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
// Only ancestors beneath a configured root contribute tags, not the root itself.
pub fn folder_names(root: &str, path: &str) -> Vec<String> {
    let Some(parent) = Path::new(path).parent() else {
        return vec![];
    };
    let Ok(relative) = parent.strip_prefix(root) else {
        return vec![];
    };
    clean_tags(
        relative
            .components()
            .filter_map(|part| match part {
                std::path::Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect(),
    )
}
pub fn sync_folder_tags(c: &Connection, image: i64, root: &str, path: &str) -> Result<()> {
    let names = folder_names(root, path);
    for tag in photo_tags(c, image)? {
        if tag.sources.contains(&TagSource::Folder) && !names.contains(&tag.name) {
            c.execute(
                "DELETE FROM image_tags WHERE image_id=?1 AND tag_id=?2 AND source='folder'",
                params![image, tag.id],
            )?;
        }
    }
    for name in names {
        let ignored: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM ignored_folder_tags WHERE image_id=?1 AND name=?2)",
            params![image, name],
            |r| r.get(0),
        )?;
        if !ignored {
            attach(c, image, &name, "folder")?;
        }
    }
    Ok(())
}

pub fn migrate(c: &mut Connection) -> Result<()> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(include_str!("tags-schema.sql"))?;
    let photos = {
        let mut stmt = tx.prepare("SELECT i.id,i.path,f.path,i.tags_json FROM images i JOIN folders f ON f.id=i.folder_id")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (id, path, root, raw) in photos {
        let mut names: Vec<String> =
            serde_json::from_str(&raw).context("Could not migrate existing image tags")?;
        let mut stmt = tx.prepare("SELECT name FROM legacy_tags WHERE image_id=?1")?;
        names.extend(
            stmt.query_map([id], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?,
        );
        for name in clean_tags(names) {
            attach(&tx, id, &name, "legacy")?;
        }
        sync_folder_tags(&tx, id, &root, &path)?;
    }
    tx.execute_batch(
        "DROP TABLE legacy_tags; ALTER TABLE images DROP COLUMN tags_json; PRAGMA user_version=2;",
    )?;
    tx.commit()?;
    Ok(())
}

impl Db {
    pub fn tags(&self, folder: Option<i64>) -> Result<Vec<Tag>> {
        let c = self.connect()?;
        let mut stmt=c.prepare("SELECT t.id,t.name,count(DISTINCT it.image_id) FROM tags t JOIN image_tags it ON it.tag_id=t.id JOIN images i ON i.id=it.image_id WHERE ?1 IS NULL OR i.folder_id=?1 GROUP BY t.id ORDER BY count(DISTINCT it.image_id) DESC,t.name LIMIT 80")?;
        let rows = stmt.query_map([folder], |r| {
            Ok(Tag {
                id: r.get(0)?,
                name: r.get(1)?,
                count: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
    pub fn tag_catalog(&self, query: &str, orphans_only: bool, page: u32) -> Result<TagPage> {
        let mut c = self.connect()?;
        let tx = c.transaction()?;
        let query = query.trim().to_lowercase();
        let condition="instr(t.name,?1)>0 AND (?2=0 OR NOT EXISTS(SELECT 1 FROM image_tags it WHERE it.tag_id=t.id))";
        let total = tx.query_row(
            &format!("SELECT count(*) FROM tags t WHERE {condition}"),
            params![query, orphans_only],
            |r| r.get(0),
        )?;
        let orphans=tx.query_row("SELECT count(*) FROM tags t WHERE NOT EXISTS(SELECT 1 FROM image_tags it WHERE it.tag_id=t.id)",[],|r|r.get(0))?;
        let tags = {
            let mut stmt=tx.prepare(&format!("SELECT t.id,t.name,(SELECT count(DISTINCT image_id) FROM image_tags it WHERE it.tag_id=t.id) FROM tags t WHERE {condition} ORDER BY t.name LIMIT 50 OFFSET ?3"))?;
            let rows = stmt.query_map(params![query, orphans_only, i64::from(page) * 50], |r| {
                Ok(Tag {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    count: r.get(2)?,
                })
            })?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        Ok(TagPage {
            tags,
            total,
            orphans,
        })
    }
    pub fn tag_suggestions(&self, query: &str, prefix: bool) -> Result<Vec<Tag>> {
        let c = self.connect()?;
        let mut stmt=c.prepare("SELECT t.id,t.name,count(DISTINCT it.image_id) FROM tags t LEFT JOIN image_tags it ON it.tag_id=t.id WHERE (?2=0 AND instr(t.name,?1)>0) OR (?2=1 AND substr(t.name,1,length(?1))=?1) GROUP BY t.id ORDER BY (t.name=?1) DESC,count(DISTINCT it.image_id) DESC,t.name LIMIT 60")?;
        let rows = stmt.query_map(params![query.trim().to_lowercase(), prefix], |r| {
            Ok(Tag {
                id: r.get(0)?,
                name: r.get(1)?,
                count: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
    /// A global rename is a user edit. Collisions merge into the existing entity.
    pub fn rename_tag(&self, id: i64, name: &str) -> Result<()> {
        let name = clean_tags(vec![name.into()])
            .pop()
            .context("Enter a tag name")?;
        let mut c = self.connect()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let old: String = tx
            .query_row("SELECT name FROM tags WHERE id=?1", [id], |r| r.get(0))
            .optional()?
            .context("Tag no longer exists")?;
        if old == name {
            return Ok(());
        }
        let target = tag_id(&tx, &name)?;
        tx.execute("INSERT OR IGNORE INTO ignored_folder_tags(image_id,name) SELECT image_id,?2 FROM image_tags WHERE tag_id=?1 AND source='folder'",params![id,old])?;
        tx.execute("INSERT OR IGNORE INTO image_tags(image_id,tag_id,source) SELECT DISTINCT image_id,?2,'user' FROM image_tags WHERE tag_id=?1",params![id,target])?;
        tx.execute("DELETE FROM tags WHERE id=?1", [id])?;
        tx.commit()?;
        Ok(())
    }
    pub fn delete_tag(&self, id: i64) -> Result<()> {
        let c = self.connect()?;
        let changed = c.execute(
            "DELETE FROM tags WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM image_tags WHERE tag_id=?1)",
            [id],
        )?;
        if changed == 0 {
            bail!("Only unused tags can be deleted. This tag is in use or no longer exists.");
        }
        Ok(())
    }
    pub fn purge_orphan_tags(&self) -> Result<usize> {
        Ok(self.connect()?.execute(
            "DELETE FROM tags WHERE NOT EXISTS(SELECT 1 FROM image_tags WHERE tag_id=tags.id)",
            [],
        )?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Classification, Search};
    use std::sync::atomic::AtomicBool;

    fn nested_fixture() -> (tempfile::TempDir, Db, crate::db::Folder, i64) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("collection");
        let nested = root.join("Trips").join("Alps").join("Trips");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("one.jpg"), b"image").unwrap();
        let db = Db::new(dir.path().join("db")).unwrap();
        db.add_folder(root.to_str().unwrap()).unwrap();
        let folder = db.folders().unwrap().remove(0);
        db.scan(&folder, &AtomicBool::new(false)).unwrap();
        let id = db.next().unwrap().unwrap().id;
        (dir, db, folder, id)
    }
    fn classification(names: &[&str]) -> Classification {
        Classification {
            tags: names.iter().map(|s| s.to_string()).collect(),
            caption: "Photo".into(),
            category: None,
        }
    }
    fn count(db: &Db, query: &str) -> i64 {
        db.search(&Search {
            query: query.into(),
            ..Default::default()
        })
        .unwrap()
        .total
    }
    #[test]
    fn folder_and_ai_sources_share_entities_and_counts_and_manual_edits_keep_sources() {
        let (_dir, db, _, id) = nested_fixture();
        let photo = db.photo(id).unwrap();
        assert_eq!(
            photo
                .tags
                .iter()
                .map(|t| t.name.as_str())
                .collect::<Vec<_>>(),
            vec!["alps", "trips"]
        );
        assert!(photo
            .tags
            .iter()
            .all(|t| t.sources == vec![TagSource::Folder]));
        assert_eq!(count(&db, "alps"), 1);
        db.store(
            id,
            classification(&[" ALPS ", "alps", "snow"]),
            Some(photo.modified),
        )
        .unwrap();
        let alps = db
            .photo(id)
            .unwrap()
            .tags
            .into_iter()
            .find(|t| t.name == "alps")
            .unwrap();
        assert_eq!(alps.sources.len(), 2);
        assert_eq!(db.tag_catalog("alps", false, 0).unwrap().tags[0].count, 1);
        db.store(
            id,
            classification(&["alps", "trips", "snow", " My trip ", "my trip"]),
            None,
        )
        .unwrap();
        let photo = db.photo(id).unwrap();
        assert_eq!(photo.tags.len(), 4);
        assert_eq!(
            photo
                .tags
                .iter()
                .find(|t| t.name == "snow")
                .unwrap()
                .sources,
            vec![TagSource::Ai]
        );
        assert_eq!(
            photo
                .tags
                .iter()
                .find(|t| t.name == "my trip")
                .unwrap()
                .sources,
            vec![TagSource::User]
        );
    }
    #[test]
    fn removed_folder_tag_stays_removed_after_purge_and_rescan_and_user_tags_survive_reclassification(
    ) {
        let (_dir, db, folder, id) = nested_fixture();
        db.store(id, classification(&["alps", "favorite"]), None)
            .unwrap();
        assert_eq!(db.purge_orphan_tags().unwrap(), 1);
        db.scan(&folder, &AtomicBool::new(false)).unwrap();
        assert_eq!(count(&db, "trips"), 0);
        std::fs::write(db.photo(id).unwrap().path, b"different image contents").unwrap();
        db.scan(&folder, &AtomicBool::new(false)).unwrap();
        let photo = db.photo(id).unwrap();
        assert!(photo
            .tags
            .iter()
            .any(|t| t.name == "favorite" && t.sources == vec![TagSource::User]));
        db.store(id, classification(&["mountain"]), Some(photo.modified))
            .unwrap();
        assert_eq!(count(&db, "favorite"), 1);
        assert_eq!(count(&db, "alps"), 1);
        assert_eq!(count(&db, "mountain"), 1);
        assert_eq!(count(&db, "trips"), 0);
        db.store(id, classification(&[]), None).unwrap();
        assert!(db.photo(id).unwrap().tags.is_empty());
        db.scan(&folder, &AtomicBool::new(false)).unwrap();
        assert!(db.photo(id).unwrap().tags.is_empty());
    }
    #[test]
    fn rename_merges_relationships_updates_search_and_orphan_purge_keeps_used_tags() {
        let (_dir, db, folder, id) = nested_fixture();
        let before = db.photo(id).unwrap();
        let alps = before.tags.iter().find(|t| t.name == "alps").unwrap().id;
        let trips = before.tags.iter().find(|t| t.name == "trips").unwrap().id;
        assert!(db.delete_tag(alps).is_err());
        db.rename_tag(alps, " TRIPS ").unwrap();
        assert_eq!(count(&db, "alps"), 0);
        assert_eq!(count(&db, "trips"), 1);
        let photo = db.photo(id).unwrap();
        assert_eq!(photo.tags.len(), 1);
        assert_eq!(photo.tags[0].id, trips);
        assert!(photo.tags[0].sources.contains(&TagSource::User));
        assert_eq!(db.tag_catalog("trips", false, 0).unwrap().tags[0].count, 1);
        db.scan(&folder, &AtomicBool::new(false)).unwrap();
        assert_eq!(count(&db, "alps"), 0);
        assert_eq!(db.purge_orphan_tags().unwrap(), 0);
        db.remove_folder(folder.id).unwrap();
        assert_eq!(db.tag_catalog("", true, 0).unwrap().total, 1);
        assert_eq!(db.purge_orphan_tags().unwrap(), 1);
        assert_eq!(db.tag_catalog("", false, 0).unwrap().total, 0);
        let c = db.connect().unwrap();
        c.execute(
            "INSERT INTO image_search(image_search) VALUES('integrity-check')",
            [],
        )
        .unwrap();
    }
    #[test]
    fn catalog_and_suggestions_include_orphans_beyond_sidebar_limit() {
        let (_dir, db, _, _) = nested_fixture();
        let c = db.connect().unwrap();
        for n in 0..123 {
            tag_id(&c, &format!("unused {n:03}")).unwrap();
        }
        assert_eq!(db.tag_catalog("unused", true, 0).unwrap().tags.len(), 50);
        assert_eq!(db.tag_catalog("unused", true, 2).unwrap().tags.len(), 23);
        assert_eq!(db.tag_catalog("unused", true, 0).unwrap().total, 123);
        assert_eq!(
            db.tag_suggestions("unused 122", false).unwrap()[0].name,
            "unused 122"
        );
        let id = db.tag_suggestions("unused 122", false).unwrap()[0].id;
        db.delete_tag(id).unwrap();
        assert_eq!(db.tag_catalog("", true, 0).unwrap().total, 122);
        assert_eq!(db.tag_catalog("' OR 1=1 --", false, 0).unwrap().total, 0);
    }
    fn legacy_fixture(raw: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let c = Connection::open(dir.path().join("index.sqlite3")).unwrap();
        c.execute_batch(include_str!("schema-v1.sql")).unwrap();
        let root = dir.path().join("photos");
        let path = root.join("Trips").join("one.jpg");
        c.execute(
            "INSERT INTO folders(id,path,name) VALUES(1,?1,'Photos')",
            [root.to_string_lossy().as_ref()],
        )
        .unwrap();
        c.execute("INSERT INTO images(id,folder_id,path,filename,modified,size,seen,caption,tags_json,tags_text,status) VALUES(1,1,?1,'one.jpg',1,1,'old','Caption',?2,'forest','classified')",params![path.to_string_lossy(),raw]).unwrap();
        c.execute("INSERT INTO tags(image_id,name) VALUES(1,'woodland')", [])
            .unwrap();
        dir
    }
    #[test]
    fn migration_preserves_old_tags_backfills_folder_tags_and_is_repeatable() {
        let dir = legacy_fixture(r#"[" Forest ", "forest"]"#);
        let db = Db::new(dir.path()).unwrap();
        assert!(dir
            .path()
            .join("index.before-tag-entities.sqlite3")
            .is_file());
        let old = Connection::open(dir.path().join("index.before-tag-entities.sqlite3")).unwrap();
        assert_eq!(
            old.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        let photo = db.photo(1).unwrap();
        assert_eq!(photo.caption, "Caption");
        assert_eq!(photo.tags.len(), 3);
        assert_eq!(
            photo
                .tags
                .iter()
                .find(|t| t.name == "forest")
                .unwrap()
                .sources,
            vec![TagSource::Legacy]
        );
        assert_eq!(
            photo
                .tags
                .iter()
                .find(|t| t.name == "trips")
                .unwrap()
                .sources,
            vec![TagSource::Folder]
        );
        for name in ["forest", "woodland", "trips"] {
            assert_eq!(count(&db, name), 1);
        }
        let c = db.connect().unwrap();
        assert!(c.prepare("SELECT tags_json FROM images").is_err());
        assert_eq!(
            c.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
        c.execute(
            "INSERT INTO image_search(image_search) VALUES('integrity-check')",
            [],
        )
        .unwrap();
        drop(db);
        assert_eq!(Db::new(dir.path()).unwrap().photo(1).unwrap().tags.len(), 3);
    }
    #[test]
    fn invalid_legacy_data_rolls_back_migration_without_losing_originals() {
        let dir = legacy_fixture("not-json");
        assert!(Db::new(dir.path()).is_err());
        let c = Connection::open(dir.path().join("index.sqlite3")).unwrap();
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            c.query_row("SELECT tags_json FROM images", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "not-json"
        );
        assert_eq!(
            c.query_row("SELECT name FROM tags", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "woodland"
        );
    }
}

#[cfg(test)]
mod search_tests {
    use super::*;
    use crate::db::{Classification, Search};
    use std::sync::atomic::AtomicBool;

    #[test]
    fn exact_tags_combine_with_text_folder_and_status_without_prefix_or_caption_matches() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("images");
        std::fs::create_dir(&root).unwrap();
        for name in ["one.jpg", "two.jpg"] {
            std::fs::write(root.join(name), b"image").unwrap();
        }
        let db = Db::new(dir.path().join("db")).unwrap();
        db.add_folder(root.to_str().unwrap()).unwrap();
        let folder = db.folders().unwrap().remove(0);
        db.scan(&folder, &AtomicBool::new(false)).unwrap();
        let photos = db.search(&Search::default()).unwrap().images;
        for (photo, tags) in photos
            .iter()
            .zip([vec!["forest", "green trees"], vec!["forestry"]])
        {
            db.store(
                photo.id,
                Classification {
                    tags: tags.into_iter().map(String::from).collect(),
                    caption: "sunset forest".into(),
                    category: None,
                },
                None,
            )
            .unwrap();
        }
        let filter = Search {
            tags: vec![" FOREST ".into(), "green trees".into()],
            query: "sun".into(),
            folder_id: Some(folder.id),
            status: Some("classified".into()),
            ..Default::default()
        };
        assert_eq!(db.search(&filter).unwrap().total, 1);
        assert_eq!(
            db.search(&Search {
                tags: vec!["fore".into()],
                ..Default::default()
            })
            .unwrap()
            .total,
            0
        );
        assert_eq!(
            db.search(&Search {
                tags: vec!["forest".into(), "forestry".into()],
                ..Default::default()
            })
            .unwrap()
            .total,
            0
        );
        assert_eq!(
            db.search(&Search {
                tags: vec!["x'; DROP TABLE tags; --".into()],
                ..Default::default()
            })
            .unwrap()
            .total,
            0
        );
        assert_eq!(db.tag_suggestions("fo", true).unwrap().len(), 2);
        assert!(db.tag_suggestions("orest", true).unwrap().is_empty());
        assert_eq!(db.tag_suggestions("orest", false).unwrap().len(), 2);
    }
}
