// MRO (examples/05-orbiter) adapter for the PlanDev Cosmolabe panel: which scene objects the plan's
// activities belong to, and how a location/window proposed from the 3D view becomes input to the
// mission's own ScheduleTargetObservations goal. Nothing here decides whether an observation is
// possible: the goal does that, with the model's kernels, when the user runs scheduling in PlanDev.

const NAME_PREFIX = 'TargetObs '; // must match ScheduleTargetObservations.NAME_PREFIX
const EMPTY = '{"type":"FeatureCollection","features":[]}';

/** Every activity in an orbiter plan is MRO's; the scene object it is shown against. */
export const vehicle = 'MRO';
export const body = 'Mars';

export const targets = {
  goal: 'ScheduleTargetObservations',
  /** Cosmolabe body a proposed location must lie on. */
  body: 'Mars',
  /** What the goal's GeoJSON means (see ScheduleTargetObservations). */
  conventions: 'Mars, IAU_MARS body-fixed, planetocentric latitude, east-positive longitude in [-180, 180), degrees; window in UTC',
  /** How target coordinates are written, for drawing them in the scene (Mars IAU 2015 ellipsoid, as the globe). */
  coordinates: {
    latitude: 'planetocentric',
    longitudeDirection: 'east',
    longitudeDomain: '-180..180',
    referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] },
  },
  /** Staging allows at most this many targets in the goal (what one closest-pass search per target costs). */
  max: 20,

  /** The directive name the goal gives the observation it creates for target `id`. */
  directiveName: (id) => NAME_PREFIX + id,

  /** The target id an activity was created for, or null. */
  targetOf: (directiveName) => (directiveName?.startsWith(NAME_PREFIX) ? directiveName.slice(NAME_PREFIX.length) : null),

  /** Targets already in the goal's arguments: [{ id, name, latDeg, lonDeg, window, source }]. */
  read(args) {
    const fc = JSON.parse(args?.targets || EMPTY);
    const features = fc.type === 'Feature' ? [fc] : fc.features ?? [];
    return features
      .filter((f) => f.geometry?.type === 'Point')
      .map((f, i) => ({
        id: String(f.id ?? f.properties?.id ?? i),
        name: f.properties?.name ?? String(f.id ?? i),
        lonDeg: f.geometry.coordinates[0],
        latDeg: f.geometry.coordinates[1],
        window: f.properties?.window ?? null,
        source: f.properties?.source ?? null,
      }));
  },

  /** Mission-specific pre-checks; the goal repeats every one of them authoritatively. */
  check(p) {
    const problems = [];
    if (p.body !== 'Mars') problems.push(`MRO targets are on Mars, not ${p.body}`);
    if (!(Math.abs(p.latDeg) <= 90) || !(p.lonDeg >= -180 && p.lonDeg <= 180)) problems.push('latitude/longitude out of range');
    if (p.window && !(Date.parse(p.window.start) < Date.parse(p.window.end))) problems.push('the window is empty');
    return problems;
  },

  /** New goal arguments with proposal `p` added as one Point target, its window and provenance attached. */
  stage(args, p) {
    const fc = JSON.parse(args?.targets || EMPTY);
    const features = fc.type === 'Feature' ? [fc] : [...(fc.features ?? [])];
    if (features.length >= this.max) throw new Error(`at most ${this.max} targets`);
    features.push({
      type: 'Feature',
      id: p.id,
      properties: { id: p.id, name: p.name, ...(p.window ? { window: p.window } : {}), source: p.source },
      geometry: { type: 'Point', coordinates: [+p.lonDeg.toFixed(5), +p.latDeg.toFixed(5)] },
    });
    return { ...args, targets: JSON.stringify({ type: 'FeatureCollection', features }), rejectUnscheduled: true };
  },

  /** New goal arguments without target `id`. */
  remove(args, id) {
    const fc = JSON.parse(args?.targets || EMPTY);
    const features = (fc.type === 'Feature' ? [fc] : fc.features ?? []).filter((f) => String(f.id ?? f.properties?.id) !== id);
    return { ...args, targets: JSON.stringify({ type: 'FeatureCollection', features }) };
  },
};
