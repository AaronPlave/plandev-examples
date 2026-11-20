package moonfall;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.*;

class MoonTerrainTest {
  private final MoonTerrain terrain = MoonTerrain.get();

  /** The Java sampler gives Cosmolabe's CubeSphereSampler height at the same points (data/terrain-reference.mjs). */
  @Test
  void matchesCosmolabesSampler() throws IOException {
    final JsonObject ref;
    try (InputStream in = getClass().getResourceAsStream("/terrain-reference.json")) {
      ref = JsonParser.parseString(new String(in.readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject();
    }
    assertEquals(terrain.revision, ref.get("revision").getAsString());
    int n = 0;
    double worst = 0;
    for (final JsonElement e : ref.getAsJsonArray("samples")) {
      final JsonObject s = e.getAsJsonObject();
      final double lat = s.get("lat").getAsDouble();
      final MoonTerrain.Sample j = terrain.sample(lat, s.get("lon").getAsDouble());
      // The pack holds tiles centred within 22 km of the pole; a point near its edge may lie in an unpacked tile.
      if (j == null && Math.toRadians(90 + lat) * 1737.4 > 19) continue;
      assertNotNull(j, s.toString());
      assertEquals(s.get("tile").getAsString(), j.tileId(), s.toString());
      worst = Math.max(worst, Math.abs(j.heightM() - s.get("elevationM").getAsDouble()));
      n++;
    }
    assertTrue(n > 270, n + " points compared");
    // float32 metres in both; Cosmolabe converts to km first, so only rounding separates them.
    assertTrue(worst < 1e-6, "worst difference " + worst + " m");
  }

  @Test
  void noTerrainOutsideThePackAndNoCoarseSubstitute() {
    assertNull(terrain.sample(-88.0, 0.0), "60 km from the pole is outside the pack");
    assertNull(terrain.sample(10.0, 0.0), "other faces are not packed");
    // Just outside the 22 km pack: the product has finer tiles there, but none are packed; no ancestor is used.
    assertNull(terrain.sample(-90 + Math.toDegrees(23.0 / 1737.4), 45.0));
  }

  @Test
  void slopeAndNormalAreConsistent() {
    final double[] dir = Vec.direction(-89.55, -45);
    final double[] n = terrain.normal(dir, 15);
    assertNotNull(n);
    assertEquals(1, Vec.norm(n), 1e-12);
    assertEquals(Math.toDegrees(Vec.angle(n, Vec.unit(dir))), terrain.slopeDeg(dir, 15), 1e-9);
  }

  @Test
  void rayIntersectionLandsOnTheSurface() {
    final double[] ground = terrain.surfacePoint(Vec.direction(-89.6, 10));
    final double[] up = Vec.unit(ground);
    final double[] origin = Vec.axpy(ground, 200, up);
    final double[] hit = terrain.intersect(origin, Vec.scale(up, -1), 1000, 2);
    assertNotNull(hit);
    assertEquals(0, terrain.clearanceM(hit), 0.02);
    assertEquals(200, Vec.norm(Vec.sub(hit, origin)), 0.05);
  }
}
