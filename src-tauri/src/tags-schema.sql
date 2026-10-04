ALTER TABLE tags RENAME TO legacy_tags;
CREATE TABLE tags(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE CHECK(length(name)>0));
CREATE TABLE image_tags(
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK(source IN ('ai','user','folder','legacy')),
    PRIMARY KEY(image_id,tag_id,source)
);
CREATE INDEX image_tags_tag ON image_tags(tag_id,image_id);
-- Suppress explicitly removed folder names independently of the tag entity's lifetime.
CREATE TABLE ignored_folder_tags(
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    PRIMARY KEY(image_id,name)
);
-- tags_text is only a derived FTS cache. The relationships above own the data.
UPDATE images SET tags_text='';
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
