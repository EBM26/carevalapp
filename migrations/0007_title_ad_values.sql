-- 0007: a unique, editable title per car, and the ORIGINAL ad values (JSON),
-- kept apart from the working values so later uploads never replace them.
ALTER TABLE cars ADD COLUMN title TEXT;
ALTER TABLE cars ADD COLUMN ad_values TEXT;
