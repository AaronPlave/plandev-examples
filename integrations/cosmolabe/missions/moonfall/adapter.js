// MoonFall (examples/12-moonfall) adapter for the PlanDev Cosmolabe panel. The drones' trajectories are not in
// any kernel: each drone's position, velocity and attitude come from the selected PlanDev simulation, resource
// `<drone>.state` (examples/12-moonfall DroneState), supplied to the scene as a MissionState source. The mission
// model computed that trajectory (HopSolver); nothing here computes or interpolates a flight of its own beyond
// Cosmolabe's Hermite/SLERP between the simulation's samples.

export const body = 'Moon';
/** Activities without a drone argument are shown against Polaris-A. */
export const vehicle = 'Polaris-A';
export const vehicles = ['Polaris-A', 'Polaris-B', 'Polaris-C', 'Polaris-D'];

/** The drone a simulated activity belongs to (PerformHop, AcquireSurveyImages: the `drone` argument). */
export const vehicleOf = (span) => span?.attributes?.arguments?.drone ?? null;

export const missionState = {
  vehicles,
  resource: (v) => `${v}.state`,
  // DroneState: Moon-centred MOON_ME_DE421 km and km/s; quaternion scalar-first, MOON_ME_DE421 → body.
  position: { timeScale: 'UTC', frame: 'MOON_ME_DE421', center: 'Moon', positionUnits: 'km', velocityUnits: 'km/s' },
  attitude: { timeScale: 'UTC', quaternionOrder: 'scalar-first', referenceFrame: 'MOON_ME_DE421', bodyFrame: 'MOONFALL_DRONE', direction: 'reference-to-body' },
  /** One profile value as sample parts. */
  sample: (v) => ({
    position: [v.xKm, v.yKm, v.zKm],
    velocity: [v.vxKmps, v.vyKmps, v.vzKmps],
    quaternion: [v.qw, v.qx, v.qy, v.qz],
    phase: v.phase,
    trajectoryId: v.trajectoryId,
  }),
};

/**
 * What the mission model evaluated for a selected imaging activity (AcquireSurveyImages computed attributes): each
 * taken image's footprint (camera corner rays on MoonTerrain) and the requested target region, drawn in the scene
 * as read-only context beside the camera frustum. Coverage is the mission's number, not recomputed here.
 */
export const observations = {
  body: 'Moon',
  /** Planetocentric latitude, east longitude, MOON_ME_DE421 (the Moon's body frame in the catalog). */
  coordinates: {
    frame: 'MOON_ME_DE421',
    latitude: 'planetocentric',
    longitudeDirection: 'east',
    longitudeDomain: '-180..180',
    referenceShape: { kind: 'sphere', radiusKm: 1737.4 },
  },
  /** GeoJSON features for one simulated span (none for other activity types). */
  of(span) {
    const a = span?.attributes;
    const r = a?.computedAttributes;
    if (span?.type !== 'AcquireSurveyImages' || !r) return [];
    const parse = (v) => (typeof v === 'string' ? (v ? JSON.parse(v) : null) : v);
    const region = parse(a.arguments?.targetRegion);
    const pct = Math.round((r.targetCoverage ?? 0) * 100);
    const features = (parse(r.footprints)?.features ?? []).map((f) => ({
      geometry: f.geometry,
      properties: { name: `Image ${f.properties.frame + 1} (mission footprint)`, time: f.properties.time, gsdM: +f.properties.gsdM.toFixed(2) },
    }));
    if (region) {
      features.push({
        geometry: region,
        properties: { name: `${r.targetName || 'Target'}: ${pct}% covered (mission evaluation, ${r.imagesTaken} of ${r.frames.length} images taken)` },
      });
    }
    return features;
  },
};
