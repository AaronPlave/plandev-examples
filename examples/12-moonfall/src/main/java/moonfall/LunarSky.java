package moonfall;

import gov.nasa.ammos.plandev.geometry.spice.SpiceUtils;
import spice.basic.CSPICE;
import spice.basic.SpiceErrorException;

import java.nio.file.Path;
import java.time.Instant;

/**
 * The Sun and the Earth as seen from a point on (or above) the Moon, from SPICE.
 *
 * <p>Kernels: the shared {@code spice-kernels/} set (SPICE_DIRECTORY), which for this needs DE440s planetary
 * ephemerides ({@code de440s.bsp}), the leap seconds ({@code naif0012.tls}) and the DE421 lunar orientation that
 * the terrain, the drone states and Cosmolabe's MoonFall scene all use: {@code moon_pa_de421_1900_2050.bpc} with
 * {@code moon_080317.tf} (frame {@value #FRAME}). The two lunar kernels are byte-identical to Cosmolabe's
 * (LRO PDS archive lrosp_1000).
 *
 * <p>Directions are from the observer point (not the Moon's centre: the Earth's parallax across 1737 km is 0.26°),
 * light-time and stellar-aberration corrected (LT+S, the observer's apparent sky). Elevation is above the
 * <b>reference-sphere</b> horizon (the plane normal to the radial at the point) — not the terrain horizon: a body
 * above it can still be hidden by mountains. {@link #terrainBlocked} tells the two apart within the terrain pack.
 */
public final class LunarSky {
  private LunarSky() {}

  public static final String FRAME = "MOON_ME_DE421";
  private static boolean loaded;

  /** Loads the kernel set once per JVM and checks that the lunar frame and its orientation data are present. */
  public static synchronized void ensureKernels() {
    if (loaded) return;
    final Path dir = Path.of(System.getenv().getOrDefault("SPICE_DIRECTORY", "spice-kernels"));
    try {
      SpiceUtils.initialize(dir);
      if (CSPICE.namfrm(FRAME) == 0) {
        throw new IllegalStateException(FRAME + " is not defined: " + dir.toAbsolutePath() + " needs moon_080317.tf and moon_pa_de421_1900_2050.bpc");
      }
    } catch (SpiceErrorException e) {
      throw new IllegalStateException("SPICE kernels in " + dir.toAbsolutePath() + " could not be loaded", e);
    }
    loaded = true;
  }

  /** ET (TDB seconds past J2000) of a UTC instant. */
  public static double et(Instant t) {
    ensureKernels();
    try {
      return CSPICE.str2et(t.toString());
    } catch (SpiceErrorException e) {
      throw new IllegalStateException(e);
    }
  }

  /** Unit vector from {@code observerM} (MOON_ME_DE421, metres from the Moon's centre) toward SUN or EARTH. */
  public static double[] direction(String target, Instant t, double[] observerM) {
    ensureKernels();
    try {
      final double[] p = new double[3], lt = new double[1];
      // Target as seen from the Moon's centre, then shifted to the observer (parallax).
      CSPICE.spkpos(target, et(t), FRAME, "LT+S", "MOON", p, lt);
      return Vec.unit(Vec.sub(Vec.scale(p, 1000), observerM));
    } catch (SpiceErrorException e) {
      throw new IllegalStateException(target + " from the Moon at " + t + ": " + e.getMessage(), e);
    }
  }

  /** Degrees above the reference-sphere horizon at {@code observerM}. */
  public static double elevationDeg(double[] observerM, double[] direction) {
    return 90 - Math.toDegrees(Vec.angle(Vec.unit(observerM), direction));
  }

  /** Terrain visibility of a direction from a point, within the shipped terrain pack only. */
  public enum TerrainView { CLEAR_WITHIN_TERRAIN_PACK, BLOCKED_BY_TERRAIN, BELOW_HORIZON }

  /**
   * Whether the terrain pack's own surface hides {@code direction} from {@code observerM} (raised 2 m, a mast
   * height). CLEAR only means no terrain <em>in the pack</em> (22 km around the pole) is in the way; farther
   * massifs are not represented.
   */
  public static TerrainView terrainBlocked(MoonTerrain terrain, double[] observerM, double[] direction) {
    if (elevationDeg(observerM, direction) <= 0) return TerrainView.BELOW_HORIZON;
    final double[] from = Vec.axpy(observerM, 2, Vec.unit(observerM));
    return terrain.intersect(from, direction, 40_000, 20) != null ? TerrainView.BLOCKED_BY_TERRAIN : TerrainView.CLEAR_WITHIN_TERRAIN_PACK;
  }
}
