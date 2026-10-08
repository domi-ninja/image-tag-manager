ALTER TABLE tags ADD COLUMN hidden_from_search INTEGER NOT NULL DEFAULT 0 CHECK(hidden_from_search IN (0, 1));
ALTER TABLE tags ADD COLUMN disable_tagging INTEGER NOT NULL DEFAULT 0 CHECK(disable_tagging IN (0, 1));

DROP TRIGGER image_tags_ai;
DROP TRIGGER image_tags_ad;

-- Search text is derived from visible tag assignments. The tag entity still exists
-- on the image when hidden, so it can be shown and edited in the viewer.
CREATE TRIGGER image_tags_ai AFTER INSERT ON image_tags BEGIN
    UPDATE images SET tags_text=(SELECT coalesce(group_concat(name,' '),'') FROM
        (SELECT DISTINCT t.name FROM tags t JOIN image_tags it ON it.tag_id=t.id WHERE it.image_id=new.image_id AND t.hidden_from_search=0 ORDER BY t.name))
    WHERE id=new.image_id;
END;
CREATE TRIGGER image_tags_ad AFTER DELETE ON image_tags BEGIN
    UPDATE images SET tags_text=(SELECT coalesce(group_concat(name,' '),'') FROM
        (SELECT DISTINCT t.name FROM tags t JOIN image_tags it ON it.tag_id=t.id WHERE it.image_id=old.image_id AND t.hidden_from_search=0 ORDER BY t.name))
    WHERE id=old.image_id;
END;
CREATE TRIGGER tags_search_visibility_au AFTER UPDATE OF hidden_from_search ON tags
WHEN old.hidden_from_search <> new.hidden_from_search BEGIN
    UPDATE images SET tags_text=(SELECT coalesce(group_concat(name,' '),'') FROM
        (SELECT DISTINCT t.name FROM tags t JOIN image_tags it ON it.tag_id=t.id WHERE it.image_id=images.id AND t.hidden_from_search=0 ORDER BY t.name))
    WHERE id IN (SELECT image_id FROM image_tags WHERE tag_id=new.id);
END;

UPDATE images SET tags_text=(SELECT coalesce(group_concat(name,' '),'') FROM
    (SELECT DISTINCT t.name FROM tags t JOIN image_tags it ON it.tag_id=t.id WHERE it.image_id=images.id AND t.hidden_from_search=0 ORDER BY t.name));
