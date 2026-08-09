-- Allow wall_area masks (app uses this role; 001 schema omitted it → save error 23514).
ALTER TABLE shapes DROP CONSTRAINT IF EXISTS shapes_measure_role_check;
ALTER TABLE shapes ADD CONSTRAINT shapes_measure_role_check CHECK (measure_role IN (
  'floor_area', 'deduct', 'surface_area', 'linear', 'count', 'wall_area'
));
