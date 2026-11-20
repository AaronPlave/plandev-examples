package moonfall.activities;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import gov.nasa.ammos.plandev.contrib.streamline.modeling.discrete.DiscreteEffects;
import gov.nasa.ammos.plandev.merlin.framework.annotations.ActivityType;
import gov.nasa.ammos.plandev.merlin.framework.annotations.ActivityType.EffectModel;
import gov.nasa.ammos.plandev.merlin.framework.annotations.AutoValueMapper;
import gov.nasa.ammos.plandev.merlin.framework.annotations.Export.Parameter;
import gov.nasa.ammos.plandev.merlin.framework.annotations.Subsystem;
import gov.nasa.ammos.plandev.merlin.protocol.types.Duration;
import moonfall.Camera;
import moonfall.Drone;
import moonfall.HopSolver;
import moonfall.HopSolver.Phase;
import moonfall.Mission;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;

import static gov.nasa.ammos.plandev.contrib.streamline.core.Resources.currentTime;
import static gov.nasa.ammos.plandev.contrib.streamline.core.Resources.currentValue;
import static gov.nasa.ammos.plandev.merlin.framework.ModelActions.delay;

/**
 * Take {@code frames} survey images, {@code intervalS} apart, with a drone's downward camera ({@link Camera}).
 *
 * <p>Each exposure uses the drone's exact simulated position and attitude at that instant (the hop's integrated
 * trajectory, not the 1 s display samples). An image is taken only while the drone holds its coast attitude
 * (nadir camera), {@link Camera#SETTLE_S} after the coast begins and before braking; any other exposure is
 * recorded as skipped with the reason, and makes no data. A taken image's footprint is the camera's corner rays on
 * the terrain. With a {@code targetRegion} (GeoJSON Polygon or Feature, lon/lat degrees), the result gives the
 * fraction of it the taken images cover.
 *
 * <p>Two coverages are reported, and they are different things. {@code geometricCoverage}: the fraction of the
 * target inside any taken footprint — where the camera pointed. {@code usableCoverage}: the same with only the images
 * that meet the conceptual camera's capability ({@link Camera#CAPABILITY}: image centre directly sunlit at a usable
 * incidence, smear within a pixel), evaluated at each exposure's own instant. Not modelled: scattered light in shadow
 * (this camera cannot use it), exposure control, noise, compression artefacts.
 */
@ActivityType("AcquireSurveyImages")
@Subsystem("payload")
public class AcquireSurveyImages {
  @Parameter
  public String drone = "Polaris-A";

  @Parameter
  public int frames = 8;

  @Parameter
  public double intervalS = 2.0;

  /** Name of the survey area, for display. */
  @Parameter
  public String targetName = "";

  /** Survey area as GeoJSON (Polygon geometry or Feature), [lon, lat] degrees; blank for none. */
  @Parameter
  public String targetRegion = "";

  @AutoValueMapper.Record
  public record Frame(double offsetS, String status, String reason, double centerLatitude, double centerLongitude, double slantRangeM, double gsdM,
                      String usability, String usabilityReason, double sunIncidenceDeg, double sunElevationDeg, String sunView, double smearPx) {}

  @AutoValueMapper.Record
  public record Result(
      int imagesTaken,
      int imagesSkipped,
      int imagesUsable,
      double dataMbit,
      String trajectoryId,
      String targetName,
      /** Fraction of the target inside any taken footprint (geometry only). */
      double geometricCoverage,
      /** Fraction of the target inside the footprints of usable images ({@link Camera#CAPABILITY}). */
      double usableCoverage,
      /** With a target: distance from its centroid to the nearest taken footprint (m, polar plane); 0 inside one, -1 without a target or images. */
      double targetNearestFootprintM,
      String imagingCapability,
      List<Frame> frames,
      String footprints) {}

  @EffectModel
  public Result run(Mission model) {
    final Drone d = model.drone(drone);
    final List<Frame> out = new ArrayList<>();
    final List<List<double[]>> taken = new ArrayList<>();
    final List<List<double[]>> usable = new ArrayList<>();
    final JsonArray features = new JsonArray();
    final Duration t0 = currentTime();
    String trajectoryId = "";
    DiscreteEffects.set(d.cameraOn, true);
    for (int k = 0; k < frames; k++) {
      if (k > 0) delay(Duration.of(Math.round(intervalS * 1e6), Duration.MICROSECONDS));
      final double offset = currentTime().minus(t0).ratioOver(Duration.SECOND);
      final Optional<Drone.Flying> flying = currentValue(d.flight);
      final Camera.Footprint fp;
      Camera.Quality quality = Camera.NOT_EVALUATED;
      if (flying.isEmpty()) {
        fp = skipped(Camera.Status.NOT_IN_IMAGING_ATTITUDE, "landed");
      } else {
        final HopSolver.Hop hop = flying.get().hop();
        trajectoryId = hop.trajectoryId();
        final double t = currentTime().minus(flying.get().start()).ratioOver(Duration.SECOND);
        final HopSolver.PhaseSpan coast = HopSolver.span(hop, Phase.COAST);
        if (t < coast.startS() + Camera.SETTLE_S || t >= coast.endS()) {
          fp = skipped(Camera.Status.NOT_IN_IMAGING_ATTITUDE, String.format(Locale.ROOT, "%s at %.1f s into the hop; images need the coast attitude (%.1f-%.1f s)",
              HopSolver.phaseAt(hop, t), t, coast.startS() + Camera.SETTLE_S, coast.endS()));
        } else {
          final double[][] rv = HopSolver.stateAt(hop, t);
          fp = Camera.footprint(rv[0], HopSolver.coastAttitude(rv[0], rv[1]), model.terrain);
          quality = Camera.quality(fp, rv[0], rv[1], model.planStart.plusNanos(currentTime().in(Duration.MICROSECONDS) * 1000), model.terrain);
        }
      }
      if (fp.status() == Camera.Status.OK) {
        taken.add(fp.corners());
        if (quality.usable()) usable.add(fp.corners());
        DiscreteEffects.set(d.imagesTaken, currentValue(d.imagesTaken) + 1);
        DiscreteEffects.set(d.dataStoredMbit, currentValue(d.dataStoredMbit) + Camera.MBIT_PER_IMAGE);
        features.add(feature(fp, quality, model.planStart.plusNanos(currentTime().in(Duration.MICROSECONDS) * 1000).toString(), k, trajectoryId));
      }
      out.add(new Frame(offset, fp.status().name(), fp.reason(), fp.center() == null ? 0 : fp.center()[0], fp.center() == null ? 0 : fp.center()[1],
          fp.slantRangeM(), fp.gsdM(), quality.usability().name(), quality.reason(), quality.sunIncidenceDeg(), quality.sunElevationDeg(), quality.sunView(), quality.smearPx()));
    }
    DiscreteEffects.set(d.cameraOn, false);
    final List<double[]> region = region(targetRegion);
    final double geometric = region.isEmpty() ? 0 : Camera.coverage(region, taken, 10);
    final double usableCoverage = region.isEmpty() ? 0 : Camera.coverage(region, usable, 10);
    final JsonObject fc = new JsonObject();
    fc.addProperty("type", "FeatureCollection");
    fc.add("features", features);
    return new Result(taken.size(), frames - taken.size(), usable.size(), taken.size() * Camera.MBIT_PER_IMAGE, trajectoryId, targetName,
        geometric, usableCoverage, region.isEmpty() ? -1 : Camera.nearestFootprintM(region, taken), Camera.CAPABILITY, out, fc.toString());
  }

  private static Camera.Footprint skipped(Camera.Status s, String reason) {
    return new Camera.Footprint(s, reason, null, List.of(), 0, 0, null);
  }

  private JsonObject feature(Camera.Footprint fp, Camera.Quality q, String time, int k, String trajectoryId) {
    final JsonArray ring = new JsonArray();
    for (int i = 0; i <= 4; i++) {
      final double[] c = fp.corners().get(i % 4);
      final JsonArray p = new JsonArray();
      p.add(c[1]);
      p.add(c[0]);
      ring.add(p);
    }
    final JsonArray rings = new JsonArray();
    rings.add(ring);
    final JsonObject geom = new JsonObject();
    geom.addProperty("type", "Polygon");
    geom.add("coordinates", rings);
    final JsonObject props = new JsonObject();
    props.addProperty("drone", drone);
    props.addProperty("frame", k);
    props.addProperty("time", time);
    props.addProperty("trajectoryId", trajectoryId);
    props.addProperty("slantRangeM", fp.slantRangeM());
    props.addProperty("gsdM", fp.gsdM());
    props.addProperty("usability", q.usability().name());
    props.addProperty("usabilityReason", q.reason());
    props.addProperty("sunIncidenceDeg", q.sunIncidenceDeg());
    props.addProperty("camera", String.format(Locale.ROOT, "survey %.0f°x%.0f°, nadir in coast attitude", Camera.H_FOV_DEG, Camera.V_FOV_DEG));
    props.addProperty("terrain", "MoonTerrain (see mission.terrain)");
    final JsonObject f = new JsonObject();
    f.addProperty("type", "Feature");
    f.add("geometry", geom);
    f.add("properties", props);
    return f;
  }

  /** The outer ring of a GeoJSON Polygon (or Feature of one) as [lat, lon]; empty for blank. */
  static List<double[]> region(String geojson) {
    if (geojson == null || geojson.isBlank()) return List.of();
    JsonObject g = JsonParser.parseString(geojson).getAsJsonObject();
    if (g.has("geometry")) g = g.getAsJsonObject("geometry");
    if (!"Polygon".equals(g.get("type").getAsString())) throw new IllegalArgumentException("targetRegion must be a GeoJSON Polygon");
    final List<double[]> out = new ArrayList<>();
    for (final JsonElement p : g.getAsJsonArray("coordinates").get(0).getAsJsonArray()) {
      out.add(new double[] {p.getAsJsonArray().get(1).getAsDouble(), p.getAsJsonArray().get(0).getAsDouble()});
    }
    return out;
  }
}
