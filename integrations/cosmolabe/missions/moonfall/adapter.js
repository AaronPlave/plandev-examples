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
 * What the mission model evaluated for a selected imaging activity (AcquireSurveyImages computed attributes), as
 * read-only Cosmolabe observations: each taken image's footprint (camera corner rays on MoonTerrain, at the exposure
 * instant) and, apart from them, the survey target the activity was asked to cover. Every number shown is the
 * mission model's; nothing is recomputed here. Older model versions (v3) report only geometric coverage.
 */
const parse = (v) => (typeof v === 'string' ? (v ? JSON.parse(v) : null) : v);
const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;
const utc = (iso) => iso.replace('T', ' ').replace(/\.\d+Z$|Z$/, '').slice(0, 19) + ' UTC';
const m = (x) => (x >= 1000 ? `${(x / 1000).toFixed(2)} km` : `${x.toFixed(0)} m`);

export const observations = {
  body: 'Moon',
  /** Cyan acquired footprints and a yellow survey target, as the panel's legend describes them. */
  legend: [
    { color: '#33e6ff', text: 'Acquired footprints (simulated exposures)' },
    { color: '#ffd11a', text: 'Survey target (requested area)' },
  ],
  /**
   * @param span a simulated span; @param ctx { planId, datasetId }
   * @returns [{ spec, footprints: [{ title, time, rows }], region }] — `spec` is a Cosmolabe host observation.
   */
  of(span, ctx) {
    const a = span?.attributes;
    const r = a?.computedAttributes;
    if (span?.type !== 'AcquireSurveyImages' || !r) return [];
    const args = a.arguments ?? {};
    const drone = args.drone ?? vehicle;
    const features = parse(r.footprints)?.features ?? [];
    const regionGeo = parse(args.targetRegion);
    const ring = regionGeo ? (regionGeo.geometry ?? regionGeo).coordinates?.[0] : null;
    const geometric = r.geometricCoverage ?? r.targetCoverage ?? 0;
    const hasUsable = typeof r.usableCoverage === 'number';
    const frames = r.frames ?? [];
    const attempted = frames.length;
    const name = `${args.targetName || 'Survey'} (span ${span.span_id})`;
    const provenance = {
      id: `plandev:plan/${ctx.planId}/simulation_dataset/${ctx.datasetId}/span/${span.span_id}`,
      kind: 'observation',
      classification: 'planned',
      source: `PlanDev simulation dataset ${ctx.datasetId} (plan ${ctx.planId}), AcquireSurveyImages span ${span.span_id}`,
      version: String(ctx.datasetId),
    };
    const footprints = features.map((f) => {
      const p = f.properties;
      const usable = p.usability ? (p.usability === 'USABLE' ? 'usable' : `not usable: ${p.usabilityReason || p.usability}`) : 'not evaluated (model v3)';
      return {
        title: `Image ${p.frame + 1} of ${attempted}`,
        time: p.time,
        rows: [
          ['Exposure', utc(p.time)],
          ['Camera', `${drone} Survey Camera (${p.camera ?? 'conceptual'})`],
          ['Ground sample distance', `${p.gsdM.toFixed(2)} m`],
          ['Slant range', m(p.slantRangeM)],
          ['Science', usable],
          ['Trajectory', p.trajectoryId || '—'],
          ['Source', provenance.source],
        ],
      };
    });
    const geometricText = `${pct(geometric)} geometric coverage`;
    const label = regionGeo ? `${args.targetName || 'Target'} · Survey target · ${geometricText}` : undefined;
    let note = '';
    if (regionGeo && geometric === 0) {
      note = r.imagesTaken === 0
        ? 'No exposure produced a footprint, so nothing can cover the target.'
        : r.targetNearestFootprintM > 0
          ? `None of the ${r.imagesTaken} footprints reaches the target: the nearest is ${m(r.targetNearestFootprintM)} from its centre. The flight path does not pass over it during the imaging window.`
          : `None of the ${r.imagesTaken} footprints covers the target.`;
    }
    const region = regionGeo && {
      title: label,
      rows: [
        ['Requested by', `${span.type} “${args.targetName || 'survey'}” (${a.directiveId != null ? `directive ${a.directiveId}, ` : ''}span ${span.span_id})`],
        ['Extent', extent(ring)],
        ['Exposures', `${r.imagesTaken} taken of ${attempted} attempted${r.imagesSkipped ? ` (${r.imagesSkipped} skipped: outside the coast attitude or off the terrain)` : ''}`],
        ['Geometric coverage', `${pct(geometric)} — area inside any footprint (where the camera pointed)`],
        ...(hasUsable
          ? [['Usable coverage', `${pct(r.usableCoverage)} — ${r.imagesUsable} of ${r.imagesTaken} images meet the camera capability`],
             ['Capability', r.imagingCapability]]
          : [['Usable coverage', 'not evaluated by this model version (geometry only)']]),
        ['Source', provenance.source],
      ],
      note,
    };
    const spec = {
      name,
      target: 'Moon',
      instrument: `${drone} Survey Camera`,
      observer: drone,
      campaign: r.trajectoryId || undefined,
      provenance,
      // One group per taken image: footprint i was taken at its exposure instant.
      groups: features.length
        ? features.map((f) => ({ startTime: f.properties.time, endTime: f.properties.time }))
        : [{ startTime: new Date(span.startMs).toISOString(), endTime: new Date(span.endMs).toISOString() }],
      coverage: { kind: 'footprint', polygonLonLat: features.map((f) => f.geometry.coordinates[0]) },
      ...(ring ? { requestedRegion: { name: args.targetName || 'Survey target', label, polygonLonLat: ring } } : {}),
      footprintColor: [0.2, 0.9, 1],
      fillInObservations: false,
    };
    return [{ spec, footprints, region }];
  },
};

/** A ring's lat/lon extent and its size, for display. */
function extent(ring) {
  if (!ring?.length) return '—';
  const lats = ring.map((p) => p[1]), lons = ring.map((p) => p[0]);
  const R = 1737.4e3, rad = Math.PI / 180;
  // Polar stereographic metres: the frame the mission's coverage uses.
  const xy = ring.map(([lon, lat]) => { const rho = 2 * R * Math.tan(((90 + lat) * rad) / 2); return [rho * Math.cos(lon * rad), rho * Math.sin(lon * rad)]; });
  const w = Math.max(...xy.map((p) => p[0])) - Math.min(...xy.map((p) => p[0]));
  const h = Math.max(...xy.map((p) => p[1])) - Math.min(...xy.map((p) => p[1]));
  return `lat ${Math.min(...lats).toFixed(3)}° to ${Math.max(...lats).toFixed(3)}°, lon ${Math.min(...lons).toFixed(2)}° to ${Math.max(...lons).toFixed(2)}° (≈${m(w)} × ${m(h)})`;
}
