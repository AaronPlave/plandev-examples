package moonfall;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class CameraTest {
  static final MoonTerrain T = MoonTerrain.get();

  @Test
  void raysSpanTheDeclaredFieldOfView() {
    final List<double[]> rays = Camera.rays();
    assertArrayEquals(Camera.BORESIGHT, rays.get(0), 0);
    for (final double[] c : rays.subList(1, 5)) {
      // Along track (body X) and across track (body Y) half-angles, measured from the -Z boresight.
      assertEquals(Camera.V_FOV_DEG / 2, Math.toDegrees(Math.atan2(Math.abs(c[0]), -c[2])), 1e-9);
      assertEquals(Camera.H_FOV_DEG / 2, Math.toDegrees(Math.atan2(Math.abs(c[1]), -c[2])), 1e-9);
    }
  }

  /** A drone 800 m above the terrain in coast attitude, moving toward +lon: the camera looks straight down. */
  @Test
  void nadirFootprintInCoastAttitude() {
    final double[] ground = T.surfacePoint(Vec.direction(-89.62, -30));
    final double[] up = Vec.unit(ground);
    final double[] r = Vec.axpy(ground, 800, up);
    final double[] east = Vec.unit(Vec.cross(Vec.of(0, 0, 1), up));
    final double[] v = Vec.scale(east, 50);
    final double[] q = HopSolver.coastAttitude(r, v);
    final Camera.Footprint fp = Camera.footprint(r, q, T);
    assertEquals(Camera.Status.OK, fp.status(), fp.reason());
    // Boresight hits the terrain directly below: slant range is the height above the terrain there.
    assertEquals(800, fp.slantRangeM(), 0.05);
    assertEquals(-89.62, fp.center()[0], 1e-6);
    assertEquals(-30, fp.center()[1], 1e-4);
    assertEquals(800 * Math.toRadians(Camera.H_FOV_DEG) / Camera.WIDTH_PX, fp.gsdM(), 1e-3);
    // Each corner is on the terrain, at its ray's angle from the boresight, and the image top is ahead (east).
    final double cornerAngle = Math.atan(Math.hypot(Math.tan(Math.toRadians(Camera.H_FOV_DEG / 2)), Math.tan(Math.toRadians(Camera.V_FOV_DEG / 2))));
    for (int i = 0; i < 4; i++) {
      final double[] c = fp.corners().get(i);
      final double[] p = T.surfacePoint(Vec.direction(c[0], c[1]));
      assertEquals(cornerAngle, Vec.angle(Vec.sub(p, r), Vec.scale(up, -1)), 2e-4);
      final double ahead = Vec.dot(Vec.sub(p, ground), east);
      assertTrue(i < 2 ? ahead > 0 : ahead < 0, "corners 0,1 are the image top, ahead along track");
    }
  }

  @Test
  void footprintUnavailableBeyondTheTerrain() {
    // 20.5 km from the pole, 4 km up: the outer rays reach past the packed terrain (22 km).
    final double[] ground = T.surfacePoint(Vec.direction(-90 + Math.toDegrees(20.5 / 1737.4), 45));
    final double[] r = Vec.axpy(ground, 4000, Vec.unit(ground));
    final Camera.Footprint fp = Camera.footprint(r, HopSolver.coastAttitude(r, Vec.of(0, 50, 0)), T);
    assertEquals(Camera.Status.NO_TERRAIN_INTERSECTION, fp.status());
    assertNull(fp.center());
  }

  @Test
  void coverageOfARegion() {
    final List<double[]> square = List.of(new double[] {-89.60, -30}, new double[] {-89.60, -29}, new double[] {-89.61, -29}, new double[] {-89.61, -30});
    final List<double[]> big = List.of(new double[] {-89.59, -31}, new double[] {-89.59, -28}, new double[] {-89.62, -28}, new double[] {-89.62, -31});
    final List<double[]> far = List.of(new double[] {-89.40, 10}, new double[] {-89.40, 11}, new double[] {-89.41, 11}, new double[] {-89.41, 10});
    assertEquals(1.0, Camera.coverage(square, List.of(big), 5));
    assertEquals(0.0, Camera.coverage(square, List.of(far), 5));
    // Half the square (split along its longitude midline) covered by a footprint over one half.
    final List<double[]> half = List.of(new double[] {-89.59, -31}, new double[] {-89.59, -29.5}, new double[] {-89.62, -29.5}, new double[] {-89.62, -31});
    assertEquals(0.5, Camera.coverage(square, List.of(half), 2), 0.03);
  }
}
