package moonfall;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;

import static org.junit.jupiter.api.Assertions.*;

class LunarSkyTest {
  private static JsonObject reference() throws IOException {
    try (InputStream in = LunarSkyTest.class.getResourceAsStream("/lunar-sky-reference.json")) {
      return JsonParser.parseString(new String(in.readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject();
    }
  }

  private static double[] vec(JsonElement e) {
    final var a = e.getAsJsonArray();
    return new double[] {a.get(0).getAsDouble(), a.get(1).getAsDouble(), a.get(2).getAsDouble()};
  }

  /**
   * JNISpice (N0067) in the mission model agrees with Cosmolabe's independent cspice-wasm build (N0066) on the
   * same kernels: Sun and Earth directions in MOON_ME_DE421 from the MoonFall sites, December 2028
   * (data/lunar-sky-reference.mjs).
   */
  @Test
  void matchesAnIndependentSpiceBuild() throws IOException {
    final JsonObject ref = reference();
    double worstDeg = 0, worstElevation = 0;
    int n = 0;
    for (final JsonElement e : ref.getAsJsonArray("cases")) {
      final JsonObject c = e.getAsJsonObject();
      final Instant t = Instant.parse(c.get("utc").getAsString());
      assertEquals(c.get("et").getAsDouble(), LunarSky.et(t), 1e-6, "ET of " + t);
      final double[] o = vec(c.get("observerM"));
      final double[] d = LunarSky.direction(c.get("target").getAsString(), t, o);
      worstDeg = Math.max(worstDeg, Math.toDegrees(Vec.angle(d, vec(c.get("direction")))));
      worstElevation = Math.max(worstElevation, Math.abs(LunarSky.elevationDeg(o, d) - c.get("elevationDeg").getAsDouble()));
      n++;
    }
    assertEquals(60, n);
    assertTrue(worstDeg < 1e-7, "direction differs by " + worstDeg + "°");
    assertTrue(worstElevation < 1e-7, "elevation differs by " + worstElevation + "°");
  }

  /** From the Moon's centre, the Earth's direction is the Earth→Moon vector reversed; from the surface, parallax. */
  @Test
  void observerParallaxIsApplied() {
    final Instant t = Instant.parse("2028-12-15T11:00:00Z");
    final double[] pole = Vec.scale(Vec.direction(-89.55, -45), MoonTerrain.RADIUS_M);
    final double[] centre = LunarSky.direction("EARTH", t, new double[] {0, 0, 0});
    final double[] site = LunarSky.direction("EARTH", t, pole);
    final double parallaxDeg = Math.toDegrees(Vec.angle(centre, site));
    // 1737 km across ~370,000–405,000 km: about a quarter of a degree, depending on the geometry.
    assertTrue(parallaxDeg > 0.1 && parallaxDeg < 0.3, "parallax " + parallaxDeg);
  }

  /** Reference-sphere elevation and the terrain-pack check are different things and stay distinguishable. */
  @Test
  void terrainViewIsSeparateFromHorizonElevation() {
    final MoonTerrain terrain = MoonTerrain.get();
    final double[] site = terrain.surfacePoint(Vec.direction(-89.55, -45));
    final double[] up = Vec.unit(site);
    assertEquals(90, LunarSky.elevationDeg(site, up), 1e-9);
    assertEquals(LunarSky.TerrainView.CLEAR_WITHIN_TERRAIN_PACK, LunarSky.terrainBlocked(terrain, site, up));
    assertEquals(LunarSky.TerrainView.BELOW_HORIZON, LunarSky.terrainBlocked(terrain, site, Vec.scale(up, -1)));
    // At the real Sun (about 0.3° up here), the pack's own terrain decides; whichever it is, it is not "below".
    final Instant t = Instant.parse("2028-12-15T11:00:00Z");
    final double[] sun = LunarSky.direction("SUN", t, site);
    assertTrue(LunarSky.elevationDeg(site, sun) > 0);
    assertNotEquals(LunarSky.TerrainView.BELOW_HORIZON, LunarSky.terrainBlocked(terrain, site, sun));
  }
}
