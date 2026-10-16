ALTER TABLE wallets DROP CONSTRAINT wallets_profile_id_key;
ALTER TABLE wallets ADD COLUMN kind TEXT NOT NULL DEFAULT 'cash' CHECK (kind IN ('cash','savings','deposit','investment'));
ALTER TABLE wallets ADD COLUMN is_primary BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE wallets ADD COLUMN is_archived BOOLEAN NOT NULL DEFAULT false;
UPDATE wallets SET is_primary=true;
ALTER TABLE wallets ADD CONSTRAINT primary_wallet_cash CHECK (NOT is_primary OR (kind='cash' AND NOT is_archived));
CREATE UNIQUE INDEX uq_primary_wallet ON wallets(profile_id) WHERE is_primary;
ALTER TABLE screenshot_imports ADD COLUMN account_id UUID;
UPDATE screenshot_imports s SET account_id=(SELECT id FROM wallets w WHERE w.profile_id=s.profile_id AND w.is_primary);
ALTER TABLE screenshot_imports ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE screenshot_imports ADD FOREIGN KEY (profile_id,account_id) REFERENCES wallets(profile_id,id);

CREATE TABLE account_transfers (
 id UUID PRIMARY KEY, profile_id UUID NOT NULL REFERENCES profiles(id),
 from_account_id UUID NOT NULL, to_account_id UUID NOT NULL,
 amount_minor BIGINT NOT NULL CHECK (amount_minor BETWEEN 1 AND 99999999999),
 occurred_on DATE NOT NULL, note VARCHAR(500) NOT NULL DEFAULT '',
 version INTEGER NOT NULL DEFAULT 1 CHECK (version>0), deleted_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK (from_account_id<>to_account_id),
 FOREIGN KEY (profile_id,from_account_id) REFERENCES wallets(profile_id,id),
 FOREIGN KEY (profile_id,to_account_id) REFERENCES wallets(profile_id,id)
);
CREATE INDEX ix_transfer_profile ON account_transfers(profile_id,occurred_on DESC,id);
CREATE TABLE account_valuations (
 id UUID PRIMARY KEY, profile_id UUID NOT NULL REFERENCES profiles(id), account_id UUID NOT NULL,
 amount_minor BIGINT NOT NULL CHECK (amount_minor BETWEEN 0 AND 99999999999),
 previous_minor NUMERIC NOT NULL, delta_minor NUMERIC NOT NULL,
 occurred_on DATE NOT NULL, request_version INTEGER NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK (delta_minor=amount_minor-previous_minor),
 FOREIGN KEY (profile_id,account_id) REFERENCES wallets(profile_id,id)
);
CREATE INDEX ix_valuation_profile ON account_valuations(profile_id,occurred_on DESC,id);

CREATE VIEW account_entries AS
 SELECT profile_id,id AS account_id,tracking_start_date AS occurred_on,opening_balance_minor::numeric AS delta_minor FROM wallets
 UNION ALL SELECT profile_id,wallet_id,occurred_on,CASE WHEN type='income' THEN amount_minor::numeric ELSE -amount_minor::numeric END FROM transactions WHERE deleted_at IS NULL
 UNION ALL SELECT profile_id,from_account_id,occurred_on,-amount_minor::numeric FROM account_transfers WHERE deleted_at IS NULL
 UNION ALL SELECT profile_id,to_account_id,occurred_on,amount_minor::numeric FROM account_transfers WHERE deleted_at IS NULL
 UNION ALL SELECT profile_id,account_id,occurred_on,delta_minor FROM account_valuations;
