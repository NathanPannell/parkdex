-- Allow the complete British Columbia catalogue, including Haida Gwaii,
-- the far north, and the eastern Rocky Mountains.
ALTER TABLE places DROP CONSTRAINT IF EXISTS places_latitude_check;
ALTER TABLE places DROP CONSTRAINT IF EXISTS places_longitude_check;
ALTER TABLE places ADD CONSTRAINT places_latitude_check CHECK (latitude BETWEEN 47 AND 61);
ALTER TABLE places ADD CONSTRAINT places_longitude_check CHECK (longitude BETWEEN -141 AND -113);
