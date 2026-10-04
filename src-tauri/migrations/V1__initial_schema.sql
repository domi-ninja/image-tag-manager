CREATE TABLE folders (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    categories TEXT NOT NULL DEFAULT '[]',
    instructions TEXT NOT NULL DEFAULT ''
);
CREATE TABLE images (
    id INTEGER PRIMARY KEY,
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    modified INTEGER NOT NULL,
    size INTEGER NOT NULL,
    seen TEXT NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    tags_text TEXT NOT NULL DEFAULT '',
    category TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT
);
CREATE INDEX images_folder ON images(folder_id);
CREATE INDEX images_status ON images(status,folder_id);
CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE CHECK(length(name)>0)
);
CREATE TABLE image_tags (
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK(source IN ('ai','user','folder')),
    PRIMARY KEY(image_id,tag_id,source)
);
CREATE INDEX image_tags_tag ON image_tags(tag_id,image_id);
CREATE TABLE ignored_folder_tags (
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    PRIMARY KEY(image_id,name)
);
CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE VIRTUAL TABLE image_search USING fts5(
    filename,caption,tags_text,category,
    content='images',content_rowid='id',tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER images_ai AFTER INSERT ON images BEGIN
    INSERT INTO image_search(rowid,filename,caption,tags_text,category)
    VALUES(new.id,new.filename,new.caption,new.tags_text,new.category);
END;
CREATE TRIGGER images_ad AFTER DELETE ON images BEGIN
    INSERT INTO image_search(image_search,rowid,filename,caption,tags_text,category)
    VALUES('delete',old.id,old.filename,old.caption,old.tags_text,old.category);
END;
CREATE TRIGGER images_au AFTER UPDATE OF filename,caption,tags_text,category ON images BEGIN
    INSERT INTO image_search(image_search,rowid,filename,caption,tags_text,category)
    VALUES('delete',old.id,old.filename,old.caption,old.tags_text,old.category);
    INSERT INTO image_search(rowid,filename,caption,tags_text,category)
    VALUES(new.id,new.filename,new.caption,new.tags_text,new.category);
END;
-- This is a derived FTS cache; tag entities and relationships own the data.
CREATE TRIGGER image_tags_ai AFTER INSERT ON image_tags BEGIN
    UPDATE images SET tags_text=(SELECT coalesce(group_concat(name,' '),'') FROM
        (SELECT DISTINCT t.name FROM tags t JOIN image_tags it ON it.tag_id=t.id WHERE it.image_id=new.image_id ORDER BY t.name))
    WHERE id=new.image_id;
END;
CREATE TRIGGER image_tags_ad AFTER DELETE ON image_tags BEGIN
    UPDATE images SET tags_text=(SELECT coalesce(group_concat(name,' '),'') FROM
        (SELECT DISTINCT t.name FROM tags t JOIN image_tags it ON it.tag_id=t.id WHERE it.image_id=old.image_id ORDER BY t.name))
    WHERE id=old.image_id;
END;
