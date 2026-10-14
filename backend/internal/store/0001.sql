CREATE TABLE profiles (
        id UUID PRIMARY KEY, name VARCHAR(50) NOT NULL,
        timezone VARCHAR(100) NOT NULL, currency VARCHAR(3) NOT NULL CHECK (currency = 'RUB'),
        created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE wallets (
        id UUID PRIMARY KEY, profile_id UUID NOT NULL UNIQUE REFERENCES profiles(id),
        name VARCHAR(50) NOT NULL, opening_balance_minor BIGINT NOT NULL CHECK (opening_balance_minor BETWEEN -99999999999 AND 99999999999),
        tracking_start_date DATE NOT NULL, version INTEGER NOT NULL CHECK (version > 0),
        created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE (profile_id, id)
    );
    CREATE TABLE categories (
        id UUID PRIMARY KEY, profile_id UUID NOT NULL REFERENCES profiles(id),
        type VARCHAR(7) NOT NULL CHECK (type IN ('income', 'expense')),
        name VARCHAR(50) NOT NULL, normalized_name TEXT NOT NULL,
        icon VARCHAR(30) NOT NULL, color VARCHAR(7) NOT NULL, is_archived BOOLEAN NOT NULL,
        created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE (profile_id, id, type),
        CONSTRAINT uq_category_name UNIQUE (profile_id, type, normalized_name)
    );
    CREATE TABLE transactions (
        id UUID PRIMARY KEY, profile_id UUID NOT NULL REFERENCES profiles(id),
        wallet_id UUID NOT NULL, category_id UUID NOT NULL, type VARCHAR(7) NOT NULL,
        amount_minor BIGINT NOT NULL CHECK (amount_minor BETWEEN 1 AND 99999999999),
        occurred_on DATE NOT NULL, note VARCHAR(500) NOT NULL,
        source VARCHAR(20) NOT NULL CHECK (source = 'manual'),
        version INTEGER NOT NULL CHECK (version > 0), deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
        FOREIGN KEY (profile_id, wallet_id) REFERENCES wallets(profile_id, id),
        FOREIGN KEY (profile_id, category_id, type) REFERENCES categories(profile_id, id, type)
    );
    CREATE INDEX ix_transaction_history ON transactions (profile_id, occurred_on DESC, id DESC);
    CREATE INDEX ix_transaction_category ON transactions (profile_id, category_id);
    CREATE TABLE monthly_budgets (
        id UUID PRIMARY KEY, profile_id UUID NOT NULL REFERENCES profiles(id), month DATE NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
        limit_minor BIGINT NOT NULL CHECK (limit_minor BETWEEN 1 AND 99999999999),
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE (profile_id, month)
    );
