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

  // --- Usable science (Camera.CAPABILITY), 15 Dec 2028 11:01 UTC: the Sun 0.3 deg above the polar horizon ---------

  static Camera.Footprint nadir(double lat, double lon, double heightM, double speedMps) {
    final double[] ground = T.surfacePoint(Vec.direction(lat, lon));
    final double[] up = Vec.unit(ground);
    final double[] r = Vec.axpy(ground, heightM, up);
    final double[] v = Vec.scale(Vec.unit(Vec.cross(Vec.of(0, 0, 1), up)), speedMps);
    return Camera.footprint(r, HopSolver.coastAttitude(r, v), T);
  }

  static Camera.Quality quality(double lat, double lon, double speedMps) {
    final double[] ground = T.surfacePoint(Vec.direction(lat, lon));
    final double[] up = Vec.unit(ground);
    final double[] r = Vec.axpy(ground, 800, up);
    final double[] v = Vec.scale(Vec.unit(Vec.cross(Vec.of(0, 0, 1), up)), speedMps);
    return Camera.quality(nadir(lat, lon, 800, speedMps), r, v, java.time.Instant.parse("2028-12-15T11:01:00Z"), T);
  }

  /** The west-rim survey area: the terrain pack hides the Sun there; a geometric image is not a usable one. */
  @Test
  void shadowedGroundIsNotUsableForThisCamera() {
    final Camera.Quality q = quality(-89.62, -30, 50);
    assertEquals(Camera.Usability.IN_SHADOW, q.usability(), q.reason());
    assertEquals("BLOCKED_BY_TERRAIN", q.sunView());
    assertTrue(q.reason().contains("no illuminator"), q.reason());
  }

  /** A sunlit slope near Shackleton's far rim, imaged at coast speed: usable. */
  @Test
  void directlySunlitGroundAtCoastSpeedIsUsable() {
    final Camera.Quality q = quality(-89.75, -150, 50);
    assertEquals(Camera.Usability.USABLE, q.usability(), q.reason());
    assertEquals("CLEAR_WITHIN_TERRAIN_PACK", q.sunView());
    assertTrue(q.sunIncidenceDeg() < Camera.MAX_INCIDENCE_DEG);
    // 50 m/s for 4 ms over a 0.27 m GSD.
    assertEquals(50 * Camera.EXPOSURE_S / (800 * Math.toRadians(Camera.H_FOV_DEG) / Camera.WIDTH_PX), q.smearPx(), 0.01);
  }

  @Test
  void theSameSunlitGroundSmearsAtOrbitalSpeed() {
    assertEquals(Camera.Usability.SMEARED, quality(-89.75, -150, 1600).usability());
  }

  @Test
  void nearestFootprintExplainsAMiss() {
    final java.util.List<double[]> region = java.util.List.of(new double[] {-89.6, 0}, new double[] {-89.6, 1}, new double[] {-89.61, 1}, new double[] {-89.61, 0});
    final Camera.Footprint fp = nadir(-89.62, -30, 800, 50);
    final double d = Camera.nearestFootprintM(region, java.util.List.of(fp.corners()));
    assertTrue(d > 5_000 && d < 7_000, "about 6 km away: " + d);
    assertEquals(-1, Camera.nearestFootprintM(region, java.util.List.of()));
  }
}
