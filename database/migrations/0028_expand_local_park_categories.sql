-- Expand the place category check before municipal and community rows are seeded.
ALTER TABLE places DROP CONSTRAINT IF EXISTS places_category_check;
ALTER TABLE places ADD CONSTRAINT places_category_check
    CHECK (category IN (
        'national', 'provincial', 'regional', 'island', 'municipal', 'community'
    ));
