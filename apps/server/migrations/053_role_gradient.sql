-- Gradient role colours: an optional second colour stop (0xRRGGBB). Only meaningful while `color` is non-zero (enforced by the API).
ALTER TABLE roles ADD COLUMN IF NOT EXISTS color_secondary INTEGER;
