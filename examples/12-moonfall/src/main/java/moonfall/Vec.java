package moonfall;

/** Three-vector arithmetic on {@code double[3]}. */
public final class Vec {
  private Vec() {}

  public static double[] of(double x, double y, double z) { return new double[] {x, y, z}; }
  public static double[] add(double[] a, double[] b) { return of(a[0] + b[0], a[1] + b[1], a[2] + b[2]); }
  public static double[] sub(double[] a, double[] b) { return of(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
  public static double[] scale(double[] a, double s) { return of(a[0] * s, a[1] * s, a[2] * s); }
  /** a + s b */
  public static double[] axpy(double[] a, double s, double[] b) { return of(a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]); }
  public static double dot(double[] a, double[] b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  public static double[] cross(double[] a, double[] b) {
    return of(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
  }
  public static double norm(double[] a) { return Math.sqrt(dot(a, a)); }
  public static double[] unit(double[] a) { return scale(a, 1 / norm(a)); }
  /** Component of a perpendicular to unit vector n. */
  public static double[] reject(double[] a, double[] n) { return axpy(a, -dot(a, n), n); }
  public static double angle(double[] a, double[] b) { return Math.atan2(norm(cross(a, b)), dot(a, b)); }

  /** Unit direction of planetocentric latitude/longitude (degrees). */
  public static double[] direction(double latDeg, double lonDeg) {
    final double la = Math.toRadians(latDeg), lo = Math.toRadians(lonDeg);
    return of(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la));
  }
  public static double latDeg(double[] r) { return Math.toDegrees(Math.atan2(r[2], Math.hypot(r[0], r[1]))); }
  public static double lonDeg(double[] r) { return Math.toDegrees(Math.atan2(r[1], r[0])); }

  /**
   * Scalar-first quaternion q of the rotation taking reference-frame vectors to body-frame vectors
   * (v_body = q v_ref q*), from the body axes expressed in the reference frame. The axes must be orthonormal
   * and right-handed. This is the SPICE C-matrix sense (rows of the matrix are the body axes).
   */
  public static double[] quaternion(double[] x, double[] y, double[] z) {
    // Rotation matrix M with rows x, y, z (M v_ref = v_body).
    final double m00 = x[0], m01 = x[1], m02 = x[2], m10 = y[0], m11 = y[1], m12 = y[2], m20 = z[0], m21 = z[1], m22 = z[2];
    final double tr = m00 + m11 + m22;
    double w, qx, qy, qz;
    if (tr > 0) {
      final double s = Math.sqrt(tr + 1) * 2;
      w = 0.25 * s; qx = (m21 - m12) / s; qy = (m02 - m20) / s; qz = (m10 - m01) / s;
    } else if (m00 > m11 && m00 > m22) {
      final double s = Math.sqrt(1 + m00 - m11 - m22) * 2;
      w = (m21 - m12) / s; qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s;
    } else if (m11 > m22) {
      final double s = Math.sqrt(1 + m11 - m00 - m22) * 2;
      w = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s;
    } else {
      final double s = Math.sqrt(1 + m22 - m00 - m11) * 2;
      w = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s;
    }
    // Canonical sign: w >= 0, so equal attitudes give equal numbers.
    if (w < 0) { w = -w; qx = -qx; qy = -qy; qz = -qz; }
    return new double[] {w, qx, qy, qz};
  }

  /** v_body = q v_ref q* for a scalar-first unit quaternion. */
  public static double[] rotate(double[] q, double[] v) {
    final double w = q[0];
    final double[] u = of(q[1], q[2], q[3]);
    final double[] t = scale(cross(u, v), 2);
    return add(add(v, scale(t, w)), cross(u, t));
  }

  /** v_ref from v_body: the conjugate rotation. */
  public static double[] unrotate(double[] q, double[] v) {
    return rotate(new double[] {q[0], -q[1], -q[2], -q[3]}, v);
  }
}
