ALTER TABLE transactions DROP CONSTRAINT transactions_source_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_source_check CHECK (source IN ('manual','screenshot','notification'));

CREATE TABLE notification_receipts (
 id UUID PRIMARY KEY,
 profile_id UUID NOT NULL REFERENCES profiles(id),
 request_sha256 CHAR(64) NOT NULL,
 transaction_id UUID NOT NULL REFERENCES transactions(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notification_receipts_profile ON notification_receipts(profile_id);
