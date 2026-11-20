package moonfall;

import gov.nasa.ammos.plandev.merlin.framework.annotations.AutoValueMapper;

/** Where a drone is at plan start: planetocentric degrees in MOON_ME_DE421, on the terrain; propellant on board. */
@AutoValueMapper.Record
public record DroneStart(String name, double latitude, double longitude, double propellantKg) {}
