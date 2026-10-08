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
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoTag {
    pub id: i64,
    pub name: String,
    pub sources: Vec<TagSource>,
    pub hidden_from_search: bool,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub count: i64,
    pub hidden_from_search: bool,
    pub disable_tagging: bool,
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
        "INSERT OR IGNORE INTO image_tags(image_id,tag_id,source) SELECT ?1,id,?3 FROM tags WHERE id=?2 AND disable_tagging=0",
        params![image, id, source],
    )?;
    Ok(())
}
pub fn photo_tags(c: &Connection, image: i64) -> Result<Vec<PhotoTag>> {
    let mut stmt = c.prepare("SELECT t.id,t.name,group_concat(it.source),t.hidden_from_search FROM image_tags it JOIN tags t ON t.id=it.tag_id WHERE it.image_id=?1 GROUP BY t.id ORDER BY t.name")?;
    let rows = stmt.query_map([image], |r| {
        let sources: String = r.get(2)?;
        Ok(PhotoTag {
            id: r.get(0)?,
            name: r.get(1)?,
            sources: sources
                .split(',')
                .map(|s| match s {
                    "ai" => Ok(TagSource::Ai),
                    "user" => Ok(TagSource::User),
                    "folder" => Ok(TagSource::Folder),
                    _ => Err(rusqlite::Error::InvalidQuery),
                })
                .collect::<rusqlite::Result<_>>()?,
            hidden_from_search: r.get(3)?,
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
            .flat_map(|name| {
                name.split_whitespace()
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
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

impl Db {
    pub fn tags(&self, folder: Option<i64>) -> Result<Vec<Tag>> {
        let c = self.connect()?;
        let mut stmt=c.prepare("SELECT t.id,t.name,count(DISTINCT it.image_id),t.hidden_from_search,t.disable_tagging FROM tags t JOIN image_tags it ON it.tag_id=t.id JOIN images i ON i.id=it.image_id WHERE t.hidden_from_search=0 AND (?1 IS NULL OR i.folder_id=?1) GROUP BY t.id ORDER BY count(DISTINCT it.image_id) DESC,t.name LIMIT 80")?;
        let rows = stmt.query_map([folder], |r| {
            Ok(Tag {
                id: r.get(0)?,
                name: r.get(1)?,
                count: r.get(2)?,
                hidden_from_search: r.get(3)?,
                disable_tagging: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
    pub fn tag_catalog(&self, query: &str, orphans_only: bool, page: u32) -> Result<TagPage> {
        let mut c = self.connect()?;
        let tx = c.transaction()?;
        let query = query.trim().to_lowercase();
        let condition="instr(t.name,?1)>0 AND (?2=0 OR (t.hidden_from_search=0 AND t.disable_tagging=0 AND NOT EXISTS(SELECT 1 FROM image_tags it WHERE it.tag_id=t.id)))";
        let total = tx.query_row(
            &format!("SELECT count(*) FROM tags t WHERE {condition}"),
            params![query, orphans_only],
            |r| r.get(0),
        )?;
        let orphans=tx.query_row("SELECT count(*) FROM tags t WHERE t.hidden_from_search=0 AND t.disable_tagging=0 AND NOT EXISTS(SELECT 1 FROM image_tags it WHERE it.tag_id=t.id)",[],|r|r.get(0))?;
        let tags = {
            let mut stmt=tx.prepare(&format!("SELECT t.id,t.name,(SELECT count(DISTINCT image_id) FROM image_tags it WHERE it.tag_id=t.id),t.hidden_from_search,t.disable_tagging FROM tags t WHERE {condition} ORDER BY t.name LIMIT 50 OFFSET ?3"))?;
            let rows = stmt.query_map(params![query, orphans_only, i64::from(page) * 50], |r| {
                Ok(Tag {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    count: r.get(2)?,
                    hidden_from_search: r.get(3)?,
                    disable_tagging: r.get(4)?,
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
        let mut stmt=c.prepare("SELECT t.id,t.name,count(DISTINCT it.image_id),t.hidden_from_search,t.disable_tagging FROM tags t LEFT JOIN image_tags it ON it.tag_id=t.id WHERE (?2=0 AND instr(t.name,?1)>0) OR (?2=1 AND t.hidden_from_search=0 AND t.disable_tagging=0 AND substr(t.name,1,length(?1))=?1) GROUP BY t.id ORDER BY (t.name=?1) DESC,count(DISTINCT it.image_id) DESC,t.name LIMIT 60")?;
        let rows = stmt.query_map(params![query.trim().to_lowercase(), prefix], |r| {
            Ok(Tag {
                id: r.get(0)?,
                name: r.get(1)?,
                count: r.get(2)?,
                hidden_from_search: r.get(3)?,
                disable_tagging: r.get(4)?,
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
        let existing: Option<i64> = tx
            .query_row("SELECT id FROM tags WHERE name=?1", [&name], |r| r.get(0))
            .optional()?;
        let target = if let Some(target) = existing {
            target
        } else {
            tx.execute("INSERT INTO tags(name,hidden_from_search,disable_tagging) SELECT ?1,hidden_from_search,disable_tagging FROM tags WHERE id=?2",params![name,id])?;
            tx.last_insert_rowid()
        };
        let disabled: bool = tx.query_row(
            "SELECT disable_tagging FROM tags WHERE id=?1",
            [target],
            |r| r.get(0),
        )?;
        if disabled {
            let in_use: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM image_tags WHERE tag_id=?1)",
                [id],
                |r| r.get(0),
            )?;
            if in_use {
                bail!("This tag is disabled for image tagging");
            }
        }
        tx.execute("INSERT OR IGNORE INTO ignored_folder_tags(image_id,name) SELECT image_id,?2 FROM image_tags WHERE tag_id=?1 AND source='folder'",params![id,old])?;
        tx.execute("INSERT OR IGNORE INTO image_tags(image_id,tag_id,source) SELECT DISTINCT image_id,?2,'user' FROM image_tags WHERE tag_id=?1",params![id,target])?;
        tx.execute("DELETE FROM tags WHERE id=?1", [id])?;
        tx.commit()?;
        Ok(())
    }
    pub fn delete_tag(&self, id: i64) -> Result<()> {
        let c = self.connect()?;
        let changed = c.execute(
            "DELETE FROM tags WHERE id=?1 AND hidden_from_search=0 AND disable_tagging=0 AND NOT EXISTS(SELECT 1 FROM image_tags WHERE tag_id=?1)",
            [id],
        )?;
        if changed == 0 {
            bail!("Only unused tags without active options can be deleted.");
        }
        Ok(())
    }
    pub fn purge_orphan_tags(&self) -> Result<usize> {
        Ok(self.connect()?.execute(
            "DELETE FROM tags WHERE hidden_from_search=0 AND disable_tagging=0 AND NOT EXISTS(SELECT 1 FROM image_tags WHERE tag_id=tags.id)",
            [],
        )?)
    }
    pub fn set_tag_options(
        &self,
        id: i64,
        hidden_from_search: bool,
        disable_tagging: bool,
    ) -> Result<()> {
        let mut c = self.connect()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if tx.execute(
            "UPDATE tags SET hidden_from_search=?2,disable_tagging=?3 WHERE id=?1",
            params![id, hidden_from_search, disable_tagging],
        )? == 0
        {
            bail!("Tag no longer exists");
        }
        if disable_tagging {
            tx.execute("DELETE FROM image_tags WHERE tag_id=?1", [id])?;
        }
        tx.commit()?;
        Ok(())
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
    fn folder_names_split_on_spaces_but_keep_dashes_and_underscores() {
        let root = Path::new("collection");
        let image = root
            .join("Blue  Sky")
            .join("scifi.clothes")
            .join("road-trip")
            .join("snow_day")
            .join("image.jpg");
        let names = folder_names(root.to_str().unwrap(), image.to_str().unwrap());
        assert_eq!(
            names,
            vec!["blue", "road-trip", "scifi.clothes", "sky", "snow_day"]
        );
    }
    #[test]
    fn tag_options_control_search_and_future_assignments() {
        let (_dir, db, folder, id) = nested_fixture();
        let photo = db.photo(id).unwrap();
        let alps = photo.tags.iter().find(|tag| tag.name == "alps").unwrap().id;
        let hidden_orphan = tag_id(&db.connect().unwrap(), "hidden future").unwrap();
        db.set_tag_options(hidden_orphan, true, false).unwrap();

        db.set_tag_options(alps, true, false).unwrap();
        assert_eq!(count(&db, "alps"), 0);
        assert_eq!(
            db.search(&Search {
                tags: vec!["alps".into()],
                ..Default::default()
            })
            .unwrap()
            .total,
            0
        );
        assert!(db.tags(None).unwrap().iter().all(|tag| tag.id != alps));
        assert!(db.tag_suggestions("al", true).unwrap().is_empty());
        assert!(db.photo(id).unwrap().tags.iter().any(|tag| tag.id == alps));
        let hidden = db.tag_catalog("alps", false, 0).unwrap().tags.remove(0);
        assert!(hidden.hidden_from_search);
        assert!(!hidden.disable_tagging);

        db.set_tag_options(alps, true, true).unwrap();
        assert!(db.photo(id).unwrap().tags.iter().all(|tag| tag.id != alps));
        db.scan(&folder, &AtomicBool::new(false)).unwrap();
        assert!(db.photo(id).unwrap().tags.iter().all(|tag| tag.id != alps));
        db.store(
            id,
            classification(&["alps", "mountain"]),
            Some(photo.modified),
        )
        .unwrap();
        assert!(db.photo(id).unwrap().tags.iter().all(|tag| tag.id != alps));
        assert!(db.store(id, classification(&["alps"]), None).is_err());
        db.purge_orphan_tags().unwrap();
        assert!(db.tag_catalog("alps", false, 0).unwrap().tags[0].disable_tagging);
        assert!(db.tag_catalog("hidden future", false, 0).unwrap().tags[0].hidden_from_search);
        assert!(db.delete_tag(alps).is_err());
        assert!(db.delete_tag(hidden_orphan).is_err());

        db.set_tag_options(alps, false, false).unwrap();
        db.scan(&folder, &AtomicBool::new(false)).unwrap();
        assert!(db.photo(id).unwrap().tags.iter().any(|tag| tag.id == alps));
        assert_eq!(count(&db, "alps"), 1);
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
