// Shared catalogs for the map editor (labels come from i18n `factoryMap.block_*`).

// 3D shapes assignable to a production machine ('auto' = heuristic by name).
export const BLOCK_KINDS = [
  'auto', 'cobot', 'conveyor', 'assembly_line', 'lift_table', 'beam_saw', 'pit_stop', 'box',
] as const;

// Kinds a decorative prop can take (matches PROP_CATALOG in Factory3D).
export const PROP_KINDS = [
  'conveyor', 'lift_table', 'work_table', 'rack', 'dust_collector', 'cobot', 'box',
] as const;
