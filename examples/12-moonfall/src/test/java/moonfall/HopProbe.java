package moonfall;

/** Development probe: prints solutions for a few hops. Run with ./gradlew :examples:12-moonfall:probe --args="lat lon ..." */
public final class HopProbe {
  public static void main(String[] args) {
    final MoonTerrain t = MoonTerrain.get();
    final HopSolver solver = new HopSolver(t);
    final double[] start = t.surfacePoint(Vec.direction(Double.parseDouble(args[0]), Double.parseDouble(args[1])));
    for (int i = 2; i + 1 < args.length; i += 2) {
      final long t0 = System.nanoTime();
      final var hop = solver.solve(new HopSolver.Request(start, Double.parseDouble(System.getProperty("prop", "40")), Double.parseDouble(args[i]), Double.parseDouble(args[i + 1]),
          HopSolver.Profile.valueOf(System.getProperty("profile", "MIN_PROPELLANT")), Vehicle.defaults()));
      System.out.printf("%s %s: %s  [%d ms]%n  dur %.1f s prop %.3f kg dv %.1f maxH %.1f minClr %.1f slope %.1f td %.2f/%.2f%n  %s%n  phases %s%n",
          args[i], args[i + 1], hop.status(), (System.nanoTime() - t0) / 1_000_000, hop.durationS(), hop.propellantKg(), hop.deltaVMps(),
          hop.maxHeightAboveTerrainM(), hop.minClearanceM(), hop.landingSlopeDeg(), hop.touchdownVerticalMps(), hop.touchdownHorizontalMps(),
          hop.reason(), hop.phases());
      System.out.println("  candidates: " + hop.candidates());
      if (hop.feasible()) {
        final var c = HopSolver.span(hop, HopSolver.Phase.COAST);
        for (double tc = c.startS() + 3; tc < c.endS(); tc += 6) {
          final double[] r = HopSolver.stateAt(hop, tc)[0];
          System.out.printf("  coast: %.5f, %.5f at +%.0f s, %.0f m above terrain%n", Vec.latDeg(r), Vec.lonDeg(r), tc, MoonTerrain.get().clearanceM(r));
        }
      }
    }
  }
}
