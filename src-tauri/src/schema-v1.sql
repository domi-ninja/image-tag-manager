
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
        PRAGMA user_version=1;
