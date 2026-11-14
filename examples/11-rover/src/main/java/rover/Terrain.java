package rover;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * The slope grid the rover plans and simulates against.
 *
 * <p>The grid is a data product shipped inside the mission model jar ({@code rover/terrain/<DATASET>.asc},
 * an Esri ASCII grid in planetocentric degrees, east-positive). {@code data/build-jezero-data.sh}
 * derives it from the USGS Mars 2020 TRN CTX DTM of Jezero crater: the mean, in each 200 m cell, of
 * the 20 m DTM's slope. The slopes are real; what the rover does with them ({@link DriveModel}) is
 * illustrative.
 *
 * <p>{@link #id} names the dataset and the first 12 hex digits of the file's SHA-256. The model
 * publishes it as the {@code rover.terrainDataset} resource and the scheduling goal writes it into
 * each Drive activity, so a plan and a simulation both say which grid they used.
 */
public final class Terrain {
  public static final String DATASET = "jezero-ctx-slope-200m-v1";

  public final String id;
  public final int ncols;
  public final int nrows;
  /** West and south edges of the grid, and the cell size, in degrees. */
  public final double west;
  public final double south;
  public final double cellDeg;
  /** Row 0 is the northernmost row. NaN where the product has no data. */
  private final float[] slopeDeg;

  private static Terrain shipped;

  /** The grid shipped with the mission model. */
  public static synchronized Terrain get() {
    if (shipped == null) {
      try (InputStream in = Terrain.class.getResourceAsStream("/rover/terrain/" + DATASET + ".asc")) {
        if (in == null) throw new IllegalStateException("terrain " + DATASET + " is not on the classpath");
        shipped = parse(DATASET, in.readAllBytes());
      } catch (IOException e) {
        throw new UncheckedIOException(e);
      }
    }
    return shipped;
  }

  public static Terrain parse(String name, byte[] bytes) {
    final String[] lines = new String(bytes, StandardCharsets.US_ASCII).split("\\R");
    final double[] header = new double[6];
    for (int i = 0; i < 6; i++) header[i] = Double.parseDouble(lines[i].trim().split("\\s+")[1]);
    final int ncols = (int) header[0];
    final int nrows = (int) header[1];
    final float[] slope = new float[ncols * nrows];
    for (int r = 0; r < nrows; r++) {
      final String[] v = lines[6 + r].trim().split("\\s+");
      if (v.length != ncols) throw new IllegalArgumentException(name + ": row " + r + " has " + v.length + " values, expected " + ncols);
      for (int c = 0; c < ncols; c++) {
        final float s = Float.parseFloat(v[c]);
        slope[r * ncols + c] = s == (float) header[5] ? Float.NaN : s;
      }
    }
    return new Terrain(name + "@" + sha256(bytes).substring(0, 12), ncols, nrows, header[2], header[3], header[4], slope);
  }

  private Terrain(String id, int ncols, int nrows, double west, double south, double cellDeg, float[] slopeDeg) {
    this.id = id;
    this.ncols = ncols;
    this.nrows = nrows;
    this.west = west;
    this.south = south;
    this.cellDeg = cellDeg;
    this.slopeDeg = slopeDeg;
  }

  public int col(double lon) {
    return (int) Math.floor((lon - west) / cellDeg);
  }

  public int row(double lat) {
    return nrows - 1 - (int) Math.floor((lat - south) / cellDeg);
  }

  public boolean inside(int col, int row) {
    return col >= 0 && col < ncols && row >= 0 && row < nrows;
  }

  /** Longitude and latitude of a cell's centre. */
  public double lon(int col) {
    return west + (col + 0.5) * cellDeg;
  }

  public double lat(int row) {
    return south + (nrows - 1 - row + 0.5) * cellDeg;
  }

  /** Slope in degrees of a cell; NaN outside the grid or where the product has no data. */
  public double slope(int col, int row) {
    return inside(col, row) ? slopeDeg[row * ncols + col] : Double.NaN;
  }

  public double slopeAt(double lat, double lon) {
    return slope(col(lon), row(lat));
  }

  private static String sha256(byte[] bytes) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }
}
