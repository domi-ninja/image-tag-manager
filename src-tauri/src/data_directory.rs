use anyhow::{bail, Context, Result};
use std::{fs, path::Path};

/// Move the previous app's library, models, and staged updates before opening them.
pub(crate) fn migrate(root: &Path) -> Result<()> {
    let legacy = root.with_file_name("com.domi.imageshelf");
    if !legacy.try_exists()? {
        return Ok(());
    }
    if root.try_exists()? {
        // Tauri or a previous launch may have already created an empty directory.
        if fs::read_dir(root)?.next().is_some() {
            bail!(
                "Both {} and {} contain app data. Resolve the directories before starting; neither has been changed.",
                legacy.display(),
                root.display()
            );
        }
        fs::remove_dir(root)?;
    }
    fs::rename(&legacy, root).with_context(|| {
        format!(
            "Could not move app data from {} to {}",
            legacy.display(),
            root.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_existing_data_once() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("com.domi.imageshelf");
        let root = dir.path().join("ninja.domi.image-tag-manager");
        fs::create_dir_all(legacy.join("models")).unwrap();
        fs::write(legacy.join("models/weights"), b"model").unwrap();
        fs::write(legacy.join("index.sqlite3"), b"library").unwrap();
        fs::create_dir(&root).unwrap();
        migrate(&root).unwrap();
        migrate(&root).unwrap();
        assert!(!legacy.exists());
        assert_eq!(fs::read(root.join("index.sqlite3")).unwrap(), b"library");
        assert_eq!(fs::read(root.join("models/weights")).unwrap(), b"model");
    }

    #[test]
    fn leaves_conflicting_libraries_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("com.domi.imageshelf");
        let root = dir.path().join("ninja.domi.image-tag-manager");
        for path in [&legacy, &root] {
            fs::create_dir(path).unwrap();
            fs::write(path.join("index.sqlite3"), b"library").unwrap();
        }
        assert!(migrate(&root).is_err());
        for path in [&legacy, &root] {
            assert_eq!(fs::read(path.join("index.sqlite3")).unwrap(), b"library");
        }
    }

    #[test]
    fn fresh_install_needs_no_migration() {
        let dir = tempfile::tempdir().unwrap();
        migrate(&dir.path().join("ninja.domi.image-tag-manager")).unwrap();
    }
}
