CREATE TABLE category_budgets (
    id UUID PRIMARY KEY,
    profile_id UUID NOT NULL REFERENCES profiles(id),
    category_id UUID NOT NULL,
    category_type VARCHAR(7) NOT NULL DEFAULT 'expense' CHECK (category_type = 'expense'),
    month DATE NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
    limit_minor BIGINT NOT NULL CHECK (limit_minor BETWEEN 1 AND 99999999999),
    version INTEGER NOT NULL CHECK (version > 0),
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (profile_id, category_id, category_type) REFERENCES categories(profile_id, id, type),
    UNIQUE (profile_id, month, category_id)
);
