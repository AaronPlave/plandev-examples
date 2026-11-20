package moonfall;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;

/**
 * The lunar south-polar terrain the drones fly over: Cosmolabe's pinned cube-sphere height product (the terrain
 * its MoonFall scene draws), shipped in the jar as the product's own tiles ({@code data/build-terrain-pack.mjs}).
 *
 * <p>Heights are metres above the 1737.4 km reference sphere, radial, in MOON_ME_DE421. A height is the lattice
 * triangle under the point, exactly as Cosmolabe's {@code CubeSphereSampler.sample} (checked against it by
 * {@code MoonTerrainTest}). Only the product's <em>finest</em> tile at a point is used: where that tile is not
 * in the pack, the point has no terrain ({@link #sample} returns null). A coarser ancestor is never used instead.
 *
 * <p>{@link #id} is {@code <product revision>@<first 12 hex of the pack's SHA-256>}.
 */
public final class MoonTerrain {
  public static final double RADIUS_M = 1737.4e3;

  public record Sample(double heightM, int level, double uncertaintyM, String tileId) {}

  public final String id;
  public final String revision;
  private final int width;
  private final int height;
  private final Map<Long, Tile> tiles = new HashMap<>();
  private final int maxLevel;
  private final int minLevel;

  private record Tile(int level, int x, int y, float[] heightsM, double uncertaintyM) {}

  private static MoonTerrain shipped;

  /** The terrain shipped with the mission model. */
  public static synchronized MoonTerrain get() {
    if (shipped == null) {
      try (InputStream index = MoonTerrain.class.getResourceAsStream("/moonfall/terrain/index.json");
           InputStream data = MoonTerrain.class.getResourceAsStream("/moonfall/terrain/tiles.f32")) {
        if (index == null || data == null) {
          throw new IllegalStateException("moonfall/terrain/{index.json,tiles.f32} not on the classpath: run examples/12-moonfall/data/build-terrain-pack.mjs");
        }
        shipped = new MoonTerrain(new String(index.readAllBytes(), StandardCharsets.UTF_8), data.readAllBytes());
      } catch (IOException e) {
        throw new UncheckedIOException(e);
      }
    }
    return shipped;
  }

  MoonTerrain(String indexJson, byte[] data) {
    final JsonObject index = JsonParser.parseString(indexJson).getAsJsonObject();
    final String packSha = sha256(data);
    if (!packSha.equals(index.get("packSha256").getAsString())) {
      throw new IllegalStateException("terrain tiles.f32 does not match index.json (" + packSha + ")");
    }
    if (!"nz".equals(index.get("face").getAsString())) throw new IllegalStateException("expected face nz");
    this.revision = index.get("revision").getAsString();
    this.id = revision + "@" + packSha.substring(0, 12);
    final JsonObject grid = index.getAsJsonObject("grid");
    this.width = grid.get("width").getAsInt();
    this.height = grid.get("height").getAsInt();
    final ByteBuffer buf = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN);
    int lo = Integer.MAX_VALUE, hi = 0;
    for (final JsonElement e : index.getAsJsonArray("tiles")) {
      final JsonArray t = e.getAsJsonArray();
      final int level = t.get(0).getAsInt(), x = t.get(1).getAsInt(), y = t.get(2).getAsInt();
      final float[] h = new float[width * height];
      for (int i = 0; i < h.length; i++) h[i] = buf.getFloat();
      tiles.put(key(level, x, y), new Tile(level, x, y, h, t.get(3).getAsDouble() * 1000));
      lo = Math.min(lo, level);
      hi = Math.max(hi, level);
    }
    if (buf.hasRemaining()) throw new IllegalStateException("terrain pack has trailing bytes");
    this.minLevel = lo;
    this.maxLevel = hi;
  }

  private static long key(int level, int x, int y) {
    return ((long) level << 56) | ((long) x << 28) | y;
  }

  /** Terrain under a Moon-fixed direction (any length), or null where the pack has no finest tile. */
  public Sample sample(double[] r) {
    // Face nz (CubeSphere.ts): N = (0,0,-1), U = (-1,0,0), V = (0,1,0); u = r.U / r.N, v = r.V / r.N.
    // Face ownership: |z| must dominate, as directionToCubeFace's X > Y > Z tie rule requires.
    final double ax = Math.abs(r[0]), ay = Math.abs(r[1]), az = Math.abs(r[2]);
    if (r[2] >= 0 || az <= ax || az <= ay) return null;
    final double s = -r[2];
    final double u = -r[0] / s + 0, v = r[1] / s + 0;
    for (int level = maxLevel; level >= minLevel; level--) {
      final int count = 1 << level;
      final int tx = index(u, count), ty = index(v, count);
      final Tile tile = tiles.get(key(level, tx, ty));
      if (tile == null) continue;
      final double localU = (u + 1) * 0.5 * count - tx, localV = (v + 1) * 0.5 * count - ty;
      final double px = localU * (width - 1), py = localV * (height - 1);
      final int x0 = (int) Math.floor(px), y0 = (int) Math.floor(py);
      final int x1 = Math.min(x0 + 1, width - 1), y1 = Math.min(y0 + 1, height - 1);
      final double fx = px - x0, fy = py - y0;
      final float[] h = tile.heightsM;
      final double h00 = h[y0 * width + x0], h11 = h[y1 * width + x1];
      final double heightM = fx >= fy
          ? h00 + fx * (h[y0 * width + x1] - h00) + fy * (h11 - h[y0 * width + x1])
          : h00 + fy * (h[y1 * width + x0] - h00) + fx * (h11 - h[y1 * width + x0]);
      return new Sample(heightM, tile.level, tile.uncertaintyM, "nz/" + tile.level + "/" + tile.x + "/" + tile.y);
    }
    return null;
  }

  private static int index(double coordinate, int count) {
    return Math.min(count - 1, (int) Math.floor((coordinate + 1) * 0.5 * count));
  }

  public Sample sample(double latDeg, double lonDeg) {
    return sample(Vec.direction(latDeg, lonDeg));
  }

  /** Height of the vehicle's position above the terrain under it (radial), or NaN without terrain. */
  public double clearanceM(double[] r) {
    final Sample s = sample(r);
    return s == null ? Double.NaN : Vec.norm(r) - RADIUS_M - s.heightM();
  }

  /** The terrain surface point (Moon-fixed, m) along a direction, or null without terrain. */
  public double[] surfacePoint(double[] direction) {
    final Sample s = sample(direction);
    return s == null ? null : Vec.scale(Vec.unit(direction), RADIUS_M + s.heightM());
  }

  /**
   * Upward terrain normal at a direction from heights {@code baselineM} either side along two horizontal axes,
   * or null where any of the five points has no terrain.
   */
  public double[] normal(double[] direction, double baselineM) {
    final double[] up = Vec.unit(direction);
    final double[] east = Vec.unit(Vec.cross(Vec.of(0, 0, 1), up));
    final double[] north = Vec.cross(up, east);
    final double d = baselineM / RADIUS_M;
    final double[] pe = surfacePoint(Vec.axpy(up, d, east)), pw = surfacePoint(Vec.axpy(up, -d, east));
    final double[] pn = surfacePoint(Vec.axpy(up, d, north)), ps = surfacePoint(Vec.axpy(up, -d, north));
    if (pe == null || pw == null || pn == null || ps == null) return null;
    final double[] n = Vec.unit(Vec.cross(Vec.sub(pe, pw), Vec.sub(pn, ps)));
    return Vec.dot(n, up) < 0 ? Vec.scale(n, -1) : n;
  }

  /** Slope (degrees) of the terrain at a direction over {@code baselineM}, or NaN without terrain. */
  public double slopeDeg(double[] direction, double baselineM) {
    final double[] n = normal(direction, baselineM);
    return n == null ? Double.NaN : Math.toDegrees(Vec.angle(n, Vec.unit(direction)));
  }

  /**
   * First intersection of a ray with the terrain, marching {@code stepM} and refining by bisection to 1 cm.
   * Returns null if the ray leaves terrain coverage, points away from the surface for {@code maxRangeM}, or
   * starts below the surface.
   */
  public double[] intersect(double[] origin, double[] dir, double maxRangeM, double stepM) {
    final double[] d = Vec.unit(dir);
    double prevT = 0, prevC = clearanceM(origin);
    if (!(prevC > 0)) return null;
    for (double t = stepM; t <= maxRangeM + stepM; t += stepM) {
      final double c = clearanceM(Vec.axpy(origin, t, d));
      if (Double.isNaN(c)) return null;
      if (c <= 0) {
        double a = prevT, b = t;
        while (b - a > 0.01) {
          final double m = 0.5 * (a + b);
          final double cm = clearanceM(Vec.axpy(origin, m, d));
          if (Double.isNaN(cm)) return null;
          if (cm > 0) a = m; else b = m;
        }
        return Vec.axpy(origin, b, d);
      }
      prevT = t;
      prevC = c;
    }
    return null;
  }

  private static String sha256(byte[] bytes) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }
}
