ALTER TABLE transactions DROP CONSTRAINT transactions_source_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_source_check CHECK (source IN ('manual','screenshot'));

INSERT INTO categories(id,profile_id,type,name,normalized_name,icon,color,is_archived,created_at,updated_at)
SELECT gen_random_uuid(),p.id,k.type,'Не определено','не определено','circle','#9690AF',false,now(),now()
FROM profiles p CROSS JOIN (VALUES ('income'),('expense')) AS k(type)
ON CONFLICT ON CONSTRAINT uq_category_name DO NOTHING;

CREATE TABLE screenshot_imports (
 id UUID PRIMARY KEY, profile_id UUID NOT NULL REFERENCES profiles(id),
 file_sha256 CHAR(64) NOT NULL, capture_date DATE NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('queued','processing','ready','failed','confirmed','cancelled')),
 version INTEGER NOT NULL DEFAULT 1 CHECK (version>0),
 image BYTEA, result JSONB NOT NULL DEFAULT '{}'::jsonb,
 error TEXT NOT NULL DEFAULT '', lease_until TIMESTAMPTZ, lease_token UUID,
 confirmed_hash CHAR(64), receipt JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(profile_id,file_sha256)
);
CREATE INDEX ix_screenshot_queue ON screenshot_imports(created_at) WHERE status IN ('queued','processing');
CREATE INDEX ix_screenshot_profile ON screenshot_imports(profile_id,created_at DESC);
